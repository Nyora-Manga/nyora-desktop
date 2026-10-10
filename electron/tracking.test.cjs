'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TrackingBroker } = require('./tracking.cjs');
const token = 'synthetic-token-never-use-with-real-provider';
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-tracking-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], responses = [];
  const encryption = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-key-store',
    encryptString: text => Buffer.from([...text].reverse().join('')), decryptString: bytes => [...bytes.toString()].reverse().join('') };
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next || { data: { Viewer: { id: 10, name: 'Fixture account' } } }), { headers: { 'content-type': 'application/json' }, ...(options.status ? { status: options.status } : {}) });
  };
  const broker = new TrackingBroker({ directory, encryption, fetch, ...options });
  t.after(() => broker.close());
  return { broker, directory, encryption, fetch, calls, responses, connect: () => broker.request('tracking.connect', { slug: 'anilist', token }) };
}

test('verified AniList connection is encrypted, metadata-only and durable with its explicit links', async t => {
  const f = await fixture(t); await f.connect();
  await f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'exact-native-title', mediaId: 123 });
  const state = await f.broker.request('tracking.capabilities');
  assert.equal(state.trackers[0].connected, true); assert.equal(state.trackers[0].enabled, true);
  assert.deepEqual(state.trackers[0].user, { id: 10, name: 'Fixture account' });
  assert.equal(state.trackers[0].links['exact-native-title'], 123);
  assert(!JSON.stringify(state).includes(token));
  const file = path.join(f.directory, 'tracking.json'), disk = await fs.readFile(file, 'utf8');
  assert(!disk.includes(token)); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const reopened = new TrackingBroker({ directory: f.directory, encryption: f.encryption, fetch: f.fetch });
  assert.deepEqual(await reopened.request('tracking.capabilities'), state); await reopened.close();
  assert.equal(f.calls[0].url, 'https://graphql.anilist.co'); assert.equal(f.calls[0].redirect, 'error');
});

test('invalid replacement token retains the acknowledged account, while verified account switching clears links', async t => {
  const f = await fixture(t); await f.connect();
  await f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'existing', mediaId: 123 });
  f.responses.push({ errors: [{ message: 'Invalid token' }] });
  await assert.rejects(f.broker.request('tracking.connect', { slug: 'anilist', token: 'replacement-synthetic-token' }));
  let state = (await f.broker.request('tracking.capabilities')).trackers[0];
  assert.equal(state.user.id, 10); assert.equal(state.connected, true); assert.equal(state.links.existing, 123);
  f.responses.push({ data: { Viewer: { id: 11, name: 'Different fixture account' } } });
  await f.broker.request('tracking.connect', { slug: 'anilist', token: 'valid-synthetic-replacement-token' });
  state = (await f.broker.request('tracking.capabilities')).trackers[0];
  assert.equal(state.user.id, 11); assert.deepEqual(state.links, {});
});

