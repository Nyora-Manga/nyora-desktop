import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { overlaySettings } from '../scripts/frontend-overlay.mjs';
import { overlayNativeMisc, overlayNativeSettings } from '../scripts/native-service-overlay.mjs';
import { awaitNativeMutations } from '../scripts/native-mutation-overlay.mjs';
import { overlayDownloadControls } from '../scripts/download-controls-overlay.mjs';
import { overlayReadingRoom } from '../scripts/reading-room-overlay.mjs';
import { webRoot } from '../scripts/build-frontend.mjs';

const sources = {};
for (const name of ['explore', 'settings', 'downloads', 'discover', 'details']) {
  const key = `screens/${name}.js`;
  let source = await readFile(`${webRoot}/web/${key}`, 'utf8');
  if (name === 'settings') source = overlayNativeSettings(overlaySettings(source));
  source = awaitNativeMutations(overlayNativeMisc(key, source), key).source;
  if (name === 'downloads') source = overlayDownloadControls(source);
  sources[name] = overlayReadingRoom(source, key);
}
function declaration(source, name) {
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id.name === name) found = node;
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  }
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  assert(found, `Function ${name} exists`);
  return source.slice(found.start, found.end);
}
function node(tag, props, ...children) {
  return { tag, props: props || {}, children: children.flat().filter(Boolean), dataset: {}, hidden: false,
    classList: { add() {}, toggle() {} },
    append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, appendChild(item) { this.children.push(item); return item; },
    replaceChildren(...items) { this.children = items; }, setAttribute(key, value) { this.props[key] = value; },
    addEventListener(key, value) { this.props[key] = value; },
  };
}
const btn = (label, props) => node('button', props, label);
const text = n => typeof n === 'string' ? n : (n?.children || []).map(text).join(' ');
const all = n => [n, ...(n?.children || []).filter(x => typeof x === 'object').flatMap(all)];
const instantiate = (name, names, deps) => Function('deps', `const {${Object.keys(deps).join(',')}}=deps; ${names.map(n => declaration(sources[name], n)).join('\n')} return ${names.at(-1)};`)(deps);

test('screen overlays parse after native transforms and fail loudly on source drift', () => {
  for (const source of Object.values(sources)) parse(source, {ecmaVersion:'latest',sourceType:'module'});
  assert.throws(() => overlayReadingRoom('missing', 'screens/settings.js'), /drift/i);
  assert.equal(overlayReadingRoom('untouched', 'screens/other.js'), 'untouched');
});

test('source search combines local name, language and pins while keeping the search node mounted', () => {
  const state = {filter:'',lang:'all',pinnedOnly:false,sourcesLoading:false,sourcesError:null};
  const entries = [{id:'a',name:'Sakura Reader',lang:'en',isPinned:true},{id:'b',name:'Sakura JP',lang:'ja'},{id:'c',name:'Other Reader',lang:'en'}];
  const make = instantiate('explore', ['sourcesSection'], {state, el:node, btn, sectionHeader:(label,...children)=>node('header',null,label,...children), installedVisible:()=>entries,
    filteredSources:()=>entries.filter(s => (state.lang==='all'||s.lang===state.lang) && s.name.toLowerCase().includes(state.filter.toLowerCase())),
    buildLangSelect:()=>({el:node('select'),langCount:2}), renderLanding(){}, openExtensions(){}, sourceTile:s=>node('article',{'data-id':s.id},s.name),
    emptyState:message=>node('p',null,message), spinner:()=>node('i'),errorBox:message=>node('p',null,message),loadSources(){}});
  const section = make();
  const input = all(section).find(n=>n.tag==='input');
  assert.equal(input.props['aria-label'],'Search sources');
  input.props.onInput({target:{value:'Sakura'}});
  assert.deepEqual(all(section).filter(n=>n.tag==='article').map(n=>n.props['data-id']),['a','b']);
  state.lang='en'; input.props.onInput({target:{value:'Sakura'}});
  const pin = all(section).find(n=>n.tag==='button' && text(n)==='Pinned only'); pin.props.onClick();
  assert.deepEqual(all(section).filter(n=>n.tag==='article').map(n=>n.props['data-id']),['a']);
  input.props.onInput({target:{value:'Missing'}});
  assert.match(text(section),/No sources match/);
  assert.equal(all(section).find(n=>n.tag==='input'),input);
});

