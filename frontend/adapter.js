export function createDesktopAdapter(bridge = globalThis.nyoraDesktop) {
  const available = !!bridge && ['runtimeStatus', 'openVerification', 'resetSourceSession'].every((name) => typeof bridge[name] === 'function');
  const native = (method, args) => {
    if (!available) return Promise.reject(new Error('Native runtime unavailable. Launch with npm run dev to verify Electron/Chromium.'));
    return bridge[method](args);
  };
  return Object.freeze({
    mode: 'desktop',
    nativeAvailable: available,
    runtimeStatus: () => native('runtimeStatus'),
    verificationStatus: () => typeof bridge?.verificationStatus === 'function' ? bridge.verificationStatus() : Promise.resolve([]),
    openVerification: (sourceId, url) => native('openVerification', { sourceId, url }),
    saveSourceCookies: (sourceId) => typeof bridge?.saveSourceCookies === 'function'
      ? native('saveSourceCookies', { sourceId }) : Promise.reject(new Error('Cookie saving unavailable in this runtime.')),
    resetSourceSession: (sourceId) => native('resetSourceSession', { sourceId }),
  });
}
