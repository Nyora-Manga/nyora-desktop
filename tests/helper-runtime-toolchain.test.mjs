import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArchive } from '../scripts/prepare-jdk.mjs';
import { runtimeCommand, runtimeEnv, runtimeTree, verifyBundledHelper, verifyJava } from '../scripts/runtime-validation.mjs';
import { ManagedHelper } from '../electron/helper.cjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nyora-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('runtime archive validation rejects same-size corruption and truncated downloads', async t => {
  const root = await fixture(t), file = join(root, 'archive.tar.gz');
  const bytes = Buffer.from('synthetic pinned runtime archive');
  const pin = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(file, bytes);
  await verifyArchive(file, pin);
  const corrupt = Buffer.from(bytes); corrupt[0] ^= 1;
  await writeFile(file, corrupt);
  await assert.rejects(verifyArchive(file, pin), /SHA256/);
  await writeFile(file, bytes.subarray(1));
  await assert.rejects(verifyArchive(file, pin), /size/);
});

test('runtime command rejects crashes, nonzero exits and timeouts while removing JVM option injection', async () => {
  const env = runtimeEnv({ ...process.env, JAVA_TOOL_OPTIONS: '-Xint', _JAVA_OPTIONS: '-Xint', JDK_JAVA_OPTIONS: '-Xint', CLASSPATH: '/untrusted' });
  for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH']) assert.equal(env[key], undefined);
  await assert.rejects(runtimeCommand(process.execPath, ['-e', 'process.exit(7)']), /exit 7/);
  await assert.rejects(runtimeCommand(process.execPath, ['-e', 'process.kill(process.pid,"SIGKILL")']), /SIGKILL|exit/);
  await assert.rejects(runtimeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timeout/);
  assert.equal(await runtimeCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { env }), 'ok');
});

test('runtime timeout is bounded when a descendant inherits output pipes', async () => {
  const started = Date.now();
  const command = 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},2200)"],{stdio:["ignore",1,2]});setInterval(()=>{},1000)';
  await assert.rejects(runtimeCommand(process.execPath, ['-e', command], { timeout: 400 }), /timeout/);
  assert.ok(Date.now() - started < 1500, 'descendant output pipes must not extend the runtime deadline');
});

test('runtime tree detects changed bytes and rejects external symlink dependencies', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), tree = join(root, 'runtime');
  await mkdir(tree);
  await writeFile(join(tree, 'lib'), 'initial');
  const before = await runtimeTree(tree);
  await writeFile(join(tree, 'lib'), 'changed');
  assert.notEqual((await runtimeTree(tree)).sha256, before.sha256);
  await writeFile(join(root, 'outside'), 'external runtime bytes');
  await symlink('../outside', join(tree, 'external'));
  await assert.rejects(runtimeTree(tree), /outside|external|escape|symlink/i);
});

test('runtime version gate rejects a working wrong-architecture executable', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), java = join(root, 'java');
  await writeFile(java, '#!/usr/bin/env node\nconsole.log("os.arch = amd64\\njava.runtime.version = 17.0.20.1+1\\njava.vendor = Azul Systems, Inc.");\n', { mode: 0o700 });
  await assert.rejects(verifyJava(java, { arch: 'arm64' }), /natively/);
  assert.equal((await verifyJava(java, { arch: 'x64' })).arch, 'amd64');
  await assert.rejects(verifyJava(java, { arch: 'x64', pin: { vendor: 'Other vendor', version: '17.0.20.1+1' } }), /pinned/);
});

async function fakeHelper(t, durable) {
  const root = await fixture(t), logs = join(root, 'launches.ndjson');
  await mkdir(join(root, 'jre', 'bin'), { recursive: true });
  await writeFile(join(root, 'nyora-helper.jar'), 'synthetic helper');
  const code = [
    '#!/usr/bin/env node',
    "const fs=require('node:fs'),http=require('node:http'),path=require('node:path');",
    "const arg=name=>process.argv.find(value=>value.startsWith('-D'+name+'='))?.split('=').slice(1).join('=');",
    "const profile=arg('nyora.data.dir'),portFile=arg('nyora.helper.port-file');",
    'fs.appendFileSync(' + JSON.stringify(logs) + ',JSON.stringify({profile,pid:process.pid})+"\\n");',
    "const data=path.join(profile,'synthetic-category.json');",
    'let rows=' + (durable ? "fs.existsSync(data)?JSON.parse(fs.readFileSync(data,'utf8')):[];" : '[];'),
    "const server=http.createServer((req,res)=>{",
    "res.setHeader('Content-Type','application/json');",
    "if(req.headers.authorization!=='Bearer '+process.env.NYORA_HELPER_TOKEN){res.statusCode=401;res.end('{}');return;}",
    "if(req.url==='/health'){res.end(JSON.stringify({status:'ok',isolated:true,protocol:'nyora-desktop-helper/1',revision:'synthetic',sourceTransport:'chromium'}));return;}",
    "if(req.url.startsWith('/library/categories/create')){rows=[{id:1,title:'Runtime validation'}];fs.writeFileSync(data,JSON.stringify(rows));res.end(JSON.stringify({id:1}));return;}",
    "if(req.url==='/library/categories'){res.end(JSON.stringify({categories:rows}));return;}",
    "res.statusCode=404;res.end('{}');});",
    "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(portFile,String(server.address().port)));",
  ].join('\n');
  await writeFile(join(root, 'jre', 'bin', 'java'), code, { mode: 0o700 });
  return { root, logs };
}

for (const durable of [true, false]) test('bundled helper gate ' + (durable ? 'accepts durable restart' : 'rejects lost restart data') + ' and removes its disposable profile', { skip: process.platform === 'win32' }, async t => {
  const { root, logs } = await fakeHelper(t, durable);
  if (durable) assert.equal((await verifyBundledHelper(root)).restart, true);
  else await assert.rejects(verifyBundledHelper(root));
  const launches = (await readFile(logs, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].profile, launches[1].profile);
  for (const launch of launches) {
    await assert.rejects(stat(launch.profile), { code: 'ENOENT' });
    assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
  }
});

test('bundled helper cleanup still removes the profile after a shutdown error', { skip: process.platform === 'win32' }, async t => {
  const { root, logs } = await fakeHelper(t, true);
  const original = ManagedHelper.prototype.stop;
  let stops = 0;
  ManagedHelper.prototype.stop = async function () {
    await original.call(this);
    if (++stops === 2) throw new Error('Synthetic shutdown receipt failure');
  };
  try {
    await assert.rejects(verifyBundledHelper(root), /cleanup failed/);
    const launches = (await readFile(logs, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    await assert.rejects(stat(launches[0].profile), { code: 'ENOENT' });
  } finally { ManagedHelper.prototype.stop = original; }
});
