'use strict';
const { randomUUID } = require('node:crypto');
const { sourceKey, contentKey } = require('./policy.cjs');
const { text, ID } = require('./offline-store.cjs');
const DEFAULTS = Object.freeze({ format: 'CBZ', maxConcurrent: 2, imageConcurrency: 2, retries: 2, keepOffline: true, saveToDevice: false });
const ACTIVE = new Set(['QUEUED', 'RUNNING']);
function settings(patch, current = DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('Invalid download settings');
  const next = { ...current, ...patch };
  if (!['CBZ', 'ZIP'].includes(next.format) || next.keepOffline !== true || next.saveToDevice !== false) throw new Error('Native downloads require offline storage; exports use the native save dialog');
  for (const [key, min, max] of [['maxConcurrent', 1, 4], ['imageConcurrency', 1, 4], ['retries', 0, 3]]) {
    if (!Number.isSafeInteger(next[key]) || next[key] < min || next[key] > max) throw new Error('Invalid download concurrency or retry limit');
  }
  return next;
}
function descriptor(value) {
  const fields = ['sourceId', 'mangaId', 'mangaUrl', 'mangaTitle', 'chapterUrl', 'chapterId', 'chapterTitle', 'chapterNumber'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid download descriptor');
  sourceKey(value.sourceId);
  if (!contentKey(value.mangaUrl) || !contentKey(value.chapterUrl)) throw new Error('Download needs exact manga and chapter keys');
  const next = { sourceId: value.sourceId, mangaUrl: value.mangaUrl, chapterUrl: value.chapterUrl,
    mangaTitle: text(value.mangaTitle, 'Manga'), chapterTitle: text(value.chapterTitle, 'Chapter') };
  for (const field of ['mangaId', 'chapterId']) if (value[field] !== undefined) next[field] = text(String(value[field]));
  if (value.chapterNumber != null) { if (!Number.isFinite(value.chapterNumber)) throw new Error('Invalid chapter number'); next.chapterNumber = value.chapterNumber; }
  return next;
}
const dedupe = value => JSON.stringify([value.sourceId, value.mangaUrl, value.chapterUrl]);
const verificationError = error => error?.code === 'SOURCE_VERIFICATION_REQUIRED' || /verification_required/.test(String(error?.message));
function aborted(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
class NativeDownloadBroker {
  #jobs = new Map();
  #active = new Map();
  #settings = { ...DEFAULTS };
  #queuePaused = false;
  #closing = false;
  #clearing = false;
  #committing = 0;
  #mutations = Promise.resolve();
  constructor({ store, fetchPages, fetchImage, onVerification = () => {}, onChanged = () => {} } = {}) {
    if (!store || typeof fetchPages !== 'function' || typeof fetchImage !== 'function') throw new Error('Native downloads require the trusted content/image pipeline');
    Object.assign(this, { store, fetchPages, fetchImage, onVerification, onChanged });
  }
  async init() {
    const saved = await this.store.readState('downloads.json');
    if (saved) {
      if (saved.schema !== 1 || (Object.hasOwn(saved, 'queuePaused') && typeof saved.queuePaused !== 'boolean') || !Array.isArray(saved.jobs) || saved.jobs.length > 5000) throw new Error('Download queue metadata is damaged');
      this.#queuePaused = saved.queuePaused ?? false;
      this.#settings = settings(saved.settings);
      for (const job of saved.jobs) {
        if (!ID.test(job.id) || !['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) throw new Error('Download queue metadata is damaged');
        const clean = { ...descriptor(Object.fromEntries(Object.entries(job).filter(([key]) => ['sourceId','mangaId','mangaUrl','mangaTitle','chapterUrl','chapterId','chapterTitle','chapterNumber'].includes(key)))),
          id: job.id, startedAt: job.startedAt, status: job.status, totalPages: 0, completedPages: 0, failedPages: 0, bytes: 0, offline: false };
        if (this.store.has(job.id)) {
          const book = this.store.open(job.id); Object.assign(clean, { status: 'COMPLETED', totalPages: book.pageCount, completedPages: book.pageCount, bytes: book.bytes, offline: true, finishedAt: job.finishedAt });
        } else if (ACTIVE.has(job.status)) clean.status = 'QUEUED';
        else if (job.status === 'COMPLETED') Object.assign(clean, { status: 'FAILED', error: 'Offline file is unavailable' });
        else { clean.error = job.error ? text(job.error) : undefined; clean.errorCode = job.errorCode; clean.finishedAt = job.finishedAt; }
        this.#jobs.set(job.id, clean);
      }
    }
    await this.#save(); this.#pump(); return this;
  }
  snapshot() { return structuredClone({ entries: [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt), settings: this.#settings, queuePaused: this.#queuePaused }); }
  committedSnapshot() { return this.#mutate(() => this.snapshot()); }
  #changed(snapshot) { try { this.onChanged(snapshot); } catch {} }
  async #save({ mutation = false } = {}) {
    // Workers must not persist prospective user changes until their transaction
    // commits (or rolls back). Capture the snapshot only after that boundary.
    if (!mutation && this.#committing) await this.#mutations.catch(() => {});
    const state = structuredClone({ schema: 1, queuePaused: this.#queuePaused, settings: this.#settings, jobs: [...this.#jobs.values()] });
    await this.store.writeState('downloads.json', state);
    this.#changed({ entries: state.jobs.sort((a,b) => b.startedAt - a.startedAt), settings: state.settings, queuePaused: state.queuePaused });
  }
  #get(id) { if (!ID.test(id) || !this.#jobs.has(id)) throw new Error('Download was not found'); return this.#jobs.get(id); }
  #mutate(operation) {
    const task = this.#mutations.catch(() => {}).then(async () => {
      this.#committing++;
      try { return await operation(); } finally { this.#committing--; this.#pump(); }
    });
    this.#mutations = task; return task;
  }
  pause() { return this.#setPaused(true); }
  resume() { return this.#setPaused(false); }
  #setPaused(value) { return this.#mutate(async () => {
    if (this.#closing || this.#clearing) throw new Error('Downloads are unavailable during cleanup');
    const before = this.#queuePaused; this.#queuePaused = value;
    try { await this.#save({ mutation: true }); } catch(error) { this.#queuePaused = before; throw error; }
    return { queuePaused: this.#queuePaused };
  }); }
  configure(patch) { return this.#mutate(async () => {
    if (this.#closing) throw new Error('Downloads are closing');
    const before = this.#settings; this.#settings = settings(patch, before);
    try { await this.#save({ mutation: true }); } catch (error) { this.#settings = before; throw error; }
    return structuredClone(this.#settings);
  }); }
  enqueue(descriptors) { return this.#mutate(async () => {
    if (this.#closing || this.#clearing) throw new Error('Downloads are unavailable during cleanup');
    if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 200) throw new Error('Download batch must contain 1–200 chapters');
    const validated = descriptors.map(descriptor), result = { added: 0, requeued: 0, skipped: 0 };
    const added = [], restored = [];
    try {
    for (const value of validated) {
      const existing = [...this.#jobs.values()].find(job => dedupe(job) === dedupe(value));
      if (existing) {
        if (['FAILED','CANCELLED'].includes(existing.status) && !this.#active.has(existing.id)) { restored.push([existing, structuredClone(existing)]); Object.assign(existing, value, { status: 'QUEUED', error: undefined, errorCode: undefined }); result.requeued++; }
        else result.skipped++;
      } else {
        if (this.#jobs.size >= 5000) throw new Error('Download queue is full');
        const id = randomUUID(); added.push(id); this.#jobs.set(id, { ...value, id, status: 'QUEUED', totalPages: 0, completedPages: 0, failedPages: 0, bytes: 0, offline: false, startedAt: Date.now() }); result.added++;
      }
    }
    await this.#save({ mutation: true }); return result;
    } catch (error) {
      for (const id of added) this.#jobs.delete(id);
      for (const [job, previous] of restored) { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, previous); }
      throw error;
    }
  }); }
  #pump() {
    if (this.#closing || this.#clearing || this.#committing || this.#queuePaused) return;
    for (const job of this.#jobs.values()) {
      if (this.#active.size >= this.#settings.maxConcurrent) break;
      if (job.status !== 'QUEUED' || this.#active.has(job.id)) continue;
      const controller = new AbortController();
      const promise = this.#run(job.id, controller).finally(() => { this.#active.delete(job.id); this.#pump(); });
      this.#active.set(job.id, { controller, promise });
      // Persistence/callback failures remain visible in the job; avoid an orphan
      // rejected promise from this intentionally background worker.
      promise.catch(() => {});
    }
  }
  async #run(id, controller) {
    const signal = controller.signal, job = this.#get(id), config = { ...this.#settings };
    try {
      signal.throwIfAborted();
      Object.assign(job, { status: 'RUNNING', completedPages: 0, totalPages: 0, bytes: 0, failedPages: 0, offline: false, error: undefined, errorCode: undefined, finishedAt: undefined }); await this.#save();
      signal.throwIfAborted();
      const result = await aborted(this.fetchPages(descriptor(Object.fromEntries(Object.entries(job).filter(([key]) => ['sourceId','mangaId','mangaUrl','mangaTitle','chapterUrl','chapterId','chapterTitle','chapterNumber'].includes(key)))), { signal }), signal);
      const pages = result?.pages;
      if (!Array.isArray(pages) || !pages.length || pages.length > this.store.maxPages || pages.some(page => typeof page !== 'string' && (!page || typeof page.url !== 'string'))) throw new Error('Chapter has no valid pages or exceeds limits');
      job.totalPages = pages.length; await this.#save();
      const self = this;
      async function* downloaded() {
        for (let i = 0; i < pages.length; i += config.imageConcurrency) {
          signal.throwIfAborted();
          const batch = pages.slice(i, i + config.imageConcurrency);
          const images = await Promise.all(batch.map(async page => {
            for (let attempt = 0; ; attempt++) {
              try { return await aborted(self.fetchImage({ sourceId: job.sourceId, page: typeof page === 'string' ? { url: page } : page }, { signal }), signal); }
              catch (error) { if (signal.aborted || verificationError(error) || attempt >= config.retries) throw error; await delay(250 * 2 ** attempt, signal); }
            }
          }));
          for (const image of images) { signal.throwIfAborted(); yield image; }
        }
      }
      const book = await this.store.createBook({ id, kind: 'download', title: job.mangaTitle, chapterTitle: job.chapterTitle,
        sourceId: job.sourceId, mangaId: job.mangaId, mangaUrl: job.mangaUrl, chapterId: job.chapterId, chapterUrl: job.chapterUrl }, downloaded(), {
        signal, onProgress: async progress => { if (!signal.aborted && job.status === 'RUNNING') { Object.assign(job, progress); await this.#save(); } },
      });
      if (signal.aborted || job.status !== 'RUNNING') { await this.store.remove(id); signal.throwIfAborted(); return; }
      Object.assign(job, { status: 'COMPLETED', offline: true, completedPages: book.pageCount, bytes: book.bytes, finishedAt: Date.now() }); await this.#save();
    } catch (error) {
      controller.abort();
      if (this.#closing && job.status === 'RUNNING') job.status = 'QUEUED';
      else if (job.status !== 'CANCELLED') Object.assign(job, { status: 'FAILED', offline: false, failedPages: Math.max(1, job.totalPages - job.completedPages),
        error: verificationError(error) ? 'Source verification is required' : 'Chapter could not be downloaded. Retry when the source is available.',
        errorCode: verificationError(error) ? 'SOURCE_VERIFICATION_REQUIRED' : 'DOWNLOAD_FAILED', finishedAt: Date.now() });
      await this.#save();
      if (verificationError(error)) await this.onVerification(structuredClone(job), error);
    }
  }
  async cancel(id) { const job = this.#get(id); if (ACTIVE.has(job.status)) { job.status = 'CANCELLED'; job.finishedAt = Date.now(); this.#active.get(id)?.controller.abort(); await this.#save(); } return { ok: true }; }
  async cancelAll() { const ids = [...this.#jobs.values()].filter(job => ACTIVE.has(job.status)).map(job => job.id); for (const id of ids) await this.cancel(id); return { cancelled: ids.length }; }
  retry(id) { return this.#mutate(async () => {
    const job = this.#get(id);
    if (!['FAILED','CANCELLED'].includes(job.status) || this.#active.has(id) || this.#closing || this.#clearing) throw new Error('Download cannot be retried yet');
    await this.#requeue([job]); return { ok: true };
  }); }
  retryFailed() { return this.#mutate(async () => {
    if (this.#closing || this.#clearing) throw new Error('Downloads are unavailable during cleanup');
    const failed = [...this.#jobs.values()].filter(job => job.status === 'FAILED' && !this.#active.has(job.id));
    const ordinary = failed.filter(job => job.errorCode !== 'SOURCE_VERIFICATION_REQUIRED');
    if (ordinary.length) await this.#requeue(ordinary);
    return { requeued: ordinary.length, verificationRequired: failed.length - ordinary.length };
  }); }
  async #requeue(jobs) {
    const before = jobs.map(job => [job, structuredClone(job)]);
    for (const job of jobs) Object.assign(job, { status: 'QUEUED', error: undefined, errorCode: undefined });
    try { await this.#save({ mutation: true }); }
    catch(error) {
      for (const [job, previous] of before) { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, previous); }
      throw error;
    }
  }
  async resumeVerification(sourceId) {
    sourceKey(sourceId);
    const paused = [...this.#jobs.values()].filter(job => job.sourceId === sourceId && job.status === 'FAILED' && job.errorCode === 'SOURCE_VERIFICATION_REQUIRED');
    await Promise.allSettled(paused.map(job => this.#active.get(job.id)?.promise));
    let requeued = 0;
    for (const job of paused) if (!this.#closing && job.status === 'FAILED' && job.errorCode === 'SOURCE_VERIFICATION_REQUIRED') { await this.retry(job.id); requeued++; }
    return { requeued };
  }
  async remove(id) {
    const job = this.#get(id); if (ACTIVE.has(job.status) || this.#active.has(id)) throw new Error('Cancel the download before removing it');
    if (this.store.has(id)) await this.store.remove(id); this.#jobs.delete(id); await this.#save(); return { removed: 1 };
  }
  async clearCompleted() { let removed = 0; for (const job of [...this.#jobs.values()]) if (!ACTIVE.has(job.status) && !this.#active.has(job.id)) { await this.remove(job.id); removed++; } return { removed }; }
  async clearAll() {
    this.#clearing = true;
    try { await this.cancelAll(); await Promise.allSettled([...this.#active.values()].map(entry => entry.promise)); return await this.clearCompleted(); }
    finally { this.#clearing = false; this.#pump(); }
  }
  open(id) { const job = this.#get(id); if (!job.offline || job.status !== 'COMPLETED') throw new Error('Download is not available offline'); return this.store.open(id); }
  page(id, index) { this.open(id); return this.store.page(id, index); }
  exportTo(id, destination) { this.open(id); return this.store.exportTo(id, destination); }
  exportBundleTo(ids, destination) { for (const id of ids) this.open(id); return this.store.exportBundleTo(ids, destination); }
  async close() {
    if (this.#closing) { await Promise.allSettled([...this.#active.values()].map(entry => entry.promise)); return; }
    this.#closing = true;
    await this.#mutations.catch(() => {});
    for (const entry of this.#active.values()) entry.controller.abort();
    await Promise.allSettled([...this.#active.values()].map(entry => entry.promise)); await this.#save(); await this.store.close();
  }
}
module.exports = { NativeDownloadBroker, descriptor, settings };
