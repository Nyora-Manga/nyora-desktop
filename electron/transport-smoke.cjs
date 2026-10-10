'use strict';
// Offline synthetic HTTPS transport test; never loaded by main.cjs.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { ChallengeCoordinator } = require('./challenges.cjs');
const { SourceRelay } = require('./relay.cjs');
const { compileCatalogue, createCatalogueLookup } = require('./catalogue.cjs');
if (app.isPackaged) throw new Error('Synthetic transport smoke is unavailable in packaged apps');
app.enableSandbox();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nyora-transport-smoke-'));
app.setPath('userData', profile);
const keyFile = path.join(profile, 'fixture.key');
const certFile = path.join(profile, 'fixture.crt');
const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=example.org']);
if (generated.status !== 0) throw new Error('OpenSSL is required for the synthetic HTTPS transport fixture');
const cert = fs.readFileSync(certFile, 'utf8');
const requests = [];
const windows = [];
const sockets = new Set();
let relay;
const server = https.createServer({ key: fs.readFileSync(keyFile), cert }, (request, response) => {
  requests.push({ cookie: request.headers.cookie });
  const valid = request.headers.cookie?.includes('nyora_proof=valid');
  response.writeHead(200, { 'content-type': valid ? 'application/json' : 'text/html' });
  response.end(valid ? '{"items":[{"id":"fixture"}]}' : '<!doctype html><title>Just a moment...</title><div id="cf-chl-fixture"></div>');
});
const proxy = http.createServer();
proxy.on('connect', (request, incoming, head) => {
  if (request.url !== 'example.org:443') { incoming.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const outgoing = net.connect(server.address().port, '127.0.0.1', () => {
    incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) outgoing.write(head);
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  sockets.add(incoming); sockets.add(outgoing);
  incoming.on('close', () => sockets.delete(incoming));
  outgoing.on('close', () => sockets.delete(outgoing));
  incoming.on('error', () => outgoing.destroy());
  outgoing.on('error', () => incoming.destroy());
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

app.whenReady().then(async () => {
  await listen(server);
  await listen(proxy);
  const contexts = new Map();
  async function sourceSession(sourceId) {
    if (!contexts.has(sourceId)) {
      const ses = session.fromPartition(`persist:transport-${sourceId.replace(':', '-')}`);
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `https=127.0.0.1:${proxy.address().port}` });
      // Trust only this temporary fixture certificate and its one synthetic host.
      ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'example.org' && request.certificate.data.trim() === cert.trim() ? 0 : -2));
      contexts.set(sourceId, ses);
    }
    return contexts.get(sourceId);
  }
  const coordinator = new ChallengeCoordinator({
    catalogueLookup: async sourceId => ({ sourceId, allowedOrigins: ['https://example.org'] }),
    sessionForSource: sourceSession,
    validateContent: async value => JSON.parse(value.body.toString()).items?.[0]?.id === 'fixture',
    openVerification: async ({ sourceId, url }) => {
      const window = new BrowserWindow({ show: false, webPreferences: {
        session: await sourceSession(sourceId), sandbox: true, contextIsolation: true, nodeIntegration: false,
      } });
      windows.push(window);
      await window.loadURL(url);
    },
  });
  const first = { sourceId: 'data:first', operation: 'search', url: 'https://example.org/search' };
  const second = { ...first, sourceId: 'data:second' };
  assert.equal((await coordinator.request(first)).phase, 'verification-required');
  await coordinator.verify(first.sourceId);
  await (await sourceSession(first.sourceId)).cookies.set({ url: first.url, name: 'nyora_proof', value: 'valid', secure: true, path: '/' });
  const result = await coordinator.retry(first.sourceId);
  assert.equal(result.phase, 'ready');
  assert.match(result.body.toString(), /fixture/);
  const beforeSecond = requests.length;
  assert.equal((await coordinator.request(second)).phase, 'verification-required');
  assert.ok(requests.some(request => request.cookie?.includes('nyora_proof=valid')));
  assert.ok(requests.slice(beforeSecond).every(request => !request.cookie?.includes('nyora_proof=valid')));
  // Exercise the production private relay, not a custom protocol or mocked fetch.
  // This test-only facade keeps the offline CONNECT proxy already configured
  // above; production SourceRelay still forces the real session to direct mode.
  const get = createCatalogueLookup(compileCatalogue({ sources: ['relay-one', 'relay-two'].map(id => ({ id, engine: 'madara', domain: 'example.org' })) }));
  const pending = [];
  const facades = new Map();
  relay = new SourceRelay({ catalogueLookup: get, onChallenge: value => pending.push(value),
    sessionForSource: async sourceId => {
      const ses = await sourceSession(sourceId);
      if (!facades.has(ses)) facades.set(ses, {
        setProxy: async options => assert.deepEqual(options, { mode: 'direct' }),
        resolveHost: ses.resolveHost.bind(ses), fetch: ses.fetch.bind(ses),
      });
      return facades.get(ses);
    },
  });
  const credentials = await relay.start();
  const relayRequest = async sourceId => {
    const response = await fetch(`${credentials.baseUrl}/fetch`, { method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId, url: 'https://example.org/search', method: 'GET', headers: { Cookie: 'spoof=never', Authorization: 'never' } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const challenged = await relayRequest('data:relay-one');
  assert.equal(challenged.status, 200);
  assert.match(Buffer.from(challenged.bodyBase64, 'base64').toString(), /cf-chl-fixture/);
  assert.equal(pending[0].phase, 'verification-required');
  const verification = new BrowserWindow({ show: false, webPreferences: { session: await sourceSession('data:relay-one'),
    sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(verification);
  await verification.loadURL('https://example.org/search');
  // Manual synthetic completion; opening a window alone cannot prove success.
  assert.match(Buffer.from((await relayRequest('data:relay-one')).bodyBase64, 'base64').toString(), /cf-chl-fixture/);
  await (await sourceSession('data:relay-one')).cookies.set({ url: 'https://example.org/', name: 'nyora_proof', value: 'valid', secure: true, path: '/' });
  const resumed = await relayRequest('data:relay-one');
  assert.equal(resumed.status, 200);
  assert.equal(JSON.parse(Buffer.from(resumed.bodyBase64, 'base64')).items[0].id, 'fixture');
  assert.deepEqual(Object.keys(resumed.headers), ['content-type']);
  const beforeIsolated = requests.length;
  assert.match(Buffer.from((await relayRequest('data:relay-two')).bodyBase64, 'base64').toString(), /cf-chl-fixture/);
  assert.ok(requests.slice(beforeIsolated).every(request => !request.cookie?.includes('nyora_proof=valid')));
  assert.ok(requests.every(request => !request.cookie?.includes('spoof=never')));
  await relay.stop();
  console.log('Passed actual Electron coordinator and production authenticated SourceRelay over HTTPS: HTTP200 challenge, explicit verification, same-session retry, stripped credentials and source cookie isolation');
  coordinator.shutdown();
  windows.forEach(window => window.destroy());
  for (const ses of contexts.values()) { await ses.closeAllConnections(); await ses.cookies.flushStore(); }
  sockets.forEach(socket => socket.destroy());
  proxy.close(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(0);
}).catch(async error => {
  console.error(error);
  await relay?.stop();
  windows.forEach(window => window.destroy());
  sockets.forEach(socket => socket.destroy());
  proxy.close(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(1);
});
