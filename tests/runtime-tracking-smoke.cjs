'use strict';
const { app, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const profile = process.env.NYORA_TRACKING_SMOKE_PROFILE, nonce = process.env.NYORA_TRACKING_SMOKE_NONCE;
const phase = process.env.NYORA_TRACKING_SMOKE_PHASE;
assert.ok(!app.isPackaged && path.isAbsolute(profile || '') && /^[a-f0-9]{32}$/.test(nonce || '') && ['write', 'restart'].includes(phase));
const resources = process.env.NYORA_TRACKING_SMOKE_RESOURCES || null;
const root = resources ? path.join(resources, 'app.asar') : path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
assert.equal(version, process.env.NYORA_TRACKING_SMOKE_VERSION);
if (resources) assert.ok(fs.statSync(path.join(root, 'dist/index.html')).isFile());
const { TrackingBroker } = require(path.join(root, 'electron/tracking.cjs'));
const { NativeSyncBroker } = require(path.join(root, 'electron/sync.cjs'));
app.enableSandbox(); app.setName('Nyora Preview'); app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const syntheticToken = `disposable-native-tracker-fixture-${nonce}`;
let broker, sync;
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Actual OS encryption must be available');
  assert.notEqual(safeStorage.getSelectedStorageBackend?.(), 'basic_text', 'Plaintext storage cannot pass native acceptance');
  let viewer = 101, authenticated = 0;
  // No HTTP client is used: every provider operation is an injected fixture.
  const fetch = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${syntheticToken}`); authenticated++;
    const { query, variables } = JSON.parse(init.body);
    const data = query.includes('Viewer') ? { Viewer: { id: viewer, name: 'Disposable native fixture' } }
      : { Media: { id: variables.mediaId, mediaListEntry: { status: 'CURRENT', progress: 7, score: 50 } } };
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  };
  const directory = path.join(profile, 'device/tracking');
  broker = new TrackingBroker({ directory, encryption: safeStorage, fetch });
  const cloudSession = { accessToken: `cloud-access-${nonce}`, refreshToken: `cloud-refresh-${nonce}`, userId: 'disposable-cloud-user', email: 'fixture@example.org', lastSyncTimestamp: '1970-01-01T00:00:00Z' };
  let cloudRequests = 0;
  sync = new NativeSyncBroker({ directory, encryption: safeStorage, helper: {
    start: async () => {}, request: async (route, options) => {
      cloudRequests++; assert.equal(route, '/desktop/sync'); assert.equal(options.method, 'POST');
      if (phase === 'write') { assert.equal(options.json.action, 'signIn'); assert.equal(options.json.session, null); assert.equal(options.json.password, `cloud-password-${nonce}`); }
      else { assert.equal(options.json.action, 'now'); assert.deepEqual(options.json.session, cloudSession); }
      return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ session: cloudSession })) };
    },
  } });
  const checks = [];
  if (phase === 'write') {
    await broker.request('tracking.connect', { slug: 'anilist', token: syntheticToken });
    await broker.request('tracking.link', { slug: 'anilist', mangaId: 'disposable-native-title', mediaId: 123 });
    const account = (await broker.request('tracking.capabilities')).trackers[0];
    assert.equal(account.connected, true); assert.equal(account.links['disposable-native-title'], 123);
    const raw = fs.readFileSync(path.join(directory, 'tracking.json'), 'utf8');
    assert.ok(!raw.includes(syntheticToken));
    const stored = JSON.parse(raw);
    assert.equal(safeStorage.decryptString(Buffer.from(stored.account.encryptedToken, 'base64')), syntheticToken);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'tracking.json')).mode & 0o777, 0o600);
    checks.push('Actual OS encryption protects verified fixture credentials; explicit links are durably written without plaintext');
    const cloud = await sync.request('sync.signIn', { email: cloudSession.email, password: `cloud-password-${nonce}` });
    assert.equal(cloud.isAuthenticated, true); assert.ok(!JSON.stringify(cloud).includes(nonce));
    const cloudRaw = fs.readFileSync(path.join(directory, 'cloud-session.json'), 'utf8');
    assert.ok(!cloudRaw.includes(nonce)); assert.deepEqual(JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(cloudRaw).encrypted, 'base64'))), cloudSession);
    checks.push('Nyora Cloud stores only actual OS-encrypted synthetic credentials and returns metadata');
  } else {
    const account = (await broker.request('tracking.capabilities')).trackers[0];
    assert.equal(account.connected, true); assert.equal(account.enabled, true); assert.equal(account.user.id, 101);
    assert.equal(account.links['disposable-native-title'], 123);
    assert.deepEqual(await broker.request('tracking.getState', { slug: 'anilist', mediaId: 123 }), { linked: true, status: 'reading', progress: 7, score: 0.5 });
    assert.equal(authenticated, 1);
    checks.push('A separate native process decrypts the saved credential and reads the exact linked provider ID');
    viewer = 102;
    await broker.request('tracking.connect', { slug: 'anilist', token: syntheticToken });
    assert.deepEqual((await broker.request('tracking.capabilities')).trackers[0].links, {});
    await broker.request('tracking.disconnect', { slug: 'anilist' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'tracking.json'))).account, null);
    checks.push('Verified account switching clears old title links and disconnect durably removes its credential');
    assert.equal((await sync.request('sync.status')).isAuthenticated, true);
    await sync.request('sync.now'); assert.equal(cloudRequests, 1);
    await sync.request('sync.signOut'); assert.equal(fs.existsSync(path.join(directory, 'cloud-session.json')), false);
    assert.equal((await sync.request('sync.status')).isAuthenticated, false);
    checks.push('Cloud credentials survive a separate process, remain helper-private and are durably removed on sign-out');
  }
  await broker.close(); await sync.close();
  fs.writeFileSync(path.join(profile, `${phase}.json`), JSON.stringify({ passed: true, nonce, resources, appVersion: version, phase, platform: process.platform, arch: process.arch, productionTransport: 'TrackingBroker', checks }));
  app.exit(0);
}).catch(async error => { console.error(error); await broker?.close().catch(() => {}); await sync?.close().catch(() => {}); app.exit(1); });
