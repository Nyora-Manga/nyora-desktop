import { replaceOnce } from './frontend-overlay.mjs';
export function overlaySourceFilters(source) {
  source=replaceOnce(source,"    mode: 'POPULAR',","    mode: 'POPULAR',\n    browseFilters: [],\n    browseRequestPage: 1,",'source filter state');
  source=replaceOnce(source,'exploreCache.sourceId === wantSourceId && exploreCache.entries.length','exploreCache.sourceId === wantSourceId','restore empty filtered sessions');
  source=replaceOnce(source,"    state.query = hit ? exploreCache.query : '';","    state.query = hit ? exploreCache.query : '';\n    state.browseFilters = hit ? structuredClone(exploreCache.browseFilters || []) : [];",'restore source filters');
  source=replaceOnce(source,'sourceId: store.source.id, mode: state.mode, query: state.query,','sourceId: store.source.id, mode: state.mode, query: state.query, browseFilters: structuredClone(state.browseFilters),','cache applied filters');
  source=replaceOnce(source,'    browsePane.appendChild(browseHeader());',`    browsePane.appendChild(browseHeader());
    if (state.browseFilters.length) browsePane.appendChild(el('div', {class:'browse-filter-summary', 'aria-label':'Applied filters'},
      ...state.browseFilters.map(item=>el('span', null,
        item.name === 'Tags' ? item.value.split(',').length + ' genres included' :
        item.name === 'Excluded tags' ? item.value.split(',').length + ' genres excluded' :
        filterLabel(item.name) + ': ' + item.value.split(',').map(filterLabel).join(' · '))),
      btn('Clear filters', {variant:'ghost', onClick:()=>applySourceFilters([],state.query)})));
`, 'applied filter summary');
  source=replaceOnce(source,"    if (state.mode === 'SEARCH') {", "    if (state.mode === 'SEARCH' && !state.browseFilters.length) {",'filtered title search lives in panel');
  source=replaceOnce(source,"state.mode = m; state.entries = []; state.browseError = null;", "state.mode = m; state.browseFilters = []; state.entries = []; state.browseError = null;",'mode switch resets advanced filters');
  source=replaceOnce(source,"{ label: 'Search', value: 'SEARCH' }", "{ label: state.browseFilters.length ? 'Filtered' : 'Search', value: 'SEARCH' }",'filtered browse mode label');
  source=replaceOnce(source,"        iconBtn('refresh', () => loadBrowse(1, true), 'Refresh'),",`        btn(state.browseFilters.length ? 'Filter & sort (' + state.browseFilters.length + ')' : 'Filter & sort', {
          variant: state.browseFilters.length ? 'accent' : 'ghost',
          onClick:()=>{ if(store.source) openSourceFilters({el,btn,modal,api,source:store.source,
            filters:state.browseFilters,query:state.mode==='SEARCH'?state.query:'',onApply:applySourceFilters}); }
        }),
        iconBtn('refresh', () => loadBrowse(1, true), 'Refresh'),`, 'source filters entry point');
  source=source.replaceAll("state.mode === 'SEARCH' && !state.query", "state.mode === 'SEARCH' && !state.query && !state.browseFilters.length");
  source=replaceOnce(source,"    if (state.mode === 'SEARCH' && !state.query && !state.browseFilters.length) { renderBrowse(); return; }", "    if (state.mode === 'SEARCH' && !state.query && !state.browseFilters.length) { ++state.browseToken; state.browseLoading=false; state.hasNext=false; syncExploreCache(); renderBrowse(); return; }",'empty search invalidates prior requests');
  source=replaceOnce(source,'    state.page = page;\n    state.browseLoading = true;', '    state.browseLoading = true;\n    state.browseRequestPage = page;\n    if (page === 1) state.hasNext = false;', 'advance page only after success');
  source=replaceOnce(source,'api.search(src.id, state.query, page)', 'api.search(src.id, state.query, page, state.browseFilters)', 'send applied filters to source');
  source=replaceOnce(source,'      state.hasNext = !!(res && res.hasNextPage);', '      state.page = page;\n      state.hasNext = !!(res && res.hasNextPage);', 'commit successful filtered page');
  source=replaceOnce(source,'  async function loadBrowse(page, force = false) {',`  function applySourceFilters(filters, query) {
    if (!root.isConnected) return;
    state.browseFilters = structuredClone(filters);
    state.query = query;
    state.mode = filters.length || query ? 'SEARCH' : 'POPULAR';
    state.entries = []; state.page = 1; state.hasNext = false;
    syncExploreCache();
    loadBrowse(1);
  }

  async function loadBrowse(page, force = false) {`, 'apply filters resets pagination');
  source=replaceOnce(source, 'request.params.page === state.page && (state.mode', 'request.params.page === state.browseRequestPage && (state.mode', 'recover attempted filtered page');
  source=replaceOnce(source, 'request.params.q === state.query.trim()', "request.params.q === state.query.trim() && (request.params.f || '[]') === JSON.stringify(state.browseFilters)", 'ignore recovered requests for older filters');
  source=replaceOnce(source, 'if (matching) loadBrowse(state.page, true);', 'if (matching) loadBrowse(state.browseRequestPage, true);', 'retry exact filtered page');
  return "import { openSourceFilters } from 'nyora-source-filters';\nimport { filterLabel } from 'nyora-source-filter-state';\n"+source;
}
