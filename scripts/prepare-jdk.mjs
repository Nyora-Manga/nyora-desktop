import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { javaName, runtimeCommand, runtimeTree, verifyJava } from './runtime-validation.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function pinnedRuntime() {
  const lock = JSON.parse(await readFile(join(desktop, 'runtime-lock.json'), 'utf8'));
  if (lock.schema !== 1) throw new Error('Unknown runtime lock schema');
  return lock.runtimes[`${process.platform}-${process.arch}`];
}
export async function verifyArchive(file, pin) {
  if ((await stat(file)).size !== pin.bytes) throw new Error('Runtime archive size does not match the pin');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== pin.sha256) throw new Error('Runtime archive SHA256 does not match the pin');
}

export async function prepareJdk({ archivePath } = {}) {
  const pin = await pinnedRuntime();
  if (!pin) throw new Error(`No verified runtime pin for ${process.platform}/${process.arch}. Supply NYORA_JDK_DIR on a matching native runner; it must pass the runtime gates.`);
  const cache = join(desktop, '.runtime');
  const destination = join(cache, pin.sha256);
  const home = join(destination, pin.home);
  await mkdir(cache, { recursive: true });
  try {
    const receipt = JSON.parse(await readFile(join(destination, 'verified.json'), 'utf8'));
    if (receipt.archiveSha256 !== pin.sha256 || receipt.treeSha256 !== (await runtimeTree(home)).sha256) throw new Error('Cached JDK changed; remove its .runtime cache directory and run setup:runtime again');
    await verifyJava(join(home, 'bin', javaName), { pin, cwd: cache });
    return { home, pin };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(cache, '.stage-'));
  try {
    const archive = join(stage, 'runtime.tar.gz');
    if (archivePath) await cp(resolve(archivePath), archive);
    else {
      const response = await fetch(pin.url, { redirect: 'error', signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`Pinned runtime download failed (${response.status})`);
      let size = 0;
      await pipeline(response.body, new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length; done(size > pin.bytes ? new Error('Runtime download exceeds pinned size') : null, chunk);
      } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    }
    await verifyArchive(archive, pin);
    await runtimeCommand('/usr/bin/tar', ['-xzf', archive, '-C', stage], { cwd: stage, timeout: 60000 });
    await rm(archive);
    const stagedHome = join(stage, pin.home);
    await verifyJava(join(stagedHome, 'bin', javaName), { pin, cwd: stage });
    await writeFile(join(stage, 'verified.json'), JSON.stringify({ archiveSha256: pin.sha256, treeSha256: (await runtimeTree(stagedHome)).sha256 }, null, 2));
    await rename(stage, destination);
    console.log(`Prepared pinned ${pin.distribution} ${pin.version} for ${process.platform}/${process.arch}`);
    return { home, pin };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--archive')) throw new Error('Usage: setup:runtime [-- --archive /path/to/pinned-archive.tar.gz]');
  await prepareJdk({ archivePath: args[1] });
}
