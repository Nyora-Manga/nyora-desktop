import { cp, mkdtemp, mkdir, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stage the real application without altering production resource selection.
// Missing-helper coverage stays deterministic even after a helper is packaged.
export async function runtimeFixture(project, { bundledHelper = false } = {}) {
  if (bundledHelper && !(await stat(join(project, 'resources/helper/manifest.json')).catch(() => null))?.isFile()) {
    throw new Error('Bundled helper missing: run npm run build:helper before the native runtime smoke');
  }
  const root = await mkdtemp(join(tmpdir(), 'nyora-runtime-fixture-'));
  const app = join(root, 'app');
  try {
    await mkdir(app);
    await cp(join(project, 'electron'), join(app, 'electron'), { recursive: true });
    await cp(join(project, 'dist'), join(app, 'dist'), { recursive: true });
    await cp(join(project, 'package.json'), join(app, 'package.json'));
    if (bundledHelper) {
      await mkdir(join(app, 'resources'));
      await symlink(join(project, 'resources/helper'), join(app, 'resources/helper'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const metadata = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    return { app, appVersion: metadata.version, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
