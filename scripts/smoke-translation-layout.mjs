// Recorded OCR/MT; real pixels, worker geometry, and Electron text metrics.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,mkdtemp,cp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {resolve,join,dirname} from 'node:path';
import {chromium} from 'playwright';
import {runtimeFixture} from '../tests/runtime-fixture.mjs';
import {eventually} from '../tests/cdp.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=join(project,'test-results/translation-comparison');
const output=join(project,'test-results/translation-layout');
const sample=JSON.parse(await readFile(join(input,'nyora.json'),'utf8')).runs.find(r=>r.name==='warm');
const fixture=await runtimeFixture(project);
const profile=await mkdtemp(join(tmpdir(),'nyora-translation-smoke-'));
const assets=join(fixture.app,'dist');
let child,browser;
await mkdir(output,{recursive:true});
try {
  await cp(join(input,'original.jpg'),join(assets,'sample.jpg'));
  await cp(join(project,'frontend/translation/overlay.js'),join(assets,'layout-overlay.js'));
  await cp(join(project,'frontend/translation/bubble-layout.js'),join(assets,'bubble-layout.js'));
  await cp(join(project,'vendor/web/web/core/translate/overlay.js'),join(assets,'baseline-overlay.js'));
  await writeFile(join(assets,'layout-worker.js'),`import {addBubbleLayouts} from './bubble-layout.js';onmessage=async({data:{bitmap,blocks}})=>{const start=performance.now();const c=new OffscreenCanvas(bitmap.width,bitmap.height);const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();postMessage({blocks:addBubbleLayouts(ctx,blocks,c.width,c.height),geometryMs:performance.now()-start});};`);
  await writeFile(join(assets,'layout-check.js'),`import {attachOverlay} from './layout-overlay.js';import {attachOverlay as baseline} from './baseline-overlay.js';window.layoutCheck={attachOverlay,baseline};`);
  await writeFile(join(assets,'index.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>html,body{display:block!important;height:auto!important;overflow:auto!important;margin:0!important;padding:0!important;background:white!important}.reader-slide{position:relative!important;display:block!important;width:770px;flex:none!important}.reader-slide img{display:block!important;width:100%!important;height:auto!important;max-width:none!important;max-height:none!important}</style><div class="reader-slide"><img src="/sample.jpg"></div><script type="module" src="/layout-check.js"></script>`);
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  child=spawn(createRequire(import.meta.url)('electron'),[fixture.app,'--nyora-smoke'],{cwd:tmpdir(),env:{...process.env,NYORA_SMOKE_PROFILE:profile,NYORA_SMOKE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  await eventually(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},{timeout:30000});
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=await eventually(()=>browser.contexts()[0].pages().find(p=>p.url().includes('/index.html')));
  page.on('pageerror', e=>console.error('Electron page:',e.message));
  await page.waitForFunction(()=>window.layoutCheck&&document.querySelector('img').naturalWidth);
  await page.setViewportSize({width:790,height:1100});
  const report={date:new Date().toISOString(),runtime:'Electron',method:'Recorded Japanese OCR and English MT; live pixels, worker geometry, browser lettering',extraModelBytes:0,sizes:[]};
  await page.evaluate(s=>{window.sample=s;window.img=document.querySelector('img');window.handle=layoutCheck.baseline(img);handle.setBlocks(s.blocks,s.texts);},sample);
  report.baseline=await page.locator('.tl-block').evaluateAll(ds=>ds.map(d=>({text:d.textContent,font:parseFloat(d.style.fontSize)})));
  await page.screenshot({path:join(output,'before.png'),fullPage:true});
  const result=await page.evaluate(async()=>{
    const bitmap=await createImageBitmap(img);const worker=new Worker('/layout-worker.js',{type:'module'});
    const result=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;worker.postMessage({bitmap,blocks:sample.blocks},[bitmap]);});worker.terminate();
    window.enhanced=result.blocks;handle.destroy();handle=layoutCheck.attachOverlay(img);handle.setBlocks(enhanced,sample.texts);return result;
  });
  report.blocks=result.blocks;report.geometryMs=result.geometryMs;report.expandedCandidates=result.blocks.filter(b=>b.layoutBoxes?.length).length;
  for(const width of [770,500,1000]) {
    await page.evaluate(w=>{document.querySelector('.reader-slide').style.width=w+'px';},width);
    await page.waitForFunction(w=>document.querySelector('.tl-overlay').clientWidth===w,width);
    const data=await page.locator('.tl-block').evaluateAll(ds=>ds.map(d=>({text:d.textContent,font:parseFloat(d.style.fontSize),overflow:d.scrollHeight>d.clientHeight+1||d.scrollWidth>d.clientWidth+1,left:d.style.left,width:d.style.width})));
    assert.deepEqual(data.map(d=>d.text),sample.texts);assert.ok(data.every(d=>!d.overflow),'lettering must remain inside its box');
    report.sizes.push({width,blocks:data});
    if(width===770) {assert.ok(data[1].font>report.baseline[1].font*1.3);assert.ok(data[2].font>report.baseline[2].font*1.3);await page.screenshot({path:join(output,'after.png'),fullPage:true});}
  }
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(output,'electron.log'),logs);
  console.log(JSON.stringify(report,null,2));
} catch(error) { console.error(error); throw error; } finally {
  await browser?.close().catch(()=>{});
  if(child&&child.exitCode===null) {child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,3000))]);}
  await fixture.cleanup();await rm(profile,{recursive:true,force:true,maxRetries:3});
}
