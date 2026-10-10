import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
import {createNativeDownloads} from '../frontend/native-downloads.js';
import {createLocalReader,getLocalReader} from '../frontend/native-local-reader.js';
import * as localReader from '../frontend/native-local-reader.js';
import {overlayNativeMisc,overlayNativeSettings} from '../scripts/native-service-overlay.mjs';
import {overlaySettings} from '../scripts/frontend-overlay.mjs';
import {awaitNativeMutations} from '../scripts/native-mutation-overlay.mjs';
import {webRoot} from '../scripts/build-frontend.mjs';
const source=path=>readFile(`${webRoot}/web/${path}`,'utf8');
test('offline reader uses durable book identity and rehydrates fresh media and saved page after renderer restart',async()=>{
  globalThis.location={origin:'http://127.0.0.1:31337'};
  const id='00000000-0000-4000-8000-000000000001',book={id,title:'Offline',state:{page:1},pages:[{url:`${location.origin}/local-media/${id}/0?cap=current`},{url:`${location.origin}/local-media/${id}/1?cap=current`}]};
  const route=createLocalReader({...book,state:book.state});assert.equal(route.local,id);getLocalReader(id).dispose();assert.equal(getLocalReader(id),null);
  await localReader.restoreLocalReader(id,'local',async requested=>{assert.equal(requested,id);return book;});assert.equal(getLocalReader(id).state.page,1);assert.match(getLocalReader(id).pages[0].url,/cap=current/);
  assert.throws(()=>createLocalReader({...book,pages:[{url:'http://127.0.0.1:8788/local/image?file=x'}]}),/issued by this app/);
});
test('incognito and oversized queries do not persist recent searches or interrupt the actual search',async()=>{
  const result=overlayNativeMisc('screens/search.js',await source('screens/search.js'));
  const a=result.indexOf('async function pushRecent('),b=result.indexOf('async function clearRecent',a);assert(a>0&&b>a);
  let incognito=true,writes=[];
  const push=Function('nativeServices','getRecent',`${result.slice(a,b)} return pushRecent;`)({uiPreferences:()=>({incognito}),saveUiPreferences:async patch=>writes.push(patch)},()=>['old query']);
  await push('private query');assert.deepEqual(writes,[]);incognito=false;await push('x'.repeat(201));assert.deepEqual(writes,[]);
  await push(' normal query ');assert.deepEqual(writes,[{searchRecent:['normal query','old query']}]);
});
test('reader preference rejection propagates to Done action rather than claiming the uncommitted colour save finished',async()=>{
  const result=awaitNativeMutations(overlayNativeMisc('screens/reader.js',await source('screens/reader.js')),'screens/reader.js').source;
  const a=result.indexOf('  async function savePrefs()'),b=result.indexOf('  // Chapter pages cache',a);assert(a>0&&b>a);
  const save=Function('library','desktopMutation',`const st={manga:{id:'exact-native-id'},grade:{brightness:0,contrast:1,saturation:1,invert:0.5,palette:''}},local=null; const mode='PAGED',fit='WIDTH',prefetch=true,webtoonWidth=70,autoLevel=2,translateTo='en',translateFrom='auto'; ${result.slice(a,b)} return savePrefs;`)({saveMangaPrefs:async()=>{throw new Error('Device write failed');}},fn=>fn());
  await assert.rejects(save(),/Device write failed/);
});
test('local reader preferences are acknowledged durably before changing confirmed state, and failure retains prior adjustments',async()=>{
  const result=awaitNativeMutations(overlayNativeMisc('screens/reader.js',await source('screens/reader.js')),'screens/reader.js').source;
  const a=result.indexOf('  async function savePrefs()'),b=result.indexOf('  // Chapter pages cache',a);assert(a>0&&b>a);
  const previous={invert:0.25},local={state:{prefs:previous},savePreferences:async()=>{throw new Error('Offline preferences could not be saved');}};
  const save=Function('local','desktopMutation',`const st={manga:{id:'local:00000000-0000-4000-8000-000000000001'},grade:{brightness:0,contrast:1,saturation:1,invert:0.5,palette:''}}; const mode='PAGED',fit='WIDTH',prefetch=true,webtoonWidth=70,autoLevel=2,translateTo='en',translateFrom='auto'; ${result.slice(a,b)} return savePrefs;`)(local,fn=>fn());
  await assert.rejects(save(),/Offline preferences could not be saved/);assert.equal(local.state.prefs,previous);
  let release;local.savePreferences=prefs=>new Promise(resolve=>{assert.equal(prefs.invert,0.5);release=resolve;});
  const pending=save();assert.equal(local.state.prefs,previous);release();await pending;assert.equal(local.state.prefs.invert,0.5);
});
test('download cache exposes only confirmed durable jobs, survives failed mutation and hydrates after restart',async()=>{
  let saved={entries:[],settings:{format:'CBZ'}},reject=false;const calls=[];
  const request=async(operation,params)=>{calls.push([operation,params]);if(operation==='downloads.snapshot')return structuredClone(saved);if(reject)throw new Error('Disk full');saved.entries.push({id:'committed',sourceId:'data:ATSUMOE',chapterUrl:'opaque',status:'QUEUED'});return {added:1,requeued:0,skipped:0};};
  const downloads=createNativeDownloads(request);await downloads.hydrate();reject=true;
  await assert.rejects(downloads.enqueue([{sourceId:'data:ATSUMOE',chapterUrl:'opaque'}]),/Disk full/);assert.deepEqual(downloads.list(),[]);
  reject=false;await downloads.enqueue([{sourceId:'data:ATSUMOE',chapterUrl:'opaque'}]);assert.equal(downloads.statusOf('data:ATSUMOE','opaque').id,'committed');
  const restart=createNativeDownloads(request);await restart.hydrate();assert.deepEqual(restart.list(),downloads.list());assert(calls.some(([op,p])=>op==='downloads.enqueue'&&Array.isArray(p.descriptors)));
});
test('full desktop overlays restore downloads, durable read marks/search and safe offline reader without browser storage',async()=>{
  for(const file of ['screens/details.js','screens/downloads.js','screens/search.js']){
    const result=awaitNativeMutations(overlayNativeMisc(file,await source(file)),file).source;parse(result,{ecmaVersion:'latest',sourceType:'module'});
    assert(!/unavailable in this desktop preview|Downloads unavailable|localStorage/.test(result),file);
    if(file==='screens/details.js'){assert.match(result,/library\.readMarks\(mangaId\)/);assert.match(result,/await .*saveReadMarks/);}
    if(file==='screens/downloads.js')assert.match(result,/await downloads\.open\(job.id\)/);
    if(file==='screens/search.js')assert.match(result,/searchRecent/);
  }
});
test('consumer settings offer native download controls, cloud account and website sessions without prototype dead ends',async()=>{
  const result=awaitNativeMutations(overlayNativeSettings(overlaySettings(await source('screens/settings.js'))),'screens/settings.js').source;
  parse(result,{ecmaVersion:'latest',sourceType:'module'});assert(!/desktop prototype|Prototype data|Downloads unavailable|Tracking unavailable/.test(result));
  assert.match(result,/Merge and sync/);assert.match(result,/mountRuntimePanel/);assert.match(result,/downloads\.saveSettings/);
  assert(!/NYORA WEB 2\.0|reader for the browser/.test(result));
  const details=overlayNativeMisc('screens/details.js',await source('screens/details.js'));
  assert(!/Connect AniList, MyAnimeList, MangaBaka or Kitsu/.test(details));
  assert.match(details,/Connect an available account in Settings/);
});
