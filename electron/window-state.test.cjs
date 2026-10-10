'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WindowState } = require('./window-state.cjs');

const displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
test('window state persists normal bounds and maximized state across separate instances', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-window-state-'));
  try {
    const file = path.join(folder, 'window.json'), state = new WindowState(file), window = new EventEmitter();
    Object.assign(window, { isDestroyed: () => false, isMinimized: () => false, isMaximized: () => true, getNormalBounds: () => ({ x: 100, y: 40, width: 1000, height: 700 }) });
    state.watch(window); window.emit('resize'); await state.close();
    assert.deepEqual(await new WindowState(file).restore(displays), { x: 100, y: 40, width: 1000, height: 700, maximized: true });
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('off-screen, corrupt and excessive state restores safe visible dimensions', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-window-state-'));
  try {
    const file = path.join(folder, 'window.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, bounds: { x: -4000, y: 0, width: 1000, height: 700 }, maximized: false }));
    const state = await new WindowState(file).restore(displays);
    assert(state.x >= 0 && state.x + state.width <= 1440);
    await fs.writeFile(file, '{not json');
    const recovered = await new WindowState(file).restore([{ workArea: { x: 0, y: 0, width: 800, height: 600 } }]);
    assert.equal(recovered.width, 800); assert.equal(recovered.height, 600);
    assert.equal(recovered.maximized, false);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
