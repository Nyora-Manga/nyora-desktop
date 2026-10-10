import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {eventually} from './cdp.mjs';
import {runtimeFixture} from './runtime-fixture.mjs';
const root=resolve('.'),fixture=await runtimeFixture(root,{bundledHelper:true}),profile=await mkdtemp(join(tmpdir(),'nyora-thumbnail-probe-')),port=61250;
const child=spawn(createRequire(import.meta.url)('electron'),[fixture.app,'--nyora-smoke'],{env:{...process.env,NYORA_SMOKE_PROFILE:profile,NYORA_SMOKE_PORT:String(port)},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
let browser;
try {
 await eventually(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},{timeout:30000});
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 const page=await eventually(()=>browser.contexts()[0].pages().find(p=>p.url().includes('/index.html')));
 await page.waitForFunction(()=>globalThis.NYORA_SERVICES?.library.cacheStatus().hydrated,{},{timeout:40000});
 const results=[];
 for(const id of ['data:mangadex','data:weebcentral','data:asurascans']) {
  const failures=[];const response=r=>{if(r.url().includes('/helper-image')&&r.status()!==200)failures.push(r.status());};page.on('response',response);
  await page.evaluate(id=>{window.__previousBrowse=document.querySelector('.explore-browse');location.hash='/explore?source='+encodeURIComponent(id);},id);
  await page.waitForFunction(()=>!window.__previousBrowse?.isConnected);
  await page.locator('.card-open').first().waitFor({timeout:60000});
  await page.locator('.cover img').evaluateAll(images=>images.forEach(img=>{img.loading='eager';}));
  await page.waitForFunction(()=>{const covers=[...document.querySelectorAll('.cover')];return covers.length>0&&covers.every(n=>n.querySelector('img')?.naturalWidth>0);},null,{timeout:60000}).catch(async error=>{console.log(JSON.stringify({id,failures,images:await page.locator('.cover').evaluateAll(nodes=>nodes.map(n=>({fallback:!!n.querySelector('.cover-fallback'),loaded:!!n.querySelector('img')?.naturalWidth,loading:n.querySelector('img')?.loading})))}));throw error;});
  results.push({id,failures,images:await page.locator('.cover').evaluateAll(nodes=>nodes.map(n=>{const img=n.querySelector('img');return {loaded:!!img?.naturalWidth,placeholder:!!n.querySelector('.cover-fallback'),host:img?.src?new URL(new URL(img.src).searchParams.get('u')||img.src).host:undefined};}))});
  page.off('response',response);assert(results.at(-1).images.every(image=>image.loaded));console.log(`PASS ${id}: ${results.at(-1).images.length} decoded covers`);
 }
 await mkdir('test-results/thumbnails',{recursive:true});await page.screenshot({path:'test-results/thumbnails/live.png'});
 await writeFile('test-results/thumbnails/live-results.json',JSON.stringify(results,null,2));
}finally{
 await writeFile('/tmp/nyora-thumbnail-native.log',logs);
 await browser?.close();child.kill('SIGTERM');await new Promise(done=>{if(child.exitCode!==null)return done();child.once('exit',done);setTimeout(()=>{child.kill('SIGKILL');done();},5000);});
 await fixture.cleanup();await rm(profile,{recursive:true,force:true});
}
