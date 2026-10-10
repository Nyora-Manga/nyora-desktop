'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
let CookiePersistence;
try { ({ CookiePersistence } = require('./cookie-persistence.cjs')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > end) assert.fail('Coordinator did not settle'); await turn(); }
}
function fixture({ flush = async () => {}, storage = () => {}, rows = [] } = {}) {
  const cookies = new EventEmitter(), effects = [];
  cookies.flushStore = async () => { effects.push('cookie-flush'); await flush(); };
  cookies.get = async filter => { assert.deepEqual(filter, {}); effects.push('metadata-read'); return rows; };
  cookies.set = () => { assert.fail('Saving must never copy cookies or change expiry'); };
  const ses = { cookies, flushStorageData: () => { effects.push('storage-flush'); return storage(); } };
  assert.equal(typeof CookiePersistence, 'function', 'Native cookie persistence coordinator is missing');
  return { coordinator: new CookiePersistence(ses, { debounceMs: 10, now: () => 2000000 }), cookies, effects };
}

test('save publishes only nonexpired cookie metadata after Chromium durability work', async () => {
  const persistent = { name: 'cf_clearance', value: 'private-value', domain: '.example.org', path: '/', secure: true, httpOnly: true, session: false, expirationDate: 2100, sameSite: 'no_restriction' };
  const { coordinator, effects } = fixture({ rows: [persistent, { ...persistent, expirationDate: 1999 }, { ...persistent, session: true, expirationDate: undefined }] });
  const receipt = await coordinator.save();
  assert.deepEqual(receipt, { state: 'saved', savedAt: 2000000, persistentCookies: 1, sessionCookies: 1 });
  assert.deepEqual(effects, ['cookie-flush', 'storage-flush', 'metadata-read']);
  assert.equal(persistent.expirationDate, 2100);
  assert.ok(!JSON.stringify(coordinator.status()).includes('private-value'));
  receipt.persistentCookies = 100; assert.equal(coordinator.status().persistentCookies, 1);
  await coordinator.close();
});

test('failed Chromium flush never creates a saved receipt or exposes the raw error', async () => {
  const { coordinator } = fixture({ flush: async () => { throw new Error('private-cookie-secret'); } });
  await assert.rejects(coordinator.save(), error => error.code === 'COOKIE_SAVE_FAILED' && !error.message.includes('private-cookie-secret'));
  assert.deepEqual(coordinator.status(), { state: 'failed' });
  await assert.rejects(coordinator.close(), { code: 'COOKIE_SAVE_FAILED' });
});

test('storage durability failure is also a failed save rather than a cookie-only receipt', async () => {
  const { coordinator } = fixture({ storage: () => { throw Error('secret-storage-path'); } });
  await assert.rejects(coordinator.save(), { code: 'COOKIE_SAVE_FAILED' });
  assert.deepEqual(coordinator.status(), { state: 'failed' });
  await coordinator.close().catch(() => {});
});

test('changed cookies become saving immediately and bursts debounce into one durable save', async () => {
  const { coordinator, cookies, effects } = fixture();
  for (let i = 0; i < 4; i++) cookies.emit('changed', {}, { name: 'secret', value: 'never-export' }, 'explicit', false);
  assert.deepEqual(coordinator.status(), { state: 'saving' });
  await until(() => coordinator.status().state === 'saved');
  assert.deepEqual(effects, ['cookie-flush', 'storage-flush', 'metadata-read']);
  await coordinator.close();
});

test('a cookie change during a flush cannot publish a stale save receipt', async () => {
  const first = deferred(), second = deferred(); let passes = 0;
  const { coordinator, cookies } = fixture({ flush: () => (++passes === 1 ? first : second).promise });
  const saving = coordinator.save();
  await until(() => passes === 1);
  cookies.emit('changed', {}, {}, 'explicit', false);
  const joined = coordinator.save();
  first.resolve(); await until(() => passes === 2);
  assert.deepEqual(coordinator.status(), { state: 'saving' });
  let resolved = false; saving.then(() => { resolved = true; }); await turn(); assert.equal(resolved, false);
  second.resolve(); assert.equal((await saving).state, 'saved'); assert.equal((await joined).state, 'saved');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(passes, 2, 'An already-flushed dirty event must not schedule a redundant later save');
  await coordinator.close();
});

