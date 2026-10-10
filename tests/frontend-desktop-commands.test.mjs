import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../frontend/desktop-commands.js').catch(() => ({}));
function fixture(history = []) {
  assert.equal(typeof module.createDesktopCommands, 'function', 'trusted fixed commands must exist');
  const actions = [];
  const commands = module.createDesktopCommands({ router: { navigate: (...args) => actions.push(args) }, services: { snapshot: () => ({ history, favourites: [] }) }, files: { select: kind => { actions.push(['import', kind]); return { books: [{ id: 'confirmed' }] }; } }, navigation: { back: () => actions.push(['back']), forward: () => actions.push(['forward']) }, focusSearch: () => actions.push(['focus']), showShortcuts: () => actions.push(['help']) });
  return { commands, actions };
}
test('palette searches fixed useful commands without interpreting query text as a command or URL', async () => {
  const { commands, actions } = fixture();
  assert.deepEqual(module.searchCommands(commands, 'reading history').map(row => row.id), ['history']);
  assert.equal(module.searchCommands(commands, 'https://untrusted.example').length, 0);
  await module.runCommand(commands, 'bookmarks');
  assert.deepEqual(actions, [['bookmarks']]);
  await assert.rejects(module.runCommand(commands, 'clear-all'), /Unknown command/);
});
test('continue reading preserves the exact stored source/manga/chapter keys and is disabled without a usable history record', async () => {
  const { commands, actions } = fixture([{ sourceId: 'data:atsumoe', mangaUrl: '/manga/series', chapterId: 'series/chapter-1' }]);
  await module.runCommand(commands, 'continue-reading');
  assert.deepEqual(actions, [['reader', { sid: 'data:atsumoe', url: '/manga/series', chapterUrl: 'series/chapter-1' }]]);
  for (const history of [[], [{ sourceId: 'data:source', mangaUrl: '/manga', chapterId: 'unresolved-canonical-id' }], [{ sourceId: 'unbound', mangaUrl: '/manga', chapterUrl: '/chapter' }], [{ sourceId: 'data:source', mangaUrl: 'file:///etc/passwd', chapterUrl: '/chapter' }]]) {
    await assert.rejects(module.runCommand(fixture(history).commands, 'continue-reading'), /not available/);
  }
});
test('import commands delegate only existing native picker kinds and navigation/help have fixed callbacks', async () => {
  const { commands, actions } = fixture();
  for (const id of ['import-comics', 'import-folder', 'back', 'forward', 'focus-search', 'shortcuts']) await module.runCommand(commands, id);
  assert.deepEqual(actions, [['import', 'files'], ['local'], ['import', 'folder'], ['local'], ['back'], ['forward'], ['focus'], ['help']]);
});
test('cancelled native import preserves the current reader route', async () => {
  const commands = module.createDesktopCommands({ router: { navigate() { assert.fail('cancel must not leave current view'); } }, services: { snapshot: () => ({ history: [] }) }, files: { select: async () => ({ cancelled: true, books: [] }) } });
  await module.runCommand(commands, 'import-comics');
});
test('native navigation accepts fixed existing routes only and never interrupts an open dialog', () => {
  assert.equal(typeof module.navigateDesktopRoute, 'function');
  const calls = [], router = { navigate: route => calls.push(route) };
  let modal = true;
  const document = { querySelector: () => modal ? {} : null };
  module.navigateDesktopRoute(router, 'history', document);
  modal = false;
  module.navigateDesktopRoute(router, 'bookmarks', document);
  module.navigateDesktopRoute(router, 'file:///private', document);
  assert.deepEqual(calls, ['bookmarks']);
});
