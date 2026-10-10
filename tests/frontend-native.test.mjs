import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeServices } from '../frontend/native-services.js';
import { createNativeLibrary } from '../frontend/native-library.js';
import { nativeImageUrl, nativeMangaImages, nativeDiscoveryResponse } from '../frontend/native-api.js';
import { awaitNativeMutations } from '../scripts/native-mutation-overlay.mjs';
import { packageTarget, verifyHelperTarget } from '../scripts/package-target.mjs';
import { requireSourceId, sourceId } from '../frontend/native-source-identity.js';
import { createNativeBackup } from '../frontend/native-backup.js';

const mediaOrigin = 'http://127.0.0.1:1420';
const issuedMedia = (source, path = 'cover.png') => `${mediaOrigin}/helper-image?u=https%3A%2F%2Fexample.org%2F${path}&sourceId=${encodeURIComponent(source)}&cap=fixture-media-cap`;
globalThis.location = { origin: mediaOrigin };
const manga = { id: 'native:exact-id', title: 'Synthetic', url: 'https://example.org/manga', source: { name: 'data:synthetic' } };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-native-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'authoritative-fixture.json');
  await writeFile(file, JSON.stringify({ favourites: [], history: [], bookmarks: [], categories: [], prefs: { readerMode: 'webtoon' }, mangaPrefs: {}, pinned: false }));
  const controls = { failWrite: false, failRead: false, loseResponse: null, failReadAfterCommit: null, calls: [] };
  const afterCommit = (operation) => { if (controls.failReadAfterCommit === operation) { controls.failReadAfterCommit = null; controls.failRead = true; } if (controls.loseResponse === operation) { controls.loseResponse = null; throw new Error('fixture response lost after commit'); } };
  const bridge = { async serviceRequest({ operation, params }) {
    controls.calls.push({ operation, params });
    const state = JSON.parse(await readFile(file));
    if (operation === 'library.favouriteToggle') {
      if (controls.failWrite) throw new Error('fixture durable write rejected');
      state.favourites = state.favourites.length ? [] : [manga];
      await writeFile(file, JSON.stringify(state));
      afterCommit(operation);
      return { favourited: state.favourites.length > 0 };
    }
    if (operation === 'sources.pinToggle') { state.pinned = !state.pinned; await writeFile(file, JSON.stringify(state)); afterCommit(operation); return { ok: true }; }
    if (operation === 'library.historyRecord') { state.history = [{ ...params, mangaUrl: manga.url, mangaTitle: manga.title, mangaCoverUrl: '', updatedAt: 123 }]; await writeFile(file, JSON.stringify(state)); return { ok: true }; }
    if (operation === 'library.mangaPrefsSave') { state.mangaPrefs[params.mangaId] = { ...params, present: true }; await writeFile(file, JSON.stringify(state)); afterCommit(operation); return { ok: true }; }
    if (operation === 'ui.preferences.save') { if (controls.failWrite) throw new Error('fixture preferences write rejected'); state.prefs = { ...state.prefs, ...params.patch }; await writeFile(file, JSON.stringify(state)); afterCommit(operation); return state.prefs; }
    if (controls.failRead) throw new Error('fixture refresh unavailable');
    if (operation === 'library.mangaPrefs') return state.mangaPrefs[params.mangaId] || { present: false };
    if (operation === 'ui.preferences.get') return state.prefs;
    if (operation === 'library.categories') return { categories: state.categories };
    if (operation === 'library.stats') return { totalChapters: state.history.length, distinctManga: state.history.length, favouritesCount: state.favourites.length, topSources: [] };
    if (operation === 'sources.list') return { sources: [{ id: 'data:synthetic', isInstalled: true, isPinned: state.pinned }] };
    if (operation === 'sources.catalog') return { entries: [{ id: 'data:synthetic', isInstalled: true, name: 'Synthetic', isNsfw: false }] };
    return { entries: state[operation.split('.')[1]] || [] };
  } };
  return { bridge, controls, file };
}

