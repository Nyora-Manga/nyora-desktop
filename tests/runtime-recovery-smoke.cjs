'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const profile = process.env.NYORA_RECOVERY_SMOKE_PROFILE, nonce = process.env.NYORA_RECOVERY_SMOKE_NONCE;
assert.ok(!app.isPackaged && path.isAbsolute(profile || '') && /^[a-f0-9]{32}$/.test(nonce || ''));
const resources = process.env.NYORA_RECOVERY_SMOKE_RESOURCES || null;
const root = resources ? path.join(resources, 'app.asar') : path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
assert.equal(version, process.env.NYORA_RECOVERY_SMOKE_VERSION);
const { WindowRecovery, HelperReadRecovery } = require(path.join(root, 'electron/recovery.cjs'));
const { ManagedHelper } = require(path.join(root, 'electron/helper.cjs'));
const { SourceRelay } = require(path.join(root, 'electron/relay.cjs'));
const { loadCatalogue } = require(path.join(root, 'electron/catalogue.cjs'));
const helperRoot = resources ? path.join(resources, 'helper') : path.join(root, 'resources/helper');
const manifest = JSON.parse(fs.readFileSync(path.join(helperRoot, 'manifest.json')));
assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
app.enableSandbox(); app.setPath('userData', profile); app.on('window-all-closed', () => {});
const checks = []; let window, controller, helper, readRecovery, relay, child, launches = 0, quitRequests = 0;
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'fixture=stable; Path=/; Max-Age=600' }); res.end('<!doctype html><title>Recovery fixture</title>'); });
async function wait(predicate) { const until = Date.now() + 10000; while (!predicate()) { if (Date.now() > until) throw new Error('Recovery fixture deadline'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function cleanup() { controller?.close(); readRecovery?.close(); await helper?.stop(); await relay?.stop(); if (window && !window.isDestroyed()) window.destroy(); await new Promise(resolve => server.close(resolve)); }
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const indexUrl = `http://127.0.0.1:${server.address().port}/index.html`;
  window = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition('persist:recovery-fixture'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let loaded = 0; window.webContents.on('did-finish-load', () => { loaded++; });
  controller = new WindowRecovery({ window, indexUrl, dialog: { showMessageBox: async () => ({ response: 1 }) }, quit: () => { quitRequests++; } });
  await window.loadURL(`${indexUrl}#/reader?chapterUrl=synthetic`);
  for (const count of [2, 3]) {
    window.webContents.forcefullyCrashRenderer(); await wait(() => loaded >= count);
    assert.match(window.webContents.getURL(), /#\/reader\?chapterUrl=synthetic$/);
    assert.equal(await window.webContents.executeJavaScript("document.cookie.includes('fixture=stable')"), true);
  }
  checks.push('Actual sandboxed renderer crashes reload the same trusted reader route and retain its session');
  window.webContents.forcefullyCrashRenderer(); await wait(() => quitRequests === 1); assert.equal(loaded, 3);
  checks.push('Third renderer crash requires a native decision instead of an automatic reload loop');
  const lookup = loadCatalogue(path.join(helperRoot, 'catalogue.json'), manifest.catalogueSha256);
  relay = new SourceRelay({ catalogueLookup: lookup, sessionForSource: async () => { throw new Error('Fixture forbids source network'); } });
  const privateRelay = await relay.start();
  helper = new ManagedHelper({ profileRoot: path.join(profile, 'library'), javaPath: path.join(helperRoot, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java'), jarPath: path.join(helperRoot, 'nyora-helper.jar'),
    relay: { url: `${privateRelay.baseUrl}/fetch`, token: privateRelay.token }, launcher: (...args) => { launches++; child = spawn(...args); return child; } });
  await helper.start(); await helper.request('/stats');
  readRecovery = new HelperReadRecovery({ helper: () => helper });
  child.kill('SIGKILL'); await wait(() => helper.status.state === 'unavailable');
  await assert.rejects(readRecovery.run(false, () => helper.request('/categories', { method: 'POST', json: { title: 'Never replay this write' } })));
  assert.equal(launches, 1);
  const read = await readRecovery.run(true, () => helper.request('/stats')); assert.equal(JSON.parse(read.bytes).favouritesCount, 0); assert.equal(launches, 2);
  checks.push('Actual bundled ARM helper crash restarts for a safe GET; failed writes are not replayed');
  await cleanup();
  const result = { passed: true, nonce, resources, appVersion: version, platform: process.platform, arch: process.arch, productionTransport: 'RuntimeRecovery', checks };
  const output = path.resolve(__dirname, '../test-results/runtime-recovery-smoke/result.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); app.exit(0);
}).catch(async error => { console.error(error); await cleanup().catch(() => {}); app.exit(1); });
