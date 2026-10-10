// Narrow, checked transformations on a temporary copy, never the shared source.
export function replaceOnce(source, from, to, label) {
  if (source.split(from).length !== 2) throw new Error(`Shared frontend drift: expected exactly one ${label}`);
  return source.replace(from, to);
}

function replaceFunction(source, start, end, body, guards) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0) {
    throw new Error(`Shared frontend drift: missing or repeated ${start}`);
  }
  const old = source.slice(from, to);
  for (const guard of guards) {
    if (!old.includes(guard)) throw new Error(`Shared frontend drift: ${start} no longer contains ${guard}`);
  }
  return source.slice(0, from) + body + '\n\n' + source.slice(to);
}

export function overlayApp(source) {
  source = replaceOnce(source, "    { key: 'discord', label: 'Join Discord', icon: 'discord', href: DISCORD_URL },\n", '', 'duplicate community navigation');
  for (const call of ['setupInstallPrompt();', 'registerSW();', 'initAutoSync();']) {
    source = replaceOnce(source, `\n${call}`, `\n// Desktop handles natively: ${call}`, call);
  }
  source = replaceOnce(source, "const BASE_TITLE = 'Nyora — Free Online Manga Reader in Your Browser';", "const BASE_TITLE = 'Nyora';", 'app title');
  source = source.replaceAll("router.start(routes, 'discover')", "router.start(routes, 'library')");
  return source;
}

export function overlaySettings(source) {
  source = replaceOnce(source, "sub: 'Account, sync and restore'", "sub: 'Account and library sync'", 'sync setting label');
  source = replaceOnce(source, "sub: 'Export, import and clear data'", "sub: 'Portable backup and local data'", 'backup setting label');
  source = replaceFunction(source, 'function buildBackupData() {', 'function buildSync() {', `function buildBackupData() {
  return el('section', { class: 'settings-section' },
    el('h2', null, 'Portable backup'),
    el('p', { class: 'hint' }, 'Your library is stored on this device. Use portable .nyorabk files to back it up.'));
}`, ['library.exportData()', 'library.importData(']);
  source = replaceOnce(source, 'const reg = await navigator.serviceWorker.getRegistration();', 'const reg = null; // Desktop updates are verified through the native runtime.', 'PWA update action');
  source = replaceOnce(source, "'Check for a new version now and reload if one is waiting.'", "'Reload the installed interface.'", 'PWA update description');
  return source;
}

export function overlayWelcome(source) {
  // Keep the shared preferences flow, bypass the browser auth/import welcome.
  source = replaceFunction(source, 'export function shouldShowWelcome() {', 'function markOnboarded() {', 'export function shouldShowWelcome() { return false; }', ['sync.status()', 'localStorage.getItem(ONBOARD_KEY)']);
  source = replaceFunction(source, 'export function showWelcome(onDone) {', 'function populatePreferencesCard(', 'export function showWelcome(onDone) { if (onDone) onDone(); }', ['api.importBackup(', 'sync.signInAndFetch(']);
  return replaceOnce(source, "'Sign in on any device to pick up where you left off'", "'Reading data stays on this device until you sign in and sync'", 'preferences sync claim');
}

export function overlayHtml(source) {
  // Offline desktop typography is bundled; no external font stylesheet at boot.
  source = source.replace(/\s*<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
  source = replaceOnce(source, '<html lang="en">', '<html lang="en" data-community-links="pending">', 'community preference preflight');
  source = replaceOnce(source, '      <a class="community-site"', '      <div class="desktop-community-links" role="group" aria-label="Community links">\n      <a class="community-site"', 'community links group');
  source = replaceOnce(source, '        <span class="visit-site-label">Official website</span>\n      </a>', '        <span class="visit-site-label">Official website</span>\n      </a>\n      <button id="desktop-dismiss-community" type="button" aria-label="Hide community links" title="Hide Discord and website links">×</button>\n      </div>', 'dismiss community links');
  source = replaceOnce(source, '<script src="/boot/migrate.js"></script>', '', 'origin migration script');
  source = replaceOnce(source, '<link rel="manifest" href="/manifest.webmanifest" />', '', 'PWA manifest');
  source = replaceOnce(source, '<script type="module" src="/app.js?v=9"></script>', '<script type="module" src="/desktop.js"></script>', 'app bootstrap');
  // Desktop isn't a public SEO landing page; remove web/PWA marketing metadata.
  source = replaceFunction(source, '<!-- SEO / Social / Structured Data block -->', '  <link rel="icon"', '<title>Nyora</title>', ['application/ld+json', 'rel="canonical"']);
  source = source.replace(/<noscript>[\s\S]*?<\/noscript>/g, '<noscript>Nyora requires JavaScript.</noscript>');
  source = replaceFunction(source, '<section id="seo-intro" data-static-seo>', '    </main>', '<p>Nyora is loading…</p>', ['offline-capable PWA', 'Google cloud sync']);
  return replaceOnce(source, '<link rel="stylesheet" href="/styles.css?v=40" />', '<link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/desktop.css" />', 'styles');
}
