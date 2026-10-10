'use strict';
const { readFileSync } = require('node:fs');
const { createHash, timingSafeEqual } = require('node:crypto');
const { sourceKey, publicHttps } = require('./policy.cjs');

// Only build-time trusted catalogue data enters this compiler. Do not compile
// renderer preferences or network responses into descriptors at runtime.
function origin(value) {
  if (typeof value !== 'string' || !value || /[{}$\\\s]/.test(value)) throw new Error('Invalid catalogue host');
  const url = new URL(value.startsWith('https://') ? value : `https://${value}`);
  if (!publicHttps(url.href) || url.hash || url.search || url.hostname.length > 253
    || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Invalid catalogue origin');
  return url.origin;
}
function compileCatalogue(raw) {
  if (!raw || !Array.isArray(raw.sources) || raw.sources.length > 10000) throw new Error('Invalid source catalogue');
  const seen = new Set();
  const sources = raw.sources.map(source => {
    if (!source || typeof source.id !== 'string') throw new Error('Invalid catalogue identity');
    // Match DataDrivenCatalog.source(): definition IDs are ASCII identifiers;
    // the helper emits their Locale.ROOT lowercase form as the canonical ID.
    const sourceId = `data:${source.id.toLowerCase()}`;
    sourceKey(sourceId);
    if (seen.has(sourceId) || typeof source.engine !== 'string' || !/^[a-z0-9]+$/.test(source.engine)) throw new Error('Invalid catalogue identity');
    seen.add(sourceId);
    const config = source.config || {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid source configuration');
    const baseOrigin = origin(source.domain);
    const allowed = new Set([baseOrigin]);
    const add = value => { if (value !== undefined && value !== null && value !== '') allowed.add(origin(value)); };
    if (source.altDomains !== undefined && !Array.isArray(source.altDomains)) throw new Error('Invalid alternate domains');
    for (const domain of source.altDomains || []) add(domain);
    // These fields and defaults mirror the respective bundled engine host grammar.
    // No wildcard suffixes or hosts discovered in HTML/API responses are granted.
    switch (source.engine) {
      // PageImageLoader redirects Atsu static posters/pages to this fixed CDN.
      case 'atsumoe': add('cdn.atsu.moe'); break;
      case 'mangadex': add(config.apiHost || `api.${source.domain}`); add(config.uploadsHost || `uploads.${source.domain}`); break;
      case 'heancms': add(config.apiPath || `api.${source.domain}`); add(config.cdn || `api.${source.domain}`); break;
      case 'signedrest': add(config.apiDomain); break;
      case 'mangabox': add(config.otherDomain); break;
      case 'mangareader':
        if (config.domains !== undefined && !Array.isArray(config.domains)) throw new Error('Invalid engine domains');
        for (const domain of config.domains || []) add(domain);
        // A replacement destination is a literal image prefix, not a host inferred from a response.
        for (const pair of config.pages?.imageUrlReplacements || []) {
          const replacement = Array.isArray(pair) ? pair[1] : undefined;
          if (typeof replacement === 'string' && replacement.startsWith('https://')) add(replacement);
        }
        break;
      case 'mangaplus': add(config.apiUrl || 'https://jumpg-webapi.tokyo-cdn.com/api'); break;
      case 'webtoons': add(config.mobileApiDomain || 'm.webtoons.com'); add(config.staticDomain || 'webtoon-phinf.pstatic.net'); break;
      case 'baozimh': add(`static-tw${source.domain.replace(/^www/, '')}`); break;
      case 'hitomi': {
        const cdn = config.cdnDomain || 'gold-usergeneratedcontent.net';
        for (const prefix of ['ltn', 'a1', 'a2', 'atn', 'btn']) add(`${prefix}.${cdn}`);
        break;
      }
    }
    const allowedOrigins = [...allowed].sort();
    const referer = new Set(allowedOrigins);
    for (const value of [config.referer, config.origin, config.images?.referer]) {
      if (typeof value === 'string' && value.startsWith('https://') && !/[{}$]/.test(value)) referer.add(origin(value));
    }
    return { sourceId, engineKey: source.engine, baseOrigin, allowedOrigins,
      verificationOrigins: [...allowedOrigins], refererOrigins: [...referer].sort(),
      readOnlyPost: { kind: source.engine === 'madara' ? 'madara' : 'none' } };
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId, 'en'));
  return { schemaVersion: 1, sources };
}
function createCatalogueLookup(compiled) {
  if (compiled?.schemaVersion !== 1 || !Array.isArray(compiled.sources) || compiled.sources.length > 10000) throw new Error('Invalid compiled catalogue');
  const descriptors = new Map();
  for (const item of compiled.sources) {
    sourceKey(item?.sourceId);
    if (descriptors.has(item.sourceId) || typeof item.engineKey !== 'string' || !['none', 'madara'].includes(item.readOnlyPost?.kind)
      || (item.readOnlyPost.kind === 'madara' && item.engineKey !== 'madara')) throw new Error('Invalid descriptor identity');
    if (!Array.isArray(item.allowedOrigins) || !item.allowedOrigins.length || item.allowedOrigins.length > 64
      || !Array.isArray(item.verificationOrigins) || !item.verificationOrigins.length) throw new Error('Invalid descriptor origins');
    if (item.refererOrigins !== undefined && (!Array.isArray(item.refererOrigins) || item.refererOrigins.length > 64)) throw new Error('Invalid referer authority');
    for (const value of [...item.allowedOrigins, ...item.verificationOrigins, ...(item.refererOrigins || []), item.baseOrigin]) {
      if (origin(value) !== value) throw new Error('Descriptor origin must be exact');
    }
    if (!item.allowedOrigins.includes(item.baseOrigin) || item.verificationOrigins.some(value => !item.allowedOrigins.includes(value))) throw new Error('Invalid verification authority');
    const descriptor = Object.freeze({ sourceId: item.sourceId, engineKey: item.engineKey, baseOrigin: item.baseOrigin,
      allowedOrigins: Object.freeze([...item.allowedOrigins]), verificationOrigins: Object.freeze([...item.verificationOrigins]),
      refererOrigins: Object.freeze([...(item.refererOrigins || item.allowedOrigins)]),
      readOnlyPost: Object.freeze({ kind: item.readOnlyPost.kind }) });
    descriptors.set(item.sourceId, descriptor);
  }
  return sourceId => { sourceKey(sourceId); return descriptors.get(sourceId); };
}
function loadCatalogue(filePath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('Catalogue digest required');
  const bytes = readFileSync(filePath);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Catalogue too large');
  const actual = createHash('sha256').update(bytes).digest();
  if (!timingSafeEqual(actual, Buffer.from(expectedSha256, 'hex'))) throw new Error('Catalogue digest mismatch');
  return createCatalogueLookup(JSON.parse(bytes.toString('utf8')));
}

function readOnlyPostPolicy({ sourceId, url, headers, body, descriptor }) {
  if (descriptor?.sourceId !== sourceId || descriptor.engineKey !== 'madara' || descriptor.readOnlyPost?.kind !== 'madara'
    || !Buffer.isBuffer(body) || body.length > 1024 * 1024
    || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(headers?.['content-type'] || '')) return false;
  let target;
  try { target = new URL(url); } catch { return false; }
  if (!publicHttps(url) || !descriptor.verificationOrigins.includes(target.origin) || target.search || target.hash) return false;
  if (target.pathname.endsWith('/ajax/chapters/') && body.length === 0) return true;
  if (target.pathname !== '/wp-admin/admin-ajax.php') return false;
  const text = body.toString('utf8');
  if (!Buffer.from(text).equals(body) || /%(?![a-f0-9]{2})/i.test(text)) return false;
  const form = new URLSearchParams(text);
  const entries = [...form];
  if (entries.length > 256 || new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  const action = form.get('action');
  if (action === 'manga_get_chapters') return entries.length === 2 && /^\d{1,20}$/.test(form.get('manga') || '');
  if (action !== 'madara_load_more') return false;
  const fixed = new Set(['action', 'page', 'template', 'vars[s]', 'vars[paged]', 'vars[template]', 'vars[post_type]', 'vars[post_status]',
    'vars[manga_archives_item_layout]', 'vars[meta_key]', 'vars[orderby]', 'vars[order]', 'vars[meta_query][relation]',
    'vars[meta_query][0][relation]', 'vars[tax_query][relation]', 'vars[meta_query][0][query_avarage_reviews][key]',
    'vars[meta_query][0][query_total_reviews][key]', 'vars[orderby][query_avarage_reviews]', 'vars[orderby][query_total_reviews]',
    'vars[meta_query][0][0][key]', 'vars[meta_query][0][0][compare]', 'vars[meta_query][0][0][value][]',
    'vars[meta_query][0][1][key]', 'vars[meta_query][0][1][value]']);
  for (const [key, value] of entries) {
    if (value.length > 4096 || /[\0\r\n]/.test(value)) return false;
    if (!fixed.has(key) && !/^vars\[tax_query\]\[[012]\]\[(taxonomy|field|operator)\]$/.test(key)
      && !/^vars\[tax_query\]\[[012]\]\[terms\]\[\d{0,3}\]$/.test(key)) return false;
  }
  return form.get('template') === 'madara-core/content/content-search' && form.get('vars[post_type]') === 'wp-manga'
    && form.get('vars[post_status]') === 'publish' && /^\d{1,6}$/.test(form.get('page') || '')
    && /^\d{1,6}$/.test(form.get('vars[paged]') || '');
}
module.exports = { compileCatalogue, createCatalogueLookup, loadCatalogue, readOnlyPostPolicy };
