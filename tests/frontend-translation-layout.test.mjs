import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBubbleLayouts } from '../frontend/translation/bubble-layout.js';

// Hand-drawn, closed white bubble with a narrow vertical text column.
function page({open=false, gap=false, colored=false, decoration=false}={}) {
  const width=400, height=400, data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const white=(x>=90&&x<210&&y>=70&&y<270)|| (open&&y>=130&&y<160&&x<100) || (gap&&y===140&&x<100);
    const i=(y*width+x)*4; data[i]=white?255:0; data[i+1]=white?(colored?210:255):0; data[i+2]=white?(colored?190:255):0; data[i+3]=255;
  }
  if (decoration) for(let y=80;y<160;y++) for(let x=172;x<200;x++) data[(y*width+x)*4+1]=80;
  // Text is safely inside the bubble; its holes must not be mistaken for an outline.
  for(let y=100;y<230;y+=18) for(let yy=y;yy<y+7;yy++) for(let x=140;x<151;x++) data.fill(0,(yy*width+x)*4,(yy*width+x)*4+3);
  return {getImageData(x,y,w,h) {const crop=new Uint8ClampedArray(w*h*4);for(let r=0;r<h;r++) crop.set(data.subarray(((y+r)*width+x)*4,((y+r)*width+x+w)*4),r*w*4);return {data:crop,width:w,height:h};}};
}
const block={x:130,y:90,w:35,h:155,bg:'rgb(255,255,255)',text:'original'};
test('expands a narrow column only into the enclosed bubble, retaining the erasure box',()=>{
  const [result]=addBubbleLayouts(page(),[block],400,400);
  assert.ok(result.layoutBoxes?.some(r=>r.w>=100),'closed bubble should expose a wider safe layout');
  assert.equal(result.x,130);assert.equal(result.w,35);assert.equal(result.text,'original');
  for(const r of result.layoutBoxes) {assert.ok(r.x>90&&r.x+r.w<210);assert.ok(r.y>70&&r.y+r.h<270);}
  assert.equal(block.layoutBoxes,undefined,'do not mutate cached OCR data');
});
test('rejects an open or colored region',()=>{
  for(const options of [{open:true},{colored:true}]) assert.equal(addBubbleLayouts(page(options),[block],400,400)[0].layoutBoxes,undefined);
});
test('closes a one-pixel outline leak without extending into the gutter',()=>{
  const [result]=addBubbleLayouts(page({gap:true}),[block],400,400);
  assert.ok(result.layoutBoxes?.length);assert.ok(result.layoutBoxes.every(r=>r.x>90));
});
test('does not expand a bubble shared with another detected text region',()=>{
  const neighbor={x:170,y:100,w:20,h:80};
  assert.equal(addBubbleLayouts(page(),[block],400,400,[block,neighbor])[0].layoutBoxes,undefined);
});
test('falls back when pixel access fails or a very large page would exhaust the analysis budget',()=>{
  const inaccessible={getImageData(){throw Error('unavailable');}};
  assert.deepEqual(addBubbleLayouts(inaccessible,[block],400,400),[block]);
  let called=false;
  const huge={...block,x:1000,y:1000,w:10000,h:10000};
  assert.deepEqual(addBubbleLayouts({getImageData(){called=true;throw Error('must not allocate');}},[huge],50000,50000),[huge]);
  assert.equal(called,false);
});

test('finds lower bubble space while keeping a colored interjection visible above it',()=>{
  const [result]=addBubbleLayouts(page({decoration:true}),[block],400,400);
  assert.ok(result.layoutBoxes?.some(r=>r.w>90&&r.y>=160&&r.h>=70));
});
test('can narrow the layout beside a colored mark without covering that mark',()=>{
  const [result]=addBubbleLayouts(page({decoration:true}),[block],400,400);
  assert.ok(result.layoutBoxes?.some(r=>r.y<150&&r.w>60&&r.x+r.w<172));
});
