import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildFrontend, desktopRoot } from './build-frontend.mjs';
import { readFile, access, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageTarget, verifyHelperTarget } from './package-target.mjs';
import { runtimeTree, verifyJava, verifyBundledHelper, javaName } from './runtime-validation.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const allowed = new Set(['--dir', '--mac', '--win', '--linux', '--x64', '--arm64']);
if (args.some((arg) => !allowed.has(arg))) throw new Error('Only directory/platform/architecture packaging flags are accepted.');
const target = packageTarget(args);
const helper = resolve(desktopRoot, 'resources/helper');
const manifest = await readFile(resolve(helper, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => { throw new Error('Missing helper runtime manifest. Run npm run build:helper on the target platform and architecture first.'); });
verifyHelperTarget(manifest, target);
if (target.platform !== process.platform || target.arch !== process.arch) throw new Error('Runtime execution gates require packaging on a matching native OS/architecture runner.');
await access(resolve(helper, 'nyora-helper.jar'));
await access(resolve(helper, 'jre/bin', target.platform === 'win32' ? 'java.exe' : 'java'));
for (const [file, expected] of [['nyora-helper.jar', manifest.jarSha256], ['catalogue.json', manifest.catalogueSha256]]) {
  const bytes = await readFile(resolve(helper, file));
  if (!/^[a-f0-9]{64}$/.test(expected || '') || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`Staged helper ${file} failed its manifest integrity check. Rebuild the native helper before packaging.`);
  }
}
if (!manifest.validation?.jvmTestsPassed || !manifest.validation?.jit || !manifest.validation?.interpreted || !manifest.validation?.nativeZip
  || !manifest.validation?.sqliteWrite || !manifest.validation?.restart
  || manifest.runtime?.treeSha256 !== (await runtimeTree(resolve(helper, 'jre'))).sha256) {
  throw new Error('Bundled Java runtime is unverified or changed. Rebuild it before packaging.');
}
// Re-run on this host even when resources were staged on an earlier OS version.
await verifyJava(resolve(helper, 'jre/bin', javaName));
await verifyBundledHelper(helper);
async function run(args) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: desktopRoot, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Packaging validation failed: ${signal || code}`)));
  });
}
const tests = [
  ...(await readdir(resolve(desktopRoot, 'tests'))).filter(name => /^(frontend|helper).*\.test\.mjs$/.test(name)).map(name => `tests/${name}`),
  ...(await readdir(resolve(desktopRoot, 'electron'))).filter(name => name.endsWith('.test.cjs')).map(name => `electron/${name}`),
];
await run(['--test', ...tests]);
await run(['tests/runtime-catalogue-smoke.mjs']);
const catalogueChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-catalogue-smoke/result.json'), 'utf8'));
await buildFrontend();
// Cookie durability alone cannot catch a UI that never resumes after close.
// Exercise the built shared interface's automatic verification/retry flow too.
// The browser UI smoke is the one stage whose timing depends on runner speed:
// slow macOS runners have tripped render races in it that a fast machine never
// sees. Give it exactly one retry; a real regression fails both attempts.
await run(['scripts/smoke-frontend.mjs', '--no-build']).catch(async (error) => {
  console.warn(`Frontend smoke failed (${error.message}); retrying once`);
  await run(['scripts/smoke-frontend.mjs', '--no-build']);
});
const builder = require.resolve('electron-builder/cli.js');
// Build the app directory first. An unusable bundled JVM cannot enter an installer.
await run([builder, ...args.filter(arg => arg !== '--dir'), '--dir', '--publish', 'never']);
const configuration = JSON.parse(await readFile(resolve(desktopRoot, 'package.json')));
const output = resolve(desktopRoot, configuration.build.directories.output);
const suffix = target.arch === 'x64' ? '' : `-${target.arch}`;
const unpacked = resolve(output, target.platform === 'darwin' ? `mac${suffix}` : `${target.platform === 'win32' ? 'win' : 'linux'}${suffix}-unpacked`);
const appDirectory = target.platform === 'darwin' ? resolve(unpacked, `${configuration.build.productName}.app`) : unpacked;
const packagedHelper = resolve(appDirectory, target.platform === 'darwin' ? 'Contents/Resources/helper' : 'resources/helper');
if ((await runtimeTree(resolve(packagedHelper, 'jre'))).sha256 !== manifest.runtime.treeSha256) throw new Error('Packaged runtime differs from the validated runtime');
const packagedChecks = await verifyBundledHelper(packagedHelper);
// Exercise the assembled ASAR and its own helper through Chromium before an
// installer can ship. This catches image URL, source rewrite and HTTP regressions.
await run(['tests/runtime-images-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const imageChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-images-smoke/result.json'), 'utf8'));
// Real Chromium must carry partitioned clearance from the verification window
// through the copied production transport, including reset and cancellation.
await run(['tests/runtime-cf-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const cloudflareChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-cf-smoke/result.json'), 'utf8'));
await run(['tests/runtime-cookies-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const cookieChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-cookies-smoke/result.json'), 'utf8'));
await run(['tests/runtime-recovery-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const recoveryChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-recovery-smoke/result.json'), 'utf8'));
await run(['tests/runtime-offline-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const offlineChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-offline-smoke/result.json'), 'utf8'));
await run(['tests/runtime-tracking-smoke.mjs', '--resources', resolve(packagedHelper, '..')]);
const accountChecks = JSON.parse(await readFile(resolve(desktopRoot, 'test-results/runtime-tracking-smoke/result.json'), 'utf8'));
await writeFile(resolve(output, `runtime-validation-${target.platform}-${target.arch}.json`), JSON.stringify({
  ...target, jarSha256: manifest.jarSha256, runtimeSha256: manifest.runtime.treeSha256, javaIdentity: manifest.javaIdentity,
  packaged: packagedChecks, recovery: recoveryChecks, offline: offlineChecks, accounts: accountChecks, images: imageChecks, cloudflare: cloudflareChecks, cookies: cookieChecks,
  frontend: { passed: true, automaticVerificationRecovery: true, automaticReaderImageRecovery: true, manualCookieControl: false,
    libraryTools: true, commandPalette: true, shortcutHelp: true, downloadQueueControls: true,
    searchMotion: true, reducedMotion: true },
  catalogue: { sources: catalogueChecks.runtime, cloudflare: catalogueChecks.cloudflare.eligible,
    wallB: catalogueChecks.wallB.eligible, knownChallengeOnlyOverrides: catalogueChecks.knownChallengeOnlyOverrides,
    sourceRequests: catalogueChecks.sourceRequests },
}, null, 2));
if (!args.includes('--dir')) await run([builder, ...args, '--prepackaged', appDirectory, '--publish', 'never']);
