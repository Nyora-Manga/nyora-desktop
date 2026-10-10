import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createFrontendServer } from '../scripts/dev-server.mjs';

function get(port, path, options = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('frontend server exposes generated assets only and rejects traversal and symlink escape', async () => {
  const base = await mkdtemp(join(tmpdir(), 'nyora-server-'));
  const dist = join(base, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<title>Prototype</title>');
  await writeFile(join(dist, 'worker.wasm'), 'wasm');
  await writeFile(join(base, 'secret.txt'), 'must not leak');
  await symlink(join(base, 'secret.txt'), join(dist, 'escape.txt'));
  const server = await createFrontendServer(dist, { port: 0 });
  const port = server.address().port;
  try {
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.body, /Prototype/);
    assert.equal(index.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal((await get(port, '/worker.wasm')).headers['content-type'], 'application/wasm');
    assert.equal((await get(port, '/', { method: 'HEAD' })).body, '');
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%252e%252e/secret.txt', '/a/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%5c..%5csecret.txt', '/.env', '/escape.txt', '/%00file']) {
      const result = await get(port, path);
      assert.equal(result.status, 403, path);
      assert(!result.body.includes('must not leak'));
    }
    assert.equal((await get(port, '/%zz')).status, 400);
    assert.equal((await get(port, '/missing.js')).status, 404);
    assert.equal((await get(port, '/')).headers['cache-control'], 'no-store');
    assert.equal((await get(port, '/', { method: 'POST' })).status, 405);
    assert.equal((await get(port, '/', { headers: { Host: 'evil.example' } })).status, 403);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(base, { recursive: true, force: true });
  }
});
