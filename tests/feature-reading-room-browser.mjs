import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

// Run from the full desktop fixture; real UI, fonts and styles, synthetic data.
export async function checkReadingRoom(page,base) {
  const original=page.viewportSize();
  const evidence=resolve('test-results/reading-room');
  await mkdir(evidence,{recursive:true});
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base+'/#/library');
    await page.locator('.library-welcome').waitFor();
    for(const [width,height] of [[1440,900],[860,600]]) {
      await page.setViewportSize({width,height});
      const settings=await page.locator('#sidebar [data-route="settings"]').boundingBox();
      assert(settings && settings.y>=0 && settings.y+settings.height<=height,'Settings stays in the viewport');
      for(const label of ['Browse sources','Import comics']) {
        const box=await page.getByRole('button',{name:label,exact:true}).boundingBox();
        assert(box && box.y>=0 && box.y+box.height<=height, label+' fits the empty Library');
      }
      assert.equal(await page.locator('.desktop-main-nav [data-route]').count(),6);
      assert.equal(await page.locator('.desktop-community-links').isVisible(),false);
      assert.equal(await page.locator('.library-tools').isVisible(),false);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:resolve(evidence,'library-empty-'+width+'.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(async()=>{
      window.__featureSources = [
        {id:'data:ATSUMOE',name:'Synthetic',lang:'en',isInstalled:true},
        {id:'data:OTHER',name:'Other Synthetic',lang:'en',isInstalled:true},
        ...Array.from({length:40},(_,i)=>({id:'data:SCROLL'+i,name:'Scroll source '+i,lang:i%2?'ja':'en',isInstalled:true})),
      ];
      await NYORA_SERVICES.library.hydrate();
    });
    await page.goto(base+'/#/explore');
    const search=page.getByRole('searchbox',{name:'Search sources',exact:true});
    await search.waitFor();
    const sourceList=page.locator('.reading-room-sources > .explore-sources-body');
    for(const [width,height] of [[1440,900],[860,600]]) {
      await page.setViewportSize({width,height});
      const controls=page.locator('.reading-room-sources > :not(.explore-sources-body)');
      const positions=await controls.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().y));
      await sourceList.hover();
      await page.mouse.wheel(0,700);
      await page.waitForFunction(()=>document.querySelector('.reading-room-sources > .explore-sources-body').scrollTop>0);
      assert.deepEqual(await controls.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().y)),positions,'Sources heading, filters and count stay pinned while results scroll');
      assert.equal(await page.locator('#view').evaluate(node=>node.scrollTop),0);
      await page.screenshot({path:resolve(evidence,'sources-scrolled-'+width+'.png'),animations:'disabled'});
      await sourceList.evaluate(node=>{node.scrollTop=0;});
    }
    await page.setViewportSize({width:1440,height:900});
    const contentCalls=()=>page.evaluate(()=>window.__desktopCalls.filter(x=>x.args?.operation?.startsWith('content.')).length);
    const before=await contentCalls();
    await search.fill('not-a-source');
    await page.getByText('No sources match these filters. Try another name or language.',{exact:true}).waitFor();
    await search.fill('Synthetic');
    assert(await page.locator('.reading-room-sources .source-tile').count()>0);
    assert.equal(await contentCalls(),before,'source filtering must not fetch source content');
    await page.screenshot({path:resolve(evidence,'sources.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Source catalog',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search source catalog',exact:true}).waitFor();
    await page.locator('.ext-row').first().waitFor();
    for(const [width,height] of [[1280,800],[860,600],[390,844]]) {
      await page.setViewportSize({width,height});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Catalog fits the viewport');
      assert(await page.locator('.ext-row .name').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)),'Source names wrap without truncation');
      assert(await page.locator('.ext-row').evaluateAll(rows=>rows.every(row=>{
        const bounds=row.getBoundingClientRect();
        return [...row.children].every(child=>child.getBoundingClientRect().bottom<=bounds.bottom+1);
      })),'Catalog actions stay inside their rows without overlapping the next source');
      const dialog=await page.locator('.modal:has(.ext-sheet)').boundingBox();
      assert(dialog.x>=0 && dialog.x+dialog.width<=width && dialog.y>=0 && dialog.y+dialog.height<=height,'Catalog remains inside the window');
      await page.screenshot({path:resolve(evidence,'catalog-polished-'+width+'.png'),animations:'disabled'});
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(async()=>{delete window.__featureSources;await NYORA_SERVICES.library.hydrate();});
    await page.goto(base+'/#/settings?s=appearance');
    await page.locator('.reading-appearance-preview').waitFor();
    assert(await page.evaluate(async()=>{
      const faces=await document.fonts.load('600 28px "Nyora Poppins"');
      return faces.some(face=>face.family==='Nyora Poppins' && face.status==='loaded');
    }),'bundled display font loads without Google Fonts');
    await page.screenshot({path:resolve(evidence,'settings-dark.png'),animations:'disabled'});
    const categories = page.locator('.reading-settings-categories');
    const detail = page.locator('.reading-settings-detail');
    for (const [width,height] of [[1440,900],[1024,600]]) {
      await page.setViewportSize({width,height});
      await detail.evaluate(node => { node.scrollTop = 0; });
      const before = await categories.boundingBox();
      await detail.hover();
      await page.mouse.wheel(0,650);
      await page.waitForFunction(() => document.querySelector('.reading-settings-detail').scrollTop > 0);
      const after = await categories.boundingBox();
      assert(Math.abs(before.y-after.y)<1,'Settings categories stay pinned while preferences scroll');
      assert.equal(await page.locator('#view').evaluate(node=>node.scrollTop),0,'Settings page heading stays pinned');
      assert(after.y+after.height<=height,'All categories fit or scroll within their own column');
      await page.screenshot({path:resolve(evidence,'settings-scrolled-'+width+'.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:1440,height:900});
    await detail.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button',{name:'Light',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='LIGHT');
    await page.screenshot({path:resolve(evidence,'settings-light.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='DARK');
    await page.getByRole('button',{name:'Pure black',exact:true}).click();
    await page.waitForFunction(()=>!document.documentElement.classList.contains('soft-dark'));
    await page.goto(base+'/#/explore');
    assert(await page.locator('.source-tile').first().evaluate(node=>getComputedStyle(node).backgroundColor!==getComputedStyle(document.body).backgroundColor),'Pure black panels remain distinct from the canvas');
    await page.screenshot({path:resolve(evidence,'sources-pure-black.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Source catalog',exact:true}).click();
    await page.locator('.ext-row').first().waitFor();
    await page.screenshot({path:resolve(evidence,'catalog-pure-black.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await page.goto(base+'/#/settings?s=appearance');
    await page.getByRole('button',{name:'Soft',exact:true}).click();
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    if(original)await page.setViewportSize(original);
    await page.goto(base+'/#/library');
  }
}
