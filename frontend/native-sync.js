import {nativeServices} from './native-services.js';
let current={isConfigured:true,isAuthenticated:false,email:'',lastSyncTimestamp:''};
export const SYNC_CONFIG=Object.freeze({syncUrl:'native'});
export function status(){return {...current};}
export function hasLocalData(){const state=nativeServices.snapshot();return !!(state.favourites.length||state.history.length||state.bookmarks.length);}
export async function refreshStatus(){current=await nativeServices.request('sync.status');return status();}
export async function signIn(email,password){current=await nativeServices.request('sync.signIn',{email,password});return refreshStatus();}
export async function register(email,password){current=await nativeServices.request('sync.register',{email,password});return refreshStatus();}
export async function syncNow(){const result=await nativeServices.performBackup(()=>nativeServices.request('sync.now'),true);await refreshStatus();return result;}
export async function signOut(){await nativeServices.request('sync.signOut');return refreshStatus();}
export default {status,hasLocalData,refreshStatus,signIn,register,syncNow,signOut};
