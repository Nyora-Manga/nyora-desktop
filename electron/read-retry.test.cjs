'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ContentReadRetry } = require('./read-retry.cjs');

const transient = code => Object.assign(new Error('Temporary failure'), { code });

test('temporary content GET failures retry twice at most and successful reads return normally', async () => {
  const retry = new ContentReadRetry({ delays: [0, 0] });
  let calls = 0;
  assert.deepEqual(await retry.run('content.pages', 'GET', async () => {
    if (++calls < 3) throw transient('HELPER_HTTP_503');
    return { pages: ['image'] };
  }), { pages: ['image'] });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retry.run('content.search', 'GET', async () => { calls++; throw transient('HELPER_HTTP_429'); }));
  assert.equal(calls, 3);
  retry.close();
});

test('CF, parser, security, auth and missing content errors never retry', async () => {
  const retry = new ContentReadRetry({ delays: [0, 0] });
  for (const code of ['SOURCE_VERIFICATION_REQUIRED', 'HELPER_HTTP_409', 'HELPER_HTTP_400', 'HELPER_HTTP_401',
    'HELPER_HTTP_403', 'HELPER_HTTP_404', 'HELPER_HTTP_500', 'PRIVATE_NETWORK_DENIED', 'UNTRUSTED_REDIRECT', 'TRANSPORT_CANCELLED']) {
    let calls = 0;
    await assert.rejects(retry.run('content.details', 'GET', async () => { calls++; throw transient(code); }));
    assert.equal(calls, 1, code);
  }
  let calls = 0;
  await assert.rejects(retry.run('content.pages', 'GET', async () => { calls++; throw new Error('Parser failed: desktop_relay_unavailable'); }));
  assert.equal(calls, 1, 'Error messages cannot confer retry authority');
  retry.close();
});

test('writes, metadata, global searches and unknown operations are outside content read retry', async () => {
  const retry = new ContentReadRetry({ delays: [0, 0] });
  for (const [operation, method] of [['library.favouriteToggle', 'POST'], ['library.stats', 'GET'],
    ['content.globalSearch', 'GET'], ['sources.filters', 'GET'], ['content.pages', 'POST'], ['content.other', 'GET']]) {
    let calls = 0;
    await assert.rejects(retry.run(operation, method, async () => { calls++; throw transient('HELPER_HTTP_503'); }));
    assert.equal(calls, 1, operation);
  }
  retry.close();
});

test('typed connection causes and actual timeouts retry while bare TypeError does not', async () => {
  const retry = new ContentReadRetry({ delays: [0] });
  for (const error of [new DOMException('Timed out', 'TimeoutError'), new TypeError('fetch failed', { cause: transient('ECONNRESET') })]) {
    let calls = 0;
    assert.equal(await retry.run('content.popular', 'GET', async () => { if (++calls === 1) throw error; return 'loaded'; }), 'loaded');
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(retry.run('content.latest', 'GET', async () => { calls++; throw new TypeError('Failed to fetch'); }));
  assert.equal(calls, 1);
  retry.close();
});

test('verification or helper state changing during backoff prevents a new attempt', async () => {
  const retry = new ContentReadRetry({ delays: [10, 10] });
  let calls = 0, permitted = true;
  const pending = retry.run('content.pages', 'GET', async () => { calls++; throw transient('HELPER_HTTP_504'); }, { canRetry: () => permitted });
  await new Promise(resolve => setImmediate(resolve));
  permitted = false;
  await assert.rejects(pending, { code: 'HELPER_HTTP_504' });
  assert.equal(calls, 1);
  retry.close();
});

test('shutdown cancels queued backoff immediately without replaying an operation', async () => {
  const retry = new ContentReadRetry({ delays: [5000, 5000] });
  let calls = 0;
  const pending = retry.run('content.pages', 'GET', async () => { calls++; throw transient('HELPER_HTTP_502'); });
  const rejected = assert.rejects(pending, { code: 'READ_RETRY_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  retry.close();
  await rejected;
  assert.equal(calls, 1);
  await assert.rejects(retry.run('content.pages', 'GET', async () => { calls++; }), { code: 'READ_RETRY_CANCELLED' });
  assert.equal(calls, 1);
});

test('destroying the requesting window cancels backoff and releases its listener', async () => {
  const retry = new ContentReadRetry({ delays: [5000] }), owner = new EventEmitter();
  let calls = 0;
  const rejected = assert.rejects(retry.run('content.pages', 'GET', async () => {
    calls++; throw transient('HELPER_HTTP_503');
  }, { owner }), { code: 'READ_RETRY_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  owner.emit('destroyed');
  await rejected;
  assert.equal(calls, 1);
  assert.equal(owner.listenerCount('destroyed'), 0);
  retry.close();
});

test('concurrent hydration and mutation requests attach no retry listeners', async () => {
  const retry = new ContentReadRetry(), owner = new EventEmitter();
  const reads = Array.from({ length: 20 }, () => retry.run('library.stats', 'GET', async () => {
    assert.equal(owner.listenerCount('destroyed'), 0); return 'loaded';
  }, { owner }));
  assert.equal((await Promise.all(reads)).length, 20);
  retry.close();
});
