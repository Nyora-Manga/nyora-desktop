import { replaceOnce } from './frontend-overlay.mjs';

// Apply to screens/library.js only, on the captured desktop build copy.
export function overlayLibraryTools(source) {
  source = replaceOnce(source, `const SORTS = [
  { label: 'Recent', value: 'recent' },
  { label: 'Title', value: 'title' },
];`, 'const SORTS = LIBRARY_SORTS;', 'library parity sorts');
  source = replaceOnce(source, "    sort: 'recent',", "    sort: 'recent',\n    tools: { query: '', source: '', reading: 'all' },", 'library filter state');
  source = replaceOnce(source, "  const countEl = el('span', {", "  const countEl = el('span', { class: 'library-result-count', 'aria-live': 'polite',", 'library result count');
  source = replaceOnce(source, `  const sortSeg = segmented(SORTS, state.sort, (v) => {
    state.sort = v;
    renderGrid();
  });`, `  const sortSeg = el('select', { class: 'input library-sort-select', 'aria-label': 'Sort library',
    onChange: event => { state.sort = event.target.value; renderGrid(); } },
    ...SORTS.map(item => el('option', { value: item.value }, item.label)));`, 'library compact sort');
  source = replaceOnce(source, "  const favSection = el('div', { class: 'library-favourites' }, sortRow, chipsEl, gridHost);", `  const librarySearch = el('input', { class: 'input', type: 'search', placeholder: 'Search your library', 'aria-label': 'Search your library',
    onInput: event => { state.tools.query = event.target.value; renderGrid(); } });
  const sourceFilter = el('select', { class: 'input', 'aria-label': 'Filter library by source',
    onChange: event => { state.tools.source = event.target.value; renderGrid(); } });
  const readingFilter = el('select', { class: 'input', 'aria-label': 'Filter library by reading history', 'aria-describedby': 'library-history-filter-note',
    onChange: event => { state.tools.reading = event.target.value; renderGrid(); } },
    el('option', { value: 'all' }, 'All reading states'),
    el('option', { value: 'with-history' }, 'With recent history'),
    el('option', { value: 'no-history' }, 'No recent history'));
  const quickControls = [['downloaded','Downloaded'],['completed','Completed'],['newChapters','New chapters']].map(([key,label]) => {
    const input = el('input',{type:'checkbox',onChange:event=>{state.tools[key]=event.target.checked;renderGrid();}});
    return {key,input,node:el('label',{class:'library-quick-filter'},input,el('span',null,label))};
  });
  const clearFilters = btn('Clear filters', { variant: 'ghost', onClick: resetFilters });
  const historyNote = el('p', { id: 'library-history-filter-note', class: 'hint library-history-note' },
    'Uses saved recent history. Clearing history or reading privately affects this view.');
  const toolField = (label, control) => el('label', { class: 'library-tools-field' }, el('span', null, label), control);
  const filterSummary = el('summary', { class: 'library-filter-toggle' }, 'Filters');
  const filterDisclosure = el('details', { class: 'library-filter-disclosure' }, filterSummary,
    el('div', { class: 'library-filter-panel' }, toolField('Source', sourceFilter),
      toolField('Reading history', readingFilter), ...quickControls.map(c=>c.node), historyNote, clearFilters));
  const toolsRow = el('div', { class: 'library-tools', role: 'group', 'aria-label': 'Library filters' },
    librarySearch, filterDisclosure, sortRow);
  const subnav = el('nav', { class: 'library-subnav', 'aria-label': 'Library views' },
    ...[['history', 'History'], ['bookmarks', 'Bookmarks'], ['stats', 'Stats']].map(([route, label]) =>
      btn(label, { variant: 'ghost', onClick: () => router.navigate(route) })));
  header.appendChild(subnav);
  const resume = createLibraryResume({ services: globalThis.NYORA_SERVICES?.library, el, btn, icon, router });
  const favSection = el('div', { class: 'library-favourites' },
    ...(resume ? [resume] : []), chipsEl, toolsRow, gridHost);
  filterDisclosure.addEventListener?.('keydown', event => {
    if (event.key === 'Escape') { filterDisclosure.open = false; filterSummary.focus(); }
  });

  function updateSourceFilter() {
    const entries = library.favourites().entries || [];
    sourceFilter.replaceChildren(el('option', { value: '' }, 'All sources'),
      ...librarySourceOptions(entries, state.sources).map(option => el('option', { value: option.value }, option.label)));
    sourceFilter.value = state.tools.source;
  }
  function resetFilters() {
    state.tools = resetLibraryFilters(state.tools);
    librarySearch.value = ''; sourceFilter.value = ''; readingFilter.value = 'all';
    quickControls.forEach(c=>{c.input.checked=false;});
    renderGrid();
  }
  function renderNoMatches() {
    const empty = emptyState('No titles match these filters.', 'search');
    empty.appendChild(btn('Reset filters', { variant: 'ghost', onClick: resetFilters }));
    return empty;
  }`, 'library tools controls');
  source = replaceOnce(source, "    let entries;\n    try {\n      entries = sortEntries(favEntries(), state.sort);", `    let entries, unfiltered;
    try {
      unfiltered = favEntries();
      const snapshot = globalThis.NYORA_SERVICES?.library?.snapshot() || {};
      const known = new Map((snapshot.favourites || []).map(m=>[String(m.id),m]));
      entries = selectLibraryEntries(unfiltered.map(m=>({...m,libraryAddedAt:known.get(String(m.id))?.libraryAddedAt || 0})),
        { ...state.tools, sort: state.sort }, library.history().entries || [],
        {...snapshot,downloads:globalThis.NYORA_SERVICES?.downloads?.list() || []});
      const filtered = hasLibraryFilters(state.tools);
      const totalTitles = (library.favourites().entries || []).length;
      toolsRow.hidden = !totalTitles;
      chipsEl.hidden = !totalTitles && !state.categories.length;
      const filterCount = Number(!!state.tools.source) + Number(state.tools.reading !== 'all') + quickControls.filter(c=>state.tools[c.key]).length;
      filterSummary.textContent = filterCount ? 'Filters (' + filterCount + ')' : 'Filters';
      clearFilters.hidden = !filtered;
      historyNote.hidden = state.tools.reading === 'all' && !['read','read-oldest'].includes(state.sort);
      countEl.textContent = filtered ? entries.length + ' of ' + unfiltered.length + ' titles' : (entries.length === 1 ? '1 title' : entries.length + ' titles');`, 'library cached filtering boundary');
  source = replaceOnce(source, '      gridHost.replaceChildren(renderEmpty());', '      gridHost.replaceChildren(unfiltered.length && hasLibraryFilters(state.tools) ? renderNoMatches() : renderEmpty());', 'library no matches');
  source = replaceOnce(source, `    const wrap = emptyState("It's kind of empty here…", 'inbox');
    wrap.appendChild(
      btn('Explore', { variant: 'accent', icon: 'compass', onClick: () => router.navigate('explore') }),
    );`, `    const wrap = el('section', { class: 'library-welcome', 'aria-label': 'Empty library' },
      el('div', { class: 'library-welcome-mark', 'aria-hidden': 'true' }, icon('library')),
      el('h2', null, 'Your library starts here'),
      el('p', null, 'Save a title from a source, or bring your own comics. Your next chapter will be waiting here.'),
      el('div', { class: 'library-welcome-actions' },
        btn('Browse sources', { variant: 'accent', icon: 'compass', onClick: () => router.navigate('explore') }),
        btn('Import comics', { variant: 'ghost', icon: 'folder', onClick: () => importLibraryComics({ files: globalThis.NYORA_SERVICES?.files, router, toast }) })));`, 'library actionable empty state');
  source = replaceOnce(source, "    const onFav = state.tab === 'favourites';", "    const onFav = state.tab === 'favourites';\n    tabRow.hidden = onFav;", 'library legacy downloads tab');
  source = replaceOnce(source, '  // ---- boot ----------------------------------------------------------', '  // ---- boot ----------------------------------------------------------\n\n  updateSourceFilter();', 'library initial source options');
  source = replaceOnce(source, '  installedSources().then((sources) => { state.sources = sources || []; });', '  installedSources().then((sources) => { if (!favSection.isConnected) return; state.sources = sources || []; updateSourceFilter(); });', 'library source labels');
  source = replaceOnce(source, '  applyTab();\n\n  // Loading', `  applyTab();
  const offLibrary = library.onChange(()=>{if(favSection.isConnected){updateSourceFilter();renderGrid();}});
  const nativeDownloads = globalThis.NYORA_SERVICES?.downloads;
  const offDownloads = nativeDownloads?.subscribe(()=>{if(favSection.isConnected)renderGrid();});
  nativeDownloads?.hydrate().catch(()=>{});
  const observer = new MutationObserver(()=>{if(!favSection.isConnected){offLibrary?.();offDownloads?.();observer.disconnect();}});
  observer.observe(view,{childList:true});

  // Loading`, 'library reactive filters');
  return `import { createLibraryResume, importLibraryComics } from 'nyora-library-presentation';\nimport { LIBRARY_SORTS, selectLibraryEntries, librarySourceOptions, hasLibraryFilters, resetLibraryFilters } from 'nyora-library-tools';\n` + source;
}

