import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DesktopServices} from '../electron/services.cjs';
import {ReaderState} from '../electron/reader-state.cjs';
const contract=JSON.parse(await readFile(new URL('../frontend/service-contract.json',import.meta.url),'utf8'));
test('new features reject paths, tokens and unexpected arguments before broker dispatch',async()=>{
  const calls=[];
  const services=new DesktopServices({contract,nativeRequest:async(operation,params)=>{calls.push([operation,params]);return {ok:true};}});
  await services.request({operation:'local.select',params:{kind:'archive'}});
  await services.request({operation:'downloads.enqueue',params:{descriptors:[]}});
  assert.equal(calls.length,2);
  for(const value of [
    {operation:'local.select',params:{path:'/private/file'}},
    {operation:'sync.now',params:{session:{accessToken:'forged'}}},
    {operation:'tracking.search',params:{slug:'anilist',title:'Test',url:'https://other.example'}},
    {operation:'downloads.export',params:{id:'fixture',destination:'/private/file'}},
    {operation:'local.rawRead',params:{path:'/private/file'}},
  ]) await assert.rejects(services.request(value),/Unexpected|Unknown/);
  assert.equal(calls.length,2);
});
test('complete title preferences persist without leaking extra fields into legacy helper queries',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nyora-title-adapter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];
  const helper={start:async()=>{},request:async(route)=>{calls.push(route);return {contentType:'application/json',bytes:Buffer.from(JSON.stringify(route.startsWith('/manga/prefs?')?{present:true,brightness:0,readerMode:'WEBTOON'}:{ok:true}))};}};
  const create=()=>new DesktopServices({contract,helper,readerState:new ReaderState(directory)});
  await create().request({operation:'library.mangaPrefsSave',params:{mangaId:'123',readerMode:'WEBTOON',readerFit:'HEIGHT',prefetch:false,invert:0.5,webtoonWidth:75}});
  assert.equal(calls[0].includes('readerFit'),false);assert.equal(calls[0].includes('invert'),false);
  const value=await create().request({operation:'library.mangaPrefs',params:{mangaId:'123'}});
  assert.equal(value.readerMode,'WEBTOON');assert.equal(value.readerFit,'HEIGHT');assert.equal(value.invert,0.5);assert.equal(value.prefetch,false);
  await create().request({operation:'library.readMarksSave',params:{mangaId:'123',read:['/chapter'],unread:[]}});
  assert.deepEqual(await create().request({operation:'library.readMarks',params:{mangaId:'123'}}),{read:['/chapter'],unread:[]});
  await create().request({operation:'library.mangaPrefsClear',params:{mangaId:'123'}});
  assert.equal((await create().request({operation:'library.mangaPrefs',params:{mangaId:'123'}})).invert,undefined);
});

test('Replace clears native chapter overrides but preserves device reader preferences',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nyora-reader-replace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const state=new ReaderState(directory);await state.saveMarks('one',{read:['/c1'],unread:['/c2']});await state.savePreferences('one',{readerFit:'HEIGHT'});
  await state.clearAllMarks();const reopened=await new ReaderState(directory).get('one');
  assert.deepEqual(reopened.marks,{read:[],unread:[]});assert.equal(reopened.preferences.readerFit,'HEIGHT');
});
