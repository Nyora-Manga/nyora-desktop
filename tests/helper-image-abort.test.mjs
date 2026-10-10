import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedHelper } from '../electron/helper.cjs';
import { DesktopServices } from '../electron/services.cjs';
import { ServiceGate } from '../electron/service-gate.cjs';
import { LocalAppServer } from '../electron/local-server.cjs';

const fixtureSource = [
  "const fs=require('node:fs'),http=require('node:http');",
  "const args=JSON.parse(process.env.TEST_JAVA_ARGS);",
  "const portFile=args.find(x=>x.startsWith('-Dnyora.helper.port-file=')).split('=').slice(1).join('=');",
  "const server=http.createServer((req,res)=>{",
  " if(req.headers.authorization!=='Bearer '+process.env.NYORA_HELPER_TOKEN){res.writeHead(401);res.end();return;}",
  " if(req.url.startsWith('/image?')){res.once('close',()=>process.send({event:'image-closed'}));process.send({event:'image-started'});return;}",
  " res.setHeader('Content-Type','application/json');",
  " if(req.url==='/health')res.end(JSON.stringify({status:'ok',isolated:true,protocol:'nyora-desktop-helper/1',revision:'synthetic-abort'}));",
  " else res.end(JSON.stringify({ok:true}));",
  "});",
  "server.listen(0,'127.0.0.1',()=>setTimeout(()=>fs.writeFileSync(portFile,String(server.address().port)),Number(process.env.TEST_READY_DELAY)||0));",
].join('\n');

async function bounded(promise, label, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' did not complete promptly')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { readyDelay = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nyora-image-abort-'));
  const dist = join(root, 'dist'), fake = join(root, 'helper.cjs');
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<!doctype html>');
  await writeFile(fake, fixtureSource);
  const started = Promise.withResolvers(), imageStarted = Promise.withResolvers(), imageClosed = Promise.withResolvers();
  let child, imageRequests = 0, server, services;
  const helper = new ManagedHelper({
    profileRoot: join(root, 'profile'), javaPath: process.execPath, jarPath: join(root, 'unused.jar'), timeout: 5000,
    launcher(file, args, options) {
      child = spawn(file, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...options.env, TEST_JAVA_ARGS: JSON.stringify(args), TEST_READY_DELAY: String(readyDelay) } });
      child.on('message', value => {
        if (value.event === 'image-started') { imageRequests++; imageStarted.resolve(); }
        if (value.event === 'image-closed') imageClosed.resolve();
      });
      started.resolve(); return child;
    },
  });
  const gate = new ServiceGate();
  server = new LocalAppServer({ distDirectory: dist, image: (url, { signal }) => gate.run(() => services.image(url, { signal })) });
  t.after(async () => {
    await server.stop();
    await helper.stop();
    if (child?.connected) child.disconnect();
    await rm(root, { recursive: true, force: true });
  });
  await server.start();
  services = new DesktopServices({ helper, preferences: {}, contract: { schemaVersion: 1, operations: {} }, appOrigin: server.origin });
  const url = server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/synthetic.png', sourceId: 'data:synthetic' }));
  return { helper, gate, server, services, url, started, imageStarted, imageClosed, imageRequests: () => imageRequests };
}

for (const action of ['client disconnect', 'local server shutdown']) {
  test(action + ' aborts helper HTTP and releases the production service gate', async t => {
    const f = await fixture(t);
    const request = http.get(f.url);
    request.on('error', () => {});
    t.after(() => request.destroy());
    await bounded(f.imageStarted.promise, 'authenticated helper image request');
    if (action === 'client disconnect') request.destroy();
    else await bounded(f.server.stop(), 'local listener shutdown');
    await bounded(f.imageClosed.promise, 'helper HTTP cancellation');
    await bounded(f.gate.close(), 'service gate drain');
    assert.equal(f.helper.status.state, 'ready', 'image cancellation must not stop the shared helper');
    const response = await f.helper.request('/library/stats');
    assert.deepEqual(JSON.parse(response.bytes), { ok: true });
  });
}

test('aborting an image waiting for readiness preserves shared helper startup for another consumer', async t => {
  const f = await fixture(t, { readyDelay: 700 });
  const controller = new AbortController();
  const route = new URL(f.url); route.searchParams.delete('cap');
  const pending = f.gate.run(() => f.services.image(route.href, { signal: controller.signal }));
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' || /abort/i.test(error.message));
  await bounded(f.started.promise, 'helper launch');
  const anotherConsumer = f.helper.start();
  controller.abort();
  await bounded(rejected, 'image readiness cancellation', 400);
  await bounded(f.gate.close(), 'gate drain during readiness', 400);
  assert.equal((await bounded(anotherConsumer, 'other helper consumer')).state, 'ready');
  assert.equal(f.imageRequests(), 0, 'cancelled readiness wait must not dispatch an image request');
});