test('library hydration and writes use native authority, survive adapter restart, and never access browser storage', async (t) => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('browser storage forbidden'); } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new Error('browser database forbidden'); } });
  t.after(() => { delete globalThis.localStorage; delete globalThis.indexedDB; });
  const { bridge, controls } = await fixture(t);
  const services = createNativeServices(bridge), library = createNativeLibrary(services);
  assert.throws(() => library.favourites(), /not been hydrated/);
  await services.hydrate();
  await library.toggleFavourite(manga);
  await library.recordHistory({ manga, sourceId: 'data:synthetic', sourceNsfw: false, chapterUrl: 'https://example.org/chapter', page: 1, total: 4 });
  assert.equal(library.history().entries[0].percent, .5);
  const restarted = createNativeServices(bridge); await restarted.hydrate();
  assert.equal(createNativeLibrary(restarted).favourites().entries[0].id, manga.id);
  assert.equal(createNativeLibrary(restarted).history().entries[0].manga.url, manga.url);
  assert(controls.calls.every((call) => !Object.hasOwn(call, 'path')));
  assert.equal(controls.calls.find((call) => call.operation === 'library.favouriteToggle').params.mangaId, manga.id);
});

test('rejected writes and acknowledged writes with failed refresh preserve the last confirmed cache', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate();
  controls.failWrite = true;
  await assert.rejects(services.setFavourite(manga.id, true), /write rejected/);
  assert.deepEqual(services.snapshot().favourites, []);
  controls.failWrite = false; controls.failRead = true;
  // An unknown write result forces a read first; an unavailable reload must
  // stop a subsequent write entirely.
  await assert.rejects(services.setFavourite(manga.id, true), /refresh unavailable/);
  assert.deepEqual(services.snapshot().favourites, []);
  assert.equal(controls.calls.filter((call) => call.operation === 'library.favouriteToggle').length, 1);
  controls.failRead = false;
  await services.setFavourite(manga.id, true);
  assert.equal(services.snapshot().favourites.length, 1);
  // The retry reloads the committed state; it must not toggle it back off.
  assert.equal(controls.calls.filter((call) => call.operation === 'library.favouriteToggle').length, 2);
});

test('lost favourite and pin responses reload committed state instead of reversing a toggle', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate();
  controls.loseResponse = 'library.favouriteToggle';
  await assert.rejects(services.setFavourite(manga.id, true), /response lost after commit/);
  assert.deepEqual(services.snapshot().favourites, []);
  await services.setFavourite(manga.id, true);
  assert.equal(services.snapshot().favourites[0].id, manga.id);
  assert.equal(controls.calls.filter((call) => call.operation === 'library.favouriteToggle').length, 1);
  controls.loseResponse = 'sources.pinToggle';
  await assert.rejects(services.setSourcePinned('data:synthetic', true), /response lost after commit/);
  assert.equal(services.snapshot().sources[0].isPinned, false);
  await services.setSourcePinned('data:synthetic', true);
  assert.equal(services.snapshot().sources[0].isPinned, true);
  assert.equal(controls.calls.filter((call) => call.operation === 'sources.pinToggle').length, 1);
});

test('an acknowledged commit with failed refresh stays unconfirmed until a native read succeeds', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate(); controls.failReadAfterCommit = 'library.favouriteToggle';
  await assert.rejects(services.setFavourite(manga.id, true), /refresh unavailable/);
  assert.deepEqual(services.snapshot().favourites, []);
  await assert.rejects(services.setFavourite(manga.id, true), /refresh unavailable/);
  assert.equal(controls.calls.filter((call) => call.operation === 'library.favouriteToggle').length, 1);
  controls.failRead = false; await services.setFavourite(manga.id, true);
  assert.equal(services.snapshot().favourites.length, 1);
  assert.equal(controls.calls.filter((call) => call.operation === 'library.favouriteToggle').length, 1);
});

