import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../frontend/native-services.js';
import * as recovery from '../frontend/source-recovery.js';
import { createImageRetries } from '../frontend/native-images.js';
import { SourceVerification } from '../electron/verification.cjs';

const id = 'data:ATSUMOE';
const blocked = () => new Error('Source verification_required');

test('an older successful read cannot erase a newer verification failure', async () => {
  const old = Promise.withResolvers();
  let calls = 0;
  const services = createNativeServices({ serviceRequest: async () => ++calls === 1 ? old.promise : Promise.reject(blocked()) });
  const first = services.request('content.popular', { id, page: 1 });
  await assert.rejects(services.request('content.popular', { id, page: 1 }));
  assert(services.canRetryContent(id));
  old.resolve({ entries: [{ id: 'older-cached-title' }] }); await first;
  assert(services.canRetryContent(id), 'The new failure must remain available for post-verification retry');
});

test('an older failed read cannot recreate an error already resolved by a newer read', async () => {
  const old = Promise.withResolvers();
  let calls = 0;
  const services = createNativeServices({ serviceRequest: async () => ++calls === 1 ? old.promise : { entries: [{ id: 'current-title' }] } });
  const first = services.request('content.popular', { id, page: 1 });
  await services.request('content.popular', { id, page: 1 });
  old.reject(blocked()); await assert.rejects(first);
  assert.equal(services.canRetryContent(id), false);
});

test('recovery retains every failed read for a source and clears exact normal successes', async () => {
  let fail = true;
  const requests = [];
  const services = createNativeServices({ async serviceRequest(value) {
    requests.push(structuredClone(value));
    if (fail) throw blocked();
    return value.operation === 'content.pages' ? { pages: ['https://example.org/page.jpg'] } : { entries: [{ id: 'manga' }] };
  } });
  await assert.rejects(services.request('content.popular', { id, page: 1 }));
  await assert.rejects(services.request('content.pages', { id, url: 'chapter/a' }));
  await assert.rejects(services.request('content.pages', { id, url: 'chapter/b' }));
  await assert.rejects(services.request('content.popular', { id: 'data:OTHER', page: 1 }));
  fail = false;
  await services.request('content.pages', { id, url: 'chapter/a' });
  requests.length = 0;
  const result = await services.retryContent(id);
  assert.deepEqual(requests, [
    { operation: 'content.popular', params: { id, page: 1 } },
    { operation: 'content.pages', params: { id, url: 'chapter/b' } },
  ]);
  assert.deepEqual(result.retriedRequests, requests);
  assert.equal(services.canRetryContent(id), false);
  assert.equal(services.canRetryContent('data:OTHER'), true);
});

test('a failed recovery cannot prevent other reads recovering or discard unresolved reads', async () => {
  let stage = 'blocked';
  const services = createNativeServices({ async serviceRequest({ operation }) {
    if (stage === 'blocked' || stage === 'partial' && operation === 'content.popular') throw blocked();
    return { pages: ['https://example.org/page.jpg'] };
  } });
  await assert.rejects(services.request('content.popular', { id, page: 1 }));
  await assert.rejects(services.request('content.pages', { id, url: 'chapter' }));
  stage = 'partial';
  await assert.rejects(services.retryContent(id), error => {
    assert.deepEqual(error.retriedRequests, [{ operation: 'content.pages', params: { id, url: 'chapter' } }]);
    return true;
  });
  assert.equal(services.canRetryContent(id), true);
  stage = 'ready';
  const result = await services.retryContent(id);
  assert.deepEqual(result.retriedRequests, [{ operation: 'content.popular', params: { id, page: 1 } }]);
  assert.equal(services.canRetryContent(id), false);
});

test('per-source global search errors preserve the exact query and concurrent recovery is deduplicated', async () => {
  let solved = false, calls = 0;
  const services = createNativeServices({ async serviceRequest({ operation, params }) {
    assert.equal(operation, 'content.globalSearch');
    assert.deepEqual(params, { q: 'original query', limit: 5 });
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    return { groups: [id, 'data:OTHER'].map(sourceId => ({ sourceId, entries: solved ? [{ id: 'manga' }] : [], error: solved ? null : 'verification_required' })) };
  } });
  await services.request('content.globalSearch', { q: 'original query', limit: 5 });
  assert.equal(services.canRetryContent(id), true);
  assert.equal(services.canRetryContent('data:OTHER'), true);
  solved = true;
  await Promise.all([services.retryContent(id), services.retryContent('data:OTHER')]);
  assert.equal(calls, 2, 'Both source recoveries share the same original query request');
  assert.equal(services.canRetryContent(id), false);
  assert.equal(services.canRetryContent('data:OTHER'), false);
});

