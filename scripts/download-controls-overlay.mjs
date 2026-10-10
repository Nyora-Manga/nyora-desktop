import { replaceOnce } from './frontend-overlay.mjs';

// Apply after the existing native service and mutation overlays. Shared web
// sources remain untouched; drift in the replaced function fails the build.
export function overlayDownloadControls(source) {
  const start = source.indexOf('function paintQueue(view, host) {');
  const end = source.indexOf('\nfunction downloadRow(view, job) {', start);
  if (start < 0 || end < 0 || source.indexOf('function paintQueue(view, host) {', start + 1) >= 0) throw new Error('Shared frontend drift: download queue render');
  source = source.slice(0,start) + queueRender + source.slice(end);
  source = replaceOnce(source,"  return el('div', { class: 'row-item' }, main, actions);", "  return el('div', { class: 'row-item', 'data-download-id': job.id }, main, actions);", 'download focus identity');
  source = replaceOnce(source,"        : 'Queued'));", "        : (downloads.queuePaused() ? 'Queued · paused' : 'Queued')));", 'paused queued label');
  source = replaceOnce(source,"const determinate = status === 'RUNNING' && total > 0;", "const determinate = status === 'RUNNING' && total > 0;\n    const held = status === 'QUEUED' && downloads.queuePaused();", 'held download activity');
  source = replaceOnce(source,"class: determinate ? 'progress' : 'progress indeterminate'", "class: held ? 'progress queue-held' : determinate ? 'progress' : 'progress indeterminate'", 'held progress presentation');
  return "import { desktopMutation as downloadControlMutation } from 'nyora-native-services';\n" + source;
}

const queueRender = `const pendingDownloadControls = new Set();
function replaceDownloadQueue(host, fragment) {
  const focused = document.activeElement;
  const rowId = host.contains(focused) ? focused.closest('[data-download-id]')?.dataset.downloadId : null;
  const action = host.contains(focused) ? focused.dataset.downloadQueueAction : null;
  const label = focused?.getAttribute('aria-label') || focused?.getAttribute('title');
  host.replaceChildren(fragment);
  const target = action ? [...host.querySelectorAll('[data-download-queue-action]')].find(node => node.dataset.downloadQueueAction === action)
    : rowId ? [...host.querySelectorAll('[data-download-id]')].find(node => node.dataset.downloadId === rowId)?.querySelectorAll('button') : null;
  const button = target && typeof target.focus === 'function' ? target : target ? [...target].find(node => (node.getAttribute('aria-label') || node.getAttribute('title')) === label) : null;
  if(button && !button.disabled) button.focus({preventScroll:true});
}
function paintQueue(view, host) {
  const rows = downloads.list(), paused = downloads.queuePaused();
  const fragment = document.createDocumentFragment();
  const control = (label,key,operation,onSuccess) => {
    const button = btn(label,{variant:'ghost',class:'btn-sm',onClick:async()=>{
      if(pendingDownloadControls.has(key))return;
      pendingDownloadControls.add(key); paintQueue(view,host);
      try { const result = await downloadControlMutation(operation); onSuccess?.(result); }
      catch {} // The native mutation wrapper publishes the visible error.
      finally { pendingDownloadControls.delete(key); if(host.isConnected)paintQueue(view,host); }
    }});
    button.dataset.downloadQueueAction=key; button.disabled=pendingDownloadControls.has(key); return button;
  };
  const ordinaryFailed=rows.filter(job=>job.status==='FAILED' && job.errorCode!=='SOURCE_VERIFICATION_REQUIRED');
  const controls=el('div',{class:'download-queue-controls'},control(paused?'Resume queue':'Pause queue','pause',()=>paused?downloads.resume():downloads.pause()));
  if(ordinaryFailed.length)controls.append(control('Retry failed ('+ordinaryFailed.length+')','retry-failed',()=>downloads.retryFailed(),result=>toast(result.requeued?'Queued '+result.requeued+' failed chapters':'No failed chapters to retry')));
  fragment.append(controls,el('p',{class:'download-queue-guidance',role:'status'},paused?'Queue paused. Current chapters finish; queued chapters wait until you resume.':'Pausing lets current chapters finish and holds queued chapters.'));
  if(!rows.length)fragment.append(emptyState('No downloads yet — open a manga and tap Download.','download'));
  for(const [status,title] of [['RUNNING','Running'],['QUEUED',paused?'Queued · paused':'Queued'],['FAILED','Failed'],['COMPLETED','Completed'],['CANCELLED','Cancelled']]) {
    const group=rows.filter(job=>job.status===status);if(!group.length)continue;
    const actions=[];
    if(status==='RUNNING'||status==='QUEUED') {
      const active=rows.filter(job=>ACTIVE.has(job.status));
      if(status==='RUNNING'||!rows.some(job=>job.status==='RUNNING'))actions.push(control('Cancel all ('+active.length+')','cancel-all',()=>downloads.cancelAll(),()=>toast('Downloads cancelled')));
    }
    if(status==='COMPLETED' && group.filter(job=>job.offline).length>1)actions.push(control('Save all','save-all',()=>downloads.saveBundle(group.filter(job=>job.offline).map(job=>job.id)),result=>toast(result.status==='cancelled'?'Export cancelled':result.ok?'Saved '+result.count+' chapters':'Nothing to save')));
    fragment.append(sectionHeader(title+' ('+group.length+')',...actions));
    const list=el('div',{class:'list'});for(const job of group)list.append(downloadRow(view,job));fragment.append(list);
  }
  for(const warning of downloads.warnings())fragment.prepend(el('p',{role:'status'},warning.message));
  if(downloads.error())fragment.prepend(errorBox(downloads.error()),control('Retry loading downloads','reload',()=>downloads.hydrate()));
  replaceDownloadQueue(host,fragment);
}
`;
