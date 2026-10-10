import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
import {overlayNativeMisc} from '../scripts/native-service-overlay.mjs';
import {webRoot} from '../scripts/build-frontend.mjs';

const original=await readFile(`${webRoot}/web/screens/explore.js`,'utf8');
const source=overlayNativeMisc('screens/explore.js',original);
function declaration(name){
  let found;
  function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&node.id.name===name)found=node;for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
  walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));assert(found,`Actual Explore function ${name} must exist`);return source.slice(found.start,found.end);
}
function fixture({known=true,installed=false,failedInstall=false,catalogPromise}={}){
  const id='data:REMOVED',entry={id,name:'Removed source',isInstalled:installed};
  const state={screen:'browse',sources:[],sourcesLoading:true,browseLoading:true,browseError:null,entries:[],mode:'POPULAR',page:1,browseToken:0};
  const calls=[],reads=[],messages=[],root={isConnected:true},store={source:null},route={name:'explore',params:{source:id}};let releaseInstall;
  const node=(tag,props,...children)=>({tag,props,children:children.flat()});
  const body={children:[],replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}};
  const button=(label,props={})=>({label,props,disabled:!!props.disabled});
  const api={listSources:async()=>{reads.push('installed');return {sources:entry.isInstalled?[{...entry}]:[]};},catalog:async()=>{reads.push('catalog');return catalogPromise||{entries:known?[{...entry}]:[]};},installSource:async sourceId=>{
    calls.push(['install',sourceId]);await new Promise(resolve=>releaseInstall=resolve);if(failedInstall)throw new Error('Native save failed');entry.isInstalled=true;calls.push(['committed',sourceId]);
  }};
  const helpers={state,api,root,store,router:{current:()=>route,navigate:(name,params={})=>{route.name=name;route.params=params;calls.push(['navigate',name,params]);}},wantSourceId:id,renderSourceLists:()=>{},renderBrowseView:()=>calls.push(['render']),renderLanding:()=>{},loadBrowse:page=>calls.push(['browse',store.source?.id,page]),el:node,btn:button,emptyState:text=>({text}),errorBox:text=>({text}),skeletonCard:()=>({skeleton:true}),spinner:()=>({loading:true}),card:()=>{},toast:message=>messages.push(message),openExtensions:()=>calls.push(['catalog']),lsSet:()=>{},LAST_SOURCE_KEY:'unused'};
  const functions=Function('deps',`const {${Object.keys(helpers).join(',')}}=deps;let sourceLoadToken=0,exploreCache=null;${declaration('loadSources')}\n${declaration('renderBrowseBody')}\n${declaration('selectSource')}\n${declaration('backToLanding')} return {loadSources,renderBrowseBody,selectSource,backToLanding};`)(helpers);
  const buttons=()=>{const result=[];function visit(node){if(node?.label)result.push(node);node?.children?.forEach(visit);}body.children.forEach(visit);return result;};
  return {...functions,state,calls,reads,body,messages,store,root,route,buttons,release:()=>releaseInstall(),entry};
}
test('uninstalled source deep link stops loading and only browses after explicit durable installation',async()=>{
  const f=fixture();await f.loadSources();assert.equal(f.state.browseLoading,false,'missing installed source must not remain on loading skeletons');f.renderBrowseBody(f.body);
  assert(!f.calls.some(([name])=>name==='install'||name==='browse'),'opening a deep link cannot install or fetch source content');
  const install=f.buttons().find(button=>button.label==='Install source');assert(install,'known catalogue entry needs an install action');
  const pending=install.props.onClick();await Promise.resolve();assert(install.disabled);assert.deepEqual(f.calls.filter(([name])=>name!=='render'),[['install','data:REMOVED']]);
  f.release();await pending;assert.deepEqual(f.calls.filter(([name])=>name!=='render'),[['install','data:REMOVED'],['committed','data:REMOVED'],['browse','data:REMOVED',1]]);assert.equal(f.store.source.id,'data:REMOVED');
});
test('removed or unsupported source deep link offers catalogue/back without installing or dispatching content',async()=>{
  const f=fixture({known:false});await f.loadSources();assert.equal(f.state.browseLoading,false);f.renderBrowseBody(f.body);
  assert(!f.buttons().some(button=>button.label==='Install source'));await f.buttons().find(button=>button.label==='Open catalog').props.onClick();await f.buttons().find(button=>button.label==='Back to Explore').props.onClick();
  assert.deepEqual(f.calls.filter(([name])=>name!=='render'),[['catalog'],['navigate','explore',{}]]);
});
test('failed installation keeps the unavailable view and enables another explicit attempt without browsing',async()=>{
  const f=fixture({failedInstall:true});await f.loadSources();assert.equal(f.state.browseLoading,false);f.renderBrowseBody(f.body);const install=f.buttons().find(button=>button.label==='Install source');assert(install);
  const pending=install.props.onClick();await Promise.resolve();f.release();await pending;assert.equal(install.disabled,false);assert.equal(f.store.source,null);assert(!f.calls.some(([name])=>name==='browse'));assert.deepEqual(f.messages,['Native save failed']);
});
test('a delayed catalogue lookup cannot change a source view after navigation away',async()=>{
  let release;const f=fixture({catalogPromise:new Promise(resolve=>release=resolve)});const pending=f.loadSources();await Promise.resolve();f.root.isConnected=false;release({entries:[f.entry]});await pending;assert.deepEqual(f.calls,[]);
});
test('installed source keeps the normal browse path without catalogue lookup or installation',async()=>{
  const f=fixture({installed:true});await f.loadSources();assert.deepEqual(f.calls,[['browse','data:REMOVED',1]]);assert.deepEqual(f.reads,['installed']);assert.equal(f.store.source.id,'data:REMOVED');
});
test('a removed source cannot reuse a cached source object or previously loaded titles',async()=>{
  const f=fixture();f.store.source={id:f.entry.id,isInstalled:true};f.state.entries=[{id:'cached-title'}];await f.loadSources();assert.equal(f.store.source,null);assert.deepEqual(f.state.entries,[]);assert.equal(f.state.browseLoading,false);assert(!f.calls.some(([name])=>name==='browse'));
});
test('changing to another Explore source invalidates a delayed missing-source response before the old root detaches',async()=>{
  let release;const f=fixture({catalogPromise:new Promise(resolve=>release=resolve)});const pending=f.loadSources();await Promise.resolve();
  f.route.params={source:'data:OTHER'};f.store.source={id:'data:OTHER'};release({entries:[f.entry]});await pending;
  assert.equal(f.store.source.id,'data:OTHER');assert.equal(f.state.missingSource,undefined);assert.deepEqual(f.calls,[]);
});
test('an older missing-source lookup cannot replace newer confirmed installed state on the same route',async()=>{
  let release;const f=fixture({catalogPromise:new Promise(resolve=>release=resolve)});const old=f.loadSources();await Promise.resolve();
  f.entry.isInstalled=true;await f.loadSources();release({entries:[{...f.entry,isInstalled:false}]});await old;
  assert.equal(f.state.missingSource,null);assert.equal(f.store.source.id,f.entry.id);assert.deepEqual(f.calls,[['browse',f.entry.id,1]]);
});
test('Back and source selection immediately clear missing-source state and invalidate pending lookups',async()=>{
  const f=fixture();await f.loadSources();assert(f.state.missingSource);f.selectSource({id:'data:OTHER',isInstalled:true});assert.equal(f.state.missingSource,null);assert.equal(f.route.params.source,'data:OTHER');
  f.state.missingSource={source:f.entry};f.backToLanding();assert.equal(f.state.missingSource,null);assert.deepEqual(f.route.params,{});
});
