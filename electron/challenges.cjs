'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { sourceKey, publicHttps } = require('./policy.cjs');

const DEFAULT_OPERATIONS = ['catalogue', 'search', 'details', 'chapters', 'pages'];
function failure(code) { return Object.assign(new Error(code), { code }); }
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
function isChallengeHtml(body, contentType = '') {
  if (!/html/i.test(contentType) && !/^\s*(<!doctype\s+html|<html)/i.test(body)) return false;
  return /\/cdn-cgi\/challenge-platform\/|\bcf-chl-[\w-]*|\bchallenge-form\b/i.test(body)
    || (/<title[^>]*>\s*(just a moment|attention required)/i.test(body) && /cloudflare|challenge/i.test(body));
}

// Main-process service only. This object and request() must not be exposed to
// renderer IPC. A managed helper supplies authoritative catalogue descriptors
// and parser-backed validation; untrusted pages supply neither.
class ChallengeCoordinator extends EventEmitter {
  #entries = new Map();
  constructor({ catalogueLookup, sessionForSource, validateContent, openVerification,
    allowedOperations = DEFAULT_OPERATIONS, maxPending = 32, maxActive = 8,
    maxAttempts = 3, maxResponseBytes = 16 * 1024 * 1024, timeoutMs = 20000 } = {}) {
    super();
    for (const [name, value] of Object.entries({ catalogueLookup, sessionForSource, validateContent, openVerification })) {
      if (typeof value !== 'function') throw new TypeError(`${name} must be a trusted main-process function`);
    }
    for (const value of [maxPending, maxActive, maxAttempts, maxResponseBytes, timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Coordinator bounds must be positive integers');
    }
    this.options = { catalogueLookup, sessionForSource, validateContent, openVerification,
      allowedOperations: new Set(allowedOperations), maxPending, maxActive, maxAttempts, maxResponseBytes, timeoutMs };
  }

  #publish(entry, phase, code) {
    entry.phase = phase;
    entry.code = code;
    const summary = this.#summary(entry);
    this.emit('status', summary);
    return summary;
  }
  #summary(entry) {
    return { sourceId: entry.sourceId, pendingId: entry.pendingId, phase: entry.phase,
      attempts: entry.attempts, ...(entry.code ? { code: entry.code } : {}) };
  }
  status(sourceId) {
    sourceKey(sourceId);
    const entry = this.#entries.get(sourceId);
    return entry ? this.#summary(entry) : { sourceId, phase: 'idle', attempts: 0 };
  }

  async #boundRequest(value) {
    sourceKey(value?.sourceId);
    if (!this.options.allowedOperations.has(value?.operation)) throw new Error('Unsupported source operation');
    if (typeof value.url !== 'string' || value.url.length > 8192 || !publicHttps(value.url)) {
      throw new Error('Source content requires a public HTTPS URL');
    }
    const descriptor = await this.options.catalogueLookup(value.sourceId);
    if (!descriptor || descriptor.sourceId !== value.sourceId || !Array.isArray(descriptor.allowedOrigins) || !descriptor.allowedOrigins.length) {
      throw new Error('Source is unavailable in the authoritative catalogue');
    }
    const origins = new Set(descriptor.allowedOrigins.filter(origin => {
      try { return publicHttps(origin) && new URL(origin).origin === origin; }
      catch { return false; }
    }));
    const url = new URL(value.url).href;
    if (!origins.has(new URL(url).origin)) throw new Error('URL origin is not authorised by the source catalogue');
    return { sourceId: value.sourceId, operation: value.operation, url, origins };
  }

  async request(value) {
    const request = await this.#boundRequest(value);
    const existing = this.#entries.get(request.sourceId);
    const same = existing && existing.request.url === request.url && existing.request.operation === request.operation;
    if (existing?.pending) {
      if (same) return existing.pending;
      throw failure('SOURCE_BUSY');
    }
    if (same && ['verification-required', 'verifying'].includes(existing.phase)) return this.#summary(existing);
    if (existing && ['verification-required', 'verifying'].includes(existing.phase)) throw failure('SOURCE_BUSY');
    if (!existing && this.#entries.size >= this.options.maxPending) {
      const terminal = [...this.#entries].find(([, entry]) => ['ready', 'failed', 'cancelled'].includes(entry.phase) && !entry.pending);
      if (terminal) this.#entries.delete(terminal[0]);
      else throw failure('PENDING_LIMIT');
    }
    const entry = { sourceId: request.sourceId, request, pendingId: randomUUID(), attempts: 0,
      phase: 'idle', cancelled: false };
    this.#entries.set(request.sourceId, entry);
    return this.#execute(entry);
  }

  async verify(sourceId) {
    sourceKey(sourceId);
    const entry = this.#entries.get(sourceId);
    if (!entry || !['verification-required', 'verifying'].includes(entry.phase)) throw failure('NO_PENDING_CHALLENGE');
    if (entry.verifyingPromise) return entry.verifyingPromise;
    const pending = Promise.resolve().then(() => this.options.openVerification({ sourceId, url: entry.request.url, pendingId: entry.pendingId }))
      .then(() => entry.cancelled ? this.#summary(entry) : this.#publish(entry, 'verifying'))
      .finally(() => { if (entry.verifyingPromise === pending) entry.verifyingPromise = undefined; });
    entry.verifyingPromise = pending;
    // A window opening, an HTTP200, or a cookie appearing is not valid content.
    return pending;
  }

  async retry(sourceId) {
    sourceKey(sourceId);
    const entry = this.#entries.get(sourceId);
    if (!entry || !['verification-required', 'verifying'].includes(entry.phase)) throw failure('NO_PENDING_CHALLENGE');
    if (entry.pending) return entry.pending;
    if (entry.attempts >= this.options.maxAttempts) return this.#publish(entry, 'failed', 'ATTEMPT_LIMIT');
    // Revalidate catalogue authority before each resume; it may have changed.
    entry.request = await this.#boundRequest(entry.request);
    if (entry.cancelled) return this.#summary(entry);
    if (entry.pending) return entry.pending;
    if (entry.attempts >= this.options.maxAttempts) return this.#publish(entry, 'failed', 'ATTEMPT_LIMIT');
    return this.#execute(entry);
  }

  cancel(sourceId) {
    sourceKey(sourceId);
    const entry = this.#entries.get(sourceId);
    if (!entry) return { sourceId, phase: 'idle', attempts: 0 };
    entry.cancelled = true;
    entry.controller?.abort(failure('CANCELLED'));
    return this.#publish(entry, 'cancelled', 'CANCELLED');
  }
  shutdown() { for (const sourceId of this.#entries.keys()) this.cancel(sourceId); }

  async #execute(entry) {
    const active = [...this.#entries.values()].filter(value => value.pending).length;
    if (active >= this.options.maxActive) return this.#publish(entry, 'failed', 'ACTIVE_LIMIT');
    entry.controller = new AbortController();
    entry.attempts += 1;
    this.#publish(entry, 'loading');
    const timeout = setTimeout(() => entry.controller.abort(failure('TRANSPORT_TIMEOUT')), this.options.timeoutMs);
    const pending = this.#fetchAndValidate(entry).catch(error => {
      if (entry.cancelled) return this.#publish(entry, 'cancelled', 'CANCELLED');
      return this.#publish(entry, 'failed', entry.controller.signal.reason?.code || error.code || 'REQUEST_FAILED');
    }).finally(() => {
      clearTimeout(timeout);
      if (entry.pending === pending) entry.pending = undefined;
    });
    entry.pending = pending;
    return pending;
  }

  async #fetchAndValidate(entry) {
    const ses = await abortable(this.options.sessionForSource(entry.sourceId), entry.controller.signal);
    if (!ses || typeof ses.fetch !== 'function') throw failure('SESSION_UNAVAILABLE');
    let url = entry.request.url;
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await abortable(ses.fetch(url, { method: 'GET', credentials: 'include', redirect: 'manual', signal: entry.controller.signal }), entry.controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      let next;
      try { next = new URL(location, url); } catch { throw failure('INVALID_REDIRECT'); }
      if (!location || !publicHttps(next.href) || !entry.request.origins.has(next.origin)) throw failure('UNTRUSTED_REDIRECT');
      await response.body?.cancel();
      if (redirects === 5) throw failure('REDIRECT_LIMIT');
      url = next.href;
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > this.options.maxResponseBytes) throw failure('RESPONSE_TOO_LARGE');
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
        const part = await abortable(reader.read(), entry.controller.signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.options.maxResponseBytes) {
          await reader.cancel();
          throw failure('RESPONSE_TOO_LARGE');
        }
        chunks.push(Buffer.from(part.value));
      }
    }
    const body = Buffer.concat(chunks, size);
    const contentType = response.headers.get('content-type') || '';
    if (isChallengeHtml(body.toString('utf8'), contentType)) return this.#publish(entry, 'verification-required', 'CHALLENGE_HTML');
    if (response.status !== 200) return this.#publish(entry, 'failed', 'HTTP_STATUS');
    let valid = false;
    try {
      valid = await abortable(this.options.validateContent({ sourceId: entry.sourceId, operation: entry.request.operation,
        url, httpStatus: response.status, contentType, body }), entry.controller.signal);
    } catch { /* Parser failure is not evidence of a solved challenge. */ }
    if (entry.cancelled || entry.controller.signal.aborted) throw entry.controller.signal.reason || failure('CANCELLED');
    if (valid !== true) return this.#publish(entry, 'failed', 'INVALID_CONTENT');
    return { ...this.#publish(entry, 'ready'), url, httpStatus: response.status, contentType, body };
  }
}
module.exports = { ChallengeCoordinator, isChallengeHtml };
