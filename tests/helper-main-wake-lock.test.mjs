import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const mainFile = resolve(dirname(fileURLToPath(import.meta.url)), '../electron/main.cjs'), mainRequire = createRequire(mainFile);
test('actual main grants only screen wake lock to the current trusted local main frame', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-wake-lock-main-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const app = new EventEmitter(), paths = { appData: directory };
  Object.assign(app, { commandLine: { hasSwitch: () => false }, isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {}, getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}) });
  const origin = 'http://127.0.0.1:43210', frame = { url: `${origin}/index.html#/reader` };
  const contents = { mainFrame: frame, isDestroyed: () => false }, window = { isDestroyed: () => false, webContents: contents };
  const context = vm.createContext({ require: name => name === 'electron' ? { app, BrowserWindow: class {}, ipcMain: {}, Menu: {}, safeStorage: {}, dialog: {}, session: {} } : mainRequire(name), __dirname: dirname(mainFile), module: { exports: {} }, Buffer, console, URL, process: { argv: ['node', 'permission-test'], env: {}, platform: process.platform, arch: process.arch, versions: process.versions }, setTimeout, clearTimeout, window, origin });
  vm.runInContext(await readFile(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext('mainWindow = window; localServer = {origin};', context);
  function session(remote) {
    const ses = new EventEmitter(); ses.webRequest = { onBeforeRequest() {} };
    ses.setPermissionRequestHandler = fn => { ses.request = fn; }; ses.setPermissionCheckHandler = fn => { ses.check = fn; };
    Object.assign(context, { ses, remote }); vm.runInContext('protectSession(ses, remote)', context); return ses;
  }
  const local = session(false), remote = session(true), details = { isMainFrame: true, requestingUrl: frame.url };
  const request = (ses, wc, permission, info) => { let allowed; ses.request(wc, permission, value => { allowed = value; }, info); return allowed; };
  assert.equal(request(local, contents, 'screen-wake-lock', details), true);
  assert.equal(local.check(contents, 'screen-wake-lock', origin, details), true);
  for (const permission of ['system-wake-lock', 'media', 'notifications', 'fullscreen', 'clipboard-read']) {
    assert.equal(request(local, contents, permission, details), false); assert.equal(local.check(contents, permission, origin, details), false);
  }
  for (const info of [{ ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://example.org/' }, { ...details, requestingUrl: `${origin}/other.html` }, undefined]) {
    assert.equal(request(local, contents, 'screen-wake-lock', info), false); assert.equal(local.check(contents, 'screen-wake-lock', origin, info), false);
  }
  assert.equal(local.check(contents, 'screen-wake-lock', 'https://example.org', details), false);
  assert.equal(request(local, { ...contents }, 'screen-wake-lock', details), false);
  assert.equal(local.check(null, 'screen-wake-lock', origin, details), false);
  assert.equal(request(remote, contents, 'screen-wake-lock', details), false);
  assert.equal(remote.check(contents, 'screen-wake-lock', origin, details), false);
  frame.url = 'https://example.org/'; assert.equal(request(local, contents, 'screen-wake-lock', details), false);
  frame.url = details.requestingUrl; vm.runInContext('quitting = true', context);
  assert.equal(request(local, contents, 'screen-wake-lock', details), false);
});
