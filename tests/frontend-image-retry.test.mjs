import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageRetryController,createVerificationRetryGate} from '../frontend/image-auto-retry.js';
function fixture({outcomes=[true],gate={online:true,verification:false}}={}){
  let clock=0,attached=true;const timers=new Map(),calls=[],states=[];let sequence=0;
  const controller=createImageRetryController({retry:async()=>{calls.push(clock);return outcomes.shift()??false;},isAttached:()=>attached,check:async()=>gate,onStatus:state=>states.push(state),setTimer:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,time:clock+delay});return id;},clearTimer:id=>timers.delete(id)});
  const advance=async milliseconds=>{clock+=milliseconds;for(const [id,timer] of [...timers])if(timer.time<=clock){timers.delete(id);timer.fn();}for(let i=0;i<10;i++)await Promise.resolve();};
  return {controller,calls,states,advance,gate,detach:()=>{attached=false;},timerCount:()=>timers.size};
}
test('reader retries transient failures after1/3s and stops after decoded success',async()=>{
  const f=fixture({outcomes:[false,true]});f.controller.failed();await f.advance(999);assert.deepEqual(f.calls,[]);await f.advance(1);assert.deepEqual(f.calls,[1000]);await f.advance(2999);assert.equal(f.calls.length,1);await f.advance(1);assert.deepEqual(f.calls,[1000,4000]);f.controller.resume();f.controller.failed();await f.advance(60000);assert.equal(f.calls.length,2);assert.equal(f.timerCount(),0);
});
test('a delayed status check cannot schedule duplicate gates or consume attempts without a new image request',async()=>{
  let gateRelease,scheduled,checks=0,retries=0,schedules=0;const controller=createImageRetryController({retry:async()=>{retries++;return false;},isAttached:()=>true,check:()=>{checks++;return new Promise(resolve=>gateRelease=resolve);},setTimer:fn=>{schedules++;scheduled=fn;return schedules;},clearTimer:()=>{}});
  controller.failed();scheduled();for(let i=0;i<5;i++){controller.failed();controller.resume();}assert.equal(checks,1);assert.equal(schedules,1);gateRelease({online:true,verification:false});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(retries,1);assert.equal(schedules,2);controller.cancel();
});
test('concurrent reader pages share one source-status query and only the matching pending source is paused',async()=>{
  let release,calls=0;const gate=createVerificationRetryGate({status:()=>{calls++;return new Promise(resolve=>release=resolve);},online:()=>true,now:()=>1000});
  const first=gate('data:ONE'),second=gate('data:TWO');await Promise.resolve();assert.equal(calls,1);release([{sourceId:'data:ONE',phase:'verification-required'}]);assert.deepEqual(await first,{online:true,verification:true});assert.deepEqual(await second,{online:true,verification:false});await gate('data:TWO');assert.equal(calls,1);
});
test('closed saved verification permits transient retry while renewed challenges, open windows and cookie flushes pause it',async()=>{
  for(const [entry,verification] of [[{phase:'retry-required',cookies:{state:'saved'}},false],[{phase:'retry-required',cookies:{state:'failed'}},false],[{phase:'verification-required'},true],[{phase:'verification-opened'},true],[{phase:'retry-required',cookies:{state:'saving'}},true]]){
    const gate=createVerificationRetryGate({status:async()=>[{sourceId:'data:ONE',...entry}],online:()=>true});assert.equal((await gate('data:ONE')).verification,verification);
  }
});
test('permanent failure consumes exactly three attempts and repeated error/online events never reset its budget',async()=>{
  const f=fixture({outcomes:[]});f.controller.failed();await f.advance(1000);f.controller.failed();await f.advance(3000);await f.advance(8000);for(let i=0;i<5;i++){f.controller.failed();f.controller.resume();await f.advance(60000);}assert.deepEqual(f.calls,[1000,4000,12000]);assert.equal(f.timerCount(),0);assert.equal(f.states.at(-1),'failed');
});
test('offline and source verification pause without polling or spending attempts; online resumes the same budget',async()=>{
  const f=fixture({gate:{online:false,verification:false}});f.controller.failed();await f.advance(1000);assert.deepEqual(f.calls,[]);assert.equal(f.states.at(-1),'offline');await f.advance(60000);assert.equal(f.timerCount(),0);f.gate.online=true;f.gate.verification=true;f.controller.resume();await f.advance(1000);assert.equal(f.states.at(-1),'verification');assert.deepEqual(f.calls,[]);await f.advance(60000);assert.equal(f.timerCount(),0);f.gate.verification=false;f.controller.resume();await f.advance(1000);assert.equal(f.calls.length,1);
});
test('external verification/manual retry cancels a pending automatic attempt and shares any in-flight attempt',async()=>{
  let release,calls=0;const timers=new Map();const controller=createImageRetryController({retry:()=>{calls++;return new Promise(resolve=>release=resolve);},isAttached:()=>true,check:async()=>({online:true,verification:false}),setTimer:(fn)=>{timers.set(1,fn);return 1;},clearTimer:id=>timers.delete(id)});
  controller.failed();assert.equal(timers.size,1);const first=controller.retryNow(),second=controller.retryNow();assert.equal(first,second);assert.equal(timers.size,0);assert.equal(calls,1);release(true);assert.equal(await first,true);assert.equal(calls,1);
});
test('verification handoff queues one fresh request after an older attempt settles; repeated handoffs coalesce',async()=>{
  const pending=[],calls=[];let scheduled;const controller=createImageRetryController({retry:url=>{calls.push(url);return new Promise(resolve=>pending.push(resolve));},isAttached:()=>true,check:async()=>({online:true,verification:false}),setTimer:fn=>{scheduled=fn;return 1;},clearTimer:()=>{}});
  controller.failed();scheduled();for(let i=0;i<5;i++)await Promise.resolve();assert.equal(calls.length,1);
  const first=controller.retryNow('issued?_r=post-close'),second=controller.retryNow('issued?_r=duplicate');assert.equal(first,second);assert.equal(calls.length,1);controller.loaded();pending[0](true);for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls.length,2);assert.equal(calls[1],'issued?_r=post-close');pending[1](true);assert.equal(await first,true);assert.equal(calls.length,2);
});
test('explicit cancellation suppresses a queued verification handoff even while its page remains attached',async()=>{
  for(const loadedBeforeCancel of [false,true]){
    let release,calls=0,cancellations=0;const controller=createImageRetryController({retry:()=>{calls++;return calls===1?new Promise(resolve=>release=resolve):Promise.resolve(false);},isAttached:()=>true,check:async()=>({online:true,verification:false}),onCancel:()=>cancellations++,setTimer:()=>1,clearTimer:()=>{}});
    const old=controller.retryNow(),handoff=controller.retryNow('issued?_r=post-close');
    if(loadedBeforeCancel)controller.loaded();
    controller.cancel();controller.cancel();release(false);await old;
    assert.equal(await handoff,false);assert.equal(calls,1);assert.equal(cancellations,1);
  }
});
test('route detachment cancels queued retries and a late status result cannot revive a disconnected page',async()=>{
  const f=fixture();f.controller.failed();f.detach();await f.advance(1000);assert.deepEqual(f.calls,[]);assert.equal(f.timerCount(),0);
  let gateRelease,attached=true,calls=0,scheduled;const controller=createImageRetryController({retry:async()=>{calls++;return true;},isAttached:()=>attached,check:()=>new Promise(resolve=>gateRelease=resolve),setTimer:fn=>{scheduled=fn;return 1;},clearTimer:()=>{}});controller.failed();scheduled();await Promise.resolve();attached=false;controller.cancel();gateRelease({online:true,verification:false});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls,0);
});
