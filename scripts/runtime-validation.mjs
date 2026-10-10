import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative as relativePath, sep } from 'node:path';
import { ManagedHelper } from '../electron/helper.cjs';
import { SourceRelay } from '../electron/relay.cjs';

export const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
export const runtimeEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) =>
  !/^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH)$/i.test(key)));

export function runtimeCommand(file, args, { cwd, env = runtimeEnv(), timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        child.kill('SIGKILL');
      }
      child.stdout.destroy(); child.stderr.destroy();
      reject(new Error(`Runtime validation failed (timeout): ${file}`));
    }, timeout);
    const collect = chunk => { output = (output + chunk).slice(-65536); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error(`Runtime validation failed (${timedOut ? 'timeout' : signal || `exit ${code}`}): ${file}\n${output.trim()}`));
      else resolve(output.trim());
    });
  });
}

export async function verifyJava(java, { arch = process.arch, pin, cwd } = {}) {
  const output = await runtimeCommand(java, ['-XshowSettings:properties', '-version'], { cwd });
  const property = name => output.match(new RegExp(`^\\s*${name.replaceAll('.', '\\.')} = (.+)$`, 'm'))?.[1].trim();
  const actual = { arch: property('os.arch'), version: property('java.runtime.version'), vendor: property('java.vendor') };
  const allowed = { arm64: ['aarch64', 'arm64'], x64: ['x86_64', 'amd64'] }[arch];
  if (!allowed?.includes(actual.arch) || !actual.version?.startsWith('17.')) throw new Error('Runtime must execute natively on the target architecture with Java 17');
  if (pin && (actual.vendor !== pin.vendor || actual.version !== pin.version)) throw new Error('Runtime does not match the pinned vendor/version');
  return actual;
}

export async function verifyJitAndNativeLibraries(jdk, jre) {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-java-probe-'));
  try {
    await writeFile(join(directory, 'NyoraRuntimeProbe.java'), `
import java.util.zip.*;
public class NyoraRuntimeProbe {
  static long work(int count) { long sum = 0; for (int i = 0; i < count; i++) sum += i; return sum; }
  public static void main(String[] args) {
    if (work(5000000) != 12499997500000L) throw new AssertionError("JIT arithmetic");
    Deflater zip = new Deflater(); zip.setInput(new byte[8192]); zip.finish();
    if (zip.deflate(new byte[1024]) <= 0) throw new AssertionError("Native zip library");
    zip.end(); System.out.println("NYORA_RUNTIME_OK");
  }
}
`);
    await runtimeCommand(join(jdk, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'), ['-d', directory, join(directory, 'NyoraRuntimeProbe.java')], { cwd: directory });
    for (const flags of [[], ['-Xint']]) {
      const result = await runtimeCommand(join(jre, 'bin', javaName), [...flags, '-cp', directory, 'NyoraRuntimeProbe'], { cwd: directory });
      if (result !== 'NYORA_RUNTIME_OK') throw new Error('Native/JIT runtime probe did not complete');
    }
    return { jit: true, interpreted: true, nativeZip: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Hash the linked runtime, including symlink targets, before/after packaging.
export async function runtimeTree(root) {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Runtime root cannot be a symlink');
  const canonicalRoot = await realpath(root);
  const files = {};
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isSymbolicLink()) {
        const target = relativePath(canonicalRoot, await realpath(full));
        if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new Error('Runtime symlink escapes its root');
        files[name] = `link:${await readlink(full)}`;
      }
      else if (entry.isFile()) files[name] = createHash('sha256').update(await readFile(full)).digest('hex');
      else throw new Error('Unsupported runtime filesystem entry');
    }
  }
  await walk(root);
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

// Exercise the actual bundled JVM, native SQLite, isolated profile and restart.
// The private relay refuses all source traffic; this gate never contacts a site.
export async function verifyBundledHelper(root) {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-bundled-helper-check-'));
  const relay = new SourceRelay({ catalogueLookup: () => undefined, sessionForSource: () => { throw new Error('Source traffic is forbidden during runtime validation'); } });
  let helper;
  let failure;
  try {
    const credentials = await relay.start();
    helper = new ManagedHelper({ profileRoot: join(directory, 'profile'), javaPath: join(root, 'jre/bin', javaName), jarPath: join(root, 'nyora-helper.jar'),
      relay: { url: `${credentials.baseUrl}/fetch`, token: credentials.token }, timeout: 30000 });
    const health = await helper.start();
    const created = JSON.parse((await helper.request('/library/categories/create?title=Runtime%20validation', { method: 'POST' })).bytes);
    assert.ok(Number.isSafeInteger(created.id));
    const read = async () => JSON.parse((await helper.request('/library/categories')).bytes).categories;
    assert.ok((await read()).some(item => item.id === created.id && item.title === 'Runtime validation'));
    await helper.stop(); await helper.start();
    assert.ok((await read()).some(item => item.id === created.id && item.title === 'Runtime validation'));
    return { protocol: health.protocol, revision: health.revision, sourceTransport: health.sourceTransport, sqliteWrite: true, restart: true };
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanup = await Promise.allSettled([helper?.stop(), relay.stop()]);
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
    if (!failure && cleanup.some(item => item.status === 'rejected')) throw new AggregateError(cleanup.filter(item => item.status === 'rejected').map(item => item.reason), 'Runtime validation cleanup failed');
  }
}
