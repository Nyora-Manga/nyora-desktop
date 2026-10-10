const test = require('node:test');
const assert = require('node:assert/strict');
const { SourceRelay, publicAddress } = require('./relay.cjs');

async function fixture(t, overrides = {}) {
  const calls = [];
  const challenges = [];
  const ses = {
    setProxy: async () => {},
    resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json', 'set-cookie': 'secret=never-return' } });
    },
  };
  const relay = new SourceRelay({
    catalogueLookup: async sourceId => sourceId === 'data:fixture' ? { sourceId, allowedOrigins: ['https://example.org'] } : undefined,
    sessionForSource: async () => ses,
    onChallenge: value => challenges.push(value),
    ...overrides,
  });
  const credentials = await relay.start();
  t.after(() => relay.stop());
  const post = (body, extra = {}) => fetch(`${credentials.baseUrl}/fetch`, {
    method: 'POST', headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  return { relay, credentials, post, ses, calls, challenges };
}
const request = { sourceId: 'data:fixture', url: 'https://example.org/search', method: 'GET', headers: { Accept: 'application/json' } };

test('private ephemeral relay authenticates every request and has no CORS', async t => {
  const { credentials } = await fixture(t);
  const denied = await fetch(`${credentials.baseUrl}/fetch`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${credentials.baseUrl}/fetch`, { method: 'OPTIONS' })).status, 401);
  assert.equal(credentials.token.length, 64);
});

test('route, HTTP method and canonical source authority are restricted', async t => {
  const { post, credentials } = await fixture(t);
  assert.equal((await fetch(`${credentials.baseUrl}/wrong`, { headers: { authorization: `Bearer ${credentials.token}` } })).status, 404);
  assert.equal((await post({ ...request, method: 'DELETE' })).status, 400);
  assert.equal((await post({ ...request, sourceId: 'data:unknown' })).status, 400);
  assert.equal((await post({ ...request, url: 'https://evil.example.com' })).status, 400);
  assert.equal((await post(request, { origin: 'nyora://app' })).status, 403);
});

test('same-session GET forwards only safe headers and excludes response credentials', async t => {
  const { post, calls } = await fixture(t);
  const response = await post({ ...request, headers: {
    Cookie: 'secret', Authorization: 'secret', Host: 'evil.example.com', 'User-Agent': 'spoof',
    Accept: 'application/json', 'Accept-Language': 'en', 'X-Api-Key': 'secret', Connection: 'close',
  } });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(Buffer.from(value.bodyBase64, 'base64').toString(), '{"items":[]}');
  assert.deepEqual(value.headers, { 'content-type': 'application/json' });
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json', 'accept-language': 'en' });
  assert.equal(calls[0].options.credentials, 'include');
});

test('POST is denied by default and needs an explicit trusted read-only engine policy', async t => {
  const denied = await fixture(t);
  const body = Buffer.from('{"query":"{search}"}').toString('base64');
  assert.equal((await denied.post({ ...request, method: 'POST', bodyBase64: body, bodyContentType: 'application/json' })).status, 400);
  const allowed = await fixture(t, { readOnlyPostPolicy: async value => value.url.endsWith('/search') && value.body.toString() === '{"query":"{search}"}' });
  assert.equal((await allowed.post({ ...request, method: 'POST', bodyBase64: body, bodyContentType: 'application/json' })).status, 200);
  assert.equal(allowed.calls[0].options.body.toString(), '{"query":"{search}"}');
});

test('protected content references are checked against catalogue authority', async t => {
  const { post, calls } = await fixture(t);
  assert.equal((await post({ ...request, headers: { Referer: 'https://example.org/title', Origin: 'https://example.org', 'X-Requested-With': 'XMLHttpRequest' } })).status, 200);
  assert.equal(calls[0].options.headers.referer, 'https://example.org/title');
  for (const headers of [{ Referer: 'https://evil.org/title' }, { Origin: 'https://example.org/path' }, { 'X-Requested-With': 'spoof' }]) {
    assert.equal((await post({ ...request, headers })).status, 400);
  }
  assert.equal(calls.length, 1);
});

test('private DNS addresses and untrusted redirects never reach their destination', async t => {
  const blocked = await fixture(t, { sessionForSource: async () => ({ resolveHost: async () => ({ endpoints: [{ address: '127.0.0.1' }] }), setProxy: async () => {}, fetch: async () => assert.fail('private fetch') }) });
  assert.equal((await blocked.post(request)).status, 400);
  const redirected = await fixture(t, { sessionForSource: async () => ({ resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }), setProxy: async () => {}, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }) }) });
  assert.equal((await redirected.post(request)).status, 400);
});

test('exact parsed CDN media on public 192.0 addresses reaches transport while reserved prefixes stay denied', async t => {
  let address = '192.0.77.2';
  const calls = [];
  const image = 'https://i1.wp.com/imagizer.imageshack.com/v2/xq70/922/VV8mWb.png';
  const { relay, post } = await fixture(t, { sessionForSource: async () => ({
    setProxy: async () => {}, resolveHost: async () => ({ endpoints: [{ address }] }),
    fetch: async (url) => { calls.push(url); return new Response(Buffer.from([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }); },
  }) });
  await relay.authorizeMedia('data:fixture', [image]);
  const value = { ...request, url: image, headers: { Referer: 'https://example.org/' } };
  for (address of ['192.0.77.2', '192.0.78.24', '::ffff:192.0.77.2', '::ffff:c000:4d02']) {
    const response = await post(value);
    assert.equal(response.status, 200, address);
    assert.equal((await response.json()).headers['content-type'], 'image/jpeg');
  }
  assert.equal(calls.length, 4);
  for (address of ['192.0.0.1', '192.0.0.255', '192.0.2.1', '192.0.2.255', '::ffff:192.0.0.1', '::ffff:c000:201', '192.168.1.1']) {
    const response = await post(value);
    assert.equal(response.status, 400, address);
    assert.equal((await response.json()).code, 'PRIVATE_NETWORK_DENIED');
  }
  assert.equal(calls.length, 4, 'reserved DNS results must not reach transport');
  address = '192.0.77.2';
  assert.equal((await post({ ...value, url: image.replace('VV8mWb', 'unparsed') })).status, 400, 'public DNS does not grant unrelated media URLs');
  assert.equal(calls.length, 4);
});

test('HTTP200 challenge body is preserved and signals pending content rather than solved', async t => {
  const body = '<!doctype html><title>Just a moment...</title><div id="cf-chl-test"></div>';
  const { post, challenges } = await fixture(t, { sessionForSource: async () => ({ resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }), setProxy: async () => {}, fetch: async () => new Response(body, { headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }) }) });
  const response = await (await post(request)).json();
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(response.bodyBase64, 'base64').toString(), body);
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].sourceId, 'data:fixture');
  assert.equal(challenges[0].phase, 'verification-required');
});

test('malformed base64 and request/response limits fail closed', async t => {
  const malformed = await fixture(t, { readOnlyPostPolicy: async () => true });
  assert.equal((await malformed.post({ ...request, method: 'POST', bodyBase64: '!bad', bodyContentType: 'text/plain' })).status, 400);
  const oversized = await fixture(t, { maxResponseBytes: 4 });
  assert.equal((await oversized.post(request)).status, 400);
});

test('address classification refuses loopback/private/link-local and IPv4 mapped IPv6', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.0.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('bounded concurrent and stalled transport work cannot exhaust the relay', async t => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const { post } = await fixture(t, { maxConcurrent: 1, timeoutMs: 20, sessionForSource: async () => ({
    resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }), setProxy: async () => {},
    fetch: async () => { begin(); return new Promise(() => {}); },
  }) });
  const pending = post(request);
  await started;
  assert.equal((await post(request)).status, 429);
  assert.equal((await pending).status, 504);
});

test('relay restart invalidates its previous per-launch credential', async t => {
  const { relay, credentials } = await fixture(t);
  await relay.stop();
  const restarted = await relay.start();
  assert.notEqual(restarted.token, credentials.token);
  assert.equal((await fetch(`${restarted.baseUrl}/fetch`, { method: 'POST', headers: { authorization: `Bearer ${credentials.token}` } })).status, 401);
});

test('source reset pauses new requests and drains native transport before clearing only that source', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const cookies = new Map([['data:fixture', 'old'], ['data:other', 'other']]);
  const calls = [];
  const { relay, post } = await fixture(t, {
    catalogueLookup: async sourceId => ({ sourceId, allowedOrigins: ['https://example.org'] }),
    sessionForSource: async sourceId => ({ setProxy: async () => {}, resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }),
      fetch: (url, options) => {
        calls.push(sourceId);
        if (sourceId === 'data:other') return Promise.resolve(new Response('other'));
        started();
        return new Promise(resolve => {
          options.signal.addEventListener('abort', () => {
            // Simulate native cancellation cleanup settling after the IPC abort.
            setTimeout(() => { cookies.set(sourceId, 'late'); resolve(new Response('cancelled')); }, 10);
          }, { once: true });
        });
      },
    }),
  });
  const inFlight = post(request);
  await began;
  let release;
  const clearing = new Promise(resolve => { release = resolve; });
  const reset = relay.withSourcePaused('data:fixture', async () => {
    assert.equal(cookies.get('data:fixture'), 'late', 'real fetch settled before clearing');
    cookies.delete('data:fixture');
    await clearing;
    return { reset: true };
  });
  assert.equal((await inFlight).status, 400);
  assert.equal((await post(request)).status, 400);
  assert.equal((await post({ ...request, sourceId: 'data:other' })).status, 200);
  release();
  assert.deepEqual(await reset, { reset: true });
  assert.equal(cookies.has('data:fixture'), false);
  assert.equal(cookies.get('data:other'), 'other');
  assert.deepEqual(calls, ['data:fixture', 'data:other']);
});

test('source pause fails reset safely when native cancellation does not settle and releases failed callback gates', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const { relay, post } = await fixture(t, { timeoutMs: 15, sessionForSource: async () => ({
    setProxy: async () => {}, resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }),
    fetch: () => { started(); return new Promise(() => {}); },
  }) });
  const inFlight = post(request);
  await began;
  await assert.rejects(relay.withSourcePaused('data:fixture', () => assert.fail('unsafe clear')), { code: 'SOURCE_TRANSPORT_BUSY' });
  assert.equal((await inFlight).status, 400);
  // A retired HTTP response does not hide an underlying unsettled fetch.
  await assert.rejects(relay.withSourcePaused('data:fixture', () => assert.fail('late unsafe clear')), { code: 'SOURCE_TRANSPORT_BUSY' });
  await assert.rejects(relay.withSourcePaused('data:other', () => { throw new Error('clear failed'); }), /clear failed/);
  assert.equal(await relay.withSourcePaused('data:other', () => 'gate released'), 'gate released');
});

test('main-only media grants authorize an exact GET URL for one known source without origin or POST expansion', async t => {
  const { relay, post, calls, credentials } = await fixture(t, { catalogueLookup: async sourceId => ['data:fixture', 'data:other'].includes(sourceId)
    ? { sourceId, allowedOrigins: ['https://example.org'] } : undefined });
  const media = 'https://cdn.other.org/chapters/one.jpg?token=parsed';
  await assert.rejects(relay.authorizeMedia('data:unknown', [media]), { code: 'UNKNOWN_SOURCE' });
  for (const url of ['http://cdn.other.org/one.jpg', 'https://localhost/one.jpg', 'https://127.0.0.1/one.jpg', `${media}#fragment`]) {
    await assert.rejects(relay.authorizeMedia('data:fixture', [url]), { code: 'INVALID_MEDIA_URL' });
  }
  assert.deepEqual(await relay.authorizeMedia('data:fixture', [media, media]), { authorized: 1 });
  assert.equal((await post({ ...request, url: media })).status, 200);
  assert.equal((await post({ ...request, url: 'https://cdn.other.org/chapters/two.jpg?token=parsed' })).status, 400);
  assert.equal((await post({ ...request, url: media.replace('parsed', 'different') })).status, 400);
  assert.equal((await post({ ...request, url: media, sourceId: 'data:unknown' })).status, 400);
  assert.equal((await post({ ...request, url: media, sourceId: 'data:other' })).status, 400);
  assert.equal((await post({ ...request, url: media, method: 'POST', bodyBase64: '', bodyContentType: 'text/plain' })).status, 400);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${credentials.baseUrl}/authorizeMedia`, { method: 'POST', headers: { authorization: `Bearer ${credentials.token}` } })).status, 404);
});

test('media grants enforce per-source/global LRU bounds and absolute expiry', async t => {
  let now = 100;
  const { relay, post } = await fixture(t, { now: () => now, mediaGrantTtlMs: 10, maxMediaGrantsPerSource: 2, maxMediaGrants: 3,
    catalogueLookup: async sourceId => ({ sourceId, allowedOrigins: ['https://example.org'] }) });
  const a = 'https://cdn.other.org/a.jpg'; const b = 'https://cdn.other.org/b.jpg'; const c = 'https://cdn.other.org/c.jpg';
  await assert.rejects(relay.authorizeMedia('data:fixture', [a, b, c]), { code: 'MEDIA_GRANT_LIMIT' });
  await relay.authorizeMedia('data:fixture', [a, b]);
  assert.equal((await post({ ...request, url: a })).status, 200); // a becomes most recently used.
  await relay.authorizeMedia('data:fixture', [c]);
  assert.equal((await post({ ...request, url: b })).status, 400);
  await relay.authorizeMedia('data:other', [a, b]);
  assert.equal((await post({ ...request, url: a })).status, 400); // global eviction, not a cross-source grant.
  assert.equal((await post({ ...request, url: c })).status, 200);
  now = 109;
  assert.equal((await post({ ...request, url: c })).status, 200);
  now = 110;
  assert.equal((await post({ ...request, url: c })).status, 400); // GET did not renew expiry.
  await relay.authorizeMedia('data:fixture', [c]);
  assert.equal((await post({ ...request, url: c })).status, 200);
});

test('every media redirect requires another exact grant or catalogue origin; private DNS is still blocked', async t => {
  const a = 'https://cdn.other.org/a.jpg'; const b = 'https://cdn.other.org/b.jpg';
  const calls = [];
  const { relay, post } = await fixture(t, { sessionForSource: async () => ({ setProxy: async () => {},
    resolveHost: async () => ({ endpoints: [{ address: '1.1.1.1' }] }),
    fetch: async url => { calls.push(url); return url === a ? new Response(null, { status: 302, headers: { location: b } }) : new Response('image'); },
  }) });
  await relay.authorizeMedia('data:fixture', [a]);
  assert.equal((await post({ ...request, url: a })).status, 400);
  assert.deepEqual(calls, [a]);
  await relay.authorizeMedia('data:fixture', [b]);
  assert.equal((await post({ ...request, url: a })).status, 200);
  assert.deepEqual(calls, [a, a, b]);
  const privateFixture = await fixture(t, { sessionForSource: async () => ({ setProxy: async () => {},
    resolveHost: async () => ({ endpoints: [{ address: '10.0.0.1' }] }), fetch: () => assert.fail('private image request') }) });
  await privateFixture.relay.authorizeMedia('data:fixture', [a]);
  assert.equal((await privateFixture.post({ ...request, url: a })).status, 400);
});

test('successful targeted reset clears that source media grants while another source remains authorized', async t => {
  const media = 'https://cdn.other.org/a.jpg';
  const { relay, post } = await fixture(t, { catalogueLookup: async sourceId => ({ sourceId, allowedOrigins: ['https://example.org'] }) });
  await relay.authorizeMedia('data:fixture', [media]);
  await relay.authorizeMedia('data:other', [media]);
  await relay.withSourcePaused('data:fixture', async () => {
    await assert.rejects(relay.authorizeMedia('data:fixture', [media]), { code: 'SOURCE_SESSION_PAUSED' });
    assert.equal((await post({ ...request, url: media })).status, 400);
  });
  assert.equal((await post({ ...request, url: media })).status, 400);
  assert.equal((await post({ ...request, url: media, sourceId: 'data:other' })).status, 200);
});

test('an enrollment awaiting catalogue lookup cannot repopulate grants after a completed reset', async t => {
  let release;
  const descriptor = new Promise(resolve => { release = resolve; });
  const { relay, post } = await fixture(t, { catalogueLookup: async sourceId => { await descriptor; return { sourceId, allowedOrigins: ['https://example.org'] }; } });
  const media = 'https://cdn.other.org/a.jpg';
  const enrollment = relay.authorizeMedia('data:fixture', [media]);
  await relay.withSourcePaused('data:fixture', async () => {});
  release();
  await assert.rejects(enrollment, { code: 'SOURCE_SESSION_RESET' });
  assert.equal((await post({ ...request, url: media })).status, 400);
});

test('exact media GET accepts helper same-target Referer without granting Origin or unrelated content headers', async t => {
  const { relay, post, calls } = await fixture(t, { readOnlyPostPolicy: async () => true });
  const media = 'https://cdn.other.org/chapter/one.jpg';
  await relay.authorizeMedia('data:fixture', [media]);
  const helperImage = { ...request, url: media, headers: { Referer: 'https://cdn.other.org/' } };
  assert.equal((await post(helperImage)).status, 200);
  assert.equal(calls[0].options.headers.referer, 'https://cdn.other.org/');
  assert.equal((await post({ ...helperImage, headers: { Referer: 'https://example.org/manga/title' } })).status, 200);
  assert.equal(calls[1].options.headers.referer, 'https://example.org/manga/title');
  assert.equal((await post({ ...helperImage, headers: { Referer: 'https://unrelated.org/' } })).status, 400);
  assert.equal((await post({ ...helperImage, headers: { Origin: 'https://cdn.other.org' } })).status, 400);
  assert.equal((await post({ ...helperImage, url: 'https://cdn.other.org/chapter/ungranted.jpg' })).status, 400);
  assert.equal((await post({ ...request, headers: { Referer: 'https://cdn.other.org/' } })).status, 400);
  assert.equal((await post({ ...request, method: 'POST', headers: { Referer: 'https://cdn.other.org/' },
    bodyBase64: '', bodyContentType: 'application/x-www-form-urlencoded' })).status, 400);
  assert.equal(calls.length, 2);
});
