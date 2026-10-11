'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('only shipped files changed since the last release publish a new one', async () => {
  const { decide, shipped } = await import('../scripts/release-gate.mjs');
  for (const file of ['tests/a.test.mjs', 'docs/INSTALL.md', '.github/workflows/release.yml', 'README.md', 'electron/cors.test.cjs', 'scripts/smoke-frontend.mjs', 'distribution/mirror-release.mjs']) assert.equal(shipped(file), false, file);
  for (const file of ['electron/main.cjs', 'vendor/web/web/core/translate/mt.js', 'package.json', 'scripts/build-frontend.mjs', 'frontend/desktop.js']) assert.equal(shipped(file), true, file);
  assert.deepEqual(decide([{ message: 'Fix a flaky test', files: ['tests/feature-library-browser.mjs'] }]), []);
  assert.deepEqual(decide([{ message: 'Retry the UI smoke once [no release]', files: ['scripts/package-electron.mjs'] }]), []);
  assert.deepEqual(decide([
    { message: 'Fix a flaky test', files: ['tests/x.mjs'] },
    { message: 'Translate more', files: ['vendor/web/web/core/translate/mt.js', 'tests/y.mjs'] },
  ]), ['vendor/web/web/core/translate/mt.js']);
});
