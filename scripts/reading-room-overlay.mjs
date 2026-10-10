import { replaceOnce } from './frontend-overlay.mjs';

// Desktop composition runs after native service/mutation overlays. Keep the
// existing builders and request lifecycle; assert every changed render boundary.
function replaceBlock(source, start, end, replacement) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) throw new Error(`Shared frontend drift: reading room ${start}`);
  return source.slice(0, a) + replacement + '\n\n' + source.slice(b);
}

export function overlayReadingRoom(source, key) {
  if (key === 'screens/explore.js') {
    source = replaceOnce(source, "title: 'Explore', nav: true", "title: 'Sources', nav: true", 'Sources navigation title');
    source = replaceOnce(source, "modal({ title: 'Catalog',", "modal({ title: 'Source catalog',", 'source catalog title');
    source = replaceOnce(source, "placeholder: 'Search extensions…',", "placeholder: 'Search sources…', 'aria-label': 'Search source catalog',", 'source catalog search label');
    source = replaceOnce(source, "    filter: '',", "    filter: '',\n    pinnedOnly: false,", 'source pinned filter state');
    source = replaceBlock(source, '  function sourcesSection() {', '  function sourceTile(src) {', sourceSection);
    // A keyboard activation on the nested pin must not also open the source.
    source = replaceOnce(source,
      "onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSource(src); } },",
      "onKeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectSource(src); } },",
      'source pin keyboard isolation');
  }
  if (key === 'screens/settings.js') {
    source = replaceBlock(source, 'export function render(view, params) {', 'function buildAppearance() {', settingsRender);
    // Community destinations are in native About; the global header no longer
    // contains them, so its old visibility preference has no useful effect.
    source = replaceBlock(source,
      "  section.append(settingRow('Community links',",
      "  section.append(settingRow('Show titles under covers',", '');
    source = replaceOnce(source, "btn('Export native backup',", "btn('Create backup',", 'desktop Create backup label');
    source = replaceOnce(source, "btn('Import and merge native backup',", "btn('Restore backup',", 'desktop Restore backup label');
    source = replaceOnce(source,
      "function buildAppearance() {\n  const prefs = store.get();\n  const section = el('section', { class: 'settings-section' });",
      `function buildAppearance() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(el('aside', {class:'reading-appearance-preview', 'aria-label':'Live appearance preview'},
    el('span', {class:'reading-preview-marker', 'aria-hidden':'true'}),
    el('span', {class:'reading-preview-label'}, 'LIVE PREVIEW'),
    el('h3', null, 'Your reading room'),
    el('p', null, 'A little space for your next chapter.')));`, 'live appearance preview');
  }
  if (key === 'screens/details.js') {
    source = replaceOnce(source,
      "  const state2 = { filter: 'all', sortKey: 'number', asc: false };",
      "  const state2 = { filter: 'all', sortKey: 'number', asc: false, query: '' };", 'chapter search state');
    source = replaceOnce(source,
      "    const unread = unreadCount();",
      `    const query = state2.query.trim().toLocaleLowerCase();
    if (query) list = list.filter(chapter => {
      const originalIndex = readingOrder.length - 1 - readingOrder.indexOf(chapter);
      return fmt.chapterTitle(chapter, originalIndex).toLocaleLowerCase().includes(query)
        || String(chapter.number ?? '').toLocaleLowerCase().includes(query);
    });
    const unread = unreadCount();`, 'chapter title and number filtering');
    source = replaceOnce(source,
      '    countEl.textContent = `'+ '${readingOrder.length} chapters · ${unread} unread`;',
      '    countEl.textContent = query ? `'+ '${list.length} matching · ${readingOrder.length} chapters` : `${readingOrder.length} chapters · ${unread} unread`;', 'chapter matched count');
    source = replaceOnce(source,
      "emptyState(state2.filter === 'unread' ? 'All caught up.' : 'Nothing here.')",
      "emptyState(query ? 'No chapters match this search and filter.' : state2.filter === 'unread' ? 'All caught up.' : 'Nothing here.')", 'chapter search empty state');
    source = replaceOnce(source,
      "  const chapters2 = el('div', { class: 'd2-chapters' },",
      `  const chapterSearch = el('input', {
    class: 'input reading-chapter-search', type: 'search', placeholder: 'Search chapters',
    'aria-label': 'Search chapters', value: state2.query,
    onInput: event => { state2.query = event.target.value; renderRows(); },
  });
  const chapters2 = el('div', { class: 'd2-chapters' },`, 'chapter search field');
    source = replaceOnce(source,
      "    el('div', { class: 'd2-chapter-scroll' }, listHost),",
      "    el('div', { class: 'reading-chapter-searchbar' }, chapterSearch),\n    el('div', { class: 'd2-chapter-scroll' }, listHost),", 'chapter search toolbar');
  }
  if (key === 'screens/downloads.js') {
    source = replaceOnce(source,
      "el('div', { class: 'dl-storage-actions' }, clearDone, clearAll)",
      "el('details', { class: 'dl-storage-actions reading-download-actions' }, el('summary', null, 'Manage downloads'), el('div', {class:'reading-download-menu'}, clearDone, clearAll))",
      'secondary download management');
    source = replaceOnce(source, '    const c = downloads.counts();', `    const c = downloads.counts();
    node.hidden = !downloads.list().length;
    clearDone.hidden = !downloads.list().some(job => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status));`, 'empty download storage actions');
    source = replaceOnce(source, "  fragment.append(controls,el('p',{class:'download-queue-guidance',role:'status'},", "  if(rows.length)fragment.append(controls,el('p',{class:'download-queue-guidance',role:'status'},", 'empty queue controls');
    source = replaceOnce(source,
      "  if(!rows.length)fragment.append(emptyState('No downloads yet — open a manga and tap Download.','download'));",
      `  if(!rows.length && !downloads.error()) {
    const browse = btn('Browse library', {variant:'accent', onClick:()=>router.navigate('library')});
    browse.dataset.downloadQueueAction = 'browse-library';
    fragment.append(el('section', {class:'reading-room-empty'},
      el('div', {class:'reading-room-empty-icon', 'aria-hidden':'true'}, '↓'),
      el('h2', null, 'Ready for offline reading'),
      el('p', null, 'Download chapters from a title in your library. They’ll be ready here when you need them.'),
      browse));
  }`, 'actionable download empty state');
  }
  if (key === 'screens/discover.js') {
    source = replaceOnce(source, "  root.append(body);", "  root.append(sectionHeader('Discover'), body);", 'discovery page title');
    source = replaceOnce(source, `    body.replaceChildren(
      errorBox("Couldn't load discovery right now."),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body, { forceRefresh: true }) }),
      ),
    );`, `    body.replaceChildren(readingRoomDiscoveryState('error', () => load(body, { forceRefresh: true })));`, 'discovery error state');
    source = replaceOnce(source, `    body.replaceChildren(
      emptyState('Nothing to discover right now — check back soon.', 'trending'),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body, { forceRefresh: true }) }),
      ),
    );`, `    body.replaceChildren(readingRoomDiscoveryState('empty', () => load(body, { forceRefresh: true })));`, 'discovery no results state');
    // Preserve the distinction between a failed feed and a valid empty result.
    source = replaceOnce(source, '    return EMPTY_FEED;', "    throw new Error('Recommendations could not be loaded.');", 'discovery transport failure');
    source += '\n' + discoveryState;
  }
  return source;
}

