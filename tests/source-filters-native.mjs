import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {eventually} from './cdp.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
const root=resolve('.'),fixture=await runtimeFixture(root,{bundledHelper:true}),profile=await mkdtemp(join(tmpdir(),'nyora-filter-probe-')),port=61250;
const child=spawn(createRequire(import.meta.url)('electron'),[fixture.app,'--nyora-smoke'],{env:{...process.env,NYORA_SMOKE_PROFILE:profile,NYORA_SMOKE_PORT:String(port)},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
let browser;
try {
 await eventually(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},{timeout:30000});
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 const page=await eventually(()=>browser.contexts()[0].pages().find(p=>p.url().includes('/index.html')));
 await page.waitForFunction(()=>globalThis.NYORA_SERVICES?.library.cacheStatus().hydrated,{},{timeout:40000});
 const results=[];
 for(const id of ['data:mangadex','data:weebcentral','data:asurascans']) {
  const result=await page.evaluate(async id=>{try{const options=await nyoraDesktop.serviceRequest({operation:'sources.filters',params:{id}});return {id,tags:options.tags?.length,filters:options.filters,searchWithFilters:options.searchWithFilters};}catch(e){return{id,error:e.message};}},id);
  console.log(JSON.stringify(result));results.push(result);
 }
 const available=results.find(r=>r.tags&&r.filters?.some(f=>f.name==='Sort'));
 if(!available)throw new Error('No live source supplied filters');
 await page.evaluate(id=>{location.hash='/explore?source='+encodeURIComponent(id);},available.id);
 await page.getByRole('button',{name:/^Filter & sort/}).click();
 const dialog=page.getByRole('dialog',{name:'Filter & sort'});
 await dialog.getByLabel('Sort by',{exact:true}).waitFor({timeout:60000});
 await dialog.getByLabel('Sort by',{exact:true}).selectOption('ALPHABETICAL');
 await dialog.getByRole('group',{name:'Publication status',exact:true}).getByRole('button',{name:'Completed',exact:true}).click();
 await dialog.getByLabel('Chapter language').fill('en');
 await dialog.getByLabel('Find a genre').fill('Adventure');
 await dialog.getByRole('button',{name:'Include Adventure',exact:true}).click();
 await mkdir('test-results/source-filters',{recursive:true});
 await page.screenshot({path:'test-results/source-filters/electron-live.png'});
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.browse-filter-summary')&&document.querySelectorAll('.card-open').length>0,{},{timeout:60000});
 console.log('LIVE FILTERED TITLES',await page.locator('.card-open').allTextContents());
 await writeFile('test-results/source-filters/native-results.json',JSON.stringify(results,null,2));
 console.log('PASS: bundled helper options and live sorted results in Electron');
}finally{
 await writeFile('/tmp/nyora-filter-native.log',logs);
 await browser?.close();child.kill('SIGTERM');await new Promise(done=>{if(child.exitCode!==null)return done();child.once('exit',done);setTimeout(()=>{child.kill('SIGKILL');done();},5000);});
 await fixture.cleanup();await rm(profile,{recursive:true,force:true});
}
