import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// Exercises real browser text metrics, resize observers, and overlay lifecycle.
test('whole-word bubble layout improves narrow text without moving its eraser or shrinking other text',async()=>{
  const overlay=await readFile(new URL('../frontend/translation/overlay.js',import.meta.url),'utf8').catch(()=>readFile(new URL('../vendor/web/web/core/translate/overlay.js',import.meta.url),'utf8'));
  const css=await readFile(new URL('../vendor/web/web/styles.css',import.meta.url),'utf8');
  const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/overlay.js'?'text/javascript':req.url==='/styles.css'?'text/css':'text/html');res.end(req.url==='/overlay.js'?overlay:req.url==='/styles.css'?css:`<link rel="stylesheet" href="/styles.css"><style>body{display:block!important}.reader-slide{position:relative;width:400px;display:block!important}.reader-slide img{width:100%;display:block}</style><div class="reader-slide"><img id="image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3C/svg%3E"></div><script type="module">import {attachOverlay} from '/overlay.js';window.attachOverlay=attachOverlay;</script>`);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await chromium.launch();const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.attachOverlay&&document.querySelector('img').naturalWidth===400);
    const result=await page.evaluate(()=>{
      const img=document.querySelector('img');window.handle=attachOverlay(img);
      window.blocks=[{x:130,y:90,w:35,h:155,bg:'rgb(255,255,255)'},{x:240,y:90,w:100,h:150,bg:'rgb(255,255,255)'}];window.texts=['What about School☆Idol?','Rob a bank'];
      handle.setBlocks(blocks,texts);const baseline=[...document.querySelectorAll('.tl-block')].map(d=>parseFloat(d.style.fontSize));
      blocks[0].layoutBoxes=[{x:96,y:76,w:108,h:188}];blocks[1].layoutBoxes=[{x:260,y:120,w:25,h:35}];
      handle.setBlocks(blocks,texts);
      const rendered=[...document.querySelectorAll('.tl-block')];
      return {baseline,fonts:rendered.map(d=>parseFloat(d.style.fontSize)),text:rendered.map(d=>d.textContent),mask:[...document.querySelectorAll('.tl-erase')].map(d=>({left:d.style.left,width:d.style.width})),hyphens:rendered.map(d=>getComputedStyle(d).hyphens)};
    });
    assert.ok(result.fonts[0]>result.baseline[0]*1.5,'expanded bubble must materially improve lettering');
    assert.ok(result.fonts[1]>=result.baseline[1],'poor candidates must not shrink text');
    assert.deepEqual(result.text,['What about School☆Idol?','Rob a bank']);
    assert.equal(result.mask[0].left,'32.5%');assert.equal(result.mask[0].width,'8.75%');
    assert.deepEqual(result.hyphens,['none','none']);
    const scrollRefits=await page.evaluate(async()=>{
      let changes=0;const observer=new MutationObserver(records=>{changes+=records.filter(r=>r.target.classList.contains('tl-block')).length;});
      observer.observe(document.querySelector('.tl-overlay'),{subtree:true,attributes:true,attributeFilter:['style']});
      window.dispatchEvent(new Event('scroll'));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));observer.disconnect();return changes;
    });
    assert.equal(scrollRefits,0,'scrolling must not repeatedly measure every font candidate');
    await page.evaluate(()=>{document.querySelector('.reader-slide').style.width='280px';});
    await page.waitForFunction(()=>document.querySelector('.tl-overlay').clientWidth===280);
    assert.ok(await page.evaluate(()=>[...document.querySelectorAll('.tl-block')].every(d=>d.scrollWidth<=d.clientWidth+1&&d.scrollHeight<=d.clientHeight+1)));
    const lifecycle=await page.evaluate(()=>{handle.setBlocks(blocks,null,{stage:'translate'});const pending=document.querySelectorAll('.tl-progress').length;handle.setBlocks(blocks,texts);const done=document.querySelectorAll('.tl-progress').length;handle.destroy();const removed=document.querySelectorAll('.tl-overlay').length;handle=attachOverlay(document.querySelector('img'));handle.setBlocks(blocks,texts);return {pending,done,removed,count:document.querySelectorAll('.tl-overlay').length};});
    assert.deepEqual(lifecycle,{pending:1,done:0,removed:0,count:1});
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
