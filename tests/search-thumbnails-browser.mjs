import {browserOptions} from '../scripts/browser-options.mjs';
import assert from 'node:assert/strict';
import {checkDesktopSearchMotion} from './feature-commands-browser.mjs';
import {chromium} from 'playwright';
import {createFrontendServer} from '../scripts/dev-server.mjs';
import {resolve} from 'node:path';
const server=await createFrontendServer(resolve('dist'),{port:0});
const browser=await chromium.launch({headless:true,...(await browserOptions())});
const context=await browser.newContext({viewport:{width:1380,height:940}});
await context.addInitScript(()=>{
  const source={id:'data:TEST',name:'Test',lang:'en',isInstalled:true,isPinned:true};
  const media=name=>location.origin+'/helper-image?'+new URLSearchParams({sourceId:'data:TEST0',cap:'fixture',u:'https://covers.example/'+name});
  const sources=Array.from({length:8},(_,i)=>({...source,id:'data:TEST'+i,name:'Test '+i}));
  const books=['transient','stable1','stable2','stable3','stable4','stable5'].map(id=>({id,title:id,url:'/manga/'+id,source:{name:'data:TEST0'},coverUrl:media(id)}));
  window.__searchPending=[];window.__searchCalls=[];
  let prefs={onboarded:true,appearance:'DARK'};
  window.__calls=[];
  window.nyoraDesktop={runtimeStatus:async()=>({runtime:'electron',dataMode:'native-helper',appVersion:'0.2.3'}),verificationStatus:()=>[],onNavigate:()=>()=>{},serviceRequest:async({operation,params={}})=>{
    window.__calls.push({operation,params});
    if(operation==='ui.preferences.get')return prefs;
    if(operation==='ui.preferences.save'){prefs={...prefs,...params.patch};return prefs;}
    if(operation==='sources.list')return {sources};
    if(operation==='sources.catalog')return {entries:sources};
    if(operation==='library.categories')return {categories:[]};
    if(operation==='library.stats')return {};
    if(operation==='library.favourites')return {entries:[]};
    if(operation==='content.search'){
      window.__searchCalls.push(params.id);
      return new Promise(resolve=>window.__searchPending.push({id:params.id,finish:()=>resolve({entries:params.id==='data:TEST0'?books:[]})}));
    }
    if(operation==='library.updates')return {entries:[]};
    if(operation==='library.readMarks')return {read:[],unread:[]};
    if(operation==='library.mangaPrefs')return {present:false};
    if(operation==='downloads.snapshot')return {entries:[],settings:{},queuePaused:false};
    if(operation==='tracking.capabilities')return {trackers:[]};
    return {entries:[]};
  }};
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const requests=new Map();let activeImages=0,overloads=0;
await page.route('**/helper-image?*',async route=>{
  const name=new URL(new URL(route.request().url()).searchParams.get('u')).pathname.slice(1);
  const count=(requests.get(name)||0)+1;requests.set(name,count);
  activeImages++;
  try {
  if(activeImages+await page.evaluate(()=>window.__searchPending.length)>8){overloads++;return await route.fulfill({status:502,body:'Native connection capacity exceeded'});}
  if(name==='transient'&&count===1)return await route.fulfill({status:502,body:'Temporary image failure'});
  // Keep the fallback visible while the next request is in flight.
  await new Promise(resolve=>setTimeout(resolve,300));
  return await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
  }finally{activeImages--;}
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/#/search?q=transient`);
  await page.waitForFunction(()=>window.__searchPending.length>=2);
  assert.equal(await page.evaluate(()=>window.__searchCalls.length),2,'background searches leave capacity for thumbnail requests');
  await page.evaluate(()=>window.__searchPending.splice(0,2).forEach(p=>p.finish()));
  await page.waitForFunction(()=>document.querySelector('img[alt="transient"]')?.naturalWidth>0);
  assert.equal(requests.get('transient'),2,'search thumbnail automatically recovers while other sources are pending');
  await page.waitForFunction(()=>[...document.querySelectorAll('.cover img')].filter(img=>img.naturalWidth>0).length===6);
  assert.equal(overloads,0,'streamed covers and source searches stay within the native request budget');
  assert.equal(requests.get('stable1'),1);
  await page.waitForFunction(()=>window.__searchPending.length===2);
  await page.evaluate(()=>{location.hash='/library';});await page.locator('.search-results').waitFor({state:'detached'});
  const calls=await page.evaluate(()=>window.__searchCalls.length);
  await page.evaluate(()=>window.__searchPending.splice(0).forEach(p=>p.finish()));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.__searchCalls.length),calls,'leaving search does not launch more source requests');
  await page.evaluate(()=>{location.hash='/search?q=transient';});
  await page.getByText(/Stopped ·/).waitFor();
  await page.waitForFunction(()=>document.querySelector('img[alt="transient"]')?.naturalWidth>0);
  assert.equal(await page.evaluate(()=>window.__searchCalls.length),calls,'return restores cached results without background replay');
  await page.evaluate(()=>{location.hash='/library';});
  await page.locator('.search-results').waitFor({state:'detached'});
  await checkDesktopSearchMotion(page);
  assert.deepEqual(errors,[]);
  console.log('PASS: search cover recovery, reserved connection capacity, route cancellation cached return and reduced-motion Search');
}finally{await browser.close();await new Promise(r=>server.close(r));}