test('a verified search with no matches clears native and renderer recovery together', async () => {
  let solved = false;
  const flow = new SourceVerification(sourceId => ({ sourceId, baseUrl: 'https://example.org/', allowedOrigins: ['https://example.org'] }));
  const services = createNativeServices({ async serviceRequest({ operation, params }) {
    const checkpoint = flow.checkpoint();
    if (!solved) flow.required({ sourceId: id, url: 'https://example.org/search' });
    const result = { groups: [{ sourceId: id, entries: [], ...(solved ? {} : { error: 'verification_required' }) }] };
    flow.completed(operation, params, result, { checkpoint });
    return result;
  } });
  await services.request('content.globalSearch', { q: 'title with no matches', limit: 5 });
  assert(services.canRetryContent(id));
  assert.equal(flow.status().length, 1);
  flow.opened(id, 'https://example.org/search'); flow.closed(id);
  solved = true;
  await services.retryContent(id);
  assert.equal(services.canRetryContent(id), false);
  assert.equal(flow.status().length, 0, 'A fresh successful empty search must not leave an unretryable Verify prompt');
});

test('error DTOs stay recoverable and a proactive access check uses the native first page', async () => {
  let fail = true;
  const services = createNativeServices({ async serviceRequest({ operation, params }) {
    assert.equal(operation, 'content.popular');
    assert.deepEqual(params, { id, page: 1 });
    return fail ? { error: 'verification_required' } : { entries: [{ id: 'manga' }] };
  } });
  await assert.rejects(services.request('content.popular', { id, page: 1 }));
  assert.equal(services.canRetryContent(id), true);
  fail = false;
  assert.deepEqual(await services.checkSourceAccess(id), { entries: [{ id: 'manga' }] });
  assert.equal(services.canRetryContent(id), false);
});

test('recovered reads refresh only the matching screen, chapter or search query', () => {
  const navigated = [];
  let current;
  const router = { current: () => current, navigate: (...args) => navigated.push(args) };
  const pages = [{ operation: 'content.pages', params: { id, url: 'chapter/a' } }];
  current = { name: 'reader', params: { sid: id, url: 'title', chapterUrl: 'chapter/b', page: '8' } };
  recovery.reloadRecoveredSource(router, id, pages);
  assert.deepEqual(navigated, [], 'An old failed chapter must not reset current reading');
  current = { name: 'reader', params: { sid: id, url: 'title', chapterUrl: 'chapter/a', page: '8' } };
  recovery.reloadRecoveredSource(router, id, pages);
  assert.deepEqual(navigated, [['reader', { sid: id, url: 'title', chapterUrl: 'chapter/a', page: '8' }]]);
  navigated.length = 0;
  current = { name: 'search', params: { q: 'new query' } };
  const search = [{ operation: 'content.globalSearch', params: { q: 'old query', limit: 5 } }];
  recovery.reloadRecoveredSource(router, id, search);
  assert.deepEqual(navigated, []);
  current.params.q = 'old query';
  recovery.reloadRecoveredSource(router, id, search);
  assert.deepEqual(navigated, [['search', { q: 'old query' }]]);
  navigated.length = 0;
  current = { name: 'explore', params: { source: 'data:OTHER' } };
  recovery.reloadRecoveredSource(router, id, [{ operation: 'content.popular', params: { id, page: 1 } }]);
  assert.deepEqual(navigated, []);
});

test('automatic image recovery waits for issued media to settle and leaves other sources alone', async () => {
  const images = createImageRetries({ origin: () => 'http://127.0.0.1:31420' });
  const decoded = Promise.withResolvers();
  const url = 'http://127.0.0.1:31420/helper-image?sourceId=data%3AATSUMOE&u=https%3A%2F%2Fexample.org%2Fpage.jpg&cap=issued';
  images.failed(url, () => decoded.promise);
  images.failed(url.replace('ATSUMOE', 'OTHER'), () => assert.fail('Another source replayed'));
  let settled = false;
  const retry = images.retrySourceAndWait(id).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Checking must remain active until load/error completion');
  decoded.resolve(true);
  assert.equal(await retry, 1);
});

test('a screen can handle successful recovery in place without losing its search or pagination', () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const router = { current: () => ({ name: 'explore', params: { source: id } }), navigate: () => assert.fail('In-place recovery must not navigate') };
    let detail;
    window.addEventListener('nyora:source-content-recovered', event => { detail = event.detail; event.preventDefault(); });
    const requests = [{ operation: 'content.search', params: { id, q: 'keep query', page: 3 } }];
    recovery.reloadRecoveredSource(router, id, requests);
    assert.deepEqual(detail, { sourceId: id, requests });
  } finally { globalThis.window = previous; }
});
