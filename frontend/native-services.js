import contract from './service-contract.json' with { type: 'json' };
const clone = (value) => value == null ? value : structuredClone(value);
const entries = (value, key = 'entries') => {
  if (!Array.isArray(value?.[key])) throw new Error(`Native service returned an invalid ${key} response.`);
  return value[key];
};
export function createNativeServices(bridge) {
  let state = null;
  let queue = Promise.resolve();
  let refreshRequired = false;
  let backupReloadRequired = false;
  const listeners = new Set();
  const failedContent = new Map();
  const recoveryRequests = new Map();
  const inFlightReads = new Map();
  let sequence = 0;
  const requestKey = (operation, params) => JSON.stringify([operation, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
  const rememberFailure = (sourceId, operation, params) => {
    if (!failedContent.has(sourceId)) failedContent.set(sourceId, new Map());
    failedContent.get(sourceId).set(requestKey(operation, params), { operation, params: clone(params) });
  };
  const forgetFailure = (sourceId, operation, params) => {
    const failed = failedContent.get(sourceId);
    failed?.delete(requestKey(operation, params));
    if (failed?.size === 0) failedContent.delete(sourceId);
  };
  const request = async (operation, params = {}) => {
    if (!Object.hasOwn(contract.operations, operation)) throw new Error(`Unsupported native service operation: ${operation}`);
    if (typeof bridge?.serviceRequest !== 'function') throw new Error('The native data helper is unavailable. Start the packaged helper and retry.');
    const allowed = new Set([...contract.operations[operation].params, ...(contract.operations[operation].bodyParam ? [contract.operations[operation].bodyParam] : [])]);
    if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error(`Unsupported parameters for ${operation}`);
    const key = requestKey(operation, params), attempt = ++sequence;
    const concurrent = inFlightReads.get(key) || { pending: 0, latest: new Map() };
    concurrent.pending++; inFlightReads.set(key, concurrent);
    const settle = (sourceId, failed) => {
      if ((concurrent.latest.get(sourceId) || 0) > attempt) return;
      concurrent.latest.set(sourceId, attempt);
      if (failed) rememberFailure(sourceId, operation, params);
      else forgetFailure(sourceId, operation, params);
    };
    try {
      const result = await bridge.serviceRequest({ operation, params: clone(params) });
      if (result?.error) throw new Error(String(result.error));
      if (operation === 'content.globalSearch' && Array.isArray(result?.groups)) {
        let failed = false;
        for (const group of result.groups) {
          if (typeof group?.sourceId !== 'string') continue;
          settle(group.sourceId, !!group.error);
          if (group.error) failed = true;
        }
        if (failed) globalThis.dispatchEvent?.(new CustomEvent('nyora:native-request-failed'));
      } else if (typeof params.id === 'string') settle(params.id, false);
      return result;
    } catch (error) {
      if ((operation.startsWith('content.') || operation === 'sources.filters') && typeof params.id === 'string') settle(params.id, true);
      globalThis.dispatchEvent?.(new CustomEvent('nyora:native-request-failed'));
      throw error;
    } finally {
      // Keep ordering only while overlapping reads can return out of order.
      // Query history is not retained after all requests for a key have settled.
      if (--concurrent.pending === 0) inFlightReads.delete(key);
    }
  };
  const fetchState = async () => {
    const [favourites, history, bookmarks, categories, updates, stats, sources, catalog, uiPreferences] = await Promise.all([
      request('library.favourites'), request('library.history', { limit: 5000 }), request('library.bookmarks'), request('library.categories'),
      request('library.updates'), request('library.stats'), request('sources.list'), request('sources.catalog'), request('ui.preferences.get'),
    ]);
    const next = { favourites: entries(favourites), history: entries(history), bookmarks: entries(bookmarks), categories: entries(categories, 'categories'), updates: entries(updates), stats, sources: entries(sources, 'sources'), catalog: entries(catalog), uiPreferences, categoryEntries: {}, mangaPrefs: {}, readMarks: {} };
    if (!uiPreferences || typeof uiPreferences !== 'object' || Array.isArray(uiPreferences)) throw new Error('Native preferences are unavailable.');
    for (const category of next.categories) next.categoryEntries[String(category.id)] = entries(await request('library.categoryManga', { categoryId: category.id }));
    // Existing prefs are retained in read caches; fresh details explicitly hydrate
    // their per-manga prefs before the reader can consume the returned manga.
    for (const mangaId of Object.keys(state?.mangaPrefs || {})) next.mangaPrefs[mangaId] = await request('library.mangaPrefs', { mangaId });
    const markedTitles = [...new Set([...next.favourites.map(m=>String(m.id)), ...Object.keys(state?.readMarks || {})])];
    for(let start=0;start<markedTitles.length;start+=8) await Promise.all(markedTitles.slice(start,start+8).map(async mangaId=>{
      next.readMarks[mangaId] = await request('library.readMarks', {mangaId});
    }));
    return next;
  };
  const publish = (next) => { state = next; refreshRequired = backupReloadRequired = false; for (const listener of listeners) { try { listener(); } catch (error) { console.error('Native cache listener failed', error); } } };
  const hydrated = () => { if (!state) throw new Error('Native data has not been hydrated.'); return state; };
  const hydrate = async () => { const next = await fetchState(); publish(next); return clone(next); };
  const serialized = (fn) => { const task = queue.catch(() => {}).then(fn); queue = task; return task; };
  const requireEditable = () => { if (backupReloadRequired) throw new Error('Native backup state has not been reloaded. Reload native data before editing.'); };
  const mutate = (operation, params = {}, options = {}) => serialized(async () => {
    requireEditable();
    hydrated();
    if (refreshRequired) await hydrate();
    if (options.when && !options.when()) return clone(options.skippedResult);
    const resolvedParams = typeof params === 'function' ? params() : params;
    // IPC failure cannot tell us whether the helper committed. Retain the last
    // confirmed cache, but require a native reload before another mutation.
    refreshRequired = true;
    const result = await request(operation, resolvedParams);
    try { publish(await fetchState()); }
    catch (error) { throw new Error(`The native write was acknowledged, but refreshed data is unavailable. Retry loading before editing again: ${error.message}`); }
    return clone(result);
  });
  return Object.freeze({
    request, hydrate: () => serialized(hydrate), mutate,
    cacheStatus: () => ({ hydrated: !!state, writeAvailable: !!state && !backupReloadRequired, refreshRequired }),
    performBackup: (operation, importMode = false) => serialized(async () => {
      hydrated();
      if (refreshRequired) await hydrate();
      if (importMode) refreshRequired = backupReloadRequired = true;
      let result, failure;
      try { result = await operation(); } catch (error) { failure = error; }
      if (importMode) {
        try { await hydrate(); }
        catch (error) { throw new Error(`Native backup data may have changed. Editing remains disabled until native data reloads: ${error.message}${failure ? ` (${failure.message})` : ''}`); }
      }
      if (failure) throw failure;
      return result;
    }),
    canRetryContent: (sourceId) => failedContent.has(sourceId),
    checkSourceAccess: (sourceId) => request('content.popular', { id: sourceId, page: 1 }),
    async retryContent(sourceId) {
      const previous = [...(failedContent.get(sourceId)?.values() || [])];
      if (!previous.length) throw new Error('Reload the source screen to retry its request.');
      const retriedRequests = [];
      let failure;
      for (const entry of previous) {
        const key = requestKey(entry.operation, entry.params);
        try {
          // One global search can have several challenged source groups. Share
          // its in-flight replay instead of sending that query once per group.
          if (!recoveryRequests.has(key)) {
            const pending = request(entry.operation, entry.params).finally(() => {
              if (recoveryRequests.get(key) === pending) recoveryRequests.delete(key);
            });
            recoveryRequests.set(key, pending);
          }
          const result = await recoveryRequests.get(key);
          if (entry.operation === 'content.globalSearch') {
            const group = result?.groups?.find(group => group.sourceId === sourceId);
            if (!group || group.error) throw new Error(group?.error || 'This source did not return search results.');
          }
          if (failedContent.get(sourceId)?.has(key)) throw new Error('Source access needs another check.');
          retriedRequests.push(clone(entry));
        } catch (error) { failure ||= error; }
      }
      if (failure) {
        const error = new Error(String(failure.message || failure));
        error.retriedRequests = retriedRequests;
        throw error;
      }
      return { retriedRequests };
    },
    snapshot: () => clone(hydrated()),
    uiPreferences: () => clone(hydrated().uiPreferences),
    saveUiPreferences: (patch) => mutate('ui.preferences.save', { patch }).then(() => clone(hydrated().uiPreferences)),
    loadMangaPrefs: (mangaId) => serialized(async () => {
      if (refreshRequired) await hydrate();
      const [result,marks] = await Promise.all([request('library.mangaPrefs', { mangaId: String(mangaId) }),request('library.readMarks', {mangaId:String(mangaId)})]);
      const next = clone(hydrated()); next.mangaPrefs[String(mangaId)] = result; next.readMarks[String(mangaId)] = marks; publish(next);
      return clone(result);
    }),
    setSourcePinned: (id, desired) => serialized(async () => {
      requireEditable();
      if (refreshRequired) await hydrate();
      const source = hydrated().sources.find((entry) => entry.id === id);
      if (!source) throw new Error('The source is not available in the native database.');
      if (!!source.isPinned === desired) return { ok: true };
      refreshRequired = true;
      const result = await request('sources.pinToggle', { id });
      publish(await fetchState());
      if (!!hydrated().sources.find((entry) => entry.id === id)?.isPinned !== desired) throw new Error('Native source pin state was not confirmed.');
      return clone(result);
    }),
    async setFavourite(mangaId, desired) {
      return serialized(async () => {
        requireEditable();
        hydrated();
        if (refreshRequired) await hydrate();
        if (hydrated().favourites.some((manga) => String(manga.id) === String(mangaId)) === desired) return { favourited: desired };
        refreshRequired = true;
        const result = await request('library.favouriteToggle', { mangaId: String(mangaId) });
        publish(await fetchState());
        if (result.favourited !== desired) throw new Error('Native favourite state did not match the requested change.');
        return clone(result);
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}
export const nativeServices = createNativeServices(globalThis.nyoraDesktop);
export async function desktopMutation(operation) {
  try { return await operation(); }
  catch (error) {
    globalThis.dispatchEvent?.(new CustomEvent('nyora:service-error', { detail: String(error?.message || error) }));
    throw error;
  }
}
