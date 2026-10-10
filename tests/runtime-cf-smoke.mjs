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
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--resources' && isAbsolute(args[1])), 'Usage: test:cf [--resources <absolute assembled app Resources directory>]');
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
const profile = await mkdtemp(join(tmpdir(), 'nyora-native-cf-smoke-'));
const nonce = randomBytes(16).toString('hex');
const resultPath = join(project, 'test-results/runtime-cf-smoke/result.json');
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
  child = spawn(require('electron'), [join(project, 'tests/runtime-cf-smoke.cjs')], {
    cwd: project, env: { ...process.env, NYORA_CF_SMOKE_PROFILE: profile, NYORA_CF_SMOKE_NONCE: nonce,
      NYORA_CF_SMOKE_RESOURCES: resources || '', NYORA_CF_SMOKE_VERSION: currentPackage.version },
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
  assert.equal(interrupted, false, 'Native CF fixture was interrupted');
  assert.equal(timedOut, false, 'Native CF fixture exceeded its 120 second deadline');
  assert.equal(status.code, 0, `Native CF fixture exited with ${status.signal || status.code}`);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.nonce, nonce, 'CF evidence must belong to this fresh invocation');
  assert.equal(result.resources, resources || null, 'CF evidence must match selected assembled resources');
  assert.equal(result.appVersion, currentPackage.version);
  assert.equal(result.productionTransport, 'BrowserContextTransport', 'CF evidence must use the production browser transport');
  assert.equal(result.passed, true);
} finally {
  clearTimeout(timeout); clearTimeout(escalation);
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  if (timedOut || interrupted) terminate('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
