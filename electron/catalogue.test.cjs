'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { compileCatalogue, createCatalogueLookup, loadCatalogue, readOnlyPostPolicy } = require('./catalogue.cjs');
const source = (id, engine = 'madara', config = {}) => ({ id, engine, domain: 'example.org', config });
const lookup = (...sources) => createCatalogueLookup(compileCatalogue({ sources }));

test('catalogue grants only canonical exact trusted identities and immutable descriptors', () => {
  const get = lookup(source('fixture'));
  const item = get('data:fixture');
  assert.deepEqual(item.allowedOrigins, ['https://example.org']);
  assert.equal(get('data:unknown'), undefined);
  assert.equal(get('data:FIXTURE'), undefined);
  assert.throws(() => get('../fixture'));
  assert.throws(() => item.allowedOrigins.push('https://evil.org'));
  assert.throws(() => compileCatalogue({ sources: [source('fixture'), source('fixture')] }));
  assert.throws(() => compileCatalogue({ sources: [source('fixture'), source('FIXTURE')] }));
  assert.equal(lookup(source('UPPERCASE'))('data:uppercase').sourceId, 'data:uppercase');
  assert.equal(lookup(source('UPPERCASE'))('data:UPPERCASE'), undefined);
  assert.throws(() => compileCatalogue({ sources: [{ engine: 'madara', domain: 'example.org' }] }));
});

test('known engine API and finite image hosts are scoped to that source', () => {
  const get = lookup(source('dex', 'mangadex'), source('web', 'webtoons'), source('plus', 'mangaplus'),
    source('hean', 'heancms', { apiPath: 'api.other.org/v1', cdn: 'images.other.org/file/' }),
    source('hitomi', 'hitomi', { cdnDomain: 'images.other.org' }), source('box', 'mangabox', { otherDomain: 'chapters.other.org' }));
  assert.ok(get('data:dex').allowedOrigins.includes('https://uploads.example.org'));
  assert.ok(get('data:web').allowedOrigins.includes('https://webtoon-phinf.pstatic.net'));
  assert.ok(get('data:plus').allowedOrigins.includes('https://jumpg-webapi.tokyo-cdn.com'));
  assert.deepEqual(get('data:hean').allowedOrigins, ['https://api.other.org', 'https://example.org', 'https://images.other.org']);
  assert.ok(get('data:hitomi').allowedOrigins.includes('https://a2.images.other.org'));
  assert.ok(!get('data:hitomi').allowedOrigins.includes('https://a3.images.other.org'));
  assert.ok(!get('data:box').allowedOrigins.includes('https://api.example.org'));
});

test('Atsu helper CDN rewrite grants only the engine-owned exact origin to that source', () => {
  const get = lookup(
    { ...source('atsu', 'atsumoe'), domain: 'atsu.moe' },
    { ...source('other'), domain: 'atsu.moe' },
  );
  const atsu = get('data:atsu');
  assert.deepEqual(atsu.allowedOrigins, ['https://atsu.moe', 'https://cdn.atsu.moe']);
  assert.ok(atsu.refererOrigins.includes('https://atsu.moe'));
  assert.deepEqual(get('data:other').allowedOrigins, ['https://atsu.moe']);
  assert.ok(!atsu.allowedOrigins.includes('https://images.atsu.moe'));
  assert.ok(!atsu.allowedOrigins.includes('https://cdn.atsu.moe.evil.org'));
  assert.equal(atsu.readOnlyPost.kind, 'none');
});

test('only named engine configuration fields grant fetch origins; referers do not grant fetch', () => {
  const item = lookup(source('fixture', 'signedrest', { apiDomain: 'api.other.org', origin: 'https://referer.other.org',
    referer: 'https://referer.other.org/', maliciousUrl: 'https://evil.other.org/', allowedOrigins: ['https://evil.other.org'] }))('data:fixture');
  assert.ok(item.refererOrigins.includes('https://referer.other.org'));
  assert.ok(!item.allowedOrigins.includes('https://referer.other.org'));
  assert.ok(!item.allowedOrigins.includes('https://evil.other.org'));
  const replaced = lookup(source('images', 'mangareader', { pages: { imageUrlReplacements: [['http://images.other.org/', 'https://images.other.org/']] } }))('data:images');
  assert.ok(replaced.allowedOrigins.includes('https://images.other.org'));
});

