'use strict';
const http = require('node:http');
const { isIP } = require('node:net');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { sourceKey, publicHttps } = require('./policy.cjs');
const { isChallengeHtml } = require('./challenges.cjs');
const SAFE_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'range', 'cache-control', 'pragma']);
const error = code => Object.assign(new Error(code), { code });

function publicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6) return false;
  const lower = new URL(`http://[${address}]`).hostname.slice(1, -1).toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (isIP(mapped) === 4) return publicAddress(mapped);
    const parts = mapped.split(':');
    if (parts.length === 2) {
      const first = parseInt(parts[0], 16); const second = parseInt(parts[1], 16);
      return publicAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
    return false;
  }
  return /^[23][a-f\d]{3}:/i.test(lower) && !/^2001:db8:|^2002:/i.test(lower);
}

async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason;
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function readResponse(response, maximum, signal) {
  if (Number(response.headers.get('content-length')) > maximum) throw error('RESPONSE_TOO_LARGE');
  let length = 0;
  const chunks = [];
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maximum) throw error('RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(part.value));
      }
    } catch (failure) {
      await reader.cancel().catch(() => {});
      throw failure;
    }
  }
  return Buffer.concat(chunks, length);
}

// Private main-process relay. Credentials are supplied only to the managed
// helper launch environment; neither this object nor fetch URLs enter preload.
class SourceRelay {
  #server;
  #token = randomBytes(32).toString('hex');
  #active = new Set();
  #transportOwners = new Set();
  #sessions = new WeakMap();
  #pausedSources = new Set();
  #mediaSources = new Map();
  #mediaLru = new Map();
  #mediaVersions = new Map();
  #mediaEpoch = 0;
  #closing = false;
  constructor({ catalogueLookup, sessionForSource, onChallenge = () => {}, readOnlyPostPolicy = async () => false,
    maxRequestBytes = 1024 * 1024, maxResponseBytes = 32 * 1024 * 1024, maxConcurrent = 8, timeoutMs = 30000,
    maxMediaGrants = 16384, maxMediaGrantsPerSource = 4096, mediaGrantTtlMs = 30 * 60 * 1000, now = Date.now } = {}) {
    for (const fn of [catalogueLookup, sessionForSource, onChallenge, readOnlyPostPolicy, now]) {
      if (typeof fn !== 'function') throw new TypeError('Relay authority and transport must be trusted main-process functions');
    }
    for (const value of [maxRequestBytes, maxResponseBytes, maxConcurrent, timeoutMs, maxMediaGrants, maxMediaGrantsPerSource, mediaGrantTtlMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Relay bounds must be positive integers');
    }
    this.options = { catalogueLookup, sessionForSource, onChallenge, readOnlyPostPolicy, maxRequestBytes, maxResponseBytes, maxConcurrent, timeoutMs,
      maxMediaGrants, maxMediaGrantsPerSource, mediaGrantTtlMs, now };
  }
  async start() {
    if (this.#server) throw error('RELAY_ALREADY_STARTED');
    this.#closing = false;
    this.#token = randomBytes(32).toString('hex');
    this.#server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => this.#handle(request, response));
    this.#server.requestTimeout = this.options.timeoutMs;
    this.#server.headersTimeout = Math.min(this.options.timeoutMs, 10000);
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', resolve);
    });
    return Object.freeze({ baseUrl: `http://127.0.0.1:${this.#server.address().port}`, token: this.#token });
  }
  async stop() {
    this.#closing = true;
    this.#mediaEpoch += 1;
    this.#mediaSources.clear();
    this.#mediaLru.clear();
    for (const controller of new Set([...this.#active, ...this.#transportOwners])) controller.abort(error('RELAY_STOPPED'));
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  // Main-only authority: call only for image references returned by the trusted
  // authenticated helper parser. There is deliberately no HTTP/IPC grant route.
  async authorizeMedia(sourceId, urls) {
    sourceKey(sourceId);
    if (this.#closing) throw error('RELAY_STOPPED');
    if (this.#pausedSources.has(sourceId)) throw error('SOURCE_SESSION_PAUSED');
    if (!Array.isArray(urls) || urls.length > this.options.maxMediaGrantsPerSource) throw error('MEDIA_GRANT_LIMIT');
    const canonical = new Set();
    const version = this.#mediaVersions.get(sourceId) || 0;
    const epoch = this.#mediaEpoch;
    for (const value of urls) {
      if (typeof value !== 'string' || value.length > 8192 || !publicHttps(value)) throw error('INVALID_MEDIA_URL');
      const url = new URL(value);
      if (url.hash) throw error('INVALID_MEDIA_URL');
      canonical.add(url.href);
    }
    const descriptor = await this.options.catalogueLookup(sourceId);
    if (!descriptor || descriptor.sourceId !== sourceId || !Array.isArray(descriptor.allowedOrigins)) throw error('UNKNOWN_SOURCE');
    if (this.#closing) throw error('RELAY_STOPPED');
    if (this.#pausedSources.has(sourceId)) throw error('SOURCE_SESSION_PAUSED');
    if ((this.#mediaVersions.get(sourceId) || 0) !== version || this.#mediaEpoch !== epoch) throw error('SOURCE_SESSION_RESET');
    const time = this.options.now();
    for (const grant of this.#mediaLru.values()) if (grant.expiresAt <= time) this.#deleteMedia(grant);
    for (const url of canonical) {
      const previous = this.#mediaSources.get(sourceId)?.get(url);
      if (previous) this.#deleteMedia(previous);
      const grant = { sourceId, url, expiresAt: time + this.options.mediaGrantTtlMs };
      if (!this.#mediaSources.has(sourceId)) this.#mediaSources.set(sourceId, new Map());
      const bucket = this.#mediaSources.get(sourceId);
      bucket.set(url, grant);
      this.#mediaLru.set(grant, grant);
      while (bucket.size > this.options.maxMediaGrantsPerSource) this.#deleteMedia(bucket.values().next().value);
      while (this.#mediaLru.size > this.options.maxMediaGrants) this.#deleteMedia(this.#mediaLru.values().next().value);
    }
    return { authorized: canonical.size };
  }
  #deleteMedia(grant) {
    this.#mediaLru.delete(grant);
    const bucket = this.#mediaSources.get(grant.sourceId);
    bucket?.delete(grant.url);
    if (!bucket?.size) this.#mediaSources.delete(grant.sourceId);
  }
  #mediaAllowed(sourceId, url) {
    const bucket = this.#mediaSources.get(sourceId);
    const grant = bucket?.get(url);
    if (!grant) return false;
    if (grant.expiresAt <= this.options.now()) { this.#deleteMedia(grant); return false; }
    // Access refreshes LRU order, never the parser-established expiry time.
    this.#mediaLru.delete(grant); this.#mediaLru.set(grant, grant);
    bucket.delete(url); bucket.set(url, grant);
    return true;
  }
  async withSourcePaused(sourceId, callback) {
    sourceKey(sourceId);
    if (typeof callback !== 'function') throw new TypeError('Source reset callback required');
    if (this.#pausedSources.has(sourceId)) throw error('SOURCE_ALREADY_PAUSED');
    this.#pausedSources.add(sourceId);
    this.#mediaVersions.set(sourceId, (this.#mediaVersions.get(sourceId) || 0) + 1);
    let timeout;
    try {
      const matching = [...new Set([...this.#active, ...this.#transportOwners])].filter(controller => controller.sourceId === sourceId);
      for (const controller of matching) controller.abort(error('SOURCE_SESSION_RESET'));
      const drained = Promise.all(matching.map(async controller => {
        await controller.finished;
        // Abortable races stop serving a response immediately. A reset must also
        // wait for the actual native fetch to settle before storage is cleared.
        await Promise.all([...controller.transportSettled]);
      }));
      await Promise.race([drained, new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(error('SOURCE_TRANSPORT_BUSY')), this.options.timeoutMs);
      })]);
      const result = await callback();
      for (const grant of this.#mediaSources.get(sourceId)?.values() || []) this.#deleteMedia(grant);
      return result;
    } finally {
      clearTimeout(timeout);
      this.#pausedSources.delete(sourceId);
    }
  }
  #respond(response, status, body) {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  #authenticated(request) {
    const given = createHash('sha256').update(typeof request.headers.authorization === 'string' ? request.headers.authorization : '').digest();
    const expected = createHash('sha256').update(`Bearer ${this.#token}`).digest();
    return timingSafeEqual(given, expected);
  }
  async #handle(request, response) {
    if (!this.#authenticated(request)) { this.#respond(response, 401, { code: 'UNAUTHORIZED' }); return; }
    if (request.headers.origin !== undefined) { this.#respond(response, 403, { code: 'BROWSER_ACCESS_DENIED' }); return; }
    if (request.url !== '/fetch') { this.#respond(response, 404, { code: 'NOT_FOUND' }); return; }
    if (request.method !== 'POST') { this.#respond(response, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
    if (this.#closing) { this.#respond(response, 503, { code: 'RELAY_STOPPED' }); return; }
    if (new Set([...this.#active, ...this.#transportOwners]).size >= this.options.maxConcurrent) { this.#respond(response, 429, { code: 'CONCURRENCY_LIMIT' }); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      this.#respond(response, 400, { code: 'JSON_REQUIRED' }); return;
    }
    const controller = new AbortController();
    let finish;
    controller.finished = new Promise(resolve => { finish = resolve; });
    controller.transportSettled = new Set();
    this.#active.add(controller);
    const timeout = setTimeout(() => controller.abort(error('REQUEST_TIMEOUT')), this.options.timeoutMs);
    const disconnected = () => { if (!response.writableEnded) controller.abort(error('REQUEST_CANCELLED')); };
    response.once('close', disconnected);
    try {
      const value = await abortable(this.#readInput(request), controller.signal);
      const result = await this.#fetch(value, controller);
      this.#respond(response, 200, result);
    } catch (failure) {
      this.#respond(response, failure.code === 'REQUEST_TIMEOUT' ? 504 : 400, { code: failure.code || 'INVALID_SOURCE_REQUEST' });
    } finally {
      if (controller.signal.aborted && !request.complete) request.destroy();
      clearTimeout(timeout);
      response.removeListener('close', disconnected);
      this.#active.delete(controller);
      finish();
    }
  }
  async #readInput(request) {
    const declared = Number(request.headers['content-length']);
    if (declared > this.options.maxRequestBytes * 2) throw error('REQUEST_TOO_LARGE');
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > this.options.maxRequestBytes * 2) throw error('REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw error('INVALID_JSON'); }
  }
  async #fetch(value, controller) {
    const signal = controller.signal;
    sourceKey(value?.sourceId);
    controller.sourceId = value.sourceId;
    if (this.#pausedSources.has(value.sourceId)) throw error('SOURCE_SESSION_PAUSED');
    if (typeof value?.url !== 'string' || value.url.length > 8192 || !publicHttps(value.url)) throw error('PUBLIC_HTTPS_REQUIRED');
    if (!['GET', 'POST'].includes(value.method)) throw error('READ_ONLY_METHOD_REQUIRED');
    const descriptor = await abortable(this.options.catalogueLookup(value.sourceId), signal);
    if (!descriptor || descriptor.sourceId !== value.sourceId || !Array.isArray(descriptor.allowedOrigins)) throw error('UNKNOWN_SOURCE');
    const origins = new Set(descriptor.allowedOrigins.filter(origin => {
      try { return publicHttps(origin) && new URL(origin).origin === origin; } catch { return false; }
    }));
    let url = new URL(value.url).href;
    const allowedTarget = target => origins.has(new URL(target).origin)
      || (value.method === 'GET' && this.#mediaAllowed(value.sourceId, target));
    if (!allowedTarget(url)) throw error('UNTRUSTED_SOURCE_ORIGIN');
    const headers = {};
    if (value.headers !== undefined && (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers))) throw error('INVALID_HEADERS');
    for (const [name, content] of Object.entries(value.headers || {})) {
      const lower = name.toLowerCase();
      if (['referer', 'origin', 'x-requested-with'].includes(lower)) {
        if (typeof content !== 'string' || content.length > 4096 || /[\r\n\0]/.test(content)) throw error('INVALID_HEADERS');
        if (lower === 'x-requested-with') {
          if (content !== 'XMLHttpRequest') throw error('INVALID_HEADERS');
        } else {
          const reference = publicHttps(content) ? new URL(content) : undefined;
          const grantedMediaReferer = reference && lower === 'referer' && value.method === 'GET'
            && reference.origin === new URL(url).origin && this.#mediaAllowed(value.sourceId, url);
          if (!reference || (!(descriptor.refererOrigins || descriptor.allowedOrigins).includes(reference.origin) && !grantedMediaReferer)
            || (lower === 'origin' && reference.origin !== content)) throw error('UNTRUSTED_REFERER');
        }
        headers[lower] = content;
        continue;
      }
      if (!SAFE_HEADERS.has(lower)) continue;
      if (typeof content !== 'string' || content.length > 4096 || /[\r\n\0]/.test(content)) throw error('INVALID_HEADERS');
      headers[lower] = content;
    }
    let body;
    if (value.method === 'POST') {
      if (typeof value.bodyBase64 !== 'string' || value.bodyBase64.length > Math.ceil(this.options.maxRequestBytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)) throw error('INVALID_REQUEST_BODY');
      body = Buffer.from(value.bodyBase64, 'base64');
      if (body.length > this.options.maxRequestBytes) throw error('REQUEST_TOO_LARGE');
      if (!/^(application\/json|application\/x-www-form-urlencoded|text\/plain)(?:;\s*charset=utf-8)?$/i.test(value.bodyContentType || '')) throw error('INVALID_BODY_CONTENT_TYPE');
      headers['content-type'] = value.bodyContentType;
      const allowed = await abortable(this.options.readOnlyPostPolicy({ sourceId: value.sourceId, url, headers, body, descriptor }), signal);
      if (allowed !== true) throw error('POST_NOT_READ_ONLY');
    } else if (value.bodyBase64 !== undefined || value.bodyContentType !== undefined) throw error('GET_BODY_NOT_ALLOWED');
    const ses = await abortable(this.options.sessionForSource(value.sourceId), signal);
    if (!ses || typeof ses.fetch !== 'function' || typeof ses.resolveHost !== 'function' || typeof ses.setProxy !== 'function') throw error('SESSION_UNAVAILABLE');
    if (!this.#sessions.has(ses)) this.#sessions.set(ses, ses.setProxy({ mode: 'direct' }));
    await abortable(this.#sessions.get(ses), signal);
    let method = value.method;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const hostname = new URL(url).hostname;
      const resolution = await abortable(ses.resolveHost(hostname, { source: 'system', cacheUsage: 'disallowed' }), signal);
      if (!resolution?.endpoints?.length || resolution.endpoints.some(endpoint => !publicAddress(endpoint.address))) throw error('PRIVATE_NETWORK_DENIED');
      if (signal.aborted) throw signal.reason;
      const transport = Promise.resolve(ses.fetch(url, { method, headers, ...(body ? { body } : {}), credentials: 'include', redirect: 'manual', signal }));
      const settled = transport.then(() => {}, () => {});
      controller.transportSettled.add(settled);
      this.#transportOwners.add(controller);
      settled.then(() => {
        controller.transportSettled.delete(settled);
        if (!controller.transportSettled.size) this.#transportOwners.delete(controller);
      });
      const fetched = await abortable(transport, signal);
      if ([301, 302, 303, 307, 308].includes(fetched.status)) {
        const location = fetched.headers.get('location');
        let next;
        try { next = new URL(location, url); } catch { throw error('INVALID_REDIRECT'); }
        if (!location || !publicHttps(next.href) || !allowedTarget(next.href)) throw error('UNTRUSTED_REDIRECT');
        await fetched.body?.cancel();
        if (redirects === 5) throw error('REDIRECT_LIMIT');
        if (method === 'POST' && [301, 302, 303].includes(fetched.status)) { method = 'GET'; body = undefined; delete headers['content-type']; }
        if (method === 'POST') {
          const allowed = await abortable(this.options.readOnlyPostPolicy({ sourceId: value.sourceId, url: next.href, headers, body, descriptor }), signal);
          if (allowed !== true) throw error('POST_NOT_READ_ONLY');
        }
        url = next.href;
        continue;
      }
      const bytes = await readResponse(fetched, this.options.maxResponseBytes, signal);
      const responseHeaders = {};
      for (const name of ['content-type', 'cf-mitigated']) {
        const content = fetched.headers.get(name);
        if (content !== null && content.length <= 4096) responseHeaders[name] = content;
      }
      if (responseHeaders['cf-mitigated'] === 'challenge' || isChallengeHtml(bytes.toString('utf8'), responseHeaders['content-type'])) {
        await abortable(this.options.onChallenge({ sourceId: value.sourceId, url, method, status: fetched.status, phase: 'verification-required' }), signal);
      }
      return { status: fetched.status, headers: responseHeaders, bodyBase64: bytes.toString('base64') };
    }
    throw error('REDIRECT_LIMIT');
  }
}
module.exports = { SourceRelay, publicAddress };
