'use strict';
const path = require('node:path');
const { NativeSyncBroker } = require('./sync.cjs');

// Main-process orchestration. All OS paths come from dialogs or fixed private
// profile directories; renderer operations carry only opaque IDs and metadata.
class DesktopFeatures {
  constructor({ profile, helper, encryption, dialogs, window, localServer, fetchPages, fetchImage, onVerification, onDownloadsChanged, validateImage }) {
    this.options = { profile, helper, encryption, dialogs, window, localServer, fetchPages, fetchImage, onVerification, onDownloadsChanged, validateImage };
    this.dialogBusy = false;
    this.sync = new NativeSyncBroker({ directory: path.join(profile, 'accounts'), helper, encryption });
    const { TrackingBroker } = require('./tracking.cjs');
    this.tracking = new TrackingBroker({ directory: path.join(profile, 'accounts'), encryption });
  }
  async init() {
    try {
    const { OfflineStore } = require('./offline-store.cjs');
    const { NativeDownloadBroker } = require('./downloads.cjs');
    const { LocalFilesBroker } = require('./local-files.cjs');
    this.store = new OfflineStore({ root: path.join(this.options.profile, 'offline'), validateImage: this.options.validateImage });
    await this.store.init();
    this.files = new LocalFilesBroker({ store: this.store });
    this.downloads = new NativeDownloadBroker({ store: this.store, fetchPages: this.options.fetchPages, fetchImage: this.options.fetchImage, onVerification: this.options.onVerification, onChanged: this.options.onDownloadsChanged });
    await this.downloads.init();
    } catch { this.offlineFailure = new Error('Your offline library could not be loaded. Your files are retained. Restart Nyora to try again.'); }
  }
  #book(book) {
    return { ...book, pages: (book.pages || []).map(page => ({ ...page, url: this.options.localServer.localMediaUrl(book.id, page.index) })) };
  }
  #cover(book) {
    return (book.pageCount > 0 || book.offline && book.totalPages > 0) ? { ...book, coverUrl: this.options.localServer.localMediaUrl(book.bookId || book.id, 0) } : book;
  }
  async #dialog(operation) {
    if (this.dialogBusy) throw new Error('Finish the open file dialog first.');
    this.dialogBusy = true;
    try { return await operation(); } finally { this.dialogBusy = false; }
  }
  async request(operation, params = {}) {
    if (operation.startsWith('sync.')) return this.sync.request(operation, params);
    if (operation.startsWith('tracking.')) return this.tracking.request(operation, params);
    if (this.offlineFailure) throw this.offlineFailure;
    const downloads = this.downloads;
    if (operation === 'downloads.snapshot') {
      const result = await downloads.committedSnapshot();
      return { ...result, entries: result.entries.map(book => this.#cover(book)), warnings: this.store.status().issues };
    }
    if (operation === 'downloads.enqueue') return downloads.enqueue(params.descriptors);
    if (operation === 'downloads.settings.save') return downloads.configure(params.patch);
    for (const name of ['cancel', 'retry', 'remove']) if (operation === `downloads.${name}`) return downloads[name](params.id);
    for (const name of ['cancelAll', 'clearCompleted', 'clearAll', 'pause', 'resume', 'retryFailed']) if (operation === `downloads.${name}`) return downloads[name]();
    if (operation === 'downloads.open') return this.#book(await downloads.open(params.id));
    if (operation === 'downloads.export' || operation === 'downloads.exportBundle') return this.#dialog(async () => {
      const bundle = operation === 'downloads.exportBundle';
      if (bundle) {
        if (!Array.isArray(params.ids) || !params.ids.length || params.ids.length > 200 || new Set(params.ids).size !== params.ids.length) throw new Error('Choose 1–200 completed downloads.');
        for (const id of params.ids) downloads.open(id);
      }
      const format = bundle || downloads.snapshot().settings.format === 'ZIP' ? 'zip' : 'cbz';
      const book = bundle ? null : await downloads.open(params.id);
      const title = bundle ? 'Nyora downloaded chapters' : [book.title, book.chapterTitle].filter(Boolean).join(' - ');
      const safeName = String(title || 'Nyora chapter').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
      const picked = await this.options.dialogs.showSaveDialog(this.options.window(), { title: bundle ? 'Export downloaded chapters' : 'Export chapter', defaultPath: `${safeName}.${format}`, filters: [{ name: bundle ? 'ZIP archive' : 'Comic book archive', extensions: [format] }] });
      if (picked.canceled || !picked.filePath) return { cancelled: true };
      if (bundle) await downloads.exportBundleTo(params.ids, picked.filePath);
      else await downloads.exportTo(params.id, picked.filePath);
      return { exported: true };
    });
    if (operation === 'local.list') {
      const result = await this.files.list(); return { ...result, books: result.books.map(book => this.#cover(book)), warnings: this.store.status().issues };
    }
    if (operation === 'local.select') return this.#dialog(async () => {
      if (!['archive', 'folder', 'files'].includes(params.kind)) throw new Error('Choose comic archives or an image folder.');
      const folder = params.kind === 'folder';
      const selected = await this.options.dialogs.showOpenDialog(this.options.window(), { title: folder ? 'Import an image folder' : 'Import comic archives', properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'], ...(folder ? {} : { filters: [{ name: 'Comic archives', extensions: ['cbz', 'zip'] }] }) });
      if (selected.canceled || !selected.filePaths.length) return { cancelled: true, books: [] };
      if (selected.filePaths.length > 50) throw new Error('Import up to 50 books at a time.');
      const books = [];
      const failures = [];
      for (const file of selected.filePaths) {
        try { const result = await this.files.importSelected(file); books.push(...result.books.map(book => this.#cover(book))); }
        catch (error) { failures.push(`${path.basename(file)}: ${error.code ? 'The file could not be read.' : String(error.message || error).slice(0, 200)}`); }
      }
      if (!books.length && failures.length) throw new Error(failures.join('\n').slice(0, 1000));
      return { books, failures };
    });
    if (operation === 'local.open') return this.#book(await this.files.open(params.id));
    if (operation === 'local.remove') return this.files.remove(params.id);
    if (operation === 'local.progress') {
      const patch = {};
      if (Object.hasOwn(params, 'page')) patch.page = params.page;
      if (Object.hasOwn(params, 'prefs')) {
        if (!params.prefs || typeof params.prefs !== 'object' || Array.isArray(params.prefs)) throw new Error('Invalid offline reader preferences');
        patch.prefs = { ...params.prefs };
        if (Object.hasOwn(patch.prefs, 'mangaId')) {
          if (patch.prefs.mangaId !== `local:${params.id}`) throw new Error('Offline book identity does not match');
          delete patch.prefs.mangaId;
        }
      }
      return this.store.updateProgress(params.id, patch);
    }
    throw new Error('Unknown desktop feature');
  }
  page(id, index) { if (this.offlineFailure) throw this.offlineFailure; return this.store.page(id, index); }
  async close() {
    const results = await Promise.allSettled([this.offlineFailure ? this.store?.close() : this.downloads?.close(), this.sync.close(), this.tracking.close?.()]);
    if (results.some(result => result.status === 'rejected')) console.error('Some desktop state could not finish saving before shutdown.');
  }
}
module.exports = { DesktopFeatures };
