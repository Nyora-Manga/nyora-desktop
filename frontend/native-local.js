import {files} from './native-files.js';
import {el,btn,sectionHeader,emptyState,errorBox,spinner} from 'nyora-shared-ui';
import {router} from 'nyora-shared-store';
import {createLocalReader} from './native-local-reader.js';
export const meta={title:'Local',nav:true,icon:'folder',order:50};
export function render(view) {
  const body=el('div',{class:'local-body'}),status=el('p',{role:'status'});
  const choose=btn('Choose folder',{variant:'accent',icon:'folder',onClick:async()=>{choose.disabled=true;try{const result=await files.select('folder');if(!result.cancelled){await load();status.textContent=(result.failures||[]).join(' ');}}catch(error){status.textContent=error.message;}finally{choose.disabled=false;}}});
  const archive=btn('Open archive',{variant:'ghost',onClick:async()=>{archive.disabled=true;try{const result=await files.select('archive');if(!result.cancelled){await load();status.textContent=(result.failures||[]).join(' ');}}catch(error){status.textContent=error.message;}finally{archive.disabled=false;}}});
  view.replaceChildren(sectionHeader('Local',choose,archive),status,body);
  async function load(){body.replaceChildren(spinner());try{const result=await files.list();if(!view.isConnected)return;const books=result.books||[];body.replaceChildren();for(const warning of result.warnings || [])body.append(el('p',{role:'status'},warning.message));if(!books.length){body.append(emptyState('Choose a folder of images or CBZ/ZIP archives to read offline.'));return;}
    const list=el('div',{class:'list'});for(const book of books){const open=btn('Read',{variant:'ghost',onClick:async()=>{open.disabled=true;try{const result=await files.open(book.id);router.navigate('reader',createLocalReader({...result,back:'local',state:result.state || {page:0}}));}catch(error){status.textContent=error.message;}finally{open.disabled=false;}}});list.append(el('div',{class:'row-item'},el('div',{class:'row-main'},el('div',{class:'name'},book.title),el('div',{class:'sub'},`${book.pageCount} pages`)),el('div',{class:'row-actions'},open)));}body.append(list);
  }catch(error){body.replaceChildren(errorBox(error.message));}}
  void load();
}
export default {meta,render};
