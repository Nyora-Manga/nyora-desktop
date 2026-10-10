const test = require('node:test');
const assert = require('node:assert/strict');
const { ChallengeCoordinator, isChallengeHtml } = require('./challenges.cjs');

const descriptor = { sourceId: 'data:fixture', allowedOrigins: ['https://example.org'] };
function fixture(responses, options = {}) {
  const calls = [];
  const opened = [];
  const coordinator = new ChallengeCoordinator({
    catalogueLookup: async id => id === descriptor.sourceId ? descriptor : undefined,
    sessionForSource: async id => ({ fetch: async (url, init) => {
      calls.push({ id, url, init });
      const next = responses.shift();
      if (typeof next === 'function') return next(init);
      return next;
    } }),
    validateContent: async ({ body, operation }) => operation === 'search' && JSON.parse(body.toString()).items instanceof Array,
    openVerification: async value => opened.push(value),
    ...options,
  });
  return { coordinator, calls, opened };
}
const request = { sourceId: 'data:fixture', operation: 'search', url: 'https://example.org/search' };
const json = () => new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
const challenge = () => new Response('<!doctype html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>', { status: 200, headers: { 'content-type': 'text/html' } });

test('HTTP200 challenge HTML remains blocked until original content validates in the same session', async () => {
  const { coordinator, calls, opened } = fixture([challenge(), json()]);
  assert.equal((await coordinator.request(request)).phase, 'verification-required');
  assert.equal(coordinator.status(request.sourceId).phase, 'verification-required');
  assert.equal((await coordinator.verify(request.sourceId)).phase, 'verifying');
  assert.equal(opened.length, 1);
  assert.equal(coordinator.status(request.sourceId).phase, 'verifying');
  const content = await coordinator.retry(request.sourceId);
  assert.equal(content.phase, 'ready');
  assert.equal(content.body.toString(), '{"items":[]}');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.id === request.sourceId && call.init.credentials === 'include'));
});

test('a successful window open never establishes proof and repeated challenge stays pending', async () => {
  const { coordinator } = fixture([challenge(), challenge()]);
  await coordinator.request(request);
  await coordinator.verify(request.sourceId);
  assert.equal((await coordinator.retry(request.sourceId)).phase, 'verification-required');
});

test('catalogue identity and origin bind requests; renderer cannot choose an arbitrary site', async () => {
  const { coordinator, calls } = fixture([json()]);
  await assert.rejects(coordinator.request({ ...request, sourceId: 'data:unknown' }), /catalogue/);
  await assert.rejects(coordinator.request({ ...request, url: 'https://evil.example.com/search' }), /origin/);
  await assert.rejects(coordinator.request({ ...request, url: 'file:///tmp/secret' }), /HTTPS/);
  assert.equal(calls.length, 0);
});

test('redirects to origins outside the catalogue are denied before their fetch', async () => {
  const { coordinator, calls } = fixture([new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } })]);
  const outcome = await coordinator.request(request);
  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.code, 'UNTRUSTED_REDIRECT');
  assert.equal(calls.length, 1);
});

test('unvalidated successful responses cannot produce verification success', async () => {
  const { coordinator } = fixture([new Response('<html>login required</html>', { headers: { 'content-type': 'text/html' } })]);
  const outcome = await coordinator.request(request);
  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.code, 'INVALID_CONTENT');
});

test('identical in-flight requests deduplicate; source cancellation aborts transport', async () => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const { coordinator, calls } = fixture([init => new Promise((resolve, reject) => {
    begin();
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  })]);
  const first = coordinator.request(request);
  await started;
  const duplicate = coordinator.request(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  coordinator.cancel(request.sourceId);
  assert.equal((await first).phase, 'cancelled');
  assert.equal((await duplicate).phase, 'cancelled');
});

test('bounded retry attempts and response bytes prevent indefinite or oversized work', async () => {
  const { coordinator, calls } = fixture([challenge(), challenge(), challenge()], { maxAttempts: 2 });
  await coordinator.request(request);
  await coordinator.retry(request.sourceId);
  assert.equal((await coordinator.retry(request.sourceId)).code, 'ATTEMPT_LIMIT');
  assert.equal(calls.length, 2);
  const tooLarge = fixture([json()], { maxResponseBytes: 4 });
  assert.equal((await tooLarge.coordinator.request(request)).code, 'RESPONSE_TOO_LARGE');
});

test('ordinary pages and normal Cloudflare response headers are not challenge proof', () => {
  assert.equal(isChallengeHtml('<html>normal page</html>', 'text/html'), false);
  assert.equal(isChallengeHtml('{"items":[]}', 'application/json'), false);
  assert.equal(isChallengeHtml('<title>Just a moment...</title>/cdn-cgi/challenge-platform/', 'text/html'), true);
});

test('stalled parser proof obeys the same bounded transport timeout', async () => {
  const { coordinator } = fixture([json()], { timeoutMs: 10, validateContent: () => new Promise(() => {}) });
  assert.equal((await coordinator.request(request)).code, 'TRANSPORT_TIMEOUT');
});

test('concurrent user retries deduplicate after asynchronous catalogue lookup', async () => {
  let finish;
  const { coordinator, calls } = fixture([challenge(), () => new Promise(resolve => { finish = resolve; })]);
  await coordinator.request(request);
  const first = coordinator.retry(request.sourceId);
  const second = coordinator.retry(request.sourceId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  finish(json());
  assert.equal((await first).phase, 'ready');
  assert.equal((await second).phase, 'ready');
});

test('pending source limits cannot evict a live challenge', async () => {
  const { coordinator } = fixture([challenge()], {
    maxPending: 1,
    catalogueLookup: async sourceId => ({ sourceId, allowedOrigins: descriptor.allowedOrigins }),
  });
  await coordinator.request(request);
  await assert.rejects(coordinator.request({ ...request, sourceId: 'data:second' }), error => error.code === 'PENDING_LIMIT');
  assert.equal(coordinator.status(request.sourceId).phase, 'verification-required');
});
