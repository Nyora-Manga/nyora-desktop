'use strict';

// Observes committed broker snapshots only. Keep completed members of the current
// batch so finishing one chapter does not reset the remaining batch's progress.
// Historical completions are never admitted; nothing is persisted or sent by IPC.
class DownloadProgress {
  #batch = new Set();
  #value = -1;
  #mode = 'none';
  #lastWindow;
  #lastKey;
  #closed = false;
  constructor({ window, platform = process.platform }) {
    this.window = window;
    this.platform = platform;
  }
  update(snapshot) {
    if (this.#closed) return;
    const entries = snapshot?.entries || [];
    const pending = entries.filter(job => job.status === 'RUNNING' || job.status === 'QUEUED');
    if (!pending.length) {
      this.#batch.clear(); this.#value = -1; this.#mode = 'none';
    } else {
      for (const job of pending) this.#batch.add(job.id);
      const batch = entries.filter(job => this.#batch.has(job.id)
        && ['RUNNING', 'QUEUED', 'COMPLETED'].includes(job.status));
      this.#batch = new Set(batch.map(job => job.id));
      const running = pending.filter(job => job.status === 'RUNNING');
      const discovering = running.some(job => !(job.totalPages > 0));
      this.#mode = snapshot.queuePaused && !running.length ? 'paused' : discovering ? 'indeterminate' : 'normal';
      this.#value = discovering ? 2 : batch.reduce((total, job) => total + (job.status === 'COMPLETED' ? 1
        : job.status === 'RUNNING' && job.totalPages > 0 && Number.isFinite(job.completedPages)
          ? Math.max(0, Math.min(1, job.completedPages / job.totalPages)) : 0), 0) / batch.length;
      if (this.platform === 'linux' && discovering) { this.#value = 0; this.#mode = 'normal'; }
    }
    this.refresh();
  }
  refresh() {
    // The dock/taskbar is feedback, never part of the download commit. A window
    // closing or a platform integration failure must not mark good media failed.
    try {
      const window = this.window();
      if (!window || window.isDestroyed()) return;
      const key = `${this.#mode}:${this.#value}`;
      if (window === this.#lastWindow && key === this.#lastKey) return;
      window.setProgressBar(this.#value, { mode: this.#mode });
      this.#lastWindow = window; this.#lastKey = key;
    } catch { /* Best-effort native presentation; the broker remains authoritative. */ }
  }
  close() {
    this.#closed = true; this.#batch.clear(); this.#value = -1; this.#mode = 'none';
    this.refresh();
  }
}
module.exports = { DownloadProgress };
