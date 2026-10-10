import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFrontendManifest, assertBuildInputsStable } from './frontend-manifest.mjs';

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const webRoot = resolve(process.env.NYORA_WEB_DIR || resolve(desktopRoot, 'vendor/web'));
const require = createRequire(import.meta.url);

export async function buildFrontend() {
  const lockPath = resolve(desktopRoot, '.frontend-build.lock');
  let lock;
  const started = Date.now();
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx');
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''));
      if (pid > 0) {
        try { process.kill(pid, 0); }
        catch (check) { if (check.code === 'ESRCH') { await rm(lockPath, { force: true }); continue; } }
      }
      if (Date.now() - started > 30_000) throw new Error('Another frontend build still owns the output directory.');
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  try { return await buildLockedFrontend(); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function buildLockedFrontend() {
  const source = resolve(webRoot, 'web');
  const stage = resolve(desktopRoot, '.frontend-stage');
  const stagedWeb = resolve(stage, 'web');
  const stagedOverlay = resolve(stage, 'frontend');
  const stagedScripts = resolve(stage, 'scripts');
  const out = resolve(stage, 'output');
  const finalOut = resolve(desktopRoot, 'dist');
  await readFile(resolve(source, 'vendor/ort/ort.min.mjs')).catch(() => {
    throw new Error(`Missing ${source}/vendor/ort/ort.min.mjs. Fetch ORT in the shared Nyora Web checkout before building.`);
  });
  await rm(stage, { recursive: true, force: true });
  try {
    await cp(source, stagedWeb, { recursive: true });
    await cp(resolve(desktopRoot, 'frontend'), stagedOverlay, { recursive: true });
    await cp(resolve(desktopRoot, 'scripts'), stagedScripts, { recursive: true });
    const manifest = await createFrontendManifest(desktopRoot, webRoot, { sourceRoot: stagedWeb, overlayRoot: stagedOverlay, scriptsRoot: stagedScripts });
    await assertBuildInputsStable(desktopRoot, manifest);
    // Execute the captured transformations and bundle the captured overlay;
    // neither path can pick up live edits after its provenance was recorded.
    const { overlayApp, overlaySettings, overlayWelcome, overlayHtml, replaceOnce } = await import(pathToFileURL(resolve(stagedScripts, 'frontend-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayNativeStore, overlayNativeSettings, overlayNativeMisc } = await import(pathToFileURL(resolve(stagedScripts, 'native-service-overlay.mjs')).href + `?build=${Date.now()}`);
    const { awaitNativeMutations } = await import(pathToFileURL(resolve(stagedScripts, 'native-mutation-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayDesktopShortcuts } = await import(pathToFileURL(resolve(stagedScripts, 'desktop-shortcuts-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayLibraryTools, overlayReadingRoomCards } = await import(pathToFileURL(resolve(stagedScripts, 'library-tools-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayDownloadControls } = await import(pathToFileURL(resolve(stagedScripts, 'download-controls-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayReaderParity } = await import(pathToFileURL(resolve(stagedScripts, 'reader-parity-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlaySourceFilters } = await import(pathToFileURL(resolve(stagedScripts, 'source-filters-overlay.mjs')).href + `?build=${Date.now()}`);
    const { overlayReadingRoom } = await import(pathToFileURL(resolve(stagedScripts, 'reading-room-overlay.mjs')).href + `?build=${Date.now()}`);
    for (const [file, transform] of [['app.js', overlayApp], ['screens/settings.js', overlaySettings], ['screens/welcome.js', overlayWelcome], ['index.html', overlayHtml]]) {
      const path = resolve(stagedWeb, file);
      await writeFile(path, transform(await readFile(path, 'utf8')));
    }
    const storePath = resolve(stagedWeb, 'core/store.js');
    await writeFile(storePath, overlayNativeStore(await readFile(storePath, 'utf8')));
    const settingsPath = resolve(stagedWeb, 'screens/settings.js');
    await writeFile(settingsPath, overlayNativeSettings(await readFile(settingsPath, 'utf8')));
    await writeFile(resolve(stagedWeb, 'screens/local.js'), `export {meta,render,default} from 'nyora-native-local';\n`);
    await writeFile(resolve(stagedWeb, 'core/migrations.js'), 'export async function runMigrations() {}\n');
    await writeFile(resolve(stagedWeb, 'core/changelog.js'), "export const APP_VERSION='0.1.0'; export function shouldShowChangelog(){return false;} export function showChangelog(){} export function markChangelogSeen(){}\n");
    const overlayModules = async (dir, rel = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) { if (key !== 'vendor') await overlayModules(path, key); }
        else if (entry.name.endsWith('.js') && (key.startsWith('screens/') || key === 'core/ui.js' || key === 'app.js')) {
          let source = overlayNativeMisc(key, await readFile(path, 'utf8'));
          if (key === 'screens/library.js') source = overlayLibraryTools(source);
          let transformed = awaitNativeMutations(source, key).source;
          transformed = overlayDesktopShortcuts(key, transformed);
          if (key === 'screens/explore.js') transformed = overlaySourceFilters(transformed);
          if (key === 'screens/downloads.js') transformed = overlayDownloadControls(transformed);
          transformed = overlayReadingRoom(transformed, key);
          transformed = overlayReaderParity(transformed, key);
          if (key === 'core/ui.js') transformed = overlayReadingRoomCards(transformed);
          await writeFile(path, transformed);
        }
      }
    };
    await overlayModules(stagedWeb);
    const sharedStyles = resolve(stagedWeb, 'styles.css');
    await writeFile(sharedStyles, replaceOnce(await readFile(sharedStyles, 'utf8'),
      ':focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }',
      ':focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
      'preserve control shape on focus'));
    // Desktop-only typography, captured alongside the other build inputs.
    for (const file of ['overlay.js', 'bubble-layout.js']) {
      await cp(resolve(stagedOverlay, 'translation', file), resolve(stagedWeb, 'core/translate', file));
    }
    const translationWorker = resolve(stagedWeb, 'core/translate/tl-worker.js');
    const workerSource = replaceOnce(await readFile(translationWorker, 'utf8'),
      "  post({ type: 'page-result', id, blocks });",
      "  post({ type: 'page-result', id, blocks: addBubbleLayouts(sctx, blocks, W, H, rects) });",
      'translation bubble layout');
    await writeFile(translationWorker, "import { addBubbleLayouts } from './bubble-layout.js';\n" + workerSource);
    const htmlPath = resolve(stagedWeb, 'index.html');
    await writeFile(htmlPath, (await readFile(htmlPath, 'utf8')).replace('<script src="/boot/theme.js"></script>', ''));
    await writeFile(resolve(stagedWeb, 'core/sync.js'), `export * from 'nyora-native-sync'; export {default} from 'nyora-native-sync';\n`);
    await writeFile(resolve(stagedWeb, 'core/auto-sync.js'), 'export function initAutoSync() {}\n');
    await rm(resolve(stagedWeb, 'sw.js'));
    await rm(resolve(stagedWeb, 'boot/migrate.js'));
    await rm(resolve(stagedWeb, 'manifest.webmanifest'));
    await rm(resolve(stagedWeb, 'boot/theme.js'));
    // Deployment metadata and ad-hoc web debug pages are not app assets.
    for (const name of await readdir(stagedWeb)) {
      if (/^_.*\.html$/.test(name) || ['_headers', '_redirects', 'llms.txt', 'robots.txt', 'sitemap.xml'].includes(name)) await rm(resolve(stagedWeb, name));
    }
    const stagingEntry = resolve(stagedWeb, 'desktop.js');
    await writeFile(stagingEntry, `import ${JSON.stringify(resolve(stagedOverlay, 'desktop.js'))};\n`);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(stagedWeb, out, { recursive: true });
    const desktopStyles = await Promise.all(['desktop.css', 'desktop-motion.css', 'desktop-commands.css', 'reading-room.css', 'library-tools.css', 'download-controls.css', 'reading-room-screens.css', 'source-filters.css', 'reader-parity.css', 'input-focus.css']
      .map(file => readFile(resolve(stagedOverlay, file), 'utf8')));
    await writeFile(resolve(out, 'desktop.css'), desktopStyles.join('\n'));
    await cp(resolve(stagedOverlay, 'fonts'), resolve(out, 'fonts'), { recursive: true });
    await cp(resolve(stagedOverlay, 'service-contract.json'), resolve(out, 'service-contract.json'));
    const workerPaths = ['core/translate/tl-worker.js', 'core/colorize/worker.js'];
    const common = { bundle: true, minify: true, format: 'esm', target: ['es2020'], legalComments: 'none' };
    await build({ ...common, entryPoints: workerPaths.map((p) => resolve(stagedWeb, p)), outdir: out, outbase: stagedWeb });
    const workerId = createHash('sha256').update(await readFile(resolve(out, workerPaths[1]))).digest('hex').slice(0, 12);
    await build({ ...common, target: ['es2022'], entryPoints: [stagingEntry], outdir: out, entryNames: 'desktop', chunkNames: 'chunk-[hash]', splitting: true, metafile: true,
      define: { __NYORA_APP_VERSION__: JSON.stringify(manifest.appVersion), __NYORA_COLORIZER_WORKER_URL__: JSON.stringify(`/core/colorize/worker.js?v=${workerId}`) },
      plugins: [{ name: 'desktop-shared-boundary', setup(builder) {
        for (const [name,file] of Object.entries({'nyora-reader-parity':'reader-parity.js','nyora-source-filters':'source-filters.js','nyora-source-filter-state':'source-filter-state.js','nyora-library-presentation':'library-presentation.js','nyora-library-tools':'library-tools.js','nyora-native-about':'native-about.js','nyora-native-sync':'native-sync.js','nyora-native-local':'native-local.js','nyora-native-runtime':'runtime-panel.js'})) builder.onResolve({filter:new RegExp(`^${name}$`)},()=>({path:resolve(stagedOverlay,file)}));
        builder.onResolve({ filter: /^nyora-native-services$/ }, () => ({ path: resolve(stagedOverlay, 'native-services.js') }));
        builder.onResolve({ filter: /^nyora-native-backup$/ }, () => ({ path: resolve(stagedOverlay, 'native-backup.js') }));
        builder.onResolve({ filter: /^nyora-native-images$/ }, () => ({ path: resolve(stagedOverlay, 'native-images.js') }));
        builder.onResolve({ filter: /^nyora-source-verification$/ }, () => ({ path: resolve(stagedOverlay, 'source-verification.js') }));
        builder.onResolve({ filter: /^nyora-shared-ui$/ }, () => ({ path: resolve(stagedWeb, 'core/ui.js') }));
        builder.onResolve({ filter: /^nyora-shared-store$/ }, () => ({ path: resolve(stagedWeb, 'core/store.js') }));
        const replacements = { 'library.js': 'native-library.js', 'api.js': 'native-api.js', 'source-preferences.js': 'native-source-preferences.js', 'source-identity.js': 'native-source-identity.js', 'downloads.js': 'native-downloads.js', 'tracking.js': 'native-tracking.js', 'local-reader.js':'native-local-reader.js' };
        builder.onResolve({ filter: /(library|api|source-preferences|source-identity|downloads|tracking|local-reader)\.js$/ }, (args) => {
          for (const [shared, native] of Object.entries(replacements)) if (resolve(dirname(args.importer), args.path) === resolve(stagedWeb, 'core', shared)) return { path: resolve(stagedOverlay, native) };
        });
        builder.onResolve({ filter: /^\.\/shared-app\.js$/ }, () => ({ path: resolve(stagedWeb, 'app.js') }));
        builder.onResolve({ filter: /vendor\/md-elevated-card\.js$/ }, () => ({ path: require.resolve('@material/web/labs/card/elevated-card.js') }));
      } }],
      nodePaths: [resolve(desktopRoot, 'node_modules')],
    });
    const keep = new Set(['desktop.js', 'env.js', 'oauth.js', 'boot/theme.js', ...workerPaths]);
    const prune = async (dir, rel = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (key === 'vendor/ort') continue;
          await prune(path, key);
        } else if (entry.name.endsWith('.js') && !keep.has(key) && !entry.name.startsWith('chunk-') && key !== 'vendor/gsap.min.js') await rm(path);
      }
    };
    await prune(out);
    await writeFile(resolve(out, 'env.js'), `// Desktop services use only the native preload boundary.\nglobalThis.NYORA_SYNC_URL = '';\n`);
    for (const file of await readdir(out)) if (/^(desktop|chunk-.*)\.js$/.test(file) && /\blocalStorage\s*[.\[]|\bindexedDB\s*[.\[]/.test(await readFile(resolve(out, file), 'utf8'))) throw new Error(`Browser personal storage leaked into desktop bundle: ${file}`);
    await writeFile(resolve(out, 'frontend-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await assertBuildInputsStable(desktopRoot, manifest);
    const previous = resolve(desktopRoot, '.frontend-previous');
    await rm(previous, { recursive: true, force: true });
    const hadPrevious = await rename(finalOut, previous).then(() => true).catch((error) => { if (error.code === 'ENOENT') return false; throw error; });
    try { await rename(out, finalOut); }
    catch (error) { if (hadPrevious) await rename(previous, finalOut); throw error; }
    await rm(previous, { recursive: true, force: true });
    console.log(`Built desktop/dist from ${source}`);
    return finalOut;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildFrontend();
