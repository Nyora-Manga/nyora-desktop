'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OfflineStore } = require('./offline-store.cjs');
const { LocalFilesBroker } = require('./local-files.cjs');
const { openArchive } = require('./offline-archive.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-local-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new OfflineStore({ root: path.join(root, 'owned') }); await store.init();
  return { root, store, files: new LocalFilesBroker({ store }) };
}
test('selected folder pages use natural order and survive deleting the selected original', async t => {
  const { root, store, files } = await fixture(t);
  const selected = path.join(root, 'selected'); await fs.mkdir(selected);
  // Add a valid ancillary chunk to distinguish bytes without changing pixels.
  const chunk = Buffer.alloc(17); chunk.writeUInt32BE(5); chunk.write('tEXt', 4); chunk.write('tag\0x', 8);
  chunk.writeUInt32BE(require('node:zlib').crc32(chunk.subarray(4,13)), 13);
  const one = png, ten = Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
  await fs.writeFile(path.join(selected, '10.png'), ten); await fs.writeFile(path.join(selected, '2.png'), one);
  const { books } = await files.importSelected(selected);
  assert.equal(books.length, 1); assert.equal(books[0].pageCount, 2);
  await fs.rm(selected, { recursive: true });
  assert.deepEqual((await files.page(books[0].id, 0)).bytes, one);
  assert.deepEqual((await files.page(books[0].id, 1)).bytes, ten);
  assert.equal(JSON.stringify(files.list()).includes(root), false);
  const reopened = new OfflineStore({ root: store.root }); await reopened.init();
  assert.equal(reopened.list('local').length, 1);
});
test('CBZ export is a CRC-valid archive and reimport preserves pages without exposing paths', async t => {
  const { root, store, files } = await fixture(t);
  const source = await store.createBook({ title: 'Comic' }, [{ bytes: png }]);
  const destination = path.join(root, 'export.cbz'); await files.exportTo(source.id, destination);
  const archive = await openArchive(destination);
  try { assert.equal(archive.entries[0].crc, 0x6b0a6139); assert.deepEqual(await archive.read(archive.entries[0]), png); } finally { await archive.close(); }
  const imported = await files.importSelected(destination);
  assert.equal(imported.books.length, 1); assert.notEqual(imported.books[0].id, source.id);
  assert.deepEqual((await files.page(imported.books[0].id, 0)).bytes, png);
});
test('symlinked selected files and malformed archives never expose external files or publish books', async t => {
  const { root, files, store } = await fixture(t);
  const selected = path.join(root, 'selected'); await fs.mkdir(selected);
  const outside = path.join(root, 'sentinel.png'); await fs.writeFile(outside, png);
  await fs.symlink(outside, path.join(selected, 'page.png'));
  await assert.rejects(files.importSelected(selected));
  await assert.rejects(files.importSelected('relative-path'));
  const bad = path.join(root, 'bad.cbz'); await fs.writeFile(bad, Buffer.from('not a zip'));
  await assert.rejects(files.importSelected(bad));
  assert.equal(store.list().length, 0); assert.deepEqual(await fs.readFile(outside), png);
});
