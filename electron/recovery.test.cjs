'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowRecovery, HelperReadRecovery } = require('./recovery.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));

function windowFixture() {
  const contents = new EventEmitter(), window = new EventEmitter(), loads = [], messages = [];
  let url = 'http://127.0.0.1:12345/index.html#/reader?sid=data:first';
  Object.assign(contents, { getURL: () => url, isDestroyed: () => false });
  Object.assign(window, { webContents: contents, isDestroyed: () => false, loadURL: async target => { loads.push(target); url = target; } });
  let next = 0, quitting = false, now = 0, quits = 0;
  const recovery = new WindowRecovery({ window, indexUrl: 'http://127.0.0.1:12345/index.html',
    dialog: { async showMessageBox(_window, value) { messages.push(value); return { response: next }; } },
    isQuitting: () => quitting, quit: () => { quits++; }, now: () => now });
  return { contents, window, recovery, loads, messages, setResponse: v => { next = v; }, setQuitting: v => { quitting = v; }, advance: v => { now += v; }, quits: () => quits };
}

test('renderer recovery reloads the trusted reader route twice then requires a native decision', async () => {
  const f = windowFixture();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await turn();
  f.contents.emit('render-process-gone', {}, { reason: 'oom' }); await turn();
  assert.equal(f.loads.length, 2); assert.match(f.loads[0], /#\/reader\?/);
  f.setResponse(1);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await turn();
  assert.equal(f.loads.length, 2); assert.equal(f.messages.length, 1); assert.equal(f.quits(), 1);
  f.setQuitting(true);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await turn();
  assert.equal(f.messages.length, 1);
  f.recovery.close();
});

test('unresponsive window can wait without reloading and responsive events dismiss later prompts', async () => {
  const f = windowFixture(); f.setResponse(1);
  f.window.emit('unresponsive'); await turn();
  assert.equal(f.loads.length, 0); assert.deepEqual(f.messages[0].buttons, ['Reload', 'Keep waiting', 'Quit']);
  f.window.emit('responsive');
  f.setResponse(0); f.window.emit('unresponsive'); await turn();
  assert.equal(f.loads.length, 1);
  f.recovery.close();
});

test('renderer recovery rejects remote routes and releases event listeners when its window closes', async () => {
  const f = windowFixture(); f.contents.getURL = () => 'https://untrusted.example/';
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await turn();
  assert.equal(f.loads[0], 'http://127.0.0.1:12345/index.html');
  f.recovery.close(); f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await turn();
  assert.equal(f.loads.length, 1);
});

test('simultaneous safe reads coalesce a crashed helper restart; writes and CF failures are never replayed', async () => {
  let starts = 0, count = 0;
  const helper = { status: { state: 'unavailable', code: 'HELPER_EXITED' }, async start() { starts++; await turn(); this.status = { state: 'ready' }; } };
  const recovery = new HelperReadRecovery({ helper: () => helper });
  const read = async () => { count++; if (helper.status.state !== 'ready') throw new Error('Read connection ended'); return 'parsed'; };
  assert.deepEqual(await Promise.all([recovery.run(true, read), recovery.run(true, read)]), ['parsed', 'parsed']);
  assert.equal(starts, 1); assert.equal(count, 4);
  helper.status = { state: 'unavailable', code: 'HELPER_EXITED' };
  let writes = 0;
  await assert.rejects(recovery.run(false, async () => { writes++; throw new Error('Commit response lost'); }));
  assert.equal(writes, 1); assert.equal(starts, 1);
  await assert.rejects(recovery.run(true, async () => { throw Object.assign(new Error('Challenge'), { code: 'SOURCE_VERIFICATION_REQUIRED' }); }));
  assert.equal(starts, 1);
});

test('helper read restart is bounded and shutdown refuses new recovery', async () => {
  let starts = 0;
  const helper = { status: { state: 'unavailable', code: 'HELPER_EXITED' }, async start() { starts++; } };
  const recovery = new HelperReadRecovery({ helper: () => helper });
  const failed = () => Promise.reject(new Error('Unavailable'));
  await assert.rejects(recovery.run(true, failed)); await assert.rejects(recovery.run(true, failed));
  await assert.rejects(recovery.run(true, failed)); assert.equal(starts, 2);
  recovery.close(); await assert.rejects(recovery.run(true, failed)); assert.equal(starts, 2);
});