test('unsafe credential storage and unsupported providers cannot connect or make network requests', async t => {
  const f = await fixture(t, { encryption: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(f.connect(), /credential store/i);
  await assert.rejects(f.broker.request('tracking.connect', { slug: 'myanimelist', token }), /OAuth/i);
  assert.equal(f.calls.length, 0);
  const trackers = (await f.broker.request('tracking.capabilities')).trackers;
  assert(trackers.every(item => !item.connected && !item.available));
});

test('search uses variables and returns bounded trusted metadata; state maps AniList status and normalized score', async t => {
  const f = await fixture(t); await f.connect();
  const title = 'Fixture " } mutation { unsafe';
  f.responses.push({ data: { Page: { media: [{ id: 123, title: { userPreferred: 'Synthetic' }, coverImage: { medium: 'https://s4.anilist.co/file/fixture.png' }, siteUrl: 'https://anilist.co/manga/123' }] } } });
  assert.deepEqual(await f.broker.request('tracking.search', { slug: 'anilist', title }), { results: [{ id: 123, title: 'Synthetic', cover: 'https://s4.anilist.co/file/fixture.png', url: 'https://anilist.co/manga/123' }] });
  assert.equal(f.calls.at(-1).body.variables.title, title); assert(!f.calls.at(-1).body.query.includes(title));
  f.responses.push({ data: { Media: { id: 123, mediaListEntry: { status: 'REPEATING', progress: 8, score: 75 } } } });
  assert.deepEqual(await f.broker.request('tracking.getState', { slug: 'anilist', mediaId: 123 }), { linked: true, status: 'rereading', progress: 8, score: 0.75 });
});

test('state writes validate fields, require acknowledged provider mutation and never retry unknown commits', async t => {
  const f = await fixture(t); await f.connect(); const before = f.calls.length;
  for (const patch of [{ status: 'invented' }, { score: 1.1 }, { progress: -1 }, { progress: 1.5 }, { arbitrary: true }]) {
    await assert.rejects(f.broker.request('tracking.setState', { slug: 'anilist', mediaId: 123, ...patch }));
  }
  assert.equal(f.calls.length, before);
  f.responses.push({ data: { SaveMediaListEntry: { id: 42, mediaId: 123, status: 'CURRENT', progress: 5, score: 80 } } });
  assert.deepEqual(await f.broker.request('tracking.setState', { slug: 'anilist', mediaId: 123, status: 'reading', progress: 5, score: 0.8 }), { ok: true });
  assert.equal(f.calls.at(-1).body.variables.scoreRaw, 80); assert.equal(f.calls.at(-1).body.variables.status, 'CURRENT');
  f.responses.push(new Error('Network response lost'));
  const writes = f.calls.length;
  await assert.rejects(f.broker.request('tracking.setState', { slug: 'anilist', mediaId: 123, progress: 6 }));
  assert.equal(f.calls.length, writes + 1);
});

test('expired persisted credential disconnects without exporting token or accepting provider error text', async t => {
  const f = await fixture(t); await f.connect();
  f.responses.push({ errors: [{ message: `Invalid token ${token}` }] });
  await assert.rejects(f.broker.request('tracking.getState', { slug: 'anilist', mediaId: 123 }), error => {
    assert.equal(error.code, 'TRACKER_AUTH_REQUIRED'); assert(!error.message.includes(token)); return true;
  });
  assert.equal((await f.broker.request('tracking.capabilities')).trackers[0].connected, false);
  assert(!(await fs.readFile(path.join(f.directory, 'tracking.json'), 'utf8')).includes('encryptedToken'));
});

test('automatic scrobble requires an explicit enabled link and advances only acknowledged progress', async t => {
  const f = await fixture(t); await f.connect(); const before = f.calls.length;
  assert.equal((await f.broker.request('tracking.scrobble', { mangaId: 'unlinked', chapter: 5 })).skipped, true);
  assert.equal(f.calls.length, before);
  await f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'linked', mediaId: 123 });
  await f.broker.request('tracking.setEnabled', { slug: 'anilist', enabled: false });
  await f.broker.request('tracking.scrobble', { mangaId: 'linked', chapter: 5 }); assert.equal(f.calls.length, before);
  await f.broker.request('tracking.setEnabled', { slug: 'anilist', enabled: true });
  f.responses.push({ data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 4, score: 0 } } } }, { data: { SaveMediaListEntry: { id: 42, mediaId: 123, progress: 5 } } });
  const result = await f.broker.request('tracking.scrobble', { mangaId: 'linked', chapter: 5.9 });
  assert.deepEqual(result.updated, [{ slug: 'anilist', mediaId: 123 }]);
  assert.equal(f.calls.at(-1).body.variables.mediaId, 123); assert.equal(f.calls.at(-1).body.variables.progress, 5);
  const count = f.calls.length; await f.broker.request('tracking.scrobble', { mangaId: 'linked', chapter: 5 }); assert.equal(f.calls.length, count);
});

test('close drains accepted tracker operations and refuses new calls', async t => {
  const f = await fixture(t); await f.broker.close();
  await assert.rejects(f.broker.request('tracking.capabilities'), /closing/i);
});

