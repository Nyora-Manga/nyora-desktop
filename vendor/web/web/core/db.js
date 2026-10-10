// core/db.js — IndexedDB persistence mirroring the shared Nyora DB schema.
//
// WHY
// ---
// The mac/linux/windows ports persist to SQLDelight and the cross-platform sync
// layer targets Supabase (tables nyora_manga / nyora_favourite / nyora_history /
// nyora_bookmark / nyora_manga_prefs / nyora_category / nyora_manga_category /
// nyora_update). To make the web a first-class member of that sync mesh, this
// module stores the SAME row shapes (same column names, TEXT ids) in IndexedDB,
// plus a change_log for future push-to-Supabase.
//
// library.js keeps its fast synchronous localStorage cache as the in-session
// source of truth and calls mirrorAll() after each mutation; this module
// translates that into normalized schema rows. Everything here is async and
// best-effort: if IndexedDB is unavailable the app keeps working off localStorage.

const DB_NAME = 'nyora';
const DB_VERSION = 1;

export const STORES = {
  manga: 'manga',
  favourite: 'favourite',
  history: 'history',
  bookmark: 'bookmark',
  mangaPrefs: 'manga_prefs',
  category: 'category',
  mangaCategory: 'manga_category',
  update: 'update',
  changeLog: 'change_log',
};

let _dbPromise = null;
let _available = typeof indexedDB !== 'undefined';

function openDB() {
  if (!_available) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      _available = false;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // keyPath stores (row carries its own id/manga_id key)
      if (!db.objectStoreNames.contains(STORES.manga)) db.createObjectStore(STORES.manga, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.favourite)) db.createObjectStore(STORES.favourite, { keyPath: 'manga_id' });
      if (!db.objectStoreNames.contains(STORES.history)) db.createObjectStore(STORES.history, { keyPath: 'manga_id' });
      if (!db.objectStoreNames.contains(STORES.bookmark)) db.createObjectStore(STORES.bookmark, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.mangaPrefs)) db.createObjectStore(STORES.mangaPrefs, { keyPath: 'manga_id' });
      if (!db.objectStoreNames.contains(STORES.category)) db.createObjectStore(STORES.category, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.mangaCategory)) db.createObjectStore(STORES.mangaCategory, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.update)) db.createObjectStore(STORES.update, { keyPath: 'manga_id' });
      if (!db.objectStoreNames.contains(STORES.changeLog)) db.createObjectStore(STORES.changeLog, { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _available = false; resolve(null); };
  });
  return _dbPromise;
}

function tx(db, storeNames, mode) {
  const t = db.transaction(storeNames, mode);
  return t;
}

function reqDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- public async API (used by a future SupabaseSync) ------------------

