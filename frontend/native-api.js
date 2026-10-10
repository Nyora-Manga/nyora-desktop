import { nativeServices } from './native-services.js';
import library from './native-library.js';
import contract from './service-contract.json' with { type: 'json' };
const unavailable = () => { throw new Error('This feature has no native desktop adapter yet.'); };
import { requireSourceId as canonical } from './native-source-identity.js';
import { nativeImageUrl, nativeMangaImages } from './native-images.js';
export { nativeImageUrl, nativeMangaImages } from './native-images.js';
export async function helperSourceId(id) { return canonical(id); }
async function browse(operation, params) {
  const result = await nativeServices.request(operation, params);
  if (!Array.isArray(result?.entries)) throw new Error('Native browse response omitted its entries.');
  return { ...result, entries: result.entries.map((manga) => nativeMangaImages(manga, params.id)) };
}
async function discovery(operation, params = {}) {
  const result = await nativeServices.request(operation, params);
  return nativeDiscoveryResponse(operation, result);
}
export function nativeDiscoveryResponse(operation, result) {
  const mangaDTO = (manga, sourceId = manga.sourceId) => nativeMangaImages({ ...manga, ...(sourceId ? { source: { name: canonical(sourceId) } } : {}), ...(manga.publicUrl && !manga.url ? { url: manga.publicUrl } : {}) }, sourceId);
  if (operation === 'content.globalSearch') {
    if (!Array.isArray(result?.groups)) throw new Error('Native global search omitted its groups.');
    return { ...result, groups: result.groups.map((group) => ({ ...group, entries: group.entries.map((manga) => mangaDTO(manga, group.sourceId)) })) };
  }
  if (!Array.isArray(result?.entries)) throw new Error('Native discovery response omitted its entries.');
  return { ...result, entries: result.entries.map((entry) => operation === 'content.alternatives' ? { ...entry, manga: mangaDTO(entry.manga, entry.sourceId) } : mangaDTO(entry)) };
}
async function route(path, method) {
  if (!String(path).startsWith('/')) throw new Error('Only named native service routes are supported.');
  const parsed = new URL(path, 'nyora://app');
  const entry = Object.entries(contract.operations).find(([, spec]) => spec.path === parsed.pathname && spec.method === method);
  if (!entry) throw new Error('This helper operation has no native desktop adapter.');
  const [operation, spec] = entry;
  const params = Object.fromEntries(parsed.searchParams);
  if (spec.bodyParam) throw new Error('This operation requires its named desktop API.');
  return nativeServices.request(operation, params);
}
export const get = (path) => route(path, 'GET');
export const post = (path) => route(path, 'POST');
export const del = (path) => route(path, 'DELETE');
export const api = {
  get, post, del,
  prepareSourceMigration: async () => {},
  listSources: async () => ({ sources: nativeServices.snapshot().sources.filter((source) => source.isInstalled) }),
  catalog: async () => ({ entries: nativeServices.snapshot().catalog }),
  refreshSources: () => nativeServices.mutate('sources.refresh'),
  isSourceNsfw(id) { return nativeServices.snapshot().catalog.find((source) => source.id === id)?.isNsfw ?? null; },
  installSource: (id) => nativeServices.mutate('sources.install', { id: canonical(id) }),
  uninstallSource: (id) => nativeServices.mutate('sources.uninstall', { id: canonical(id) }),
  pinSource: (id, pinned) => nativeServices.setSourcePinned(canonical(id), !!pinned),
  setInstalledSources: (ids) => nativeServices.mutate('sources.setInstalled', { ids: ids.map(canonical) }),
  enableSetupNsfwSources: () => api.installNsfwSources(),
  async installNsfwSources() {
    const snapshot = nativeServices.snapshot();
    const ids = snapshot.catalog.filter((source) => source.isInstalled || source.isNsfw).map((source) => canonical(source.id));
    const added = ids.filter((id) => !snapshot.catalog.find((source) => source.id === id)?.isInstalled).length;
    await nativeServices.mutate('sources.setInstalled', { ids }); return { added };
  },
  sourceFilters: (id) => nativeServices.request('sources.filters', { id: canonical(id) }),
  popular: (id, page = 1) => browse('content.popular', { id: canonical(id), page }),
  latest: (id, page = 1) => browse('content.latest', { id: canonical(id), page }),
  search: (id, q, page = 1, filters) => browse('content.search', { id: canonical(id), q, page, ...(filters?.length ? { f: JSON.stringify(filters) } : {}) }),
  async details(id, url) {
    const result = await nativeServices.request('content.details', { id: canonical(id), url });
    if (!result?.manga?.id) throw new Error('Native details omitted the canonical manga ID.');
    await nativeServices.loadMangaPrefs(result.manga.id);
    return { ...result, manga: nativeMangaImages(result.manga, id) };
  },
  async pages(id, url, refresh) {
    const result = await nativeServices.request('content.pages', { id: canonical(id), url, ...(refresh ? { refresh: 1 } : {}) });
    if (!Array.isArray(result?.pages)) throw new Error('Native pages response omitted its pages.');
    return { ...result, pages: result.pages.map((page) => typeof page === 'string' ? nativeImageUrl(page, undefined, id) : { ...page, url: nativeImageUrl(page.url, page.headers, id) }) };
  },
  imageUrl: nativeImageUrl,
  history: async (limit) => library.history(limit), recordHistory: library.recordHistory,
  removeHistory: library.removeHistory, clearHistory: library.clearHistory, clearLibrary: library.clearAll,
  favourites: async () => library.favourites(), toggleFavourite: library.toggleFavourite,
  checkFavourite: async (id, url) => ({ favourited: library.isFavourite(url ?? id) }),
  bookmarks: async () => library.bookmarks(), addBookmark: library.addBookmark, removeBookmark: library.removeBookmark, checkBookmark: async (body) => library.checkBookmark(body),
  updates: async () => library.updates(), refreshUpdates: library.refreshUpdates, markUpdatesSeen: library.markUpdatesSeen,
  categories: async () => library.categories(), categoryManga: async (id) => library.categoryManga(id),
  createCategory: library.createCategory, renameCategory: library.renameCategory, deleteCategory: library.deleteCategory,
  addToCategory: library.addToCategory, removeFromCategory: library.removeFromCategory, categoriesForManga: async (id, url) => library.categoriesForManga(url ?? id),
  mangaPrefs: async (id, url) => library.mangaPrefs(url ?? id), saveMangaPrefs: library.saveMangaPrefs, clearMangaPrefs: library.clearMangaPrefs,
  stats: async () => library.stats(), suggestions: () => discovery('content.suggestions'),
  globalSearch: (q, limit = 5) => discovery('content.globalSearch', { q, limit }),
  alternatives: (sid, url, title) => discovery('content.alternatives', { title: title ?? url ?? sid }),
  networkSettings: () => nativeServices.request('network.settings'),
  saveNetworkSettings: unavailable, exportBackup: unavailable, importBackup: unavailable,
  localScan: unavailable, localChapter: unavailable, localImageUrl: unavailable,
  downloads: unavailable, startDownload: unavailable, cancelDownload: unavailable, downloadSettings: unavailable, saveDownloadSettings: unavailable,
};
export default api;
