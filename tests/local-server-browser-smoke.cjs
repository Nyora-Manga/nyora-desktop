'use strict';
// Standalone real Electron acceptance for the HTTP asset/image server. This
// creates only synthetic bundled assets; it does not launch the data helper.
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createPackage } = require('@electron/asar');
const { LocalAppServer } = require('../electron/local-server.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
let server, directory, window;
let calls = 0;
app.on('window-all-closed', () => {});
app.enableSandbox();
app.whenReady().then(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nyora-local-browser-smoke-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="styled">Fixture</div></body></html>');
  await writeFile(join(directory, 'style.css'), '#styled { color: rgb(17, 34, 51); }');
  await writeFile(join(directory, 'worker.js'), 'postMessage({isolated:crossOriginIsolated});');
  await writeFile(join(directory, 'fixture.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const archive = `${directory}.asar`;
  await createPackage(directory, archive);
  server = new LocalAppServer({ distDirectory: archive,
    csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'",
    image: async url => { assert.equal(new URL(url).searchParams.has('_r'), false); assert.equal(new URL(url).searchParams.has('cap'), false); calls++; return { bytes: png, contentType: 'image/png' }; },
  });
  await server.start();
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  await window.loadURL(server.indexUrl);
  const media = new URL(server.mediaUrl(new URLSearchParams({ u: 'https://cdn.example.org/fixture.png', sourceId: 'data:fixture' })));
  media.searchParams.set('_r', '1791111222333');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(media.href)}; document.body.append(image); await image.decode();
    const workerResult = await new Promise((resolve,reject)=>{ const worker=new Worker('/worker.js'); worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=()=>reject(new Error('worker failed')); });
    const response = await fetch('/fixture.wasm'); await WebAssembly.compileStreaming(response);
    const denied = await fetch('/helper-image?u=https%3A%2F%2Fcdn.example.org%2Ffixture.png');
    return { isolated:crossOriginIsolated, color:getComputedStyle(document.querySelector('#styled')).color, image:[image.naturalWidth,image.naturalHeight], worker:workerResult, denied:denied.status };
  })()`);
  assert.deepEqual(result, { isolated: true, color: 'rgb(17, 34, 51)', image: [1, 1], worker: { isolated: true }, denied: 403 });
  assert.equal(calls, 1);
  console.log(`Passed real ${process.arch} Electron ASAR local HTTP raster decode, CSS, isolated worker, streaming Wasm, and image capability rejection.`);
}).then(async () => {
  window?.destroy(); await server?.stop(); await rm(directory, { recursive: true, force: true }); await rm(`${directory}.asar`, { force: true }); app.exit(0);
}).catch(async error => {
  console.error(error.message); window?.destroy(); await server?.stop(); if (directory) { await rm(directory, { recursive: true, force: true }); await rm(`${directory}.asar`, { force: true }); } app.exit(1);
});
