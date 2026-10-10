'use strict';
const { app, BrowserWindow, ipcMain, session, Menu, safeStorage, dialog, screen, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sourceKey, publicHttps, bundledUrl, trustedCaller } = require('./policy.cjs');
const { ManagedHelper } = require('./helper.cjs');
const { DevicePreferences } = require('./preferences.cjs');
const { DesktopServices } = require('./services.cjs');
const { SourceRelay } = require('./relay.cjs');
const { BrowserContextTransport } = require('./browser-transport.cjs');
const { CookiePersistence } = require('./cookie-persistence.cjs');
const { SourceVerification } = require('./verification.cjs');
const { ServiceGate } = require('./service-gate.cjs');
const { LocalAppServer } = require('./local-server.cjs');
const { WindowRecovery, HelperReadRecovery } = require('./recovery.cjs');
const { ContentReadRetry } = require('./read-retry.cjs');
const { WindowState } = require('./window-state.cjs');
const { consumerMenu } = require('./menu.cjs');
const { ReaderState } = require('./reader-state.cjs');
const { DesktopFeatures } = require('./features.cjs');
const { DownloadProgress } = require('./download-progress.cjs');

const APP_ID = 'app.nyora.desktop.preview';
const smokeMode = process.argv.includes('--nyora-smoke');
const unsafeSwitches = ['no-sandbox', 'disable-web-security', 'disable-gpu-sandbox', 'remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'];
for (const name of unsafeSwitches) {
  if (app.commandLine.hasSwitch(name)) throw new Error(`Nyora refuses the unsafe startup switch --${name}`);
}
if (smokeMode && app.isPackaged) throw new Error('Runtime smoke is unavailable in packaged applications');
app.enableSandbox();
app.setName('Nyora Preview');
app.setAppUserModelId(APP_ID);

// No existing Nyora client directories are discovered or migrated.
if (smokeMode) {
  const supplied = process.env.NYORA_SMOKE_PROFILE;
  if (!supplied || !path.isAbsolute(supplied)) throw new Error('Smoke requires an absolute NYORA_SMOKE_PROFILE');
  const profile = fs.realpathSync(supplied);
  const temporary = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temporary, profile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Smoke profile must be a dedicated directory within the OS temporary directory');
  }
  const port = Number(process.env.NYORA_SMOKE_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Smoke CDP port must be in 1024..65535');
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
} else {
  const profile = path.join(app.getPath('appData'), APP_ID, 'electron');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
}
const sessionDirectory = path.join(app.getPath('userData'), 'chromium');
fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
app.setPath('sessionData', sessionDirectory);

const sources = new Map();
const verificationTargets = new Map();
const sourceSessions = new Map();
const cookieStores = new Map();
const sourceOperations = new Map();
let mainWindow;
let windowRecovery;
let quitting = false;
let shutdownComplete = false;
let helper;
let services;
let relay;
let browserTransport;
let backup;
let automation;
let localServer;
let features;
const downloadProgress = new DownloadProgress({ window: () => mainWindow });
const serviceGate = new ServiceGate();
const windowState = new WindowState(path.join(app.getPath('userData'), 'device', 'window-state.json'));
const readRecovery = new HelperReadRecovery({ helper: () => helper });
const contentReadRetry = new ContentReadRetry();
let catalogueLookup = () => undefined;
const primaryInstance = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('child-process-gone', (_event, details) => windowRecovery?.gpuFailure(details));
const lookupSource = (sourceId) => {
  if (smokeMode && ['data:smoke-one', 'data:smoke-two'].includes(sourceId)) return {
    sourceId, baseOrigin: 'https://example.org', allowedOrigins: ['https://example.org'], verificationOrigins: ['https://example.org'],
  };
  return catalogueLookup(sourceId);
};
const verification = new SourceVerification(lookupSource);
const { CONTENT_SECURITY_POLICY: CSP } = require('./content-policy.cjs');

