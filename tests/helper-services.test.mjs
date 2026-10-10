import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopServices } from '../electron/services.cjs';

function service() {
  const requests = [];
  const helper = { start: async () => {}, request: async (path, options) => {
    requests.push({ path, options });
    return { bytes: Buffer.from('{"entries":[]}'), contentType: 'application/json' };
  } };
  const contract = { schemaVersion: 1, operations: {
    'content.details': { method: 'GET', path: '/manga/details', params: ['id', 'url'] },
    'library.favouriteToggle': { method: 'POST', path: '/library/favourites/toggle', params: ['mangaId'] },
    'sources.setInstalled': { method: 'POST', path: '/sources/setInstalled', params: [], bodyParam: 'ids' },
  } };
  return { requests, instance: new DesktopServices({ helper, contract, appOrigin: 'http://127.0.0.1:43210' }) };
}

test('fixed operations encode opaque IDs without exposing a raw path API', async () => {
  const { requests, instance } = service();
  await instance.request({ operation: 'library.favouriteToggle', params: { mangaId: 'opaque&id=not-another-param' } });
  assert.equal(requests[0].path, '/library/favourites/toggle?mangaId=opaque%26id%3Dnot-another-param');
  assert.equal(requests[0].options.method, 'POST');
  await assert.rejects(instance.request({ operation: '/backup/import', params: {} }), /Unknown/);
  await assert.rejects(instance.request({ operation: '__proto__', params: {} }), /Unknown/);
  await assert.rejects(instance.request({ operation: 'content.details', params: { id: 'data:fixture', url: 'https://example.org', arbitraryPath: '/backup/import' } }), /Unexpected/);
});

test('installed sources use the helper raw-array contract', async () => {
  const { requests, instance } = service();
  await instance.request({ operation: 'sources.setInstalled', params: { ids: ['data:fixture'] } });
  assert.deepEqual(requests[0].options.json, ['data:fixture']);
  await assert.rejects(instance.request({ operation: 'sources.setInstalled', params: { ids: ['parser:retired'] } }));
  assert.equal(requests.length, 1);
});

test('relative and opaque parser content keys reach the helper unchanged', async () => {
  const { requests, instance } = service();
  for (const url of ['/manga/fixture-series', 'chapter-key-123', '/chapter/1?lang=en&group=2']) {
    await instance.request({ operation: 'content.details', params: { id: 'data:atsumoe', url } });
    const route = new URL(requests.at(-1).path, 'http://127.0.0.1');
    assert.equal(route.searchParams.get('url'), url);
    assert.equal(route.searchParams.get('id'), 'data:atsumoe');
  }
});

test('main-owned verification recovery requests fresh parsed content without changing renderer authority', async () => {
  const { requests, instance } = service();
  const value = { operation: 'content.details', params: { id: 'data:fixture', url: '/manga/original?lang=en' } };
  await instance.request(value, { fresh: true });
  const route = new URL(requests[0].path, 'http://127.0.0.1');
  assert.equal(route.searchParams.get('refresh'), '1');
  assert.equal(route.searchParams.get('url'), '/manga/original?lang=en');
  assert.deepEqual(value.params, { id: 'data:fixture', url: '/manga/original?lang=en' });
  await assert.rejects(instance.request({ ...value, params: { ...value.params, refresh: 1 } }), /Unexpected/);
  await instance.request({ operation: 'library.favouriteToggle', params: { mangaId: 'exact' } }, { fresh: true });
  assert(!requests[1].path.includes('refresh'));
});

test('native source IDs and remote URLs are validated before helper calls', async () => {
  const { requests, instance } = service();
  for (const params of [{ id: 'parser:retired', url: 'https://example.org' }, { id: 'data:fixture', url: 'https://127.0.0.1/' }]) {
    await assert.rejects(instance.request({ operation: 'content.details', params }));
  }
  assert.equal(requests.length, 0);
});

test('image bridge rejects credentials, private URLs and arbitrary forwarded headers', async () => {
  const { requests, instance } = service();
  for (const suffix of ['u=https%3A%2F%2F127.0.0.1%2F', 'u=https%3A%2F%2Fexample.org%2Fa.jpg&h=Authorization%3ABearer%20x', 'u=https%3A%2F%2Fexample.org%2Fa.jpg&path=%2Fbackup%2Fexport']) {
    await assert.rejects(instance.image(`http://127.0.0.1:43210/helper-image?sourceId=data%3Afixture&${suffix}`));
  }
  assert.equal(requests.length, 0);
});
