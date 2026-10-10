import { nativeServices } from './native-services.js';
export function createNativeBackup(bridge, services) {
  const available = typeof bridge?.backupExport === 'function' && typeof bridge?.backupImport === 'function';
  const run = async (method, importMode, mode) => {
    if (!available) throw new Error('Native portable backup is unavailable in this runtime.');
    const result = await services.performBackup(() => mode === undefined ? bridge[method]() : bridge[method](mode), importMode);
    if (!['cancelled', 'saved', 'completed'].includes(result?.status)) throw new Error('Native backup returned an unrecognized result.');
    return result;
  };
  return Object.freeze({ available, export: () => run('backupExport', false), import: (mode = 'merge') => run('backupImport', true, mode), reload: () => services.hydrate(), cacheStatus: () => services.cacheStatus() });
}
export const nativeBackup = createNativeBackup(globalThis.nyoraDesktop, nativeServices);
