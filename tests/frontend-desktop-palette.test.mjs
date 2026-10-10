import {browserOptions} from '../scripts/browser-options.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { checkDesktopCommands } from './feature-commands-browser.mjs';
async function browserFixture() {
  const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/frontend/desktop-commands.css"></head><body><aside id="sidebar"><div class="brand">Nyora</div></aside><main id="view"><input id="searchInput"></main><div id="modalRoot"></div><script type="module">
    import {mountDesktopCommands} from '/frontend/desktop-palette.js';
    const services={snapshot:()=>({history:[],favourites:[]})};
    window.__navigationCalls=[];
    window.__unmountDesktopCommands=mountDesktopCommands({router:{navigate(name){window.__navigationCalls.push(name);location.hash='/'+name;}},services,files:{select:async()=>({cancelled:true,books:[]})},bridge:{onCommand(listener){window.__nativeCommand=listener;return()=>{window.__nativeCommand=null;};}}});
  </script></body></html>`;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(await readFile(new URL('../vendor/web/web/styles.css', import.meta.url))); }
      else if (request.url.startsWith('/frontend/')) { response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'application/javascript'); response.end(await readFile(new URL('..'+request.url, import.meta.url))); }
      else response.end(fixture);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(await browserOptions()) });
    const page = await browser.newPage();
    await page.goto(base+'/index.html');
    return {page,base,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};
  } catch(error) { await browser?.close(); await new Promise(resolve => server.close(resolve)); throw error; }
}
test('actual browser Search filters, runs known routes, opens shortcut help and restores keyboard focus', { timeout: 45000 }, async () => {
  const fixture=await browserFixture();
  try {
    assert.equal(await fixture.page.locator('[data-desktop-command-trigger]').count(), 1, 'a visible Search entry point must mount');
    await checkDesktopCommands(fixture.page, fixture.base);
  } finally { await fixture.close(); }
});
test('animated Search keeps a selected action pending until exit and double Enter invokes it once', {timeout:15000}, async()=>{
  const fixture=await browserFixture();const {page}=fixture;
  try {
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('[data-desktop-command-trigger]').click();
    await page.getByRole('combobox').fill('bookmarks');
    const immediate=await page.evaluate(()=>{
      const input=document.querySelector('[role="combobox"]');
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return {calls:window.__navigationCalls.slice(),dialogs:document.querySelectorAll('[role="dialog"]').length};
    });
    assert.deepEqual(immediate.calls,[], 'navigation waits until the visible exit completes');
    assert.equal(immediate.dialogs,1,'exiting Search still blocks underlying reader keys');
    await page.waitForFunction(()=>window.__navigationCalls.length===1);
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(()=>window.__navigationCalls),['bookmarks']);
  }finally{await fixture.close();}
});
test('reduced motion closes Search immediately without animations and restores focus, including a live preference change', {timeout:15000},async()=>{
  const fixture=await browserFixture();const {page}=fixture;
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('[data-desktop-command-trigger]').click();
    const animations=await page.getByRole('dialog').evaluate(node=>node.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length);
    assert.equal(animations,0);
    const immediate=await page.evaluate(()=>{
      document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      return {dialogs:document.querySelectorAll('[role="dialog"]').length,focused:document.activeElement===document.querySelector('[data-desktop-command-trigger]')};
    });
    assert.deepEqual(immediate,{dialogs:0,focused:true});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('[data-desktop-command-trigger]').click();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),0);
  }finally{await fixture.close();}
});
test('rapid Escape and native reopen yields one focused Search, while unmount discards a queued reopen', {timeout:15000},async()=>{
  const fixture=await browserFixture();const {page}=fixture;
  try {
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('[data-desktop-command-trigger]').click();
    const originalDialog=await page.getByRole('dialog').elementHandle();
    await page.evaluate(()=>{
      document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}));
      window.__nativeCommand('palette');window.__nativeCommand('palette');
    });
    await page.waitForFunction(node=>!node.isConnected,originalDialog);
    await page.waitForFunction(()=>document.querySelectorAll('[role="dialog"]').length===1 && document.activeElement===document.querySelector('[role="combobox"]'));
    await page.getByRole('combobox').fill('reading history');
    assert.equal(await page.getByRole('option').count(),1);
    await page.evaluate(()=>{
      document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      window.__nativeCommand('palette');window.__unmountDesktopCommands();
    });
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.waitForTimeout(250);
    assert.equal(await page.getByRole('dialog').count(),0,'detached app cannot reopen from an exit timer');
    assert.equal(await page.locator('[data-desktop-command-trigger]').count(),0);
  }finally{await fixture.close();}
});
