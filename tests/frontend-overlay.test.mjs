import {overlayNativeSettings} from '../scripts/native-service-overlay.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webRoot } from '../scripts/build-frontend.mjs';
import { overlayApp, overlaySettings, overlayWelcome, overlayHtml, replaceOnce } from '../scripts/frontend-overlay.mjs';
import { createDesktopAdapter } from '../frontend/adapter.js';
import { overlayNativeMisc } from '../scripts/native-service-overlay.mjs';

test('desktop adapter invokes the agreed contract and reports missing native runtime', async () => {
  const calls = [];
  const bridge = Object.fromEntries(['runtimeStatus', 'openVerification', 'resetSourceSession'].map((name) => [name, async (args) => { calls.push([name, args]); return { status: 'opened' }; }]));
  const adapter = createDesktopAdapter(bridge);
  await adapter.runtimeStatus();
  await adapter.openVerification('data:synthetic', 'https://example.org/');
  await adapter.resetSourceSession('data:synthetic');
  assert.deepEqual(calls, [['runtimeStatus', undefined], ['openVerification', { sourceId: 'data:synthetic', url: 'https://example.org/' }], ['resetSourceSession', { sourceId: 'data:synthetic' }]]);
  assert(Object.isFrozen(adapter));
  await assert.rejects(createDesktopAdapter(null).runtimeStatus(), /Native runtime unavailable/);
  assert.equal(createDesktopAdapter({ invoke() {} }).nativeAvailable, false);
});

test('overlay disables startup sync, install prompt and service worker without changing shared source', async () => {
  const path = resolve(webRoot, 'web/app.js');
  const before = await readFile(path, 'utf8');
  const app = overlayApp(before);
  for (const call of ['initAutoSync();', 'registerSW();', 'setupInstallPrompt();']) assert(!app.includes(`\n${call}`));
  assert.match(app, /const BASE_TITLE = 'Nyora'/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('overlay routes cloud account through native sync and strips browser backup/PWA paths', async () => {
  const settings = overlayNativeSettings(overlaySettings(await readFile(resolve(webRoot, 'web/screens/settings.js'), 'utf8')));
  for (const forbidden of ['library.exportData()', 'library.importData(', 'sync.signInAndFetch(', 'sync.registerAndMigrate(', 'navigator.serviceWorker']) assert(!settings.includes(forbidden), forbidden);
  assert.match(settings, /Merge and sync/); assert.match(settings, /sync.signIn\(email/);
  const welcome = overlayWelcome(await readFile(resolve(webRoot, 'web/screens/welcome.js'), 'utf8'));
  assert.match(welcome, /export function shouldShowWelcome\(\) \{ return false; \}/);
});

test('desktop HTML delegates boot to desktop entry and removes migration/PWA claims', async () => {
  const html = overlayHtml(await readFile(resolve(webRoot, 'web/index.html'), 'utf8'));
  assert.match(html, /src="\/desktop.js"/);
  for (const forbidden of ['src="/boot/migrate.js"', 'rel="manifest"', 'application/ld+json', 'src="/app.js', 'offline-capable PWA']) assert(!html.includes(forbidden), forbidden);
});

test('source drift fails loudly instead of silently enabling unsafe web paths', () => {
  assert.throws(() => replaceOnce('missing', 'expected', '', 'boot'), /Shared frontend drift/);
  assert.throws(() => replaceOnce('expected expected', 'expected', '', 'boot'), /Shared frontend drift/);
  assert.throws(() => overlaySettings('function buildBackupData() {}\nfunction buildSync() {}'), /Shared frontend drift/);
  assert.throws(() => overlayApp('initAutoSync();'), /Shared frontend drift/);
});

test('disabled sync cannot read a browser session or perform an upload', async () => {
  const sync = await import('../frontend/sync-disabled.js');
  assert.equal(sync.status().isAuthenticated, false);
  assert.equal(sync.SYNC_CONFIG.syncUrl, '');
  await assert.rejects(sync.signIn('synthetic@example.org', 'fake'), /disabled/);
  await assert.rejects(sync.syncNow(), /disabled/);
  await assert.rejects(sync.restoreFromCloud(), /disabled/);
});

test('two desktop reader retries replace _r while preserving issued media authority and headers', async () => {
  const path = resolve(webRoot, 'web/screens/reader.js');
  const original = await readFile(path, 'utf8');
  const overlaid = overlayNativeMisc('screens/reader.js', original);
  const start = overlaid.indexOf('  function bustPage(p) {');
  const end = overlaid.indexOf('  function brokenPage(p, i) {', start);
  assert(start >= 0 && end > start);
  let timestamp = 1000;
  const origin = 'http://127.0.0.1:31420';
  const bustPage = Function('URL', 'location', 'Date', `${overlaid.slice(start, end)}\nreturn bustPage;`)(URL, { origin }, { now: () => timestamp++ });
  const query = new URLSearchParams({ u: 'https://cdn.example.org/page.png?value=one two&key=exact', sourceId: 'data:ATSUMOE', cap: 'exact-signed-capability_-', _r: '999' });
  query.append('h', 'Referer:https://source.example.org/chapter?one=two');
  query.append('h', 'Referer:https://source.example.org/alternate');
  for (const originalUrl of [`${origin}/helper-image?${query}`, `/helper-image?${query}`]) {
    const page = { url: originalUrl, index: 2 };
    const first = bustPage(page), second = bustPage(first);
    const retry = new URL(second.url);
    assert.equal(retry.origin, origin); assert.equal(retry.pathname, '/helper-image');
    assert.equal(retry.searchParams.getAll('_r').length, 1);
    assert.notEqual(new URL(first.url).searchParams.get('_r'), retry.searchParams.get('_r'));
    for (const key of ['u', 'cap', 'sourceId', 'h']) assert.deepEqual(retry.searchParams.getAll(key), query.getAll(key), key);
    assert.equal(second.index, 2); assert.equal(page.url, originalUrl);
  }
  assert.equal(bustPage(null), null);
  assert.equal(await readFile(path, 'utf8'), original);
});
