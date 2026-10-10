import { nativeServices } from './native-services.js';
export function createNativeDownloads(request, { pollMs = 1000 } = {}) {
  let snapshot = { entries: [], queuePaused: false, settings: { format: 'CBZ', maxConcurrent: 2, imageConcurrency: 4, retries: 2, keepOffline: true, saveToDevice: false } };
  let queue = Promise.resolve(), refreshing, timer, lastError;
  const listeners = new Set(), clone = value => structuredClone(value);
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = await request('downloads.snapshot');
      if (!Array.isArray(next?.entries) || !next.settings) throw new Error('Download state could not be loaded.');
      snapshot = { ...clone(next), queuePaused: next.queuePaused ?? false }; lastError=null; for (const listener of listeners) listener(); return clone(snapshot);
    })();
    try { return await refreshing; } catch(error) {const changed=lastError!==error.message;lastError=error.message;if(changed)for(const listener of listeners)listener();throw error;} finally { refreshing = null; }
  }
  const exportReceipt = async (operation, params, count) => {
    const result = await request(operation, params);
    if(result?.cancelled === true) return { ok: false, status: 'cancelled', count: 0 };
    if(result?.exported === true) return { ok: true, status: 'saved', count };
    throw new Error('Export result could not be confirmed.');
  };
  const mutate = (operation, params = {}) => {
    const task = queue.catch(() => {}).then(async () => { await refresh(); const result = await request(operation, params); await refresh(); return result; });
    queue = task; return task;
  };
  return Object.freeze({
    STATUS: Object.freeze(Object.fromEntries(['QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED'].map(key => [key, key]))), FORMATS: ['CBZ','ZIP'],
    hydrate: refresh, error:()=>lastError, warnings:()=>clone(snapshot.warnings||[]), list: () => clone(snapshot.entries), get: id => clone(snapshot.entries.find(job => job.id === id) || null),
    statusOf: (sourceId, chapterUrl) => clone(snapshot.entries.find(job => job.sourceId === sourceId && job.chapterUrl === chapterUrl) || null),
    counts: () => snapshot.entries.reduce((counts, job) => { counts[job.status.toLowerCase()]++; if(job.status === 'COMPLETED') counts.totalBytes += job.bytes || 0; return counts; }, { queued:0, running:0, completed:0, failed:0, cancelled:0, totalBytes:0 }),
    queuePaused: () => snapshot.queuePaused, pause: () => mutate('downloads.pause'), resume: () => mutate('downloads.resume'), retryFailed: () => mutate('downloads.retryFailed'),
    getSettings: () => clone(snapshot.settings), saveSettings: patch => mutate('downloads.settings.save', { patch }),
    enqueue: descriptors => mutate('downloads.enqueue', { descriptors: Array.isArray(descriptors) ? descriptors : [descriptors] }),
    cancel: id => mutate('downloads.cancel', { id }), cancelAll: () => mutate('downloads.cancelAll'), retry: id => mutate('downloads.retry', { id }),
    remove: id => mutate('downloads.remove', { id }), clearCompleted: () => mutate('downloads.clearCompleted'), clearAll: () => mutate('downloads.clearAll'),
    open: id => request('downloads.open', { id }), saveToDevice: id => exportReceipt('downloads.export', { id }, 1), saveBundle: ids => exportReceipt('downloads.exportBundle', { ids }, ids.length),
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) timer = setInterval(() => { void refresh().catch(()=>{}); }, pollMs);
      return () => { listeners.delete(listener); if(!listeners.size) { clearInterval(timer); timer = null; } };
    },
  });
}
export const downloads = createNativeDownloads((operation,params={}) => nativeServices.request(operation,params));
export default downloads;