test('ordinary write response loss refreshes before computing a subsequent partial per-title save', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge), library = createNativeLibrary(services);
  await services.hydrate(); await services.loadMangaPrefs(manga.id);
  controls.loseResponse = 'library.mangaPrefsSave';
  await assert.rejects(library.saveMangaPrefs({ mangaId: manga.id, contrast: 1.7 }), /response lost after commit/);
  assert.deepEqual(library.mangaPrefs(manga.id), {});
  const afterFailure = controls.calls.length;
  await library.saveMangaPrefs({ mangaId: manga.id, palette: 'warm' });
  assert.equal(library.mangaPrefs(manga.id).contrast, 1.7);
  assert.equal(library.mangaPrefs(manga.id).palette, 'warm');
  const subsequent = controls.calls.slice(afterFailure);
  assert(subsequent.findIndex((call) => call.operation === 'library.mangaPrefs') < subsequent.findIndex((call) => call.operation === 'library.mangaPrefsSave'));
});

test('history privacy checks use native preferences refreshed after an unknown device-preference commit', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge), library = createNativeLibrary(services);
  await services.hydrate(); controls.loseResponse = 'ui.preferences.save';
  await assert.rejects(services.saveUiPreferences({ incognito: true }), /response lost after commit/);
  assert.equal(services.uiPreferences().incognito, undefined);
  assert.deepEqual(await library.recordHistory({ manga, sourceId: 'data:synthetic', sourceNsfw: false, chapterUrl: 'https://example.org/chapter', page: 0, total: 4 }), { recorded: false });
  assert.equal(controls.calls.filter((call) => call.operation === 'library.historyRecord').length, 0);
});

test('bookmarks reopen from exact native DTO navigation without favourites/history and category covers retain source', async (t) => {
  const { bridge, file } = await fixture(t), services = createNativeServices(bridge), library = createNativeLibrary(services);
  const state = JSON.parse(await readFile(file));
  state.bookmarks = [{ id: 7, mangaId: 'opaque/native:id', mangaTitle: 'Duplicate title', mangaUrl: 'https://example.org/exact', mangaCoverUrl: issuedMedia('data:ATSUMOE'), sourceId: 'data:ATSUMOE', chapterId: 'opaque/chapter:id', chapterUrl: 'https://example.org/exact/chapter', page: 3 }];
  await writeFile(file, JSON.stringify(state)); await services.hydrate();
  const bookmark = library.bookmarks().entries[0];
  assert.equal(bookmark.manga.id, 'opaque/native:id'); assert.equal(bookmark.manga.url, 'https://example.org/exact');
  assert.equal(bookmark.sourceId, 'data:ATSUMOE'); assert.equal(bookmark.chapterUrl, 'https://example.org/exact/chapter');
  assert.equal(new URL(bookmark.manga.coverUrl).searchParams.get('sourceId'), 'data:ATSUMOE');
  const categories = createNativeLibrary({ snapshot: () => ({ categoryEntries: { 9: [{ ...manga, source: { name: 'data:DEMONICSCANS' }, coverUrl: issuedMedia('data:DEMONICSCANS', 'category.png') }] } }) });
  assert.equal(new URL(categories.categoryManga(9).entries[0].coverUrl).searchParams.get('sourceId'), 'data:DEMONICSCANS');
});

test('native source validation preserves exact uppercase catalogue identities', () => {
  for (const id of ['data:ATSUMOE', 'data:DEMONICSCANS', 'data:Mixed_Case.1-2']) assert.equal(requireSourceId(id), id);
  assert.equal(sourceId({ name: 'data:ATSUMOE' }), 'data:ATSUMOE');
  assert.throws(() => requireSourceId('data:source/escape'), /canonical/);
  assert.throws(() => requireSourceId('data:' + 'A'.repeat(201)), /canonical/);
});

test('global groups and nested alternatives preserve native DTO identity and image source context', () => {
  const raw = { id: 'opaque:exact', title: 'Synthetic', publicUrl: 'https://example.org/exact', coverUrl: issuedMedia('data:ATSUMOE', 'raw.png'), sourceId: 'data:ATSUMOE' };
  const groups = nativeDiscoveryResponse('content.globalSearch', { query: 'Synthetic', groups: [{ sourceId: 'data:ATSUMOE', sourceName: 'Synthetic', entries: [raw], error: null }] });
  assert.equal(groups.groups[0].entries[0].id, raw.id);
  assert.equal(new URL(groups.groups[0].entries[0].coverUrl).searchParams.get('sourceId'), raw.sourceId);
  const alternative = nativeDiscoveryResponse('content.alternatives', { entries: [{ sourceId: raw.sourceId, sourceName: 'Synthetic', manga: raw }] }).entries[0];
  assert.equal(alternative.manga.url, raw.publicUrl); assert.equal(alternative.manga.source.name, raw.sourceId);
  assert.equal(new URL(alternative.manga.coverUrl).searchParams.get('sourceId'), raw.sourceId);
});

