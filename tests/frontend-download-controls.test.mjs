import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDownloads} from '../frontend/native-downloads.js';

test('download controls keep last confirmed pause state on rejection and refresh successful mutations',async()=>{
  let saved={entries:[],settings:{format:'CBZ'},queuePaused:false},reject=false;
  const request=async(operation)=>{
    if(operation==='downloads.snapshot')return structuredClone(saved);
    if(reject)throw new Error('Disk full');
    if(operation==='downloads.pause')saved.queuePaused=true;
    else if(operation==='downloads.resume')saved.queuePaused=false;
    else throw new Error('Unexpected operation');
    return {queuePaused:saved.queuePaused};
  };
  const downloads=createNativeDownloads(request);await downloads.hydrate();assert.equal(downloads.queuePaused(),false);
  reject=true;await assert.rejects(downloads.pause(),/Disk full/);assert.equal(downloads.queuePaused(),false);
  reject=false;await downloads.pause();assert.equal(downloads.queuePaused(),true);await downloads.resume();assert.equal(downloads.queuePaused(),false);
});
test('batch retry reports verification wait separately and publishes only refreshed queued jobs',async()=>{
  let saved={entries:[{id:'ordinary',status:'FAILED',errorCode:'DOWNLOAD_FAILED'},{id:'cf',status:'FAILED',errorCode:'SOURCE_VERIFICATION_REQUIRED'},{id:'cancelled',status:'CANCELLED'}],settings:{format:'CBZ'},queuePaused:true};
  const downloads=createNativeDownloads(async(operation)=>{
    if(operation==='downloads.snapshot')return structuredClone(saved);
    assert.equal(operation,'downloads.retryFailed');saved.entries[0].status='QUEUED';return {requeued:1,verificationRequired:1};
  });await downloads.hydrate();assert.deepEqual(await downloads.retryFailed(),{requeued:1,verificationRequired:1});
  assert.equal(downloads.queuePaused(),true);assert.deepEqual(downloads.list().map(job=>job.status),['QUEUED','FAILED','CANCELLED']);
});

test('native export receipts report saved or cancelled without inventing success',async()=>{
  let receipt={exported:true};
  const downloads=createNativeDownloads(async(operation)=>{assert(['downloads.export','downloads.exportBundle'].includes(operation));return receipt;});
  assert.deepEqual(await downloads.saveToDevice('exact-id'),{ok:true,status:'saved',count:1});
  assert.deepEqual(await downloads.saveBundle(['one','two']),{ok:true,status:'saved',count:2});
  receipt={cancelled:true};assert.deepEqual(await downloads.saveToDevice('exact-id'),{ok:false,status:'cancelled',count:0});
  receipt={};await assert.rejects(downloads.saveToDevice('exact-id'),/Export result could not be confirmed/);
});
