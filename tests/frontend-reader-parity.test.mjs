import test from 'node:test';
import assert from 'node:assert/strict';
const reader = await import('../frontend/reader-parity.js').catch(()=>({}));
test('chapter navigation stays in the selected translation branch, including unnamed branches',()=>{
  const chapters=[{url:'/a1',branch:'A'},{url:'/b1',branch:'B'},{url:'/a2',branch:'A'},{url:'/none',branch:null}];
  assert.deepEqual(reader.chaptersForBranch(chapters,'/a1'),[chapters[0],chapters[2]]);
  assert.deepEqual(reader.chaptersForBranch(chapters,'/none'),[chapters[3]]);
  assert.deepEqual(reader.chaptersForBranch(chapters,'/missing'),chapters);
});
test('vertical paging locates the visible slide by its vertical centre',()=>{
  const slides=[{left:0,top:-800,width:600,height:800},{left:0,top:0,width:600,height:800},{left:0,top:800,width:600,height:800}];
  assert.equal(reader.nearestSlide({left:0,top:0,width:600,height:800},slides,true),1);
  assert.equal(reader.nearestSlide({left:0,top:0,width:600,height:800},[{left:-600,top:0,width:600,height:800},slides[1]],false),1);
});
