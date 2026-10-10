'use strict';
const { randomBytes } = require('node:crypto');
const { sourceKey, publicHttps } = require('./policy.cjs');
const problem = code => Object.assign(new Error(code), { code });
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'range', 'cache-control', 'pragma', 'referer', 'origin', 'x-requested-with']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'cf-mitigated', 'location']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const WORLD = 1004;

function requestOptions(url, init, maximum) {
  if (!publicHttps(url) || typeof url !== 'string' || url.length > 8192) throw problem('INVALID_TRANSPORT_URL');
  if (!['GET', 'POST'].includes(init?.method || 'GET') || init?.redirect !== 'manual' || init?.credentials !== 'include') throw problem('INVALID_TRANSPORT_OPTIONS');
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  if (body && (init.method !== 'POST' || body.length > maximum)) throw problem('INVALID_TRANSPORT_BODY');
  const headers = {};
  for (const [name, value] of Object.entries(init.headers || {})) {
    const lower = name.toLowerCase();
    if (!REQUEST_HEADERS.has(lower) || typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) throw problem('INVALID_TRANSPORT_HEADERS');
    if (Object.hasOwn(headers, lower)) throw problem('INVALID_TRANSPORT_HEADERS');
    headers[lower] = value;
  }
  const target = new URL(url); target.hash = '';
  return { url: target.href, method: init.method || 'GET', headers, body };
}

