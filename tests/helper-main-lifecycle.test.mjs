import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainFile = resolve(dirname(fileURLToPath(import.meta.url)), '../electron/main.cjs');
const mainRequire = createRequire(mainFile);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('actual main prevents repeated quit and hidden-window closure until native work and cookie flush finish', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-main-lifecycle-'));
  const stopped = deferred(), closed = deferred(), flushed = deferred();
  const events = [], quits = [];
  let exited = false;
  const app = new EventEmitter();
  const paths = { appData: directory };
  Object.assign(app, {
    commandLine: { hasSwitch: () => false }, isPackaged: false,
    enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; },
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      quits.push({ prevented });
      if (!prevented) { exited = true; events.push('exit-permitted'); }
    },
    exit: code => { throw new Error(`Unexpected forced exit ${code}`); },
  });
  const session = name => ({
    flushStorageData() { events.push(`${name}:storage-flush`); },
    cookies: { flushStore() { events.push(`${name}:cookie-flush`); return flushed.promise; } },
  });
  const sourceSession = session('source'), uiSession = session('ui');
  const electron = { app, BrowserWindow: class {}, ipcMain: {}, Menu: {}, safeStorage: {}, dialog: {},
    session: { fromPartition: partition => { assert.equal(partition, 'persist:local-ui'); return uiSession; } } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : mainRequire(name),
    __dirname: dirname(mainFile), module: { exports: {} }, Buffer, console,
    process: { argv: ['node', 'main-lifecycle-test'], env: {}, arch: process.arch, platform: process.platform, versions: process.versions },
    setTimeout, clearTimeout,
    injectedServer: { stop() { events.push('local-server-stop'); } },
    injectedHelper: { stop() { events.push('helper-stop'); return stopped.promise; } },
    injectedRelay: { stop() { events.push('relay-stop'); } },
    injectedTransport: { close() { events.push('native-close'); app.emit('window-all-closed'); return closed.promise; } },
    injectedSourceWindow: { isDestroyed: () => false, destroy() { events.push('verification-destroy'); } },
    injectedSourceSession: sourceSession,
  });
  try {
    vm.runInContext(await readFile(mainFile, 'utf8'), context, { filename: mainFile });
    // Bind production module state to owned lifecycle doubles; no source rewrite
    // or alternate implementation of its event handlers/cleanup chain is used.
    vm.runInContext(`localServer = injectedServer; helper = injectedHelper; relay = injectedRelay;
      browserTransport = injectedTransport; sources.set('owned', injectedSourceWindow);
      sourceSessions.set('owned', injectedSourceSession);`, context);
    app.quit(); app.quit();
    await turn();
    assert.deepEqual(events, ['local-server-stop', 'helper-stop']);
    assert.equal(exited, false);
    assert.ok(quits.every(quit => quit.prevented));
    stopped.resolve(); await turn();
    assert.deepEqual(events, ['local-server-stop', 'helper-stop', 'relay-stop', 'verification-destroy', 'native-close']);
    assert.equal(quits.length, 2, 'Last hidden-window closure must not re-enter quit during cleanup');
    app.quit(); assert.equal(exited, false);
    closed.resolve(); await turn();
    assert.ok(events.includes('source:cookie-flush') && events.includes('ui:cookie-flush'));
    assert.equal(exited, false, 'Pending cookie durability must prevent process exit');
    app.quit(); assert.equal(exited, false);
    flushed.resolve(); await turn();
    assert.equal(exited, true);
    assert.equal(quits.filter(quit => !quit.prevented).length, 1);
    assert.equal(events.at(-1), 'exit-permitted');
    assert.ok(events.indexOf('native-close') < events.indexOf('source:cookie-flush'));
    assert.ok(events.indexOf('source:cookie-flush') < events.indexOf('exit-permitted'));
  } finally {
    stopped.resolve(); closed.resolve(); flushed.resolve(); await turn();
    await rm(directory, { recursive: true, force: true });
  }
});
