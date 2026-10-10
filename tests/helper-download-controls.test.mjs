import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopFeatures} from '../electron/features.cjs';
import {DesktopServices} from '../electron/services.cjs';
const contract=JSON.parse(await readFile(new URL('../frontend/service-contract.json',import.meta.url),'utf8'));

test('named download controls hold durable queue work and reject extra renderer authority',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'nyora-download-controls-'));
  let starts=0;const changes=[];
  const features=new DesktopFeatures({profile,helper:{},encryption:{},dialogs:{},window:()=>null,localServer:{localMediaUrl:(id,index)=>`http://127.0.0.1:1234/local-media/${id}/${index}`},
    fetchPages:async()=>{starts++;throw new Error('Offline');},fetchImage:async()=>{throw new Error('No image request');},onDownloadsChanged:value=>changes.push(value)});
  await features.init();t.after(async()=>{await features.close();await rm(profile,{recursive:true,force:true});});
  const services=new DesktopServices({contract,nativeRequest:(operation,params)=>features.request(operation,params)});
  const request=(operation,params={})=>services.request({operation,params});
  await request('downloads.pause');
  await request('downloads.enqueue',{descriptors:[{sourceId:'data:fixture',mangaUrl:'/title',chapterUrl:'/chapter',mangaTitle:'Title',chapterTitle:'Chapter'}]});
  assert.equal(starts,0);const snapshot=await request('downloads.snapshot');assert.equal(snapshot.queuePaused,true);assert.equal(snapshot.entries[0].status,'QUEUED');
  assert.equal(changes.at(-1).queuePaused,true);
  for(const operation of ['downloads.pause','downloads.resume','downloads.retryFailed']) await assert.rejects(request(operation,{url:'https://forged.invalid/'}),/Unexpected/);
  await request('downloads.resume');
  for(let i=0;i<100&&(await request('downloads.snapshot')).entries[0].status!=='FAILED';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await request('downloads.snapshot')).entries[0].status,'FAILED');
  await request('downloads.pause');assert.deepEqual(await request('downloads.retryFailed'),{requeued:1,verificationRequired:0});assert.equal(starts,1);
});