const sourceSection = `  function sourcesSection() {
    const wrap = el('div', { class: 'explore-sources reading-room-sources' });
    const body = el('div', { class: 'explore-sources-body' });
    const count = el('span', { class: 'reading-source-count', role:'status', 'aria-live':'polite' });
    const search = el('input', {
      class:'input reading-source-search', type:'search', placeholder:'Search sources',
      'aria-label':'Search sources', value:state.filter,
      onInput:event=>{state.filter=event.target.value;paintSources();},
    });
    const { el:langSel, langCount } = buildLangSelect(renderLanding);
    const pinned = btn('Pinned only', {variant:'ghost',onClick:()=>{
      state.pinnedOnly=!state.pinnedOnly;
      pinned.setAttribute('aria-pressed', String(state.pinnedOnly));
      paintSources();
    }});
    pinned.setAttribute('aria-pressed', String(!!state.pinnedOnly));
    wrap.append(sectionHeader('Sources', btn('Source catalog', {variant:'ghost', onClick:openExtensions})),
      el('p', {class:'reading-room-intro'}, 'Find a source, then explore its collection. Pin your favourites to keep them close.'),
      el('div', {class:'reading-source-toolbar'}, search, langCount>1?langSel:null, pinned), count, body);
    function paintSources() {
      body.replaceChildren();
      count.textContent='';
      if(state.sourcesLoading){body.append(el('div',{class:'center',style:{padding:'32px 0'}},spinner()));return;}
      if(state.sourcesError){body.append(errorBox(state.sourcesError),btn('Retry',{variant:'ghost',onClick:()=>loadSources()}));return;}
      if(!installedVisible().length){body.append(emptyState('No sources installed yet.','compass'),btn('Open catalog',{variant:'accent',onClick:openExtensions}));return;}
      const shown=filteredSources().filter(source=>!state.pinnedOnly || source.isPinned);
      count.textContent=shown.length+' source'+(shown.length===1?'':'s');
      if(!shown.length){body.append(emptyState('No sources match these filters. Try another name or language.','compass'));return;}
      const byName=(a,b)=>(a.name||'').localeCompare(b.name||'');
      for(const [label,group] of [['Pinned sources',shown.filter(source=>source.isPinned)],['All sources',shown.filter(source=>!source.isPinned)]]){
        if(!group.length)continue;
        body.append(el('h2',{class:'reading-source-group'},label));
        const grid=el('div',{class:'source-grid'});
        for(const source of group.sort(byName))grid.append(sourceTile(source));
        body.append(grid);
      }
    }
    paintSources();
    return wrap;
  }`;

