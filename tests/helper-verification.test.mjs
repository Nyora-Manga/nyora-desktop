import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceVerification } from '../electron/verification.cjs';

const descriptor = (sourceId) => ['data:first', 'data:second'].includes(sourceId)
  ? { sourceId, baseUrl: 'https://example.org/', allowedOrigins: ['https://example.org'] } : undefined;

test('verification binds the URL to a known source and never exposes request paths', () => {
  const flow = new SourceVerification(descriptor);
  assert.throws(() => flow.target('data:unknown'), /Unknown/);
  assert.throws(() => flow.target('data:first', 'https://unrelated.org'), /selected source/);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/private-title/chapter' });
  assert.deepEqual(flow.status(), [{ sourceId: 'data:first', origin: 'https://example.org', phase: 'verification-required', manual: false }]);
});

test('global search binds proof to the original query and individual failed source group', () => {
  const flow = new SourceVerification(descriptor);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/search' });
  flow.completed('content.globalSearch', { q: 'original' }, { groups: [{ sourceId: 'data:first', error: 'verification_required', entries: [] }] });
  flow.completed('content.globalSearch', { q: 'different' }, { groups: [{ sourceId: 'data:first', entries: [{ id: 'match' }] }] });
  flow.completed('content.globalSearch', { q: 'original' }, { groups: [{ sourceId: 'data:second', entries: [{ id: 'other' }] }] });
  assert.equal(flow.status().length, 1);
  flow.completed('content.globalSearch', { q: 'original' }, { groups: [{ sourceId: 'data:first', entries: [{ id: 'match' }] }] });
  assert.equal(flow.status().length, 0);
});

test('an authenticated relay media challenge admits only its exact dynamic target', () => {
  const flow = new SourceVerification(descriptor);
  const url = 'https://dynamic-cdn.org/protected/page.jpg';
  assert.throws(() => flow.target('data:first', url));
  flow.required({ sourceId: 'data:first', url }, { fromRelay: true });
  assert.equal(flow.target('data:first'), url);
  assert.equal(flow.target('data:first', url), url);
  assert.throws(() => flow.target('data:first', 'https://dynamic-cdn.org/unrelated'));
  assert.throws(() => flow.target('data:second', url));
});

