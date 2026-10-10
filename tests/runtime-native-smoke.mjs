// Real ARM Electron + bundled native helper. No mock bridge, hosted API, real
// source requests, user profile, helper credentials or privileged seed endpoint.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CDP, delay, eventually } from './cdp.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

assert.equal(process.arch, 'arm64', 'Native runtime acceptance requires an ARM runner');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const executable = require('electron');
const fixture = await runtimeFixture(project, { bundledHelper: true });
const profile = await mkdtemp(join(tmpdir(), 'nyora-native-runtime-smoke-'));
const output = join(project, 'test-results/runtime-native-smoke');
const checks = [];
const logs = [];
let active;
await mkdir(output, { recursive: true });

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function launch() {
  const port = await freePort();
  const child = spawn(executable, [fixture.app, '--nyora-smoke', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], {
    cwd: tmpdir(), env: { ...process.env, NYORA_SMOKE_PROFILE: profile, NYORA_SMOKE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, connections: [] }; active = state;
  child.on('error', error => { state.error = error; });
  child.stdout.on('data', data => logs.push(String(data)));
  child.stderr.on('data', data => logs.push(String(data)));
  const target = await eventually(async () => {
    if (state.error) throw state.error;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited: ${child.exitCode ?? child.signalCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(item.url));
  }, { timeout: 45000, label: 'real native desktop window' });
  state.main = await CDP.connect(target.webSocketDebuggerUrl); state.connections.push(state.main);
  await state.main.send('Network.enable');
  await state.main.send('Network.setBlockedURLs', { urls: ['https://*'] });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  state.browser = await CDP.connect((await version.json()).webSocketDebuggerUrl); state.connections.push(state.browser);
  await eventually(() => state.main.evaluate('Boolean(globalThis.nyoraDesktop?.serviceRequest) && document.readyState === "complete"'), { label: 'native preload bridge' });
  const status = await eventually(async () => {
    const current = await state.main.evaluate('nyoraDesktop.runtimeStatus()');
    if (current.helper?.state === 'unavailable') throw new Error(`Bundled helper unavailable: ${current.helper.code}`);
    return current.helper?.state === 'ready' ? current : undefined;
  }, { timeout: 35000, label: 'bundled ARM helper authentication/readiness' });
  assert.equal(status.localServer?.origin, await state.main.evaluate('location.origin'));
  assert.match(status.localServer.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(status.helper.sourceTransport, 'chromium');
  assert.equal(status.helper.protocol, 'nyora-desktop-helper/1');
  assert.equal(status.appVersion, fixture.appVersion);
  assert.equal(status.rendererSandboxed, true); assert.equal(status.contextIsolated, true); assert.equal(status.smokeMode, true);
  await eventually(() => state.main.evaluate('globalThis.NYORA_SERVICES?.library.cacheStatus().hydrated && Boolean(document.querySelector("#sidebar [data-route=library]"))'), { label: 'shared frontend hydrated from native helper' });
  assert.notEqual(await state.main.evaluate('document.querySelector("#view h1")?.textContent'), 'Native data unavailable');
  assert.equal(await state.main.evaluate('Boolean(document.querySelector("#sidebar [data-route=library]"))'), true);
  await state.main.evaluate('document.querySelector("#sidebar [data-route=library]").click()');
  state.status = status;
  return state;
}
async function stop(state) {
  if (!state) return;
  await state.browser?.send('Browser.close').catch(() => {});
  for (const connection of state.connections) connection.close();
  if (state.child.exitCode === null && state.child.signalCode === null) await Promise.race([once(state.child, 'exit').catch(() => {}), delay(7000)]);
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill('SIGTERM'); await Promise.race([once(state.child, 'exit').catch(() => {}), delay(4000)]);
  }
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill('SIGKILL'); throw new Error('Native app failed graceful shutdown');
  }
  // A private readiness file is removed by ManagedHelper.stop. Leaving one
  // behind would make a restart/fixture database write unsafe.
  if (state.status) assert.deepEqual(await readdir(join(profile, 'library/runtime')), []);
  active = undefined;
}
const service = (state, operation, params = {}) => state.main.evaluate(`nyoraDesktop.serviceRequest(${JSON.stringify({ operation, params })})`);
const sourceId = 'data:mangadex';
const mangaUrl = 'https://mangadex.org/title/00000000-0000-0000-0000-000000000001';
let hash = 1125899906842597n;
for (const char of `MANGADEX${mangaUrl}`) hash = BigInt.asIntN(64, 31n * hash + BigInt(char.charCodeAt(0)));
const mangaId = hash.toString();
const title = 'Nyora native persistence fixture';
const chapterId = 'native-fixture-chapter';
let categoryId;

async function seedSyntheticManga() {
  const database = join(profile, 'library/nyora.db');
  const script = `import sqlite3,json,sys\nconn=sqlite3.connect(sys.argv[1])\nfixture=json.loads(sys.argv[2])\nconn.execute('INSERT INTO manga (id,title,url,public_url,source_ref,chapters) VALUES (?,?,?,?,?,?)', (fixture['id'],fixture['title'],fixture['url'],fixture['url'],json.dumps({'name':fixture['sourceId']}),json.dumps([{'id':fixture['chapterId'],'title':'Synthetic chapter','url':'https://mangadex.org/chapter/00000000-0000-0000-0000-000000000002'}])))\nconn.commit()\nassert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'\nconn.close()\n`;
  const seeded = spawnSync('python3', ['-c', script, database, JSON.stringify({ id: mangaId, title, url: mangaUrl, sourceId, chapterId })], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr || 'Fixture seed failed');
}
async function assertLibrary(state) {
  const favourites = await service(state, 'library.favourites');
  assert.equal(favourites.entries.find(item => String(item.id) === mangaId)?.title, title);
  const categories = await service(state, 'library.categories');
  assert.equal(categories.categories.find(item => item.id === categoryId)?.title, 'Native smoke category');
  const members = await service(state, 'library.categoryManga', { categoryId });
  assert.ok(members.entries.some(item => String(item.id) === mangaId));
  const history = await service(state, 'library.history', { limit: 100 });
  const entry = history.entries.find(item => String(item.mangaId) === mangaId);
  assert.equal(entry?.chapterId, chapterId); assert.equal(entry?.page, 3); assert.equal(entry?.percent, 0.375); assert.equal(entry?.sourceId, sourceId);
  const bookmarks = await service(state, 'library.bookmarks');
  const bookmark = bookmarks.entries.find(item => String(item.mangaId) === mangaId);
  assert.equal(bookmark?.chapterId, chapterId); assert.equal(bookmark?.page, 3); assert.equal(bookmark?.note, 'Native smoke bookmark');
  await state.main.evaluate('NYORA_SERVICES.library.hydrate()');
  assert.equal(await state.main.evaluate(`NYORA_SERVICES.library.snapshot().favourites.find(item=>String(item.id)===${JSON.stringify(mangaId)})?.title`), title);
  // Reload the real shared application so the visible library is bootstrapped
  // from durable native state, not only the direct service response above.
  await state.main.send('Page.reload');
  await eventually(() => state.main.evaluate(`document.querySelector("#view")?.textContent?.includes(${JSON.stringify(title)}) && (!document.querySelector("#splash") || getComputedStyle(document.querySelector("#splash")).opacity === "0")`), { label: 'synthetic favourite visible in hydrated shared library with boot overlay dismissed' });
}

try {
  const initialized = await launch();
  checks.push({ check: 'Bundled ARM Java helper authenticated with Chromium source relay; actual shared UI hydrated', status: initialized.status });
  await initialized.main.send('Page.bringToFront');
  await eventually(() => initialized.main.evaluate('document.visibilityState === "visible"'), { label: 'visible main reader window for screen wake lock' });
  const wakeLock = await initialized.main.evaluate(`(async () => {
    if (!navigator.wakeLock) throw new Error('Screen Wake Lock API is missing');
    const sentinel = await navigator.wakeLock.request('screen');
    try { return { type: sentinel.type, acquired: !sentinel.released }; }
    finally { await sentinel.release(); globalThis.__nyoraSmokeWakeLockReleased = sentinel.released; }
  })()`);
  assert.deepEqual(wakeLock, { type: 'screen', acquired: true });
  assert.equal(await initialized.main.evaluate('globalThis.__nyoraSmokeWakeLockReleased'), true);
  await initialized.main.evaluate('delete globalThis.__nyoraSmokeWakeLockReleased');
  checks.push({ check: 'Visible trusted main window acquires and releases a native screen wake lock', passed: true });
  const descriptors = JSON.parse(await readFile(join(project, 'resources/helper/catalogue.json'), 'utf8'));
  const trustedIds = new Set(descriptors.sources.map(item => item.sourceId));
  const catalogue = await service(initialized, 'sources.catalog');
  assert.ok(catalogue.entries.length > 100 && catalogue.entries.length <= trustedIds.size, `Actual bundled catalogue must be hydrated: ${catalogue.entries.length} entries`);
  for (const entry of catalogue.entries) assert.ok(trustedIds.has(entry.id), `Actual helper source ${entry.id} lacks a canonical native descriptor`);
  checks.push({ check: 'Actual native source catalogue IDs match packaged relay authority', sourceCount: catalogue.entries.length });
  assert.equal(await initialized.main.evaluate('Boolean(navigator.serviceWorker.controller)'), false);
  await assert.rejects(service(initialized, 'arbitrary.fetch', { url: 'https://example.org/' }));
  const portDirectory = join(profile, 'library/runtime');
  const launchDirectory = (await readdir(portDirectory))[0];
  const port = Number((await readFile(join(portDirectory, launchDirectory, 'helper.port'), 'utf8')).trim());
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(unauthenticated.status, 401, 'Native helper listener must require its private launch bearer');
  checks.push({ check: 'Fixed renderer service boundary and authenticated private helper listener', passed: true });
  await eventually(() => initialized.main.evaluate('document.documentElement.dataset.communityLinks === "shown"'), { label: 'dismissible community links ready' });
  assert.equal(await initialized.main.evaluate('document.querySelectorAll("#sidebar .nav-item-community").length'), 0);
  await initialized.main.evaluate('document.getElementById("desktop-dismiss-community").click()');
  await eventually(() => initialized.main.evaluate('document.documentElement.dataset.communityLinks === "hidden"'), { label: 'community links dismissal acknowledged by native storage' });
  assert.equal((await service(initialized, 'ui.preferences.get')).hideCommunityLinks, true);
  await stop(initialized);
  await seedSyntheticManga();

  const writable = await launch();
  assert.equal((await service(writable, 'library.favouriteToggle', { mangaId })).favourited, true);
  categoryId = (await service(writable, 'library.categoryCreate', { title: 'Native smoke category' })).id;
  assert.ok(Number.isSafeInteger(categoryId));
  await service(writable, 'library.categoryAdd', { mangaId, categoryId });
  await service(writable, 'library.historyRecord', { mangaId, sourceId, chapterId, chapterTitle: 'Synthetic chapter', page: 3, percent: 0.375 });
  await service(writable, 'library.bookmarkAdd', { mangaId, chapterId, chapterTitle: 'Synthetic chapter', page: 3, note: 'Native smoke bookmark' });
  await assertLibrary(writable);
  checks.push({ check: 'Named native service favourite/category/history/bookmark writes and actual shared UI reload', passed: true });
  const screenshot = await writable.main.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'native-library.png'), Buffer.from(screenshot.data, 'base64'));
  await stop(writable);

  const restarted = await launch();
  await assertLibrary(restarted);
  await eventually(() => restarted.main.evaluate('document.documentElement.dataset.communityLinks === "hidden"'), { label: 'community dismissal retained across full app restart' });
  assert.equal(await restarted.main.evaluate('getComputedStyle(document.querySelector(".desktop-community-links")).display'), 'none');
  checks.push({ check: 'Community promotion dismissal through the actual UI stays hidden across full application restart', passed: true });
  checks.push({ check: 'Native SQLite library state survives full Electron/helper restart', passed: true });
  await stop(restarted);
  const manifest = JSON.parse(await readFile(join(project, 'resources/helper/manifest.json'), 'utf8'));
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, platform: process.platform, arch: process.arch,
    fixture: 'Dedicated temporary SQLite manga metadata; all library mutations via actual restricted native IPC',
    externalSourceNetwork: 'Blocked in Chromium; no content operations issued', helper: { jarSha256: manifest.jarSha256, javaIdentity: manifest.javaIdentity }, checks }, null, 2));
  console.log(`Passed ${checks.length} bundled native helper runtime checks. Evidence: ${output}`);
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, platform: process.platform, arch: process.arch, checks, error: error.message }, null, 2));
  throw error;
} finally {
  try { await stop(active); }
  finally {
    await writeFile(join(output, 'app.log'), logs.join(''));
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    await fixture.cleanup();
  }
}