const settingsRender = `export function render(view, params) {
  view.replaceChildren();
  const s=params && params.s;
  const sub=params && params.sub;
  const section=SECTIONS.find(item=>item.id===(s || 'appearance'));
  if(!section){router.navigate('settings');return;}
  view.append(sectionHeader('Settings'));
  const list=el('nav',{class:'settings-nav reading-settings-categories','aria-label':'Settings categories'});
  for(const item of SECTIONS){
    const row=navRow(item.name,item.sub,item.icon,()=>router.navigate('settings',{s:item.id}));
    if(item.id===section.id){row.classList.add('is-current');row.setAttribute('aria-current','page');}
    list.append(row);
  }
  const detail=el('div',{class:'reading-settings-detail'});
  const layout=el('div',{class:'reading-settings-layout'+(s?' has-selection':' is-hub')},list,detail);
  view.append(layout);
  if(s==='experimental' && sub && EXP_CHILDREN[sub]){
    const child=EXP_CHILDREN[sub];
    const back=iconBtn('back',()=>router.navigate('settings',{s:'experimental'}),'Back to Experimental');
    detail.append(el('div',{class:'settings-subheader reading-settings-nested'},back,el('h1',null,child.name)));
    if(store.get().experimental!==true)detail.append(el('p',{class:'exp-hint'},'Enable experimental features to use this.'));
    detail.append(child.build());return;
  }
  const back=iconBtn('back',()=>router.navigate('settings'),'Back to settings');
  detail.append(el('div',{class:'settings-subheader'},back,el('h1',null,section.name)),section.build());
}`;

const discoveryState = `function readingRoomDiscoveryState(kind, retry) {
  const offline=typeof navigator!=='undefined' && navigator.onLine===false;
  const title=offline?'You’re offline':kind==='empty'?'No recommendations right now':'Recommendations couldn’t load';
  const message=offline?'Your library and downloaded chapters are still here. Reconnect to refresh recommendations.':kind==='empty'?'Try again later, or find your next read in Sources.':'The discovery service may be temporarily unavailable. You can keep reading from your library or browse a source.';
  return el('section',{class:'reading-room-empty'},
    el('div',{class:'reading-room-empty-icon','aria-hidden':'true'},'✦'),
    el('h2',null,title),el('p',null,message),
    el('div',{class:'reading-room-empty-actions'},
      btn('Open library',{variant:'accent',onClick:()=>router.navigate('library')}),
      btn('Browse sources',{variant:'ghost',onClick:()=>router.navigate('explore')}),
      btn('Retry',{variant:'ghost',icon:'refresh',onClick:retry})));
}`;
