import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedHelper } from '../electron/helper.cjs';

const fakeHelper = `
const fs = require('node:fs');
const http = require('node:http');
const args = JSON.parse(process.env.TEST_JAVA_ARGS);
const portFile = args.find(x => x.startsWith('-Dnyora.helper.port-file=')).split('=').slice(1).join('=');
if (process.env.TEST_MODE === 'crash') process.exit(23);
if (process.env.TEST_MODE === 'timeout') { setInterval(() => {}, 1000); return; }
const server = http.createServer((request, response) => {
 if (request.headers.authorization !== 'Bearer ' + process.env.NYORA_HELPER_TOKEN) { response.writeHead(401); return response.end(); }
 response.setHeader('Content-Type', 'application/json');
 if (request.url === '/health') response.end(JSON.stringify({status:'ok',isolated:true,protocol:process.env.TEST_MODE === 'wrong-protocol'?'wrong':'nyora-desktop-helper/1',revision:'synthetic-1'}));
 else response.end(JSON.stringify({private:true}));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
`;

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'nyora-helper-test-'));
  const fake = join(root, 'fake.cjs');
  await writeFile(fake, fakeHelper);
  let starts = 0;
  let child;
  let captured;
  const helper = new ManagedHelper({ profileRoot: join(root, 'profile'), javaPath: process.execPath, jarPath: join(root, 'helper.jar'), timeout: 700,
    launcher(file, args, options) {
      starts++;
      captured = { args, options };
      child = spawn(file, [fake], { ...options, env: { ...options.env, TEST_JAVA_ARGS: JSON.stringify(args), TEST_MODE: mode || '' } });
      return child;
    },
  });
  t.after(async () => { await helper.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, helper, starts: () => starts, child: () => child, captured: () => captured };
}

test('one owned helper authenticates, exposes no credential and stops its child', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.helper.start(), f.helper.start()]);
  assert.equal(f.starts(), 1);
  assert.deepEqual(a, b);
  assert.equal(a.state, 'ready');
  assert.equal(JSON.stringify(a).includes('token'), false);
  const launch = f.captured();
  assert.ok(launch.args.includes('-Dnyora.desktop.isolated=true'));
  assert.ok(launch.args.some((arg) => arg.startsWith('-Djava.io.tmpdir=')));
  const portFile = launch.args.find((arg) => arg.startsWith('-Dnyora.helper.port-file=')).slice('-Dnyora.helper.port-file='.length);
  const port = await readFile(portFile, 'utf8');
  const denied = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(denied.status, 401);
  const response = await f.helper.request('/library/favourites');
  assert.deepEqual(JSON.parse(response.bytes), { private: true });
  await assert.rejects(f.helper.request('//evil.example/path'), /Invalid internal/);
  await f.helper.stop();
  assert.notEqual(f.child().exitCode ?? f.child().signalCode, null);
  await assert.rejects(f.helper.request('/library/favourites'), /unavailable/);
});

for (const [mode, expected] of [['crash', 'HELPER_EXITED'], ['timeout', 'HELPER_START_TIMEOUT'], ['wrong-protocol', 'HELPER_PROTOCOL_MISMATCH']]) {
  test(`startup ${mode} fails without attaching to another service`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(f.helper.start(), (error) => error.code === expected);
    assert.equal(f.helper.status.state, 'unavailable');
    assert.notEqual(f.child().exitCode ?? f.child().signalCode, null);
  });
}

test('shutdown during startup cancels and reaps owned process', async (t) => {
  const f = await fixture(t, 'timeout');
  const start = f.helper.start();
  const rejected = assert.rejects(start);
  await f.helper.stop();
  await rejected;
  assert.equal(f.helper.status.state, 'stopped');
});

test('symlink profile cannot redirect helper writes into another profile', async (t) => {
  const f = await fixture(t);
  await symlink(f.root, join(f.root, 'profile'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.helper.start(), /symlink/);
  assert.equal(f.starts(), 0);
});