test('protected images retain their own proof requirement after a content retry', () => {
  const flow = new SourceVerification(descriptor);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/page.jpg' });
  const imageRoute = 'nyora://app/helper-image?sourceId=data%3Afirst&u=https%3A%2F%2Fexample.org%2Fpage.jpg';
  flow.imageResult(imageRoute, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const params = { id: 'data:first', url: 'https://example.org/chapter' };
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.pages', params, { pages: [{ url: 'https://example.org/page.jpg' }] });
  assert.equal(flow.status().length, 1);
  flow.imageResult(imageRoute);
  assert.equal(flow.status().length, 0);
});

test('partial recovery does not turn an ordinary image retry into another verification challenge', () => {
  const flow = new SourceVerification(descriptor);
  const sourceId = 'data:first', imageUrl = 'https://example.org/page.jpg';
  const imageRoute = `http://127.0.0.1/helper-image?sourceId=${sourceId}&u=${encodeURIComponent(imageUrl)}`;
  const params = { id: sourceId, url: 'chapter' };
  flow.required({ sourceId, url: imageUrl });
  flow.imageResult(imageRoute, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.required({ sourceId, url: 'https://example.org/chapter' });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.opened(sourceId); flow.closed(sourceId);
  flow.completed('content.pages', params, { pages: [imageUrl] }, { checkpoint: flow.checkpoint() });
  flow.imageResult(imageRoute, { code: 'HELPER_HTTP_502' }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status()[0].phase, 'retry-required', 'A successful partial retry is not a fresh CF failure');
  assert.equal(flow.target(sourceId), imageUrl);
  flow.required({ sourceId, url: imageUrl });
  flow.imageResult(imageRoute, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.status()[0].phase, 'verification-required', 'An actual new challenge still asks for verification');
});

test('closing a verification window requires a parsed retry, independent of other sources', () => {
  const flow = new SourceVerification(descriptor);
  for (const id of ['data:first', 'data:second']) flow.opened(id, 'https://example.org/');
  flow.closed('data:first');
  const params = { id: 'data:first', url: 'https://example.org/chapter' };
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.status()[0].phase, 'retry-required');
  flow.completed('library.historyRecord', { id: 'data:first' }, { ok: true });
  flow.completed('content.pages', { id: 'data:first' }, { error: 'challenge' });
  assert.equal(flow.status().length, 2);
  flow.completed('content.popular', { id: 'data:first' }, { entries: [{ id: 'home-result' }] });
  flow.completed('content.pages', { id: 'data:first', url: 'https://example.org/different' }, { pages: [{ url: 'https://example.org/image.jpg' }] });
  flow.completed('content.pages', params, { pages: [] });
  assert.equal(flow.status().length, 2);
  flow.completed('content.pages', params, { pages: [{ url: 'https://example.org/image.jpg' }] });
  assert.deepEqual(flow.status().map((item) => item.sourceId), ['data:second']);
});

test('a proactive source check clears only after closing and a usable read for that source', () => {
  const flow = new SourceVerification(descriptor);
  flow.opened('data:first', 'https://example.org/');
  flow.completed('content.popular', { id: 'data:first' }, { entries: [{ id: 'item' }] });
  assert.equal(flow.status()[0].phase, 'verification-opened');
  flow.closed('data:first');
  flow.completed('content.popular', { id: 'data:second' }, { entries: [{ id: 'other' }] });
  flow.completed('content.popular', { id: 'data:first' }, { entries: [] });
  flow.completed('content.popular', { id: 'data:first' }, { entries: [null, {}] });
  flow.completed('library.favouriteToggle', { id: 'data:first' }, { ok: true });
  flow.completed('content.globalSearch', { q: 'unrelated' }, { groups: [{ sourceId: 'data:first', entries: [{ id: 'match' }] }] });
  assert.equal(flow.status()[0].phase, 'retry-required');
  flow.opened('data:first', 'https://example.org/');
  flow.closed('data:first');
  flow.completed('content.popular', { id: 'data:first' }, { entries: [{ id: 'item' }] });
  assert.equal(flow.status().length, 0);
});

test('a real challenge supersedes proactive verification and string pages satisfy its exact retry', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', url: 'opaque/chapter' };
  flow.opened('data:first', 'https://example.org/');
  flow.required({ sourceId: 'data:first', url: 'https://example.org/chapter' }, { fromRelay: true });
  flow.closed('data:first');
  flow.completed('content.popular', { id: 'data:first' }, { entries: [{ id: 'unrelated' }] });
  assert.equal(flow.status().length, 1, 'Relay challenge cannot become a manual-only check');
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.opened('data:first', 'https://example.org/chapter');
  flow.closed('data:first');
  flow.completed('content.pages', { ...params, url: 'different/chapter' }, { pages: ['https://example.org/page.jpg'] });
  flow.completed('content.pages', params, { pages: [null, '', {}] });
  assert.equal(flow.status().length, 1);
  flow.completed('content.pages', params, { pages: ['https://example.org/page.jpg'] });
  assert.equal(flow.status().length, 0);
});

test('verification lifecycle IDs distinguish user reopen from repeated close and later relay failures', () => {
  const flow = new SourceVerification(descriptor);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/read' });
  assert.equal(flow.status()[0].manual, false);
  assert.equal(flow.status()[0].verificationId, undefined);
  flow.opened('data:first', 'https://example.org/read');
  const first = flow.status()[0].verificationId;
  assert.match(first, /^[a-f0-9-]{36}$/);
  flow.closed('data:first'); flow.closed('data:first');
  assert.equal(flow.status()[0].verificationId, first);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/read' }, { fromRelay: true });
  flow.failed('content.pages', { id: 'data:first', url: 'chapter' }, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.status()[0].verificationId, first, 'Retry challenge cannot create another automatic retry cycle');
  flow.opened('data:first', 'https://example.org/read');
  assert.notEqual(flow.status()[0].verificationId, first);
  assert.equal(flow.status()[0].manual, false);
});

