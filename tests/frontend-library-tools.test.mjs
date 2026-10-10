import test from 'node:test';
import assert from 'node:assert/strict';

let tools;
try { tools = await import('../frontend/library-tools.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const required = () => { assert(tools, 'Desktop library presentation tools are missing'); return tools; };
const entries = [
  { id: 'one', title: 'Blue Garden', url: '/blue', source: { name: 'data:ALPHA' }, altTitles: ['Azure Garden'] },
  { id: 'two', title: 'Blue Garden', url: '/blue', source: { name: 'data:beta' } },
  { id: 'three', title: 'Amber Road', url: '/amber', source: { name: 'data:ALPHA' } },
  { id: 'four', title: 'Cedar House', url: '/cedar', source: { name: 'data:beta' } },
];
const history = [
  { mangaId: 'one', sourceId: 'data:ALPHA', mangaUrl: '/blue', updatedAt: 10, percent: 1 },
  { mangaId: 'three', sourceId: 'data:ALPHA', mangaUrl: '/amber', updatedAt: 50, percent: 0.1 },
  { mangaId: 'one', sourceId: 'data:ALPHA', mangaUrl: '/blue', updatedAt: 30, percent: 0 },
];
const ids = rows => rows.map(row => row.id);

test('library text, source, and history filters combine without changing saved entries', () => {
  const { selectLibraryEntries } = required();
  const before = structuredClone(entries);
  assert.deepEqual(ids(selectLibraryEntries(entries, { query: '  BLUE ', source: 'data:ALPHA', reading: 'with-history' }, history)), ['one']);
  assert.deepEqual(ids(selectLibraryEntries(entries, { query: 'azure', reading: 'with-history' }, history)), ['one']);
  assert.deepEqual(entries, before);
});
test('matching title and URL on another source does not inherit history or normalize source case', () => {
  const { selectLibraryEntries } = required();
  assert.deepEqual(ids(selectLibraryEntries(entries, { query: 'blue', reading: 'no-history' }, history)), ['two']);
  assert.deepEqual(ids(selectLibraryEntries(entries, { source: 'data:alpha' }, history)), []);
  assert.deepEqual(ids(selectLibraryEntries(entries, { reading: 'with-history' }, [{ sourceId: 'data:ALPHA', mangaUrl: '/different', mangaTitle: 'Blue Garden', updatedAt: 80 }])), []);
});
test('filtering within a category never adds matching titles from outside that category', () => {
  const { selectLibraryEntries } = required();
  assert.deepEqual(ids(selectLibraryEntries([entries[1], entries[3]], { query: 'blue' }, history)), ['two']);
  assert.deepEqual(ids(selectLibraryEntries([entries[1], entries[3]], { reading: 'with-history' }, history)), []);
});
test('recently-read sorting uses newest exact history timestamp rather than chapter completion', () => {
  const { selectLibraryEntries } = required();
  assert.deepEqual(ids(selectLibraryEntries(entries, { sort: 'read' }, history)), ['three', 'one', 'two', 'four']);
  assert.deepEqual(ids(selectLibraryEntries(entries, { reading: 'with-history' }, history)), ['one', 'three']);
  assert.deepEqual(ids(selectLibraryEntries(entries, { reading: 'no-history' }, [])), ['one', 'two', 'three', 'four']);
});
test('recent ordering and equal-title tie order retain the native collection order', () => {
  const { selectLibraryEntries } = required();
  assert.deepEqual(ids(selectLibraryEntries(entries, { sort: 'recent' }, history)), ['one', 'two', 'three', 'four']);
  assert.deepEqual(ids(selectLibraryEntries(entries, { sort: 'title' }, history)), ['three', 'one', 'two', 'four']);
});
test('source options use exact saved source identities and do not include unrelated installed sources', () => {
  const { librarySourceOptions } = required();
  assert.deepEqual(librarySourceOptions(entries, [
    { id: 'data:ALPHA', name: 'Alpha' }, { id: 'data:beta', name: 'Beta' }, { id: 'data:other', name: 'Other' },
  ]), [{ value: 'data:ALPHA', label: 'Alpha' }, { value: 'data:beta', label: 'Beta' }]);
});
test('no-results reset clears only presentation filters and preserves category and chosen sort', () => {
  const { selectLibraryEntries, resetLibraryFilters, hasLibraryFilters } = required();
  const state = { query: 'missing', source: 'data:ALPHA', reading: 'no-history', activeCategoryId: 8, sort: 'read' };
  assert.deepEqual(selectLibraryEntries([entries[1], entries[3]], state, history), []);
  assert(hasLibraryFilters(state));
  const cleared = resetLibraryFilters(state);
  assert.equal(cleared.activeCategoryId, 8); assert.equal(cleared.sort, 'read');
  assert.equal(hasLibraryFilters(cleared), false);
  assert.deepEqual(ids(selectLibraryEntries([entries[1], entries[3]], cleared, history)), ['two', 'four']);
  assert.equal(state.query, 'missing');
});

test('Android-style library sorting and quick filters use saved chapter state and exact download identity', () => {
  const {selectLibraryEntries} = required();
  const books = [
    {...entries[0], rating:0.5, libraryAddedAt:10, chapters:[{id:'c1',url:'/1',number:1,uploadDate:20},{id:'c2',url:'/2',number:2,uploadDate:40}]},
    {...entries[1], rating:0.9, libraryAddedAt:30, chapters:[{id:'c3',url:'/3',number:1,uploadDate:60}]},
    {...entries[2], rating:-1, libraryAddedAt:20, chapters:[]},
  ];
  const recent=[{sourceId:'data:ALPHA',mangaUrl:'/blue',chapterId:'/2',updatedAt:30,percent:0.5}];
  const context={updates:[{mangaId:'two',sourceId:'data:beta',newChapters:3}],downloads:[{mangaId:'one',sourceId:'data:ALPHA',status:'COMPLETED',offline:true}],readMarks:{}};
  const pick=filters=>ids(selectLibraryEntries(books,filters,recent,context));
  assert.deepEqual(pick({sort:'oldest'}),['one','three','two']);
  assert.deepEqual(pick({sort:'title-desc'}),['one','two','three']);
  assert.deepEqual(pick({sort:'rating'}),['two','one','three']);
  assert.deepEqual(pick({sort:'updated'}),['two','one','three']);
  assert.deepEqual(pick({sort:'new-chapters'}),['two','one','three']);
  assert.deepEqual(pick({sort:'progress'}),['one','two','three']);
  assert.deepEqual(pick({downloaded:true}),['one']);
  assert.deepEqual(pick({newChapters:true}),['two']);
  assert.deepEqual(pick({completed:true}),[]); // Last chapter is only half read.
  context.readMarks.one={read:['/1','/2'],unread:[]};
  assert.deepEqual(pick({completed:true}),['one']);
  context.readMarks.one.unread=['/1'];
  assert.deepEqual(pick({completed:true}),[]);
  assert.equal(required().hasLibraryFilters({downloaded:true}),true);
  assert.equal(required().hasLibraryFilters(required().resetLibraryFilters({newChapters:true,completed:true,downloaded:true})),false);
});