test('untrusted/private catalogue origins and expanded descriptor authority fail closed', () => {
  for (const domain of ['127.0.0.1', 'localhost', 'service.local', 'https://user:pass@example.org', 'https://example.org:8443', '*.example.org', 'https://{domain}']) {
    assert.throws(() => compileCatalogue({ sources: [{ ...source('fixture'), domain }] }), domain);
  }
  const compiled = compileCatalogue({ sources: [source('fixture')] });
  compiled.sources[0].verificationOrigins.push('https://evil.org');
  assert.throws(() => createCatalogueLookup(compiled));
});

test('bundled catalogue loader verifies exact file bytes before admitting sources', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nyora-catalogue-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'catalogue.json');
  const bytes = JSON.stringify(compileCatalogue({ sources: [source('fixture')] }));
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(file, bytes);
  assert.equal(loadCatalogue(file, sha)('data:fixture').sourceId, 'data:fixture');
  assert.throws(() => loadCatalogue(file));
  writeFileSync(file, `${bytes}\n`);
  assert.throws(() => loadCatalogue(file, sha), /digest mismatch/);
});

const descriptor = lookup(source('fixture'))('data:fixture');
const post = (body, extras = {}) => readOnlyPostPolicy({ sourceId: 'data:fixture', descriptor,
  url: 'https://example.org/wp-admin/admin-ajax.php', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: Buffer.from(body), ...extras });
const browse = new URLSearchParams({ action: 'madara_load_more', page: '0', template: 'madara-core/content/content-search',
  'vars[paged]': '1', 'vars[post_type]': 'wp-manga', 'vars[post_status]': 'publish', 'vars[s]': 'query',
  'vars[tax_query][0][terms][0]': 'adventure' }).toString();

test('read-only Madara browse/chapter requests accept only known paths and form actions', () => {
  assert.equal(post(browse), true);
  assert.equal(post('action=manga_get_chapters&manga=123'), true);
  assert.equal(post('', { url: 'https://example.org/manga/title/ajax/chapters/' }), true);
  for (const body of ['action=manga_views&manga=123', 'action=login&password=secret', 'action=manga_get_chapters&manga=123&nonce=secret',
    'action=manga_get_chapters&action=delete&manga=123', 'action=manga_get_chapters&manga=abc', `${browse}&password=secret`, `${browse}&unknown=1`, `${browse}&bad=%zz`]) {
    assert.equal(post(body), false, body);
  }
  assert.equal(post(browse, { url: 'https://other.org/wp-admin/admin-ajax.php' }), false);
  assert.equal(post(browse, { url: 'https://example.org/account/login' }), false);
  assert.equal(post(browse, { headers: { 'content-type': 'application/json' } }), false);
  assert.equal(post(browse, { sourceId: 'data:other' }), false);
  assert.equal(post(browse, { descriptor: lookup(source('fixture', 'batoto'))('data:fixture') }), false);
  assert.equal(post('', { body: Buffer.alloc(1024 * 1024 + 1) }), false);
});

test('actual bundled catalogue compiles all source identities without broad origin inference', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, '../../nyora-shared-datadriven/data/catalogue.json')));
  const compiled = compileCatalogue(raw);
  assert.equal(compiled.sources.length, raw.sources.length);
  assert.deepEqual(new Set(compiled.sources.map(item => item.sourceId)), new Set(raw.sources.map(item => `data:${item.id.toLowerCase()}`)),
    'Compiled source keys must match the helper DataDrivenCatalog.source() identity grammar for every definition');
  const get = createCatalogueLookup(compiled);
  assert.ok(get('data:mangadex').allowedOrigins.includes('https://api.mangadex.org'));
  assert.ok(get('data:atsumoe').allowedOrigins.includes('https://cdn.atsu.moe'));
  assert.ok(!get('data:mangadex').allowedOrigins.includes('https://cdn.atsu.moe'));
  assert.ok(get('data:reapercomics').allowedOrigins.includes('https://media.reaperscans.com'));
  assert.ok(get('data:shinigami').allowedOrigins.includes('https://api.shngm.io'));
  assert.equal(post('action=manga_views&manga=123', { sourceId: 'data:hentaicube', descriptor: get('data:hentaicube'),
    url: `${get('data:hentaicube').baseOrigin}/wp-admin/admin-ajax.php` }), false);
});
