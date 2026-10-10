import {replaceOnce} from './frontend-overlay.mjs';
export function overlayReaderParity(source,file) {
  if(file==='screens/settings.js') return replaceOnce(source,"{ value: 'PAGED_RTL', label: 'Paged RTL' }", "{ value: 'PAGED_RTL', label: 'Paged RTL' }, {value:'VERTICAL',label:'Vertical pages'}",'vertical default');
  if(file==='screens/reader.js') {
    source=replaceOnce(source,"['WEBTOON', 'PAGED', 'PAGED_RTL']","['WEBTOON', 'PAGED', 'PAGED_RTL', 'VERTICAL']",'vertical title mode');
    source=replaceOnce(source,"{ label: 'Webtoon', value: 'WEBTOON' }","{label:'Vertical',value:'VERTICAL'}, { label: 'Webtoon', value: 'WEBTOON' }",'vertical mode control');
    source=replaceOnce(source,"class: 'reader-paged-track' + (fit === 'HEIGHT' ? ' fit-height' : ' fit-width')","class: 'reader-paged-track' + (mode === 'VERTICAL' ? ' vertical' : '') + (fit === 'HEIGHT' ? ' fit-height' : ' fit-width')",'vertical track');
    source=replaceOnce(source,"inline: 'center', block: 'nearest'","inline: 'center', block: mode === 'VERTICAL' ? 'center' : 'nearest'",'vertical page jump');
    const start=source.indexOf('    const mid = r.left + r.width / 2;');
    const end=source.indexOf('    if (best !== st.currentPage)',start);
    if(start<0||end<0)throw new Error('Reader slide detection drift');
    source=source.slice(0,start)+`    const best = nearestSlide(r, [...track.children].map(slide=>slide.getBoundingClientRect()), mode==='VERTICAL');\n`+source.slice(end);
    source=replaceOnce(source,"    st.chapters = (details && details.chapters) || st.chapters || [];","    st.chapters = chaptersForBranch((details && details.chapters) || st.chapters || [], st.chapterUrl);",'reader branch navigation');
    source=replaceOnce(source,"const stage = el('div', { class: 'reader-paged' }, track, ...zones);","const stage = el('div', { class: 'reader-paged' + (mode === 'VERTICAL' ? ' vertical' : '') }, track, ...zones);",'vertical tap zones');
    return `import {chaptersForBranch, nearestSlide} from 'nyora-reader-parity';\n`+source;
  }
  if(file==='screens/details.js') {
    source=replaceOnce(source,"const state2 = { filter: 'all', sortKey: 'number', asc: false, query: '' };","const state2 = { filter: 'all', sortKey: 'number', asc: false, query: '', branch: null };",'chapter branch state');
    source=replaceOnce(source,'let list = ascByNumber.slice();',"let list = ascByNumber.filter(c=>state2.branch===null || chapterBranch(c)===state2.branch);",'chapter branch filter');
    source=replaceOnce(source,'    const unread = unreadCount();',"    const visible = readingOrder.filter(c=>state2.branch===null || chapterBranch(c)===state2.branch);\n    const unread = visible.filter(c=>!isRead(c)).length;",'branch unread count');
    source=replaceOnce(source,'`${readingOrder.length} chapters · ${unread} unread`','`${visible.length} chapters · ${unread} unread`','branch total count');
    source=replaceOnce(source,'const cta = buildCTA(sid, url, mangaId, chapters, ascByNumber, isRead);',"const cta = el('div', {class:'chapter-branch-cta'}, buildCTA(sid, url, mangaId, chapters, ascByNumber, isRead));",'branch start reading');
    source=replaceOnce(source,'openDownloadDialog(sid, url, mangaId, title, chapters));','openDownloadDialog(sid, url, mangaId, title, chapters.filter(c=>state2.branch===null || chapterBranch(c)===state2.branch)));','branch download');
    // Only mark-all handlers own state2; the download dialog already receives filtered chapters.
    source=source.replace(/for \(const c of readingOrder\) (?=(?:await )?setRead\()/g, 'for (const c of readingOrder.filter(c=>state2.branch===null || chapterBranch(c)===state2.branch)) ');
    source=replaceOnce(source,'if ((Number(x.number) || 0) <= n)', 'if (chapterBranch(x)===chapterBranch(c) && (Number(x.number) || 0) <= n)', 'mark previous within branch');
    source=replaceOnce(source,"  const chapters2 = el('div',",`  const branches = [...new Set(chapters.map(chapterBranch))];
  const branchSelect = el('select',{class:'input chapter-branch-select','aria-label':'Chapter branch',onChange:event=>{
    state2.branch=event.target.value==='all'?null:branches[Number(event.target.value)];renderRows();
    const selected=chapters.filter(c=>state2.branch===null || chapterBranch(c)===state2.branch);
    cta.replaceChildren(buildCTA(sid,url,mangaId,selected,ascByNumber.filter(c=>selected.includes(c)),isRead));
  }},el('option',{value:'all'},'All translations'),...branches.map((branch,index)=>el('option',{value:String(index)},branch||'Default translation')));
  branchSelect.hidden=branches.length<2;
  const chapters2 = el('div',`, 'chapter branch selector');
    source=replaceOnce(source,"{ class: 'd2-toolbar-r' }, markAllBtn, filterBtn, sortBtn","{ class: 'd2-toolbar-r' }, branchSelect, markAllBtn, filterBtn, sortBtn",'chapter branch toolbar');
    // Reading one branch must never mark another translation read.
    source=replaceOnce(source,'return Number.isFinite(n) ? n <= lastNum : false;', 'return chapterBranch(c) === chapterBranch(last) && Number.isFinite(n) ? n <= lastNum : false;', 'branch derived read');
    source=replaceOnce(source,'return (c) => readingOrder.indexOf(c) >= lastIdx;', 'return (c) => chapterBranch(c) === chapterBranch(last) && readingOrder.indexOf(c) >= lastIdx;', 'unnumbered branch read');
    return `import {chapterBranch} from 'nyora-reader-parity';\n`+source;
  }
  return source;
}