test('settings keep category routes, native builders and nested back navigation in the two-column shell', () => {
  const calls = [], builds=[];
  const SECTIONS = ['appearance','advanced','experimental'].map(id=>({id,name:id,sub:'description',icon:'icon',build:()=>{builds.push(id);return node('section',null,id);}}));
  const render = instantiate('settings',['render'], {SECTIONS,EXP_CHILDREN:{translation:{name:'Translation',build:()=>node('section',null,'Translate')}},
    el:node,sectionHeader:label=>node('header',null,label),navRow:(name,sub,icon,onClick)=>node('button',{onClick},name),
    iconBtn:(icon,onClick,label)=>btn(label,{onClick}),router:{navigate:(...args)=>calls.push(args)},store:{get:()=>({experimental:true})}});
  const view=node('main');render(view,{});
  assert.deepEqual(builds,['appearance']);
  assert(all(view).some(n=>n.props.class?.includes('reading-settings-layout')));
  const advanced=all(view).find(n=>n.tag==='button'&&text(n)==='advanced');advanced.props.onClick();
  assert.deepEqual(calls.pop(),['settings',{s:'advanced'}]);
  render(view,{s:'advanced'});assert.equal(builds.at(-1),'advanced');
  render(view,{s:'experimental',sub:'translation'});
  assert.match(text(view),/Translate/);
  all(view).find(n=>n.tag==='button'&&text(n)==='Back to Experimental').props.onClick();
  assert.deepEqual(calls.pop(),['settings',{s:'experimental'}]);
});

test('empty downloads offer library without queue controls, while load errors remain recoverable', () => {
  let rows=[],error=null,painted;const routes=[];
  const downloads={list:()=>rows,queuePaused:()=>false,warnings:()=>[],error:()=>error};
  const paint=instantiate('downloads',['paintQueue'],{downloads,document:{createDocumentFragment:()=>node('fragment')},el:node,btn,
    pendingDownloadControls:new Set(),downloadControlMutation:op=>op(),replaceDownloadQueue:(host,fragment)=>{painted=fragment;},
    emptyState:message=>node('p',null,message),errorBox:message=>node('p',null,message),router:{navigate:route=>routes.push(route)},
    sectionHeader:(label,...children)=>node('header',null,label,...children),downloadRow:(view,job)=>node('article',null,job.id),ACTIVE:new Set(['RUNNING','QUEUED'])});
  paint({},{});
  assert.doesNotMatch(text(painted),/Pause queue|Clear finished|Delete all/);
  all(painted).find(n=>n.tag==='button'&&text(n)==='Browse library').props.onClick();assert.deepEqual(routes,['library']);
  error='Native store is unavailable';paint({},{});assert.match(text(painted),/Native store is unavailable/);assert.doesNotMatch(text(painted),/No downloads yet|Ready for offline/);
  rows=[{id:'queued',status:'QUEUED'}];error=null;paint({},{});assert.match(text(painted),/Pause queue/);
});

test('discovery distinguishes explicit offline from other failures and retains useful routes', () => {
  const routes=[],navigator={onLine:true};
  const make=instantiate('discover',['readingRoomDiscoveryState'],{navigator,el:node,btn,router:{navigate:r=>routes.push(r)}});
  const failure=make('error',()=>{});assert.doesNotMatch(text(failure),/You’re offline/);assert.match(text(failure),/couldn’t load/i);
  all(failure).find(n=>n.tag==='button'&&text(n)==='Open library').props.onClick();
  all(failure).find(n=>n.tag==='button'&&text(n)==='Browse sources').props.onClick();assert.deepEqual(routes,['library','explore']);
  navigator.onLine=false;assert.match(text(make('error',()=>{})),/You’re offline/);
  navigator.onLine=true;assert.match(text(make('empty',()=>{})),/No recommendations/);
});

