import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileCatalogue } from '../electron/catalogue.cjs';
import { pinnedRuntime, prepareJdk } from './prepare-jdk.mjs';
import { runtimeEnv, runtimeTree, verifyJava, verifyJitAndNativeLibraries, verifyBundledHelper } from './runtime-validation.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = (name) => process.platform === 'win32' ? `${name}.exe` : name;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function command(file, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options });
    let output = '';
    child.stdout?.on('data', (part) => { output += part; });
    child.stderr?.on('data', (part) => { output += part; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done(output.trim()) : reject(new Error(`${file} exited with ${signal || code}${options.capture ? `: ${output}` : ''}`)));
  });
}

async function sourceManifest(root) {
  const files = {};
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.gradle', 'build', 'node_modules'].includes(entry.name) || entry.name.startsWith('.env')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isFile() && /\.(kt|kts|sq|sqm|json|properties|jar)$/.test(entry.name)) files[name] = digest(await readFile(full));
    }
  }
  await walk(root);
  return { treeSha256: digest(JSON.stringify(files)), files };
}

export async function packageHelper() {
  const shared = resolve(process.env.NYORA_SHARED_DIR || join(desktop, 'vendor/helper'));
  // Ambient JAVA_HOME/system discovery previously selected incompatible JVMs.
  // Default to the reviewed archive; an explicit path must meet the same pin.
  const selected = process.env.NYORA_JDK_DIR
    ? { home: resolve(process.env.NYORA_JDK_DIR), pin: await pinnedRuntime() }
    : await prepareJdk();
  const jdk = selected.home;
  const java = join(jdk, 'bin', executable('java'));
  const jlink = join(jdk, 'bin', executable('jlink'));
  const release = await readFile(join(jdk, 'release'), 'utf8');
  if (!/^JAVA_VERSION="17[.\"]/m.test(release)) throw new Error('Desktop helper packaging requires JDK 17');
  const javaArch = release.match(/^OS_ARCH="([^"]+)"/m)?.[1];
  const expected = { arm64: ['aarch64', 'arm64'], x64: ['x86_64', 'amd64'] }[process.arch];
  if (!expected?.includes(javaArch)) throw new Error('JDK architecture must match the build host; use native platform/architecture runners');
  const jdkProbeDirectory = await mkdtemp(join(desktop, '.jdk-probe-'));
  let javaIdentity;
  try { javaIdentity = await verifyJava(java, { pin: selected.pin, cwd: jdkProbeDirectory }); }
  finally { await rm(jdkProbeDirectory, { recursive: true, force: true }); }
  const buildEnv = { ...runtimeEnv(), JAVA_HOME: jdk };
  const before = await sourceManifest(shared);
  const rawCatalogue = await readFile(join(shared, 'data/catalogue.json'));
  if (digest(rawCatalogue) !== before.files['data/catalogue.json']) throw new Error('Catalogue changed while reading helper inputs');
  // Gradle must not execute auto-detected Intel/system JVMs while probing tools.
  const args = ['--no-daemon', '-Dorg.gradle.jvmargs=-Xmx2048m', '-Pkotlin.compiler.execution.strategy=in-process', '-Porg.gradle.java.installations.auto-detect=false', '-Porg.gradle.java.installations.auto-download=false', 'jvmTest', 'helperJar'];
  if (process.platform === 'win32') {
    // cmd.exe is only used for the checked-in fixed Gradle wrapper filename.
    await command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `gradlew.bat ${args.join(' ')}`], { cwd: shared, env: buildEnv });
  } else await command(join(shared, 'gradlew'), args, { cwd: shared, env: buildEnv });
  const after = await sourceManifest(shared);
  if (before.treeSha256 !== after.treeSha256) throw new Error('Helper source changed during packaging; retry the build');
  const jar = join(shared, 'build/libs/nyora-helper.jar');
  if (!(await stat(jar)).isFile()) throw new Error('Gradle did not produce nyora-helper.jar');
  const resources = join(desktop, 'resources');
  await mkdir(resources, { recursive: true });
  const stage = await mkdtemp(join(resources, '.helper-stage-'));
  try {
    await cp(jar, join(stage, 'nyora-helper.jar'));
    const catalogueBytes = Buffer.from(JSON.stringify(compileCatalogue(JSON.parse(rawCatalogue.toString('utf8')))));
    await writeFile(join(stage, 'catalogue.json'), catalogueBytes);
    // Preserve JDK legal notices and all modules initially. Runtime reduction
    // needs a verified module audit of Kotlin engines, JDBC and image codecs.
    await command(jlink, ['--add-modules', 'ALL-MODULE-PATH', '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=2', '--output', join(stage, 'jre')], { env: buildEnv });
    await verifyJava(join(stage, 'jre/bin', executable('java')), { pin: selected.pin, cwd: stage });
    const runtimeChecks = await verifyJitAndNativeLibraries(jdk, join(stage, 'jre'));
    const helperChecks = await verifyBundledHelper(stage);
    const runtime = await runtimeTree(join(stage, 'jre'));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({
      schema: 1, platform: process.platform, arch: process.arch,
      protocol: 'nyora-desktop-helper/1', jarSha256: digest(await readFile(join(stage, 'nyora-helper.jar'))),
      catalogueSha256: digest(catalogueBytes),
      javaReleaseSha256: digest(release), javaIdentity, source: after,
      runtime: { treeSha256: runtime.sha256, files: runtime.files,
        archiveSha256: process.env.NYORA_JDK_DIR ? null : selected.pin?.sha256 || null,
        selection: process.env.NYORA_JDK_DIR ? 'explicit-validated-jdk' : 'verified-pinned-archive',
        distribution: process.env.NYORA_JDK_DIR ? javaIdentity.vendor : selected.pin?.distribution || javaIdentity.vendor },
      validation: { jvmTestsPassed: true, ...runtimeChecks, ...helperChecks, platform: process.platform, arch: process.arch, osRelease: (await import('node:os')).release() },
    }, null, 2));
    const destination = join(resources, 'helper');
    const previous = join(resources, '.helper-previous');
    await rm(previous, { recursive: true, force: true });
    let replaced = false;
    try { await rename(destination, previous); replaced = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, destination); }
    catch (error) { if (replaced) await rename(previous, destination); throw error; }
    await rm(previous, { recursive: true, force: true });
    console.log(`Packaged isolated helper and Java 17 for ${process.platform}/${process.arch}`);
    return destination;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageHelper();
