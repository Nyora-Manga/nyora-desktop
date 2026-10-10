'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OfflineStore } = require('./offline-store.cjs');
const { NativeDownloadBroker } = require('./downloads.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const descriptor = chapterUrl => ({ sourceId: 'data:fixture', mangaId: 'portable-manga', mangaUrl: '/title', mangaTitle: 'Same', chapterUrl, chapterId: `portable-${chapterUrl}`, chapterTitle: 'Same' });
async function until(fn) { for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('Queue did not settle'); }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-download-test-'));
  const store = new OfflineStore({ root }); await store.init();
  const brokers = [];
  const create = async patch => {
    const broker = new NativeDownloadBroker({ store, fetchPages: async () => ({ pages: [{ url: 'issued-one' }, { url: 'issued-two' }] }),
      fetchImage: async () => ({ bytes: png, contentType: 'image/png' }), ...options, ...patch });
    brokers.push(broker); await broker.init(); return broker;
  };
  t.after(async () => { for (const broker of brokers) await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { store, create, root };
}
test('complete native downloads survive restart, preserve exact identity and avoid title collisions', async t => {
  const { store, create } = await fixture(t);
  const broker = await create(); await broker.configure({ retries: 0, maxConcurrent: 1 });
  assert.deepEqual(await broker.enqueue([descriptor('/chapter1'), descriptor('/chapter2')]), { added: 2, requeued: 0, skipped: 0 });
  await until(() => broker.snapshot().entries.every(job => job.status === 'COMPLETED'));
  const jobs = broker.snapshot().entries;
  assert.notEqual(jobs[0].id, jobs[1].id);
  for (const job of jobs) { assert.equal(job.mangaId, 'portable-manga'); assert.equal(job.offline, true); assert.equal(store.open(job.id).pageCount, 2); }
  await broker.close();
  const reopened = await create();
  assert.equal(reopened.snapshot().entries.length, 2);
  assert.equal(reopened.snapshot().settings.maxConcurrent, 1);
  assert.deepEqual(await reopened.enqueue([descriptor('/chapter1')]), { added: 0, requeued: 0, skipped: 1 });
  await reopened.remove(jobs[0].id); assert.equal(store.has(jobs[0].id), false);
});
test('one failed page cannot publish a partial completed archive, verification failure reaches main', async t => {
  let calls = 0, verification;
  const { store, create } = await fixture(t, { fetchImage: async () => {
    if (++calls === 2) throw Object.assign(new Error('Challenge'), { code: 'SOURCE_VERIFICATION_REQUIRED' });
    return { bytes: png, contentType: 'image/png' };
  }, onVerification: (job, error) => { verification = { sourceId: job.sourceId, code: error.code }; } });
  const broker = await create(); await broker.configure({ retries: 0, imageConcurrency: 1 });
  await broker.enqueue([descriptor('/blocked')]);
  const job = await until(() => broker.snapshot().entries.find(job => job.status === 'FAILED'));
  assert.equal(store.has(job.id), false); assert.equal(job.offline, false);
  await until(() => verification);
  assert.deepEqual(verification, { sourceId: 'data:fixture', code: 'SOURCE_VERIFICATION_REQUIRED' });
});
test('queued cancellation never starts, active cancellation aborts and interrupted jobs resume on reopen', async t => {
  const started = [], pending = Promise.withResolvers();
  const { create } = await fixture(t, { fetchPages: async desc => { started.push(desc.chapterUrl); return pending.promise; } });
  const broker = await create(); await broker.configure({ maxConcurrent: 1 });
  await broker.enqueue([descriptor('/first'), descriptor('/queued')]);
  await until(() => started.length === 1);
  const queued = broker.snapshot().entries.find(job => job.chapterUrl === '/queued'); await broker.cancel(queued.id);
  await broker.close();
  assert.deepEqual(started, ['/first']);
  const reopened = await create({ fetchPages: async desc => { started.push(desc.chapterUrl); return { pages: [{ url: 'fresh-issued' }] }; } });
  await until(() => reopened.snapshot().entries.some(job => job.status === 'COMPLETED'));
  assert.deepEqual(started, ['/first', '/first']);
  assert.equal(reopened.snapshot().entries.find(job => job.id === queued.id).status, 'CANCELLED');
});
test('failed durable enqueue/configuration publishes no new work or settings', async t => {
  let calls = 0;
  const { store, create } = await fixture(t, { fetchPages: async () => { calls++; return { pages: [{ url: 'one' }] }; } });
  const broker = await create(), write = store.writeState.bind(store);
  store.writeState = async () => { throw new Error('Disk write failed'); };
  await assert.rejects(broker.configure({ maxConcurrent: 4 }), /Disk write failed/);
  assert.equal(broker.snapshot().settings.maxConcurrent, 2);
  await assert.rejects(broker.enqueue([descriptor('/uncommitted')]), /Disk write failed/);
  assert.equal(broker.snapshot().entries.length, 0); assert.equal(calls, 0);
  store.writeState = write;
  await broker.enqueue([descriptor('/committed')]);
  await until(() => broker.snapshot().entries[0].status === 'COMPLETED'); assert.equal(calls, 1);
});
test('automatic verification resume retries only challenged jobs for the exact source', async t => {
  let solved = false;
  const { create } = await fixture(t, { fetchPages: async desc => {
    if (desc.chapterUrl === '/network') throw new Error('Offline');
    if (!solved) throw Object.assign(new Error('verification_required'), { code: 'SOURCE_VERIFICATION_REQUIRED' });
    return { pages: [{ url: 'one' }] };
  } });
  const broker = await create(); await broker.configure({ retries: 0 });
  await broker.enqueue([descriptor('/challenge'), descriptor('/network'), { ...descriptor('/other'), sourceId: 'data:other' }]);
  await until(() => broker.snapshot().entries.every(job => job.status === 'FAILED'));
  solved = true;
  assert.deepEqual(await broker.resumeVerification('data:fixture'), { requeued: 1 });
  await until(() => broker.snapshot().entries.find(job => job.chapterUrl === '/challenge').status === 'COMPLETED');
  assert.equal(broker.snapshot().entries.find(job => job.chapterUrl === '/network').status, 'FAILED');
  assert.equal(broker.snapshot().entries.find(job => job.sourceId === 'data:other').status, 'FAILED');
});
test('restart never presents a damaged downloaded book as complete or offline', async t => {
  const { store, root, create } = await fixture(t);
  const broker = await create(); await broker.enqueue([descriptor('/complete')]);
  const job = await until(() => broker.snapshot().entries.find(job => job.status === 'COMPLETED'));
  await broker.close();
  await fs.unlink(path.join(root, 'books', job.id, 'pages', '0001.png'));
  const reopenedStore = new OfflineStore({ root }); await reopenedStore.init();
  const reopened = new NativeDownloadBroker({ store: reopenedStore, fetchPages: () => { throw new Error('Do not restart damaged completed work automatically'); }, fetchImage: () => { throw new Error('No source request'); } });
  try {
    await reopened.init();
    assert.equal(reopened.snapshot().entries[0].status, 'FAILED');
    assert.equal(reopened.snapshot().entries[0].offline, false);
    assert.equal(reopenedStore.status().issues[0].id, job.id);
  } finally { await reopened.close(); }
});

test('pause finishes the running chapter, holds new work and survives restart', async t => {
  const first = Promise.withResolvers(), started = [];
  const { create } = await fixture(t, { fetchPages: async desc => { started.push(desc.chapterUrl); if(desc.chapterUrl === '/first') await first.promise; return {pages:[{url:'issued'}]}; } });
  const broker = await create(); await broker.configure({maxConcurrent:1});
  await broker.enqueue([descriptor('/first'),descriptor('/second')]); await until(()=>started.length===1);
  assert.deepEqual(await broker.pause(),{queuePaused:true}); first.resolve();
  await until(()=>broker.snapshot().entries.some(job=>job.status==='COMPLETED'));
  assert.deepEqual(started,['/first']);
  await broker.enqueue([descriptor('/third')]); await broker.close();
  const reopened = await create(); assert.equal(reopened.snapshot().queuePaused,true);
  assert.deepEqual(started,['/first']);
  assert.deepEqual(await reopened.resume(),{queuePaused:false});
  await until(()=>reopened.snapshot().entries.every(job=>job.status==='COMPLETED'));
  assert.deepEqual(started,['/first','/second','/third']);
});

test('queue pause validates persisted values while legacy queues start unpaused', async t => {
  const {store,create}=await fixture(t);
  await store.writeState('downloads.json',{schema:1,settings:{format:'CBZ',maxConcurrent:1,imageConcurrency:1,retries:0,keepOffline:true,saveToDevice:false},jobs:[]});
  const legacy=await create(); assert.equal(legacy.snapshot().queuePaused,false); await legacy.close();
  for(const value of ['true',1,null]) {
    await store.writeState('downloads.json',{schema:1,settings:legacy.snapshot().settings,jobs:[],queuePaused:value});
    await assert.rejects(create(),/metadata is damaged/);
  }
});

test('failed pause and resume commits roll back without starting held work', async t => {
  let starts=0; const {store,create}=await fixture(t,{fetchPages:async()=>{starts++;return {pages:[{url:'issued'}]};}});
  const broker=await create(), write=store.writeState.bind(store);
  store.writeState=async()=>{throw new Error('Disk write failed');};
  await assert.rejects(broker.pause(),/Disk write failed/); assert.equal(broker.snapshot().queuePaused,false);
  store.writeState=write; await broker.pause(); await broker.enqueue([descriptor('/held')]);
  store.writeState=async()=>{throw new Error('Disk write failed');};
  await assert.rejects(broker.resume(),/Disk write failed/); assert.equal(broker.snapshot().queuePaused,true); assert.equal(starts,0);
  store.writeState=write; await broker.resume(); await until(()=>broker.snapshot().entries[0].status==='COMPLETED'); assert.equal(starts,1);
});

test('failed single retry commits restore the error and cannot start uncommitted work', async t => {
  const {store,create}=await fixture(t,{fetchPages:async()=>{throw new Error('Unavailable');}});
  const broker=await create(); await broker.enqueue([descriptor('/failed')]);
  const failed=await until(()=>broker.snapshot().entries.find(job=>job.status==='FAILED')); await broker.pause();
  const write=store.writeState.bind(store); store.writeState=async()=>{throw new Error('Disk write failed');};
  await assert.rejects(broker.retry(failed.id),/Disk write failed/);
  assert.deepEqual(broker.snapshot().entries[0],failed);
  store.writeState=write;
});

test('batch retry excludes verification and cancellation, rolls back errors and stays held by pause', async t => {
  let successful=false; const started=[];
  const {store,create}=await fixture(t,{fetchPages:async desc=>{started.push(desc.chapterUrl); if(desc.chapterUrl==='/cf')throw Object.assign(new Error('verification_required'),{code:'SOURCE_VERIFICATION_REQUIRED'});if(!successful)throw new Error('Unavailable');return {pages:[{url:'issued'}]};}});
  const broker=await create(); await broker.configure({maxConcurrent:1});
  await broker.enqueue([descriptor('/ordinary'),descriptor('/cf')]); await until(()=>broker.snapshot().entries.every(job=>job.status==='FAILED'));
  await broker.pause(); await broker.enqueue([descriptor('/cancelled')]); const cancelled=broker.snapshot().entries.find(job=>job.chapterUrl==='/cancelled'); await broker.cancel(cancelled.id);
  const before=broker.snapshot(),write=store.writeState.bind(store);store.writeState=async()=>{throw new Error('Disk write failed');};
  await assert.rejects(broker.retryFailed(),/Disk write failed/);assert.deepEqual(broker.snapshot(),before);store.writeState=write;
  assert.deepEqual(await broker.retryFailed(),{requeued:1,verificationRequired:1});assert.equal(started.length,2);
  assert.equal(broker.snapshot().entries.find(job=>job.id===cancelled.id).status,'CANCELLED');
  assert.deepEqual(await broker.resumeVerification('data:fixture'),{requeued:1});assert.equal(started.length,2);
  successful=true;await broker.resume();await until(()=>broker.snapshot().entries.find(job=>job.chapterUrl==='/ordinary').status==='COMPLETED');
});

test('public snapshots wait for failed queue commits and retain confirmed pause state', async t => {
  const {store,create}=await fixture(t),broker=await create(),write=store.writeState.bind(store);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  store.writeState=async()=>{entered.resolve();await release.promise;throw new Error('Disk write failed');};
  const pause=broker.pause();await entered.promise;
  try {
    let returned=false;const snapshot=broker.committedSnapshot().then(value=>{returned=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,false);
    release.resolve();await assert.rejects(pause,/Disk write failed/);assert.equal((await snapshot).queuePaused,false);
  } finally { release.resolve();await pause.catch(()=>{});store.writeState=write; }
});

test('progress callbacks publish the captured durable snapshot rather than a prospective pause', async t => {
  const observations=[],pages=Promise.withResolvers();
  const {store,create}=await fixture(t,{fetchPages:()=>pages.promise,onChanged:value=>observations.push(value)});
  const broker=await create(),write=store.writeState.bind(store),workerEntered=Promise.withResolvers(),workerRelease=Promise.withResolvers(),pauseEntered=Promise.withResolvers(),pauseRelease=Promise.withResolvers();
  let writes=0;
  store.writeState=async(name,value)=>{const index=++writes;if(index===2){workerEntered.resolve();await workerRelease.promise;}if(index===3){pauseEntered.resolve();await pauseRelease.promise;}return write(name,value);};
  await broker.enqueue([descriptor('/held-worker')]);await workerEntered.promise;const count=observations.length,pause=broker.pause();await pauseEntered.promise;
  try {workerRelease.resolve();await until(()=>observations.length>count);assert.equal(observations[count].queuePaused,false);}
  finally {workerRelease.resolve();pauseRelease.resolve();await pause;store.writeState=write;}
});
