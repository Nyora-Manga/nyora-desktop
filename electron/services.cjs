'use strict';
const { sourceKey, publicHttps, bundledUrl, contentKey } = require('./policy.cjs');
const { normalizeNativeMedia } = require('./media.cjs');
const { EXTRA_PREFS, validatePrefs } = require('./reader-state.cjs');

const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

class DesktopServices {
  constructor({ helper, preferences, contract, authorizeMedia = () => {}, makeImageUrl, sourceOrigin, appOrigin, readerState, nativeRequest }) {
    if (contract.schemaVersion !== 1 || !ownObject(contract.operations)) throw new Error('Unsupported desktop service contract');
    this.helper = helper;
    this.readerState = readerState;
    this.nativeRequest = nativeRequest;
    this.preferences = preferences;
    this.operations = contract.operations;
    this.authorizeMedia = authorizeMedia;
    this.makeImageUrl = makeImageUrl;
    this.sourceOrigin = sourceOrigin;
    this.appOrigin = appOrigin;
  }

  async request({ operation, params = {} } = {}, { fresh = false } = {}) {
    if (typeof operation !== 'string' || !ownObject(params) || Buffer.byteLength(JSON.stringify(params)) > 131072) throw new Error('Invalid native service operation');
    if (!Object.hasOwn(this.operations, operation)) throw new Error('Unknown native service operation');
    const definition = this.operations[operation];
    const accepted = new Set([...definition.params, ...(definition.bodyParam ? [definition.bodyParam] : [])]);
    if (Object.keys(params).some(key => !accepted.has(key))) throw new Error('Unexpected native service parameter');
    if (operation === 'library.readMarks') return (await this.readerState.get(params.mangaId)).marks;
    if (operation === 'library.readMarksSave') return (await this.readerState.saveMarks(params.mangaId, { read: params.read, unread: params.unread })).marks;
    if (definition.native && !operation.startsWith('ui.preferences.')) {
      if (typeof this.nativeRequest !== 'function') throw new Error('This native feature is unavailable');
      return this.nativeRequest(operation, params);
    }
    if (operation === 'ui.preferences.get') {
      if (Object.keys(params).length) throw new Error('Unexpected preference parameters');
      return this.preferences.get();
    }
    if (operation === 'ui.preferences.save') {
      if (Object.keys(params).some((key) => key !== 'patch')) throw new Error('Unexpected preference parameters');
      return this.preferences.save(params.patch);
    }
    if (!Object.hasOwn(this.operations, operation)) throw new Error('Unknown native service operation');
    const spec = this.operations[operation];
    if (!['GET', 'POST', 'DELETE'].includes(spec.method) || !/^\/[a-zA-Z0-9/_-]+$/.test(spec.path)) throw new Error('Invalid native service definition');
    const allowed = new Set([...spec.params, ...(spec.bodyParam ? [spec.bodyParam] : [])]);
    if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error('Unexpected native service parameter');
    const titleExtras = operation === 'library.mangaPrefsSave' ? Object.fromEntries(Object.entries(params).filter(([key]) => EXTRA_PREFS.includes(key))) : {};
    if (operation === 'library.mangaPrefsSave') validatePrefs(titleExtras);
    const query = new URLSearchParams();
    for (const key of spec.params) {
      if (operation === 'library.mangaPrefsSave' && EXTRA_PREFS.includes(key)) continue;
      const value = params[key];
      if (value === undefined || value === null) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 16384) throw new Error(`Invalid native parameter: ${key}`);
      if (key === 'sourceId' || (key === 'id' && (operation.startsWith('sources.') || operation.startsWith('content.')))) sourceKey(value);
      if (key === 'url' && !contentKey(value)) throw new Error('Content requests require a valid source content key');
      query.set(key, String(value));
    }
    // Main supplies this option for a pending verification. It is not a renderer
    // parameter and must not change the exact request identity used as proof.
    if (fresh && ['content.popular', 'content.latest', 'content.search', 'content.details', 'content.pages', 'content.globalSearch'].includes(operation)) query.set('refresh', '1');
    let json;
    if (spec.bodyParam === 'ids') {
      if (!Array.isArray(params.ids) || params.ids.length > 4096) throw new Error('Invalid native source selection');
      for (const id of params.ids) sourceKey(id);
      json = params.ids;
    }
    await this.helper.start();
    const response = await this.helper.request(`${spec.path}${query.size ? `?${query}` : ''}`, { method: spec.method, json });
    if (!response.contentType.toLowerCase().includes('application/json')) throw new Error('Native service returned an unexpected content type');
    const data = JSON.parse(response.bytes.toString('utf8'));
    if (data && typeof data.error === 'string') throw new Error(data.error.slice(0, 500));
    if (this.readerState && operation === 'library.mangaPrefsSave') await this.readerState.savePreferences(params.mangaId, titleExtras);
    if (this.readerState && operation === 'library.mangaPrefsClear') await this.readerState.clearPreferences(params.mangaId);
    if (this.readerState && operation === 'library.mangaPrefs') {
      const { preferences } = await this.readerState.get(params.mangaId);
      return { ...data, ...preferences, present: !!data.present || Object.keys(preferences).length > 0 };
    }
    return normalizeNativeMedia(data, {
      sourceId: operation.startsWith('content.') ? params.id : undefined,
      pages: operation === 'content.pages', authorizeMedia: this.authorizeMedia,
      makeImageUrl: this.makeImageUrl, sourceOrigin: this.sourceOrigin,
    });
  }

  // Only the capability-checked local server calls this route. No credentials,
  // helper port, arbitrary path or response cookies cross the renderer bridge.
  async image(url, { signal } = {}) {
    const request = new URL(url);
    if (!bundledUrl(url, this.appOrigin) || request.pathname !== '/helper-image') throw new Error('Invalid image route');
    if ([...request.searchParams.keys()].some((key) => !['u', 'h', 'sourceId'].includes(key)) || request.searchParams.getAll('u').length !== 1
      || request.searchParams.getAll('sourceId').length !== 1) throw new Error('Invalid image parameters');
    const target = request.searchParams.get('u');
    if (!target || target.length > 8192 || !publicHttps(target)) throw new Error('Images require a public HTTPS URL');
    const query = new URLSearchParams({ u: target });
    const sourceId = request.searchParams.get('sourceId');
    if (sourceId) { sourceKey(sourceId); query.set('sourceId', sourceId); }
    const headers = request.searchParams.getAll('h');
    if (headers.length > 4) throw new Error('Too many image headers');
    for (const header of headers) {
      const match = /^Referer:(.+)$/i.exec(header);
      if (!match || !publicHttps(match[1]) || header.length > 8192) throw new Error('Unsupported image header');
      query.append('h', `Referer:${match[1]}`);
    }
    signal?.throwIfAborted();
    let abort;
    try {
      const starting = this.helper.start();
      if (signal) await Promise.race([starting, new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      else await starting;
    } finally { if (abort) signal.removeEventListener('abort', abort); }
    signal?.throwIfAborted();
    const result = await this.helper.request(`/image?${query}`, { maxBytes: 32 * 1024 * 1024, signal });
    if (!/^(image\/(?!svg\+xml)[a-z0-9.+-]+|application\/octet-stream)(;|$)/i.test(result.contentType)) throw new Error('Source returned non-image content');
    return result;
  }
}

module.exports = { DesktopServices };