test('backup bridge uses no renderer paths/bytes and import always reloads native committed state', async (t) => {
  const { bridge, file } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate();
  const calls = [];
  const backup = createNativeBackup({ backupExport: async (...args) => { calls.push(['export', args]); return { status: 'saved', receiptId: 'opaque-receipt' }; }, backupImport: async (...args) => { calls.push(['import', args]); const state = JSON.parse(await readFile(file)); state.favourites = [manga]; await writeFile(file, JSON.stringify(state)); return { status: 'completed', summary: { favourites: 1 } }; } }, services);
  assert.equal((await backup.export()).status, 'saved');
  assert.equal((await backup.import()).status, 'completed');
  assert.equal(services.snapshot().favourites[0].id, manga.id);
  assert.deepEqual(calls, [['export', []], ['import', ['merge']]]);
  assert.equal(services.cacheStatus().writeAvailable, true);
});

test('unknown backup commit and failed reload block editing until an explicit native hydrate succeeds', async (t) => {
  const { bridge, controls, file } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate();
  let releaseImport;
  const waiting = new Promise((resolve) => { releaseImport = resolve; });
  const backup = createNativeBackup({ backupExport: async () => ({ status: 'cancelled' }), backupImport: async () => {
    await waiting;
    const state = JSON.parse(await readFile(file)); state.favourites = [manga]; await writeFile(file, JSON.stringify(state));
    controls.failRead = true; throw new Error('backup result lost after commit');
  } }, services);
  const imported = backup.import(); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(services.cacheStatus().writeAvailable, false);
  releaseImport(); await assert.rejects(imported, /Editing remains disabled/);
  assert.deepEqual(services.snapshot().favourites, []);
  const callCount = controls.calls.length;
  await assert.rejects(services.setFavourite(manga.id, false), /backup state has not been reloaded/);
  await assert.rejects(services.mutate('library.historyClear'), /backup state has not been reloaded/);
  assert.equal(controls.calls.length, callCount);
  controls.failRead = false; await backup.reload();
  assert.equal(services.snapshot().favourites[0].id, manga.id);
  assert.equal(services.cacheStatus().writeAvailable, true);
});

test('backup cancellation and errors still refresh without reporting a completed restore', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge);
  await services.hydrate();
  const backup = createNativeBackup({ backupExport: async () => ({ status: 'cancelled' }), backupImport: async () => ({ status: 'cancelled' }) }, services);
  const before = controls.calls.length;
  assert.equal((await backup.import()).status, 'cancelled');
  assert(controls.calls.length > before);
  const failed = createNativeBackup({ backupExport: async () => ({ status: 'cancelled' }), backupImport: async () => { throw new Error('native validation rejected'); } }, services);
  await assert.rejects(failed.import(), /native validation rejected/);
  assert.equal(services.cacheStatus().writeAvailable, true);
  await assert.rejects(createNativeBackup(null, services).export(), /unavailable/);
});

test('device preference failures keep confirmed preferences and per-title partial saves preserve native fields', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge), library = createNativeLibrary(services);
  await services.hydrate();
  await services.loadMangaPrefs(manga.id);
  await library.saveMangaPrefs({ mangaId: manga.id, contrast: 1.7 });
  await library.saveMangaPrefs({ mangaId: manga.id, palette: 'warm' });
  assert.equal(library.mangaPrefs(manga.id).contrast, 1.7);
  assert.equal(library.mangaPrefs(manga.id).palette, 'warm');
  await services.saveUiPreferences({ readerMode: 'paged' });
  controls.failWrite = true;
  await assert.rejects(services.saveUiPreferences({ readerMode: 'webtoon' }), /write rejected/);
  assert.equal(services.uiPreferences().readerMode, 'paged');
});

