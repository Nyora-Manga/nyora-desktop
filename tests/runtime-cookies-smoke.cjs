'use strict';
const { sameCertificate } = require('./runtime-certificates.cjs');
// Disposable offline native cookie durability acceptance; never imported by main.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const profile = process.env.NYORA_COOKIE_SMOKE_PROFILE;
const nonce = process.env.NYORA_COOKIE_SMOKE_NONCE;
const phase = process.env.NYORA_COOKIE_SMOKE_PHASE;
const resources = process.env.NYORA_COOKIE_SMOKE_RESOURCES || null;
assert.equal(app.isPackaged, false);
assert.ok(path.isAbsolute(profile || '') && /^[a-f0-9]{32}$/.test(nonce || ''));
assert.ok(['old-issue', 'old-read', 'issue', 'read-reset', 'reset-read'].includes(phase));
const root = resources ? path.join(resources, 'app.asar') : path.resolve(__dirname, '..');
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
assert.equal(appVersion, process.env.NYORA_COOKIE_SMOKE_VERSION);
assert.ok(fs.existsSync(path.join(root, 'dist/index.html')));
const { sourceKey } = require(path.join(root, 'electron/policy.cjs'));
const { BrowserContextTransport } = require(path.join(root, 'electron/browser-transport.cjs'));
// The historical negative control intentionally omits the new coordinator, not
// the native transport: it reproduces the old write-on-normal-quit behavior.
const { CookiePersistence } = phase.startsWith('old-') ? {} : require(path.join(root, 'electron/cookie-persistence.cjs'));
app.enableSandbox();
app.setPath('userData', profile);
fs.mkdirSync(path.join(profile, 'chromium'), { recursive: true });
app.setPath('sessionData', path.join(profile, 'chromium'));
app.on('window-all-closed', () => {});
const cert = fs.readFileSync(path.join(profile, 'cert.pem'), 'utf8');
const windows = [];
const sockets = new Set();
const sessions = new Map();
const savers = new Map();
let transport;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const server = https.createServer({ key: fs.readFileSync(path.join(profile, 'key.pem')), cert }, (request, response) => {
  if (request.url === '/verify') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><button id="verify" onclick="fetch(\'/solve\',{credentials:\'include\'}).then(()=>document.title=\'Solved\')">Verify</button>');
    return;
  }
  if (request.url === '/solve') {
    response.writeHead(200, { 'set-cookie': [
      'cf_clearance=persistent-fixture; Max-Age=600; Secure; HttpOnly; SameSite=None; Partitioned; Path=/',
      'cf_session_control=session-fixture; Secure; HttpOnly; SameSite=None; Partitioned; Path=/',
    ] });
    response.end('ok'); return;
  }
  const cookie = request.headers.cookie || '';
  const clearance = cookie.includes('cf_clearance=persistent-fixture');
  if (request.url === '/page.png' && clearance) {
    response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); return;
  }
  response.writeHead(clearance ? 200 : 403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ clearance, sessionCookie: cookie.includes('cf_session_control=session-fixture') }));
});
const proxy = http.createServer();
proxy.on('connect', (request, incoming, head) => {
  if (request.url !== 'example.org:443') { incoming.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const outgoing = net.connect(server.address().port, '127.0.0.1', () => {
    incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) outgoing.write(head);
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  for (const socket of [incoming, outgoing]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
  incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function sourceSession(sourceId) {
  if (!sessions.has(sourceId)) {
    const ses = session.fromPartition(`persist:source-${sourceKey(sourceId)}`, { cache: true });
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `https=127.0.0.1:${proxy.address().port}` });
    ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'example.org'
      && sameCertificate(request.certificate.data, cert) ? 0 : -2));
    sessions.set(sourceId, ses);
    if (CookiePersistence) savers.set(sourceId, new CookiePersistence(ses, sourceId === 'data:two' ? { debounceMs: 5000 } : {}));
  }
  return sessions.get(sourceId);
}
async function issue(sourceId) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: await sourceSession(sourceId), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  windows.push(window); await window.loadURL('https://example.org/verify');
  await window.webContents.executeJavaScript('document.getElementById("verify").click()');
  const deadline = Date.now() + 5000;
  while (await window.webContents.executeJavaScript('document.title') !== 'Solved') {
    assert.ok(Date.now() < deadline, 'Synthetic user verification must complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return window;
}
const options = { method: 'GET', headers: {}, credentials: 'include', redirect: 'manual' };
async function proof(sourceId) {
  const ses = await sourceSession(sourceId);
  // Read before upstream retry. No cookie values or CHIPS secrets enter evidence.
  const before = (await ses.cookies.get({ name: 'cf_clearance' })).map(cookie => ({
    name: cookie.name, persistent: !cookie.session, secure: cookie.secure,
    httpOnly: cookie.httpOnly, expires: cookie.expirationDate,
  }));
  const result = await (await transport.fetch(sourceId, 'https://example.org/content', options)).json();
  if (result.clearance) {
    const image = await transport.fetch(sourceId, 'https://example.org/page.png', options);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  }
  return { before, ...result };
}
function report(value) {
  process.stdout.write(`NYORA_COOKIE_RESULT ${JSON.stringify({ nonce, phase, appVersion, resources,
    sourcePartition: `persist:source-${sourceKey('data:one')}`, sessionData: app.getPath('sessionData'), ...value })}\n`);
}
async function cleanup() {
  await transport?.close();
  for (const saver of savers.values()) await saver.close();
  windows.forEach(window => { if (!window.isDestroyed()) window.destroy(); });
  for (const ses of sessions.values()) await ses.closeAllConnections();
  sockets.forEach(socket => socket.destroy()); server.close(); proxy.close();
}
app.whenReady().then(async () => {
  await listen(server); await listen(proxy);
  transport = new BrowserContextTransport({ sessionForSource: sourceSession });
  if (phase.endsWith('issue')) {
    const window = await issue('data:one');
    assert.equal((await proof('data:one')).clearance, true);
    assert.equal((await proof('data:two')).clearance, false);
    const receipts = {};
    if (phase === 'issue') {
      const saver = savers.get('data:one'); const deadline = Date.now() + 5000;
      while (saver.status().state !== 'saved') {
        assert.ok(Date.now() < deadline, 'Changed event must automatically flush persistent cookie');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      receipts.automatic = saver.status();
      assert.ok(receipts.automatic.persistentCookies >= 1);
      // Source one relies only on the automatic event flush. Source two has
      // a long test debounce, so its separate store relies on explicit Save.
      const second = await issue('data:two');
      assert.notEqual(savers.get('data:two').status().state, 'saved');
      receipts.explicit = await savers.get('data:two').save();
      assert.equal(receipts.explicit.state, 'saved');
      assert.ok(receipts.explicit.savedAt > 0 && receipts.explicit.persistentCookies >= 1 && receipts.explicit.sessionCookies >= 1);
      assert.ok(!JSON.stringify(receipts).includes('persistent-fixture'), 'Receipts must not expose cookie values');
      second.destroy();
    }
    window.destroy();
    report({ readyForCrash: true, receipts, verificationWindowClosed: true });
    // Outer launcher immediately force-kills this disposable process tree, before
    // normal-quit flush; coordinator.close is deliberately not called here.
    setInterval(() => {}, 1000); return;
  }
  const first = await proof('data:one'); const second = await proof('data:two');
  if (phase === 'old-read') {
    assert.equal(first.clearance, false, 'Old write-on-quit behavior loses the new cookie on immediate force quit');
    report({ passed: true, savingRequirementSatisfied: false, first, second });
  } else if (phase === 'read-reset') {
    assert.equal(first.clearance, true); assert.equal(second.clearance, true);
    assert.equal(first.before[0]?.persistent, true); assert.equal(first.before[0]?.httpOnly, true);
    assert.equal(first.sessionCookie, false, 'Session-only cookie must not be promoted to persistent');
    await transport.closeSource('data:one');
    await savers.get('data:one').reset(async () => {
      await sessions.get('data:one').clearStorageData({ storages: ['cookies'] });
      await sessions.get('data:one').cookies.flushStore();
    });
    assert.equal(savers.get('data:one').status().state, 'idle');
    report({ readyForCrash: true, passed: true, first, second, reset: true });
    setInterval(() => {}, 1000); return;
  } else {
    assert.equal(first.clearance, false); assert.equal(second.clearance, true);
    report({ passed: true, first, second, resetDurable: true });
  }
  await cleanup(); app.quit();
}).catch(async error => { console.error(error); await cleanup().catch(() => {}); app.exit(1); });
