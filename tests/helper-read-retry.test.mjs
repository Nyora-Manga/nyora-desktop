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
  const directory = await mkdtemp(join(tmpdir(), 'nyora-read-retry-main-'));
  const app = new EventEmitter(), handlers = new Map(), paths = { appData: directory }, proofs = [];
  Object.assign(app, { commandLine: { hasSwitch: () => false }, isPackaged: false, enableSandbox() {}, setName() {}, setAppUserModelId() {},
    getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), quit() {} });
  const origin = 'http://127.0.0.1:43210', frame = { url: `${origin}/index.html` }, contents = new EventEmitter();
  let destroyed = false, currentUrl = `${origin}/index.html#/reader?chapter=first`;
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => destroyed, getURL: () => currentUrl });
  const window = { isDestroyed: () => destroyed, webContents: contents };
  const { SourceVerification } = mainRequire('./verification.cjs');
  class TrackedVerification extends SourceVerification {
    checkpoint() { const token = super.checkpoint(); proofs.push({ type: 'dispatch', token }); return token; }
    completed(operation, params, result, options) { proofs.push({ type: 'completed', token: options.checkpoint }); return super.completed(operation, params, result, options); }
    failed(operation, params, error) { proofs.push({ type: 'failed', error }); return super.failed(operation, params, error); }
  }
  const electron = { app, BrowserWindow: class {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: {}, safeStorage: {}, dialog: {}, session: {}, shell: {} };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './verification.cjs' ? { SourceVerification: TrackedVerification }
    : name === './read-retry.cjs' ? { ContentReadRetry: class extends mainRequire(name).ContentReadRetry { constructor() { super({ delays: [10, 10] }); } } } : mainRequire(name),
    __dirname: dirname(mainFile), module: { exports: {} }, Buffer, console, URL,
    process: { argv: ['node', 'read-retry-main-test'], env: {}, arch: process.arch, platform: process.platform, versions: process.versions }, setTimeout, clearTimeout,
    injectedWindow: window, injectedOrigin: origin });
  vm.runInContext(await readFile(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext(`mainWindow = injectedWindow; localServer = {origin: injectedOrigin};
    catalogueLookup = sourceId => ({sourceId,baseUrl:'https://example.org/',allowedOrigins:['https://example.org']}); registerCommands();`, context);
  return {
    proofs,
    invoke: value => handlers.get('nyora:service-request')({ sender: contents, senderFrame: frame }, value),
    inject(services, helper) {
      Object.assign(context, { injectedServices: services, injectedHelper: helper });
      vm.runInContext('services = injectedServices; helper = injectedHelper;', context);
    },
    challenge() { vm.runInContext(`verification.required({sourceId:'data:first',url:'https://example.org/chapters'},{fromRelay:true});`, context); },
    verifiedPending(params) {
      context.injectedParams = params;
      vm.runInContext(`verification.required({sourceId:injectedParams.id,url:'https://example.org/chapter'},{fromRelay:true});
        verification.failed('content.pages',injectedParams,{code:'SOURCE_VERIFICATION_REQUIRED'});
        verification.opened(injectedParams.id); verification.closed(injectedParams.id);`, context);
    },
    verificationStatus() { return vm.runInContext('verification.status()', context); },
    destroy() { destroyed = true; contents.emit('destroyed'); },
    navigate() { currentUrl = `${origin}/index.html#/reader?chapter=second`; },
    gate(run) { context.injectedRun = run; vm.runInContext('serviceGate.run = injectedRun;', context); },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('actual main automatically retries a temporary content read with a new proof checkpoint for every real attempt', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const helper = { status: { state: 'ready' } };
    f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request() {
      if (++calls === 1) throw Object.assign(new Error('Temporary upstream failure'), { code: 'HELPER_HTTP_503' });
      return { pages: ['https://example.org/page.jpg'] };
    } }, helper);
    assert.deepEqual(await f.invoke({ operation: 'content.pages', params: { id: 'data:first', url: 'chapter' } }), { pages: ['https://example.org/page.jpg'] });
    assert.equal(calls, 2);
    assert.deepEqual(f.proofs.map(entry => entry.type), ['dispatch', 'failed', 'dispatch', 'completed']);
    assert.notEqual(f.proofs[0].token, f.proofs[2].token);
    assert.equal(f.proofs[2].token, f.proofs[3].token);
  } finally { await f.cleanup(); }
});