// Apply after native mutations to core/ui.js. The menu's existing callbacks
// (including acknowledged native saves) are retained verbatim.
export function overlayReadingRoomCards(source) {
  const start = source.indexOf('export function card(manga, onClick) {');
  const end = source.indexOf('// ---- modal / dialogs', start);
  if (start < 0 || end < 0) throw new Error('Shared frontend drift: desktop cover card boundary.');
  let card = source.slice(start, end);
  card = replaceOnce(card, "{ class: 'card', role: 'button', tabindex: '0' }", "{ class: 'card reading-room-card' }", 'card separate native controls');
  card = replaceOnce(card, "el('div', { class: 'card-body' },", "el('button', { class: 'card-body card-open', type: 'button', 'aria-label': 'Open ' + (title || 'Untitled'), disabled: !onClick },", 'card open button');
  card = replaceOnce(card, `  if (onClick) {
    node.addEventListener('click', () => onClick(manga));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(manga);
      }
    });
  }`, `  const openButton = node.querySelector('.card-open');
  if (onClick) openButton.addEventListener('click', () => onClick(manga));
  const source = manga.source;
  const sourceLabel = typeof source === 'string' ? source : source?.title || source?.name || source?.id;
  if (sourceLabel) openButton.appendChild(el('span', { class: 'card-source', title: String(sourceLabel).replace(/^data:/, '') }, String(sourceLabel).replace(/^data:/, '')));`, 'card native keyboard and source attribution');
  card = replaceOnce(card, '  attachContextMenu(node, () => {', '  const getCardActions = () => {', 'card shared context actions');
  card = replaceOnce(card, `    ];
  });
  return node;`, `    ];
  };
  attachContextMenu(node, getCardActions);
  const more = el('button', { class: 'card-overflow', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Actions for ' + (title || 'Untitled'), title: 'Title actions' }, '⋯');
  more.addEventListener('click', event => {
    event.stopPropagation();
    more.focus();
    const bounds = more.getBoundingClientRect();
    contextMenu(getCardActions(), bounds.left, bounds.bottom + 4);
  });
  node.appendChild(more);
  return node;`, 'card overflow menu');
  return source.slice(0, start) + card + source.slice(end);
}
