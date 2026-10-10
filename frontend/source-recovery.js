// A recovered background request must never navigate away from current reading.
export function reloadRecoveredSource(router, sourceId, requests = []) {
  if (globalThis.window) {
    const event = new CustomEvent('nyora:source-content-recovered', { cancelable: true, detail: { sourceId, requests } });
    window.dispatchEvent(event);
    if (event.defaultPrevented) return;
  }
  const route = router.current();
  const params = route.params || {};
  const relevant = requests.some(({ operation, params: request }) => {
    if (operation === 'content.globalSearch') return route.name === 'search' && String(params.q || '').trim() === request.q;
    if (request.id !== sourceId || params.sid !== sourceId && params.source !== sourceId) return false;
    if (route.name === 'explore') return ['content.popular', 'content.latest', 'content.search', 'sources.filters'].includes(operation);
    if (route.name === 'details') return operation === 'content.details' && params.url === request.url;
    if (route.name === 'reader') return operation === 'content.pages' && params.chapterUrl === request.url;
    return false;
  });
  if (relevant) router.navigate(route.name, route.params);
}
