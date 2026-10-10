'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NativeSyncBroker } = require('./sync.cjs');
const session = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', userId: 'user1', email: 'reader@example.com', lastSyncTimestamp: '1970-01-01T00:00:00Z' };
const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join('')), decryptString: bytes => [...bytes.toString()].reverse().join('') };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-cloud-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const helper = { start: async () => {}, request: async (route, request) => { calls.push({ route, request }); return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ session, ...options.response })) }; } };
  return { directory, calls, helper, broker: new NativeSyncBroker({ directory, encryption, helper, ...options }) };
}
test('account is encrypted, survives restart and never returns tokens across the bridge', async t => {
  const f = await fixture(t);
  const status = await f.broker.request('sync.signIn', { email: 'reader@example.com', password: 'private-password' });
  assert.equal(status.isAuthenticated, true); assert.equal(JSON.stringify(status).includes('private-'), false);
  const disk = await fs.readFile(path.join(f.directory, 'cloud-session.json'), 'utf8');
  for (const secret of ['private-access-token', 'private-refresh-token', 'private-password']) assert.equal(disk.includes(secret), false);
  const restarted = new NativeSyncBroker({ directory: f.directory, encryption, helper: f.helper });
  assert.deepEqual(await restarted.request('sync.status'), status);
  await restarted.request('sync.now');
  assert.equal(f.calls[1].request.json.session.accessToken, session.accessToken);
  assert.equal(f.calls[0].request.json.action, 'signIn'); assert.equal(f.calls[0].request.json.session, null);
  await restarted.request('sync.signOut');
  assert.equal((await restarted.request('sync.status')).isAuthenticated, false);
  assert.equal(f.calls.length, 2, 'Sign-out never mutates the library or calls the cloud');
});
test('rotated refresh token is durable even when a later merge fails', async t => {
  const f = await fixture(t, { response: { error: 'cloud unavailable after refresh' } });
  await assert.rejects(f.broker.request('sync.signIn', { email: 'reader@example.com', password: 'password' }), /cloud unavailable/);
  assert.equal((await f.broker.request('sync.status')).isAuthenticated, true);
});
test('does not send credentials if OS encryption is unavailable or operation invalid', async t => {
  const f = await fixture(t, { encryption: { isEncryptionAvailable: () => false } });
  await assert.rejects(f.broker.request('sync.signIn', { email: 'reader@example.com', password: 'password' }), /credential store/);
  await assert.rejects(f.broker.request('sync.now', { url: 'https://example.org' }), /Unexpected/);
  await assert.rejects(f.broker.request('sync.restore'), /Invalid/);
  assert.equal(f.calls.length, 0);
});
test('failed durable save is reported and cannot silently sign the user in', async t => {
  const f = await fixture(t, { publish: async () => { throw new Error('disk full'); } });
  await assert.rejects(f.broker.request('sync.signIn', { email: 'reader@example.com', password: 'password' }), /disk full/);
  assert.equal((await f.broker.request('sync.status')).isAuthenticated, false);
});
