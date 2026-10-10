'use strict';
function consumerMenu({ platform, navigate, command = () => {}, exportBackup, importBackup, about, reportError }) {
  const action = operation => async () => { try { await operation(); } catch (error) { await reportError(error); } };
  const settings = () => ({ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') });
  const template = [];
  if (platform === 'darwin') template.push({ label: 'Nyora', submenu: [
    { label: 'About Nyora', click: about }, { type: 'separator' }, settings(), { type: 'separator' },
    { role: 'services' }, { type: 'separator' }, { role: 'hide', label: 'Hide Nyora' },
    { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: 'Quit Nyora' },
  ] });
  template.push({ label: 'File', submenu: [
    { label: 'Local files', accelerator: 'CmdOrCtrl+O', click: () => navigate('local') },
    { label: 'Create backup…', click: action(exportBackup) }, { label: 'Restore backup…', click: action(importBackup) },
    ...(platform === 'darwin' ? [{ type: 'separator' }, { role: 'close' }] : [{ type: 'separator' }, settings(), { role: 'quit' }]),
  ] });
  template.push({ role: 'editMenu' });
  template.push({ label: 'Navigate', submenu: [
    { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => command('palette') },
    { label: 'Back', accelerator: platform === 'darwin' ? 'Command+[' : 'Alt+Left', click: () => command('back') },
    { label: 'Forward', accelerator: platform === 'darwin' ? 'Command+]' : 'Alt+Right', click: () => command('forward') },
    { label: 'Focus search', accelerator: 'CmdOrCtrl+F', click: () => command('search-focus') },
    { type: 'separator' },
    ...[
    ['Library', 'library', '1'], ['Discover', 'discover', '2'], ['Sources', 'explore', '3'],
    ['Search manga', 'search', '4'], ['Downloads', 'downloads', '5'], ['History', 'history', '6'],
    ['Bookmarks', 'bookmarks', '7'], ['Updates', 'updates', '8'], ['Stats', 'stats', '9'],
  ].map(([label, route, key]) => ({ label, accelerator: `CmdOrCtrl+${key}`, click: () => navigate(route) }))] });
  template.push({ label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] });
  template.push({ role: 'windowMenu' });
  template.push({ label: 'Help', submenu: [
    { label: 'Keyboard shortcuts', accelerator: 'CmdOrCtrl+/', click: () => command('shortcuts') },
    ...(platform !== 'darwin' ? [{ label: 'About Nyora', click: about }] : []),
  ] });
  return template;
}
module.exports = { consumerMenu };
