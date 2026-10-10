const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
let Automation;try{({Automation}=require('./automation.cjs'));}catch{}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nyora-automation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let now=100000000;const calls=[],prefs={};
  const options={directory,now:()=>now,preferences:async()=>prefs,run:async name=>{calls.push(name);},changed:()=>calls.push('changed')};
  return {directory,calls,prefs,options,advance:ms=>now+=ms};
}
test('automation is opt-in, persists due times across restart, and does not overlap',async t=>{
  const f=await fixture(t);assert(Automation);
  const scheduler=new Automation(f.options);await scheduler.tick();assert.deepEqual(f.calls,[]);
  f.prefs.automation={updates:60,sync:15,backup:1440};await scheduler.tick();
  assert.deepEqual(f.calls,['updates','changed','sync','changed','backup']);
  const reopened=new Automation(f.options);await Promise.all([reopened.tick(),reopened.tick()]);assert.equal(f.calls.length,5);
  f.advance(15*60000);await reopened.tick();assert.deepEqual(f.calls.slice(5),['sync','changed']);
});
test('failure is recorded, backs off, and cannot stop other scheduled tasks',async t=>{
  const f=await fixture(t);f.prefs.automation={updates:60,sync:15};
  const scheduler=new Automation({...f.options,run:async name=>{f.calls.push(name);if(name==='updates')throw new Error('offline');}});
  await scheduler.tick();assert.deepEqual(f.calls,['updates','changed','sync','changed']);assert.equal(scheduler.status().updates.result,'failed');
  await scheduler.tick();assert.equal(f.calls.length,4);
});

test('device preferences allow only the supported opt-in schedules',()=>{
  const {validatePatch}=require('./preferences.cjs');
  assert.doesNotThrow(()=>validatePatch({automation:{updates:720,sync:0,backup:1440},reader:{mode:'VERTICAL'}}));
  for(const automation of [{updates:1},{sync:true},{backup:1440,path:'/tmp/arbitrary'},{unknown:0},[]])assert.throws(()=>validatePatch({automation}));
});
