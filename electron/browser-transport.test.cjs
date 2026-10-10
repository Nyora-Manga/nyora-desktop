'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {BrowserContextTransport,requestOptions}=require('./browser-transport.cjs');
const options={method:'GET',credentials:'include',redirect:'manual',headers:{}};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(execute=async()=>({status:200,body:new ArrayBuffer(0)})){
 const windows=[],commands=[],sessions=[];
 const raw={setProxy:async()=>{},resolveHost:async()=>({endpoints:[]}),closeAllConnections:async()=>{}};
 const transport=new BrowserContextTransport({sessionForSource:async id=>{sessions.push(id);return raw;},createWindow:config=>{
  const contents=new EventEmitter();contents.debugger=new EventEmitter();contents.debugger.attach=()=>{};contents.debugger.sendCommand=async(method,p)=>{commands.push({method,p});};contents.setWindowOpenHandler=fn=>{contents.open=fn;};contents.getURL=()=>contents.url;contents.executeJavaScriptInIsolatedWorld=(_world,scripts)=>execute(scripts[0].code,windows.indexOf(window));
  const window={config,webContents:contents,destroyed:false,isDestroyed(){return this.destroyed;},destroy(){this.destroyed=true;contents.emit('destroyed');},setExcludedFromShownWindowsMenu(value){this.excluded=value;},async loadURL(url){contents.url=url;if(url!=='about:blank'){contents.debugger.emit('message',{},'Fetch.requestPaused',{requestId:'bootstrap',request:{url},resourceType:'Document'});await tick();}}};windows.push(window);return window;
 }});return {transport,windows,commands,sessions};
}
test('transport normalizes HTTP fragments and rejects credential headers, private targets and unbounded bodies',()=>{
 assert.equal(requestOptions('https://example.org/manga#chapter',options,10).url,'https://example.org/manga');
 for(const key of ['Cookie','Authorization','Host','User-Agent'])assert.throws(()=>requestOptions('https://example.org/',{...options,headers:{[key]:'secret'}},10),/INVALID_TRANSPORT_HEADERS/);
 assert.throws(()=>requestOptions('https://127.0.0.1/',options,10));assert.throws(()=>requestOptions('https://example.org/',{...options,redirect:'follow'},10));
 assert.throws(()=>requestOptions('https://example.org/',{...options,method:'POST',body:Buffer.alloc(11)},10),/INVALID_TRANSPORT_BODY/);
});
test('private contexts retain source+target origin authority, deny native privileges, and bypass service workers before source bootstrap',async()=>{
 const {transport,windows,commands}=fixture();await transport.fetch('data:one','https://example.org/a',options);await transport.fetch('data:one','https://example.org/b',options);await transport.fetch('data:one','https://example.net/image',options);await transport.fetch('data:two','https://example.org/a',options);
 assert.equal(windows.length,3);for(const window of windows){assert.equal(window.config.show,false);assert.equal(window.config.focusable,false);assert.equal(window.config.skipTaskbar,true);assert.equal(window.excluded,true);assert.equal(window.config.webPreferences.sandbox,true);assert.equal(window.config.webPreferences.contextIsolation,true);assert.equal(window.config.webPreferences.nodeIntegration,false);assert.equal(window.config.webPreferences.webSecurity,true);assert.equal(window.config.webPreferences.preload,undefined);assert.deepEqual(window.webContents.open(),{action:'deny'});}
 const bypass=commands.findIndex(v=>v.method==='Network.setBypassServiceWorker');const bootstrap=commands.findIndex(v=>v.method==='Fetch.fulfillRequest');assert.ok(bypass>=0&&bypass<bootstrap);assert.deepEqual(commands[bypass].p,{bypass:true});await transport.close();assert.ok(windows.every(w=>w.isDestroyed()));
});
test('queued cancellation settles promptly without destroying unrelated active source read',async()=>{
 const pending=Promise.withResolvers();const {transport,windows}=fixture(()=>pending.promise);const active=transport.fetch('data:one','https://example.org/slow',options);await tick();await tick();const controller=new AbortController();const queued=transport.fetch('data:one','https://example.org/next',{...options,signal:controller.signal});controller.abort();await assert.rejects(queued);assert.equal(windows[0].destroyed,false);pending.resolve({status:200,body:new ArrayBuffer(0)});assert.equal((await active).status,200);await transport.close();
});
test('active cancellation waits native destruction, then queued read reacquires a fresh context',async()=>{
 const pending=Promise.withResolvers();const {transport,windows}=fixture((_code,index)=>index===0?pending.promise:Promise.resolve({status:200,body:new ArrayBuffer(0)}));const controller=new AbortController();const active=transport.fetch('data:one','https://example.org/slow',{...options,signal:controller.signal});await tick();await tick();const queued=transport.fetch('data:one','https://example.org/next',options);controller.abort();await assert.rejects(active);assert.equal(windows[0].destroyed,true);assert.equal((await queued).status,200);assert.equal(windows.length,2);await transport.close();
});
test('source close drains its pending contexts without cancelling another source',async()=>{
 const hold=Promise.withResolvers();const {transport,windows}=fixture(code=>code.includes('/slow')?hold.promise:Promise.resolve({status:200,body:new ArrayBuffer(0)}));const pending=transport.fetch('data:one','https://example.org/slow',options);pending.catch(()=>{});await tick();await tick();await transport.fetch('data:two','https://example.org/ok',options);await transport.closeSource('data:one');await assert.rejects(pending);assert.equal(windows[0].destroyed,true);assert.equal(windows[1].destroyed,false);assert.equal((await transport.fetch('data:two','https://example.org/again',options)).status,200);await transport.close();
});
test('saturated context close is safe before raw session resolution and cannot resurrect closed frames',async()=>{
 const raw=Promise.withResolvers();const transport=new BrowserContextTransport({sessionForSource:()=>raw.promise,maxContexts:1,createWindow:()=>{throw Error('Closed context must not materialize');}});const first=transport.fetch('data:first','https://example.org/slow',options);first.catch(()=>{});const second=transport.fetch('data:second','https://example.org/next',options);second.catch(()=>{});await transport.closeSource('data:second');await assert.rejects(second,/TRANSPORT_CONTEXT_LIMIT/);await transport.close();await assert.rejects(first);raw.resolve({closeAllConnections:async()=>{}});await tick();
});