test('same verified viewer preserves preferences; remote progress cannot be regressed by reader scrobbling', async t => {
  const f = await fixture(t); await f.connect();
  await f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'same', mediaId: 123 });
  await f.broker.request('tracking.setEnabled', { slug: 'anilist', enabled: false });
  await f.connect();
  let account = (await f.broker.request('tracking.capabilities')).trackers[0];
  assert.equal(account.links.same, 123); assert.equal(account.enabled, false);
  await f.broker.request('tracking.setEnabled', { slug: 'anilist', enabled: true });
  f.responses.push({ data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 10, score: 0 } } } });
  const before = f.calls.length;
  assert.equal((await f.broker.request('tracking.scrobble', { mangaId: 'same', chapter: 6 })).skipped, true);
  assert.equal(f.calls.length, before + 1); assert(!f.calls.at(-1).body.query.includes('mutation'));
});

test('failed scrobble does not dedupe a later retry and a mismatched acknowledgement is rejected', async t => {
  const f = await fixture(t); await f.connect();
  await f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'same', mediaId: 123 });
  const state = { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 1, score: 0 } } } };
  f.responses.push(state, new Error('Fixture response lost'));
  await assert.rejects(f.broker.request('tracking.scrobble', { mangaId: 'same', chapter: 2 }));
  const before = f.calls.length;
  f.responses.push(state, { data: { SaveMediaListEntry: { id: 42, mediaId: 999, progress: 2 } } });
  await assert.rejects(f.broker.request('tracking.scrobble', { mangaId: 'same', chapter: 2 }), { code: 'TRACKER_RESPONSE_INVALID' });
  assert.equal(f.calls.length, before + 2);
});

test('close waits for accepted in-flight verification rather than leaving a late credential commit', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetch: async () => { entered(); await new Promise(resolve => { release = resolve; }); return new Response(JSON.stringify({ data: { Viewer: { id: 10, name: 'Fixture' } } }), { headers: { 'content-type': 'application/json' } }); } });
  const connect = f.connect(); await started;
  let drained = false; const closing = f.broker.close().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  await assert.rejects(f.broker.request('tracking.capabilities'), { code: 'TRACKER_CLOSING' });
  release(); await connect; await closing; assert.equal(drained, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'tracking.json'), 'utf8')).account.user.id, 10);
});

test('stored vault is bounded and symlink/corrupt files cannot inject an account', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'tracking.json'), '{bad json');
  await assert.rejects(f.broker.request('tracking.capabilities'), { code: 'TRACKER_STORAGE_FAILED' });
  await fs.rm(path.join(f.directory, 'tracking.json'));
  await fs.writeFile(path.join(f.directory, 'other.json'), '{"version":1,"account":null}');
  await fs.symlink(path.join(f.directory, 'other.json'), path.join(f.directory, 'tracking.json'));
  await assert.rejects(f.broker.request('tracking.capabilities'), { code: 'TRACKER_STORAGE_FAILED' });
});

test('new links cannot publish a vault larger than the restart reader accepts', async t => {
  const f = await fixture(t);
  const account = { encryptedToken: f.encryption.encryptString(token).toString('base64'), user: { id: 10, name: 'Fixture' }, enabled: true, links: {} };
  const serialize = () => JSON.stringify({ version: 1, account });
  for (let i = 0; Buffer.byteLength(serialize()) < 523400; i++) account.links[`fixture-${i}-`.padEnd(1000, 'x')] = 123;
  const original = serialize(); assert.ok(Buffer.byteLength(original) <= 524288);
  await fs.writeFile(path.join(f.directory, 'tracking.json'), original);
  await assert.rejects(f.broker.request('tracking.link', { slug: 'anilist', mangaId: 'new-title-'.padEnd(1024, 'x'), mediaId: 123 }), { code: 'TRACKER_INPUT_INVALID' });
  assert.equal(await fs.readFile(path.join(f.directory, 'tracking.json'), 'utf8'), original);
});