test('offline storage actions follow confirmed jobs, and empty-state polling restores action focus', () => {
  let rows=[];
  const make=instantiate('downloads',['buildStorageStrip'],{el:node,btn,icon:()=>node('i'),fmtBytes:()=> '0 B',
    downloads:{counts:()=>({completed:0,totalBytes:0}),list:()=>rows}});
  const storage=make();assert.equal(storage.node.hidden,true);
  rows=[{status:'QUEUED'}];storage.refresh();assert.equal(storage.node.hidden,false);
  assert.equal(all(storage.node).find(n=>n.tag==='button'&&text(n)==='Clear finished').hidden,true);
  rows=[{status:'COMPLETED'}];storage.refresh();
  assert.equal(all(storage.node).find(n=>n.tag==='button'&&text(n)==='Clear finished').hidden,false);
  rows=[];storage.refresh();assert.equal(storage.node.hidden,true);
  let focused=0;
  const active={dataset:{downloadQueueAction:'browse-library'},closest:()=>null,getAttribute:()=>null};
  const restored={dataset:{downloadQueueAction:'browse-library'},focus(options){assert.equal(options.preventScroll,true);focused++;}};
  const replace=instantiate('downloads',['replaceDownloadQueue'],{document:{activeElement:active}});
  const host={contains:el=>el===active,replaceChildren(){},querySelectorAll:()=>[restored]};
  replace(host,node('fragment'));assert.equal(focused,1);
});

test('source pin keyboard activation cannot also navigate to the source', () => {
  const calls=[];
  const make=instantiate('explore',['sourceTile'],{el:node,iconBtn:(icon,onClick,title)=>node('button',{onClick,title}),
    togglePin:()=>calls.push('pin'),selectSource:()=>calls.push('open'),medallion:()=>node('i'),langLabel:()=> 'English'});
  const tile=make({id:'source',name:'Source',lang:'en'});
  const pin=tile.children[0];
  tile.props.onKeydown({target:pin,currentTarget:tile,key:'Enter',preventDefault(){}});
  assert.deepEqual(calls,[]);
  pin.props.onClick({stopPropagation(){}});assert.deepEqual(calls,['pin']);
  tile.props.onKeydown({target:tile,currentTarget:tile,key:'Enter',preventDefault(){}});assert.deepEqual(calls,['pin','open']);
});

test('chapter search composes with unread and downloaded filters while retaining exact identities and indices', () => {
  const first={url:'opaque:one',title:'The Beginning',number:1};
  const second={url:'opaque:two',title:'A New Beginning',number:2};
  const third={url:'opaque:three',title:'Homecoming',number:12};
  const fourth={url:'opaque:four',title:'A New Beginning',number:22};
  const readingOrder=[fourth,third,second,first],state2={filter:'all',sortKey:'number',asc:false,query:'beginning'};
  const listHost=node('ul'),countEl=node('span'),ctx={sid:'exact-source'};
  const deps={state2,readingOrder,ascByNumber:[first,second,third,fourth],listHost,countEl,ctx,sid:'exact-source',
    derivedRead:()=>()=>false,isRead:c=>c===first,unreadCount:()=>3,
    downloads:{statusOf:(sid,url)=>{assert.equal(sid,'exact-source');return {status:url===second.url?'COMPLETED':'QUEUED'};}},
    fmt:{chapterTitle:(c,index)=>c.title || `Chapter ${c.number ?? index+1}`},
    emptyState:message=>node('p',null,message),buildChapterRow:(context,c,index)=>node('li',{chapter:c,index,context},c.title)};
  const render=Function('deps',`const {${Object.keys(deps).join(',')}}=deps;let isDerived;${declaration(sources.details,'sorted')}\n${declaration(sources.details,'renderRows')}return renderRows;`)(deps);
  const matches=()=>listHost.children.filter(n=>n.tag==='li');
  render();assert.deepEqual(matches().map(n=>n.props.chapter),[fourth,second,first]);
  state2.filter='unread';render();assert.deepEqual(matches().map(n=>n.props.chapter),[fourth,second]);
  state2.filter='downloaded';render();assert.deepEqual(matches().map(n=>n.props.chapter),[second]);
  assert.equal(matches()[0].props.chapter,second);assert.equal(matches()[0].props.index,1);assert.equal(matches()[0].props.context,ctx);
  state2.query='12';render();assert.equal(matches().length,0);assert.match(text(listHost),/No chapters match/);
  state2.filter='all';render();assert.equal(matches()[0].props.chapter,third);
  state2.query='';state2.asc=true;render();assert.deepEqual(matches().map(n=>n.props.chapter),[first,second,third,fourth]);
  assert.match(sources.details, /'aria-label':\s*'Search chapters'/);
  assert.match(sources.details,/await desktopMutation\(\(\) => downloads.enqueue/);
});
