import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--resources' && isAbsolute(args[1])), 'Usage: runtime-offline-smoke.mjs [--resources <absolute assembled app Resources directory>]');
const resources = args.length ? await realpath(args[1]) : undefined;
if (resources) {
  assert.ok((await stat(resources)).isDirectory(), 'Resources must be a directory');
  assert.ok((await stat(join(resources, 'app.asar'))).isFile(), 'Assembled app.asar is required');
}
const currentPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
if (resources) {
  // Node lacks Electron's patched ASAR filesystem; inspect the package without
  // executing archive code. The child loads production modules through ASAR.
  const { extractFile } = require('@electron/asar');
  const packaged = JSON.parse(extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'));
  assert.equal(packaged.version, currentPackage.version, 'Assembled package version must match current desktop version');
  assert.equal(packaged.name, currentPackage.name, 'Assembled application identity must match');
}
const helperRoot = join(resources || join(project, 'resources'), 'helper');
const manifest = JSON.parse(await readFile(join(helperRoot, 'manifest.json'), 'utf8'));
assert.equal(manifest.arch, process.arch, 'Helper architecture must match the native test runner');
assert.equal(manifest.platform, process.platform, 'Helper platform must match the native test runner');
const profile = await mkdtemp(join(tmpdir(), 'nyora-native-offline-smoke-'));
const nonce = randomBytes(16).toString('hex');
const resultPath = join(project, 'test-results/runtime-offline-smoke/result.json');
let child;
let timeout;
let escalation;
let timedOut = false;
let interrupted = false;
function terminate(signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  } else {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  }
}
const interrupt = () => {
  interrupted = true; terminate('SIGTERM');
  clearTimeout(escalation); escalation = setTimeout(() => terminate('SIGKILL'), 5000);
};
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await rm(resultPath, { force: true });
  for (const restart of ['0', '1']) {
  child = spawn(require('electron'), [join(project, 'tests/runtime-offline-smoke.cjs')], {
    cwd: project, env: { ...process.env, NYORA_OFFLINE_SMOKE_PROFILE: profile, NYORA_OFFLINE_SMOKE_NONCE: nonce,
      NYORA_OFFLINE_SMOKE_RESOURCES: resources || '', NYORA_OFFLINE_SMOKE_VERSION: currentPackage.version, NYORA_OFFLINE_SMOKE_RESTART: restart },
    detached: process.platform !== 'win32', stdio: 'inherit',
  });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
    timeout = setTimeout(() => {
      timedOut = true; terminate('SIGTERM');
      escalation = setTimeout(() => terminate('SIGKILL'), 5000);
    }, 120000);
  });
  assert.equal(interrupted, false, 'Native image fixture was interrupted');
  assert.equal(timedOut, false, 'Native image fixture exceeded its 120 second deadline');
  assert.equal(status.code, 0, `Native image fixture exited with ${status.signal || status.code}`);
  clearTimeout(timeout); clearTimeout(escalation);
  }
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.nonce, nonce, 'Image evidence must belong to this fresh invocation');
  assert.equal(result.resources, resources || null, 'Image evidence must match selected assembled resources');
  assert.equal(result.appVersion, currentPackage.version);
  assert.equal(result.productionTransport, 'BrowserContextTransport', 'Image evidence must use the production browser transport');
  assert.equal(result.passed, true);
  assert.equal(result.freshProcessRestart, true, 'Offline books must survive a fresh native process without helper/source networking');
  assert.equal(result.durableQueuePause, true, 'A paused queue must persist its queued jobs without starting source requests');
  assert.equal(result.pausedQueueFreshProcessRestart, true, 'A fresh native process must hold persisted paused jobs until explicit Resume');
} finally {
  clearTimeout(timeout); clearTimeout(escalation);
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  if (timedOut || interrupted) terminate('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
