import { nativeServices } from './native-services.js';
export const SOURCE_PREFERENCES_KEY = null;
export function sourcePreference(id) {
  const source = nativeServices.snapshot().sources.find((source) => source.id === id);
  if (!source) return { enabled: false, pinned: false };
  return { enabled: source.isInstalled, pinned: source.isPinned };
}
export async function setSourcePreference(id, change) {
  const { api } = await import('./native-api.js');
  if (change.enabled !== undefined) await (change.enabled ? api.installSource(id) : api.uninstallSource(id));
  if (change.pinned !== undefined) await api.pinSource(id, change.pinned);
}
export async function setInstalledSources(ids) { const { api } = await import('./native-api.js'); return api.setInstalledSources(ids); }
const disabled = () => { throw new Error('Browser source sync is unavailable in desktop mode.'); };
export const enableSources = disabled;
export const sourcePrefRows = disabled;
export const applySourcePrefRows = disabled;
