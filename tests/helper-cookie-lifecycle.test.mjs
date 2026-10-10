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
const deferred = () => Promise.withResolvers();

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-cookie-main-'));
  const app = new EventEmitter(), handlers = new Map(), windows = [], sessions = new Map();
  const paths = { appData: directory };
  Object.assign(app, {
    commandLine: { hasSwitch: () => false }, isPackaged: false,
    enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; },
    requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
  });
  let flush = async () => {}, flushCalls = 0, clears = 0;
  const makeSession = () => {
    const cookies = new EventEmitter();
    Object.assign(cookies, {
      flushStore: () => { flushCalls++; return flush(); },
      get: async () => [{ name: 'cf_clearance', value: 'never-expose-this-cookie', domain: 'example.org',
        expirationDate: Date.now() / 1000 + 600, session: false, secure: true, httpOnly: true }],
    });
    return Object.assign(new EventEmitter(), {
      cookies, setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} }, flushStorageData() {}, closeAllConnections: async () => {},
      clearAuthCache: async () => {}, clearCache: async () => {}, clearStorageData: async () => { clears++; },
    });
  };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} }); }
    isDestroyed() { return this.dead; }
    loadURL() { return Promise.resolve(); }
    focus() {}
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const origin = 'http://127.0.0.1:43210';
  const frame = { url: `${origin}/index.html` };
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame: frame, isDestroyed: () => false } };
  const event = { sender: mainWindow.webContents, senderFrame: frame };
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: {}, safeStorage: {}, dialog: {}, session: { fromPartition: key => {
      if (!sessions.has(key)) sessions.set(key, makeSession()); return sessions.get(key);
    } } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : mainRequire(name),
    __dirname: dirname(mainFile), module: { exports: {} }, Buffer, console, URL,
    process: { argv: ['node', 'cookie-lifecycle-test'], env: {}, arch: process.arch, platform: process.platform, versions: process.versions },
    setTimeout, clearTimeout, injectedMainWindow: mainWindow, injectedOrigin: origin,
  });
  vm.runInContext(await readFile(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext(`mainWindow = injectedMainWindow; localServer = { origin: injectedOrigin };
    catalogueLookup = sourceId => sourceId === 'data:fixture' ? {sourceId, baseOrigin:'https://example.org', allowedOrigins:['https://example.org']} : undefined;
    registerCommands();`, context);
  return {
    handlers, windows, event, sessions,
    setServices: instance => { context.injectedServices = instance; vm.runInContext('services = injectedServices;', context); },
    challenge: () => vm.runInContext("verification.required({ sourceId: 'data:fixture', url: 'https://example.org/' }, { fromRelay: true });", context),
    setFlush: fn => { flush = fn; }, calls: () => flushCalls, clears: () => clears,
    invoke: (name, value = { sourceId: 'data:fixture' }) => handlers.get(`nyora:${name}`)(event, value),
    async cleanup() {
      flush = async () => {};
      await vm.runInContext(`typeof cookieStores === 'undefined' ? undefined : Promise.allSettled([...cookieStores.values()].map(store => store.close()))`, context);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('closing the actual verification window waits for cookie durability before allowing retry', async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.setFlush(() => gate.promise);
    await f.invoke('open-verification');
    f.windows[0].destroy(); await turn();
    assert.equal(f.calls(), 1, 'Window close must flush its own Chromium cookie store');
    assert.equal((await f.invoke('verification-status'))[0].phase, 'verification-opened');
    gate.resolve(); await turn(); await turn();
    const status = (await f.invoke('verification-status'))[0];
    assert.equal(status.phase, 'retry-required');
    assert.equal(status.cookies.state, 'saved');
    assert.equal(status.cookies.persistentCookies, 1);
    assert.doesNotMatch(JSON.stringify(status), /never-expose|cf_clearance|example\.org.*value/);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('actual main uses fresh source reads during verification and retains the original proof identity', async () => {
  const f = await fixture();
  const requests = [];
  try {
    f.setServices({ request: async (value, options) => { requests.push({ value, options }); return { entries: [{ id: 'usable-manga' }] }; } });
    const read = { operation: 'content.popular', params: { id: 'data:fixture', page: 1 } };
    await f.invoke('service-request', read);
    assert.equal(Boolean(requests[0].options?.fresh), false);
    await f.invoke('open-verification');
    f.windows[0].destroy(); await turn(); await turn();
    await f.invoke('service-request', read);
    assert.equal(requests[1].options?.fresh, true);
    assert.deepEqual(requests[1].value, read);
    assert.equal((await f.invoke('verification-status')).length, 0);
  } finally { await f.cleanup(); }
});

test('actual main cannot let an old cached response clear a newer challenge', async () => {
  const f = await fixture(), old = deferred();
  let calls = 0;
  try {
    f.setServices({ request: async () => {
      if (++calls === 1) return old.promise;
      f.challenge();
      throw Object.assign(new Error('Verification required'), { code: 'SOURCE_VERIFICATION_REQUIRED' });
    } });
    const read = { operation: 'content.popular', params: { id: 'data:fixture', page: 1 } };
    const older = f.invoke('service-request', read);
    await assert.rejects(f.invoke('service-request', read), /Verification required/);
    old.resolve({ entries: [{ id: 'old-cached-result' }] }); await older;
    assert.equal((await f.invoke('verification-status')).length, 1);
    f.setServices({ request: async () => ({ entries: [{ id: 'fresh-result' }] }) });
    await f.invoke('service-request', read);
    assert.equal((await f.invoke('verification-status')).length, 0);
  } finally { old.resolve({ entries: [] }); await f.cleanup(); }
});

test('explicit source cookie save enforces caller and catalogue authority and exposes only metadata', async () => {
  const f = await fixture();
  try {
    const save = f.handlers.get('nyora:save-source-cookies');
    assert.equal(typeof save, 'function');
    await assert.rejects(save({ sender: {}, senderFrame: f.event.senderFrame }, { sourceId: 'data:fixture' }));
    await assert.rejects(f.invoke('save-source-cookies', { sourceId: 'data:unknown' }));
    await f.invoke('open-verification');
    const receipt = await f.invoke('save-source-cookies');
    assert.equal(receipt.state, 'saved');
    assert.equal(receipt.persistentCookies, 1);
    assert.equal(f.windows[0].isDestroyed(), false, 'Saving is also usable while verification is open');
    assert.deepEqual(Object.keys(receipt).sort(), ['persistentCookies', 'savedAt', 'sessionCookies', 'state']);
  } finally { await f.cleanup(); }
});

test('failed window-close cookie save remains visible and explicit save can recover', async () => {
  const f = await fixture();
  try {
    f.setFlush(async () => { throw new Error('private-cookie-or-path-detail'); });
    await f.invoke('open-verification'); f.windows[0].destroy();
    await turn(); await turn();
    const status = (await f.invoke('verification-status'))[0];
    assert.equal(status.phase, 'retry-required');
    assert.equal(status.cookies?.state, 'failed');
    assert.doesNotMatch(JSON.stringify(status), /private-cookie-or-path-detail|never-expose/);
    f.setFlush(async () => {});
    assert.equal((await f.invoke('save-source-cookies')).state, 'saved');
  } finally { await f.cleanup(); }
});

test('source reset waits for close-time cookie save and discards its saved receipt', async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.setFlush(() => gate.promise);
    await f.invoke('open-verification'); f.windows[0].destroy(); await turn();
    const resetting = f.invoke('reset-source-session');
    await turn(); assert.equal(f.clears(), 0);
    gate.resolve(); assert.equal((await resetting).reset, true);
    assert.equal(f.clears(), 1);
    assert.equal((await f.invoke('verification-status')).length, 0);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('an older window closing during reopen cannot mark the new verification window closed', async () => {
  const f = await fixture(), proxy = deferred(), flush = deferred();
  try {
    await f.invoke('open-verification');
    [...f.sessions.values()][0].setProxy = () => proxy.promise;
    f.setFlush(() => flush.promise);
    const reopening = f.invoke('open-verification'); await turn();
    f.windows[0].destroy();
    proxy.resolve(); await reopening; await turn();
    assert.equal(f.windows.length, 2);
    assert.equal(f.windows[1].isDestroyed(), false);
    flush.resolve(); await turn(); await turn();
    assert.equal((await f.invoke('verification-status'))[0].phase, 'verification-opened',
      'Only the currently owned verification window may transition to closed');
  } finally { proxy.resolve(); flush.resolve(); await f.cleanup(); }
});