// Main-only transport; SourceRelay validates catalogue/exact media authority,
// public DNS and read-only POST before calling the facade. Unlike Session.fetch,
// these requests retain the actual target's top-level cookie partition (CHIPS).
// No source HTML/JS runs here: a random private bootstrap is fulfilled locally,
// script-src none, connect-src self; only main's isolated-world code can fetch.
class BrowserContextTransport {
  #contexts = new Map();
  #owners = new Set();
  #facades = new Map();
  #sessions = new Map();
  #closed = false;
  #closingSources = new Set();
  #drains = new Set();
  constructor({ sessionForSource, createWindow, maxContexts = 16, maxActive = 8, maxResponseBytes = 32 * 1024 * 1024, maxRequestBytes = 1024 * 1024, timeoutMs = 30000 } = {}) {
    if (typeof sessionForSource !== 'function') throw new TypeError('Trusted source sessions required');
    for (const value of [maxContexts, maxActive, maxResponseBytes, maxRequestBytes, timeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Positive transport bounds required');
    this.options = { sessionForSource, createWindow: createWindow || (options => new (require('electron').BrowserWindow)(options)), maxContexts, maxActive, maxResponseBytes, maxRequestBytes, timeoutMs };
  }
  async sessionForSource(sourceId) {
    sourceKey(sourceId);
    if (this.#closed) throw problem('TRANSPORT_CLOSED');
    if (!this.#facades.has(sourceId)) {
      const ses = await this.options.sessionForSource(sourceId);
      if (this.#closed) throw problem('TRANSPORT_CLOSED');
      this.#sessions.set(sourceId, ses);
      if (!this.#facades.has(sourceId)) this.#facades.set(sourceId, {
        setProxy: ses.setProxy.bind(ses), resolveHost: ses.resolveHost.bind(ses),
        fetch: (url, init) => this.fetch(sourceId, url, init),
      });
    }
    return this.#facades.get(sourceId);
  }
  fetch(sourceId, url, init = {}) {
    try { sourceKey(sourceId); } catch (error) { return Promise.reject(error); }
    let request;
    try { request = requestOptions(url, init, this.options.maxRequestBytes); } catch (error) { return Promise.reject(error); }
    if (this.#closed || this.#closingSources.has(sourceId)) return Promise.reject(problem('TRANSPORT_CLOSED'));
    if (init.signal?.aborted) return Promise.reject(init.signal.reason || problem('TRANSPORT_CANCELLED'));
    if (this.#owners.size >= this.options.maxActive) return Promise.reject(problem('TRANSPORT_ACTIVE_LIMIT'));
    const deferred = Promise.withResolvers();
    const owner = { sourceId, request, controller: new AbortController(), resolve: deferred.resolve, reject: deferred.reject };
    this.#owners.add(owner);
    owner.cancel = (reason = problem('TRANSPORT_CANCELLED')) => {
      if (owner.controller.signal.aborted) return;
      owner.controller.abort(reason);
      const context = owner.context;
      if (context?.active === owner) {
        // Native work owns settlement until the destroyed frame rejects it.
        // Other queued reads acquire a fresh inert frame in the same session.
        this.#destroy(context, { requeue: true });
      } else {
        if (context) { context.queue = context.queue.filter(value => value !== owner); context.owners.delete(owner); }
        owner.reject(reason);
        if (context && !context.active && !context.queue.length && !context.bootstrapped) this.#destroy(context);
      }
    };
    const abort = () => owner.cancel(init.signal.reason || problem('TRANSPORT_CANCELLED'));
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => owner.cancel(problem('TRANSPORT_TIMEOUT')), this.options.timeoutMs); timer.unref();
    owner.pending = deferred.promise.finally(() => {
      clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
      owner.context?.owners.delete(owner); this.#owners.delete(owner);
    });
    try { this.#enqueue(owner); } catch (error) { owner.reject(error); }
    return owner.pending;
  }
  #enqueue(owner) {
    if (owner.controller.signal.aborted || this.#closed || this.#closingSources.has(owner.sourceId)) { owner.reject(owner.controller.signal.reason || problem('TRANSPORT_CLOSED')); return; }
    const context = this.#context(owner);
    context.queue.push(owner);
    this.#startPump(context);
  }
  #startPump(context) {
    if (context.worker || context.destroyed || !context.queue.length) return;
    context.worker = this.#pump(context).catch(error => this.#destroy(context, { failure: error })).finally(() => {
      context.worker = undefined; this.#startPump(context);
    });
  }
  #destroy(context, { requeue = false, failure = problem('TRANSPORT_CANCELLED') } = {}) {
    if (!context || context.destroyed) return;
    context.destroyed = true;
    if (this.#contexts.get(context.key) === context) this.#contexts.delete(context.key);
    const destroyWindow = () => { if (context.window && !context.window.isDestroyed()) context.window.destroy(); };
    const active = context.active;
    if (active?.networkDone && !active.networkEnded && !context.window?.isDestroyed()) {
      // Detaching DevTools by destroying its window can resume an intercepted
      // request on Linux. Abort in the renderer first and wait for Chromium's
      // network completion receipt before allowing cookies to be cleared.
      const drain = { sourceId: context.sourceId };
      context.teardown = (async () => {
        let timer;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(problem('TRANSPORT_DRAIN_TIMEOUT')), 3000);
          });
          await Promise.race([
            (async () => {
              await context.window.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'globalThis.__nyoraRequest?.abort();' }]);
              await active.networkDone.promise;
            })(), timeout,
          ]);
        } finally { clearTimeout(timer); destroyWindow(); }
      })();
      drain.pending = context.teardown;
      this.#drains.add(drain);
      context.teardown.then(() => this.#drains.delete(drain), () => {});
    } else destroyWindow();
    for (const owner of context.queue.splice(0)) {
      context.owners.delete(owner); owner.context = undefined;
      if (requeue && !owner.controller.signal.aborted && !this.#closed && !this.#closingSources.has(owner.sourceId)) {
        try { this.#enqueue(owner); } catch (error) { owner.reject(error); }
      } else owner.reject(owner.controller.signal.reason || failure);
    }
  }
  async #pump(context) {
    await context.ready;
    while (!context.destroyed && context.queue.length) {
      const owner = context.queue.shift();
      if (owner.controller.signal.aborted) { owner.reject(owner.controller.signal.reason); continue; }
      context.active = owner;
      try { owner.resolve(await this.#execute(context, owner)); }
      catch (error) { owner.reject(owner.controller.signal.reason || error); }
      finally { if (context.active === owner) context.active = undefined; context.usedAt = Date.now(); }
    }
  }
  #context(owner) {
    const origin = new URL(owner.request.url).origin;
    const key = `${owner.sourceId}\0${origin}`;
    let context = this.#contexts.get(key);
    if (!context) {
      if (this.#contexts.size >= this.options.maxContexts) {
        const idle = [...this.#contexts.values()].filter(value => !value.owners.size).sort((a, b) => a.usedAt - b.usedAt)[0];
        if (!idle) throw problem('TRANSPORT_CONTEXT_LIMIT');
        this.#destroy(idle);
      }
      context = { key, sourceId: owner.sourceId, origin, owners: new Set(), queue: [], usedAt: Date.now(),
        bootstrap: `${origin}/__nyora_transport_${randomBytes(24).toString('hex')}` };
      this.#contexts.set(key, context);
      context.ready = this.#prepare(context);
      // A cancelled queued owner still observes the bootstrap's failure below.
      context.ready.catch(() => {});
    }
    context.owners.add(owner); owner.context = context; context.usedAt = Date.now();
    return context;
  }
  async #prepare(context) {
    const ses = await this.options.sessionForSource(context.sourceId);
    if (context.destroyed || this.#closed) throw problem('TRANSPORT_CANCELLED');
    this.#sessions.set(context.sourceId, ses);
    const window = this.options.createWindow({ show: false, skipTaskbar: true, focusable: false, webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: false, backgroundThrottling: false,
    } });
    context.window = window;
    window.setExcludedFromShownWindowsMenu?.(true);
    // Materialize Chromium's renderer before domain commands: Network.enable
    // otherwise stalls on a newly created WebContents before its first load.
    await window.loadURL('about:blank');
    if (context.destroyed || this.#closed) throw problem('TRANSPORT_CANCELLED');
    const contents = window.webContents;
    const destroyed = Promise.withResolvers();
    context.nativeDestroyed = destroyed.promise;
    contents.once('destroyed', () => destroyed.resolve());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.debugger.attach('1.3');
    context.debug = contents.debugger;
    context.debug.on('message', (_event, method, value) => {
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const owner = context.networkOwners?.get(value.requestId);
        if (owner) { owner.networkEnded = true; owner.networkDone.resolve(); context.networkOwners.delete(value.requestId); }
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      this.#intercept(context, value).catch(error => {
        if (context.active) context.active.failure = error;
        this.#destroy(context, { failure: error });
      });
    });
    const timer = setTimeout(() => this.#destroy(context), 10000); timer.unref();
    try {
      await context.debug.sendCommand('Network.enable');
      await context.debug.sendCommand('Network.setBypassServiceWorker', { bypass: true });
      await context.debug.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', requestStage: 'Response' }] });
      await window.loadURL(context.bootstrap);
      if (context.destroyed || contents.getURL() !== context.bootstrap) throw problem('TRANSPORT_BOOTSTRAP_FAILED');
      context.bootstrapped = true;
    } finally { clearTimeout(timer); }
  }
  async #intercept(context, value) {
    const { requestId, request, responseStatusCode } = value;
    if (!context.bootstrapped && request.url === context.bootstrap && responseStatusCode === undefined && value.resourceType === 'Document') {
      if (context.bootstrapServed) throw problem('TRANSPORT_BOOTSTRAP_REUSED');
      context.bootstrapServed = true;
      await context.debug.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Content-Security-Policy', value: "default-src 'none'; script-src 'none'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" },
        { name: 'Cache-Control', value: 'no-store' }, { name: 'Referrer-Policy', value: 'no-referrer' },
      ], body: Buffer.from('<!doctype html><title>Nyora private source transport</title>').toString('base64') });
      return;
    }
    const owner = context.active;
    if (!owner || owner.controller.signal.aborted || request.url !== owner.request.url || value.resourceType === 'Document') {
      await context.debug.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return;
    }
    if (responseStatusCode !== undefined) {
      const headers = {};
      for (const { name, value: content } of value.responseHeaders || []) if (RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = content;
      if (REDIRECTS.has(responseStatusCode)) {
        owner.redirect = { status: responseStatusCode, headers };
        // Renderer manual redirects are opaque. Preserve native metadata in main,
        // abort before any next hop, and let SourceRelay validate that hop itself.
        await context.debug.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return;
      }
      if (Number(headers['content-length']) > this.options.maxResponseBytes) {
        owner.failure = problem('RESPONSE_TOO_LARGE');
        await context.debug.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return;
      }
      owner.responseHeaders = headers;
      await context.debug.sendCommand('Fetch.continueResponse', { requestId }); return;
    }
    if (value.networkId) {
      owner.networkDone ||= Promise.withResolvers();
      context.networkOwners ||= new Map();
      context.networkOwners.set(value.networkId, owner);
    }
    // Let Chromium assemble Cookie from its current jar. The paused request's
    // Cookie header can contain ordinary cookies without its partitioned CHIPS
    // cookies; explicitly replaying it suppresses the native credentials merge.
    // Only relay-approved fields override their matching headers.
    const headers = Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'cookie' && !Object.hasOwn(owner.request.headers, name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) }));
    for (const [name, value] of Object.entries(owner.request.headers)) headers.push({ name, value });
    await context.debug.sendCommand('Fetch.continueRequest', { requestId, headers });
  }
  async #execute(context, owner) {
      const { url, method, body } = owner.request;
      // All requests are same-origin with the inert frame; CSP and CORS remain
      // enabled. Binary results are cloned privately to main as ArrayBuffer.
      const code = `(async () => {
        const controller = new AbortController();
        globalThis.__nyoraRequest = controller;
        let response;
        try {
          response = await fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)}, credentials:'include', redirect:'manual', cache:'no-store', signal:controller.signal,
            ${body ? `body: Uint8Array.from(${JSON.stringify([...body])}),` : ''}});
          const reader = response.body?.getReader(); const chunks = []; let size = 0;
          if (reader) while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > ${this.options.maxResponseBytes}) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
          return {status:response.status, body:bytes.buffer};
        } finally { delete globalThis.__nyoraRequest; }
      })()`;
      let result;
      try { result = await Promise.race([
        context.window.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]),
        // Electron does not always reject an outstanding isolated-world promise
        // when its frame is destroyed. Settle only after native WebContents
        // destruction; reset then closes source connections before storage clear.
        context.nativeDestroyed.then(() => { throw owner.controller.signal.reason || problem('TRANSPORT_CANCELLED'); }),
      ]); }
      catch (error) {
        if (owner.redirect) return new Response(null, owner.redirect);
        throw owner.failure || owner.controller.signal.reason || error;
      } finally {
        if (context.teardown) await context.teardown;
        if (context.active === owner) context.active = undefined;
      }
      if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
      if (owner.failure) throw owner.failure;
      if (owner.redirect) return new Response(null, owner.redirect);
      if (!Number.isInteger(result?.status) || result.status < 200 || result.status > 599 || !(result.body instanceof ArrayBuffer)
        || result.body.byteLength > this.options.maxResponseBytes) throw problem('INVALID_TRANSPORT_RESPONSE');
      return new Response([204, 205, 304].includes(result.status) ? null : Buffer.from(result.body), { status: result.status, headers: owner.responseHeaders });
  }
  async closeSource(sourceId) {
    sourceKey(sourceId);
    this.#closingSources.add(sourceId);
    try {
      const owners = [...this.#owners].filter(value => value.sourceId === sourceId);
      for (const owner of owners) owner.cancel();
      for (const context of [...this.#contexts.values()]) if (context.sourceId === sourceId) this.#destroy(context);
      await Promise.allSettled(owners.map(value => value.pending));
      await Promise.all([...this.#drains].filter(value => value.sourceId === sourceId).map(value => value.pending));
      await this.#sessions.get(sourceId)?.closeAllConnections();
    } finally { this.#closingSources.delete(sourceId); }
  }
  async close() {
    this.#closed = true;
    const owners = [...this.#owners];
    for (const owner of owners) owner.cancel(problem('TRANSPORT_CLOSED'));
    for (const context of [...this.#contexts.values()]) this.#destroy(context);
    await Promise.allSettled(owners.map(value => value.pending));
    await Promise.allSettled([...this.#sessions.values()].map(ses => ses.closeAllConnections()));
    this.#facades.clear(); this.#sessions.clear();
  }
}
module.exports = { BrowserContextTransport, requestOptions };
