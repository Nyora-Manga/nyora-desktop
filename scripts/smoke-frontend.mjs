import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildFrontend, desktopRoot } from './build-frontend.mjs';
import { createFrontendServer } from './dev-server.mjs';
import { checkReadingRoom } from '../tests/feature-reading-room-browser.mjs';
import { checkLibraryTools } from '../tests/feature-library-browser.mjs';
import { checkDesktopCommands, checkDesktopReaderCommandBoundary } from '../tests/feature-commands-browser.mjs';
import { checkDownloadControls } from '../tests/feature-downloads-browser.mjs';

const out = process.argv.includes('--no-build') ? resolve(desktopRoot, 'dist') : await buildFrontend();
const noticeEvidence=resolve(desktopRoot,'test-results/source-notices');await mkdir(noticeEvidence,{recursive:true});
const assets = await createFrontendServer(out, { port: 0 });
const imageRequests = [];
let blockReaderImage = false;
let automaticImageFailures=0,automaticImageDelay=120;
let offlinePage=0;
let offlinePreferences;
const knownPng = await readFile(resolve(out, 'icon-512.png'));
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if(url.pathname==='/fixture-offline-progress' && request.method==='POST'){
    let body='';for await(const bytes of request)body+=bytes;
    const patch=JSON.parse(body);
    if(patch.page !== undefined)offlinePage=patch.page;
    if(patch.prefs !== undefined)offlinePreferences=patch.prefs;
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({saved:true}));return;
  }
  if(url.pathname==='/fixture-offline-book'){
    const id='00000000-0000-4000-8000-000000000001';
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id,title:'Offline fixture',chapterTitle:'Offline chapter',state:{page:offlinePage,prefs:offlinePreferences},pageCount:2,pages:[0,1].map(index=>({index,contentType:'image/png',url:`http://${request.headers.host}/local-media/${id}/${index}?cap=synthetic-offline-cap`}))}));return;
  }
  if (/^\/local-media\/[a-f0-9-]{36}\/\d+$/.test(url.pathname)) {
    if(url.searchParams.get('cap') !== 'synthetic-offline-cap') {response.writeHead(403);response.end();return;}
    response.writeHead(200,{'Content-Type':'image/png','Cross-Origin-Resource-Policy':'same-origin'});response.end(knownPng);return;
  }
  if (url.pathname === '/helper-image') {
    imageRequests.push(url);
    if (url.searchParams.get('cap') !== 'synthetic-media-cap' || url.searchParams.get('sourceId') !== 'data:ATSUMOE') { response.writeHead(403); response.end(); return; }
    if(url.searchParams.get('u')==='https://example.org/auto-page.png'){
      const failed=automaticImageFailures>0;if(failed)automaticImageFailures--;
      await new Promise(done=>setTimeout(done,automaticImageDelay));
      if(failed){response.writeHead(502,{'Cache-Control':'no-store'});response.end();return;}
    }
    if (blockReaderImage && url.searchParams.get('u') === 'https://example.org/blocked-page.png') { await new Promise((done) => setTimeout(done, 300)); response.writeHead(403); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' }); response.end(knownPng); return;
  }
  const upstream = await fetch(`http://127.0.0.1:${assets.address().port}${request.url}`);
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROMIUM_PATH || (await access(systemChrome).then(() => systemChrome).catch(() => undefined));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const native of [false, true]) {
    const context = await browser.newContext();
    const errors = [], forbiddenRequests = [];
    await context.addInitScript(({ native }) => {
      // Any browser personal-storage access is a failing test, including boot.
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Forbidden browser storage access'); } });
      Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Forbidden browser database access'); } });
      window.__desktopCalls = [];
      if (native) {
        let favourites = [], prefs = {}, jobs=[], books=[], marks={}, titlePrefs={}, account={isConfigured:true,isAuthenticated:false,email:'',lastSyncTimestamp:''}, trackerConnected=false;
        const bookId='00000000-0000-4000-8000-000000000001';
        const offlineBook=()=>({id:bookId,title:'Offline fixture',chapterTitle:'Offline chapter',page:0,pageCount:2,pages:[0,1].map(index=>({index,contentType:'image/png',url:`${location.origin}/local-media/${bookId}/${index}?cap=synthetic-offline-cap`}))});
        const downloadSettings={format:'CBZ',maxConcurrent:2,imageConcurrency:4,retries:2,keepOffline:true,saveToDevice:false};
        const imageUrl = (name) => `${location.origin}/helper-image?u=${encodeURIComponent('https://example.org/' + name)}&sourceId=data%3AATSUMOE&cap=synthetic-media-cap`;
        const manga = { coverUrl: imageUrl('cover.png'), id: 'native:synthetic', title: 'Synthetic Native Title', url: 'https://example.org/manga', source: { name: 'data:ATSUMOE' }, chapters: [{ id: 'https://example.org/chapter', url: 'https://example.org/chapter', title: 'Chapter 1', number: 1 }] };
        const methods = {
          runtimeStatus: () => ({ appVersion: '0.2.0', runtime: 'electron', browserVersion: 'fixture-152', electronVersion: 'fixture-44', profileName: 'local', verificationAvailable: true, dataMode: 'native-helper' }),
          verificationStatus: () => [...(window.__extraVerifications || []),...(window.__verificationPhase ? [{ sourceId: window.__verificationSource || 'data:ATSUMOE', origin: 'https://example.org', phase: window.__verificationPhase, cookies: window.__cookies, verificationId: window.__verificationId, manual: !!window.__manual }] : [])],
          openVerification: ({ sourceId }) => { window.__verificationSource = sourceId; window.__verificationPhase = 'verification-opened'; window.__verificationId = `fixture-${window.__openSequence = (window.__openSequence || 0) + 1}`; return { sessionId: 'synthetic-session', status: 'opened' }; },
          resetSourceSession: () => { window.__verificationPhase = null; return { reset: true }; },
          saveSourceCookies: () => {
            if (window.__failCookieSave) { window.__cookies = { state: 'failed' }; throw new Error('Synthetic cookie save rejected'); }
            window.__cookies = { state: 'saved', savedAt: Date.now(), persistentCookies: 1, sessionCookies: 2 };
            return window.__cookies;
          },
          backupExport: () => ({ status: 'cancelled' }),
          backupImport: () => ({ status: 'cancelled' }),
          serviceRequest: ({ operation, params }) => {
            if(operation==='downloads.snapshot')return {entries:window.__featureJobs || jobs,settings:downloadSettings,queuePaused:Boolean(window.__queuePaused)};
            if(['downloads.pause','downloads.resume','downloads.retryFailed'].includes(operation)){
              if(window.__rejectDownloadMutation)throw new Error('Fixture download state save failed');
              if(operation==='downloads.pause'||operation==='downloads.resume'){window.__queuePaused=operation==='downloads.pause';return {queuePaused:window.__queuePaused};}
              let requeued=0,verificationRequired=0;
              for(const job of window.__featureJobs || jobs){if(job.status!=='FAILED')continue;if(job.errorCode==='SOURCE_VERIFICATION_REQUIRED'){verificationRequired++;continue;}job.status='QUEUED';job.error='';job.errorCode='';requeued++;}
              return {requeued,verificationRequired};
            }
            if(operation==='downloads.enqueue'){jobs=params.descriptors.map((descriptor,index)=>({...descriptor,id:'job-'+index,status:'COMPLETED',totalPages:2,completedPages:2,failedPages:0,bytes:1000,offline:true,startedAt:Date.now(),finishedAt:Date.now()}));return {added:jobs.length,requeued:0,skipped:0};}
            if(operation==='downloads.open'||operation==='local.open')return fetch('/fixture-offline-book').then(response=>response.json());
            if(operation==='downloads.export'||operation==='downloads.exportBundle')return {cancelled:true};
            if(operation==='downloads.settings.save'){Object.assign(downloadSettings,params.patch);return downloadSettings;}
            if(operation==='local.list')return {books};
            if(operation==='local.select'){books=[{id:bookId,title:'Imported local fixture',pageCount:2}];return {status:'selected',books};}
            if(operation==='local.progress'){if(params.prefs&&window.__rejectLocalPreferences)throw new Error('Fixture offline preference save failed');return fetch('/fixture-offline-progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)}).then(response=>response.json());}
            if(operation==='library.readMarks')return marks[params.mangaId]||{read:[],unread:[]};
            if(operation==='library.readMarksSave'){marks[params.mangaId]={read:params.read,unread:params.unread};return {saved:true};}
            if(operation==='library.mangaPrefsSave'){titlePrefs[params.mangaId]={...params,present:true};return {ok:true};}
            if(operation==='sync.status')return account;
            if(operation==='sync.signIn'||operation==='sync.register'){if(window.__rejectAccount)throw new Error('Synthetic account rejected');account={...account,isAuthenticated:true,email:params.email};return account;}
            if(operation==='sync.now'){account.lastSyncTimestamp=new Date().toISOString();return {ok:true};}
            if(operation==='sync.signOut'){account={...account,isAuthenticated:false,email:''};return account;}
            if(operation==='tracking.capabilities')return {trackers:[{slug:'anilist',name:'AniList',auth:'access-token',available:true,connected:trackerConnected,enabled:true,links:{}},{slug:'myanimelist',name:'MyAnimeList',available:false,reason:'Desktop OAuth callback is not configured.'},{slug:'mangabaka',name:'MangaBaka',available:false,reason:'Desktop OAuth callback is not configured.'}]};
            if(operation==='tracking.connect'){if(window.__rejectTracker)throw new Error('Synthetic tracker rejected');trackerConnected=true;return {ok:true};}
            if(operation==='tracking.disconnect'){trackerConnected=false;return {ok:true};}
            if(operation==='tracking.scrobble')return {updated:[],skipped:true};
            if (operation === 'ui.preferences.get') return prefs;
            if (operation === 'ui.preferences.save') { if (window.__failWrites) throw new Error('Synthetic native write rejected'); prefs = { ...prefs, ...params.patch }; return prefs; }
            if (operation === 'sources.list') return { sources: window.__featureSources || [{ id: 'data:ATSUMOE', name: 'Synthetic', lang: 'en', isInstalled: true, isPinned: false, isNsfw: false }, { id: 'data:OTHER', name: 'Other Synthetic', lang: 'en', isInstalled: true, isNsfw: false }] };
            if (operation === 'sources.catalog') return { entries: [{ id: 'data:ATSUMOE', name: 'Synthetic', lang: 'en', isInstalled: true, isNsfw: false }, { id: 'data:CF_ONLY', name: 'Protected catalog fixture', lang: 'en', isInstalled: false, isNsfw: false, isCfProtected: true },...['Manhuauss','ManhwaFull','Philia'].map(name=>({id:'data:'+name.toUpperCase(),name,lang:'en',isInstalled:false,isCfProtected:true}))] };
            if (operation === 'library.categories') return { categories: window.__featureCategories || [] };
            if (operation === 'library.history') return { entries: window.__featureHistory || [] };
            if (operation === 'library.categoryManga') return { entries: window.__featureCategoryEntries?.[params.categoryId] || [] };
            if (operation === 'library.stats') return { totalChapters: 0, distinctManga: 0, favouritesCount: favourites.length, topSources: [] };
            if (operation === 'library.favourites') return { entries: window.__featureFavourites || favourites };
            if (operation === 'library.favouriteToggle') { if (window.__failWrites) throw new Error('Synthetic native write rejected'); favourites = favourites.length ? [] : [manga]; return { favourited: favourites.length > 0 }; }
            if (operation === 'library.mangaPrefs') return titlePrefs[params.mangaId]||{ present: false };
            if (operation === 'content.details') {
              if (window.__networkFailure && window.__canAccess) throw new Error('Synthetic source network unavailable');
              if (window.__challengeRequired) { if (!window.__canAccess) { window.__manual = false; window.__verificationPhase = 'verification-required'; throw new Error('Synthetic source verification required'); } window.__challengeRequired = false; window.__verificationPhase = null; }
              return { manga, chapters: manga.chapters };
            }
            if (operation === 'content.search') {
              if (window.__searchChallenge && !window.__canAccess) { window.__manual = false; window.__verificationPhase = 'verification-required'; throw new Error('Synthetic source verification required'); }
              if (window.__searchChallenge) { window.__searchChallenge = false; window.__verificationPhase = null; }
              return { entries: [manga], hasNextPage: false };
            }
            if (operation === 'content.popular' && window.__manual && window.__verificationPhase === 'retry-required') { window.__verificationPhase = null; return { entries: [manga] }; }
            if (operation === 'sources.filters') return { filters: [] };
            if (operation === 'content.pages') { if (window.__mediaChallenge) window.__verificationPhase = 'verification-required'; return { pages: [{ url: imageUrl(window.__automaticImage ? 'auto-page.png' : window.__mediaChallenge ? 'blocked-page.png' : 'page.png') }, { url: imageUrl('loaded-page.png') }] }; }
            return { entries: [] };
          },
        };
        window.nyoraDesktop = Object.freeze(Object.fromEntries(Object.entries(methods).map(([command, result]) => [command, async (args) => {
          window.__desktopCalls.push({ command, args });
          if(command==='verificationStatus' && window.__delayStatusPoll)await new Promise(done=>setTimeout(done,1500));
          if (command === 'serviceRequest' && window.__delayRecovery && window.__canAccess && window.__verificationPhase === 'retry-required' && args.operation.startsWith('content.')) await new Promise(done => setTimeout(done, 350));
          return result(args);
        }])));
      }
    }, { native });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/sync\.nyora\.xyz|api\.nyora\.xyz|127\.0\.0\.1:8788/.test(request.url())) forbiddenRequests.push(request.url()); });
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
    const metadataItem = { id: 123, title: { english: 'Public Metadata Fixture' }, coverImage: { large: 'https://s4.anilist.co/fixture-cover.png' }, bannerImage: 'https://s4.anilist.co/fixture-banner.png', genres: ['Action'], averageScore: 80 };
    const metadataFeed = { trending: [metadataItem, { ...metadataItem, id: 124 }], manhwa: [], manhua: [], manga: [], action: [], romance: [], fantasy: [] };
    await page.route(`${base}/discover-feed.json`, (route) => route.fulfill({ json: { at: Date.now(), feed: metadataFeed } }));
    await page.route('https://graphql.anilist.co/**', (route) => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { data: Object.fromEntries(Object.entries(metadataFeed).map(([key, media]) => [key, { media }])) } }));
    await page.route(/^https:\/\/(s4\.anilist\.co|cdn\.mangabaka\.dev)\/fixture-/, (route) => route.fulfill({ body: knownPng, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://api.mangabaka.org/**', (route) => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { status: 200, data: [{ id: 321, title: 'MangaBaka Fixture', state: 'active', cover: { x350: { x1: 'https://cdn.mangabaka.dev/fixture-cover.png' } }, popularity: { global: { current: 1 } } }] } }));
    await page.goto(`${base}/#/library`);
    assert.equal(await page.evaluate(() => NYORA_DESKTOP.mode), 'desktop');
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    assert.equal(await page.locator('link[rel="manifest"]').count(), 0);
    if (!native) {
      await page.getByRole('heading', { name: 'Native data unavailable' }).waitFor();
      await page.getByRole('button', { name: 'Retry native connection' }).click();
      await page.getByRole('heading', { name: 'Native data unavailable' }).waitFor();
      assert.equal(await page.locator('#sidebar [data-route="library"]').count(), 0);
      assert.equal(await page.locator('.desktop-community-links').isVisible(),false,'community links stay hidden before native preferences hydrate');
    } else {
      await page.locator('#sidebar [data-route="library"]').waitFor();
      await checkReadingRoom(page, base);
      await checkLibraryTools(page, base);
      await checkDesktopCommands(page, base);
      await checkDownloadControls(page, base);
      await page.locator('#toast').waitFor({state:'hidden'});
      console.log('PASS desktop quick actions/help; library search/filter/sort/category identity and responsive layout; confirmed queue pause/retry and polling focus');
      await page.goto(`${base}/#/settings?s=about`);
      const about=page.locator('#view .about-section');await about.waitFor();
      assert.equal(await about.locator('a').count(),4,'About offers one useful link set without duplicate social actions');
      const capturedVersion=JSON.parse(await readFile(resolve(out,'frontend-manifest.json'),'utf8')).appVersion;
      assert(await about.getByText(`Version ${capturedVersion}`,{exact:true}).isVisible(),'About displays this captured desktop build version');
      assert.equal(await about.locator('.social-link').count(),0,'About has no duplicate icon row');
      assert.equal(await about.getByRole('link',{name:'Discord',exact:true}).count(),1,'About has one Discord link');
      assert.deepEqual(await about.locator('a').evaluateAll(links=>links.map(link=>[link.textContent,link.href])),[['Website','https://nyora.xyz/'],['Project on GitHub','https://github.com/Nyora-Manga'],['Discord','https://discord.gg/3ZBHA8RtbR'],['License','https://www.apache.org/licenses/LICENSE-2.0']],'About uses audited desktop resources rather than a different client’s issue tracker');
      for(const link of await about.getByRole('link').all()){
        assert.equal(await link.getAttribute('target'),'_blank');assert((await link.getAttribute('rel')).includes('noopener'));
        assert((await link.getAttribute('title')).includes('opens in your browser'));
      }
      await about.getByRole('link',{name:'Website',exact:true}).focus();
      await page.keyboard.press('Tab');
      assert(await about.getByRole('link',{name:'Project on GitHub',exact:true}).evaluate(link=>link===document.activeElement),'About links support normal keyboard navigation');
      await page.locator('#sidebar [data-route="settings"]').click();
      await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
      await page.goto(`${base}/#/library`);
      assert.equal(await page.locator('#sidebar #desktop-runtime').count(),0);
      assert.equal(await page.locator('#sidebar .nav-item-community').count(),0,'Discord is not duplicated in navigation');
      assert.equal(await page.locator('.desktop-community-links').isVisible(),false,'community links belong in About, not the desktop header');
      await page.locator('#sidebar [data-route="settings"]').click();
      await page.goto(`${base}/#/settings?s=appearance`);
      assert.equal(await page.getByText('Community links',{exact:true}).count(),0,'obsolete header visibility control is removed');
      await page.evaluate(()=>{
        window.__extraVerifications=['MANHUAUSS','MANHWAFULL','PHILIA'].map(name=>({sourceId:'data:'+name,phase:'verification-required',verificationId:'unrelated-'+name}));
        location.hash='/details?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga';window.dispatchEvent(new Event('focus'));
      });
      await page.getByRole('heading',{name:'Synthetic Native Title',exact:true}).waitFor();
      await page.waitForFunction(()=>document.getElementById('desktop-source-status').hidden);
      await page.evaluate(()=>{document.body.classList.remove('nav-open');document.getElementById('sidebar').scrollTop=0;document.getElementById('view').scrollTop=0;window.scrollTo(0,0);});
      await page.screenshot({path:resolve(noticeEvidence,'details-unrelated-hidden-1280.png')});
      await page.evaluate(()=>{window.__verificationPhase='verification-required';window.__verificationSource='data:ATSUMOE';window.__verificationId='scope-cycle-1';window.dispatchEvent(new Event('focus'));});
      const scopedNotice=page.locator('#desktop-source-status');
      await scopedNotice.getByText('Synthetic: Source verification required.',{exact:true}).waitFor();
      assert.equal(await scopedNotice.locator('.desktop-source-row').count(),1,'three unrelated checks cannot stack above a manga');
      assert.equal(await scopedNotice.locator('.desktop-source-list').count(),0);
      assert((await scopedNotice.boundingBox()).height<120,'current-source notice remains compact');
      await page.screenshot({path:resolve(noticeEvidence,'details-active-compact-1280.png')});
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(()=>{document.body.classList.remove('nav-open');document.getElementById('sidebar').scrollTop=0;document.getElementById('view').scrollTop=0;window.scrollTo(0,0);});
      await page.waitForTimeout(300); // Let the shared mobile sidebar transition finish before capture.
      for(const button of await scopedNotice.locator('button').all()){
        assert((await button.boundingBox()).height>=30);
        assert(await button.evaluate(button=>{const r=button.getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return target===button||button.contains(target);}), 'source controls must remain actionable without mobile navigation occlusion');
      }
      await page.screenshot({path:resolve(noticeEvidence,'details-active-compact-390.png')});
      await page.setViewportSize({width:1280,height:720});
      await page.waitForTimeout(220);
      await scopedNotice.getByRole('button',{name:'Hide Synthetic source notice',exact:true}).press('Enter');
      await page.waitForFunction(()=>document.getElementById('desktop-source-status').hidden);
      assert.equal(await page.evaluate(()=>window.__verificationPhase),'verification-required','dismissal cannot clear native pending proof');
      await page.waitForTimeout(900);assert.equal(await scopedNotice.isVisible(),false,'unchanged polling cannot undo dismissal');
      await page.evaluate(()=>{window.__delayStatusPoll=true;location.hash='/details?sid=data%3AMANHUAUSS&url=https%3A%2F%2Fexample.org%2Fmanga';});
      await scopedNotice.getByText('Manhuauss: Source verification required.',{exact:true}).waitFor({timeout:700});
      assert.equal(await scopedNotice.locator('.desktop-source-row').count(),1,'route visibility refreshes without waiting for native poll');
      await page.evaluate(()=>{location.hash='/downloads';});
      await scopedNotice.locator('.desktop-source-list > summary').filter({hasText:'Source checks (3)'}).waitFor({timeout:700});
      assert.equal(await scopedNotice.locator('.desktop-source-list').evaluate(group=>group.open),false,'aggregate starts collapsed');
      assert((await scopedNotice.boundingBox()).height<70,'aggregate cannot become a giant stack');
      await page.screenshot({path:resolve(noticeEvidence,'downloads-collapsed-summary-1280.png')});
      await scopedNotice.locator('.desktop-source-list > summary').click();
      assert.equal(await scopedNotice.getByRole('button',{name:'Verify source',exact:true}).count(),3,'downloads retains direct verification access');
      await scopedNotice.getByRole('button',{name:'Hide source notices',exact:true}).press('Space');
      await page.waitForFunction(()=>document.getElementById('desktop-source-status').hidden);
      assert.equal(await page.evaluate(()=>window.__extraVerifications.length),3,'aggregate dismissal retains every native session');
      await page.evaluate(()=>{window.__delayStatusPoll=false;window.__verificationId='scope-cycle-2';location.hash='/details?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga';window.dispatchEvent(new Event('focus'));});
      await scopedNotice.getByText('Synthetic: Source verification required.',{exact:true}).waitFor();
      await page.evaluate(()=>{window.__extraVerifications=[];window.__verificationPhase=null;window.dispatchEvent(new Event('focus'));});
      await page.waitForFunction(()=>document.getElementById('desktop-source-status').hidden);
      await page.goto(`${base}/#/settings?s=advanced`);
      await page.locator('#desktop-runtime > summary').click();
      await page.getByRole('status').filter({ hasText: 'Chromium fixture-152' }).waitFor();
      await page.getByLabel('Source', { exact: true }).selectOption('data:ATSUMOE');
      await page.getByRole('button', { name: 'Open website', exact: true }).first().click();
      await page.getByRole('status').filter({ hasText: 'Website opened.' }).waitFor();
      assert(!(await page.locator('#desktop-runtime [role="status"]').textContent()).includes('solved'));
      assert.equal(await page.getByRole('button', { name: 'Save cookies', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Reset this source session' }).click();
      await page.getByRole('status').filter({ hasText: 'Source session reset.' }).waitFor();
      const calls = await page.evaluate(() => window.__desktopCalls);
      assert.deepEqual(calls.find((call) => call.command === 'openVerification').args, { sourceId: 'data:ATSUMOE', url: undefined });
      await page.goto(`${base}/#/explore`);
      await page.getByRole('button', { name: 'Source catalog', exact: true }).click();
      const protectedRow = page.locator('.ext-row').filter({ hasText: 'Protected catalog fixture' });
      await protectedRow.getByRole('button', { name: 'Install', exact: true }).waitFor();
      await page.evaluate(() => { window.__manual = true; });
      await protectedRow.getByRole('button', { name: 'Open website', exact: true }).click();
      assert.deepEqual((await page.evaluate(() => window.__desktopCalls.filter((call) => call.command === 'openVerification').at(-1))).args, { sourceId: 'data:CF_ONLY', url: undefined });
      await page.locator('#desktop-source-status').getByText('Protected catalog fixture: Website open.', { exact: true }).waitFor();
      await page.locator('.modal-backdrop.open').getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('.modal-backdrop.open').waitFor({ state: 'detached' });
      await page.evaluate(() => { window.__verificationPhase = 'retry-required'; window.__cookies = { state: 'saved' }; window.dispatchEvent(new Event('focus')); });
      await page.waitForFunction(() => window.__verificationPhase === null);
      await page.evaluate(() => { window.__verificationSource = 'data:ATSUMOE'; window.__manual = false; });
      await page.goto(`${base}/#/explore?source=data%3AATSUMOE`);
      await page.locator('.browse-head').getByRole('button', { name: 'Open website', exact: true }).waitFor();
      for (const [route, heading] of [['settings?s=sync', 'Cloud Sync'], ['settings?s=backup', 'Portable backup'], ['settings?s=downloads', 'Downloads'], ['settings?s=tracking', 'Tracking'], ['local', 'Local'], ['downloads', 'Downloads']]) {
        await page.goto(`${base}/#/${route}`); await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
      }
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.goto(`${base}/#/settings?s=sync`);
      await page.getByRole('textbox',{name:'Email',exact:true}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'Cloud Sync',exact:true}).count(),1,'Cloud Sync has a single heading');
      for(const [width,height] of [[1440,900],[860,600]]){
        await page.setViewportSize({width,height});
        const form=await page.locator('.desktop-sync-form').boundingBox();
        assert(form.width<=461,'Account form stays at a readable width');
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Account form fits the window');
        await page.screenshot({path:resolve(desktopRoot,'test-results/reading-room/cloud-sync-'+width+'.png'),animations:'disabled'});
      }
      await page.setViewportSize({width:1280,height:720});
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.getByPlaceholder('Email',{exact:true}).fill('fixture@example.org');
      await page.getByPlaceholder('Password',{exact:true}).fill('fixture-only-password');
      await page.evaluate(()=>{window.__rejectAccount=true;});
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Synthetic account rejected'}).waitFor();
      assert.equal(await page.getByPlaceholder('Password',{exact:true}).inputValue(),'');
      await page.evaluate(()=>{window.__rejectAccount=false;});
      await page.getByPlaceholder('Password',{exact:true}).fill('fixture-only-password');
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByText('Signed in as fixture@example.org',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Merge and sync',exact:true}).click();
      await page.getByText('Library synced',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Sign out',exact:true}).click();
      await page.getByPlaceholder('Email',{exact:true}).waitFor();
      await page.goto(`${base}/#/settings?s=tracking`);
      await page.getByPlaceholder('AniList access token',{exact:true}).fill('fixture-token-not-real');
      await page.evaluate(()=>{window.__rejectTracker=true;});
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      await page.getByText('Synthetic tracker rejected',{exact:true}).waitFor();
      assert.equal(await page.getByPlaceholder('AniList access token',{exact:true}).inputValue(),'');
      await page.evaluate(()=>{window.__rejectTracker=false;});
      await page.getByPlaceholder('AniList access token',{exact:true}).fill('fixture-token-not-real');
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      await page.getByRole('button',{name:'Disconnect',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Connect',exact:true}).count(),0,'unconfigured providers cannot pretend to connect');
      await page.goto(`${base}/#/local`);
      await page.getByRole('button',{name:'Open archive',exact:true}).click();
      await page.getByText('Imported local fixture',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Read',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('img.reader-page')?.naturalWidth===512);
      assert(await page.evaluate(()=>document.querySelector('img.reader-page').src.includes('/local-media/')));
      await page.waitForFunction(()=>window.__desktopCalls.some(call=>call.command==='serviceRequest'&&call.args.operation==='local.progress'&&call.args.params.id==='00000000-0000-4000-8000-000000000001'));
      await page.locator('img.reader-page[data-page="1"]').evaluate(image=>image.scrollIntoView({block:'start'}));
      await page.waitForFunction(()=>window.__desktopCalls.some(call=>call.command==='serviceRequest'&&call.args.operation==='local.progress'&&call.args.params.page===1));
      await page.reload();
      await page.waitForFunction(()=>document.querySelector('img.reader-page')?.naturalWidth===512);
      assert(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('local')==='00000000-0000-4000-8000-000000000001');
      await page.waitForFunction(()=>window.__desktopCalls.some(call=>call.command==='serviceRequest'&&call.args.operation==='local.progress'&&call.args.params.page===1));
      await page.locator('#view').getByRole('button',{name:'Settings',exact:true}).click();
      const localInvert=page.locator('.modal-backdrop.open .field').filter({has:page.getByText('Invert',{exact:true})}).locator('input[type="range"]');
      await localInvert.evaluate(input=>{input.value='0.5';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.evaluate(()=>{window.__rejectLocalPreferences=true;});
      await page.locator('.modal-backdrop.open').getByRole('button',{name:'Done',exact:true}).click();
      await page.getByText('Fixture offline preference save failed',{exact:true}).waitFor();
      assert.equal(await page.locator('.modal-backdrop.open').count(),1,'failed local preference save must keep its settings open');
      await page.evaluate(()=>{window.__rejectLocalPreferences=false;});
      await page.locator('.modal-backdrop.open').getByRole('button',{name:'Done',exact:true}).click();
      await page.locator('.modal-backdrop.open').waitFor({state:'detached'});
      assert.equal(offlinePreferences.invert,0.5);assert.equal(offlinePreferences.mangaId,undefined,'offline prefs never send a helper manga identity');
      await page.reload();
      await page.waitForFunction(()=>document.querySelector('img.reader-page')?.naturalWidth===512);
      assert.equal(await page.locator('img.reader-page').first().evaluate(image=>Number(/invert\(([^)]+)\)/.exec(image.style.filter)?.[1])),0.5);
      await page.waitForFunction(()=>window.__desktopCalls.some(call=>call.command==='serviceRequest'&&call.args.operation==='local.progress'&&call.args.params.page===1));
      await page.goto(`${base}/#/settings?s=backup`);
      await page.getByRole('button', { name: 'Create backup', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Backup cancelled.' }).waitFor();
      await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Backup cancelled.' }).waitFor();
      await page.goto(`${base}/#/details?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga`);
      await page.getByRole('heading', { name: 'Synthetic Native Title', exact: true }).waitFor();
      await page.waitForFunction(() => { const image = document.querySelector('.d2-cover-media'); return image?.complete && image.naturalWidth === 512; });
      const favourite = page.getByRole('button', { name: 'Add to library', exact: true });
      await favourite.click();
      await page.getByRole('button', { name: 'In library', exact: true }).waitFor();
      await page.getByRole('button',{name:'Mark',exact:true}).click();
      await page.getByText('Mark all as read',{exact:true}).click();
      await page.getByText('Marked all read',{exact:true}).waitFor();
      const markWrites=await page.evaluate(()=>window.__desktopCalls.filter(call=>call.command==='serviceRequest'&&call.args.operation==='library.readMarksSave'));
      assert.equal(markWrites.length,1);assert.deepEqual(markWrites[0].args.params.read,['https://example.org/chapter']);
      await page.getByRole('button',{name:'Download',exact:true}).first().click();
      await page.locator('.modal-backdrop.open').waitFor();
      await page.locator('.modal-backdrop.open').getByText('All',{exact:true}).click();
      await page.locator('.modal-backdrop.open .dl-footer').getByRole('button',{name:'Download 1',exact:true}).click();
      await page.getByRole('heading',{name:'Downloads',exact:true}).waitFor();
      await page.getByRole('button',{name:'Read offline',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('img.reader-page')?.naturalWidth===512);
      assert(await page.evaluate(()=>document.querySelector('img.reader-page').src.includes('/local-media/')));
      await page.goto(`${base}/#/details?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga`);
      await page.getByRole('button',{name:'In library',exact:true}).waitFor();
      await page.evaluate(() => { window.__failWrites = true; });
      await page.getByRole('button', { name: 'In library', exact: true }).click();
      await page.getByText('Synthetic native write rejected', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: 'In library', exact: true }).waitFor();
      await page.evaluate(() => { window.__failWrites = false; window.__canAccess = false; window.__challengeRequired = true; window.__verificationPhase = 'verification-required'; window.__verificationId = undefined; });
      await page.goto(`${base}/#/details?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fanother`);
      await page.locator('#desktop-source-status').getByText('Synthetic: Source verification required.', { exact: true }).waitFor();
      await page.locator('#desktop-source-status').getByRole('button', { name: 'Verify source', exact: true }).click();
      const sourceNotice = page.locator('#desktop-source-status');
      await sourceNotice.getByText('Synthetic: Complete the check in the website window.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save cookies', exact: true }).count(), 0);
      const readsBeforeClose = await page.evaluate(() => window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation === 'content.details').length);
      await page.evaluate(() => { window.__verificationPhase = 'retry-required'; window.__cookies = { state: 'saving' }; window.dispatchEvent(new Event('focus')); });
      await sourceNotice.getByText('Synthetic: Saving your session…', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation === 'content.details').length), readsBeforeClose);
      // A continued challenge gets one automatic attempt, never a popup or loop.
      await page.evaluate(() => { window.__cookies = { state: 'saved' }; window.dispatchEvent(new Event('focus')); });
      await sourceNotice.getByText('Synthetic: Source verification required.', { exact: true }).waitFor();
      const continued = await page.evaluate(() => ({ reads: window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation === 'content.details').length, opens: window.__openSequence }));
      assert.equal(continued.reads, readsBeforeClose + 1);
      await sourceNotice.getByRole('button', { name: 'Verify source', exact: true }).focus();
      await page.evaluate(() => { window.__focusedVerification = document.activeElement; });
      await page.waitForTimeout(1600);
      assert.deepEqual(await page.evaluate(() => ({ reads: window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation === 'content.details').length, opens: window.__openSequence })), continued);
      assert(await page.evaluate(() => document.activeElement === window.__focusedVerification && window.__focusedVerification.isConnected), 'unchanged polls retain focused control');
      await sourceNotice.getByRole('button', { name: 'Verify source', exact: true }).click();
      await sourceNotice.getByText('Synthetic: Complete the check in the website window.', { exact: true }).waitFor();
      // Ordinary source failures must offer Try again, rather than another CF claim.
      await page.evaluate(() => { window.__canAccess = true; window.__networkFailure = true; window.__delayRecovery = true; window.__verificationPhase = 'retry-required'; window.dispatchEvent(new Event('focus')); });
      await sourceNotice.getByText('Synthetic: Checking source access…', { exact: true }).waitFor();
      await sourceNotice.getByText('Synthetic: Could not load this source. Try again.', { exact: true }).waitFor();
      assert.equal(await sourceNotice.getByRole('button', { name: 'Verify source', exact: true }).count(), 0);
      const opensBeforeRetry = await page.evaluate(() => window.__openSequence);
      await page.evaluate(() => { window.__networkFailure = false; });
      await sourceNotice.getByRole('button', { name: 'Try again', exact: true }).click();
      await sourceNotice.getByText('Synthetic: Checking source access…', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Synthetic Native Title', exact: true }).waitFor();
      await sourceNotice.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.__openSequence), opensBeforeRetry);
      // Recover the exact failed source SEARCH in place, preserving its query
      // and view instead of navigating back to the default Popular mode.
      await page.evaluate(() => { window.__canAccess = false; window.__searchChallenge = true; window.__verificationId = undefined; });
      await page.goto(`${base}/#/explore?source=data%3AATSUMOE`);
      await page.locator('.browse-head-actions').getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByPlaceholder('Search this source…', { exact: true }).fill('original fixture query');
      await page.getByPlaceholder('Search this source…', { exact: true }).press('Enter');
      await sourceNotice.getByText('Synthetic: Source verification required.', { exact: true }).waitFor();
      await page.evaluate(() => { window.__originalExploreView = document.querySelector('#view').firstElementChild; });
      await sourceNotice.getByRole('button', { name: 'Verify source', exact: true }).click();
      await sourceNotice.getByText('Synthetic: Complete the check in the website window.', { exact: true }).waitFor();
      await page.evaluate(() => { window.__canAccess = true; window.__verificationPhase = 'retry-required'; window.dispatchEvent(new Event('focus')); });
      await page.locator('.browse-body').getByText('Synthetic Native Title', { exact: true }).waitFor();
      await sourceNotice.waitFor({ state: 'hidden' });
      assert.equal(await page.getByPlaceholder('Search this source…', { exact: true }).inputValue(), 'original fixture query');
      assert(await page.evaluate(() => window.__originalExploreView === document.querySelector('#view').firstElementChild), 'source search recovery must keep the current Explore view');
      const searchReads = await page.evaluate(() => window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation === 'content.search').map(call => call.args.params));
      assert(searchReads.length >= 2);
      assert(searchReads.every(params => params.id === 'data:ATSUMOE' && params.q === 'original fixture query' && params.page === 1));
      await page.goto(`${base}/#/search?q=durable%20query%20fixture`);
      await page.waitForFunction(()=>window.__desktopCalls.some(call=>call.command==='serviceRequest'&&call.args.operation==='ui.preferences.save'&&call.args.params.patch.searchRecent?.includes('durable query fixture')));
      await page.goto(`${base}/#/search`);
      await page.getByText('durable query fixture',{exact:true}).waitFor();
      await page.goto(`${base}/#/library`);
      await page.waitForFunction(() => { const image = document.querySelector('.cover-media'); return image?.complete && image.naturalWidth === 512; });
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fchapter`);
      await page.waitForFunction(() => { const image = document.querySelector('img.reader-page'); return image?.complete && image.naturalWidth === 512; });
      await checkDesktopReaderCommandBoundary(page);
      assert.equal(await page.locator('.reader-page-broken').count(), 0);
      await page.locator('#view').getByRole('button',{name:'Settings',exact:true}).click();
      const invertControl=page.locator('.modal-backdrop.open .field').filter({has:page.getByText('Invert',{exact:true})}).locator('input[type="range"]');
      await invertControl.evaluate(input=>{input.value='0.5';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.locator('.modal-backdrop.open').getByRole('button',{name:'Done',exact:true}).click();
      await page.locator('.modal-backdrop.open').waitFor({state:'detached'});
      const readerSave=await page.evaluate(()=>window.__desktopCalls.filter(call=>call.command==='serviceRequest'&&call.args.operation==='library.mangaPrefsSave').at(-1)?.args.params);
      assert.equal(readerSave.invert,0.5);assert.equal(readerSave.readerFit,'WIDTH');assert.equal(typeof readerSave.prefetch,'boolean');
      assert.equal(await page.locator('img.reader-page').first().evaluate(image=>Number(/invert\(([^)]+)\)/.exec(image.style.filter)?.[1])),0.5);
      const decoded = await page.locator('img.reader-page').first().evaluate((image) => ({ src: image.currentSrc, origin: location.origin }));
      assert.equal(new URL(decoded.src).origin, decoded.origin);
      assert.equal(new URL(decoded.src).searchParams.get('cap'), 'synthetic-media-cap');
      // Same-origin readable media must also decode for canvas/AI bitmap input.
      const bitmap = await page.evaluate(async () => { const url = document.querySelector('img.reader-page').src + '&_r=123456789'; const response = await fetch(url); const bitmap = await createImageBitmap(await response.blob()); const dimensions = [bitmap.width, bitmap.height]; bitmap.close(); return dimensions; });
      assert.deepEqual(bitmap, [512, 512]);
      assert(imageRequests.some((url) => url.searchParams.get('_r') === '123456789'));
      const autoRequests=()=>imageRequests.filter(url=>url.searchParams.get('u')==='https://example.org/auto-page.png');
      automaticImageFailures=2;const transientStart=autoRequests().length;
      await page.evaluate(()=>{window.__automaticImage=true;});
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fauto-transient`);
      await page.locator('img.reader-page[data-page="0"]').waitFor();
      await page.evaluate(()=>{window.__automaticOriginal=document.querySelector('img.reader-page[data-page="0"]');window.__automaticReader=document.querySelector('.reader-view');});
      await page.getByText('Retrying page…',{exact:true}).waitFor();
      await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="1"]')?.naturalWidth===512);
      await page.locator('img.reader-page[data-page="1"]').evaluate(image=>image.scrollIntoView({block:'start'}));
      await page.waitForTimeout(150);
      const stableBefore=await page.evaluate(()=>({hash:location.hash,counter:document.querySelector('.reader-counter')?.textContent,pageTop:document.querySelector('img.reader-page[data-page="1"]').getBoundingClientRect().top,mutations:window.__desktopCalls.filter(call=>call.command==='serviceRequest'&&/Save$|^(library\.favouriteToggle|library\.bookmarkAdd|library\.bookmarkRemove|sources\.setInstalled|sources\.setPinned|ui\.preferences\.save|downloads\.enqueue|sync\.now)$/.test(call.args.operation)).length}));
      const loadedBeforeAuto=imageRequests.filter(url=>url.searchParams.get('u')==='https://example.org/loaded-page.png').length;
      await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="0"]')?.naturalWidth===512);
      assert.equal(autoRequests().length-transientStart,3,'two failures require exactly two automatic requests, without a second restoration fetch');
      assert.equal(imageRequests.filter(url=>url.searchParams.get('u')==='https://example.org/loaded-page.png').length,loadedBeforeAuto,'successful pages cannot replay');
      const stableAfter=await page.evaluate(()=>({hash:location.hash,counter:document.querySelector('.reader-counter')?.textContent,pageTop:document.querySelector('img.reader-page[data-page="1"]').getBoundingClientRect().top,mutations:window.__desktopCalls.filter(call=>call.command==='serviceRequest'&&/Save$|^(library\.favouriteToggle|library\.bookmarkAdd|library\.bookmarkRemove|sources\.setInstalled|sources\.setPinned|ui\.preferences\.save|downloads\.enqueue|sync\.now)$/.test(call.args.operation)).length,sameImage:window.__automaticOriginal===document.querySelector('img.reader-page[data-page="0"]'),sameReader:window.__automaticReader===document.querySelector('.reader-view')}));
      assert.equal(stableAfter.hash,stableBefore.hash);assert.equal(stableAfter.counter,stableBefore.counter);assert(Math.abs(stableAfter.pageTop-stableBefore.pageTop)<2,'recovery above the visible page preserves its viewport position');assert.equal(stableAfter.mutations,stableBefore.mutations);assert(stableAfter.sameImage&&stableAfter.sameReader);
      for(const request of autoRequests().slice(transientStart)){assert.equal(request.searchParams.get('cap'),'synthetic-media-cap');assert.equal(request.searchParams.get('sourceId'),'data:ATSUMOE');assert(request.searchParams.getAll('_r').length<=1);}
      automaticImageFailures=100;const permanentStart=autoRequests().length;
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fauto-permanent`);
      await page.waitForFunction(()=>document.querySelector('.reader-page-broken')?.textContent.includes('Page 1 failed to load'),{},{timeout:20000});
      assert.equal(autoRequests().length-permanentStart,4,'permanent failure has one initial request and three bounded attempts');
      await page.waitForTimeout(1200);assert.equal(autoRequests().length-permanentStart,4);
      automaticImageFailures=0;
      await page.locator('.reader-page-broken').getByRole('button',{name:'Reload',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="0"]')?.naturalWidth===512);
      assert.equal(autoRequests().length-permanentStart,5,'manual Reload remains usable after budget exhaustion');
      automaticImageFailures=100;const detachedStart=autoRequests().length;
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fauto-detached`);
      await page.getByText('Retrying page…',{exact:true}).waitFor();
      await page.goto(`${base}/#/library`);await page.waitForTimeout(1400);assert.equal(autoRequests().length-detachedStart,1,'navigation cancels pending page requests');
      automaticImageFailures=1;const offlineStart=autoRequests().length;
      await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{value:false,configurable:true});});
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fauto-offline`);
      await page.getByText('Waiting for a connection…',{exact:true}).waitFor();assert.equal(autoRequests().length-offlineStart,1);
      await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{value:true,configurable:true});window.dispatchEvent(new Event('online'));});
      await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="0"]')?.naturalWidth===512);assert.equal(autoRequests().length-offlineStart,2);
      await page.evaluate(()=>{window.__automaticImage=false;});
      // An actual HTTP error replaces the reader img. Closing verification
      // automatically restores that exact page; successful pages stay decoded.
      blockReaderImage = true;
      await page.evaluate(() => { window.__mediaChallenge = true; window.__manual = false; window.__verificationId = undefined; window.__delayRecovery = false; });
      await page.goto(`${base}/#/reader?sid=data%3AATSUMOE&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fchallenge-chapter`);
      await page.locator('img.reader-page[data-page="0"]').waitFor();
      await page.evaluate(() => { window.__failedReaderImage = document.querySelector('img.reader-page[data-page="0"]'); window.__failedReaderImage.addEventListener('load', () => { window.__verificationPhase = null; window.dispatchEvent(new Event('focus')); }); });
      await page.locator('.reader-page-broken[data-page="0"]').waitFor();
      await page.waitForFunction(() => { const image = document.querySelector('img.reader-page[data-page="1"]'); return image?.complete && image.naturalWidth === 512; });
      await page.evaluate(() => { document.body.classList.add('reader-immersive'); window.__originalReaderView = document.querySelector('.reader-view'); window.__successfulReaderImage = document.querySelector('img.reader-page[data-page="1"]'); });
      const pending = page.locator('#desktop-source-status');
      assert(await pending.isVisible(), 'verification notice must remain visible in immersive reader');
      assert.equal(await page.locator('#sidebar #desktop-source-status').count(), 0);
      await pending.locator('.desktop-source-help > summary').press('Space');
      await pending.getByText('Complete any check, then close the window. Nyora will check the source automatically.', { exact: true }).waitFor();
      await pending.getByRole('button', { name: 'Verify source', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#desktop-source-status button')?.disabled);
      assert.equal(await pending.getByRole('button', { name: 'Retry images' }).count(), 0);
      const loadedBefore = imageRequests.filter((url) => url.searchParams.get('u') === 'https://example.org/loaded-page.png').length;
      const blockedBefore=imageRequests.filter(url=>url.searchParams.get('u')==='https://example.org/blocked-page.png').length;
      await page.waitForTimeout(1300);assert.equal(imageRequests.filter(url=>url.searchParams.get('u')==='https://example.org/blocked-page.png').length,blockedBefore,'known verification/open window pauses automatic retries');
      const beforeRetry = await page.evaluate(() => ({ hash: location.hash, counter: document.querySelector('.reader-counter')?.textContent, reads: window.__desktopCalls.filter((call) => call.command === 'serviceRequest').length }));
      blockReaderImage = false;
      await page.evaluate(() => { window.__verificationPhase = 'retry-required'; window.__cookies = { state: 'saved' }; window.dispatchEvent(new Event('focus')); });
      await page.waitForFunction(() => { const image = document.querySelector('img.reader-page[data-page="0"]'); return image?.complete && image.naturalWidth === 512; });
      assert.equal(await page.locator('.reader-page-broken').count(), 0);
      assert(await page.evaluate(() => window.__originalReaderView === document.querySelector('.reader-view') && window.__successfulReaderImage === document.querySelector('img.reader-page[data-page="1"]') && window.__failedReaderImage === document.querySelector('img.reader-page[data-page="0"]')));
      assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, counter: document.querySelector('.reader-counter')?.textContent, reads: window.__desktopCalls.filter((call) => call.command === 'serviceRequest').length })), beforeRetry);
      assert.equal(imageRequests.filter((url) => url.searchParams.get('u') === 'https://example.org/loaded-page.png').length, loadedBefore);
      assert.equal(await pending.getByRole('button', { name: 'Retry images' }).count(), 0);
      assert(!(await pending.textContent()).includes('solved'));
      await page.evaluate(() => { window.__mediaChallenge = false; window.__verificationPhase = null; window.dispatchEvent(new CustomEvent('nyora:native-request-failed')); });
      await page.goto(`${base}/#/discover`);
      await page.waitForFunction(() => [...document.querySelectorAll('.discover-hero-bg img, .discover-hero-cover img, .discover-rail-card img')].length >= 3 && [...document.querySelectorAll('.discover-hero-bg img, .discover-hero-cover img, .discover-rail-card img')].every((image) => image.complete && image.naturalWidth === 512 && image.crossOrigin === 'anonymous'));
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.goto(`${base}/#/suggestions`);
      await page.waitForFunction(() => { const image = document.querySelector('#view .grid img'); return image?.complete && image.naturalWidth === 512 && image.crossOrigin === 'anonymous'; });
    }
    await page.waitForTimeout(250);
    assert.deepEqual(errors, []); assert.deepEqual(forbiddenRequests, []);
    if (process.env.NYORA_SMOKE_SCREENSHOT) await page.screenshot({ path: resolve(desktopRoot, process.env.NYORA_SMOKE_SCREENSHOT.replace('.png', `-${native ? 'adapter' : 'browser'}.png`)), fullPage: true });
    await page.goto(`${base}/#/settings?s=reader`);
    await context.close();
    console.log(`PASS ${native ? 'native hydration/navigation; cloud/tracker success and rejection; archive import/page progress/reload; download enqueue/offline decode; atomic read marks; invert and reader extras; durable write UI; proactive website close check; automatic verification close recovery; saving/checking states; continued-challenge dedupe and stable focus; non-CF Try again; original SEARCH query/view retained; immersive reader in-place PNG recovery without successful-image/request replay; HTTP cover/reader/bitmap and COEP metadata decode' : 'helper-unavailable startup/retry; shared UI stays uninitialized'}; no browser storage, automatic sync, hosted helper, SW`);
  }
  console.log('Frontend smoke passed. Mock preload does not establish native helper or bundled Electron acceptance.');
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
  await new Promise((done) => assets.close(done));
}
