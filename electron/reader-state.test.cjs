'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ReaderState } = require('./reader-state.cjs');
test('chapter overrides and complete title preferences survive restart and retain each other', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-reader-state-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ReaderState(directory);
  await Promise.all([store.saveMarks('123', { read: ['/chapter1'], unread: ['/chapter2'] }), store.savePreferences('123', { readerFit: 'HEIGHT', invert: 0.5, webtoonWidth: 72 })]);
  const restarted = new ReaderState(directory);
  const actual = await restarted.get('123');
  assert.deepEqual(actual.marks, { read: ['/chapter1'], unread: ['/chapter2'] }); assert.equal(actual.preferences.invert, 0.5);
  await restarted.clearPreferences('123'); assert.deepEqual((await restarted.get('123')).marks, actual.marks);
  assert.throws(() => restarted.saveMarks('123', { read: ['a'], unread: ['a'] }), /Conflicting/);
  assert.throws(() => restarted.savePreferences('123', { webtoonWidth: -1 }), /width/);
});
test('failed reader publish preserves the last acknowledged chapter marks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-reader-state-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await new ReaderState(directory).saveMarks('title', { read: ['a'], unread: [] });
  const store = new ReaderState(directory, { publish: async () => { throw new Error('disk full'); } });
  await assert.rejects(store.saveMarks('title', { read: ['b'], unread: [] }), /disk full/);
  assert.deepEqual((await store.get('title')).marks.read, ['a']);
});
