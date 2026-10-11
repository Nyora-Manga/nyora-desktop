'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const { LocalAppServer } = require('./local-server.cjs');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nyora-local-server-test-'));
  const dist = join(root, 'dist'); await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Nyora</title>');
  const server = new LocalAppServer({ distDirectory: dist, image: async () => ({ bytes: Buffer.from('image'), contentType: 'image/png' }), ...options });
  await server.start();
  t.after(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, dist, server };
}
function raw(server, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(`${server.origin}/`, { path, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end();
  });
}

test('bundled UI and worker/font/wasm assets use exact MIME and HEAD without listings', async t => {
  const { dist, server } = await fixture(t, { csp: "default-src 'self'; worker-src 'self'" });
  for (const [file, mime] of [['font.woff2', 'font/woff2'], ['font.ttf', 'font/ttf'], ['worker.mjs', 'text/javascript'], ['core.wasm', 'application/wasm'], ['theme.css', 'text/css'], ['model.onnx', 'application/octet-stream']]) {
    await writeFile(join(dist, file), 'fixture');
    const result = await raw(server, `/${file}`);
    assert.equal(result.status, 200); assert.ok(result.headers['content-type'].startsWith(mime));
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    const head = await raw(server, `/${file}`, {}, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(head.headers['content-length'], '7');
  }
  const index = await raw(server, '/'); assert.equal(index.status, 200);
  assert.equal(index.headers['content-security-policy'], "default-src 'self'; worker-src 'self'");
  assert.equal(index.headers['cross-origin-resource-policy'], 'same-origin');
  await mkdir(join(dist, 'folder')); assert.equal((await raw(server, '/folder/')).status, 404);
  assert.equal((await raw(server, '/absent.js')).status, 404);
});

test('rejects traversal, symlink escape, wrong Host/Origin/fetch site and unsafe methods', async t => {
  const { root, dist, server } = await fixture(t);
  await writeFile(join(root, 'private.txt'), 'private'); await symlink(join(root, 'private.txt'), join(dist, 'escape.txt'));
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/%5cprivate.txt', '/%00', '/%', '/escape.txt', '/.secret']) assert.ok((await raw(server, path)).status >= 400, path);
  assert.equal((await raw(server, '/', { Host: new URL(server.origin).host.replace('127.0.0.1', 'localhost') })).status, 403);
  assert.equal((await raw(server, '/', { Origin: 'https://foreign.example.org' })).status, 403);
  assert.equal((await raw(server, '/', { Origin: 'null' })).status, 403);
  assert.equal((await raw(server, '/', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await raw(server, '/', { Origin: server.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  for (const method of ['POST', 'OPTIONS', 'DELETE']) assert.equal((await raw(server, '/', {}, method)).status, 405);
});

test('image URLs require per-launch capability; callback receives no capability or helper token', async t => {
  const seen = [];
  const { server } = await fixture(t, { image: async url => { seen.push(url); return { bytes: Buffer.from([1, 2, 3]), contentType: 'image/webp' }; } });
  const query = new URLSearchParams({ u: 'https://cdn.example.org/page.webp', sourceId: 'data:fixture' });
  query.append('h', 'Referer:https://source.example.org/');
  const issued = new URL(server.mediaUrl(query));
  assert.equal(issued.origin, server.origin); assert.ok(issued.searchParams.get('cap').length >= 40);
  const result = await raw(server, `${issued.pathname}${issued.search}`, { Origin: server.origin });
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, Buffer.from([1, 2, 3]));
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  const forwarded = new URL(seen[0]); assert.equal(forwarded.origin, server.origin); assert.equal(forwarded.searchParams.get('cap'), null);
  assert.equal(forwarded.searchParams.get('u'), query.get('u')); assert.deepEqual(forwarded.searchParams.getAll('h'), query.getAll('h'));
  assert.equal((await raw(server, `/helper-image?${query}`)).status, 403);
  issued.searchParams.set('cap', 'invalid'); assert.equal((await raw(server, issued.pathname + issued.search)).status, 403);
  issued.searchParams.set('cap', new URL(server.mediaUrl(query)).searchParams.get('cap')); issued.searchParams.append('cap', issued.searchParams.get('cap'));
  assert.equal((await raw(server, issued.pathname + issued.search)).status, 403);
  for (const [field, value] of [['u', 'https://other.example.org/changed.webp'], ['sourceId', 'data:other'], ['h', 'Referer:https://other.example.org/']]) {
    const changed = new URL(server.mediaUrl(query)); changed.searchParams.set(field, value);
    assert.equal((await raw(server, changed.pathname + changed.search)).status, 403, field);
  }
  const extra = new URL(server.mediaUrl(query)); extra.searchParams.append('h', 'Referer:https://extra.example.org/');
  assert.equal((await raw(server, extra.pathname + extra.search)).status, 403);
  assert.notEqual(new URL(server.mediaUrl(query)).searchParams.get('cap'), new URL(server.mediaUrl(new URLSearchParams({ u: 'https://other.example.org/p.webp', sourceId: 'data:fixture' }))).searchParams.get('cap'));
  const valid = new URL(server.mediaUrl(query));
  assert.equal((await raw(server, valid.pathname + valid.search, { Origin: 'https://foreign.example.org' })).status, 403);
  valid.searchParams.set('_r', '1791111222333');
  assert.equal((await raw(server, valid.pathname + valid.search)).status, 200);
  assert.equal(new URL(seen[1]).searchParams.has('_r'), false);
  valid.searchParams.append('_r', '2'); assert.equal((await raw(server, valid.pathname + valid.search)).status, 400);
  valid.searchParams.delete('_r'); valid.searchParams.set('_r', 'not-a-timestamp'); assert.equal((await raw(server, valid.pathname + valid.search)).status, 400);
  valid.searchParams.delete('_r'); valid.searchParams.set('cap', 'é'.repeat(43)); assert.equal((await raw(server, valid.pathname + valid.search)).status, 403);
  assert.equal(seen.length, 2);
});

test('image output bounds/type checks never serve HTML/SVG or disclose exception text', async t => {
  let response = { bytes: Buffer.alloc(33 * 1024 * 1024), contentType: 'image/png' };
  const { server } = await fixture(t, { image: async () => { if (response instanceof Error) throw response; return response; } });
  const url = new URL(server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/p.png', sourceId: 'data:fixture' })));
  const get = () => raw(server, url.pathname + url.search);
  assert.equal((await get()).status, 502);
  for (const contentType of ['text/html', 'image/svg+xml', 'image/png\r\nInjected: true']) { response = { bytes: Buffer.from('bad'), contentType }; assert.equal((await get()).status, 502); }
  response = new Error('private credential'); const failure = await get(); assert.equal(failure.status, 502); assert.ok(!failure.bytes.includes('private credential'));
  response = { bytes: Buffer.from('ok'), contentType: 'application/octet-stream' }; assert.equal((await get()).status, 200);
});

test('stop closes listener and invalidates old media capabilities across restart', async t => {
  const { server } = await fixture(t);
  const oldOrigin = server.origin; const old = new URL(server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/p.png' })));
  await server.stop(); await server.stop();
  await assert.rejects(fetch(oldOrigin, { signal: AbortSignal.timeout(1000) }));
  assert.throws(() => server.mediaUrl(new URLSearchParams()), /running/i);
  await server.start(); const current = new URL(server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/p.png' })));
  assert.notEqual(current.searchParams.get('cap'), old.searchParams.get('cap'));
  assert.equal((await raw(server, old.pathname + old.search)).status, 403);
});

test('limits concurrent images and aborts active callbacks on shutdown', async t => {
  const signals = [];
  const { server } = await fixture(t, { image: async (url, { signal }) => { signals.push(signal); return new Promise(() => {}); } });
  const url = new URL(server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/p.png' })));
  const pending = Array.from({ length: 8 }, () => raw(server, url.pathname + url.search).catch(() => undefined));
  const deadline = Date.now() + 3000;
  while (signals.length < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(signals.length, 8);
  assert.equal((await raw(server, url.pathname + url.search)).status, 429);
  await server.stop(); await Promise.all(pending);
  assert.ok(signals.every(signal => signal.aborted));
});

test('offline pages are bound to one opaque book and page with no filesystem arguments', async t => {
  const seen = [];
  const { server } = await fixture(t, { localImage: async (id, page) => { seen.push([id, page]); return { bytes: Buffer.from('page'), contentType: 'image/png' }; } });
  const id = '11111111-2222-4333-8444-555555555555';
  const issued = new URL(server.localMediaUrl(id, 2));
  assert.equal((await raw(server, issued.pathname + issued.search)).status, 200);
  assert.deepEqual(seen, [[id, 2]]);
  assert.equal((await raw(server, issued.pathname.replace('/2', '/3') + issued.search)).status, 403);
  assert.equal((await raw(server, issued.pathname.replace(id, '99999999-2222-4333-8444-555555555555') + issued.search)).status, 403);
  issued.searchParams.set('path', '/etc/passwd');
  assert.equal((await raw(server, issued.pathname + issued.search)).status, 403);
  issued.searchParams.delete('path'); issued.searchParams.set('_r', '100');
  assert.equal((await raw(server, issued.pathname + issued.search)).status, 200);
  assert.throws(() => server.localMediaUrl('../private', 0), /Invalid/);
  assert.throws(() => server.localMediaUrl(id, -1), /Invalid/);
});

test('a preferred port keeps the renderer origin stable and a busy one falls back', async t => {
  const { dist, server: first } = await fixture(t);
  const port = Number(new URL(first.origin).port);
  const image = async () => ({ bytes: Buffer.from('image'), contentType: 'image/png' });
  // Busy: the first server still owns the port, so the second takes another.
  const busy = new LocalAppServer({ distDirectory: dist, image });
  await busy.start(port);
  assert.notEqual(busy.origin, first.origin);
  assert.equal((await raw(busy, '/index.html')).status, 200);
  await busy.stop();
  // Free again: a relaunch reuses the same origin, so its model cache survives.
  await first.stop();
  const relaunch = new LocalAppServer({ distDirectory: dist, image });
  await relaunch.start(port);
  t.after(() => relaunch.stop());
  assert.equal(relaunch.origin, `http://127.0.0.1:${port}`);
  // Invalid preferences are ignored rather than trusted.
  const invalid = new LocalAppServer({ distDirectory: dist, image });
  await invalid.start(80);
  assert.notEqual(Number(new URL(invalid.origin).port), 80);
  await invalid.stop();
});
