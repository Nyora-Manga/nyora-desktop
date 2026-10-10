import {browserOptions} from '../scripts/browser-options.mjs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createFrontendServer} from '../scripts/dev-server.mjs';
import {resolve} from 'node:path';
const server=await createFrontendServer(resolve('dist'),{port:0});
const browser=await chromium.launch({headless:true,...(await browserOptions())});
const context=await browser.newContext({viewport:{width:1380,height:940}});
await context.addInitScript(()=>{
  const source={id:'data:TEST',name:'Test',lang:'en',isInstalled:true,isPinned:true};
  const media=name=>location.origin+'/helper-image?'+new URLSearchParams({sourceId:source.id,cap:'fixture',u:'https://covers.example/'+name});
  const books=['transient','alternate','missing','stable'].map(id=>({id,title:id,url:'/manga/'+id,source:{name:source.id},coverUrl:media(id),...(id==='alternate'?{largeCoverUrl:media('large')}:{} )}));
  let prefs={onboarded:true,appearance:'DARK',reader:{mode:'VERTICAL',fit:'HEIGHT',prefetch:false}};
  window.__calls=[];
  window.nyoraDesktop={runtimeStatus:async()=>({runtime:'electron',dataMode:'native-helper',appVersion:'0.2.3'}),verificationStatus:()=>[],onNavigate:()=>()=>{},serviceRequest:async({operation,params={}})=>{
    window.__calls.push({operation,params});
    if(operation==='ui.preferences.get')return prefs;
    if(operation==='ui.preferences.save'){prefs={...prefs,...params.patch};return prefs;}
    if(operation==='sources.list')return {sources:[source]};
    if(operation==='sources.catalog')return {entries:[source]};
    if(operation==='library.categories')return {categories:[]};
    if(operation==='library.stats')return {};
    if(operation==='library.favourites')return {entries:window.__libraryBooks?books.map(book=>({...book,coverUrl:book.coverUrl+'&round=library',...(book.largeCoverUrl?{largeCoverUrl:book.largeCoverUrl+'&round=library'}:{})})):[]};
    if(operation==='content.popular')return {entries:books};
    if(operation==='library.updates')return {entries:[{mangaId:'two',sourceId:source.id,newChapters:2}]};
    if(operation==='library.readMarks')return {read:[],unread:[]};
    if(operation==='library.mangaPrefs')return {present:false};
    if(operation==='downloads.snapshot')return {entries:[{id:'offline',mangaId:'one',mangaUrl:'/one',sourceId:source.id,status:'COMPLETED',offline:true}],settings:{},queuePaused:false};
    if(operation==='tracking.capabilities')return {trackers:[]};
    if(operation==='content.details')return {manga:books[0],chapters:[]};
    if(operation==='content.pages')return {pages:[1,2,3].map(i=>({url:location.origin+'/page-'+i+'.png'}))};
    return {entries:[]};
  }};
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const requests=new Map();
await page.route('**/helper-image?*',async route=>{
  const name=new URL(new URL(route.request().url()).searchParams.get('u')).pathname.slice(1);
  const count=(requests.get(name)||0)+1;requests.set(name,count);
  if(name==='missing'||name==='alternate'||count===1&&name!=='stable')return route.fulfill({status:502,body:'Temporary image failure'});
  // Keep the fallback visible while the next request is in flight.
  await new Promise(resolve=>setTimeout(resolve,300));
  return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/#/explore?source=data%3ATEST`);
  await page.locator('.cover-fallback').first().waitFor();
  await page.waitForFunction(()=>['transient','alternate','stable'].every(title=>document.querySelector(`img[alt="${title}"]`)?.naturalWidth>0),null,{timeout:7000});
  assert.equal(requests.get('transient'),2);assert.equal(requests.get('alternate'),1);assert.equal(requests.get('large'),2);assert.equal(requests.get('stable'),1);
  await page.waitForTimeout(13000);
  assert.equal(requests.get('missing'),4,'permanent failure has three bounded retries');
  assert.equal(await page.locator('.cover-fallback').count(),1);
  // A discarded route must not retain retry jobs or resurrect its images.
  await page.reload();await page.locator('.cover-fallback').waitFor();
  await page.evaluate(()=>{document.getElementById('view').replaceChildren();});
  const before=requests.get('missing');await page.waitForTimeout(1600);assert.equal(requests.get('missing'),before);
  // Library cards use the same recovery path after native hydration.
  requests.clear();
  await page.evaluate(async()=>{window.__libraryBooks=true;await NYORA_SERVICES.library.hydrate();location.hash='/library';});
  await page.waitForFunction(()=>['transient','alternate','stable'].every(title=>document.querySelector(`img[alt="${title}"]`)?.naturalWidth>0),null,{timeout:7000});
  assert.equal(requests.get('transient'),2);assert.equal(requests.get('large'),2);
  assert.deepEqual(errors,[]);
  console.log('PASS: transient thumbnail recovery, alternate cover recovery, bounded failures route cancellation and library recovery');
}finally{await browser.close();await new Promise(r=>server.close(r));}
