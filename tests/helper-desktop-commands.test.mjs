import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
const source = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
function preload(isMainFrame = true) {
  let exposed;
  const ipc = new EventEmitter();
  runInNewContext(source, { process: { isMainFrame }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, bridge) => { exposed = bridge; } }, ipcRenderer: ipc }) });
  return { ipc, exposed };
}
test('preload accepts only named desktop commands and fixed existing routes with removable listeners', () => {
  const { ipc, exposed } = preload();
  assert.equal(typeof exposed.onCommand, 'function');
  const commands = [], routes = [];
  const removeCommands = exposed.onCommand(value => commands.push(value));
  const removeRoutes = exposed.onNavigate(value => routes.push(value));
  for (const value of ['palette', 'shortcuts', 'back', 'forward', 'search-focus', 'arbitrary-invoke', { operation: 'clear-library' }]) ipc.emit('nyora:command', {}, value);
  for (const value of ['history', 'bookmarks', 'updates', 'stats', 'https://untrusted.example', 'reader']) ipc.emit('nyora:navigate', {}, value);
  assert.deepEqual(commands, ['palette', 'shortcuts', 'back', 'forward', 'search-focus']);
  assert.deepEqual(routes, ['history', 'bookmarks', 'updates', 'stats']);
  removeCommands(); removeRoutes();
  assert.equal(ipc.listenerCount('nyora:command'), 0); assert.equal(ipc.listenerCount('nyora:navigate'), 0);
  assert.throws(() => exposed.onCommand('not a listener'), /listener must be a function/);
  assert.equal(exposed.ipcRenderer, undefined);
});
test('source subframes receive no desktop command or service bridge', () => {
  assert.equal(preload(false).exposed, undefined);
});
