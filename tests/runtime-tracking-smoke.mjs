import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--resources' && isAbsolute(args[1])), 'Usage: runtime-tracking-smoke.mjs [--resources <absolute assembled Resources directory>]');
const resources = args.length ? await realpath(args[1]) : null;
const currentPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
if (resources) {
  assert.ok((await stat(resources)).isDirectory()); assert.ok((await stat(join(resources, 'app.asar'))).isFile());
  const { extractFile } = require('@electron/asar');
  const packaged = JSON.parse(extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'));
  assert.equal(packaged.version, currentPackage.version); assert.equal(packaged.name, currentPackage.name);
}
const profile = await mkdtemp(join(tmpdir(), 'nyora-native-tracking-')), nonce = randomBytes(16).toString('hex');
const output = join(project, 'test-results/runtime-tracking-smoke/result.json');
let child, escalation, interrupted = false;
function terminate(signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); } }
}
const interrupt = () => { interrupted = true; terminate('SIGTERM'); escalation = setTimeout(() => terminate('SIGKILL'), 3000); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await rm(output, { force: true }); const checks = [];
  for (const phase of ['write', 'restart']) {
    let timedOut = false, timer;
    child = spawn(require('electron'), [join(project, 'tests/runtime-tracking-smoke.cjs')], { cwd: project, detached: process.platform !== 'win32', stdio: 'inherit',
      env: { ...process.env, NYORA_TRACKING_SMOKE_PROFILE: profile, NYORA_TRACKING_SMOKE_NONCE: nonce, NYORA_TRACKING_SMOKE_PHASE: phase, NYORA_TRACKING_SMOKE_RESOURCES: resources || '', NYORA_TRACKING_SMOKE_VERSION: currentPackage.version } });
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
        timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); escalation = setTimeout(() => terminate('SIGKILL'), 3000); }, 45000);
      });
      assert.equal(interrupted, false); assert.equal(timedOut, false, 'Native tracker fixture deadline exceeded'); assert.equal(status.code, 0, `Tracker fixture ${phase} exited with ${status.signal || status.code}`);
      const result = JSON.parse(await readFile(join(profile, `${phase}.json`), 'utf8'));
      assert.equal(result.nonce, nonce); assert.equal(result.resources, resources); assert.equal(result.appVersion, currentPackage.version);
      assert.equal(result.phase, phase); assert.equal(result.passed, true); assert.equal(result.productionTransport, 'TrackingBroker'); checks.push(...result.checks);
    } finally { clearTimeout(timer); clearTimeout(escalation); }
  }
  const result = { passed: true, nonce, resources, appVersion: currentPackage.version, platform: process.platform, arch: process.arch, productionTransport: 'TrackingBroker', checks };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); clearTimeout(escalation); terminate('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
