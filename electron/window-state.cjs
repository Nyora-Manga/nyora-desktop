'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const valid = bounds => bounds && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key]))
  && Math.abs(bounds.x) <= 1000000 && Math.abs(bounds.y) <= 1000000 && bounds.width >= 200 && bounds.width <= 8192 && bounds.height >= 200 && bounds.height <= 8192;
class WindowState {
  #window;
  #listeners = [];
  #pending = Promise.resolve();
  #timer;
  #latest;
  constructor(file) { if (!path.isAbsolute(file)) throw new Error('Window state path must be absolute'); this.file = file; }
  async restore(displays) {
    const areas = displays.map(display => display.workArea).filter(valid);
    if (!areas.length) throw new Error('A display work area is required');
    let stored;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid window state');
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version === 1 && valid(data.bounds) && typeof data.maximized === 'boolean') stored = data;
    } catch { /* Invalid display state falls back; never blocks library access. */ }
    const bounds = stored?.bounds;
    const matching = bounds && areas.find(area => Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= 100
      && Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= 100);
    const area = matching || areas[0];
    const width = Math.min(bounds?.width || 1280, area.width), height = Math.min(bounds?.height || 850, area.height);
    return { x: matching ? Math.min(Math.max(bounds.x, area.x), area.x + area.width - width) : area.x + Math.floor((area.width - width) / 2),
      y: matching ? Math.min(Math.max(bounds.y, area.y), area.y + area.height - height) : area.y + Math.floor((area.height - height) / 2),
      width, height, maximized: stored?.maximized || false };
  }
  watch(window) {
    this.#window = window;
    for (const name of ['move', 'resize', 'maximize', 'unmaximize']) {
      const handler = () => {
        if (window.isDestroyed() || window.isMinimized()) return;
        const bounds = window.getNormalBounds(); if (!valid(bounds)) return;
        this.#latest = { version: 1, bounds, maximized: window.isMaximized() };
        clearTimeout(this.#timer); this.#timer = setTimeout(() => { void this.#save().catch(() => {}); }, 150); this.#timer.unref?.();
      };
      window.on(name, handler); this.#listeners.push(() => window.removeListener(name, handler));
    }
  }
  #save() {
    clearTimeout(this.#timer); const value = this.#latest;
    if (!value) return this.#pending;
    const next = this.#pending.catch(() => {}).then(async () => {
      const directory = path.dirname(this.file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Window state directory cannot be a symbolic link');
      const pending = path.join(directory, `.window-${randomUUID()}.pending`);
      try {
        const handle = await fs.open(pending, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(pending, this.file);
      } finally { await fs.rm(pending, { force: true }); }
    });
    this.#pending = next; return next;
  }
  async close() { for (const remove of this.#listeners.splice(0)) remove(); this.#window = undefined; await this.#save(); }
}
module.exports = { WindowState };
