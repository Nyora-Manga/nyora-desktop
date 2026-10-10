// A budget belongs to one original image, not to each successive error event.
export function createImageRetryController({retry,isAttached,check,onStatus=()=>{},delays=[1000,3000,8000],setTimer=setTimeout,clearTimer=clearTimeout,onCancel=()=>{}}) {
  let attempts=0,timer,pending,checking,queuedExternal,cancelled=false,generation=0,cancellationEpoch=0;
  const clear=()=>{if(timer!==undefined){clearTimer(timer);timer=undefined;}};
  const cancel=(reason='cancelled')=>{if(reason!=='loaded')cancellationEpoch++;if(cancelled)return;clear();cancelled=true;generation++;onCancel(reason);};
  function run(url) {
    if(pending)return pending;
    if(cancelled||!isAttached()){cancel();return Promise.resolve(false);}
    onStatus('retrying');
    let result;try{result=retry(url);}catch{result=false;}
    pending=Promise.resolve(result).then(value=>value===true,()=>false).then(success=>{
      pending=undefined;
      if(success){cancel('loaded');onStatus('loaded');}
      else if(!cancelled)queue();
      return success;
    });
    return pending;
  }
  function queue() {
    if(cancelled)return;
    if(!isAttached()){cancel();return;}
    if(timer!==undefined||pending||checking!==undefined)return;
    if(attempts>=delays.length){onStatus('failed');return;}
    onStatus('scheduled');const expected=generation;
    timer=setTimer(async()=>{
      timer=undefined;
      if(cancelled||!isAttached()){cancel();return;}
      checking=expected;
      let gate;try{gate=await check();}catch{gate={online:true,verification:true};}
      if(checking===expected)checking=undefined;
      if(cancelled||expected!==generation||!isAttached()){if(!isAttached())cancel();else if(!cancelled&&!pending)queue();return;}
      if(!gate.online){onStatus('offline');return;}
      if(gate.verification){onStatus('verification');return;}
      attempts++;void run();
    },delays[attempts]);
  }
  return Object.freeze({
    failed:queue,
    resume:queue,
    cancel,
    loaded:()=>cancel('loaded'),
    isAttached,
    retryNow(url) {
      clear();attempts=0;
      if(queuedExternal)return queuedExternal;
      if(pending&&url){
        // A verification close rotates native proof. An older image response
        // cannot validate that boundary; dispatch one fresh request afterward.
        const expectedCancellation=cancellationEpoch;
        queuedExternal=pending.then(()=>{
          if(expectedCancellation!==cancellationEpoch||!isAttached())return false;
          clear();generation++;cancelled=false;return run(url);
        }).finally(()=>{queuedExternal=undefined;});
        return queuedExternal;
      }
      if(pending)return pending;
      generation++;cancelled=false;return run(url);
    },
  });
}

// Due pages share an IPC snapshot; no per-image interval or network probe.
export function createVerificationRetryGate({status,online=()=>globalThis.navigator?.onLine!==false,now=()=>Date.now()}) {
  let snapshot,pending,readAt=-Infinity;
  return async sourceId=>{
    if(!online())return {online:false,verification:false};
    if(!snapshot||now()-readAt>250){
      if(!pending)pending=Promise.resolve().then(status).then(entries=>{snapshot=entries;readAt=now();return entries;}).finally(()=>{pending=undefined;});
      await pending;
    }
    return {online:true,verification:snapshot.some(entry=>entry.sourceId===sourceId&&(['verification-required','verification-opened'].includes(entry.phase)||entry.cookies?.state==='saving'))};
  };
}
