import test from 'node:test';
import assert from 'node:assert/strict';
import * as status from '../frontend/service-status.js';
const entry=(sourceId,patch={})=>({sourceId,phase:'verification-required',verificationId:'cycle-1',...patch});
test('source views only show their active source; global screens retain compact access to pending checks',()=>{
  const state=status.createVerificationNoticeState(),entries=[entry('data:ACTIVE'),entry('data:OTHER')];state.observe(entries);
  for(const route of [{name:'details',params:{sid:'data:ACTIVE'}},{name:'reader',params:{sid:'data:ACTIVE'}},{name:'explore',params:{source:'data:ACTIVE'}}])assert.deepEqual(state.visible(entries,route).map(row=>row.sourceId),['data:ACTIVE']);
  for(const name of ['search','settings','downloads'])assert.equal(state.visible(entries,{name,params:{}}).length,2);
  assert.equal(state.visible(entries,{name:'explore',params:{}}).length,2);
  assert.equal(state.visible(entries,{name:'library',params:{}}).length,0);
});
test('route-only navigation changes visibility even when native pending entries stay identical',()=>{
  const state=status.createVerificationNoticeState(),entries=[entry('data:ACTIVE'),entry('data:OTHER')];state.observe(entries);
  assert.equal(state.visible(entries,{name:'details',params:{sid:'data:ACTIVE'}})[0].sourceId,'data:ACTIVE');
  assert.equal(state.visible(entries,{name:'reader',params:{sid:'data:OTHER'}})[0].sourceId,'data:OTHER');
});
test('dismissal leaves native pending intact and survives save/close updates, but a fresh cycle resurfaces',()=>{
  const state=status.createVerificationNoticeState(),original=entry('data:ACTIVE',{phase:'verification-opened'}),entries=[original];state.observe(entries);state.dismiss(entries);
  const closed=[{...original,phase:'retry-required',cookies:{state:'saved'}}];state.observe(closed);
  assert.equal(state.visible(closed,{name:'details',params:{sid:'data:ACTIVE'}}).length,0);assert.equal(original.phase,'verification-opened');
  const fresh=[{...closed[0],verificationId:'cycle-2'}];state.observe(fresh);assert.equal(state.visible(fresh,{name:'details',params:{sid:'data:ACTIVE'}}).length,1);
});
test('a renewed actual challenge resurfaces once; repeated polls and cookie saves do not undo dismissal',()=>{
  const state=status.createVerificationNoticeState(),route={name:'search',params:{}},entries=[entry('data:ACTIVE')];state.observe(entries);state.dismiss(entries);state.observe(entries);assert.equal(state.visible(entries,route).length,0);
  state.observe([{...entries[0],phase:'retry-required'}]);state.observe(entries);assert.equal(state.visible(entries,route).length,1);
  state.dismiss(entries);state.observe([{...entries[0],cookies:{state:'failed'}}]);assert.equal(state.visible(entries,route).length,0);
  state.observe([]);state.observe(entries);assert.equal(state.visible(entries,route).length,1);
});