test('unknown operations, raw paths, and unsupported parameters are rejected before preload access', async (t) => {
  const { bridge, controls } = await fixture(t), services = createNativeServices(bridge);
  await assert.rejects(services.request('/library/favourites'), /Unsupported native/);
  await assert.rejects(services.request('library.favourites', { url: 'https://example.org' }), /Unsupported parameters/);
  assert.deepEqual(controls.calls, []);
  await assert.rejects(createNativeServices(null).hydrate(), /helper is unavailable/);
});

test('main-issued HTTP media retains exact cap, source, Referer and reader cache-buster', () => {
  const issued = issuedMedia('data:ATSUMOE') + '&h=Referer%3Ahttps%3A%2F%2Fexample.org%2F&_r=123456789';
  assert.equal(nativeImageUrl(issued, { Cookie: 'ignored' }, 'data:ATSUMOE'), issued);
  const decorated = nativeMangaImages({ ...manga, coverUrl: issued }, 'data:ATSUMOE');
  assert.equal(decorated.coverUrl, issued); assert.equal(decorated.id, manga.id); assert.equal(decorated.url, manga.url);
  assert.throws(() => nativeImageUrl('nyora://app/helper-image?u=https://example.org/a&sourceId=data:ATSUMOE'), /current app media route/);
  assert.throws(() => nativeImageUrl('http://127.0.0.1:8788/image?u=https://example.org/a&sourceId=data:ATSUMOE'), /Legacy helper/);
  assert.throws(() => nativeImageUrl(issued.replace('1420', '9999')), /current app media route/);
  assert.throws(() => nativeImageUrl(issued.replace('&cap=fixture-media-cap', '')), /current app media route/);
  assert.throws(() => nativeImageUrl('https://example.org/source.png', undefined, 'data:ATSUMOE'), /issued by the native app/);
  assert.equal(nativeImageUrl('https://s4.anilist.co/public.png'), 'https://s4.anilist.co/public.png');
});

test('checked mutation overlay awaits persistence before success UI and exposes rejection', async () => {
  const transformed = awaitNativeMutations('export function action(){const result=library.toggleFavourite(manga); success(result.favourited);}', 'fixture');
  assert.equal(transformed.count, 1);
  let resolveWrite, rejectWrite, success = [];
  const pending = new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
  const body = transformed.source.replace(/^import .*\n/, '').replace('export ', '');
  const action = Function('library', 'manga', 'success', 'desktopMutation', `${body};return action;`)({ toggleFavourite: () => pending }, manga, (value) => success.push(value), (operation) => operation());
  const task = action(); assert.deepEqual(success, []); resolveWrite({ favourited: true }); await task; assert.deepEqual(success, [true]);
  const rejected = awaitNativeMutations('export const action=()=>{store.set({readerMode:"paged"}); success();};', 'fixture').source.replace(/^import .*\n/, '').replace('export ', '');
  const failure = Function('store', 'success', 'desktopMutation', `${rejected};return action;`)({ set: async () => { throw new Error('durable rejection'); } }, () => success.push(false), (operation) => operation());
  await assert.rejects(failure(), /durable rejection/); assert.deepEqual(success, [true]);
  assert.throws(() => awaitNativeMutations('library.clearAll();', 'drift'), /outside an awaited UI function/);
});

test('packaging refuses multi-architecture or mismatched staged helper/JRE', () => {
  assert.throws(() => packageTarget(['--arm64', '--x64']), /one platform and architecture/);
  const target = packageTarget(['--mac', '--arm64'], { platform: 'linux', arch: 'x64' });
  assert.deepEqual(target, { platform: 'darwin', arch: 'arm64' });
  const manifest = { schema: 1, protocol: 'nyora-desktop-helper/1', platform: 'darwin', arch: 'arm64' };
  verifyHelperTarget(manifest, target);
  assert.throws(() => verifyHelperTarget({ ...manifest, arch: 'x64' }, target), /native helper\/JRE/);
});
