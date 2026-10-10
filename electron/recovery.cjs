'use strict';

// Main owns recovery decisions. No URL, process handle or replay operation is
// accepted from the renderer, and writes never pass through helper replay.
class WindowRecovery {
  #listeners = [];
  #automatic = [];
  #gpu = [];
  #busy = false;
  #closed = false;
  #responsive = 0;
  constructor({ window, dialog, indexUrl, isQuitting = () => false, quit = () => {}, now = Date.now,
    maximum = 2, intervalMs = 5 * 60 * 1000 }) {
    this.window = window; this.dialog = dialog; this.indexUrl = indexUrl;
    this.isQuitting = isQuitting; this.quit = quit; this.now = now;
    this.maximum = maximum; this.intervalMs = intervalMs;
    this.#listen(window.webContents, 'render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') void this.#recover(false);
    });
    this.#listen(window, 'unresponsive', () => { void this.#recover(true); });
    this.#listen(window, 'responsive', () => { this.#responsive++; });
    this.#listen(window, 'closed', () => this.close());
  }
  #listen(emitter, name, handler) { emitter.on(name, handler); this.#listeners.push(() => emitter.removeListener(name, handler)); }
  #alive() { return !this.#closed && !this.isQuitting() && !this.window.isDestroyed(); }
  #route() {
    try {
      const url = new URL(this.window.webContents.getURL()), base = new URL(this.indexUrl);
      if (url.origin === base.origin && url.pathname === base.pathname && !url.search && url.href.length <= 16384) return url.href;
    } catch { /* An unexpected URL never becomes a recovery target. */ }
    return this.indexUrl;
  }
  async #recover(hung) {
    if (!this.#alive() || this.#busy) return;
    this.#busy = true;
    const responsive = this.#responsive;
    try {
      const cutoff = this.now() - this.intervalMs;
      this.#automatic = this.#automatic.filter(at => at > cutoff);
      let reload = !hung && this.#automatic.length < this.maximum;
      if (reload) this.#automatic.push(this.now());
      else {
        const result = await this.dialog.showMessageBox(this.window, {
          type: 'warning', title: 'Nyora', message: hung ? 'Nyora is not responding.' : 'Nyora stopped displaying this window.',
          detail: 'Your saved library and source sessions are retained. Reloading restores this view; an unconfirmed write is not repeated.',
          buttons: hung ? ['Reload', 'Keep waiting', 'Quit'] : ['Reload', 'Quit'], defaultId: 0, cancelId: 1, noLink: true,
        });
        if (!this.#alive() || hung && responsive !== this.#responsive) return;
        reload = result.response === 0;
        if (!reload && (!hung || result.response === 2)) this.quit();
      }
      if (reload && this.#alive()) await this.window.loadURL(this.#route());
    } catch {
      // A destroyed window must not open a stray dialog or start a reload loop.
      if (this.#alive()) await this.dialog.showMessageBox(this.window, {
        type: 'error', title: 'Nyora', message: 'Nyora could not reload this window.',
        detail: 'Quit and open Nyora again. Your saved library is retained.', buttons: ['OK'], noLink: true,
      }).catch(() => {});
    } finally { this.#busy = false; }
  }
  gpuFailure(details) {
    if (!this.#alive() || details.type !== 'GPU' || ['clean-exit', 'killed'].includes(details.reason)) return;
    this.#gpu = this.#gpu.filter(at => at > this.now() - this.intervalMs);
    this.#gpu.push(this.now());
    // Chromium restarts its GPU process. Repeated failures need a user decision,
    // not a security-weakening flag or an automatic whole-app restart loop.
    if (this.#gpu.length === 3) void this.#recover(true);
  }
  close() { this.#closed = true; for (const remove of this.#listeners.splice(0)) remove(); }
}

class HelperReadRecovery {
  #restarts = [];
  #starting;
  #closed = false;
  constructor({ helper, now = Date.now, maximum = 2, intervalMs = 60000 }) {
    this.helper = helper; this.now = now; this.maximum = maximum; this.intervalMs = intervalMs;
  }
  async run(readOnly, task) {
    try { return await task(); }
    catch (error) {
      const helper = this.helper();
      if (!readOnly || this.#closed || error?.code === 'SOURCE_VERIFICATION_REQUIRED'
        || helper?.status?.state !== 'unavailable' || helper.status.code !== 'HELPER_EXITED') throw error;
      if (!this.#starting) {
        this.#restarts = this.#restarts.filter(at => at > this.now() - this.intervalMs);
        if (this.#restarts.length >= this.maximum) throw error;
        this.#restarts.push(this.now());
        const starting = Promise.resolve().then(() => helper.start());
        this.#starting = starting;
        void starting.finally(() => { if (this.#starting === starting) this.#starting = undefined; }).catch(() => {});
      }
      await this.#starting;
      if (this.#closed) throw error;
      return task(); // Exactly one replay of a trusted GET, after shared restart.
    }
  }
  close() { this.#closed = true; }
}

module.exports = { WindowRecovery, HelperReadRecovery };
