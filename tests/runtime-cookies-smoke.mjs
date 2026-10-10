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
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--resources' && isAbsolute(args[1])), 'Usage: test:cookies [--resources <absolute assembled app Resources directory>]');
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
const output = join(project, 'test-results/runtime-cookies-smoke/result.json');
const profiles = [];
const evidence = [];
const nonce = randomBytes(16).toString('hex');
let active;
function terminate(child, signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); } }
}
const interrupt = () => terminate(active, 'SIGKILL');
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
async function launch(profile, phase, crash) {
  const child = spawn(require('electron'), [join(project, 'tests/runtime-cookies-smoke.cjs')], {
    cwd: project, detached: process.platform !== 'win32',
    env: { ...process.env, NYORA_COOKIE_SMOKE_PROFILE: profile, NYORA_COOKIE_SMOKE_NONCE: nonce,
      NYORA_COOKIE_SMOKE_PHASE: phase, NYORA_COOKIE_SMOKE_RESOURCES: resources || '', NYORA_COOKIE_SMOKE_VERSION: currentPackage.version },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  active = child;
  let pending = '', result, forced = false, timeoutReached = false;
  const started = Date.now();
  child.stdout.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.startsWith('NYORA_COOKIE_RESULT ')) { if (line) console.log(line); continue; }
      result = JSON.parse(line.slice('NYORA_COOKIE_RESULT '.length));
      if (crash && result.readyForCrash) {
        forced = true; result.killedWithinMs = Date.now() - started; terminate(child, 'SIGKILL');
      }
    }
  });
  const timer = setTimeout(() => { timeoutReached = true; terminate(child, 'SIGKILL'); }, 30000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timer); active = undefined; }
  assert.equal(timeoutReached, false, `Cookie phase ${phase} exceeded deadline`);
  if (crash) { assert.equal(forced, true); if (process.platform !== 'win32') assert.equal(status.signal, 'SIGKILL'); assert.ok(result.killedWithinMs < 30000); }
  else assert.equal(status.code, 0, `Cookie phase ${phase} failed`);
  assert.equal(result?.nonce, nonce); assert.equal(result.phase, phase); assert.equal(result.appVersion, currentPackage.version); assert.equal(result.resources, resources || null);
  evidence.push(result); return result;
}
async function makeProfile() {
  const profile = await mkdtemp(join(tmpdir(), 'nyora-native-cookie-smoke-')); profiles.push(profile);
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(profile, 'key.pem'),
    '-out', join(profile, 'cert.pem'), '-days', '1', '-subj', '/CN=example.org']).status, 0);
  return profile;
}
try {
  await rm(output, { force: true });
  const control = await makeProfile();
  await launch(control, 'old-issue', true);
  assert.equal((await launch(control, 'old-read', false)).savingRequirementSatisfied, false);
  const profile = await makeProfile();
  await launch(profile, 'issue', true);
  await launch(profile, 'read-reset', true);
  await launch(profile, 'reset-read', false);
  const result = { passed: true, nonce, appVersion: currentPackage.version, resources: resources || null,
    platform: process.platform, arch: process.arch, productionTransport: 'BrowserContextTransport', productionCookiePersistence: 'CookiePersistence',
    checks: ['Old behavior control loses new persistent cookie on immediate force quit',
      'Window-issued persistent HttpOnly Partitioned clearance automatically flushed; explicit save receipt exposes no values',
      'Verification close and forced full-process restart preserve protected content and image bytes in native Chromium transport',
      'Session-only control expires; second source partition remains isolated', 'Selected source reset remains durable after another force quit; second source retains clearance'], evidence };
  const { mkdir, writeFile } = await import('node:fs/promises'); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2)); console.log(`Passed ${result.checks.length} native cookie durability checks`);
} finally {
  terminate(active, 'SIGKILL'); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  for (const profile of profiles) await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
