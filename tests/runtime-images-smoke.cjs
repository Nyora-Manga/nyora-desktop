'use strict';
const { sameCertificate } = require('./runtime-certificates.cjs');
// Actual native helper -> authenticated production relay -> Chromium HTTPS ->
// signed local HTTP -> renderer image decode. Only offline synthetic Atsu JSON
// and PNG are served; no source account, user profile or public network is used.
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
assert.equal(app.isPackaged, false, 'Fixture transport must never run inside release applications');
const project = path.resolve(__dirname, '..');
const assembledResources = process.env.NYORA_IMAGE_SMOKE_RESOURCES || null;
if (assembledResources) assert.ok(path.isAbsolute(assembledResources) && fs.statSync(assembledResources).isDirectory(), 'Validated assembled Resources directory required');
const moduleRoot = assembledResources ? path.join(assembledResources, 'app.asar') : project;
const resources = path.join(assembledResources || path.join(project, 'resources'), 'helper');
const appPackage = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8'));
assert.equal(appPackage.version, process.env.NYORA_IMAGE_SMOKE_VERSION, 'Selected app package must match launcher version');
assert.ok(fs.statSync(path.join(moduleRoot, 'dist')).isDirectory());
assert.ok(fs.statSync(path.join(moduleRoot, 'dist/index.html')).isFile(), 'Selected bundled frontend must exist');
const contract = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'dist/service-contract.json'), 'utf8'));
const { ManagedHelper } = require(path.join(moduleRoot, 'electron/helper.cjs'));
const { SourceRelay } = require(path.join(moduleRoot, 'electron/relay.cjs'));
const { BrowserContextTransport } = require(path.join(moduleRoot, 'electron/browser-transport.cjs'));
const { DesktopServices } = require(path.join(moduleRoot, 'electron/services.cjs'));
const { ServiceGate } = require(path.join(moduleRoot, 'electron/service-gate.cjs'));
const { LocalAppServer } = require(path.join(moduleRoot, 'electron/local-server.cjs'));
const { loadCatalogue } = require(path.join(moduleRoot, 'electron/catalogue.cjs'));
const nonce = process.env.NYORA_IMAGE_SMOKE_NONCE;
assert.match(nonce || '', /^[a-f0-9]{32}$/, 'Fresh parent-owned evidence nonce required');
const temporary = process.env.NYORA_IMAGE_SMOKE_PROFILE;
assert.ok(typeof temporary === 'string' && path.isAbsolute(temporary) && fs.statSync(temporary).isDirectory(), 'Disposable parent-owned image profile required');
app.on('window-all-closed', () => {});
app.enableSandbox(); app.setPath('userData', path.join(temporary, 'chromium'));
const output = path.join(project, 'test-results/runtime-images-smoke');
fs.mkdirSync(output, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const sourceId = 'data:atsumoe';
const hosts = new Set(['atsu.moe', 'cdn.atsu.moe']);
const calls = [];
const sockets = new Set();
let helper, relay, transport, localServer, window, sourceSession, tlsServer, proxy;
const gate = new ServiceGate();
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

function fixture(url) {
  const target = new URL(url);
  if (target.hostname === 'cdn.atsu.moe' && /^\/static\/(posters|pages)\//.test(target.pathname)) return { body: png, contentType: 'image/png' };
  assert.equal(target.hostname, 'atsu.moe', 'Unexpected fixture origin');
  switch (target.pathname) {
    case '/api/infinite/trending': return { body: { items: [{ id: 'fixture-series', title: 'Synthetic image fixture', image: '/static/posters/fixture.png' }] } };
    case '/api/manga/page':
      assert.equal(target.searchParams.get('id'), 'fixture-series');
      return { body: { mangaPage: { title: 'Synthetic image fixture', synopsis: 'Disposable fixture', status: 'ongoing', poster: { image: 'posters/fixture.png' }, scanlators: [] } } };
    case '/api/manga/allChapters':
      assert.equal(target.searchParams.get('mangaId'), 'fixture-series');
      return { body: { chapters: [{ id: 'chapter-1', title: 'Chapter 1', number: 1, index: 1, createdAt: 0 }] } };
    case '/api/read/chapter':
      assert.equal(target.searchParams.get('mangaId'), 'fixture-series'); assert.equal(target.searchParams.get('chapterId'), 'chapter-1');
      return { body: { readChapter: { pages: [{ image: '/static/pages/page-1.png' }] } } };
    default: throw new Error('Unexpected fixture path');
  }
}
async function cleanup() {
  window?.destroy(); await localServer?.stop(); await gate.close(); await helper?.stop(); await relay?.stop();
  await transport?.close();
  if (sourceSession) { await sourceSession.closeAllConnections(); await sourceSession.cookies.flushStore(); }
  for (const socket of sockets) socket.destroy();
  for (const server of [proxy, tlsServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
  // Parent test launcher removes the profile after Chromium has fully exited.
}

app.whenReady().then(async () => {
  const keyFile = path.join(temporary, 'fixture.key'); const certFile = path.join(temporary, 'fixture.crt');
  const created = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=atsu.moe', '-addext', 'subjectAltName=DNS:atsu.moe,DNS:cdn.atsu.moe'], { stdio: 'ignore' });
  assert.equal(created.status, 0, 'OpenSSL fixture certificate generation');
  const cert = fs.readFileSync(certFile, 'utf8');
  tlsServer = https.createServer({ key: fs.readFileSync(keyFile), cert }, (request, response) => {
    try {
      const url = `https://${request.headers.host}${request.url}`;
      const target = new URL(url); const value = fixture(url);
      calls.push({ host: target.hostname, path: target.pathname, cookiePresent: request.headers.cookie?.includes('nyora_image_fixture=present') || false,
        refererMatches: request.headers.referer === 'https://atsu.moe/' });
      response.writeHead(200, { 'Content-Type': value.contentType || 'application/json' });
      response.end(Buffer.isBuffer(value.body) ? value.body : JSON.stringify(value.body));
    } catch { response.writeHead(500); response.end('Fixture request mismatch'); }
  });
  await listen(tlsServer);
  proxy = http.createServer((request, response) => { response.writeHead(403); response.end(); });
  proxy.on('connect', (request, incoming, head) => {
    if (!['atsu.moe:443', 'cdn.atsu.moe:443'].includes(request.url)) { incoming.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const outgoing = net.connect(tlsServer.address().port, '127.0.0.1', () => {
      incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) outgoing.write(head);
      incoming.pipe(outgoing); outgoing.pipe(incoming);
    });
    for (const socket of [incoming, outgoing]) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
  });
  await listen(proxy);
  sourceSession = session.fromPartition('persist:source-images-fixture');
  await sourceSession.setProxy({ mode: 'fixed_servers', proxyRules: `https=127.0.0.1:${proxy.address().port}` });
  sourceSession.setCertificateVerifyProc((request, callback) => callback(hosts.has(request.hostname) && sameCertificate(request.certificate.data, cert) ? 0 : -2));
  await sourceSession.cookies.set({ url: 'https://atsu.moe/', domain: '.atsu.moe', path: '/', name: 'nyora_image_fixture', value: 'present', secure: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'manifest.json')));
  assert.equal(manifest.arch, process.arch, 'Helper architecture must match native Electron');
  assert.equal(manifest.platform, process.platform, 'Helper platform must match native Electron');
  const lookup = loadCatalogue(path.join(resources, 'catalogue.json'), manifest.catalogueSha256);
  assert.ok(lookup(sourceId).allowedOrigins.includes('https://cdn.atsu.moe'), 'Bundled catalogue must include trusted Atsu image rewrite origin');
  // Production transport receives the real source session, including fixture
  // proxy/certificate/cookies. Its inert top-level frames perform the requests;
  // there is no Session.fetch substitute or fallback in this test.
  transport = new BrowserContextTransport({ sessionForSource: async source => { assert.equal(source, sourceId); return sourceSession; } });
  const browserSession = await transport.sessionForSource(sourceId);
  // Only these test-only relay hooks retain the offline CONNECT proxy and a
  // deterministic public DNS answer. Production code still enforces direct mode.
  const facade = { setProxy: async options => assert.deepEqual(options, { mode: 'direct' }),
    resolveHost: async hostname => { assert.ok(hosts.has(hostname)); return { endpoints: [{ address: '1.1.1.1' }] }; },
    fetch: async (url, options) => {
      try { return await browserSession.fetch(url, options); }
      catch (error) {
        // Fixture-only diagnostics: bounded error identity and permitted target
        // path; never dump request headers, cookies, body or private relay token.
        const target = new URL(url);
        console.error('Fixture BrowserContextTransport error', JSON.stringify({
          host: target.hostname, path: target.pathname,
          code: String(error?.code || '').slice(0, 120),
          message: String(error?.message || error).replace(/[\r\n]/g, ' ').slice(0, 500),
        }));
        throw error;
      }
    } };
  relay = new SourceRelay({ catalogueLookup: lookup, sessionForSource: async source => { assert.equal(source, sourceId); return facade; } });
  const privateRelay = await relay.start();
  helper = new ManagedHelper({ profileRoot: path.join(temporary, 'library'), javaPath: path.join(resources, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    jarPath: path.join(resources, 'nyora-helper.jar'), relay: { url: `${privateRelay.baseUrl}/fetch`, token: privateRelay.token } });
  let services;
  const dist = path.join(temporary, 'dist'); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Nyora native image fixture</title><link rel=stylesheet href=/fixture.css><h1>Native image fixture</h1>');
  fs.writeFileSync(path.join(dist, 'fixture.css'), 'body{font:16px system-ui;background:#16161a;color:#f0f0f0}figure{display:inline-block;margin:12px}img{display:block;width:100px;height:100px}');
  localServer = new LocalAppServer({ distDirectory: dist, image: (url, { signal }) => gate.run(() => services.image(url, { signal })),
    csp: "default-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'" });
  await localServer.start();
  services = new DesktopServices({ helper, preferences: {}, contract,
    authorizeMedia: relay.authorizeMedia.bind(relay), sourceOrigin: source => lookup(source)?.baseOrigin,
    makeImageUrl: query => localServer.mediaUrl(query), appOrigin: localServer.origin });
  const health = await helper.start(); assert.equal(health.state, 'ready'); assert.equal(health.sourceTransport, 'chromium');
  const request = (operation, params) => gate.run(() => services.request({ operation, params }));
  const browse = await request('content.popular', { id: sourceId, page: 1 });
  assert.equal(browse.entries[0].url, '/manga/fixture-series');
  const details = await request('content.details', { id: sourceId, url: browse.entries[0].url });
  assert.equal(details.manga.url, '/manga/fixture-series'); assert.equal(details.chapters[0].url, 'fixture-series/chapter-1');
  const pages = await request('content.pages', { id: sourceId, url: details.chapters[0].url });
  assert.equal(pages.pages.length, 1);
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  await window.loadURL(localServer.indexUrl);
  const images = [];
  for (const [label, value] of [['browse-cover', browse.entries[0].coverUrl], ['details-cover', details.manga.coverUrl], ['reader-page', pages.pages[0].url]]) {
    const url = new URL(value); assert.equal(url.origin, localServer.origin); assert.equal(url.pathname, '/helper-image'); assert.ok(url.searchParams.get('cap'));
    const decode = async target => window.webContents.executeJavaScript(`(async()=>{const image=new Image();image.alt=${JSON.stringify(label)};image.src=${JSON.stringify(target)};const figure=document.createElement('figure');const caption=document.createElement('figcaption');caption.textContent=${JSON.stringify(label)};figure.append(image,caption);document.body.append(figure);await image.decode();return {width:image.naturalWidth,height:image.naturalHeight,isolated:crossOriginIsolated};})()`);
    assert.deepEqual(await decode(value), { width: 1, height: 1, isolated: true });
    url.searchParams.set('_r', String(Date.now())); assert.deepEqual(await decode(url.href), { width: 1, height: 1, isolated: true });
    const tampered = new URL(value); tampered.searchParams.set('u', 'https://cdn.atsu.moe/static/pages/unauthorized.png');
    assert.equal(await window.webContents.executeJavaScript(`fetch(${JSON.stringify(tampered.href)}).then(response=>response.status)`), 403);
    images.push({ label, decodedWidth: 1, decodedHeight: 1, retryDecoded: true, tamperRejected: true });
  }
  const mediaCalls = calls.filter(call => call.host === 'cdn.atsu.moe');
  assert.ok(mediaCalls.length >= 2 && mediaCalls.length <= 6);
  assert.ok(mediaCalls.some(call => call.path.startsWith('/static/posters/')));
  assert.ok(mediaCalls.some(call => call.path.startsWith('/static/pages/')));
  assert.ok(mediaCalls.every(call => call.cookiePresent && call.refererMatches));
  assert.ok(calls.filter(call => call.host === 'atsu.moe').every(call => call.cookiePresent));
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, 'images.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, nonce, resources: assembledResources, appVersion: appPackage.version, platform: process.platform, arch: process.arch, helper: health,
    mangaKey: details.manga.url, chapterKey: details.chapters[0].url, images, productionTransport: 'BrowserContextTransport',
    transport: 'Production BrowserContextTransport isolated-world fetch in real source sessions over offline HTTPS fixture; real native helper and production relay/local-server/services',
    mediaRequestCount: mediaCalls.length, externalNetwork: 'Only two exact HTTPS hosts tunneled to disposable loopback TLS fixture; no public source requests' }, null, 2));
  console.log(`Passed real ${process.arch} helper + production BrowserContextTransport HTTPS relay + signed local HTTP cover/details/reader decode/retry: ${images.length} images, ${mediaCalls.length} image requests.`);
}).then(async () => { await cleanup(); app.exit(0); }).catch(async error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, nonce, resources: assembledResources, appVersion: appPackage.version, platform: process.platform, arch: process.arch, error: error.message }, null, 2));
  console.error(error.message); await cleanup(); app.exit(1);
});
