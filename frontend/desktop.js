import { createDesktopAdapter } from './adapter.js';
import { nativeServices } from './native-services.js';
import {files} from './native-files.js';
import sync from './native-sync.js';
import downloads from './native-downloads.js';
import tracking from './native-tracking.js';
import { nativeBackup as backup } from './native-backup.js';
import { mountServiceStatus } from './service-status.js';
import { reloadRecoveredSource } from './source-recovery.js';
import { mountCommunityLinks } from './community-links.js';
import { mountDesktopCommands } from './desktop-palette.js';
import { navigateDesktopRoute } from './desktop-commands.js';
import { mountDesktopShell } from './desktop-shell.js';

// Dynamic import is deliberate: the boundary exists before any shared module
// evaluates. The build strips the web-only boot/sync/migration paths separately.
const adapter = createDesktopAdapter();
Object.defineProperty(globalThis, 'NYORA_DESKTOP', { value: adapter, writable: false });
globalThis.NYORA_SYNC_URL = '';
document.documentElement.dataset.nyoraPlatform = 'desktop';
Object.defineProperty(globalThis, 'NYORA_SERVICES', { value: Object.freeze({ library: nativeServices, sources: nativeServices, downloads, tracking, files, backup, sync }) });

const host = document.getElementById('view');
let booted = false;
let booting = false;
async function boot() {
  if (booting || booted) return;
  booting = true;
  try {
    await nativeServices.hydrate();
    await downloads.hydrate().catch(()=>{});
    await tracking.refresh().catch(()=>{});
    await import('./shared-app.js');
    booted = true;
    // Errors from shared controls are displayed even if their legacy event
    // plumbing doesn't consume an async callback's rejected Promise.
    const { toast } = await import('nyora-shared-ui');
    const { router, store } = await import('nyora-shared-store');
    const offNativeData=globalThis.nyoraDesktop?.onNativeDataChanged?.(()=>{
      void nativeServices.hydrate().catch(error=>toast('Background update finished, but the library needs reloading: '+error.message));
    });
    window.addEventListener('pagehide',()=>offNativeData?.(),{once:true});
    mountCommunityLinks(nativeServices, store, toast);
    const unmountCommands = mountDesktopCommands({ router, services: nativeServices, files, toast });
    const unmountShell = mountDesktopShell({ router, store });
    window.addEventListener('pagehide', unmountShell, { once: true });
    window.addEventListener('pagehide', unmountCommands, { once: true });
    globalThis.nyoraDesktop?.onNavigate?.(route => navigateDesktopRoute(router, route, document));
    const reload = (sourceId, requests) => {
      if (sourceId) return reloadRecoveredSource(router, sourceId, requests);
      const route = router.current();
      router.navigate(route.name, route.params);
    };
    mountServiceStatus(adapter, nativeServices, reload, { router, toast });
    window.addEventListener('nyora:service-error', (event) => { toast(event.detail); reload(); });
    window.addEventListener('unhandledrejection', (event) => { toast(String(event.reason?.message || event.reason)); });
    window.addEventListener('error', (event) => { if (event.error) toast(String(event.error.message || event.error)); });
  } catch (error) {
    document.getElementById('splash')?.remove();
    const heading = document.createElement('h1'); heading.textContent = 'Native data unavailable';
    const message = document.createElement('p'); message.textContent = String(error?.message || error);
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry native connection'; retry.addEventListener('click', boot);
    host.replaceChildren(heading, message, retry);
  } finally { booting = false; }
}
await boot();