export async function getAll(store) {
  const db = await openDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const r = tx(db, store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

export async function put(store, row) {
  const db = await openDB();
  if (!db) return;
  try {
    const t = tx(db, store, 'readwrite');
    t.objectStore(store).put(row);
    await txComplete(t);
  } catch { /* ignore */ }
}

function txComplete(t) {
  return new Promise((resolve) => {
    t.oncomplete = () => resolve();
    t.onabort = t.onerror = () => resolve();
  });
}

/** Pending change-log rows (for the next sync push); pass `true` to clear. */
export async function drainChangeLog(clear = false) {
  const rows = await getAll(STORES.changeLog);
  if (clear && rows.length) {
    const db = await openDB();
    if (db) {
      try {
        const t = tx(db, STORES.changeLog, 'readwrite');
        t.objectStore(STORES.changeLog).clear();
        await txComplete(t);
      } catch { /* ignore */ }
    }
  }
  return rows;
}

// ---- mirror: translate the library.js localStorage shape into schema rows --

const ISO = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : new Date(0).toISOString();
};

function mangaRow(m, forcedId) {
  if (!m) return null;
  // Use the caller's canonical library key when given, so the manga row's id
  // always matches the manga_id foreign key the child rows carry. For id-keyed
  // manga this equals String(m.id) either way; for url-keyed manga the library
  // key is `sourceId|url` (keyOf in library.js) — falling back to bare m.url
  // here would orphan every child row.
  const id = forcedId != null && forcedId !== ''
    ? String(forcedId)
    : (m.id != null && m.id !== '' ? String(m.id) : (m.url || ''));
  if (!id) return null;
  return {
    id,
    title: m.title || '',
    alt_titles: JSON.stringify(m.altTitles || []),
    url: m.url || '',
    public_url: m.publicUrl || m.url || '',
    rating: typeof m.rating === 'number' ? m.rating : -1,
    is_nsfw: m.isNsfw === true || m.contentRating === 'ADULT',
    content_rating: m.contentRating || null,
    cover_url: m.coverUrl || '',
    large_cover_url: m.largeCoverUrl || m.coverUrl || '',
    state: m.state || null,
    authors: JSON.stringify(m.authors || []),
    source_ref: typeof m.source === 'string' ? m.source : JSON.stringify(m.source || {}),
    description: m.description || '',
    tags: JSON.stringify(m.tags || []),
    updated_at: ISO(Date.now()),
  };
}

let _mirrorTimer = null;
let _pending = null;

/** Debounced full mirror of the library snapshot into the schema stores. */
export function mirrorAll(snapshot) {
  _pending = snapshot;
  if (!_available) return;
  if (_mirrorTimer) clearTimeout(_mirrorTimer);
  _mirrorTimer = setTimeout(() => { _mirrorTimer = null; void doMirror(_pending); }, 400);
}

async function doMirror(data) {
  const db = await openDB();
  if (!db || !data) return;
  try {
    const stores = [
      STORES.manga, STORES.favourite, STORES.history, STORES.bookmark,
      STORES.mangaPrefs, STORES.category, STORES.mangaCategory, STORES.update,
    ];
    const t = tx(db, stores, 'readwrite');
    const os = (n) => t.objectStore(n);
    for (const n of stores) os(n).clear();

    const mangaSeen = new Set();
    const putManga = (m, id) => {
      const row = mangaRow(m, id);
      if (row && !mangaSeen.has(row.id)) { mangaSeen.add(row.id); os(STORES.manga).put(row); }
      return row ? row.id : '';
    };

    // favourites
    for (const [mid, rec] of Object.entries(data.favourites || {})) {
      putManga(rec.manga, mid);
      os(STORES.favourite).put({ manga_id: String(mid), added_at: ISO(rec.addedAt), sort_key: 0, updated_at: ISO(rec.addedAt), deleted_at: null });
    }
    // history
    for (const [mid, h] of Object.entries(data.history || {})) {
      putManga(h.manga, mid);
      os(STORES.history).put({
        manga_id: String(mid), source_id: h.sourceId || '', chapter_id: String(h.chapterId || ''),
        chapter_title: h.chapterTitle || '', page: Number(h.page) || 0, scroll: 0,
        percent: Number(h.percent) || 0, chapters_count: Number(h.total) || 0,
        updated_at: ISO(h.updatedAt), deleted_at: null,
      });
    }
    // bookmarks
    for (const b of (data.bookmarks || [])) {
      putManga(b.manga, b.mangaId);
      const id = `${b.mangaId}:${b.chapterId}:${b.page}`;
      os(STORES.bookmark).put({
        id, manga_id: String(b.mangaId), chapter_id: String(b.chapterId || ''),
        chapter_title: b.chapterTitle || '', page: Number(b.page) || 0, note: b.note || '',
        created_at: ISO(b.createdAt), updated_at: ISO(b.createdAt), deleted_at: null,
      });
    }
    // categories + members
    for (const c of Object.values(data.categories || {})) {
      os(STORES.category).put({ id: String(c.id), title: c.title || '', sort_key: 0, created_at: ISO(c.createdAt), updated_at: ISO(c.createdAt), deleted_at: null });
    }
    for (const [cid, members] of Object.entries(data.categoryMembers || {})) {
      for (const mid of Object.keys(members || {})) {
        if (!members[mid]) continue;
        os(STORES.mangaCategory).put({ id: `${mid}|${cid}`, manga_id: String(mid), category_id: String(cid), updated_at: ISO(Date.now()), deleted_at: null });
      }
    }
    // per-manga prefs
    for (const [mid, p] of Object.entries(data.prefs || {})) {
      os(STORES.mangaPrefs).put({
        manga_id: String(mid), reader_mode: p.mode || p.reader_mode || '',
        brightness: Number(p.brightness) || 0, contrast: Number(p.contrast) || 1,
        saturation: Number(p.saturation) || 1, hue: Number(p.hue) || 0,
        palette: p.palette || '', updated_at: ISO(Date.now()),
      });
    }
    // update snapshots
    for (const [mid, s] of Object.entries(data.snapshots || {})) {
      os(STORES.update).put({
        manga_id: String(mid), source_id: s.sourceId || '',
        last_chapter_count: Number(s.chapterCount) || 0, new_chapters_count: Number(s.newChapters) || 0,
        latest_chapter_title: s.latestChapterTitle || '', last_synced_at: ISO(s.lastSyncedAt), updated_at: ISO(s.lastSyncedAt),
      });
    }
    await txComplete(t);
  } catch { /* best-effort */ }
}

export default { STORES, getAll, put, mirrorAll, drainChangeLog };
