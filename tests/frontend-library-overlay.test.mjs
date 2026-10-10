import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import * as tools from '../frontend/library-tools.js';
import * as presentation from '../frontend/library-presentation.js';
import { overlayNativeMisc } from '../scripts/native-service-overlay.mjs';

let transform = source => source;
try { ({ overlayLibraryTools: transform } = await import('../scripts/library-tools-overlay.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const original = await readFile(new URL('../vendor/web/web/screens/library.js', import.meta.url), 'utf8');
const source = transform(overlayNativeMisc('screens/library.js', original));
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const render = tree.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'render').declaration;
const sorts = tree.body.find(node => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'SORTS').declarations[0].init;

function fixture(rows = [
  {id:'a',title:'Blue Garden',url:'/blue',source:{name:'data:ALPHA'}},
  {id:'b',title:'Blue Garden',url:'/blue',source:{name:'data:beta'}},
  {id:'c',title:'Amber Road',url:'/amber',source:{name:'data:ALPHA'}},
]) {
  const node = (tag, props = {}, ...children) => ({ tag, props: props || {}, children: children.flat(), style:{}, textContent:'', value:props?.value || '', isConnected:true,
    append(...items){this.children.push(...items);}, appendChild(item){if(item.tag==='fragment')this.children.push(...item.children);else this.children.push(item);return item;}, replaceChildren(...items){this.children=items;},
  });
  const view = node('main'), chips=[], segments=[], observers=[];
  const deps = { ...tools, ...presentation, el:node, btn:(label,props)=>node('button',props,label), chip:(label,props)=>{const pill=node('button',props,label);chips.push(pill);return pill;},
    card:manga=>node('card',{manga}), toast:()=>{}, skeletonCard:()=>node('skeleton'), icon:()=>node('icon'), emptyState:message=>node('empty',{},message),errorBox:message=>node('error',{},message),
    promptDialog:()=>{},confirmDialog:()=>{},modal:()=>{},attachContextMenu:()=>{},segmented:(options,value,onChange)=>{const segment=node('segmented',{options,value,onChange});segments.push(segment);return segment;},
    library:{onChange:()=>()=>{},favourites:()=>({entries:rows}),categories:()=>({categories:[{id:7,title:'Selected',mangaCount:1}]}),categoryManga:()=>({entries:[rows[1]]}),history:()=>({entries:[{sourceId:'data:ALPHA',mangaUrl:'/blue',updatedAt:2}]})},
    api:{},store:{},router:{navigate:()=>{}},downloadsRender:()=>{}, installedSources:async()=>[{id:'data:ALPHA',name:'Alpha'},{id:'data:beta',name:'Beta'}], resolveSid:manga=>manga.source.name,
    MutationObserver:class {observe(){}disconnect(){}},sortEntries:entries=>entries, document:{createDocumentFragment:()=>node('fragment')},IntersectionObserver:class {constructor(callback){this.callback=callback;observers.push(this);}observe(){}unobserve(){}disconnect(){}},
  };
  const fn=Function('deps',`const {${Object.keys(deps).join(',')}}=deps;const SORTS=${source.slice(sorts.start,sorts.end)};${source.slice(render.start,render.end)};return render;`)(deps);
  fn(view, {});
  const all=()=>{const list=[];function walk(n){if(typeof n!=='object'||!n)return;list.push(n);n.children?.forEach(walk);}walk(view);return list;};
  const find=label=>all().find(n=>n.props['aria-label']===label);
  const titles=()=>all().filter(n=>n.tag==='card').map(n=>n.props.manga.id);
  return {view,all,find,titles,segments,chips,observers};
}

test('actual Library render combines local controls and preserves selected collection after no-results reset', () => {
  const f=fixture(); const search=f.find('Search your library');
  assert(search,'Library needs local text search, not the universal online search');
  search.props.onInput({target:{value:'blue'}});
  assert.deepEqual(f.titles(),['a','b']);
  f.find('Filter library by source').props.onChange({target:{value:'data:ALPHA'}});
  assert.deepEqual(f.titles(),['a']);
  f.chips.find(chip=>chip.children[0]==='Selected · 1').props.onClick();
  assert.deepEqual(f.titles(),[]);
  const reset=f.all().find(n=>n.tag==='button'&&n.children[0]==='Reset filters');assert(reset,'no matches should have an actionable reset');reset.props.onClick();
  assert.deepEqual(f.titles(),['b'],'reset must preserve the active collection');
});
test('Library renders only the first card chunk and still grows the filtered grid through its observer', () => {
  const rows=Array.from({length:60},(_,i)=>({id:String(i),title:`Saved ${i}`,url:`/${i}`,source:{name:'data:ALPHA'}}));
  const f=fixture(rows);assert.equal(f.titles().length,24);assert.equal(f.observers.length,1);
  f.observers[0].callback([{isIntersecting:true}]);assert.equal(f.titles().length,48);
  f.observers[0].callback([{isIntersecting:true}]);assert.equal(f.titles().length,60);
});
test('checked Library transform rejects a changed filtering boundary instead of silently shipping partial controls', () => {
  assert.throws(()=>transform(original.replace('entries = sortEntries(favEntries(), state.sort);','entries = favEntries();')),/drift/i);
});

test('empty Library hides inapplicable controls and exposes both ways to begin', () => {
  const f = fixture([]);
  assert.equal(f.find('Library filters').hidden, true);
  assert(f.find('Empty library'));
  for (const label of ['Browse sources', 'Import comics']) assert(f.all().some(n => n.tag === 'button' && n.children[0] === label));
});
test('filter disclosure counts active source and history filters and compact sort preserves ordering', () => {
  const f = fixture();
  f.find('Filter library by source').props.onChange({target:{value:'data:ALPHA'}});
  f.find('Filter library by reading history').props.onChange({target:{value:'with-history'}});
  assert.equal(f.all().find(n => n.tag === 'summary').textContent, 'Filters (2)');
  f.find('Filter library by reading history').props.onChange({target:{value:'all'}});
  f.find('Sort library').props.onChange({target:{value:'title'}});
  assert.deepEqual(f.titles(), ['c', 'a']);
});
