import assert from 'node:assert/strict';

export async function checkDownloadControls(page,base) {
  await page.evaluate(()=>{
    window.__queuePaused=false;
    window.__featureJobs=[
      {id:'feature-running',status:'RUNNING',mangaTitle:'Active chapter',chapterTitle:'Chapter 1',totalPages:4,completedPages:1,bytes:1024},
      {id:'feature-ordinary',status:'FAILED',mangaTitle:'Network failed',chapterTitle:'Chapter 2',errorCode:'DOWNLOAD_FAILED',error:'Chapter could not be downloaded'},
      {id:'feature-cf',status:'FAILED',mangaTitle:'Verification waiting',chapterTitle:'Chapter 3',errorCode:'SOURCE_VERIFICATION_REQUIRED',error:'Source verification is required'},
      {id:'feature-cancelled',status:'CANCELLED',mangaTitle:'Cancelled chapter',chapterTitle:'Chapter 4'}];
    location.hash='/downloads';
  });
  await page.waitForURL(url=>url.hash==='#/downloads');
  await page.evaluate(()=>window.NYORA_SERVICES.downloads.hydrate());
  const pause=page.getByRole('button',{name:'Pause queue',exact:true});await pause.waitFor({state:'visible'});
  await pause.click();await page.getByRole('button',{name:'Resume queue',exact:true}).waitFor({state:'visible'});
  assert.ok((await page.locator('.download-queue-guidance').innerText()).includes('Current chapters finish'));
  await page.getByRole('button',{name:'Retry failed (1)',exact:true}).click();
  await page.waitForFunction(()=>window.__featureJobs.find(job=>job.id==='feature-ordinary').status==='QUEUED');
  const state=await page.evaluate(()=>({paused:window.__queuePaused,statuses:window.__featureJobs.map(job=>job.status)}));
  assert.deepEqual(state,{paused:true,statuses:['RUNNING','QUEUED','FAILED','CANCELLED']});
  assert.equal(await page.getByRole('heading',{name:'Completed (2)',exact:true}).count(),0);
  assert.equal(await page.locator('[data-download-id="feature-ordinary"] .progress.indeterminate').count(),0,'paused queued chapters have no activity animation');
  const cancel=page.locator('[data-download-id="feature-running"]').getByRole('button',{name:'Cancel',exact:true});
  await cancel.focus();await page.evaluate(()=>window.NYORA_SERVICES.downloads.hydrate());
  assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'snapshot polling preserves focused row control');
  await page.evaluate(()=>{window.__rejectDownloadMutation=true;});
  await page.getByRole('button',{name:'Resume queue',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-download-queue-action="pause"]')?.disabled===false);
  assert.equal(await page.evaluate(()=>window.__queuePaused),true,'rejected resume retains confirmed pause');
  assert.equal(await page.getByRole('button',{name:'Resume queue',exact:true}).count(),1);
  await page.evaluate(()=>{window.__rejectDownloadMutation=false;});
  await page.getByRole('button',{name:'Resume queue',exact:true}).click();await pause.waitFor({state:'visible'});
  await page.evaluate(()=>{delete window.__featureJobs;delete window.__queuePaused;delete window.__rejectDownloadMutation;});
  await page.evaluate(()=>window.NYORA_SERVICES.downloads.hydrate());
}
