import { replaceOnce } from './frontend-overlay.mjs';
function between(source, start, end, replacement) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) throw new Error(`Shared frontend drift: ${start}`);
  return source.slice(0, a) + replacement + '\n\n' + source.slice(b);
}
export function overlayNativeStore(source) {
  // Only unsaved defaults change; an existing BLACK or SOFT preference wins.
  source = replaceOnce(source, "darkStyle: 'BLACK',", "darkStyle: 'SOFT',", 'desktop soft-dark default');
  source = between(source, 'function loadPrefs() {', '// ---- the store', `function loadPrefs() { return deepMerge(deepClone(DEFAULT_PREFS), nativeServices.uiPreferences()); }`);
  source = replaceOnce(source, "const saved = JSON.parse(localStorage.getItem(MANGA_CACHE_KEY) || '[]');", 'const saved = []; // Display metadata remains memory-only.', 'manga cache read');
  source = between(source, '  function persistMangaCache() {', '  function persist() {', '  function persistMangaCache() {}');
  source = between(source, '  function persist() {', '  function notify() {', '  function persist() {}');
  source = between(source, '    set(patch) {', '    /** Subscribe to changes.', `    async set(patch) {
      if (!patch || typeof patch !== 'object') return store.get();
      const committed = await nativeServices.saveUiPreferences(patch);
      prefs = deepMerge(deepClone(DEFAULT_PREFS), committed);
      applyTheme();
      notify();
      return store.get();
    },\n`);
  return `import { nativeServices } from 'nyora-native-services';\n` + source;
}
export function overlayNativeSettings(source) {
  source = replaceOnce(source, "  section.append(settingRow('Show titles under covers', null,", "  section.append(settingRow('Community links', 'Show Discord and website links in the header.',\n    switchToggle(prefs.hideCommunityLinks !== true, (v) => store.set({ hideCommunityLinks: !v }))));\n  section.append(settingRow('Show titles under covers', null,", 'community links preference');
  source = between(source, 'function buildAbout() {', '// ── Tracking', 'function buildAbout() { return buildNativeAbout(); }');
  source = between(source, 'function buildDownloads() {', 'function buildReader() {', `function buildDownloads() {
    const section=el('section',{class:'settings-section'},el('h2',null,'Downloads'),el('p',{class:'hint'},'Chapters are saved offline on this device. Export a finished chapter from Downloads to choose where to save its CBZ or ZIP file.'));
    const settings=downloads.getSettings();
    section.append(settingRow('Export format',null,menuSelect([{label:'CBZ',value:'CBZ'},{label:'ZIP',value:'ZIP'}],settings.format,async format=>{await downloads.saveSettings({format});toast('Export format saved');})));
    for(const [key,name,min,max] of [['maxConcurrent','Concurrent chapters',1,4],['imageConcurrency','Concurrent page images',1,4],['retries','Image retry attempts',0,3]])section.append(settingRow(name,null,stepper({value:settings[key],min,max,onChange:async value=>{await downloads.saveSettings({[key]:value});}})));
    if(downloads.error()) section.append(el('p',{role:'status'},downloads.error()));
    section.append(btn('Open downloads',{onClick:()=>router.navigate('downloads')}));return section;
  }`);
  source = between(source, 'function buildTracking() {', 'export default', `function buildTracking() {
    const section=el('section',{class:'settings-section'},el('h2',null,'Tracking'));
    function refresh(){section.replaceChildren(el('h2',null,'Tracking'));for(const tracker of tracking.TRACKERS){
      const capability=tracking.capability(tracker.slug);
      if(!capability.available){section.append(settingRow(tracker.name,capability.reason || 'Sign-in is not configured for this service.',null));continue;}
      section.append(trackerRow(tracker,refresh));
    }}
    tracking.refresh().then(refresh).catch(error=>section.append(el('p',{role:'status'},error.message)));return section;
  }
  function trackerRow(t,refresh) {
    if(tracking.isConnected(t.slug))return settingRow(t.name,'Connected',el('div',{class:'desktop-runtime-actions'},m3Switch(tracking.isEnabled(t.slug),async on=>{await tracking.setEnabled(t.slug,on);}),btn('Disconnect',{variant:'ghost',onClick:async()=>{await tracking.disconnect(t.slug);refresh();}})));
    const token=el('input',{class:'input',type:'password',autocomplete:'off',placeholder:'AniList access token'});const connect=btn('Connect',{onClick:async()=>{connect.disabled=true;try{await tracking.connect(t.slug,{token:token.value.trim()});refresh();}catch(error){toast(error.message);connect.disabled=false;}finally{token.value='';}}});return el('div',{class:'settings-section'},el('h3',null,t.name),el('p',{class:'hint'},'Paste your personal access token. Nyora encrypts it on this device; it is never included in backups or sent to Cloud Sync.'),field('Access token',token),connect);
  }

`);
  source = between(source, 'function buildAdvanced() {', 'function buildAbout() {', `function buildAdvanced() {
    const section=el('section',{class:'settings-section'},el('h2',null,'Desktop'),el('p',{class:'hint'},'Your library, offline books and website sessions stay on this device. Cloud Sync runs manually unless you enable its background schedule below.'));
    section.append(el('h3',null,'Background tasks'),el('p',{class:'hint'},'Runs while Nyora is open. All tasks are off by default. Automatic backups keep the latest 7 copies on this device.'));
    const config=store.get().automation||{};
    for(const [key,label,options] of [
      ['updates','Check for new chapters',[[0,'Off'],[60,'Every hour'],[360,'Every 6 hours'],[720,'Every 12 hours'],[1440,'Daily']]],
      ['sync','Cloud sync',[[0,'Off'],[15,'Every 15 minutes'],[30,'Every 30 minutes'],[60,'Every hour']]],
      ['backup','Local backup',[[0,'Off'],[1440,'Daily'],[10080,'Weekly']]],
    ]) {
      const select=el('select',{class:'input','aria-label':label,onChange:async event=>{
        await store.set({automation:{...(store.get().automation||{}),[key]:Number(event.target.value)}});
      }},...options.map(([value,text])=>el('option',{value:String(value)},text)));
      select.value=String(config[key]||0);section.append(field(label,select));
    }
    section.append(btn('Open automatic backups',{variant:'ghost',onClick:async()=>{try{await globalThis.nyoraDesktop.openBackupFolder();}catch(error){toast(error.message);}}}));
    const status=el('p',{class:'hint',role:'status'},'Checking background tasks…');section.append(status);
    globalThis.nyoraDesktop.runtimeStatus().then(runtime=>{status.textContent=Object.entries(runtime.automation||{}).map(([name,value])=>name+': '+value.result+' · '+new Date(value.at).toLocaleString()).join(' · ')||'No background tasks have run yet.';}).catch(()=>{status.textContent='Background status unavailable.';});
    mountRuntimePanel(NYORA_DESKTOP,section);return section;
  }`);
  source = between(source, 'function buildSync() {', 'async function runSync(', `function buildSync() {
    const section=el('section',{class:'settings-section desktop-sync'}),status=el('p',{class:'desktop-sync-status',role:'status'});
    async function run(action){for(const button of section.querySelectorAll('button'))button.disabled=true;status.textContent='Working…';try{await action();await draw();}catch(error){status.textContent=error.message;for(const button of section.querySelectorAll('button'))button.disabled=false;}}
    async function draw(){const account=await sync.refreshStatus();section.replaceChildren(el('p',{class:'desktop-sync-intro'},account.isAuthenticated?'Merge your library with your account whenever you choose.':'Sign in to sync your library across devices.'),status);status.textContent='';
      const note=el('p',{class:'desktop-sync-note'},'Sync runs manually unless its background schedule is enabled in Advanced. Offline files and website sessions stay on this device.');
      if(account.isAuthenticated){section.append(el('p',{class:'desktop-sync-account'},'Signed in as '+account.email),el('div',{class:'desktop-sync-actions'},btn('Merge and sync',{variant:'accent',onClick:()=>run(async()=>{await sync.syncNow();toast('Library synced');})}),btn('Sign out',{variant:'ghost',onClick:()=>run(()=>sync.signOut())})),note);return;}
      const email=el('input',{class:'input',type:'email',autocomplete:'email',placeholder:'Email','aria-label':'Email',required:true}),password=el('input',{class:'input',type:'password',autocomplete:'current-password',placeholder:'Password','aria-label':'Password',required:true});
      const form=el('form',{class:'desktop-sync-form'},field('Email',email),field('Password',password),el('div',{class:'desktop-sync-actions'},btn('Sign in',{type:'submit',variant:'accent'}),btn('Create account',{variant:'ghost',onClick:()=>{if(form.reportValidity())run(async()=>{try{await sync.register(email.value.trim(),password.value);}finally{password.value='';}});}})));
      form.addEventListener('submit',event=>{event.preventDefault();run(async()=>{try{await sync.signIn(email.value.trim(),password.value);}finally{password.value='';}});});section.append(form,note);
    }
    draw().catch(error=>{status.textContent=error.message;section.append(status);});return section;
  }`);
  source = between(source, 'function buildBackupData() {', 'function buildSync() {', `function buildBackupData() {
    const status = el('p', { role: 'status' }, nativeBackup.available ? 'Portable native backup uses .nyorabk files. Import previews the contents and merges after confirmation in the native dialog.' : 'Native portable backup is unavailable in this runtime.');
    const exportButton = btn('Export native backup', { onClick: () => run(() => nativeBackup.export()) });
    const importButton = btn('Import and merge native backup', { onClick: () => run(() => nativeBackup.import()) });
    const replaceButton = btn('Replace library from backup', { variant:'ghost', onClick: () => run(() => nativeBackup.import('replace')) });
    const reloadButton = btn('Reload native data', { onClick: () => run(async () => { await nativeBackup.reload(); return { status: 'reloaded' }; }) });
    function update() { exportButton.disabled = importButton.disabled = replaceButton.disabled = !nativeBackup.available || !nativeBackup.cacheStatus().writeAvailable; }
    async function run(action) {
      exportButton.disabled = importButton.disabled = replaceButton.disabled = reloadButton.disabled = true;
      status.textContent = 'Waiting for the native backup dialog…';
      try { const result = await action(); status.textContent = result.status === 'cancelled' ? 'Backup cancelled.' : result.status === 'saved' ? 'Native backup saved.' : result.status === 'completed' ? 'Native backup restored and data reloaded.' : 'Native data reloaded.'; }
      catch (error) { status.textContent = String(error.message || error); }
      finally { reloadButton.disabled = false; update(); }
    }
    update();
    return el('section', { class: 'settings-section' }, el('h2', null, 'Portable backup'), status, el('p', { class: 'hint' }, 'Export a portable .nyorabk backup of your library. Choose Merge to combine data, or Replace to restore the portable library after reviewing the deletion counts. Website sessions, account credentials and offline files are kept separately.'), exportButton, importButton, replaceButton, reloadButton);
  }`);
  source=replaceOnce(source,"Refine each translated page with a language model for coherence. OpenAI style covers OpenAI, OpenRouter, Groq and local Ollama; Anthropic covers Claude. Leave the API key empty to disable. The key is stored only in this browser.","Refine translated pages with OpenAI or Anthropic using the provider’s default endpoint. Custom endpoints are not supported in this desktop app. Leave the API key empty to disable refinement. The key is encrypted on this device and excluded from backups and Cloud Sync.",'desktop AI endpoint and secret scope');
  source=replaceOnce(source,"{ info: 'Leave empty to use the provider default.' } : null, input)","{ info: key === 'aiEndpoint' ? 'Leave empty for the provider default. Desktop does not support custom endpoints.' : 'Leave empty to use the provider default.' } : null, input)",'desktop endpoint hint');
  return "import { buildNativeAbout } from 'nyora-native-about';\nimport { mountRuntimePanel } from 'nyora-native-runtime';\nimport { nativeBackup } from 'nyora-native-backup';\n" + source;
}
export function overlayNativeMisc(file, source) {
  if (file === 'screens/bookmarks.js') {
    source = replaceOnce(source, "const chapterUrl = row.chapterUrl || row.chapterId || '';", "const chapterUrl = row.chapterUrl || '';", 'exact bookmark chapter URL');
    source = replaceOnce(source, 'toast(`Searching for "${title}" — saved at page ${page + 1}`);\n  router.navigate(\'search\', { q: title });', "toast('This bookmark has no native navigation metadata. Open its exact source entry before resuming.');", 'bookmark identity fallback');
  }
  if (file === 'screens/explore.js') {
    source = replaceOnce(source, '  const wantSourceId = params && params.source ? String(params.source) : null;', '  let sourceLoadToken = 0;\n  const wantSourceId = params && params.source ? String(params.source) : null;', 'Explore source lookup generation');
    source = replaceOnce(source, '  function selectSource(src) {\n    store.source = src;', '  function selectSource(src) {\n    sourceLoadToken++;\n    state.missingSource = null;\n    store.source = src;', 'clear unavailable state when selecting source');
    source = replaceOnce(source, '  function backToLanding() {\n    exploreCache = null;', '  function backToLanding() {\n    sourceLoadToken++;\n    state.missingSource = null;\n    exploreCache = null;', 'clear unavailable state when leaving source');
    source = between(source, '  async function loadSources(opts = {}) {', '  async function loadBrowse(page, force = false) {', `  async function loadSources(opts = {}) {
    const token = ++sourceLoadToken;
    const current = () => {
      const route = router.current();
      return root.isConnected && token === sourceLoadToken && route.name === 'explore' && (route.params?.source || null) === wantSourceId;
    };
    if (!opts.keepBrowse) { state.sourcesLoading = true; state.sourcesError = null; }
    try {
      const res = await api.listSources();
      if (!current()) return;
      state.sources = (res && res.sources) || [];
      state.sourcesLoading = false;
      state.sourcesError = null;
      renderSourceLists();
      let resolvedNow = false;
      if (state.screen === 'browse' && wantSourceId) {
        const src = state.sources.find(source => source.id === wantSourceId);
        if (!src) {
          store.source = null;
          const catalog = await api.catalog();
          if (!current()) return;
          state.missingSource = { source: catalog.entries.find(source => source.id === wantSourceId) };
          state.browseToken++;
          state.browseLoading = false;
          state.browseError = null;
          state.entries = [];
          renderBrowseView();
          return;
        }
        resolvedNow = !store.source;
        store.source = src;
        state.missingSource = null;
      }
      if (state.screen === 'browse' && store.source) {
        if (!state.entries.length && !state.browseError) loadBrowse(1);
        else if (resolvedNow) renderBrowseView();
      } else if (state.screen === 'landing') renderLanding();
    } catch (error) {
      if (!current()) return;
      state.sourcesLoading = false;
      state.sourcesError = error.message;
      renderSourceLists();
      if (state.screen === 'browse' && !store.source) {
        state.missingSource = { error: error.message };
        state.browseLoading = false;
        renderBrowseView();
      } else if (state.screen === 'landing') renderLanding();
    }
  }`);
    source = replaceOnce(source, '  function renderBrowseBody(body) {\n    body.replaceChildren();', `  function renderBrowseBody(body) {
    body.replaceChildren();
    if (state.missingSource) {
      const source = state.missingSource.source;
      const actions = [];
      if (state.missingSource.error) {
        body.appendChild(errorBox('Could not load this source. Please try again.'));
        actions.push(btn('Retry loading sources', { onClick: () => loadSources() }));
      } else {
        body.appendChild(emptyState(source ? (source.name || 'This source') + ' is not installed.' : 'This source is no longer available in the catalogue.', 'compass'));
        if (source) {
          const install = btn('Install source', { variant: 'accent', onClick: async () => {
            install.disabled = true;
            try {
              await api.installSource(source.id);
              if (root.isConnected && router.current().name === 'explore' && (router.current().params?.source || null) === wantSourceId) await loadSources({ keepBrowse: true });
            } catch (error) { toast(error.message); install.disabled = false; }
          } });
          actions.push(install);
        }
      }
      body.appendChild(el('div', { class: 'row', style: 'justify-content:center' }, ...actions,
        btn('Open catalog', { variant: 'ghost', onClick: openExtensions }),
        btn('Back to Explore', { variant: 'ghost', onClick: backToLanding })));
      return;
    }`, 'unavailable source deep link actions');
    source = between(source, 'function lsGet(key, fallback) {', 'function isMobile() {', 'const transientExplorePreferences = new Map();\nfunction lsGet(key, fallback) { return transientExplorePreferences.get(key) ?? fallback; }\nfunction lsSet(key, value) { transientExplorePreferences.set(key, String(value)); }');
    source = replaceOnce(source, "el('div', { class: 'row-actions' }, pinBtn)", "el('div', { class: 'row-actions' }, sourceVerificationButton(src), pinBtn)", 'source picker verification');
    source = replaceOnce(source, '          installBtn,\n        ),', '          installBtn,\n          sourceVerificationButton(e),\n        ),', 'catalogue verification');
    source = replaceOnce(source, "        iconBtn('refresh', () => loadBrowse(1, true), 'Refresh'),", "        iconBtn('refresh', () => loadBrowse(1, true), 'Refresh'),\n        src ? sourceVerificationButton(src) : null,", 'browse verification');
    source = replaceOnce(source, '|cloudflare|just a moment|challenge|forbidden/i.test(m)', '|cloudflare|just a moment|challenge|forbidden|verification[_ ]required/i.test(m)', 'source verification error');
    source = replaceOnce(source, "This source is blocked and can't be reached right now. Try another source.", 'Use Verify source to check access. Complete any check, then close the window. Nyora will check the source automatically.', 'source verification guidance');
    source = replaceOnce(source, "  window.addEventListener('nyora:sources-synced', _onSourcesSynced);", `  window.addEventListener('nyora:sources-synced', _onSourcesSynced);
  if (_onSourceContentRecovered) window.removeEventListener('nyora:source-content-recovered', _onSourceContentRecovered);
  _onSourceContentRecovered = (event) => {
    if (!root.isConnected || router.current().name !== 'explore' || state.screen !== 'browse' || store.source?.id !== event.detail?.sourceId) return;
    // The current source UI owns recovery, including stale notifications: a
    // router rebuild would discard SEARCH/LATEST state or reuse a partial cache.
    event.preventDefault();
    if (!state.browseError || state.browseLoading) return;
    const operation = state.mode === 'SEARCH' ? 'content.search' : state.mode === 'LATEST' ? 'content.latest' : 'content.popular';
    const matching = (event.detail.requests || []).some(request => request.operation === operation && request.params?.id === store.source.id && request.params.page === state.page && (state.mode !== 'SEARCH' || request.params.q === state.query.trim()));
    if (matching) loadBrowse(state.page, true);
  };
  window.addEventListener('nyora:source-content-recovered', _onSourceContentRecovered);`, 'Explore source recovery handler');
    source = replaceOnce(source, 'let _onSourcesSynced = null;', 'let _onSourcesSynced = null;\nlet _onSourceContentRecovered = null;', 'single Explore recovery listener');
    source = "import { sourceVerificationButton } from 'nyora-source-verification';\n" + source;
  }
  if (file === 'screens/library.js') source = between(source, '  async function backfillCovers(entries) {', '  function renderEmpty() {', '  async function backfillCovers() { return false; }');
  if (file === 'screens/details.js') {
    source = replaceOnce(source, 'No trackers connected — Connect AniList, MyAnimeList, MangaBaka or Kitsu in Settings → Tracking to sync your progress.', 'No tracking accounts connected. Connect an available account in Settings → Tracking to sync your progress.', 'capability-aware tracker guidance');
    source = between(source,'const READ_KEY =',"// The manga's current reading progress entry",`function readOverrides(mangaId) {
      const marks=library.readMarks(mangaId);return {read:new Set(marks.read || []),unread:new Set(marks.unread || [])};
    }
    async function saveOverrides(mangaId,overrides) {await library.saveReadMarks({mangaId,read:[...overrides.read],unread:[...overrides.unread]});}
    `);
    for(const [label,read] of [['Mark all as read',true],['Mark all as unread',false]]) {
      const original=read ? "for (const c of readingOrder) setRead(c, true); renderRows(); toast('Marked all read');" : "for (const c of readingOrder) setRead(c, false); renderRows(); toast('Marked all unread');";
      const replacement=read ? "for(const c of readingOrder){overrides.read.add(c.url);overrides.unread.delete(c.url);} saveOverrides(mangaId,overrides); renderRows(); toast('Marked all read');" : "for(const c of readingOrder){overrides.unread.add(c.url);overrides.read.delete(c.url);} saveOverrides(mangaId,overrides); renderRows(); toast('Marked all unread');";
      source=replaceOnce(source,original,replacement,label+' atomic update');
    }
  }
  if(file === 'screens/downloads.js') {
    source=replaceOnce(source,"    const blob = await downloads.getBlob(job.id);\n    if (!blob) throw new Error('Offline file not found');\n    const entries = await unzipImages(blob);\n    pages = entries.map((e) => new Blob([e.bytes]));", "    const book = await downloads.open(job.id);\n    pages = book.pages;\n    job.__offlineBook = book;", 'native offline reader');
    source=replaceOnce(source,"    chapterTitle: job.chapterTitle || 'Chapter', pages, back: 'downloads',","    id: job.__offlineBook.id, chapterTitle: job.chapterTitle || 'Chapter', pages, back: 'downloads', state: job.__offlineBook.state || {page:0},",'offline durable book identity');
    source=replaceOnce(source,'      const res = await downloads.clearCompleted();',"      if (!(await confirmDialog('Delete finished downloads and their offline files?'))) return;\n      const res = await downloads.clearCompleted();",'confirm deleting offline chapters');
    source=replaceOnce(source,"iconBtn('trash', () => { downloads.remove(job.id); }, 'Remove')","iconBtn('trash', async () => { if(await confirmDialog('Delete this download and its offline files?')) await downloads.remove(job.id); }, 'Remove')",'confirm offline chapter deletion');
    source=replaceOnce(source,"toast(res.ok ? 'Saved to device' : 'No file to save');","toast(res.status === 'cancelled' ? 'Export cancelled' : res.ok ? 'Saved to device' : 'No file to save');",'honest cancelled export');
    source=replaceOnce(source,"toast(res.ok ? `Saved ${res.count} chapters` : 'Nothing to save');","toast(res.status === 'cancelled' ? 'Export cancelled' : res.ok ? `Saved ${res.count} chapters` : 'Nothing to save');",'honest cancelled bundle export');
    source=replaceOnce(source,'  host.replaceChildren(frag);',"  for(const warning of downloads.warnings())frag.prepend(el('p',{role:'status'},warning.message));\n  if(downloads.error()) frag.prepend(errorBox(downloads.error()),btn('Retry loading downloads',{onClick:async()=>{try{await downloads.hydrate();}catch(error){toast(error.message);}}}));\n  host.replaceChildren(frag);",'download failure recovery');
  }
  if (file === 'screens/reader.js') {
    source=replaceOnce(source,'  function savePrefs() {','  async function savePrefs() {','await local reader preference commit');
    source=replaceOnce(source,'if (local) local.state.prefs = prefs;',"if (local) { if (!local.savePreferences) throw new Error('Reopen this book from your offline library before saving preferences.'); await desktopMutation(() => local.savePreferences(prefs)); local.state.prefs = prefs; }",'durable local reader preferences');
    source=replaceOnce(source,'  const local = getLocalReader(params && params.local);',`  const local = getLocalReader(params && params.local);
      if(params?.local && !local) {
        view.replaceChildren(spinner());
        restoreLocalReader(params.local,params.back).then(()=>{if(view.isConnected && router.current().name==='reader' && router.current().params.local===params.local) render(view,params);}).catch(error=>{if(view.isConnected && router.current().name==='reader' && router.current().params.local===params.local)view.replaceChildren(errorBox(error.message),btn('Back to offline books',{onClick:()=>router.navigate(params.back==='downloads'?'downloads':'local')}));});
        return;
      }`,'rehydrate durable offline reader after reload');
    source="import {restoreLocalReader} from '../core/local-reader.js';\n"+source;
    source=replaceOnce(source,'else library.saveMangaPrefs(prefs);\n    } catch { /* best-effort */ }','else library.saveMangaPrefs(prefs);\n    } catch (error) { throw error; }','propagate reader preference save failure');
    source=replaceOnce(source,'if (local) { local.state.page = page; return; }','if (local) { local.state.page = page; local.saveProgress?.(page).catch(error=>toast(error.message)); return; }','durable local reader progress');
    source = replaceOnce(source, "    const sep = url.includes('?') ? '&' : '?';\n    return Object.assign({}, p, { url: `${url}${sep}_r=${Date.now()}` });", "    const retryUrl = new URL(url, location.origin);\n    retryUrl.searchParams.set('_r', String(Date.now()));\n    return Object.assign({}, p, { url: retryUrl.href });", 'single reader image retry parameter');
  }
  if (file === 'core/ui.js') {
    source = replaceOnce(source, 'const keep = a.onClick && a.onClick() === false;', "let keep; try { keep = a.onClick && (await a.onClick()) === false; } catch (error) { toast(error.message || 'Could not complete this action'); return; }", 'await modal action').replace('onClick: () => {\n        let keep;', 'onClick: async () => {\n        let keep;');
    source = between(source, 'export function applyImage(img, url, headers, onFail) {', '// ---- schemeCard', 'export const applyImage = applyNativeImage;');
    source = "import { applyNativeImage } from 'nyora-native-images';\n" + source;
  }
  if (file === 'screens/suggestions.js') source = replaceOnce(source, "      decoding: 'async',\n      alt: title,", "      decoding: 'async',\n      crossOrigin: 'anonymous',\n      referrerPolicy: 'no-referrer',\n      alt: title,", 'public metadata image CORS');
  if (file === 'screens/discover.js' || file === 'screens/suggestions.js') source = replaceOnce(source, "const MB_SEARCH = 'https://api.mangabaka.dev/v1/series/search';", "const MB_SEARCH = 'https://api.mangabaka.org/v1/series/search';", 'MangaBaka current public API');
  if (file === 'screens/search.js') {
    // The native relay admits eight requests. Chromium can concurrently load
    // six same-origin covers, so source discovery must leave those slots free.
    source = replaceOnce(source, 'const BATCH_SIZE = 6;', 'const BATCH_SIZE = 2;', 'reserve search cover capacity');
    source = source.replaceAll('if (token !== runState.token) return;', 'if (token !== runState.token || !results.isConnected) return;');
    source = source.replaceAll('if (token === runState.token)', 'if (token === runState.token && results.isConnected)');
    source = replaceOnce(source, 'while (token === runState.token) {', 'while (token === runState.token && results.isConnected) {', 'stop background search on navigation');
    source = replaceOnce(source, '    runState.stopped = false;\n    for (const it of searchCache.items)', '    runState.stopped = runState.done < runState.total;\n    for (const it of searchCache.items)', 'honest interrupted search cache status');
    source = between(source, 'function getRecent() {', '// ---- relevance', `function getRecent() {return nativeServices.uiPreferences().searchRecent || [];}
      async function pushRecent(q) {const query=String(q || '').trim();if(!query || query.length>200 || nativeServices.uiPreferences().incognito)return;await nativeServices.saveUiPreferences({searchRecent:[query,...getRecent().filter(value=>value.toLowerCase()!==query.toLowerCase())].slice(0,10)});}
      async function clearRecent() {await nativeServices.saveUiPreferences({searchRecent:[]});}
    `);
    source = between(source,'function getLangPref() {','// ---- recent queries',`function getLangPref() {return nativeServices.uiPreferences().searchLanguage || 'all';}
      async function setLangPref(value) {await nativeServices.saveUiPreferences({searchLanguage:value});}
    `);
    source = "import {nativeServices} from 'nyora-native-services';\n" + source;
  }
  if (file === 'screens/discover.js') {
    source = replaceOnce(source, 'if (banner) bg.style.backgroundImage = `url("${banner}")`;', "if (banner) bg.appendChild(el('img', { src: banner, alt: '', crossOrigin: 'anonymous', referrerPolicy: 'no-referrer', style: { width: '100%', height: '100%', objectFit: 'cover' } }));", 'public hero banner CORS');
    source = source.replace('localStorage.getItem(FEED_CACHE_KEY)', 'null').replace('localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(feedCache));', '');
  }
  if (file === 'screens/welcome.js') source = source.replace("localStorage.setItem(ONBOARD_KEY, '1');", '');
  if (file === 'app.js') {
    source = source.replace('if (typeof requestIdleCallback === \'function\') requestIdleCallback(startMigrations, { timeout: 8000 });\nelse setTimeout(startMigrations, 4000);', '// Native service DTOs require no browser migrations.');
    source = source.replace('if (typeof requestIdleCallback === \'function\') requestIdleCallback(requestStoragePersistence, { timeout: 6000 });\nelse setTimeout(requestStoragePersistence, 3000);', '// Native stores require no browser storage persistence request.');
  }
  return source;
}
export function unavailableScreen(name) { return `import { el } from '../core/ui.js';\nexport const meta={title:${JSON.stringify(name)},nav:true};\nexport function render(view){view.replaceChildren(el('h1',null,${JSON.stringify(name + ' unavailable')}),el('p',null,'This feature is disabled until its native desktop adapter is implemented.'));}\n`; }
