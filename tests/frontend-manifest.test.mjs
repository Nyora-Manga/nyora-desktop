import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTree, createFrontendManifest, assertBuildInputsStable } from '../scripts/frontend-manifest.mjs';

test('input manifest hashes file names and exact bytes deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nyora-manifest-'));
  try {
    await writeFile(join(root, 'b.txt'), 'second');
    await writeFile(join(root, 'a.txt'), 'first');
    const before = await hashTree(root);
    assert.equal(before.fileCount, 2);
    assert.deepEqual(await hashTree(root), before);
    await writeFile(join(root, 'a.txt'), 'modified');
    assert.notEqual((await hashTree(root)).sha256, before.sha256);
    await rm(join(root, 'a.txt'));
    await writeFile(join(root, 'c.txt'), 'first');
    assert.notEqual((await hashTree(root)).sha256, before.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provenance describes captured bytes after live source changes and rejects overlay/script drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nyora-snapshot-'));
  const desktop = join(root, 'desktop');
  const web = join(root, 'shared');
  const snapshot = { sourceRoot: join(root, 'snapshot/web'), overlayRoot: join(root, 'snapshot/frontend'), scriptsRoot: join(root, 'snapshot/scripts') };
  try {
    for (const dir of [join(web, 'web'), join(desktop, 'frontend'), join(desktop, 'scripts')]) await mkdir(dir, { recursive: true });
    await writeFile(join(web, 'web/app.js'), 'captured source');
    await writeFile(join(desktop, 'frontend/adapter.js'), 'captured adapter');
    await writeFile(join(desktop, 'scripts/build.mjs'), 'captured script');
    await writeFile(join(desktop, 'package.json'), JSON.stringify({version:'9.8.7', devDependencies: { electron: '44.5.1', 'electron-builder': '26.15.3' } }));
    await writeFile(join(desktop, 'package-lock.json'), '{}');
    await cp(join(web, 'web'), snapshot.sourceRoot, { recursive: true });
    await cp(join(desktop, 'frontend'), snapshot.overlayRoot, { recursive: true });
    await cp(join(desktop, 'scripts'), snapshot.scriptsRoot, { recursive: true });
    const capturedTree = await hashTree(snapshot.sourceRoot);
    await writeFile(join(web, 'web/app.js'), 'a newer edit not packaged');
    const manifest = await createFrontendManifest(desktop, web, snapshot);
    assert.equal(manifest.appVersion,'9.8.7');
    assert.deepEqual(manifest.source.webTree, capturedTree);
    assert.notEqual(manifest.source.webTree.sha256, (await hashTree(join(web, 'web'))).sha256);
    await assertBuildInputsStable(desktop, manifest);
    await writeFile(join(desktop, 'frontend/adapter.js'), 'unexpected live adapter edit');
    await assert.rejects(assertBuildInputsStable(desktop, manifest), /frontend overlay/);
    await writeFile(join(desktop, 'frontend/adapter.js'), 'captured adapter');
    await writeFile(join(desktop, 'scripts/build.mjs'), 'unexpected live script edit');
    await assert.rejects(assertBuildInputsStable(desktop, manifest), /build scripts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
