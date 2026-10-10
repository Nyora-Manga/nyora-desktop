'use strict';
const { sourceKey, publicHttps } = require('./policy.cjs');
const { randomUUID } = require('node:crypto');
const requestKey = (operation, params) => JSON.stringify([operation, Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b))]);
const usable = (operation, result) => {
  if (result?.error) return false;
  if (operation === 'content.details') return typeof result?.manga?.id === 'string' && Boolean(result.manga.id);
  if (operation === 'content.pages') return Array.isArray(result?.pages)
    && result.pages.some(page => typeof page === 'string' ? Boolean(page) : typeof page?.url === 'string' && Boolean(page.url));
  return ['content.popular', 'content.latest', 'content.search'].includes(operation)
    && Array.isArray(result?.entries) && result.entries.some(item => typeof item?.id === 'string' && item.id);
};

// Tracks the need for user interaction, not cookie-based claims of success.
// Only a successful parsed helper read can clear a pending challenge.
class SourceVerification {
  #pending = new Map();
  #checkpoints = new WeakMap();
  constructor(catalogueLookup, { maximum = 64, lifetime = 30 * 60 * 1000 } = {}) {
    this.lookup = catalogueLookup;
    this.maximum = maximum;
    this.lifetime = lifetime;
  }
  descriptor(sourceId) {
    sourceKey(sourceId);
    const descriptor = this.lookup(sourceId);
    if (!descriptor || descriptor.sourceId !== sourceId) throw new Error('Unknown catalogue source');
    return descriptor;
  }
  target(sourceId, requested) {
    const descriptor = this.descriptor(sourceId);
    const url = requested || this.#pending.get(sourceId)?.url || descriptor.baseUrl || `${descriptor.baseOrigin}/`;
    if (typeof url !== 'string' || url.length > 8192 || !publicHttps(url)
      || (!descriptor.allowedOrigins.includes(new URL(url).origin) && new URL(url).href !== this.#pending.get(sourceId)?.url)) throw new Error('Verification URL must belong to the selected source');
    return new URL(url).href;
  }
  required({ sourceId, url }, { fromRelay = false, manual = false, opening = false } = {}) {
    this.descriptor(sourceId);
    // The private relay has already checked exact media authority and DNS. This
    // branch has no renderer entry point; it admits only that challenged URL.
    if (fromRelay && (typeof url !== 'string' || url.length > 8192 || !publicHttps(url))) throw new Error('Invalid relay challenge target');
    const target = fromRelay ? new URL(url).href : this.target(sourceId, url);
    const existing = this.#pending.get(sourceId);
    if (!existing && this.#pending.size >= this.maximum) this.#pending.delete(this.#pending.keys().next().value);
    const pending = { url: target, phase: existing?.phase === 'verification-opened' ? existing.phase : 'verification-required', at: Date.now(),
      manual: manual && !existing?.requests.size && !existing?.images.size,
      verificationId: existing?.verificationId,
      identity: existing?.identity || {}, boundary: existing?.boundary || {},
      requests: existing?.requests || new Map(), images: existing?.images || new Map(),
      deferred: existing?.deferred || new Map(),
      unbound: existing?.unbound || 0 };
    if (!opening) {
      // Relay notices precede the helper's operation error. Until that error
      // binds its request key, a changed URL might be a redirect of any read.
      pending.unbound = Math.min(2, pending.unbound + 1);
    }
    this.#pending.set(sourceId, pending);
  }
  opened(sourceId, url) {
    // A proactive source check has no original failed request. Its next usable,
    // source-bound read can confirm access after the user closes the window.
    // Reopening an actual challenge must retain its exact retry requirements.
    this.required({ sourceId, url }, { manual: this.#pending.get(sourceId)?.manual ?? true, opening: true });
    const pending = this.#pending.get(sourceId);
    pending.phase = 'verification-opened';
    // Only an explicit open starts a retry cycle. Repeated failures/close events
    // retain this opaque ID so polling cannot retry the same cycle indefinitely.
    pending.verificationId = randomUUID();
    pending.boundary = {};
    pending.deferred.clear();
  }
  closed(sourceId) {
    const pending = this.#pending.get(sourceId);
    if (pending?.phase === 'verification-opened') {
      pending.phase = 'retry-required'; pending.at = Date.now();
      // An explicit verification cycle supplies a new retry boundary for an
      // ambiguous batch. Never replay responses retained before that boundary.
      pending.unbound = 0; pending.deferred.clear();
      pending.boundary = {};
    }
  }
  reset(sourceId) { this.#pending.delete(sourceId); }
  checkpoint() {
    // Main keeps this token with a dispatched request. Captured references and
    // phases remain private and cannot be replaced by renderer parameters.
    const token = Object.freeze(Object.create(null));
    this.#checkpoints.set(token, new Map([...this.#pending].map(([sourceId, pending]) => [sourceId, {
      pending, phase: pending.phase, identity: pending.identity, boundary: pending.boundary,
      requests: new Map(pending.requests), images: new Map(pending.images),
    }])));
    return token;
  }
  #currentProof(sourceId, pending, options, kind, key) {
    // Direct trusted callers may omit a checkpoint. Main always supplies one;
    // unknown tokens fail closed rather than admitting an old cached result.
    if (!Object.hasOwn(options, 'checkpoint')) return true;
    const captured = this.#checkpoints.get(options.checkpoint)?.get(sourceId);
    if (!captured || captured.identity !== pending.identity || captured.boundary !== pending.boundary) return false;
    if (pending.manual) return captured.pending === pending && captured.phase === 'retry-required';
    const proof = pending[kind].get(key);
    return Boolean(proof && captured[kind].get(key) === proof);
  }
  #accept(sourceId, pending, kind, key, options) {
    if (!this.#currentProof(sourceId, pending, options, kind, key)) return;
    if (pending.unbound) {
      // Bound memory even if a helper never reports its failed operation. An
      // ambiguous batch is deliberately not released by one later failure.
      if (pending.unbound === 1 && pending.deferred.size < this.maximum)
        pending.deferred.set(JSON.stringify([kind, key]), { kind, key, options });
      return;
    }
    pending[kind].delete(key);
    this.#advance(sourceId, pending);
  }
  #bound(sourceId, pending) {
    if (pending.unbound !== 1) { pending.deferred.clear(); return; }
    pending.unbound = 0;
    const deferred = [...pending.deferred.values()];
    pending.deferred.clear();
    for (const { kind, key, options } of deferred) {
      if (this.#pending.get(sourceId) !== pending) break;
      this.#accept(sourceId, pending, kind, key, options);
    }
  }
  failed(operation, params, error) {
    if (error?.code !== 'SOURCE_VERIFICATION_REQUIRED' || typeof params?.id !== 'string') return;
    const pending = this.#pending.get(params.id);
    if (pending) {
      pending.manual = false;
      pending.requests.set(requestKey(operation, params), { url: pending.url });
      this.#bound(params.id, pending);
    }
  }
  completed(operation, params, result, options = {}) {
    if (operation === 'content.globalSearch' && Array.isArray(result?.groups)) {
      const key = requestKey(operation, params);
      for (const group of result.groups) {
        const pending = this.#pending.get(group?.sourceId);
        if (!pending) continue;
        if (typeof group.error === 'string' && group.error.includes('verification_required')) {
          pending.manual = false; pending.requests.set(key, { url: pending.url });
          this.#bound(group.sourceId, pending);
        } else if (!group.error && pending.requests.has(key) && (usable('content.search', group)
          || this.#emptySearch(group.sourceId, pending, key, group, options))) {
          this.#accept(group.sourceId, pending, 'requests', key, options);
        }
      }
      return;
    }
    const pending = this.#pending.get(params?.id);
    const key = requestKey(operation, params);
    if (!pending || (!usable(operation, result)
      && !(operation === 'content.search' && this.#emptySearch(params.id, pending, key, result, options)))) return;
    const manualRead = pending.manual && pending.phase === 'retry-required' && !pending.requests.size && !pending.images.size;
    if (!pending.requests.has(key) && !manualRead) return;
    this.#accept(params.id, pending, 'requests', key, options);
  }
  #emptySearch(sourceId, pending, key, result, options) {
    // A fresh retry of an already failed query may legitimately have no matches.
    // Empty home/pages/manual reads and unchecked direct calls remain inconclusive.
    return !result?.error && Array.isArray(result?.entries) && result.entries.length === 0
      && pending.requests.has(key) && Object.hasOwn(options, 'checkpoint')
      && this.#currentProof(sourceId, pending, options, 'requests', key);
  }
  imageResult(route, error, options = {}) {
    const query = new URL(route).searchParams;
    const sourceId = query.get('sourceId');
    const target = query.get('u');
    const pending = this.#pending.get(sourceId);
    if (!pending || !publicHttps(target)) return;
    const key = new URL(target).href;
    if (error?.code === 'SOURCE_VERIFICATION_REQUIRED') {
      pending.manual = false; pending.images.set(key, { url: key });
      this.#bound(sourceId, pending);
    } else if (!error && pending.images.has(key)) this.#accept(sourceId, pending, 'images', key, options);
  }
  #advance(sourceId, pending) {
    if (!pending.requests.size && !pending.images.size) { this.#pending.delete(sourceId); return; }
    pending.url = pending.images.values().next().value?.url || pending.requests.values().next().value?.url;
    // Remaining reads may still be in flight or have a temporary network error.
    // Only required() records a new challenge; partial success must not turn a
    // post-close retry into another request for human verification.
  }
  status() {
    const result = [];
    for (const [sourceId, item] of this.#pending) {
      if (item.phase !== 'verification-opened' && Date.now() - item.at > this.lifetime) { this.#pending.delete(sourceId); continue; }
      result.push({ sourceId, origin: new URL(item.url).origin, phase: item.phase, manual: Boolean(item.manual),
        ...(item.verificationId ? { verificationId: item.verificationId } : {}) });
    }
    return result;
  }
}
module.exports = { SourceVerification };