test('proactive lifecycle metadata remains manual until an actual request or image challenge', () => {
  const flow = new SourceVerification(descriptor);
  flow.opened('data:first', 'https://example.org/');
  assert.equal(flow.status()[0].manual, true);
  const id = flow.status()[0].verificationId;
  flow.closed('data:first');
  assert.equal(flow.status()[0].manual, true);
  flow.required({ sourceId: 'data:first', url: 'https://example.org/page.jpg' }, { fromRelay: true });
  const route = 'http://127.0.0.1/helper-image?sourceId=data:first&u=https%3A%2F%2Fexample.org%2Fpage.jpg';
  flow.imageResult(route, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.status()[0].manual, false);
  assert.equal(flow.status()[0].verificationId, id);
});

test('multiple failed reads preserve exact remaining proof targets', () => {
  const flow = new SourceVerification(descriptor);
  const first = { id: 'data:first', url: 'first/chapter' }, second = { id: 'data:first', url: 'second/chapter' };
  flow.required({ sourceId: 'data:first', url: 'https://example.org/first' });
  flow.failed('content.pages', first, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.required({ sourceId: 'data:first', url: 'https://example.org/second' });
  flow.failed('content.pages', second, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.opened('data:first', 'https://example.org/second'); flow.closed('data:first');
  const cycle = flow.status()[0].verificationId;
  flow.completed('content.pages', second, { pages: ['https://example.org/page.jpg'] });
  assert.equal(flow.status().length, 1);
  assert.equal(flow.status()[0].verificationId, cycle);
  assert.equal(flow.target('data:first'), 'https://example.org/first');
  flow.completed('content.pages', first, { pages: ['https://example.org/page.jpg'] });
  assert.equal(flow.status().length, 0);
});

test('local filter metadata cannot prove upstream access after proactive verification', () => {
  const flow = new SourceVerification(descriptor);
  flow.opened('data:first', 'https://example.org/'); flow.closed('data:first');
  flow.completed('sources.filters', { id: 'data:first' }, { filters: [{ name: 'Genre', typeName: 'Select', values: ['Action'] }] });
  assert.equal(flow.status()[0].phase, 'retry-required');
  flow.completed('content.popular', { id: 'data:first', page: 1 }, { entries: [{ id: 'fresh-result' }] });
  assert.equal(flow.status().length, 0);
});

test('a delayed cached read cannot clear a newer challenge for the same request', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', page: 1 };
  const oldDispatch = flow.checkpoint?.() || Object.freeze({});
  flow.required({ sourceId: params.id, url: 'https://example.org/' }, { fromRelay: true });
  flow.failed('content.popular', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.popular', params, { entries: [{ id: 'old-cached-result' }] }, { checkpoint: oldDispatch });
  assert.equal(flow.status().length, 1, 'The newer challenge must survive a response dispatched before it');
  const retryDispatch = flow.checkpoint();
  flow.completed('content.popular', params, { entries: [{ id: 'fresh-result' }] }, { checkpoint: retryDispatch });
  assert.equal(flow.status().length, 0);
});

test('an older verification generation cannot clear a replacement pending challenge', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', url: 'chapter' };
  flow.required({ sourceId: params.id, url: 'https://example.org/first' });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const checkpoint = flow.checkpoint?.() || Object.freeze({});
  flow.required({ sourceId: params.id, url: 'https://example.org/newer' }, { fromRelay: true });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.pages', params, { pages: ['https://example.org/page.jpg'] }, { checkpoint });
  assert.equal(flow.target(params.id), 'https://example.org/newer');
  assert.equal(flow.status().length, 1);
});

test('global search checkpoints preserve newer source failures but still bind failed groups', () => {
  const flow = new SourceVerification(descriptor);
  const params = { q: 'original', limit: 5 };
  flow.required({ sourceId: 'data:first', url: 'https://example.org/first' });
  flow.completed('content.globalSearch', params, { groups: [{ sourceId: 'data:first', error: 'verification_required' }] });
  const checkpoint = flow.checkpoint?.() || Object.freeze({});
  flow.required({ sourceId: 'data:second', url: 'https://example.org/second' }, { fromRelay: true });
  flow.completed('content.globalSearch', params, { groups: [
    { sourceId: 'data:first', entries: [{ id: 'current' }] },
    { sourceId: 'data:second', error: 'verification_required' },
  ] }, { checkpoint });
  flow.completed('content.globalSearch', params, { groups: [{ sourceId: 'data:second', entries: [{ id: 'old' }] }] }, { checkpoint });
  assert.deepEqual(flow.status().map(entry => entry.sourceId), ['data:second']);
  flow.completed('content.globalSearch', params, { groups: [{ sourceId: 'data:second', entries: [{ id: 'new' }] }] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0, 'The failed group was bound despite an older dispatch checkpoint');
});

test('a read dispatched while the proactive website is open cannot become post-close proof', () => {
  const flow = new SourceVerification(descriptor);
  flow.opened('data:first', 'https://example.org/');
  const checkpoint = flow.checkpoint?.() || Object.freeze({});
  flow.closed('data:first');
  flow.completed('content.popular', { id: 'data:first', page: 1 }, { entries: [{ id: 'before-close' }] }, { checkpoint });
  assert.equal(flow.status()[0]?.phase, 'retry-required');
  flow.completed('content.popular', { id: 'data:first', page: 1 }, { entries: [{ id: 'after-close' }] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0);
});

test('a delayed image success cannot clear a newer challenge for the same exact media URL', () => {
  const flow = new SourceVerification(descriptor);
  const route = 'http://127.0.0.1/helper-image?sourceId=data:first&u=https%3A%2F%2Fexample.org%2Fpage.jpg';
  const checkpoint = flow.checkpoint?.() || Object.freeze({});
  flow.required({ sourceId: 'data:first', url: 'https://example.org/page.jpg' }, { fromRelay: true });
  flow.imageResult(route, { code: 'SOURCE_VERIFICATION_REQUIRED' }, { checkpoint });
  flow.imageResult(route, undefined, { checkpoint });
  assert.equal(flow.status().length, 1, 'New media failure survives an older successful response');
  flow.imageResult(route, undefined, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0, 'Current image success still supplies its exact proof');
});

test('a different chapter failure cannot invalidate an exact successful retry already in flight', () => {
  const flow = new SourceVerification(descriptor);
  const first = { id: 'data:first', url: 'chapter/A' }, second = { id: 'data:first', url: 'chapter/B' };
  for (const params of [first, second]) {
    flow.required({ sourceId: params.id, url: `https://example.org/${params.url}` }, { fromRelay: true });
    flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  }
  flow.opened(first.id); flow.closed(first.id);
  const firstDispatch = flow.checkpoint();
  flow.required({ sourceId: second.id, url: 'https://example.org/chapter/B' }, { fromRelay: true });
  flow.failed('content.pages', second, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.pages', first, { pages: ['https://example.org/A.jpg'] }, { checkpoint: firstDispatch });
  assert.equal(flow.target(first.id), 'https://example.org/chapter/B', 'Only the renewed B failure remains');
  flow.completed('content.pages', second, { pages: ['https://example.org/B.jpg'] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0, 'Both exact successful retries retire their own failures');
});

test('independent image failures preserve each other\'s dispatched proof and exact URL binding', () => {
  const flow = new SourceVerification(descriptor);
  const route = target => `http://127.0.0.1/helper-image?sourceId=data:first&u=${encodeURIComponent(target)}`;
  const first = 'https://cdn.example.org/A.jpg', second = 'https://cdn.example.org/B.jpg';
  for (const target of [first, second]) {
    flow.required({ sourceId: 'data:first', url: target }, { fromRelay: true });
    flow.imageResult(route(target), { code: 'SOURCE_VERIFICATION_REQUIRED' });
  }
  flow.opened('data:first'); flow.closed('data:first');
  const firstDispatch = flow.checkpoint();
  flow.required({ sourceId: 'data:first', url: second }, { fromRelay: true });
  flow.imageResult(route(second), { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.imageResult(route(first), undefined, { checkpoint: firstDispatch });
  flow.imageResult(route('https://cdn.example.org/unrelated.jpg'), undefined, { checkpoint: flow.checkpoint() });
  assert.equal(flow.target('data:first'), second);
  flow.imageResult(route(second), undefined, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0);
});

test('a redirected newer challenge cannot be cleared before its helper failure binds the same request', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', url: 'chapter' };
  flow.required({ sourceId: params.id, url: 'https://example.org/first' }, { fromRelay: true });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const oldDispatch = flow.checkpoint();
  flow.required({ sourceId: params.id, url: 'https://example.org/redirected' }, { fromRelay: true });
  flow.completed('content.pages', params, { pages: ['https://example.org/old.jpg'] }, { checkpoint: oldDispatch });
  assert.equal(flow.status().length, 1, 'Relay-to-helper gap must retain the newer challenge');
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.target(params.id), 'https://example.org/redirected');
  assert.equal(flow.status().length, 1, 'Binding the same request cannot replay its older successful proof');
});

test('an independent retry finishing in a single relay-to-helper gap is retained until binding', () => {
  const flow = new SourceVerification(descriptor);
  const first = { id: 'data:first', url: 'chapter/A' }, second = { id: 'data:first', url: 'chapter/B' };
  flow.required({ sourceId: first.id, url: 'https://example.org/chapter/A' }, { fromRelay: true });
  flow.failed('content.pages', first, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const checkpoint = flow.checkpoint();
  flow.required({ sourceId: second.id, url: 'https://example.org/chapter/B' }, { fromRelay: true });
  flow.completed('content.pages', first, { pages: ['https://example.org/A.jpg'] }, { checkpoint });
  assert.equal(flow.status().length, 1);
  flow.failed('content.pages', second, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.pages', second, { pages: ['https://example.org/B.jpg'] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0, 'A\'s validated proof must survive the unrelated binding gap');
});

test('multiple unresolved challenges do not release old proof after only one helper failure binds', () => {
  const flow = new SourceVerification(descriptor);
  const first = { id: 'data:first', url: 'chapter/A' }, second = { id: 'data:first', url: 'chapter/B' };
  flow.required({ sourceId: first.id, url: 'https://example.org/chapter/A' }, { fromRelay: true });
  flow.failed('content.pages', first, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const checkpoint = flow.checkpoint();
  flow.required({ sourceId: first.id, url: 'https://example.org/chapter/B' }, { fromRelay: true });
  flow.required({ sourceId: first.id, url: 'https://example.org/redirected-A' }, { fromRelay: true });
  flow.completed('content.pages', first, { pages: ['https://example.org/old-A.jpg'] }, { checkpoint });
  flow.failed('content.pages', second, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.pages', second, { pages: ['https://example.org/B.jpg'] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 1, 'Uncorrelated overlapping relay failures must not release A\'s old proof');
});

test('only a current checkpoint for the exact failed search admits a well-formed zero-match result', () => {
  for (const operation of ['content.search', 'content.globalSearch']) {
    const flow = new SourceVerification(descriptor);
    const params = operation === 'content.search' ? { id: 'data:first', q: 'no matches', page: 1 } : { q: 'no matches' };
    const empty = operation === 'content.search' ? { entries: [] } : { groups: [{ sourceId: 'data:first', entries: [] }] };
    flow.required({ sourceId: 'data:first', url: 'https://example.org/search' }, { fromRelay: true });
    if (operation === 'content.search') flow.failed(operation, params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
    else flow.completed(operation, params, { groups: [{ sourceId: 'data:first', error: 'verification_required' }] });
    flow.opened('data:first'); flow.closed('data:first');
    const checkpoint = flow.checkpoint();
    flow.completed(operation, { ...params, q: 'different' }, empty, { checkpoint });
    flow.completed(operation, params, empty);
    flow.completed(operation, params, empty, { checkpoint: Object.freeze({}) });
    const malformed = operation === 'content.search' ? { entries: [null, {}] } : { groups: [{ sourceId: 'data:first', entries: [null, {}] }] };
    flow.completed(operation, params, malformed, { checkpoint });
    assert.equal(flow.status().length, 1, `${operation} must retain unbound, malformed, and untrusted empty responses`);
    flow.completed(operation, params, empty, { checkpoint });
    assert.equal(flow.status().length, 0, `${operation} exact fresh zero-match result completes its retry`);
  }
});

test('closing with an unbound redirected challenge rejects pre-close proof and duplicate close preserves a fresh retry', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', url: 'chapter/A' };
  flow.required({ sourceId: params.id, url: 'https://example.org/chapter/A' }, { fromRelay: true });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.opened(params.id);
  const beforeClose = flow.checkpoint();
  flow.required({ sourceId: params.id, url: 'https://example.org/redirected-A' }, { fromRelay: true });
  flow.closed(params.id);
  flow.completed('content.pages', params, { pages: ['https://example.org/old-A.jpg'] }, { checkpoint: beforeClose });
  assert.equal(flow.status().length, 1, 'Closing cannot release an older in-flight result across the binding gap');
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const fresh = flow.checkpoint();
  flow.closed(params.id);
  flow.completed('content.pages', params, { pages: ['https://example.org/fresh-A.jpg'] }, { checkpoint: fresh });
  assert.equal(flow.status().length, 0, 'A duplicate close cannot invalidate the post-close retry');
});

test('a duplicate close cannot discard a later unbound relay failure', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', url: 'chapter/A' };
  flow.required({ sourceId: params.id, url: 'https://example.org/chapter/A' }, { fromRelay: true });
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.opened(params.id); flow.closed(params.id);
  const checkpoint = flow.checkpoint();
  flow.required({ sourceId: params.id, url: 'https://example.org/redirected-A' }, { fromRelay: true });
  flow.closed(params.id);
  flow.completed('content.pages', params, { pages: ['https://example.org/old-A.jpg'] }, { checkpoint });
  assert.equal(flow.status().length, 1);
  flow.failed('content.pages', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  assert.equal(flow.status().length, 1, 'The deferred old result cannot survive the same-key newer failure');
});

test('different exact searches sharing one network endpoint retain independent current proof', () => {
  const flow = new SourceVerification(descriptor);
  const first = { id: 'data:first', q: 'first', page: 1 }, second = { id: 'data:first', q: 'second', page: 1 };
  for (const params of [first, second]) {
    flow.required({ sourceId: params.id, url: 'https://example.org/search' }, { fromRelay: true });
    flow.failed('content.search', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  }
  const checkpoint = flow.checkpoint();
  flow.required({ sourceId: second.id, url: 'https://example.org/search' }, { fromRelay: true });
  flow.failed('content.search', second, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.search', first, { entries: [] }, { checkpoint });
  flow.completed('content.search', second, { entries: [] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0, 'URL equality cannot invalidate a different bound query');
});

test('empty results cannot discharge a renewed search failure or an error response', () => {
  const flow = new SourceVerification(descriptor);
  const params = { id: 'data:first', q: 'no matches', page: 1 };
  flow.required({ sourceId: params.id, url: 'https://example.org/search' }, { fromRelay: true });
  flow.failed('content.search', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  const old = flow.checkpoint();
  flow.required({ sourceId: params.id, url: 'https://example.org/search/redirected' }, { fromRelay: true });
  flow.completed('content.search', params, { entries: [] }, { checkpoint: old });
  flow.failed('content.search', params, { code: 'SOURCE_VERIFICATION_REQUIRED' });
  flow.completed('content.search', params, { entries: [] }, { checkpoint: old });
  flow.completed('content.search', params, { entries: [], error: 'verification_required' }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 1);
  flow.completed('content.search', params, { entries: [] }, { checkpoint: flow.checkpoint() });
  assert.equal(flow.status().length, 0);
});
