'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consumerMenu } = require('./menu.cjs');
test('consumer menu uses fixed routes and native editing, backup and app actions', async () => {
  const routes = [], backup = [];
  const menu = consumerMenu({ platform: 'darwin', navigate: route => routes.push(route), exportBackup: () => backup.push('export'), importBackup: () => backup.push('import'), about: () => {}, reportError: () => {} });
  assert.equal(menu[0].label, 'Nyora');
  const file = menu.find(item => item.label === 'File').submenu;
  file.find(item => item.label === 'Local files').click();
  await file.find(item => item.label === 'Create backup…').click();
  await file.find(item => item.label === 'Restore backup…').click();
  menu.find(item => item.label === 'Navigate').submenu.find(item => item.label === 'Library').click();
  assert.deepEqual(routes, ['local', 'library']); assert.deepEqual(backup, ['export', 'import']);
  assert.equal(menu[0].submenu.find(item => item.label === 'Settings…').accelerator, 'CmdOrCtrl+,');
  assert(menu.some(item => item.role === 'editMenu'));
});
test('native action failure is caught and Windows menu provides preferences without Mac roles', async () => {
  const errors = [];
  const menu = consumerMenu({ platform: 'win32', navigate() {}, exportBackup: async () => { throw new Error('Export failed'); }, importBackup() {}, about() {}, reportError: error => errors.push(error.message) });
  assert(!menu.some(item => item.label === 'Nyora'));
  const file = menu.find(item => item.label === 'File').submenu;
  assert(file.some(item => item.label === 'Settings…'));
  await file.find(item => item.label === 'Create backup…').click();
  assert.deepEqual(errors, ['Export failed']);
});
test('native command menu opens palette/help and navigates existing sections without treating commands as routes', () => {
  const routes = [], commands = [];
  const menu = consumerMenu({ platform: 'darwin', navigate: value => routes.push(value), command: value => commands.push(value), exportBackup() {}, importBackup() {}, about() {}, reportError() {} });
  const navigation = menu.find(item => item.label === 'Navigate').submenu;
  for (const label of ['History', 'Bookmarks', 'Updates', 'Stats']) {
    const entry = navigation.find(item => item.label === label);
    assert.ok(entry, `existing section ${label} needs native navigation`); entry.click();
  }
  for (const label of ['Search…', 'Back', 'Forward', 'Focus search']) {
    const entry = navigation.find(item => item.label === label);
    assert.ok(entry, `missing useful command ${label}`); entry.click();
  }
  const help = menu.find(item => item.label === 'Help').submenu.find(item => item.label === 'Keyboard shortcuts');
  assert.ok(help); help.click();
  assert.deepEqual(routes, ['history', 'bookmarks', 'updates', 'stats']);
  assert.deepEqual(commands, ['palette', 'back', 'forward', 'search-focus', 'shortcuts']);
  assert.equal(navigation.find(item => item.label === 'Search…').accelerator, 'CmdOrCtrl+K');
  const mangaSearch = navigation.find(item => item.label === 'Search manga');
  assert.equal(mangaSearch.accelerator, 'CmdOrCtrl+4');
  mangaSearch.click();
  assert.equal(routes.at(-1), 'search', 'renamed manga search keeps its existing route');
});
