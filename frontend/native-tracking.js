import {nativeServices} from './native-services.js';
export function createNativeTracking(request) {
  let trackers=[];
  const refresh=async()=>{const result=await request('tracking.capabilities');if(!Array.isArray(result?.trackers))throw new Error('Tracking accounts could not be loaded.');trackers=structuredClone(result.trackers);return trackers;};
  const capability=slug=>trackers.find(tracker=>tracker.slug===slug)||{available:false,connected:false,enabled:false,reason:'Loading account options…'};
  const write=async(op,params)=>{const result=await request(op,params);await refresh();return result;};
  return Object.freeze({
    get TRACKERS(){return trackers.map(({slug,name,auth})=>({slug,name,auth}));},refresh,capability,
    trackerName:slug=>capability(slug).name||slug,isConnected:slug=>!!capability(slug).connected,isEnabled:slug=>!!capability(slug).connected&&!!capability(slug).enabled,
    connectedTrackers:()=>trackers.filter(tracker=>tracker.connected),linkedMediaId:(slug,mangaId)=>capability(slug).links?.[String(mangaId)]??null,
    connect:(slug,{token}={})=>write('tracking.connect',{slug,token}),disconnect:slug=>write('tracking.disconnect',{slug}),setEnabled:(slug,enabled)=>write('tracking.setEnabled',{slug,enabled}),
    link:(slug,mangaId,mediaId)=>write('tracking.link',{slug,mangaId:String(mangaId),mediaId}),unlink:(slug,mangaId)=>write('tracking.unlink',{slug,mangaId:String(mangaId)}),
    search:async(slug,title)=>(await request('tracking.search',{slug,title})).results,getState:(slug,mediaId)=>request('tracking.getState',{slug,mediaId}),
    setState:(slug,mediaId,patch)=>request('tracking.setState',{slug,mediaId,...patch}),scrobbleAll:({mangaId,chapter})=>request('tracking.scrobble',{mangaId:String(mangaId),chapter}),
  });
}
export const tracking=createNativeTracking((operation,params={})=>nativeServices.request(operation,params));
export default tracking;
