'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OfflineStore } = require('./offline-store.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-offline-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new OfflineStore({ root: path.join(root, 'offline'), ...options });
  await store.init();
  return { store, root };
}
test('books retain opaque identities, bytes and reader position after reopening', async t => {
  const { store, root } = await fixture(t);
  const book = await store.createBook({ title: 'Same title', chapterTitle: 'Chapter' }, [{ bytes: png, contentType: 'image/png' }]);
  const another = await store.createBook({ title: 'Same title', chapterTitle: 'Chapter' }, [{ bytes: png }]);
  assert.notEqual(book.id, another.id);
  assert.equal(JSON.stringify(book).includes(root), false);
  await store.updateProgress(book.id, { page: 0 });
  const reopened = new OfflineStore({ root: path.join(root, 'offline') });
  await reopened.init();
  assert.equal(reopened.list().length, 2);
  assert.deepEqual((await reopened.page(book.id, 0)).bytes, png);
  assert.equal(reopened.open(book.id).state.page, 0);
  assert.throws(() => reopened.open('../outside'));
  await assert.rejects(reopened.page(book.id, 1));
});
test('partial, non-image, oversized or cancelled imports never publish a readable book', async t => {
  const { store } = await fixture(t, { maxPageBytes: 100 });
  await assert.rejects(store.createBook({ title: 'HTML' }, [{ bytes: Buffer.from('<html>challenge</html>') }]));
  await assert.rejects(store.createBook({ title: 'Large' }, [{ bytes: Buffer.alloc(101) }]));
  async function* broken() { yield { bytes: png }; throw new Error('Page missing'); }
  await assert.rejects(store.createBook({ title: 'Partial' }, broken()));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.createBook({ title: 'Cancelled' }, [{ bytes: png }], { signal: abort.signal }));
  assert.equal(store.list().length, 0);
});
test('symlinks cannot redirect offline reads or deletion outside the owned store', async t => {
  const { store, root } = await fixture(t);
  const book = await store.createBook({ title: 'Bounded' }, [{ bytes: png }]);
  const outside = path.join(root, 'sentinel'); await fs.writeFile(outside, 'keep');
  const file = path.join(root, 'offline', 'books', book.id, 'pages', '0001.png');
  await fs.unlink(file); await fs.symlink(outside, file);
  await assert.rejects(store.page(book.id, 0));
  await store.remove(book.id);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});
test('one damaged book is retained for recovery without disabling other offline books', async t => {
  const { store, root } = await fixture(t);
  const good = await store.createBook({ title: 'Good' }, [{ bytes: png }]);
  const bad = await store.createBook({ title: 'Bad' }, [{ bytes: png }]);
  const meta = path.join(root, 'offline', 'books', bad.id, 'book.json'); await fs.writeFile(meta, '{broken');
  const reopened = new OfflineStore({ root: store.root }); await reopened.init();
  assert.deepEqual(reopened.list().map(book => book.id), [good.id]);
  assert.equal(reopened.status().issues[0].id, bad.id);
  assert.equal(await fs.readFile(meta, 'utf8'), '{broken', 'Do not destroy recoverable damaged metadata');
});
test('oversized image dimensions are rejected before entering the native decoder', async t => {
  let decoded = 0;
  const { store } = await fixture(t, { validateImage: () => { decoded++; } });
  const gif = Buffer.alloc(16); gif.write('GIF89a'); gif.writeUInt16LE(65535, 6); gif.writeUInt16LE(65535, 8); gif[15] = 59;
  await assert.rejects(store.createBook({ title: 'Huge' }, [{ bytes: gif }]), /dimension/);
  assert.equal(decoded, 0); assert.equal(store.list().length, 0);
});
test('missing, truncated or replaced stored pages are retained as damaged books after restart', async t => {
  const { store, root } = await fixture(t);
  const good = await store.createBook({ title: 'Good' }, [{ bytes: png }]);
  const damaged = [];
  for (const mutation of ['missing', 'truncated', 'directory', 'symlink']) {
    const book = await store.createBook({ title: mutation }, [{ bytes: png }]); damaged.push(book.id);
    const page = path.join(store.root, 'books', book.id, 'pages', '0001.png');
    await fs.unlink(page);
    if (mutation === 'truncated') await fs.writeFile(page, png.subarray(0, 16));
    if (mutation === 'directory') await fs.mkdir(page);
    if (mutation === 'symlink') await fs.symlink(path.join(root, 'sentinel'), page);
  }
  await fs.writeFile(path.join(root, 'sentinel'), png);
  const reopened = new OfflineStore({ root: store.root }); await reopened.init();
  assert.deepEqual(reopened.list().map(book => book.id), [good.id]);
  assert.deepEqual(reopened.status().issues.map(issue => issue.id).sort(), damaged.sort());
  for (const id of damaged) assert.equal((await fs.stat(path.join(store.root, 'books', id, 'book.json'))).isFile(), true);
});
