import {files} from './native-files.js';
const sessions = new Map();
export function createLocalReader({id:bookId,title,chapterTitle=title,pages,back='local',state={}}) {
  if (!pages?.length) throw new Error('This book has no readable pages.');
  const objectUrls = [];
  const validated = pages.map(page => {
    if (page instanceof Blob) { const url=URL.createObjectURL(page); objectUrls.push(url); return {url}; }
    const url=new URL(typeof page === 'string' ? page : page.url,location.origin);
    if(url.origin !== location.origin || !/^\/local-media\/[a-f0-9-]{36}\/\d+$/.test(url.pathname) || !url.searchParams.get('cap')) throw new Error('Local reader pages must be issued by this app.');
    return {url:url.href};
  });
  const id=bookId || crypto.randomUUID(), url=`local:${id}`;
  const session={state,saveProgress:bookId ? page=>files.progress(bookId,page) : undefined,savePreferences:bookId ? prefs=>files.savePreferences(bookId,prefs) : undefined,back:back==='downloads'?'downloads':'local',details:{manga:{id:url,url,title},chapters:[{url,title:chapterTitle}]},pages:validated,dispose(){for(const url of objectUrls)URL.revokeObjectURL(url);sessions.delete(id);}};
  sessions.set(id,session); return {local:id,back:session.back};
}
export function getLocalReader(id) {return sessions.get(id)||null;}
export async function restoreLocalReader(id,back='local',open=files.open) {
  if(!/^[a-f0-9-]{36}$/.test(id || ''))throw new Error('Reopen this book from your offline library.');
  const book=await open(id);
  if(book.id !== id)throw new Error('The offline book identity did not match.');
  createLocalReader({...book,back,state:book.state || {page:0}});
  return getLocalReader(id);
}
