import { nativeServices } from './native-services.js';
import { nativeMangaImages } from './native-images.js';
export function createNativeLibrary(services) {
  const state = () => services.snapshot();
  const mangaId = (value) => {
    const id = typeof value === 'object' ? value?.id : value;
    if (id == null || String(id) === '') throw new Error('This manga has no canonical native identity.');
    return String(id);
  };
  const knownManga = () => {
    const map = new Map(state().favourites.map((manga) => [String(manga.id), manga]));
    for (const row of state().history) if (!map.has(String(row.mangaId))) map.set(String(row.mangaId), { id: row.mangaId, url: row.mangaUrl, title: row.mangaTitle, coverUrl: row.mangaCoverUrl, source: row.sourceId ? { name: row.sourceId } : null });
    return map;
  };
  const rows = (collection) => ({ entries: collection });
  const unavailable = () => { throw new Error('This operation has no native desktop adapter yet.'); };
  const coordinates = (body) => ({ mangaId: mangaId(body.manga || body.mangaId), chapterId: String(body.chapterId ?? body.chapterUrl ?? ''), page: Number(body.page) || 0 });
  const chapterUrl = (row) => row.chapterUrl || (/^https:\/\//.test(row.chapterId || '') ? row.chapterId : '');
  return Object.freeze({
    favourites: () => rows(state().favourites.map((manga) => nativeMangaImages(manga))),
    isFavourite: (id) => state().favourites.some((manga) => String(manga.id) === mangaId(id)),
    toggleFavourite: (manga) => services.setFavourite(mangaId(manga), !state().favourites.some((entry) => String(entry.id) === mangaId(manga))),
    removeFavourite: (id) => services.setFavourite(mangaId(id), false),
    history(limit) {
      const map = knownManga();
      const list = state().history.map((row) => ({ ...row, manga: nativeMangaImages(map.get(String(row.mangaId)), row.sourceId), chapterUrl: chapterUrl(row) }));
      return rows(limit > 0 ? list.slice(0, limit) : list);
    },
    recordHistory(body) {
      return services.mutate('library.historyRecord', { ...coordinates(body), sourceId: body.sourceId || '', chapterTitle: body.chapterTitle || '', percent: body.percent ?? (body.total > 0 ? (body.page + 1) / body.total : 0) }, { when: () => {
        const prefs = state().uiPreferences;
        return !(prefs.incognito || (prefs.noNsfwHistory && (body.sourceNsfw !== false || body.manga?.isNsfw === true)));
      }, skippedResult: { recorded: false } });
    },
    removeHistory: (body) => services.mutate('library.historyRemove', { mangaId: mangaId(body.mangaId) }),
    clearHistory: () => services.mutate('library.historyClear'),
    clearAll: () => services.mutate('library.clear'),
    bookmarks() {
      const map = knownManga();
      return rows(state().bookmarks.map((row) => {
        const known = map.get(String(row.mangaId));
        const sourceId = row.sourceId || known?.source?.name || known?.source?.id || '';
        const manga = { ...(known || {}), id: row.mangaId, title: row.mangaTitle || known?.title || '', coverUrl: row.mangaCoverUrl || known?.coverUrl || '', url: row.mangaUrl || known?.url || '', source: sourceId ? { name: sourceId } : null };
        return { ...row, manga: nativeMangaImages(manga, sourceId), chapterUrl: chapterUrl(row), sourceId };
      }));
    },
    addBookmark: (body) => services.mutate('library.bookmarkAdd', { ...coordinates(body), chapterTitle: body.chapterTitle || '', note: body.note || '' }),
    removeBookmark: (body) => services.mutate('library.bookmarkRemove', body.id != null ? { id: body.id } : coordinates(body)),
    checkBookmark(body) {
      const at = coordinates(body);
      const hit = state().bookmarks.find((row) => String(row.mangaId) === at.mangaId && row.chapterId === at.chapterId && row.page === at.page);
      return { bookmarked: !!hit, id: hit?.id ?? null };
    },
    categories: () => ({ categories: state().categories }),
    categoryManga: (id) => rows((state().categoryEntries[String(id)] || []).map((manga) => nativeMangaImages(manga))),
    categoriesForManga: (id) => ({ categories: state().categories.filter((category) => (state().categoryEntries[String(category.id)] || []).some((manga) => String(manga.id) === mangaId(id))) }),
    createCategory: (title) => services.mutate('library.categoryCreate', { title }),
    renameCategory: (id, title) => services.mutate('library.categoryRename', { id, title }),
    deleteCategory: (id) => services.mutate('library.categoryDelete', { id }),
    addToCategory: (body) => services.mutate('library.categoryAdd', { mangaId: mangaId(body.mangaId), categoryId: body.categoryId }),
    removeFromCategory: (body) => services.mutate('library.categoryRemove', { mangaId: mangaId(body.mangaId), categoryId: body.categoryId }),
    mangaPrefs: (id) => state().mangaPrefs[mangaId(id)]?.present ? state().mangaPrefs[mangaId(id)] : {},
    readMarks: (id) => state().readMarks?.[mangaId(id)] || {read:[],unread:[]},
    saveReadMarks: (body) => services.mutate('library.readMarksSave', {...body,mangaId:mangaId(body.mangaId)}),
    saveMangaPrefs(body) {
      return services.mutate('library.mangaPrefsSave', () => {
        const prior = state().mangaPrefs[mangaId(body.mangaId)] || {};
        const defaults={brightness:0,contrast:1,saturation:1,hue:0};
        const params = Object.fromEntries(['readerMode', 'brightness', 'contrast', 'saturation', 'hue', 'palette'].map((key) => [key, body[key] ?? prior[key] ?? defaults[key] ?? '']));
        for(const key of ['readerFit','prefetch','webtoonWidth','autoScrollLevel','translateTo','translateFrom','invert']) if(body[key] !== undefined || prior[key] !== undefined) params[key] = body[key] ?? prior[key];
        return { mangaId: mangaId(body.mangaId), ...params };
      });
    },
    clearMangaPrefs: (body) => services.mutate('library.mangaPrefsClear', { mangaId: mangaId(body.mangaId) }),
    updates() { const map = knownManga(); return rows(state().updates.map((row) => ({ ...row, manga: nativeMangaImages(map.get(String(row.mangaId)), row.sourceId), newChapterList: [] }))); },
    refreshUpdates: () => services.mutate('library.updatesRefresh'),
    markUpdatesSeen: (body) => services.mutate('library.updatesSeen', body?.mangaId ? { mangaId: mangaId(body.mangaId) } : {}),
    stats() { const stats = state().stats; return { ...stats, totalManga: stats.distinctManga, totalFavourites: stats.favouritesCount, bySource: stats.topSources }; },
    onChange: (listener) => services.subscribe(listener),
    exportData: unavailable, importData: unavailable, persistSourceMigration: unavailable,
    setFavouriteCover: unavailable, patchHistoryManga: unavailable, dedupeCategories: unavailable,
    brokenHistoryEntries: () => [],
  });
}
export const library = createNativeLibrary(nativeServices);
export default library;
