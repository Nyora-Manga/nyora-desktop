import {browserOptions} from '../scripts/browser-options.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFrontendServer } from '../scripts/dev-server.mjs';
import { resolve } from 'node:path';
const server=await createFrontendServer(resolve('dist'),{port:0});
const browser=await chromium.launch({headless:true,...(await browserOptions())});
const context=await browser.newContext({viewport:{width:1380,height:940}});
await context.addInitScript(()=>{
 window.__calls=[];let prefs={onboarded:true,appearance:'DARK',darkStyle:'SOFT'};
 const sources=[{id:'data:ATSUMOE',name:'Filter fixture',lang:'en',isInstalled:true,isPinned:true},{id:'data:OTHER',name:'Other source',lang:'en',isInstalled:true}];
 window.nyoraDesktop={runtimeStatus:()=>({runtime:'electron',dataMode:'native-helper',appVersion:'0.2.3'}),verificationStatus:()=>[],onNavigate:()=>()=>{},
 serviceRequest:async({operation,params={}})=>{
  window.__calls.push({operation,params});
  if(operation==='ui.preferences.get')return prefs;
  if(operation==='ui.preferences.save'){prefs={...prefs,...params.patch};return prefs;}
  if(operation==='sources.list')return {sources};
  if(operation==='sources.catalog')return {entries:sources};
  if(operation==='library.categories')return {categories:[]};
  if(operation==='library.stats')return {};
  if(operation==='downloads.snapshot')return {entries:[],settings:{},queuePaused:false};
  if(operation==='tracking.capabilities')return {trackers:[]};
  if(operation==='sources.filters')return {multipleTags:true,tagsExclusion:true,searchWithFilters:params.id!=='data:OTHER',tags:[{key:'uuid-adventure',title:'Adventure'},{key:'uuid-drama',title:'Drama'},...Array.from({length:30},(_,i)=>({key:'tag'+i,title:'Genre '+i}))],filters:[{name:'Sort',typeName:'text',values:['UPDATED','ALPHABETICAL','ALPHABETICAL_DESC']},{name:'State',typeName:'text',multiple:true,values:['ONGOING','FINISHED']},{name:'Rating',typeName:'text',values:['SAFE','ADULT']},{name:'Year',typeName:'text',values:[]},{name:'Locale',typeName:'text',values:[]}]};
  if(['content.popular','content.latest','content.search'].includes(operation)) {
   if(window.__emptyResults)return {entries:[],hasNextPage:false};
   return {entries:[{id:'book-'+params.page,title:'Result page '+params.page,url:'/manga/'+params.page,source:{id:params.id},coverUrl:''}],hasNextPage:params.page<3};
  }
  return {entries:[]};
 }};
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const dialog=page.getByRole('dialog',{name:'Filter & sort'});
async function open(){await page.getByRole('button',{name:/^Filter & sort/}).click();await dialog.getByLabel('Sort by',{exact:true}).waitFor({timeout:5000}).catch(async e=>{console.log('DIALOG',await dialog.innerText(),'ERRORS',errors,'CALLS',await page.evaluate(()=>window.__calls.slice(-6)));throw e;});}
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/#/explore?source=data%3AATSUMOE`);
 await page.getByRole('button',{name:/^Filter & sort/}).waitFor();await open();
 await dialog.getByLabel('Sort by',{exact:true}).selectOption('ALPHABETICAL_DESC');
 await dialog.getByRole('group',{name:'Publication status',exact:true}).getByRole('button',{name:'Completed',exact:true}).click();
 await dialog.getByRole('button',{name:'Include Adventure',exact:true}).click();
 await dialog.getByRole('button',{name:'Exclude Drama',exact:true}).click();
 await dialog.getByLabel('Chapter language').fill('en');
 await dialog.locator('summary').click();await dialog.getByRole('textbox',{name:'Preset name'}).fill('Completed adventures');
 await dialog.getByRole('button',{name:'Save preset',exact:true}).click();
 await page.waitForFunction(()=>NYORA_SERVICES.library.uiPreferences().sourceFilterPresets?.length===1);
 await dialog.getByLabel('Find a genre').fill('Adventure');
 assert.equal(await dialog.locator('.source-filter-genre:visible').count(),1);
 await mkdir('test-results/source-filters',{recursive:true});await page.screenshot({path:'test-results/source-filters/panel-dark.png'});
 await dialog.locator('summary').click();
 await dialog.getByRole('textbox',{name:'Rename preset Completed adventures',exact:true}).fill('Adventure shelf');
 await dialog.getByRole('button',{name:'Rename',exact:true}).click();
 await page.waitForFunction(()=>NYORA_SERVICES.library.uiPreferences().sourceFilterPresets?.[0].name==='Adventure shelf');
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();
 await page.waitForFunction(()=>window.__calls.some(c=>c.operation==='content.search'));
 const first=await page.evaluate(()=>window.__calls.filter(c=>c.operation==='content.search').at(-1));
 const f=JSON.parse(first.params.f);assert(f.some(x=>x.name==='Sort'&&x.value==='ALPHABETICAL_DESC'));assert(f.some(x=>x.name==='Tags'&&x.value==='uuid-adventure'));assert(f.some(x=>x.name==='Excluded tags'&&x.value==='uuid-drama'));assert.equal(first.params.page,1);
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await page.waitForFunction(()=>window.__calls.filter(c=>c.operation==='content.search').at(-1)?.params.page===2);
 const second=await page.evaluate(()=>window.__calls.filter(c=>c.operation==='content.search').at(-1));assert.equal(second.params.f,first.params.f);
 await page.locator('#sidebar [data-route="library"]').click();await page.locator('.library-favourites').waitFor();await page.goBack();
 await page.locator('.browse-filter-summary').waitFor();assert.equal(await page.locator('.card-open').count(),2);
 await open();await dialog.getByRole('button',{name:'Reset',exact:true}).click();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 assert((await page.locator('.browse-filter-summary').innerText()).includes('Completed'));
 await open();await dialog.getByRole('button',{name:'Reset',exact:true}).click();await dialog.getByRole('button',{name:'Apply',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.browse-filter-summary'));
 await open();await dialog.locator('summary').click();await dialog.getByLabel('Saved filter presets').selectOption('0');
 assert.equal(await dialog.getByLabel('Sort by',{exact:true}).inputValue(),'ALPHABETICAL_DESC');
 assert.equal(await dialog.getByRole('button',{name:'Include Adventure',exact:true}).getAttribute('aria-pressed'),'true');
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();
 await page.locator('#sidebar [data-route="settings"]').click();await page.getByRole('button',{name:'Light',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='LIGHT');await page.goBack();await open();
 await page.locator('.modal-backdrop.open').waitFor();await page.screenshot({path:'test-results/source-filters/panel-light.png',animations:'disabled'});
 await page.setViewportSize({width:980,height:650});assert(await dialog.evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();await page.evaluate(()=>window.__emptyResults=true);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(300);
 assert(await page.locator('.browse-filter-summary').isVisible());
 await page.evaluate(()=>{window.__emptyResults=false;location.hash='/explore?source=data%3AOTHER';});
 await page.waitForFunction(()=>document.querySelector('.source-select .name')?.textContent==='Other source');
 assert.equal(await page.locator('.browse-filter-summary').count(),0);
 await open();await dialog.getByLabel('Title search',{exact:true}).fill('hero');await dialog.getByLabel('Sort by',{exact:true}).selectOption('ALPHABETICAL');
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();assert.match(await dialog.getByRole('alert').innerText(),/separate from filters/);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(errors,[]);
 console.log('PASS: apply, cancel, reset, source keys, pagination, presets, empty results, dark/light/narrow layout');
}finally{await browser.close();await new Promise(r=>server.close(r));}
