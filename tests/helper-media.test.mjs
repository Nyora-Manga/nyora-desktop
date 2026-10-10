import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeMedia as normalize } from '../electron/media.cjs';
const normalizeNativeMedia = (data, options) => normalize(data, { makeImageUrl: query => `http://127.0.0.1:43210/helper-image?${query}&cap=fixture`, sourceOrigin: () => 'https://source.org', ...options });

test('parsed dynamic CDN images grant exact URLs and hide helper readiness port', async () => {
  const grants = [];
  const dto = { manga: { sourceId: 'data:UPPER', url: 'https://source.org/title', coverUrl: 'http://127.0.0.1:12345/image?u=https%3A%2F%2Fcdn.org%2Fcover.jpg&sourceId=data%3AUPPER&h=Referer%3Ahttps%3A%2F%2Fsource.org%2F' } };
  await normalizeNativeMedia(dto, { authorizeMedia: (...args) => grants.push(args) });
  assert.equal(dto.manga.url, 'https://source.org/title');
  assert.match(dto.manga.coverUrl, /^http:\/\/127\.0\.0\.1:43210\/helper-image\?/);
  assert.ok(!JSON.stringify(dto).includes('12345'));
  assert.deepEqual(grants, [['data:UPPER', ['https://cdn.org/cover.jpg']]]);
});

test('unresolved sources and grant limits suppress optional images without losing retained records', async () => {
  const dto = { entries: [
    { id: 'known', source: { name: 'data:known' }, coverUrl: 'https://known.org/cover' },
    { id: 'unresolved', source: { name: 'data:missing' }, coverUrl: 'https://old.org/cover' },
    { id: 'bounded', sourceId: 'data:full', coverUrl: 'https://cdn.org/cover', largeCoverUrl: 'https://cdn.org/large' },
  ] };
  await normalizeNativeMedia(dto, { authorizeMedia: async source => {
    if (source !== 'data:known') throw Object.assign(new Error('Unavailable'), { code: source === 'data:full' ? 'MEDIA_GRANT_LIMIT' : 'UNKNOWN_SOURCE' });
  } });
  assert.deepEqual(dto.entries.map(row => row.id), ['known', 'unresolved', 'bounded']);
  assert.match(dto.entries[0].coverUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(dto.entries[1].coverUrl, '');
  assert.equal(dto.entries[2].coverUrl, '');
  assert.equal(dto.entries[2].largeCoverUrl, '');
});

test('reader media preserves the engine Referer and removes arbitrary page headers before IPC', async () => {
  const dto = { pages: [{ url: 'https://dynamic.org/page.jpg', headers: { Referer: 'https://source.org/chapter', Authorization: 'secret', Cookie: 'private=1' } }] };
  await normalizeNativeMedia(dto, { sourceId: 'data:reader', pages: true, authorizeMedia: async () => {} });
  const image = new URL(dto.pages[0].url);
  assert.deepEqual(image.searchParams.getAll('h'), ['Referer:https://source.org/chapter']);
  assert.equal(dto.pages[0].headers, undefined);
  assert.ok(!JSON.stringify(dto).includes('secret'));
  assert.ok(!JSON.stringify(dto).includes('private'));
});

test('Kotlin Script references and library cover DTO fields retain exact source authority', async () => {
  const grants = [];
  const dto = { entries: [
    { source: { type: 'Script', name: 'data:ATSUMOE' }, coverUrl: 'https://cdn.org/small', largeCoverUrl: 'https://cdn.org/large' },
    { sourceId: 'data:bookmark', mangaCoverUrl: 'https://cdn.org/bookmark' },
  ] };
  await normalizeNativeMedia(dto, { authorizeMedia: (...args) => grants.push(args) });
  assert.match(dto.entries[0].coverUrl, /sourceId=data%3AATSUMOE/);
  assert.match(dto.entries[0].largeCoverUrl, /sourceId=data%3AATSUMOE/);
  assert.match(dto.entries[1].mangaCoverUrl, /sourceId=data%3Abookmark/);
  assert.deepEqual(grants, [['data:ATSUMOE', ['https://cdn.org/small', 'https://cdn.org/large']], ['data:bookmark', ['https://cdn.org/bookmark']]]);
});

test('reader images inherit the exact source while unbound and private media get no authority', async () => {
  const grants = [];
  const dto = { pages: [{ url: 'https://dynamic.org/page.jpg' }, { url: 'https://127.0.0.1/private' }] };
  await normalizeNativeMedia(dto, { sourceId: 'data:reader', pages: true, authorizeMedia: (...args) => grants.push(args) });
  assert.match(dto.pages[0].url, /sourceId=data%3Areader/);
  assert.equal(dto.pages[1].url, '');
  const unbound = { coverUrl: 'https://cdn.org/a.jpg' };
  await normalizeNativeMedia(unbound, { authorizeMedia: (...args) => grants.push(args) });
  assert.equal(unbound.coverUrl, '');
  assert.deepEqual(grants, [['data:reader', ['https://dynamic.org/page.jpg']]]);
});

test('relative and protocol-relative covers/pages bind to the source origin, never the UI server', async () => {
  const grants = [];
  const dto = { coverUrl: '/covers/fixture a.png', pages: ['//cdn.org/page.png', { url: '/pages/1.png' }] };
  await normalizeNativeMedia(dto, { sourceId: 'data:fixture', pages: true, authorizeMedia: (...args) => grants.push(args) });
  assert.equal(new URL(dto.coverUrl).searchParams.get('u'), 'https://source.org/covers/fixture%20a.png');
  assert.equal(new URL(dto.pages[0]).searchParams.get('u'), 'https://cdn.org/page.png');
  assert.equal(new URL(dto.pages[1].url).searchParams.get('u'), 'https://source.org/pages/1.png');
  assert.deepEqual(grants, [['data:fixture', ['https://source.org/covers/fixture%20a.png', 'https://cdn.org/page.png', 'https://source.org/pages/1.png']]]);
});

test('legacy helper proxies are reissued for the current server and cannot switch source identity', async () => {
  const dto = { sourceId: 'data:fixture', coverUrl: 'http://localhost:8788/image?u=%2Fcover.png&sourceId=data%3Afixture',
    largeCoverUrl: 'http://127.0.0.1:11111/helper-image?u=https%3A%2F%2Fcdn.org%2Flarge.png&sourceId=data%3Afixture&cap=stale' };
  await normalizeNativeMedia(dto, { authorizeMedia: async () => {} });
  assert.equal(new URL(dto.coverUrl).searchParams.get('u'), 'https://source.org/cover.png');
  assert.equal(new URL(dto.largeCoverUrl).origin, 'http://127.0.0.1:43210');
  assert.equal(new URL(dto.largeCoverUrl).searchParams.get('cap'), 'fixture');
  const confused = { sourceId: 'data:fixture', coverUrl: 'http://127.0.0.1:8788/image?u=https%3A%2F%2Fcdn.org%2Fcover.png&sourceId=data%3Aother' };
  await normalizeNativeMedia(confused, { authorizeMedia: () => assert.fail('Conflicting source metadata must receive no grant') });
  assert.equal(confused.coverUrl, '');
});