test('reset drains native durability work before clearing and never resurrects an old receipt', async () => {
  const flushing = deferred(), clearing = deferred(); const order = [];
  const { coordinator, cookies } = fixture({ flush: () => flushing.promise });
  const saving = coordinator.save(); saving.catch(() => {});
  await turn();
  const reset = coordinator.reset(async () => { order.push('clear'); cookies.emit('changed', {}, {}, 'explicit', true); await clearing.promise; });
  await turn(); assert.deepEqual(order, []);
  flushing.resolve(); await until(() => order.length === 1);
  assert.notEqual(coordinator.status().state, 'saved');
  await assert.rejects(saving, { code: 'COOKIE_RESET_IN_PROGRESS' });
  clearing.resolve(); await reset;
  assert.deepEqual(coordinator.status(), { state: 'idle' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(coordinator.status(), { state: 'idle' });
  await coordinator.close();
});

test('reset failure reports failure and cannot keep a previous saved receipt', async () => {
  const { coordinator } = fixture(); await coordinator.save();
  await assert.rejects(coordinator.reset(async () => { throw Error('private-reset-secret'); }), error => error.code === 'COOKIE_RESET_FAILED' && !error.message.includes('private-reset-secret'));
  assert.deepEqual(coordinator.status(), { state: 'failed' });
  await coordinator.close();
});

test('close saves a dirty debounce immediately and detaches automatic cookie observation', async () => {
  const { coordinator, cookies, effects } = fixture();
  cookies.emit('changed', {}, {}, 'explicit', false);
  await coordinator.close();
  assert.equal(coordinator.status().state, 'saved');
  const old = [...effects]; cookies.emit('changed', {}, {}, 'explicit', false); await turn();
  assert.deepEqual(effects, old); assert.equal(cookies.listenerCount('changed'), 0);
  await assert.rejects(coordinator.save(), { code: 'COOKIE_PERSISTENCE_CLOSED' });
});

test('one source persistence failure does not affect another source session', async () => {
  const failed = fixture({ flush: async () => { throw Error('source-one-secret'); } });
  const usable = fixture();
  await assert.rejects(failed.coordinator.save(), { code: 'COOKIE_SAVE_FAILED' });
  assert.equal((await usable.coordinator.save()).state, 'saved');
  assert.deepEqual(failed.coordinator.status(), { state: 'failed' });
  await failed.coordinator.close().catch(() => {}); await usable.coordinator.close();
});

test('dirty changes already flushed by an explicit save do not trigger another automatic save', async () => {
  const held = deferred(); let passes = 0;
  const { coordinator, cookies } = fixture({ flush: async () => { if (++passes === 1) await held.promise; } });
  const saving = coordinator.save(); await turn(); cookies.emit('changed', {}, {}, 'explicit', false);
  held.resolve(); await saving; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(passes, 2); await coordinator.close();
});

test('automatic saving is not starved by a source continuously refreshing cookies', async () => {
  const { coordinator, cookies, effects } = fixture();
  const end = Date.now() + 35;
  while (Date.now() < end) { cookies.emit('changed', {}, {}, 'explicit', false); await turn(); }
  assert.ok(effects.includes('cookie-flush'), 'The first dirty event must schedule a save despite later events');
  await coordinator.close();
});

test('continuous changes during flush bound an explicit save and leave no stale success', async () => {
  let passes = 0, cookies;
  const fixtureValue = fixture({ flush: async () => {
    if (++passes > 4) throw Error('Native boundary rejected unbounded saving');
    cookies.emit('changed', {}, {}, 'explicit', false);
  } });
  cookies = fixtureValue.cookies; const { coordinator } = fixtureValue;
  const saving = coordinator.save(); let result;
  saving.then(value => { result = { value }; }, error => { result = { error }; });
  await turn();
  assert.ok(result?.error, 'A constantly dirty source must not hold the explicit save indefinitely');
  assert.equal(result.error.code, 'COOKIE_SAVE_BUSY');
  assert.ok(passes <= 3); assert.deepEqual(coordinator.status(), { state: 'saving' });
  await coordinator.close(); assert.equal(coordinator.status().state, 'saved');
});

test('a transient automatic flush failure recovers without another cookie event or manual save', async () => {
  let attempts = 0;
  const { coordinator, cookies } = fixture({ flush: async () => { if (++attempts === 1) throw Error('temporary-native-storage-error'); } });
  try {
    cookies.emit('changed', {}, {}, 'explicit', false);
    await until(() => coordinator.status().state === 'failed');
    await until(() => coordinator.status().state === 'saved');
    assert.equal(attempts, 2);
  } finally { await coordinator.close(); }
});

test('permanent automatic flush failure retries with a bound and a new change can start recovery', async () => {
  let attempts = 0, unavailable = true;
  const { coordinator, cookies } = fixture({ flush: async () => { attempts++; if (unavailable) throw Error('permanent-secret'); } });
  try {
    cookies.emit('changed', {}, {}, 'explicit', false);
    await until(() => attempts >= 2);
    await new Promise(resolve => setTimeout(resolve, 180));
    const stoppedAt = attempts;
    assert.ok(stoppedAt >= 2 && stoppedAt <= 4, 'Permanent failure must not create an unbounded retry loop');
    assert.deepEqual(coordinator.status(), { state: 'failed' });
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(attempts, stoppedAt);
    unavailable = false; cookies.emit('changed', {}, {}, 'explicit', false);
    await until(() => coordinator.status().state === 'saved');
    assert.equal(attempts, stoppedAt + 1);
  } finally { unavailable = false; await coordinator.close(); }
});

test('source reset cancels a scheduled failure retry and cannot resurrect a saved receipt', async () => {
  let attempts = 0;
  const { coordinator, cookies } = fixture({ flush: async () => { attempts++; throw Error('temporary'); } });
  cookies.emit('changed', {}, {}, 'explicit', false);
  await until(() => attempts === 2 && coordinator.status().state === 'failed');
  await coordinator.reset(async () => {});
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(attempts, 2); assert.deepEqual(coordinator.status(), { state: 'idle' });
  await coordinator.close();
});

test('shutdown cancels a pending automatic failure retry after its final durability attempt', async () => {
  let attempts = 0;
  const { coordinator, cookies } = fixture({ flush: async () => { attempts++; throw Error('permanent'); } });
  cookies.emit('changed', {}, {}, 'explicit', false);
  await until(() => attempts === 2 && coordinator.status().state === 'failed');
  await assert.rejects(coordinator.close(), { code: 'COOKIE_SAVE_FAILED' });
  const finalCount = attempts;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(attempts, finalCount); assert.equal(cookies.listenerCount('changed'), 0);
});