test('actual main stops ordinary retry as soon as the selected source requires verification', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request() {
      calls++; f.challenge();
      throw Object.assign(new Error('Temporary failure alongside an actual challenge'), { code: 'HELPER_HTTP_503' });
    } }, { status: { state: 'ready' } });
    await assert.rejects(f.invoke({ operation: 'content.pages', params: { id: 'data:first', url: 'chapter' } }), { code: 'HELPER_HTTP_503' });
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('a post-verification content retry recovers a temporary failure with fresh per-attempt proof', async () => {
  for (const failure of [Object.assign(new Error('Temporary upstream failure'), { code: 'HELPER_HTTP_503' }),
    new DOMException('Temporary timeout', 'TimeoutError')]) {
    const f = await fixture();
    try {
      const params = { id: 'data:first', url: 'chapter' }, freshness = [];
      let calls = 0;
      f.verifiedPending(params);
      assert.equal(f.verificationStatus()[0].phase, 'retry-required');
      f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request(_value, { fresh }) {
        freshness.push(fresh);
        if (++calls === 1) throw failure;
        return { pages: ['https://example.org/page.jpg'] };
      } }, { status: { state: 'ready' } });
      await f.invoke({ operation: 'content.pages', params });
      assert.equal(calls, 2);
      assert.deepEqual(freshness, [true, true], 'Every post-verification attempt bypasses helper cache');
      const dispatches = f.proofs.filter(entry => entry.type === 'dispatch');
      assert.equal(dispatches.length, 2);
      assert.notEqual(dispatches[0].token, dispatches[1].token);
      assert.equal(f.proofs.at(-1).token, dispatches[1].token);
      assert.equal(f.verificationStatus().length, 0, 'Exact parsed success clears the prior challenge');
    } finally { await f.cleanup(); }
  }
});

test('ordinary retry does not multiply the existing helper-crash restart replay', async () => {
  const f = await fixture();
  try {
    let calls = 0, starts = 0;
    const helper = { status: { state: 'unavailable', code: 'HELPER_EXITED' }, async start() { starts++; this.status = { state: 'ready' }; } };
    f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request() {
      calls++;
      if (calls === 1) throw new Error('Helper connection ended');
      if (calls === 2) throw Object.assign(new Error('Temporary upstream failure'), { code: 'HELPER_HTTP_503' });
      helper.status = { state: 'unavailable', code: 'HELPER_EXITED' };
      throw new DOMException('Timed out while helper exited', 'TimeoutError');
    } }, helper);
    await assert.rejects(f.invoke({ operation: 'content.pages', params: { id: 'data:first', url: 'chapter' } }), { name: 'TimeoutError' });
    assert.equal(calls, 3);
    assert.equal(starts, 1, 'The later ordinary retry cannot restart/replay the helper again');
    assert.equal(new Set(f.proofs.filter(entry => entry.type === 'dispatch').map(entry => entry.token)).size, 3);
  } finally { await f.cleanup(); }
});

test('actual main cancels queued retries after chapter navigation or main window destruction', async () => {
  for (const action of ['navigate', 'destroy']) {
    const f = await fixture();
    try {
      let calls = 0;
      f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request() {
        calls++; throw Object.assign(new Error('Temporary upstream failure'), { code: 'HELPER_HTTP_503' });
      } }, { status: { state: 'ready' } });
      const rejected = assert.rejects(f.invoke({ operation: 'content.pages', params: { id: 'data:first', url: 'chapter' } }),
        { code: action === 'destroy' ? 'READ_RETRY_CANCELLED' : 'HELPER_HTTP_503' });
      await new Promise(resolve => setImmediate(resolve));
      f[action]();
      await rejected;
      assert.equal(calls, 1, action);
    } finally { await f.cleanup(); }
  }
});

test('navigation while an extra retry waits behind the native gate prevents the delayed fetch', async () => {
  const f = await fixture();
  try {
    let calls = 0, gateCalls = 0;
    const queued = Promise.withResolvers(), release = Promise.withResolvers();
    f.gate(async request => {
      if (++gateCalls === 2) { queued.resolve(); await release.promise; }
      return request();
    });
    f.inject({ operations: { 'content.pages': { method: 'GET' } }, async request() {
      calls++; throw Object.assign(new Error('Temporary upstream failure'), { code: 'HELPER_HTTP_503' });
    } }, { status: { state: 'ready' } });
    const rejected = assert.rejects(f.invoke({ operation: 'content.pages', params: { id: 'data:first', url: 'chapter' } }),
      { code: 'READ_RETRY_CANCELLED' });
    await queued.promise;
    f.navigate(); release.resolve();
    await rejected;
    assert.equal(calls, 1, 'A queued automatic attempt must not fetch the chapter after navigation');
  } finally { await f.cleanup(); }
});
