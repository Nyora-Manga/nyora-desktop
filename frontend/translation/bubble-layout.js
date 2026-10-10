// Model-free bubble geometry. Runs in the OCR worker; source/erasure boxes stay
// untouched. Uncertain regions keep the existing Nyora layout.
const MAX_REGION_PIXELS = 1_500_000;
const MAX_PAGE_PIXELS = 10_000_000;

export function addBubbleLayouts(ctx, blocks, width, height, detected = blocks) {
  let remaining = MAX_PAGE_PIXELS;
  return blocks.map(block => {
    const {x,y,w,h} = block;
    if (![x,y,w,h,width,height].every(Number.isFinite) || w <= 0 || h <= 0) return block;
    const padX = Math.max(48, w * 1.6), padY = Math.max(32, h * .45);
    const left = Math.max(0, Math.floor(x-padX)), top = Math.max(0, Math.floor(y-padY));
    const rw = Math.min(width, Math.ceil(x+w+padX))-left;
    const rh = Math.min(height, Math.ceil(y+h+padY))-top;
    const area = rw*rh;
    if (area <= 0 || area > MAX_REGION_PIXELS || area > remaining) return block;
    remaining -= area;
    try {
      const pixels = ctx.getImageData(left,top,rw,rh);
      const boxes = enclosedLayouts(pixels, {x:x-left,y:y-top,w,h}, detected.map(r=>({...r,x:r.x-left,y:r.y-top})), width*height);
      return boxes.length ? {...block,layoutBoxes:boxes.map(r=>({...r,x:r.x+left,y:r.y+top}))} : block;
    } catch {
      // Optional typography must never make an otherwise translated page fail.
      return block;
    }
  });
}

function enclosedLayouts({data,width:W,height:H}, b, detected, pageArea) {
  const size=W*H, stride=W+1;
  const white=new Uint8Array(size), integral=new Uint32Array((W+1)*(H+1));
  for(let y=0;y<H;y++) {
    let row=0;
    for(let x=0;x<W;x++) {
      const p=y*W+x, i=p*4;
      white[p]=data[i]>=240&&data[i+1]>=240&&data[i+2]>=240&&data[i+3]>=240?1:0;
      row+=white[p]; integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row;
    }
  }
  const mask=new Uint8Array(size);
  // A 2px erosion disconnects hairline breaks in ink outlines. Components
  // reaching this eroded ROI boundary are open and cannot safely be used.
  for(let y=2;y<H-2;y++) for(let x=2;x<W-2;x++) {
    const sum=integral[(y+3)*stride+x+3]-integral[(y-2)*stride+x+3]-integral[(y+3)*stride+x-2]+integral[(y-2)*stride+x-2];
    if(sum===25) mask[y*W+x]=1;
  }
  const queue=new Int32Array(size);
  let best=null, bestOverlap=0;
  for(let start=0;start<size;start++) {
    if(!mask[start]) continue;
    let read=0, count=1, overlap=0, minX=W,maxX=0,minY=H,maxY=0, open=false;
    queue[0]=start;mask[start]=0;
    const rowLeft=new Int32Array(H).fill(W),rowRight=new Int32Array(H).fill(-1);
    while(read<count) {
      const p=queue[read++], yy=Math.floor(p/W),xx=p-yy*W;
      minX=Math.min(minX,xx);maxX=Math.max(maxX,xx);minY=Math.min(minY,yy);maxY=Math.max(maxY,yy);
      rowLeft[yy]=Math.min(rowLeft[yy],xx);rowRight[yy]=Math.max(rowRight[yy],xx);
      if(xx<=2||xx>=W-3||yy<=2||yy>=H-3) open=true;
      if(xx>=b.x&&xx<b.x+b.w&&yy>=b.y&&yy<b.y+b.h) overlap++;
      for(const next of [p-1,p+1,p-W,p+W]) if(next>=0&&next<size&&mask[next]) {mask[next]=0;queue[count++]=next;}
    }
    if(open||overlap<=bestOverlap||overlap<b.w*b.h/6) continue;
    if(count>pageArea*.15||maxX-minX>Math.max(100,b.w*5)||maxY-minY>b.h*2.3) continue;
    if(minX>b.x+8||maxX<b.x+b.w-9||minY>b.y+8||maxY<b.y+b.h-9) continue;
    // Protect even OCR-rejected detections (e.g. neighboring colored captions).
    const shared=detected.some(r=>{
      if(r.x===b.x&&r.y===b.y&&r.w===b.w&&r.h===b.h) return false;
      const iw=Math.max(0,Math.min(maxX,r.x+r.w)-Math.max(minX,r.x));
      const ih=Math.max(0,Math.min(maxY,r.y+r.h)-Math.max(minY,r.y));
      return iw*ih>r.w*r.h*.2;
    });
    if(shared) continue;
    bestOverlap=overlap;best={minY,maxY,rowLeft,rowRight};
  }
  if(!best) return [];
  const result=[];
  for(const fraction of [.3,.4,.55,.7,.85,.95]) for(const center of [.5,.35,.65,.75]) {
    const mid=best.minY+(best.maxY-best.minY)*center, half=(best.maxY-best.minY)*fraction/2;
    const y=Math.ceil(mid-half), bottom=Math.floor(mid+half);
    if(y<best.minY || bottom>best.maxY) continue;
    let left=0,right=W;
    for(let yy=y;yy<=bottom;yy++) {left=Math.max(left,best.rowLeft[yy]+3);right=Math.min(right,best.rowRight[yy]-3);}
    if(right-left<=b.w+4||bottom-y<16) continue;
    // Row envelopes alone can bridge an illustration or a colored mark inside
    // a bubble. Only source text under the original eraser may be nonwhite.
    let safe=true;
    for(let yy=y;safe&&yy<=bottom;yy++) for(let xx=left;xx<=right;xx++) {
      if(!white[yy*W+xx]&&!(xx>=b.x&&xx<b.x+b.w&&yy>=b.y&&yy<b.y+b.h)) {
        if(xx<b.x) left=Math.max(left,xx+3);
        else if(xx>=b.x+b.w) right=Math.min(right,xx-3);
        else {safe=false;break;}
      }
    }
    if(safe && right-left>b.w+4) result.push({x:left,y,w:right-left,h:bottom-y});
  }
  return result;
}
