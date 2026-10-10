const unavailable = () => { throw new Error('This feature is unavailable until its native desktop adapter is implemented.'); };
export const downloads = Object.freeze({
  list: () => [], statusOf: () => null, counts: () => ({ total: 0, active: 0, running: 0, queued: 0, completed: 0, failed: 0 }), subscribe: () => () => {},
  getSettings: unavailable, saveSettings: unavailable, enqueue: unavailable, cancel: unavailable, cancelAll: unavailable,
  retry: unavailable, remove: unavailable, clearCompleted: unavailable, clearAll: unavailable, getBlob: unavailable, saveToDevice: unavailable, saveBundle: unavailable,
});
export const tracking = Object.freeze({
  TRACKERS: [], connectedTrackers: () => [], isConnected: () => false, isEnabled: () => false, linkedMediaId: () => null,
  connect: unavailable, disconnect: unavailable, setEnabled: unavailable, link: unavailable, unlink: unavailable, search: unavailable, getState: unavailable, setState: unavailable,
  scrobbleAll: async () => {},
});
export const files = Object.freeze({ available: false, scan: unavailable, open: unavailable });
export const backup = Object.freeze({ available: false, import: unavailable, export: unavailable });
export const sync = Object.freeze({ available: false, start: unavailable });
export default downloads;
