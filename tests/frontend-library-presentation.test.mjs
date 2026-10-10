import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryResumeModel, createLibraryResume, importLibraryComics } from '../frontend/library-presentation.js';

const history = { mangaId: 'saved', sourceId: 'data:ALPHA', mangaUrl: '/title', mangaTitle: 'Blue Garden', chapterUrl: '/chapter/24?lang=ja', chapterTitle: 'Chapter 24', page: 7, percent: .25 };
const services = row => ({ snapshot: () => ({ history: row ? [row] : [], favourites: [] }) });
const el = (tag, props, ...children) => ({ tag, props, children, appendChild(child) { this.children.push(child); } });
const btn = (label, props) => el('button', props, label);

function resume(row) {
  let current = row;
  const navigations = [];
  const card = createLibraryResume({ services: { snapshot: () => ({ history: [current], favourites: [] }) }, el, btn, icon: () => el('svg'), router: { navigate: (...args) => navigations.push(args) } });
  return { card, navigations, click: () => card.children.at(-1).props.onClick(), change: row => { current = row; } };
}

test('resume displays actual title, chapter and zero-based saved page without inventing a total', () => {
  const model = libraryResumeModel(services(history));
  assert.equal(model.title, 'Blue Garden');
  assert.equal(model.chapter, 'Chapter 24');
  assert.equal(model.position, 'Page 8');
  assert.deepEqual(model.target, { sid: 'data:ALPHA', url: '/title', chapterUrl: '/chapter/24?lang=ja' });
  assert.equal(libraryResumeModel(services({ ...history, total: 31 })).position, 'Page 8 of 31');
  assert.equal(libraryResumeModel(services({ ...history, page: undefined })).position, '');
  assert.equal(libraryResumeModel(services(null)), null);
});
test('resume opens the exact stored chapter in one action and never guesses an unresolved chapter', () => {
  const ready = resume(history);
  ready.click();
  assert.deepEqual(ready.navigations, [['reader', { sid: 'data:ALPHA', url: '/title', chapterUrl: '/chapter/24?lang=ja' }]]);
  const missing = resume({ ...history, chapterUrl: undefined, chapterId: 'opaque-native-fingerprint' });
  assert.equal(missing.card.children.at(-1).children[0], 'View history');
  missing.click();
  assert.deepEqual(missing.navigations, [['history']]);
});
test('a changed resume target opens history instead of a chapter different from the displayed title', () => {
  const f = resume(history);
  f.change({ ...history, chapterUrl: '/chapter/25' });
  f.click();
  assert.deepEqual(f.navigations, [['history']]);
});
test('invalid cover authority leaves a usable text resume card and does not trigger a source request', () => {
  const model = libraryResumeModel(services({ ...history, mangaCoverUrl: 'https://source.example/unissued-cover.jpg' }));
  assert.equal(model.cover, '');
  assert(model.target);
});
test('import uses native file selection, preserves cancellation, and navigates only after a confirmed import', async () => {
  const actions = [], errors = [];
  const router = { navigate: route => actions.push(route) };
  await importLibraryComics({ files: { select: async kind => { assert.equal(kind, 'files'); return { books: [] }; } }, router, toast: message => errors.push(message) });
  assert.deepEqual(actions, []);
  await importLibraryComics({ files: { select: async () => ({ books: [{ id: 'local' }] }) }, router, toast: message => errors.push(message) });
  assert.deepEqual(actions, ['local']);
  await importLibraryComics({ files: { select: async () => { throw new Error('Import failed'); } }, router, toast: message => errors.push(message) });
  assert.deepEqual(errors, ['Import failed']);
});
