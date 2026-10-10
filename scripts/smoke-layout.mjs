// Layout-only acceptance against existing dist: no frontend/helper build.
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFrontendServer } from './dev-server.mjs';
const project = resolve(import.meta.dirname, '..');
const evidence = process.env.NYORA_LAYOUT_EVIDENCE || resolve(project, 'test-results/frontend-layout');
await mkdir(evidence, { recursive: true });
const server = await createFrontendServer(resolve(project, 'dist'), { port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROMIUM_PATH || await access(chrome).then(() => chrome).catch(() => undefined);
let browser;
const failures = [];
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const width of [320, 390, 760, 900, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addInitScript(() => {
      const source = { id: 'data:ATSUMOE', name: 'Atsu source fixture with long title', lang: 'en', isInstalled: true };
      window.nyoraDesktop = {
        runtimeStatus: async () => ({ runtime: 'electron', browserVersion: 'fixture', electronVersion: '44', profileName: 'preview', verificationAvailable: true }),
        verificationStatus: async () => window.__phase ? [{ sourceId: source.id, phase: window.__phase }] : [],
        openVerification: async () => ({ status: 'opened' }), resetSourceSession: async () => ({ reset: true }),
        serviceRequest: async ({ operation }) => {
          if (operation === 'ui.preferences.get') return {};
          if(operation==='downloads.snapshot')return {entries:[],settings:{format:'CBZ',maxConcurrent:2,imageConcurrency:4,retries:2,keepOffline:true,saveToDevice:false}};
          if(operation==='tracking.capabilities')return {trackers:[]};
          if(operation==='library.readMarks')return {read:[],unread:[]};
          if (operation === 'sources.list') return { sources: [source] };
          if (operation === 'sources.catalog') return { entries: [source, { ...source, id: 'data:OTHER', isInstalled: false }] };
          if (operation === 'library.categories') return { categories: [] };
          if (operation === 'library.stats') return {};
          if (operation === 'library.mangaPrefs') return { present: false };
          if (operation === 'content.details') {
            const chapters = [{ url: 'https://example.org/chapter', title: 'Chapter 1' }];
            return { manga: { id: 'fixture', title: 'Fixture manga', url: 'https://example.org/manga', source: { name: source.id }, chapters }, chapters };
          }
          if (operation === 'content.pages') return { pages: [{ url: location.origin + '/icon-512.png' }] };
          return { entries: [], filters: [] };
        },
      };
    });
    const page = await context.newPage();
    await page.route('https://**/*', route => route.abort());
    for (const [name, route] of [['browse', 'explore?source=data%3AATSUMOE'], ['catalog', 'explore'], ['picker', 'explore?source=data%3AATSUMOE'], ['reader', 'reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fchapter'], ['runtime', 'settings?s=advanced'], ['about','settings?s=about']]) {
      if(name==='about')await page.evaluate(()=>{window.__phase=null;window.dispatchEvent(new Event('focus'));});
      await page.goto(`${base}/#/${route}`);
      await page.locator('#splash').waitFor({ state: 'detached' });
      if (name === 'catalog') { await page.getByRole('button', { name: 'Source catalog', exact: true }).click(); await page.locator('.modal-backdrop.open').waitFor(); }
      if (name === 'picker') { await page.locator('.source-select').click(); await page.locator('.modal-backdrop.open').waitFor(); }
      if (name === 'browse') await page.locator('.browse-head-actions .desktop-verify-source').waitFor();
      if (name === 'reader') {
        await page.locator('img.reader-page').waitFor();
        await page.evaluate(() => { window.__phase = 'verification-required'; document.body.classList.add('reader-immersive'); window.dispatchEvent(new CustomEvent('nyora:native-request-failed')); });
        await page.locator('#desktop-source-status').getByRole('button', { name: 'Verify source', exact: true }).waitFor();
      }
      if (name === 'runtime') {
        await page.locator('#desktop-runtime > summary').click();
        await page.locator('#desktop-runtime').scrollIntoViewIfNeeded();
      }
      if(name==='about'){
        await page.locator('.desktop-about-links').waitFor();
        await page.evaluate(()=>{document.body.classList.remove('nav-open');document.getElementById('view').scrollTop=0;window.scrollTo(0,0);});
        for(const link of await page.locator('.desktop-about-links a').all()){
          assert(await link.evaluate(link=>{const r=link.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===link||link.contains(hit);}), 'About links remain actionable on narrow screens');
        }
      }
      await page.waitForTimeout(220); // Finish the shared modal opacity transition before capture.
      const result = await page.evaluate(() => {
        const selectors = ['.browse-head-actions', '.ext-row', '.source-row', '#desktop-source-status', '.desktop-runtime-body','.desktop-about-links'];
        const visible = element => (!element.closest('details') || element.closest('details').open) && !!(element.getBoundingClientRect().width && element.getBoundingClientRect().height);
        const controls = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).map(element => ({
          selector, width: element.clientWidth, scrollWidth: element.scrollWidth,
          buttons: [...element.querySelectorAll('button,a')].filter(visible).map(button => ({ text: button.textContent, themed: button.classList.contains('btn') || !!button.closest('.seg'), left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right, height: button.getBoundingClientRect().height })),
        })));
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, controls };
      });
      await page.screenshot({ path: resolve(evidence, `${name}-${width}.png`) });
      const issues = [];
      if (result.documentWidth > width + 1) issues.push(`document width ${result.documentWidth}`);
      for (const control of result.controls) {
        if (control.scrollWidth > control.width + 1) issues.push(`${control.selector} overflow ${control.scrollWidth} > ${control.width}`);
        for (const button of control.buttons) {
          if (!button.themed) issues.push(`${control.selector} unthemed ${button.text}`);
          if (button.right > width + 1 || button.left < -1) issues.push(`${control.selector} button outside viewport: ${button.text}`);
          if (button.height < 30) issues.push(`${control.selector} undersized ${button.text}`);
        }
      }
      if (issues.length) failures.push(`${name} ${width}px: ${issues.join('; ')}`);
      if (name === 'catalog' || name === 'picker') { await page.locator('.modal-backdrop.open').getByRole('button', { name: 'Close', exact: true }).click(); await page.locator('.modal-backdrop').waitFor({ state: 'detached' }); }
    }
    await context.close();
  }
  assert.deepEqual(failures, [], 'Desktop controls must retain shared styling and fit responsive source/reader layouts');
  console.log(`Passed 30 desktop control/About layout scenarios. Screenshots: ${evidence}`);
} finally {
  if (browser) await browser.close();
  await new Promise(done => server.close(done));
}
