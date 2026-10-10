// Trusted native DTOs already contain a main-issued media URL and per-launch
// capability. The renderer preserves that authority; it cannot mint a route.
export function nativeImageUrl(url, _headers, sourceId, origin = globalThis.location?.origin) {
  if (!url) return '';
  const value = String(url).trim();
  if (/^(data:image\/|blob:)/i.test(value)) return value;
  let parsed;
  try { parsed = new URL(value, origin); } catch { throw new Error('Invalid image URL.'); }
  if (parsed.pathname === '/helper-image') {
    if (!origin || parsed.origin !== origin || !parsed.searchParams.get('cap') || !parsed.searchParams.get('sourceId')) throw new Error('Native image needs a current app media route. Reload its source to obtain one.');
    // Preserve cap, source case, Referer metadata, and the reader _r cache-buster.
    return value;
  }
  if (parsed.protocol === 'nyora:' || parsed.pathname === '/image' || ['localhost', '[::1]', '0.0.0.0'].includes(parsed.hostname) || parsed.hostname === '127.0.0.1' && parsed.origin !== origin) throw new Error('Legacy helper image URLs are unavailable. Reload their native source.');
  if (parsed.origin === origin && parsed.protocol === 'http:') return value;
  if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !sourceId) return value;
  throw new Error('Native source images require a media URL issued by the native app.');
}
export function nativeMangaImages(manga, sourceId) {
  if (!manga || typeof manga !== 'object') return manga;
  sourceId = sourceId || manga.sourceId || manga.source?.name || manga.source?.id;
  return { ...manga, ...(manga.coverUrl ? { coverUrl: nativeImageUrl(manga.coverUrl, undefined, sourceId) } : {}), ...(manga.largeCoverUrl ? { largeCoverUrl: nativeImageUrl(manga.largeCoverUrl, undefined, sourceId) } : {}) };
}
// Remember only failed, main-issued media for explicit or post-verification recovery.
export function createImageRetries({ origin = () => globalThis.location?.origin, now = () => Date.now() } = {}) {
  const failed = new Map();
  let sequence = 0, timestamp = 0;
  function issued(url) {
    try {
      const parsed = new URL(url, origin());
      if (parsed.origin !== origin() || parsed.pathname !== '/helper-image' || !parsed.searchParams.get('cap') || !parsed.searchParams.get('sourceId') || !parsed.searchParams.get('u')) return null;
      return parsed;
    } catch { return null; }
  }
  function retry(sourceId) {
    const pending = [];
    for (const entry of [...failed.values()]) {
      if (entry.sourceId !== sourceId) continue;
      const url = new URL(entry.url);
      timestamp = Math.max(now(), timestamp + 1);
      url.searchParams.set('_r', String(timestamp));
      pending.push(entry.retry(url.href));
    }
    return pending;
  }
  return Object.freeze({
    failed(url, retry) {
      const parsed = issued(url);
      if (!parsed) return null;
      const token = ++sequence;
      failed.set(token, { url: parsed.href, sourceId: parsed.searchParams.get('sourceId'), retry });
      if (failed.size > 512) failed.delete(failed.keys().next().value);
      return token;
    },
    loaded(token) { failed.delete(token); },
    has(sourceId) { return [...failed.values()].some((entry) => entry.sourceId === sourceId); },
    retrySource(sourceId) { return retry(sourceId).length; },
    async retrySourceAndWait(sourceId) {
      const pending = retry(sourceId);
      await Promise.allSettled(pending);
      return pending.length;
    },
  });
}
export const nativeImageRetries = createImageRetries();
function imageStatusChanged(sourceId) {
  globalThis.window?.dispatchEvent(new CustomEvent('nyora:native-image-failed', { detail: { sourceId } }));
}
const automaticImages=new Set(), preparedFallbacks=new WeakSet();
const retryGate=createVerificationRetryGate({status:()=>globalThis.NYORA_DESKTOP.verificationStatus()});
let observingImages=false,retryTimestamp=0;
function watchImage(controller) {
  const reference=new WeakRef(controller);automaticImages.add(reference);
  if(automaticImages.size>512){const first=automaticImages.values().next().value;automaticImages.delete(first);first.deref()?.cancel();}
  if(!observingImages){
    observingImages=true;
    const prune=()=>{for(const reference of automaticImages){const control=reference.deref();if(!control||!control.isAttached()){automaticImages.delete(reference);control?.cancel();}}};
    new MutationObserver(prune).observe(document.getElementById('view')||document.body,{childList:true,subtree:true});
    window.addEventListener('online',()=>{prune();for(const reference of automaticImages)reference.deref()?.resume();});
    window.addEventListener('pagehide',()=>{for(const reference of automaticImages)reference.deref()?.cancel();automaticImages.clear();},{once:true});
  }
  return reference;
}
function restoreReaderImage(img,replacement) {
  const view=replacement.closest('.reader.webtoon')||document.getElementById('view'),bounds=view?.getBoundingClientRect();
  const anchor=[...(view?.querySelectorAll('.reader-page')||[])].find(page=>{const rect=page.getBoundingClientRect();return rect.bottom>(bounds?.top||0)&&rect.top<(bounds?.bottom||innerHeight);});
  const top=anchor?.getBoundingClientRect().top;
  replacement.replaceWith(img);
  const current=anchor===replacement?img:anchor;
  if(current?.isConnected&&top!==undefined){
    const delta=current.getBoundingClientRect().top-top;
    if(Math.abs(delta)>0.5){if(view&&view.scrollHeight>view.clientHeight)view.scrollTop+=delta;else window.scrollBy(0,delta);}
  }
}
export function applyNativeImage(img, url, headers, onFail) {
  let target;
  try { target = nativeImageUrl(url, headers); } catch { if (onFail) onFail(); return; }
  if (!target) { if (onFail) onFail(); return; }
  const absolute = new URL(target, location.href);
  // Public metadata CDNs with CORS can decode under require-corp. Native media
  // remains same-origin, including canvas/AI bitmap reads.
  if (absolute.protocol === 'https:' && absolute.origin !== location.origin) img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  let token,replacement,controller,reference,retryPending,cancelRetry,reservedHeight=0,failureText='Page failed to load';
  const sourceId=absolute.searchParams.get('sourceId');
  const native=absolute.origin===location.origin&&absolute.pathname==='/helper-image';
  const reader=img.classList.contains('reader-page')&&native;
  const display = img.style.display;
  function retryImage(retryUrl) {
    if(retryPending)return retryPending;
    if(!img.isConnected&&!replacement?.isConnected){nativeImageRetries.loaded(token);return Promise.resolve(false);}
    img.style.display=display;
    const next=new URL(retryUrl||target,location.href);retryTimestamp=Math.max(Date.now(),retryTimestamp+1);next.searchParams.set('_r',String(retryTimestamp));
    retryPending=new Promise(resolve=>{
      let settled=false;
      const finish=event=>{if(settled)return;settled=true;clearTimeout(timer);img.removeEventListener('load',finish);img.removeEventListener('error',finish);resolve(event?.type==='load');};
      const timer=setTimeout(()=>finish(),30000);cancelRetry=()=>finish();
      img.addEventListener('load',finish,{once:true});img.addEventListener('error',finish,{once:true});
      img.loading='eager';img.src=next.href;
    }).finally(()=>{retryPending=undefined;cancelRetry=undefined;});
    return retryPending;
  }
  img.addEventListener('load', () => {
    if(replacement?.isConnected&&!img.isConnected){
      if(reader)restoreReaderImage(img,replacement);
      else replacement.replaceWith(img);
    }
    nativeImageRetries.loaded(token);controller?.loaded();imageStatusChanged(sourceId);
  });
  img.addEventListener('error', () => {
    nativeImageRetries.loaded(token);
    if(!img.isConnected&&!replacement?.isConnected){controller?.cancel();return;}
    if(img.isConnected){
      reservedHeight=img.getBoundingClientRect().height;
      const parent=img.parentNode,index=[...parent.childNodes].indexOf(img);
      if(onFail)onFail();
      const next=!img.parentNode?parent.childNodes[index]:null;
      if(next)replacement=next;
      if(reader&&replacement?.isConnected&&replacement.tagName!=='IMG'){
        if(reservedHeight>0)replacement.style.minHeight=`${reservedHeight}px`;
        failureText=replacement.querySelector('div')?.textContent||failureText;
      }
    }
    // When a card advances to its alternate cover, that image owns recovery.
    // The failed thumbnail must never replace a successfully loaded alternate.
    if(!reader&&replacement?.tagName==='IMG'){controller?.cancel();return;}
    token=nativeImageRetries.failed(target,retryUrl=>controller?controller.retryNow(retryUrl):retryImage(retryUrl));
    if(native&&token&&!controller){
      controller=createImageRetryController({retry:retryImage,isAttached:()=>img.isConnected||!!replacement?.isConnected,check:()=>retryGate(sourceId),onStatus:state=>{
        if(['scheduled','retrying'].includes(state)&&controller&&!automaticImages.has(reference))reference=watchImage(controller);
        const message=reader&&replacement?.isConnected&&replacement.querySelector('div');
        if(message)message.textContent=state==='offline'?'Waiting for a connection…':state==='verification'?'Waiting for source verification…':['scheduled','retrying'].includes(state)?'Retrying page…':failureText;
      },onCancel:reason=>{automaticImages.delete(reference);nativeImageRetries.loaded(token);if(reason!=='loaded'){cancelRetry?.();if(!img.isConnected&&!replacement?.isConnected)img.removeAttribute('src');}}});
      reference=watchImage(controller);
    }
    if(reader&&replacement?.isConnected&&!preparedFallbacks.has(replacement)){
      preparedFallbacks.add(replacement);const manual=replacement.querySelector('button');
      manual?.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();void controller.retryNow();},{capture:true});
      manual?.addEventListener('keydown',event=>event.stopPropagation());
    }
    controller?.failed();if(token)imageStatusChanged(sourceId);
  });
  img.src = target;
}
import {createImageRetryController,createVerificationRetryGate} from './image-auto-retry.js';
