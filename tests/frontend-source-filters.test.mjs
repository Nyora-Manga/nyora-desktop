import test from 'node:test';
import assert from 'node:assert/strict';
const filters = await import('../frontend/source-filter-state.js').catch(() => ({}));
const options = { multipleTags: true, tagsExclusion: true, searchWithFilters: true,
  tags: [{ key: 'id-1', title: 'Adventure' }, { key: 'id-2', title: 'Drama' }],
  filters: [{ name: 'Sort', typeName: 'text', values: ['ALPHABETICAL', 'UPDATED'] }, { name: 'State', typeName: 'text', values: ['ONGOING', 'FINISHED'] }, { name: 'Year', typeName: 'text', values: [] }] };
test('genre selection keeps include and exclude mutually exclusive and preserves opaque keys', () => {
  assert.equal(typeof filters.setTag, 'function');
  const draft = { Tags: ['id-1'], 'Excluded tags': [] };
  const next = filters.setTag(draft, 'id-1', 'exclude', options);
  assert.deepEqual(next.Tags, []); assert.deepEqual(next['Excluded tags'], ['id-1']);
  assert.deepEqual(draft.Tags, ['id-1']);
});
test('single-genre sources replace the prior selection', () => {
  assert.equal(typeof filters.setTag, 'function');
  assert.deepEqual(filters.setTag({ Tags: ['id-1'] }, 'id-2', 'include', {...options,multipleTags:false}).Tags, ['id-2']);
});
test('wire filters preserve source keys, omit defaults, and reject stale preset options', () => {
  assert.equal(typeof filters.toWireFilters, 'function');
  assert.deepEqual(filters.toWireFilters({ Tags: ['id-1', 'removed'], State: 'FINISHED', Sort: 'ALPHABETICAL', Year: '', Locale: 'en' }, options), [
    {name:'Tags',type:'text',value:'id-1'}, {name:'Sort',type:'text',value:'ALPHABETICAL'}, {name:'State',type:'text',value:'FINISHED'}
  ]);
});
test('a source that cannot combine search with filters rejects the combination', () => {
  assert.equal(typeof filters.validateFilterDraft, 'function');
  assert.match(filters.validateFilterDraft({Tags:['id-1']}, {...options,searchWithFilters:false}, 'hero'), /search/i);
  assert.equal(filters.validateFilterDraft({}, {...options,searchWithFilters:false}, 'hero'), '');
  assert.match(filters.validateFilterDraft({Year:'not a year'}, options, ''), /year/i);
});

test('source recovery only retries the exact filters and failed page', async () => {
  const {readFile}=await import('node:fs/promises');
  const {overlayNativeMisc}=await import('../scripts/native-service-overlay.mjs');
  const {overlaySourceFilters}=await import('../scripts/source-filters-overlay.mjs');
  const shared=await readFile(new URL('../vendor/web/web/screens/explore.js',import.meta.url),'utf8');
  const result=overlaySourceFilters(overlayNativeMisc('screens/explore.js',shared));
  const start=result.indexOf('  _onSourceContentRecovered = '),end=result.indexOf("  window.addEventListener('nyora:source-content-recovered'",start);
  const calls=[],state={screen:'browse',mode:'SEARCH',query:'',page:1,browseRequestPage:2,browseError:'Verification required',browseLoading:false,browseFilters:[{name:'Sort',type:'text',value:'ALPHABETICAL'}]};
  const handler=Function('root','router','state','store','loadBrowse',`let _onSourceContentRecovered; ${result.slice(start,end)} return _onSourceContentRecovered;`)({isConnected:true},{current:()=>({name:'explore'})},state,{source:{id:'data:test'}},(...args)=>calls.push(args));
  const event=f=>({detail:{sourceId:'data:test',requests:[{operation:'content.search',params:{id:'data:test',q:'',page:2,f}}]},preventDefault(){}});
  handler(event(JSON.stringify([{name:'Sort',type:'text',value:'UPDATED'}])));assert.deepEqual(calls,[]);
  handler(event(JSON.stringify(state.browseFilters)));assert.deepEqual(calls,[[2,true]]);assert.equal(state.page,1);
});

test('multi-value axes round trip and prune stale values while single-value sources stay single', () => {
  const multi = {...options, filters: [...options.filters.filter(f=>f.name!=='State'), {name:'State',values:['ONGOING','FINISHED'],multiple:true}]};
  const wire = filters.toWireFilters({State:['ONGOING','removed','FINISHED','ONGOING']},multi);
  assert.deepEqual(wire,[{name:'State',type:'text',value:'ONGOING,FINISHED'}]);
  assert.deepEqual(filters.toWireFilters(filters.draftFromWire(wire),multi),wire);
  assert.deepEqual(filters.toWireFilters({State:['ONGOING','FINISHED']}, options),[{name:'State',type:'text',value:'ONGOING'}]);
});
