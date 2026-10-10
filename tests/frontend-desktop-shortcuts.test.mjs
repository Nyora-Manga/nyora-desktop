import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
const script = await import('../scripts/desktop-shortcuts-overlay.mjs').catch(() => ({}));
const source = await readFile(new URL('../vendor/web/web/screens/reader.js', import.meta.url), 'utf8');
test('reader keyboard overlay preserves page controls while ignoring app shortcuts, editing and modal focus', () => {
  assert.equal(typeof script.overlayDesktopShortcuts, 'function', 'standalone desktop keyboard overlay is available');
  const transformed = script.overlayDesktopShortcuts('screens/reader.js', source);
  parse(transformed, { ecmaVersion: 'latest', sourceType: 'module' });
  const start = transformed.indexOf('  function onKey(e) {');
  const end = transformed.indexOf("  document.addEventListener('keydown', onKey);", start);
  const calls = [];
  let modal = false;
  const handler = Function('$', 'mode', 'pageStep', 'toggleFit', 'auto', 'goReadingChapter', 'translate', 'bumpSpeed', 'jumpTo', 'st', 'backToDetails', transformed.slice(start, end) + '; return onKey;')(
    () => modal, 'PAGED', value => calls.push(['page', value]), () => calls.push(['fit']), { toggle: () => calls.push(['auto']) }, value => calls.push(['chapter', value]), false, () => {}, () => {}, { pages: [1] }, () => {});
  const event = overrides => ({ key: 'f', target: { tagName: 'BUTTON' }, preventDefault() { this.defaultPrevented = true; }, ...overrides });
  for (const value of [event({ ctrlKey: true }), event({ metaKey: true }), event({ altKey: true }), event({ isComposing: true }), event({ defaultPrevented: true }), event({ target: { tagName: 'INPUT' } }), event({ target: { tagName: 'SPAN', isContentEditable: true } }), event({ composedPath: () => [{ tagName: 'TEXTAREA' }, { tagName: 'CUSTOM-INPUT' }] })]) handler(value);
  modal = true; handler(event()); modal = false;
  assert.deepEqual(calls, [], 'editing/menu/modals must never invoke reader actions');
  handler(event()); handler(event({ key: 'ArrowRight' })); handler(event({ key: 'N' }));
  assert.deepEqual(calls, [['fit'], ['page', 1], ['chapter', 1]]);
  assert.equal(script.overlayDesktopShortcuts('screens/library.js', source), source);
  assert.throws(() => script.overlayDesktopShortcuts('screens/reader.js', 'reader changed'), /drift/i);
});
