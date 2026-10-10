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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-recovery-main-'));
  const app = new EventEmitter(), handlers = new Map(), names = [], external = [], paths = { appData: directory };
  Object.assign(app, { commandLine: { hasSwitch: () => false }, isPackaged: false, enableSandbox() {},
    setName: value => names.push(value), setAppUserModelId() {}, getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; },
    requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit() {} });
  const origin = 'http://127.0.0.1:43210', frame = { url: `${origin}/index.html` };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame, isDestroyed: () => false } };
  const electron = { app, BrowserWindow: class {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: {}, safeStorage: {}, dialog: {}, session: {}, shell: {openExternal: async url => external.push(url)} };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : mainRequire(name), __dirname: dirname(mainFile), module: { exports: {} }, Buffer, console, URL,
    process: { argv: ['node', 'recovery-main-test'], env: {}, arch: process.arch, platform: process.platform, versions: process.versions }, setTimeout, clearTimeout,
    injectedWindow: window, injectedOrigin: origin });
  vm.runInContext(await readFile(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext('mainWindow = injectedWindow; localServer = {origin: injectedOrigin}; registerCommands();', context);
  return { paths, names, external, protect(window, local) { Object.assign(context, {testWindow: window, testLocal: local}); vm.runInContext("protectWindow(testWindow, () => false, undefined, testLocal);", context); }, invoke: value => handlers.get('nyora:service-request')({ sender: window.webContents, senderFrame: frame }, value),
    inject(services, helper, gate) { Object.assign(context, { injectedServices: services, injectedHelper: helper, injectedGate: gate });
      vm.runInContext('services = injectedServices; helper = injectedHelper;', context);
      if (gate) vm.runInContext('serviceGate.run = injectedGate.run; serviceGate.exclusive = injectedGate.exclusive;', context);
    }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('actual main retries only crashed-helper GET reads and keeps preview profile/encryption identity', async () => {
  const f = await fixture();
  try {
    let calls = 0, restarts = 0;
    const helper = { status: { state: 'unavailable', code: 'HELPER_EXITED' }, async start() { restarts++; this.status = { state: 'ready' }; } };
    const services = { operations: { 'library.stats': { method: 'GET' }, 'library.favouriteToggle': { method: 'POST' } },
      async request(value) { calls++; if (helper.status.state !== 'ready') throw new Error('Connection ended'); return { operation: value.operation }; } };
    f.inject(services, helper);
    assert.equal((await f.invoke({ operation: 'library.stats', params: {} })).operation, 'library.stats');
    assert.equal(calls, 2); assert.equal(restarts, 1);
    helper.status = { state: 'unavailable', code: 'HELPER_EXITED' };
    await assert.rejects(f.invoke({ operation: 'library.favouriteToggle', params: { mangaId: 'synthetic' } }));
    assert.equal(calls, 3); assert.equal(restarts, 1);
    assert.match(f.paths.userData, /app\.nyora\.desktop\.preview[/\\]electron$/);
    assert.deepEqual(f.names, ['Nyora Preview']);
  } finally { await f.cleanup(); }
});

test('actual main serializes cloud mutations exclusively while ordinary reads use the read gate', async () => {
  const f = await fixture(), calls = [];
  try {
    f.inject({ operations: {}, request: async () => ({ ok: true }) }, {}, {
      run: async task => { calls.push('read'); return task(); }, exclusive: async task => { calls.push('exclusive'); return task(); },
    });
    await f.invoke({ operation: 'sync.now', params: {} });
    await f.invoke({ operation: 'ui.preferences.get', params: {} });
    assert.deepEqual(calls, ['exclusive', 'read']);
  } finally { await f.cleanup(); }
});


test('main opens only public HTTPS links in the system browser and remote windows never get this capability', async () => {
  const f = await fixture();
  try {
    const contents = new EventEmitter(); contents.setWindowOpenHandler = handler => { contents.open = handler; };
    const window = {webContents:contents,isDestroyed:()=>false}; f.protect(window,true);
    for (const url of ['file:///private/secret','javascript:alert(1)','https://127.0.0.1/','https://user:pass@example.org/','http://example.org/','nyora://account']) assert.equal(contents.open({url}).action,'deny');
    assert.equal(f.external.length,0);
    assert.equal(contents.open({url:'https://example.org/title'}).action,'deny');
    assert.deepEqual(f.external,['https://example.org/title']);
    const remote = new EventEmitter(); remote.setWindowOpenHandler = handler => {remote.open=handler;};
    f.protect({webContents:remote,isDestroyed:()=>false},false);
    remote.open({url:'https://example.org/title'});assert.equal(f.external.length,1);
  } finally { await f.cleanup(); }
});
