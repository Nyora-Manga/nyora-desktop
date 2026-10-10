import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function hashTree(root) {
  const hashes = [];
  async function walk(dir, rel = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Frontend input contains a symlink: ${key}`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), key);
      else if (entry.isFile()) hashes.push([key, createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex')]);
    }
  }
  await walk(root);
  return { sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), fileCount: hashes.length };
}

export async function createFrontendManifest(desktopRoot, webRoot, snapshot) {
  if (!snapshot?.sourceRoot || !snapshot?.overlayRoot || !snapshot?.scriptsRoot) throw new Error('Provenance requires captured build inputs.');
  const [{ stdout: head }, { stdout: changes }, tree, overlay, scripts, lock, pkg] = await Promise.all([
    exec('git', ['-C', webRoot, 'rev-parse', 'HEAD']).catch(() => ({ stdout: '' })),
    exec('git', ['-C', webRoot, 'status', '--porcelain', '--untracked-files=all']).catch(() => ({ stdout: 'unavailable' })),
    hashTree(snapshot.sourceRoot),
    hashTree(snapshot.overlayRoot),
    hashTree(snapshot.scriptsRoot),
    readFile(join(desktopRoot, 'package-lock.json')),
    readFile(join(desktopRoot, 'package.json'), 'utf8'),
  ]);
  return {
    schemaVersion: 2,
    mode: 'desktop',
    appVersion: JSON.parse(pkg).version,
    source: { gitHead: head.trim() || null, dirty: changes.length > 0, webTree: tree },
    overlay,
    scripts,
    packageLockSha256: createHash('sha256').update(lock).digest('hex'),
    packageJsonSha256: createHash('sha256').update(pkg).digest('hex'),
    runtimePins: { electron: JSON.parse(pkg).devDependencies.electron, electronBuilder: JSON.parse(pkg).devDependencies['electron-builder'] },
  };
}

export async function assertBuildInputsStable(desktopRoot, manifest) {
  const [overlay, scripts, pkg, lock] = await Promise.all([
    hashTree(join(desktopRoot, 'frontend')), hashTree(join(desktopRoot, 'scripts')),
    readFile(join(desktopRoot, 'package.json')), readFile(join(desktopRoot, 'package-lock.json')),
  ]);
  for (const [name, actual, expected] of [
    ['frontend overlay', overlay.sha256, manifest.overlay.sha256],
    ['build scripts', scripts.sha256, manifest.scripts.sha256],
    ['package.json', createHash('sha256').update(pkg).digest('hex'), manifest.packageJsonSha256],
    ['package-lock.json', createHash('sha256').update(lock).digest('hex'), manifest.packageLockSha256],
  ]) if (actual !== expected) throw new Error(`Build inputs changed during packaging: ${name}. Rebuild from stable inputs.`);
}
