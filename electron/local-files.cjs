'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { openArchive } = require('./offline-archive.cjs');
const images = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const archives = /\.(cbz|zip)$/i;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const ordered = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
async function selectedInfo(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('Local selection must come from a native file dialog');
  const info = await fs.lstat(selected);
  if (info.isSymbolicLink()) throw new Error('Local symbolic links are not supported');
  return info;
}
async function readImage(selected, maximum) {
  await selectedInfo(selected);
  const file = await fs.open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const info = await file.stat(); if (!info.isFile() || !info.size || info.size > maximum) throw new Error('Selected image exceeds limits'); return { bytes: await file.readFile() }; }
  finally { await file.close(); }
}
class LocalFilesBroker {
  constructor({ store } = {}) { if (!store) throw new Error('Local files require an owned offline store'); this.store = store; }
  async #archive(selected) {
    const archive = await openArchive(selected, { maxBytes: this.store.maxBookBytes });
    try {
      const entries = archive.entries.filter(entry => !entry.name.endsWith('/') && images.test(entry.name)).sort((a, b) => ordered(a.name, b.name));
      if (!entries.length || entries.length > this.store.maxPages) throw new Error('Archive has no readable pages or exceeds limits');
      const store = this.store;
      async function* pages() { for (const entry of entries) yield { bytes: await archive.read(entry, store.maxPageBytes) }; }
      return await store.createBook({ title: path.basename(selected).replace(archives, '') }, pages());
    } finally { await archive.close(); }
  }
  async #folder(selected, names) {
    if (!names.length || names.length > this.store.maxPages) throw new Error('Image folder exceeds limits');
    const store = this.store;
    async function* pages() { for (const name of names.sort(ordered)) yield await readImage(path.join(selected, name), store.maxPageBytes); }
    return store.createBook({ title: path.basename(selected) }, pages());
  }
  async importSelected(selected) {
    const info = await selectedInfo(selected), books = [];
    if (info.isFile()) {
      if (archives.test(selected)) books.push(await this.#archive(selected));
      else if (images.test(selected)) books.push(await this.store.createBook({ title: path.basename(selected) }, [await readImage(selected, this.store.maxPageBytes)]));
      else throw new Error('Choose a CBZ/ZIP archive or an image folder');
    } else if (info.isDirectory()) {
      const children = await fs.readdir(selected, { withFileTypes: true });
      if (children.length > 5000) throw new Error('Selected folder exceeds limits');
      // Validate all relevant candidates before publishing any folder book.
      if (children.some(child => child.isSymbolicLink())) throw new Error('Local symbolic links are not supported');
      const loose = children.filter(child => child.isFile() && images.test(child.name)).map(child => child.name);
      const candidates = children.filter(child => child.isFile() && archives.test(child.name)).sort((a, b) => ordered(a.name, b.name));
      const subfolders = [];
      for (const child of children.filter(child => child.isDirectory()).sort((a, b) => ordered(a.name, b.name))) {
        const folder = path.join(selected, child.name); await selectedInfo(folder);
        const entries = await fs.readdir(folder, { withFileTypes: true });
        if (entries.length > 5000 || entries.some(entry => entry.isSymbolicLink())) throw new Error('Selected image folder exceeds limits or contains symbolic links');
        const names = entries.filter(entry => entry.isFile() && images.test(entry.name)).map(entry => entry.name);
        if (names.length) subfolders.push({ folder, names });
      }
      if (candidates.length + subfolders.length + (loose.length ? 1 : 0) > 200) throw new Error('Select up to 200 local books at a time');
      try {
        if (loose.length) books.push(await this.#folder(selected, loose));
        for (const { folder, names } of subfolders) books.push(await this.#folder(folder, names));
        for (const child of candidates) books.push(await this.#archive(path.join(selected, child.name)));
      } catch (error) {
        // A folder import commits as a collection; keep no half-imported shelf.
        for (const book of books) await this.store.remove(book.id);
        throw error;
      }
      if (!books.length) throw new Error('No supported images or CBZ/ZIP archives were found');
    } else throw new Error('Local selection must be a regular file or directory');
    return { books };
  }
  list() { return { books: this.store.list('local') }; }
  open(id) { return this.store.open(id); }
  page(id, index) { return this.store.page(id, index); }
  remove(id) { return this.store.remove(id); }
  updateProgress(id, value) { return this.store.updateProgress(id, value); }
  exportTo(id, destination) { return this.store.exportTo(id, destination); }
}
module.exports = { LocalFilesBroker, ordered };
