// Exercises actual Electron/Chromium, native IPC and isolated cookie profiles.
// Debug transport is available only for an explicit unpackaged smoke invocation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CDP, delay, eventually } from './cdp.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const executable = require('electron');
const output = join(project, 'test-results/runtime-smoke');
const profile = await mkdtemp(join(tmpdir(), 'nyora-electron-smoke-'));
const fixture = await runtimeFixture(project);
const checks = [];
const allLogs = [];
let active;
await mkdir(output, { recursive: true });

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function launch() {
  const port = await freePort();
  const child = spawn(executable, [fixture.app, '--nyora-smoke'], {
    cwd: tmpdir(),
    env: { ...process.env, NYORA_SMOKE_PROFILE: profile, NYORA_SMOKE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, connections: [] };
  active = state;
  child.on('error', (error) => { state.error = error; });
  child.stdout.on('data', (data) => allLogs.push(String(data)));
  child.stderr.on('data', (data) => allLogs.push(String(data)));
  state.targets = async () => {
    if (state.error) throw state.error;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited: ${child.exitCode ?? child.signalCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return response.json();
  };
  state.page = async (matches) => {
    const target = await eventually(async () => (await state.targets()).find((item) => item.type === 'page' && matches(item)), { timeout: 45000, label: 'Electron page' });
    const client = await CDP.connect(target.webSocketDebuggerUrl);
    state.connections.push(client);
    client.targetId = target.id;
    return client;
  };
  state.main = await state.page((item) => /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(item.url));
  await eventually(() => state.main.evaluate('Boolean(globalThis.nyoraDesktop?.runtimeStatus) && document.readyState === "complete"'), { label: 'bundled frontend and IPC initialization' });
  state.localOrigin = await state.main.evaluate('location.origin');
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  state.browser = await CDP.connect((await response.json()).webSocketDebuggerUrl);
  state.connections.push(state.browser);
  return state;
}

async function stop(state) {
  if (!state) return;
  // Ask Chromium to quit so profiles flush before testing persistence.
  await state.browser?.send('Browser.close').catch(() => {});
  for (const connection of state.connections) connection.close();
  const child = state.child;
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, 'exit').catch(() => {}), delay(4000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
    await Promise.race([once(child, 'exit').catch(() => {}), delay(4000)]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  active = undefined;
}

function invoke(page, command, args = {}) {
  return page.evaluate(`globalThis.nyoraDesktop[${JSON.stringify({runtime_status: "runtimeStatus", open_verification: "openVerification", save_source_cookies: "saveSourceCookies", reset_source_session: "resetSourceSession"}[command])}](${JSON.stringify(args)})`);
}

const origin = 'https://example.org';
async function sourceWindow(state, sourceId, name) {
  const url = `${origin}/?nyora-smoke=${name}`;
  const opened = await invoke(state.main, 'open_verification', { sourceId, url });
  assert.equal(opened.status, 'opened');
  const page = await state.page((target) => target.url === url);
  // Serve deterministic synthetic HTML in Chromium's network stack; no source
  // account, Cloudflare automation, or third-party content is used by this test.
  page.on('Fetch.requestPaused', ({ requestId }) => {
    page.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from('<!doctype html><title>Nyora synthetic source</title><h1>Source session fixture</h1>').toString('base64'),
    }).catch(() => {});
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*` }] });
  await page.send('Page.navigate', { url });
  await eventually(() => page.evaluate('document.title === "Nyora synthetic source"'), { label: 'synthetic source page' });
  return page;
}

async function closePage(state, page) {
  await state.browser.send('Target.closeTarget', { targetId: page.targetId });
  page.close();
  await eventually(async () => !(await state.targets()).some((target) => target.id === page.targetId), { label: 'source window shutdown' });
}

try {
  const state = await launch();
  const status = await invoke(state.main, 'runtime_status');
  assert.equal(status.runtime, 'electron');
  assert.equal(status.localServer?.origin, state.localOrigin);
  assert.match(state.localOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(status.smokeMode, true, 'Smoke test requires an explicit isolated development invocation');
  assert.equal(status.dataMode, 'native-helper');
  assert.equal(status.appVersion, fixture.appVersion);
  assert.equal(status.rendererSandboxed, true);
  assert.equal(status.contextIsolated, true);
  const userAgent = await state.main.evaluate('navigator.userAgent');
  assert.match(userAgent, /Chrome\/\d+/);
  assert.ok(status.browserVersion, 'Native runtime must report its browser version');
  checks.push({ check: 'Bundled Chromium identity and local frontend IPC', status, userAgent });
  assert.equal(status.helper.state, 'unavailable', 'Missing-helper fixture must not load packaged resources');
  if (status.helper.state === 'unavailable') {
    await eventually(() => state.main.evaluate('document.querySelector("#view h1")?.textContent === "Native data unavailable"'), { label: 'visible native-helper startup failure' });
    await assert.rejects(state.main.evaluate('nyoraDesktop.serviceRequest({operation:"library.favourites",params:{}})'));
    checks.push({ check: 'Missing native helper fails visibly without browser persistence fallback', passed: true });
  } else {
    await eventually(() => state.main.evaluate('Boolean(document.querySelector("#sidebar [data-route=library]"))'), { label: 'shared frontend hydration' });
    checks.push({ check: 'Shared frontend hydrated through native service', passed: true });
  }
  assert.equal(await state.main.evaluate('Boolean(navigator.serviceWorker.controller)'), false);
  assert.equal(await state.main.evaluate('document.querySelectorAll("link[rel=manifest]").length'), 0);
  checks.push({ check: 'No PWA controller or manifest', passed: true });

  for (const args of [
    { sourceId: 'data:../escape', url: origin },
    { sourceId: 'data:smoke-one', url: 'http://example.org/' },
    { sourceId: 'data:smoke-one', url: 'https://127.0.0.1/' },
    { sourceId: 'data:smoke-one', url: 'https://unrelated.org/' },
    { sourceId: 'data:unknown', url: origin },
  ]) await assert.rejects(invoke(state.main, 'open_verification', args));
  checks.push({ check: 'Native command input rejection', passed: true });

  const first = await sourceWindow(state, 'data:smoke-one', 'one');
  await first.evaluate('document.cookie = "nyora_smoke=one; Max-Age=600; Path=/; Secure; SameSite=Lax"');
  assert.match(await first.evaluate('document.cookie'), /nyora_smoke=one/);
  const saved = await invoke(state.main, 'save_source_cookies', { sourceId: 'data:smoke-one' });
  assert.equal(saved.state, 'saved');
  assert.ok(saved.persistentCookies >= 1);
  assert.doesNotMatch(JSON.stringify(saved), /nyora_smoke|value|domain/);
  await assert.rejects(invoke(state.main, 'save_source_cookies', { sourceId: 'data:unknown' }));
  checks.push({ check: 'Native cookie save returns durable metadata without exposing cookie values', passed: true });
  await assert.rejects(invoke(state.main, 'reset_source_session', { sourceId: 'data:smoke-one' }));
  const remoteAccess = await first.evaluate(`(async () => {
    if (!globalThis.nyoraDesktop?.runtimeStatus) return 'bridge-absent';
    try { await globalThis.nyoraDesktop.runtimeStatus(); return 'ALLOWED'; }
    catch { return 'denied'; }
  })()`);
  assert.notEqual(remoteAccess, 'ALLOWED');
  await first.evaluate(`location.assign(${JSON.stringify(`${state.localOrigin}/index.html`)}); true`).catch(() => {});
  await delay(100);
  assert.equal(await first.evaluate('location.origin'), origin);
  checks.push({ check: 'Remote command and privileged navigation isolation', remoteAccess });
  const second = await sourceWindow(state, 'data:smoke-two', 'two');
  assert.doesNotMatch(await second.evaluate('document.cookie'), /nyora_smoke=/);
  await second.evaluate('document.cookie = "nyora_smoke=two; Max-Age=600; Path=/; Secure; SameSite=Lax"');
  assert.match(await first.evaluate('document.cookie'), /nyora_smoke=one/);
  checks.push({ check: 'Two source contexts do not share cookies for the same origin', passed: true });
  const capture = await state.main.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'shared-ui.png'), Buffer.from(capture.data, 'base64'));
  await closePage(state, first);
  await closePage(state, second);
  await stop(state);

  const restarted = await launch();
  const persisted = await sourceWindow(restarted, 'data:smoke-one', 'one');
  assert.match(await persisted.evaluate('document.cookie'), /nyora_smoke=one/);
  await closePage(restarted, persisted);
  await eventually(async () => (await invoke(restarted.main, 'reset_source_session', { sourceId: 'data:smoke-one' })).reset, { label: 'targeted source reset' });
  const cleared = await sourceWindow(restarted, 'data:smoke-one', 'one');
  assert.doesNotMatch(await cleared.evaluate('document.cookie'), /nyora_smoke=/);
  const retained = await sourceWindow(restarted, 'data:smoke-two', 'two');
  assert.match(await retained.evaluate('document.cookie'), /nyora_smoke=two/);
  checks.push({ check: 'Restart persistence and reset affecting only the selected source', passed: true });
  await stop(restarted);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, checks }, null, 2));
  console.log(`Passed ${checks.length} Electron runtime checks. Evidence: ${output}`);
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, platform: process.platform, arch: process.arch, checks, error: error.message }, null, 2));
  throw error;
} finally {
  await stop(active);
  await writeFile(join(output, 'app.log'), allLogs.join(''));
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  await fixture.cleanup();
}
