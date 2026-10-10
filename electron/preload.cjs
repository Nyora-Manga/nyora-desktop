'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose fixed operations, never ipcRenderer or a generic IPC method.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('nyoraDesktop', Object.freeze({
    onNavigate: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('Navigation listener must be a function');
      const handler = (_event, route) => { if (['discover', 'library', 'explore', 'search', 'downloads', 'local', 'settings', 'history', 'bookmarks', 'updates', 'stats'].includes(route)) listener(route); };
      ipcRenderer.on('nyora:navigate', handler);
      return () => ipcRenderer.removeListener('nyora:navigate', handler);
    },
    onCommand: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('Command listener must be a function');
      const handler = (_event, command) => { if (['palette', 'shortcuts', 'back', 'forward', 'search-focus'].includes(command)) listener(command); };
      ipcRenderer.on('nyora:command', handler);
      return () => ipcRenderer.removeListener('nyora:command', handler);
    },
    runtimeStatus: async () => ({
      ...await ipcRenderer.invoke('nyora:runtime-status'),
      rendererSandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
    openVerification: ({ sourceId, url } = {}) => ipcRenderer.invoke('nyora:open-verification', { sourceId, url }),
    saveSourceCookies: ({ sourceId } = {}) => ipcRenderer.invoke('nyora:save-source-cookies', { sourceId }),
    resetSourceSession: ({ sourceId } = {}) => ipcRenderer.invoke('nyora:reset-source-session', { sourceId }),
    verificationStatus: () => ipcRenderer.invoke('nyora:verification-status'),
    onNativeDataChanged: listener => {
      if(typeof listener!=='function')throw new TypeError('Data listener must be a function');
      const handler=()=>listener();ipcRenderer.on('nyora:native-data-changed',handler);
      return ()=>ipcRenderer.removeListener('nyora:native-data-changed',handler);
    },
    openBackupFolder: () => ipcRenderer.invoke('nyora:open-backup-folder'),
    backupExport: () => ipcRenderer.invoke('nyora:backup-export'),
    backupImport: (mode = 'merge') => ipcRenderer.invoke('nyora:backup-import', mode),
    serviceRequest: ({ operation, params } = {}) => ipcRenderer.invoke('nyora:service-request', { operation, params }),
  }));
}
