'use strict';
const { sourceKey, publicHttps } = require('./policy.cjs');

function identity(value) {
  try { sourceKey(value); return value; } catch { return undefined; }
}

// Only authenticated, parsed helper responses enter here. A renderer cannot
// enrol a URL. Media authority is the exact URL plus its canonical source ID.
async function normalizeNativeMedia(result, { sourceId, pages = false, authorizeMedia, makeImageUrl, sourceOrigin = () => undefined }) {
  const grants = new Map();
  const unavailable = new Map();
  function image(value, inherited, pageHeaders, clear) {
    if (typeof value !== 'string' || !value) return value;
    let target = value.trim();
    let source = inherited;
    const headers = [];
    if (pageHeaders && typeof pageHeaders === 'object' && !Array.isArray(pageHeaders)) {
      for (const [name, content] of Object.entries(pageHeaders)) {
        if (name.toLowerCase() === 'referer' && typeof content === 'string') headers.push(`Referer:${content}`);
      }
    }
    // Old helper proxies carry an ephemeral port; only their remote target is
    // retained. Resolve relative CDN paths against the authoritative source,
    // never the UI server or an unrelated renderer-provided base URL.
    for (let depth = 0; depth < 3; depth++) {
      try {
        const parsed = new URL(target, 'http://127.0.0.1');
        const wrapper = (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && ['/image', '/helper-image'].includes(parsed.pathname))
          || (parsed.protocol === 'nyora:' && parsed.hostname === 'app' && parsed.pathname === '/helper-image');
        if (!wrapper || !parsed.searchParams.has('u')) break;
        if (parsed.searchParams.getAll('u').length !== 1 || parsed.searchParams.getAll('sourceId').length > 1) return '';
        const bound = identity(parsed.searchParams.get('sourceId'));
        if (source && bound && source !== bound) return '';
        source ||= bound;
        target = parsed.searchParams.get('u');
        headers.push(...parsed.searchParams.getAll('h'));
      } catch { return ''; }
    }
    try {
      const base = source && sourceOrigin(source);
      const parsed = new URL(target.startsWith('//') ? `https:${target}` : target, base ? `${base}/` : undefined);
      parsed.hash = ''; target = parsed.href;
    } catch { return ''; }
    if (!source || !publicHttps(target) || target.length > 8192 || typeof makeImageUrl !== 'function') return '';
    if (!grants.has(source)) grants.set(source, new Set());
    if (!unavailable.has(source)) unavailable.set(source, []);
    grants.get(source).add(new URL(target).href);
    if (clear) unavailable.get(source).push(clear);
    const query = new URLSearchParams({ u: target, sourceId: source });
    for (const header of headers.slice(0, 4)) {
      const match = /^Referer:(.+)$/i.exec(header);
      if (match && publicHttps(match[1]) && header.length <= 8192) query.append('h', header);
    }
    return makeImageUrl(query);
  }
  function walk(value, inherited, depth = 0, pageList = false) {
    if (depth > 15 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (pageList && typeof value[index] === 'string') value[index] = image(value[index], inherited, undefined, () => { value[index] = ''; });
        else walk(value[index], inherited, depth + 1, pageList);
      }
      return;
    }
    const source = identity(value.sourceId) || identity(value.source?.id) || identity(value.source?.name) || identity(value.source) || inherited;
    for (const field of ['coverUrl', 'largeCoverUrl', 'mangaCoverUrl']) {
      if (Object.hasOwn(value, field)) value[field] = image(value[field], source, undefined, () => { value[field] = ''; });
    }
    if (pageList && Object.hasOwn(value, 'url')) {
      value.url = image(value.url, source, value.headers, () => { value.url = ''; });
      delete value.headers;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') walk(child, source, depth + 1, pages && key === 'pages');
    }
  }
  walk(result, identity(sourceId));
  await Promise.all([...grants].map(async ([source, urls]) => {
    try { await authorizeMedia(source, [...urls]); }
    catch {
      // Optional remote media must not make retained library/history records
      // inaccessible after an unresolved-source restore or a bounded grant failure.
      for (const clear of unavailable.get(source) || []) clear();
    }
  }));
  return result;
}
module.exports = { normalizeNativeMedia };
