'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { OfflineStore } = require('./offline-store.cjs');
const { validateLocalPreferences } = require('./local-reader-preferences.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
test('offline adjustments and concurrent page writes retain both values after restart', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'nyora-local-prefs-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new OfflineStore({ root }).init();
  const book = await store.createBook({ title: 'Local fixture' }, [{ bytes: png }, { bytes: png }]);
  await Promise.all([
    store.updateProgress(book.id, { prefs: { readerMode: 'PAGED_RTL', brightness: -0.25, palette: 'DuotoneBlue', invert: 0.5 } }),
    store.updateProgress(book.id, { page: 1 }),
  ]);
  await store.close();
  const reopened = await new OfflineStore({ root }).init();
  assert.deepEqual(reopened.open(book.id).state, { page: 1, prefs: { readerMode: 'PAGED_RTL', brightness: -0.25, palette: 'DuotoneBlue', invert: 0.5 } });
  const write = reopened.writeState; reopened.writeState = async () => { throw new Error('disk full'); };
  await assert.rejects(reopened.updateProgress(book.id, { prefs: { invert: 1 } }), /disk full/);
  assert.equal(reopened.open(book.id).state.prefs.invert, 0.5);
  reopened.writeState = write;
  await reopened.remove(book.id);
  await assert.rejects(reopened.updateProgress(book.id, { page: 0 }), /not found/);
});
test('offline reader rejects invalid ranges and unexpected preferences', () => {
  for (const prefs of [{ brightness: 3 }, { contrast: -1 }, { invert: true }, { palette: 'Unknown' }, { path: '/private/file' }, { readerMode: 'UNKNOWN' }]) assert.throws(() => validateLocalPreferences(prefs));
  validateLocalPreferences({ saturation: 2, contrast: 0, invert: 1, palette: '', readerFit: 'HEIGHT', prefetch: false });
});

test('vertical paging survives offline reader restart',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'nyora-vertical-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await new OfflineStore({root}).init();const book=await store.createBook({title:'Vertical'},[{bytes:png}]);
  await store.updateProgress(book.id,{prefs:{readerMode:'VERTICAL'}});await store.close();
  const reopened=await new OfflineStore({root}).init();assert.equal(reopened.open(book.id).state.prefs.readerMode,'VERTICAL');await reopened.close();
});
