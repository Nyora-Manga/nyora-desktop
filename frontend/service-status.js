import { nativeImageRetries } from './native-images.js';
import { verificationInstructions, formatCookieStatus, verificationAction, updateSourceVerification } from './source-verification.js';

export function createVerificationActions(adapter, services, images, reload) {
  async function assertClosed(sourceId) {
    const entries = await adapter.verificationStatus();
    if (entries.some((entry) => entry.sourceId === sourceId && entry.phase === 'verification-opened')) throw new Error('Close the verification window, then retry.');
  }
  async function retryContent(sourceId) {
    try {
      const result = await services.retryContent(sourceId);
      await reload(sourceId, result?.retriedRequests);
      return result;
    } catch (error) {
      if (error.retriedRequests?.length) await reload(sourceId, error.retriedRequests);
      throw error;
    }
  }
  const retryImages = sourceId => images.retrySourceAndWait ? images.retrySourceAndWait(sourceId) : images.retrySource(sourceId);
  return Object.freeze({
    open: (sourceId) => adapter.openVerification(sourceId),
    async retryImages(sourceId) { await assertClosed(sourceId); return retryImages(sourceId); },
    async retryContent(sourceId) {
      await assertClosed(sourceId);
      if (!services.canRetryContent(sourceId)) throw new Error('No failed source request to retry.');
      return retryContent(sourceId);
    },
    async resume(sourceId, manual) {
      await assertClosed(sourceId);
      // Each failed media request remains independent of content recovery. One
      // continued challenge cannot prevent another page/cover from resuming.
      const results = await Promise.allSettled([
        (async () => {
          if (services.canRetryContent(sourceId)) return retryContent(sourceId);
          if (manual) return services.checkSourceAccess(sourceId);
        })(),
        (async () => retryImages(sourceId))(),
      ]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(failures.map(result => result.reason?.message || result.reason).join('; '));
    },
  });
}

export function createVerificationResumer(resume, changed = () => {}) {
  const consumed = new Map(), states = new Map(), running = new Map();
  function run(entry) {
    if (running.has(entry.sourceId)) return running.get(entry.sourceId).pending;
    const state = { verificationId: entry.verificationId, state: 'checking' };
    states.set(entry.sourceId, state); changed();
    const pending = Promise.resolve().then(() => resume(entry.sourceId, !!entry.manual)).then(
      () => { state.state = 'attempted'; },
      error => { state.state = 'failed'; state.error = String(error.message || error); },
    ).finally(() => { running.delete(entry.sourceId); changed(); });
    running.set(entry.sourceId, { verificationId: entry.verificationId, pending });
    return pending;
  }
  return Object.freeze({
    status: (sourceId, verificationId) => states.get(sourceId)?.verificationId === verificationId ? states.get(sourceId) : running.has(sourceId) ? { verificationId, state: 'checking' } : undefined,
    states: () => new Map(states),
    retry: run,
    async observe(entries) {
      const pending = [];
      for (const entry of entries) {
        if (entry.phase !== 'retry-required' || !entry.verificationId || entry.cookies?.state === 'saving' || consumed.get(entry.sourceId) === entry.verificationId) continue;
        if (running.has(entry.sourceId) && running.get(entry.sourceId).verificationId !== entry.verificationId) continue;
        // Claim before starting any asynchronous work, including polling/focus
        // refreshes. A missed open poll and repeated challenge still get one try.
        consumed.set(entry.sourceId, entry.verificationId);
        pending.push(run(entry));
      }
      await Promise.all(pending);
    },
  });
}

// Dismissal belongs to a UI cycle, never to the native verification ledger.
export function createVerificationNoticeState() {
  const previous = new Map(), dismissed = new Map();
  return Object.freeze({
    observe(entries) {
      const present = new Set(entries.map(entry => entry.sourceId));
      for (const id of previous.keys()) if (!present.has(id)) { previous.delete(id); dismissed.delete(id); }
      for (const entry of entries) {
        const old = previous.get(entry.sourceId);
        const renewed = old && (old.verificationId !== entry.verificationId || !entry.manual && entry.phase === 'verification-required' && old.phase !== 'verification-required');
        previous.set(entry.sourceId, { ...entry, generation: (old?.generation || 0) + (renewed ? 1 : 0) });
      }
    },
    dismiss(entries) { for (const entry of entries) dismissed.set(entry.sourceId, previous.get(entry.sourceId)?.generation || 0); },
    visible(entries, route) {
      const sourceId = ['details', 'reader'].includes(route?.name) ? route.params?.sid : route?.name === 'explore' && !route.catalog ? route.params?.source : undefined;
      const global = ['search', 'settings', 'downloads'].includes(route?.name) || route?.name === 'explore' && (!route.params?.source || route.catalog);
      if (!sourceId && !global) return [];
      return entries.filter(entry => (!sourceId || entry.sourceId === sourceId) && dismissed.get(entry.sourceId) !== previous.get(entry.sourceId)?.generation);
    },
  });
}

export function mountServiceStatus(adapter, services, reload, { router, toast = () => {} } = {}) {
  const actions = createVerificationActions(adapter, services, nativeImageRetries, reload);
  const notice = document.createElement('section');
  notice.id = 'desktop-source-status'; notice.hidden = true;
  notice.setAttribute('aria-label', 'Source access');
  // Native button/summary keys belong to this notice. Reader shortcuts would
  // otherwise consume Space to advance a page or toggle automatic scrolling.
  notice.addEventListener('keydown', event => event.stopPropagation());
  const view = document.getElementById('view');
  if (view?.parentNode) view.parentNode.insertBefore(notice, view); else document.body.append(notice);
  let refreshing = false, refreshAgain = false, active = true, renderedSignature, entries = [], expanded = false, renderedRoute, failedStatus = false;
  const visibility = createVerificationNoticeState();
  const resumer = createVerificationResumer(actions.resume, () => { if (active) refresh(); });
  const routeContext = () => ({ ...(router?.current() || { name: document.body.dataset.route, params: {} }), catalog: !!document.querySelector('.modal-backdrop.open .ext-row, .modal-backdrop.open .source-row') });
  function dismiss(rows) {
    visibility.dismiss(rows); render();
    const target = view?.querySelector('button, a[href], input') || view;
    if (target && !target.hasAttribute('tabindex') && target === view) target.setAttribute('tabindex', '-1');
    target?.focus();
  }
  function render() {
    if (!active) return;
    const route = routeContext(), visible = visibility.visible(entries, route);
    const routeKey = JSON.stringify({ name: route.name, source: route.params?.sid || route.params?.source, catalog: route.catalog });
    if (routeKey !== renderedRoute) { expanded = false; renderedRoute = routeKey; }
    const signature = JSON.stringify({ routeKey, entries: visible.map(entry => ({ sourceId: entry.sourceId, phase: entry.phase, verificationId: entry.verificationId, manual: entry.manual, cookies: entry.cookies?.state, recovery: resumer.status(entry.sourceId, entry.verificationId)?.state })) });
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    notice.replaceChildren(); notice.hidden = !visible.length;
    const rows = visible.map(entry => {
      const state = resumer.status(entry.sourceId, entry.verificationId);
      const row = document.createElement('div'); row.className = 'desktop-source-row'; row.dataset.sourceId = entry.sourceId;
      const status = document.createElement('p'); status.className = 'desktop-source-message'; status.setAttribute('role', 'status');
      const name = services.snapshot().catalog?.find(source => source.id === entry.sourceId)?.name || entry.sourceId;
      const checking = state?.state === 'checking';
      const message = entry.cookies?.state === 'saving' ? 'Saving your session…' : checking ? 'Checking source access…'
        : entry.phase === 'verification-opened' ? (entry.manual ? 'Website open.' : 'Complete the check in the website window.')
        : entry.phase === 'verification-required' && !entry.manual ? 'Source verification required.' : 'Could not load this source. Try again.';
      status.textContent = `${name}: ${message}`;
      const controls = document.createElement('div'); controls.className = 'desktop-source-actions';
      const action = verificationAction(entry, state);
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-sm'; open.textContent = action.label; open.disabled = action.disabled; open.title = verificationInstructions;
      open.onclick = async () => {
        open.disabled = true;
        try { await actions.open(entry.sourceId); await refresh(); }
        catch { toast('Could not open this source website. Please try again.'); open.disabled = false; }
      };
      if (entry.phase === 'retry-required' && !checking && entry.cookies?.state !== 'saving') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-sm'; retry.textContent = 'Try again';
        retry.onclick = () => { retry.disabled = true; void resumer.retry(entry); };
        controls.append(retry);
      }
      controls.append(open);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-ghost btn-sm desktop-source-dismiss'; close.textContent = '×'; close.setAttribute('aria-label', `Hide ${name} source notice`); close.onclick = () => dismiss([entry]);
      controls.append(close); row.append(status, controls);
      if (!entry.manual && ['verification-required', 'verification-opened'].includes(entry.phase)) {
        const guidance = document.createElement('details'); guidance.className = 'desktop-source-help';
        const summary = document.createElement('summary'); summary.textContent = 'How to verify';
        const instructions = document.createElement('p'); instructions.textContent = verificationInstructions;
        guidance.append(summary, instructions); row.append(guidance);
      }
      const session = document.createElement('p'); session.className = 'desktop-cookie-status'; session.setAttribute('role', 'status'); session.textContent = formatCookieStatus(entry.cookies);
      if (session.textContent && entry.cookies?.state !== 'saving') row.append(session);
      return row;
    });
    if (visible.length === 1) notice.append(rows[0]);
    else {
      const group = document.createElement('details'); group.className = 'desktop-source-list'; group.open = expanded;
      const summary = document.createElement('summary'); summary.textContent = `Source checks (${visible.length})`;
      const list = document.createElement('div'); list.className = 'desktop-source-list-body'; list.append(...rows);
      group.append(summary, list); group.addEventListener('toggle', () => { expanded = group.open; });
      const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-ghost btn-sm desktop-source-dismiss desktop-source-dismiss-all'; close.textContent = '×'; close.setAttribute('aria-label', 'Hide source notices'); close.onclick = () => dismiss(visible);
      notice.append(group, close);
    }
  }
  async function refresh() {
    if (!active) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      entries = await adapter.verificationStatus();
      failedStatus = false;
      // Observe starts recovery but doesn't block rendering Checking or polling.
      void resumer.observe(entries);
      visibility.observe(entries);
      updateSourceVerification(entries, new Map(entries.map(entry => [entry.sourceId, resumer.status(entry.sourceId, entry.verificationId)])));
      render();
    } catch { if (!failedStatus) toast('Could not check source access. Please try again.'); failedStatus = true; }
    finally { refreshing = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }
  for (const name of ['nyora:native-request-failed', 'nyora:native-image-failed']) window.addEventListener(name, refresh);
  window.addEventListener('nyora:verification-error', () => { toast('Could not open this source website. Please try again.'); });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 750);
  const unsubscribe = router?.onChange(render);
  window.addEventListener('pagehide', () => { active = false; clearInterval(timer); unsubscribe?.(); }, { once: true });
  refresh();
}
