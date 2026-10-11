import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Called by the existing native-bundle browser smoke; all services are fixture
// responses. No real source requests or saved user-profile changes occur.
export async function checkLibraryTools(page, base) {
  const previousViewport = page.viewportSize();
  const evidence = resolve('test-results/library-tools');
  await mkdir(evidence, { recursive: true });
  const cards = page.locator('.library-favourites .grid .card');
  const titles = () => cards.locator('.title').allTextContents();
  const search = page.getByRole('searchbox', { name: 'Search your library', exact: true });
  const source = page.getByRole('combobox', { name: 'Filter library by source', exact: true });
  const reading = page.getByRole('combobox', { name: 'Filter library by reading history', exact: true });
  const contentCalls = () => page.evaluate(() => window.__desktopCalls.filter(call => call.command === 'serviceRequest' && call.args.operation.startsWith('content.')).length);
  try {
    await page.setViewportSize({ width: 860, height: 600 });
    await page.evaluate(async () => {
      const manga = (id, title, sourceId, url) => ({ id, title, url, source: { name: sourceId }, coverUrl: '', chapters: [] });
      const first = manga('library-one', 'Blue Garden', 'data:ATSUMOE', 'https://example.org/library-blue');
      const second = manga('library-two', 'Blue Garden', 'data:OTHER', first.url);
      const third = manga('library-three', 'Amber Road', 'data:ATSUMOE', 'https://example.org/library-amber');
      window.__featureFavourites = [first, second, third, ...Array.from({ length: 57 }, (_, i) => manga('library-tail-' + i, 'Saved title ' + String(i).padStart(2, '0'), 'data:ATSUMOE', 'https://example.org/library-' + i))];
      window.__featureHistory = [
        { mangaId: first.id, mangaUrl: first.url, mangaTitle: first.title, sourceId: 'data:ATSUMOE', chapterId: 'one', page: 9, percent: 1, updatedAt: 100 },
        { mangaId: third.id, mangaUrl: third.url, mangaTitle: third.title, sourceId: 'data:ATSUMOE', chapterId: 'three', page: 0, percent: 0, updatedAt: 500 },
      ];
      window.__featureCategories = [{ id: 700, title: 'Selected collection', mangaCount: 1 }];
      window.__featureCategoryEntries = { 700: [second] };
      await NYORA_SERVICES.library.hydrate();
    });
    await page.goto(base + '/#/history');
    await page.goto(base + '/#/library');
    await search.waitFor();
    assert.equal(await cards.count(), 24, 'first library render must retain chunked cards');
    const firstCover = await cards.first().boundingBox();
    assert(firstCover && firstCover.y < 380, 'first cover row should remain visible beneath the resume card at minimum size');
    await page.getByRole('button', { name: 'View history', exact: true }).waitFor();
    assert.match(await page.locator('.library-resume-progress').textContent(), /Page 10/);
    const before = await contentCalls();
    // The lazy grid replaces its sentinel as chunks render, so a held element can
    // detach mid-scroll on slow runners. Re-query and scroll on every poll.
    await page.waitForFunction(() => {
      document.querySelector('.library-favourites .grid-sentinel')?.scrollIntoView({ block: 'end' });
      return document.querySelectorAll('.library-favourites .grid .card').length > 24;
    });
    assert((await cards.count()) <= 60, 'lazy grid must not duplicate titles');

    await search.fill('blue');
    assert.deepEqual(await titles(), ['Blue Garden', 'Blue Garden']);
    await page.locator('.library-filter-disclosure').evaluate(node => { node.open = true; });
    await source.selectOption('data:ATSUMOE');
    await reading.selectOption('with-history');
    assert.deepEqual(await titles(), ['Blue Garden']);
    assert.equal(await page.locator('.library-result-count').textContent(), '1 of 60 titles');
    await reading.selectOption('no-history');
    assert.equal(await cards.count(), 0, 'completed chapter must not be treated as a completed book or remove its history');
    await source.selectOption('data:OTHER');
    assert.deepEqual(await titles(), ['Blue Garden'], 'same title+URL from another source cannot inherit reading history');
    await page.getByRole('button', { name: 'Selected collection · 1', exact: true }).click();
    await source.selectOption('data:ATSUMOE');
    await reading.press('Escape');
    await page.getByRole('button', { name: 'Reset filters', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    assert.deepEqual(await titles(), ['Blue Garden'], 'reset must stay inside the active collection');
    assert.equal(await page.locator('.library-result-count').textContent(), '1 title');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('combobox', { name: 'Sort library', exact: true }).selectOption('read');
    assert.deepEqual((await titles()).slice(0, 3), ['Amber Road', 'Blue Garden', 'Blue Garden']);
    await page.getByRole('combobox', { name: 'Sort library', exact: true }).selectOption('title');
    assert.deepEqual((await titles()).slice(0, 3), ['Amber Road', 'Blue Garden', 'Blue Garden']);
    await page.getByRole('combobox', { name: 'Sort library', exact: true }).selectOption('recent');
    assert.deepEqual((await titles()).slice(0, 3), ['Blue Garden', 'Blue Garden', 'Amber Road']);
    assert.equal(await contentCalls(), before, 'local search/filter/sort must not fetch any source content');

    await search.fill('blue');
    await page.locator('.library-filter-disclosure summary').click();
    for (const [width, height] of [[1280, 800], [860, 600]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.querySelector('#view')?.scrollTo(0, 0); window.scrollTo(0, 0); });
      await search.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'library tools must not create horizontal overflow');
      for (const control of [search, source, reading]) {
        const box = await control.boundingBox(); assert(box && box.height >= 30 && box.width >= 30);
      }
      await page.screenshot({ path: resolve(evidence, 'library-' + width + '.png') });
    }
    await source.selectOption('data:OTHER');
    await page.locator('.library-filter-disclosure').evaluate(node => { node.open = false; });
    await cards.first().click();
    await page.waitForFunction(() => window.__desktopCalls.some(call => call.command === 'serviceRequest' && call.args.operation === 'content.details' && call.args.params.id === 'data:OTHER' && call.args.params.url === 'https://example.org/library-blue'));
    assert.match(new URL(page.url()).hash, /sid=data%3AOTHER/, 'filtered card must open its exact source identity');
  } finally {
    await page.evaluate(async () => {
      for (const key of ['__featureFavourites', '__featureHistory', '__featureCategories', '__featureCategoryEntries']) delete window[key];
      await NYORA_SERVICES.library.hydrate();
    });
    if (previousViewport) await page.setViewportSize(previousViewport);
    await page.goto(base + '/#/library');
  }
}