function protectSession(ses, remote) {
  const screenWakeLock = (contents, permission, details) => Boolean(!remote && !quitting
    && permission === 'screen-wake-lock' && mainWindow && !mainWindow.isDestroyed()
    && contents === mainWindow.webContents && !contents.isDestroyed()
    && details?.isMainFrame === true && details.requestingUrl === contents.mainFrame?.url
    && bundledUrl(contents.mainFrame?.url, localServer?.origin));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(screenWakeLock(contents, permission, details)));
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => screenWakeLock(contents, permission, details)
    && bundledUrl(requestingOrigin, localServer?.origin));
  ses.on('will-download', event => event.preventDefault());
  if (remote) {
    // Remote sessions have no registered handler for the privileged local scheme.
    ses.webRequest.onBeforeRequest((details, callback) => {
      let allowed = publicHttps(details.url);
      try {
        const url = new URL(details.url);
        if (url.protocol === 'wss:') allowed = publicHttps(details.url.replace(/^wss:/, 'https:'));
        if (url.protocol === 'data:' || url.protocol === 'blob:' || details.url === 'about:blank') allowed = true;
      } catch { /* Refuse invalid URLs. */ }
      callback({ cancel: !allowed });
    });
  }
}

function protectWindow(window, allowedNavigation, allowedSubframe = allowedNavigation, externalLinks = false) {
  const contents = window.webContents;
  const openExternal = url => {
    if (externalLinks && publicHttps(url)) void shell.openExternal(url).catch(() => {
      if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: 'Nyora', message: 'The link could not be opened in your browser.', buttons: ['OK'] });
    });
  };
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, target) => {
    if (!allowedNavigation(event.url ?? target)) { event.preventDefault(); openExternal(event.url ?? target); }
  });
  contents.on('will-frame-navigate', event => {
    if (!(event.isMainFrame ? allowedNavigation : allowedSubframe)(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, target) => {
    if (!(event.isMainFrame === false ? allowedSubframe : allowedNavigation)(event.url ?? target)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
}

function preferences(ses, preload) {
  return {
    session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    devTools: false, ...(preload ? { preload } : {}),
  };
}

function assertCaller(event) {
  if (quitting) throw new Error('Nyora is closing');
  if (!trustedCaller(event, mainWindow, localServer?.origin)) throw new Error('This operation is restricted to the local Nyora main frame');
}

function getSourceSession(key) {
  if (!sourceSessions.has(key)) {
    const ses = session.fromPartition(`persist:source-${key}`, { cache: true });
    protectSession(ses, true);
    sourceSessions.set(key, ses);
    cookieStores.set(key, new CookiePersistence(ses));
  }
  return sourceSessions.get(key);
}

async function withSourceOperation(key, operation) {
  const previous = sourceOperations.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => {
    if (quitting) throw new Error('Nyora is closing');
    return operation();
  });
  sourceOperations.set(key, pending);
  try { return await pending; }
  finally { if (sourceOperations.get(key) === pending) sourceOperations.delete(key); }
}

function registerCommands() {
  ipcMain.handle('nyora:runtime-status', event => {
    assertCaller(event);
    return {
      runtime: 'electron', electronVersion: process.versions.electron,
      browserVersion: process.versions.chrome, appVersion: app.getVersion(),
      profileName: 'local', verificationAvailable: smokeMode || Boolean(relay),
      dataMode: 'native-helper', smokeMode, automation: automation?.status() || {},
      localServer: { state: localServer?.origin ? 'listening' : 'unavailable', origin: localServer?.origin },
      helper: helper?.status || { state: 'unavailable', code: 'HELPER_NOT_PACKAGED' },
    };
  });
  ipcMain.handle('nyora:open-verification', async (event, value) => {
    assertCaller(event);
    const key = sourceKey(value?.sourceId);
    const descriptor = verification.descriptor(value.sourceId);
    return withSourceOperation(key, async () => {
      const sourceSession = getSourceSession(key);
      // Proactive verification may precede the first relay request. Configure
      // the same direct network path before any challenge issues clearance.
      await sourceSession.setProxy({ mode: 'direct' });
      if (quitting) throw new Error('Nyora is closing');
      // Resolve after queued work/network configuration: parallel media reads
      // may have recorded a newer exact challenge while this operation waited.
      const target = verification.target(value.sourceId, value?.url);
      const existing = sources.get(key);
      if (existing && !existing.isDestroyed()) {
        if (verificationTargets.get(key) !== target) {
          // A later image challenge can belong to a different CDN. Keep the
          // same cookie session, but show the newly validated challenge target.
          verification.opened(value.sourceId, target);
          verificationTargets.set(key, target);
          existing.loadURL(target).catch(error => {
            console.error(`Source verification page failed to load (${error.code ?? 'navigation'})`);
          });
        }
        existing.focus();
        return { sessionId: `source-${key}`, status: 'opened' };
      }
      const window = new BrowserWindow({
        title: 'Nyora — Source verification', width: 1000, height: 760,
        webPreferences: preferences(sourceSession),
      });
      sources.set(key, window);
      verificationTargets.set(key, target);
      const navigationOrigins = new Set(descriptor.verificationOrigins || descriptor.allowedOrigins);
      // Verification pages may use same-origin challenge redirects. This window
      // has no preload/native bridge; relay image authority stays exact-URL-only.
      const sourceNavigation = url => {
        if (!publicHttps(url)) return false;
        const current = verificationTargets.get(key);
        return navigationOrigins.has(new URL(url).origin) || Boolean(current && new URL(url).origin === new URL(current).origin);
      };
      protectWindow(window, sourceNavigation, url => sourceNavigation(url)
        || (publicHttps(url) && new URL(url).origin === 'https://challenges.cloudflare.com'));
      verification.opened(value.sourceId, target);
      window.on('closed', () => {
        if (sources.get(key) !== window) return;
        sources.delete(key); verificationTargets.delete(key);
        if (quitting) return; // Shutdown drains these stores after native work stops.
        // A close receipt must wait for Chromium's on-disk write, not its default
        // delayed commit. Transient failures retry automatically in the store.
        withSourceOperation(key, async () => {
          try { await cookieStores.get(key).save(); }
          finally {
            // Another open may have been awaiting network setup when this
            // window closed. Its replacement owns the current open state.
            if (!sources.has(key)) {
              verification.closed(value.sourceId);
              await features?.downloads?.resumeVerification(value.sourceId);
            }
          }
        }).catch(() => {});
      });
      // Opening a window is never evidence that the source challenge was solved.
      // Loading errors remain visible in Chromium; they do not mark verification.
      window.loadURL(target).catch(error => {
        console.error(`Source verification page failed to load (${error.code ?? 'navigation'})`);
      });
      return { sessionId: `source-${key}`, status: 'opened' };
    });
  });
  ipcMain.handle('nyora:save-source-cookies', async (event, value) => {
    assertCaller(event);
    verification.descriptor(value?.sourceId);
    const key = sourceKey(value.sourceId);
    return withSourceOperation(key, async () => {
      getSourceSession(key);
      return cookieStores.get(key).save();
    });
  });
  ipcMain.handle('nyora:reset-source-session', async (event, value) => {
    assertCaller(event);
    verification.descriptor(value?.sourceId);
    const key = sourceKey(value?.sourceId);
    return withSourceOperation(key, async () => {
      if (sources.get(key) && !sources.get(key).isDestroyed()) {
        throw new Error('Close this source verification window before resetting its session');
      }
      const clear = async () => {
        await browserTransport?.closeSource(value.sourceId);
        const ses = getSourceSession(key);
        await ses.closeAllConnections();
        await ses.clearAuthCache();
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.cookies.flushStore();
        ses.flushStorageData();
        verification.reset(value.sourceId);
        return { reset: true };
      };
      getSourceSession(key);
      const reset = async () => { await cookieStores.get(key).reset(clear); return { reset: true }; };
      return relay ? relay.withSourcePaused(value.sourceId, reset) : reset();
    });
  });
  ipcMain.handle('nyora:service-request', async (event, value) => {
    assertCaller(event);
    if (!services) throw new Error('The bundled native library service is unavailable');
    const owner = event.sender, initialUrl = owner.getURL?.();
    const method = services.operations?.[value?.operation]?.method;
    const canRetry = () => !quitting && mainWindow && !mainWindow.isDestroyed() && owner === mainWindow.webContents
      && !owner.isDestroyed() && owner.getURL?.() === initialUrl && helper?.status?.state === 'ready'
      && !verification.status().some(entry => entry.sourceId === value?.params?.id && entry.phase !== 'retry-required');
    const dispatch = async (extraAttempt = false) => {
      try {
        // Each actual read, including a helper-crash replay, owns its proof.
        // Retrying must not conceal a new challenge behind an old checkpoint.
        const checkpoint = verification.checkpoint();
        const pending = verification.status();
        const fresh = pending.some(entry => entry.sourceId === value?.params?.id)
          || value?.operation === 'content.globalSearch' && pending.length > 0;
        const request = () => {
          // A retry can wait behind exclusive native work after its backoff.
          // Recheck route/verification/shutdown before issuing that queued read.
          if (extraAttempt && !canRetry()) throw Object.assign(new Error('Content retry cancelled'), { code: 'READ_RETRY_CANCELLED' });
          return services.request(value, { fresh });
        };
        const cloudMutation = ['sync.signIn', 'sync.register', 'sync.now', 'sync.signOut'].includes(value?.operation);
        const result = await (cloudMutation ? serviceGate.exclusive(request) : serviceGate.run(request));
        verification.completed(value.operation, value.params, result, { checkpoint });
        return result;
      } catch (error) {
        verification.failed(value?.operation, value?.params, error);
        throw error;
      }
    };
    return contentReadRetry.run(value?.operation, method,
      attempt => attempt === 0 ? readRecovery.run(method === 'GET', dispatch) : dispatch(true), { owner, canRetry });
  });
  ipcMain.handle('nyora:verification-status', event => {
    assertCaller(event);
    return verification.status().map(entry => ({ ...entry, cookies: cookieStores.get(sourceKey(entry.sourceId))?.status() || { state: 'idle' } }));
  });
  ipcMain.handle('nyora:open-backup-folder', async event => {
    assertCaller(event);
    const directory=path.join(app.getPath('userData'),'scheduled-backups');
    await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
    if((await fs.promises.lstat(directory)).isSymbolicLink())throw new Error('Invalid backup directory');
    const error=await shell.openPath(directory);if(error)throw new Error('Could not open backup folder');
    return {opened:true};
  });
  ipcMain.handle('nyora:backup-export', event => {
    assertCaller(event);
    if (!backup) throw new Error('The native backup service is unavailable');
    return backup.export();
  });
  ipcMain.handle('nyora:backup-import', (event, mode = 'merge') => {
    assertCaller(event);
    if (!backup) throw new Error('The native backup service is unavailable');
    return backup.import(mode);
  });
}

async function createMainWindow() {
  const local = session.fromPartition('persist:local-ui', { cache: true });
  protectSession(local, false);
  const { maximized, ...bounds } = await windowState.restore(screen.getAllDisplays());
  mainWindow = new BrowserWindow({
    title: 'Nyora', ...bounds, minWidth: Math.min(860, bounds.width), minHeight: Math.min(600, bounds.height),
    webPreferences: preferences(local, path.join(__dirname, 'preload.cjs')),
  });
  protectWindow(mainWindow, url => bundledUrl(url, localServer.origin), undefined, true);
  windowState.watch(mainWindow);
  if (maximized) mainWindow.maximize();
  windowRecovery = new WindowRecovery({ window: mainWindow, dialog, indexUrl: localServer.indexUrl,
    isQuitting: () => quitting, quit: () => app.quit() });
  // Hidden source transport contexts are BrowserWindows too; they must not keep
  // the preview and helper alive after the user closes its main window.
  mainWindow.on('closed', () => { mainWindow = undefined; if (!quitting) app.quit(); });
  await mainWindow.loadURL(localServer.indexUrl);
  downloadProgress.refresh();
}

function configureMenu() {
  app.setAboutPanelOptions({ applicationName: 'Nyora', applicationVersion: app.getVersion() });
  const template = consumerMenu({ platform: process.platform,
    navigate: route => { if (mainWindow && !mainWindow.isDestroyed() && BrowserWindow.getFocusedWindow() === mainWindow) mainWindow.webContents.send('nyora:navigate', route); },
    command: name => { if (mainWindow && !mainWindow.isDestroyed() && BrowserWindow.getFocusedWindow() === mainWindow) mainWindow.webContents.send('nyora:command', name); },
    exportBackup: () => { if (!backup) throw new Error('Native backup service unavailable'); return backup.export(); },
    importBackup: async () => {
      if (!backup) throw new Error('Native backup service unavailable');
      let refresh = false;
      try { const result = await backup.import(); refresh = result.status === 'completed'; return result; }
      catch (error) { refresh = true; throw error; }
      finally { if (refresh && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); }
    },
    about: () => app.showAboutPanel(), reportError: error => dialog.showMessageBox(mainWindow, {
      type: 'error', title: 'Nyora', message: 'The action could not be completed.', detail: String(error.message || error).slice(0, 500), buttons: ['OK'], noLink: true,
    }),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (!primaryInstance) { app.quit(); return; }
  const distDirectory = path.resolve(__dirname, '../dist');
  if (!fs.existsSync(path.join(distDirectory, 'index.html'))) throw new Error('Bundled frontend missing; run npm run build:frontend');
  localServer = new LocalAppServer({ distDirectory, csp: CSP, localImage: (id, page) => features.page(id, page), image: async (url, { signal }) => {
    if (!services) throw new Error('Native image service unavailable');
    const checkpoint = verification.checkpoint();
    try {
      const image = await serviceGate.run(() => services.image(url, { signal }));
      verification.imageResult(url, undefined, { checkpoint });
      return image;
    } catch (error) { verification.imageResult(url, error, { checkpoint }); throw error; }
  } });
  await localServer.start();
  const resourceRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../resources');
  const helperRoot = path.join(resourceRoot, 'helper');
  const manifestFile = path.join(helperRoot, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.protocol !== 'nyora-desktop-helper/1') throw new Error('Packaged helper does not match this platform or protocol');
    const jarPath = path.join(helperRoot, 'nyora-helper.jar');
    const actualHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(jarPath)).digest('hex');
    if (actualHash !== manifest.jarSha256) throw new Error('Packaged helper failed its integrity check');
    const { loadCatalogue, readOnlyPostPolicy } = require('./catalogue.cjs');
    catalogueLookup = loadCatalogue(path.join(helperRoot, 'catalogue.json'), manifest.catalogueSha256);
    browserTransport = new BrowserContextTransport({
      sessionForSource: sourceId => getSourceSession(sourceKey(sourceId)),
    });
    relay = new SourceRelay({
      catalogueLookup: lookupSource,
      sessionForSource: sourceId => browserTransport.sessionForSource(sourceId),
      readOnlyPostPolicy,
      onChallenge: value => verification.required(value, { fromRelay: true }),
    });
    const relayCredentials = await relay.start();
    helper = new ManagedHelper({
      profileRoot: path.join(app.getPath('userData'), 'library'), jarPath,
      javaPath: path.join(helperRoot, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      relay: { url: `${relayCredentials.baseUrl}/fetch`, token: relayCredentials.token },
    });
    services = new DesktopServices({
      helper,
      authorizeMedia: (sourceId, urls) => lookupSource(sourceId) ? relay.authorizeMedia(sourceId, urls) : Promise.reject(new Error('Media source unavailable')),
      makeImageUrl: query => localServer.mediaUrl(query), appOrigin: localServer.origin,
      sourceOrigin: sourceId => lookupSource(sourceId)?.baseOrigin,
      preferences: new DevicePreferences(path.join(app.getPath('userData'), 'device'), safeStorage),
      readerState: new ReaderState(path.join(app.getPath('userData'), 'reader')),
      nativeRequest: (operation, params) => features.request(operation, params),
      contract: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/service-contract.json'), 'utf8')),
    });
    features = new DesktopFeatures({
      profile: app.getPath('userData'), helper, encryption: safeStorage, dialogs: dialog, window: () => mainWindow, localServer,
      onDownloadsChanged: snapshot => downloadProgress.update(snapshot),
      validateImage: bytes => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('This page could not be decoded as an image.');
        const size = image.getSize();
        if (size.width < 1 || size.height < 1 || size.width * size.height > 100000000) throw new Error('This image exceeds the supported size.');
      },
      fetchPages: async (descriptor, { signal } = {}) => {
        signal?.throwIfAborted();
        const params = { id: descriptor.sourceId, url: descriptor.chapterUrl };
        const checkpoint = verification.checkpoint();
        try {
          const result = await serviceGate.run(() => services.request({ operation: 'content.pages', params }, { fresh: true }));
          verification.completed('content.pages', params, result, { checkpoint });
          signal?.throwIfAborted(); return result;
        } catch (error) { verification.failed('content.pages', params, error); throw error; }
      },
      fetchImage: async ({ sourceId, page }, { signal } = {}) => {
        const issued = new URL(typeof page === 'string' ? page : page.url);
        if (issued.origin !== localServer.origin || issued.pathname !== '/helper-image' || issued.searchParams.get('sourceId') !== sourceId) throw new Error('The source did not supply a trusted download page.');
        issued.searchParams.delete('cap'); issued.searchParams.delete('_r');
        const checkpoint = verification.checkpoint();
        try {
          const result = await serviceGate.run(() => services.image(issued.href, { signal }));
          verification.imageResult(issued.href, undefined, { checkpoint }); return result;
        } catch (error) { verification.imageResult(issued.href, error, { checkpoint }); throw error; }
      },
    });
    await features.init();
    const { NativeBackupBroker } = require('./backup.cjs');
    backup = new NativeBackupBroker({
      helper, dialogs: dialog, window: () => mainWindow,
      exclusive: operation => serviceGate.exclusive(operation),
      receiptDirectory: path.join(app.getPath('userData'), 'backup-receipts'),
      afterReplace:()=>services.readerState.clearAllMarks(),
    });
  }
  if(services && backup) {
    const {Automation}=require('./automation.cjs');
    automation=new Automation({directory:path.join(app.getPath('userData'),'automation'),
      preferences:()=>services.preferences.get(),
      run:async task=>{
        if(task==='backup')return backup.scheduledExport(path.join(app.getPath('userData'),'scheduled-backups'));
        return serviceGate.exclusive(async()=>{
          if(task==='sync') {
            const status=await services.request({operation:'sync.status'});
            if(!status.isAuthenticated)throw new Error('Sign in to use scheduled sync');
          }
          return services.request({operation:task==='sync'?'sync.now':'library.updatesRefresh'});
        });
      },
      changed:()=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('nyora:native-data-changed');},
    });
    automation.start();
  }
  registerCommands();
  configureMenu();
  await createMainWindow();
}).catch(error => {
  console.error(`Nyora could not initialize: ${error.message}`);
  Promise.resolve(features?.close()).catch(() => {}).then(() => Promise.allSettled([localServer?.stop(), helper?.stop(), relay?.stop(), browserTransport?.close()]))
    .then(() => Promise.allSettled([...cookieStores.values()].map(store => store.close())))
    .then(() => dialog.showMessageBox({ type: 'error', title: 'Nyora could not start',
      message: 'Nyora could not start this time.',
      detail: 'Your saved library and website sessions are retained. Close Nyora and open it again. If this continues, reinstall the application without deleting its saved data.',
      buttons: ['Quit'], noLink: true }))
    .finally(() => app.exit(1));
});
app.on('window-all-closed', () => { if (!quitting) app.quit(); });
app.on('before-quit', event => {
  if (!primaryInstance) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  downloadProgress.close();
  contentReadRetry.close();
  readRecovery.close();
  windowRecovery?.close();
  Promise.all([automation?.close(), ...[...sourceOperations.values()].map(pending => pending.catch(() => {}))])
    .then(() => features?.close())
    .then(() => localServer?.stop())
    .then(() => serviceGate.close())
    .then(() => helper?.stop())
    .then(() => relay?.stop())
    .then(async () => {
      for (const window of [...sources.values()]) if (!window.isDestroyed()) window.destroy();
      await browserTransport?.close();
    })
    .then(() => Promise.all([...cookieStores.values()].map(store => store.close())))
    .then(() => Promise.all([...sourceSessions.values(), session.fromPartition('persist:local-ui')]
      .map(async ses => { ses.flushStorageData(); await ses.cookies.flushStore(); })))
    .then(() => windowState.close().catch(() => {}))
    .then(() => { shutdownComplete = true; app.quit(); }, error => {
      console.error(`Could not flush Chromium session storage: ${error.message}`);
      app.exit(1);
    });
});
