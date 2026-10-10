import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const screenshots = fileURLToPath(new URL('../test-results/desktop-commands/', import.meta.url));

// Run after the existing native browser fixture has hydrated the real bundle.
export async function checkDesktopCommands(page, base) {
  const trigger = page.locator('[data-desktop-command-trigger]');
  await trigger.waitFor({ state: 'visible' });
  await trigger.click();
  let dialog = page.getByRole('dialog', { name: 'Search', exact: true });
  await dialog.waitFor({ state: 'visible' });
  let input = dialog.getByRole('combobox');
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 860, height: 600 });
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: screenshots+'/palette-860x600.png', animations: 'disabled' });
  const paletteBounds = await dialog.boundingBox();
  assert.ok(paletteBounds.y + paletteBounds.height <= 600, 'palette stays within the minimum desktop viewport');
  await input.press('Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await input.evaluate(node => node === document.activeElement), true, 'Tab wraps inside the dialog');
  await input.fill('reading history');
  assert.equal(await dialog.getByRole('option').count(), 1);
  await input.press('Enter');
  await page.waitForURL(url => url.origin === base && url.hash === '#/history');
  await trigger.click();
  await page.getByRole('combobox', { name: 'Search' }).press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape restores the opening control');
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+k`);
  dialog = page.getByRole('dialog', { name: 'Search', exact: true });
  await dialog.waitFor({ state: 'visible' });
  input = dialog.getByRole('combobox');
  await input.fill('unrecognized https://example.invalid');
  assert.equal(await dialog.getByRole('option').count(), 0);
  await input.press('Enter');
  assert.ok(page.url().endsWith('#/history'), 'arbitrary query does not navigate or invoke services');
  await input.fill('keyboard');
  await input.press('Enter');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: screenshots+'/shortcuts-860x600.png', animations: 'disabled' });
  const helpBounds = await page.getByRole('dialog').boundingBox();
  assert.ok(helpBounds.y + helpBounds.height <= 600, 'shortcut help scrolls inside the minimum desktop viewport');
  assert.ok((await page.getByRole('dialog').innerText()).includes('Next / Previous chapter'));
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${modifier}+k`);
  dialog = page.getByRole('dialog', { name: 'Search', exact: true });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('combobox').fill('bookmarks');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.origin === base && url.hash === '#/bookmarks');
  await checkDesktopSearchMotion(page);
  if (viewport) await page.setViewportSize(viewport);
}

// Uses the actual mounted dialog: verify motion through DOM lifetime and focus,
// rather than matching CSS declarations or waiting a fixed animation duration.
export async function checkDesktopSearchMotion(page) {
  const trigger = page.locator('[data-desktop-command-trigger]');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger.click();
  const original = await page.getByRole('dialog', { name: 'Search', exact: true }).elementHandle();
  await page.evaluate(() => {
    const input = document.querySelector('[role="combobox"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(node => !node.isConnected, original);
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1
    && document.activeElement === document.querySelector('[role="combobox"]'));
  const input = page.getByRole('combobox', { name: 'Search', exact: true });
  await input.fill('reading history');
  assert.equal(await page.getByRole('option').count(), 1, 'rapid reopening creates one usable Search');
  await input.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  assert.equal(await page.getByRole('dialog').evaluate(node => node.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running').length), 0, 'reduced motion has no active Search animation');
  const closed = await page.evaluate(() => {
    document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { dialogs: document.querySelectorAll('[role="dialog"]').length,
      focused: document.activeElement === document.querySelector('[data-desktop-command-trigger]') };
  });
  assert.deepEqual(closed, { dialogs: 0, focused: true }, 'reduced motion detaches and restores focus in the same turn');
  await page.emulateMedia({ reducedMotion: null });
}

// Call only while the existing reader fixture is mounted with decoded pages.
export async function checkDesktopReaderCommandBoundary(page) {
  const original = page.url();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+k`);
  await page.getByRole('combobox').fill('n f a');
  assert.equal(page.url(), original, 'typing reader command letters in the palette must retain the chapter');
  await page.keyboard.press('Escape');
  assert.equal(page.url(), original, 'closing the palette must not execute reader Escape');
}
