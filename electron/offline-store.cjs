'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeArchive, crc32 } = require('./offline-archive.cjs');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' };
function text(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > 16384 || /[\0-\x1f\x7f]/.test(value)) throw new Error('Invalid offline metadata');
  return value;
}
function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error('Invalid image data');
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, data = false, dimensions = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
      if (end > bytes.length || crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) throw new Error('Damaged PNG image');
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (kind === 'IHDR') dimensions = size === 13 && bytes.readUInt32BE(offset + 8) > 0 && bytes.readUInt32BE(offset + 12) > 0;
      if (kind === 'IDAT') data = true;
      if (kind === 'IEND') { if (!size && dimensions && data && end === bytes.length) return 'image/png'; break; }
      offset = end;
    }
    throw new Error('Incomplete PNG image');
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217 && bytes.includes(Buffer.from([255,218]))) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) && bytes.readUInt16LE(8) && bytes.at(-1) === 59) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length
    && /avif|avis/.test(bytes.toString('ascii', 8, bytes.readUInt32BE(0)))) return 'image/avif';
  if (bytes.toString('ascii', 0, 2) === 'BM' && bytes.readUInt32LE(2) === bytes.length) return 'image/bmp';
  throw new Error('Unsupported or incomplete image');
}
function imageDimensions(bytes, type) {
  const check = (width, height) => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 100000 || height > 100000 || width * height > 100000000) throw new Error('Image dimensions exceed supported limits');
    return { width, height };
  };
  if (type === 'image/png') return check(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (type === 'image/gif') return check(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (type === 'image/bmp' && bytes.length >= 26) return check(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22)));
  if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) return check(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      offset += length;
    }
  }
  if (type === 'image/webp') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) return check(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return check((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1); }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) return check(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (type === 'image/avif') {
    let found;
    function boxes(start, end, parents = [], depth = 0) {
      if (depth > 8) throw new Error('Image metadata exceeds limits');
      let count = 0;
      for (let offset = start; offset + 8 <= end;) {
        if (++count > 2000) throw new Error('Image metadata exceeds limits');
        let size = bytes.readUInt32BE(offset), header = 8;
        const kind = bytes.toString('ascii', offset + 4, offset + 8);
        if (size === 1) { if (offset + 16 > end) break; const large = bytes.readBigUInt64BE(offset + 8); if (large > BigInt(end - offset)) break; size = Number(large); header = 16; }
        if (size === 0) size = end - offset;
        if (size < header || offset + size > end) break;
        if (kind === 'ispe' && parents.join('/') === 'meta/iprp/ipco' && size >= header + 12) found = check(bytes.readUInt32BE(offset + header + 4), bytes.readUInt32BE(offset + header + 8));
        if ((kind === 'meta' && !parents.length) || (kind === 'iprp' && parents.join('/') === 'meta') || (kind === 'ipco' && parents.join('/') === 'meta/iprp')) boxes(offset + header + (kind === 'meta' ? 4 : 0), offset + size, [...parents, kind], depth + 1);
        offset += size;
      }
    }
    boxes(0, bytes.length); if (found) return found;
  }
  throw new Error('Image dimensions could not be validated');
}
class OfflineStore {
  #books = new Map();
  #pending = Promise.resolve();
  constructor({ root, maxPageBytes = 32 * 1024 * 1024, maxBookBytes = 512 * 1024 * 1024, maxPages = 2000, validateImage } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.dirname(root) === root) throw new Error('Offline root must be an absolute owned directory');
    for (const value of [maxPageBytes, maxBookBytes, maxPages]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid offline limits');
    this.root = path.resolve(root); this.maxPageBytes = maxPageBytes; this.maxBookBytes = maxBookBytes; this.maxPages = maxPages;
    this.validateImage = validateImage;
  }
  async confined(relative, { absent = false } = {}) {
    const target = path.resolve(this.root, relative), parts = path.relative(this.root, target).split(path.sep);
    if (path.relative(this.root, target).startsWith('..') || path.isAbsolute(path.relative(this.root, target))) throw new Error('Path escapes offline store');
    let current = this.root;
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Offline symlinks are forbidden'); }
      catch (error) { if (error.code === 'ENOENT' && absent) break; throw error; }
    }
    return target;
  }
  async init() {
    this.issues = [];
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.confined('');
    for (const directory of ['books', 'staging']) {
      const target = await this.confined(directory, { absent: true }); await fs.mkdir(target, { recursive: true, mode: 0o700 });
    }
    // Only staging directories under this owned root are removed after interruption.
    for (const name of await fs.readdir(await this.confined('staging'))) {
      if (ID.test(name)) await fs.rm(await this.confined(`staging/${name}`), { recursive: true, force: true });
    }
    this.#books.clear();
    for (const name of await fs.readdir(await this.confined('books'))) {
      if (!ID.test(name)) continue;
      try {
      const meta = await this.readState(`books/${name}/book.json`);
      if (!meta || meta.schema !== 1 || meta.id !== name || !Array.isArray(meta.pages) || !meta.pages.length || meta.pages.length > this.maxPages
        || meta.pages.some(page => !/^\d{4}\.(png|jpg|webp|gif|avif|bmp)$/.test(page.name) || !types[page.contentType]
          || !Number.isSafeInteger(page.size) || page.size <= 0 || page.size > this.maxPageBytes)) throw new Error('Offline book metadata is damaged');
      for (const key of ['title', 'chapterTitle', 'sourceId', 'mangaId', 'mangaUrl', 'chapterId', 'chapterUrl']) if (meta[key] !== undefined) text(meta[key]);
      if (!meta.state || !Number.isSafeInteger(meta.state.page) || meta.state.page < 0 || meta.state.page >= meta.pages.length) throw new Error('Offline reader state is damaged');
      if (meta.state.prefs) require('./local-reader-preferences.cjs').validateLocalPreferences(meta.state.prefs);
      for (const page of meta.pages) {
        const info = await fs.lstat(await this.confined(`books/${name}/pages/${page.name}`));
        if (!info.isFile() || info.size !== page.size) throw new Error('Offline book page is damaged');
      }
      this.#books.set(name, meta);
      } catch { this.issues.push({ id: name, message: 'This offline book is damaged; its original files have been retained for recovery.' }); }
    }
    return this;
  }
  status() { return { issues: structuredClone(this.issues || []) }; }
  async readState(relative) {
    let file;
    try { file = await fs.open(await this.confined(relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Offline metadata exceeds limits');
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  writeState(relative, value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) return Promise.reject(new Error('Offline metadata exceeds limits'));
    const operation = this.#pending.catch(() => {}).then(async () => {
      const target = await this.confined(relative, { absent: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
    });
    this.#pending = operation; return operation;
  }
  #get(id) { if (!ID.test(id) || !this.#books.has(id)) throw new Error('Offline book was not found'); return this.#books.get(id); }
  #dto(meta, pages = false) {
    const { schema, pages: storedPages, ...publicMeta } = meta;
    return structuredClone({ ...publicMeta, pageCount: storedPages.length, ...(pages ? { pages: storedPages.map((page, index) => ({ index, contentType: page.contentType })) } : {}) });
  }
  list(kind) { return [...this.#books.values()].filter(meta => !kind || meta.kind === kind).map(meta => this.#dto(meta)); }
  open(id) { return this.#dto(this.#get(id), true); }
  has(id) { return this.#books.has(id); }
  async createBook(metadata, pages, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    const id = metadata.id || randomUUID(); if (!ID.test(id) || this.#books.has(id)) throw new Error('Invalid or duplicate offline ID');
    const meta = { schema: 1, id, kind: metadata.kind === 'download' ? 'download' : 'local', title: text(metadata.title, 'Untitled'),
      chapterTitle: text(metadata.chapterTitle, metadata.title || 'Chapter'), createdAt: Date.now(), state: { page: 0 }, bytes: 0, pages: [] };
    for (const key of ['sourceId', 'mangaId', 'mangaUrl', 'chapterId', 'chapterUrl']) if (metadata[key] !== undefined) meta[key] = text(metadata[key]);
    const stage = await this.confined(`staging/${id}`, { absent: true });
    await fs.mkdir(path.join(stage, 'pages'), { recursive: true, mode: 0o700 });
    try {
      for await (const page of pages) {
        signal?.throwIfAborted();
        const bytes = page?.bytes;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > this.maxPageBytes || meta.pages.length >= this.maxPages || meta.bytes + bytes.length > this.maxBookBytes) throw new Error('Offline page exceeds limits');
        const contentType = imageType(bytes);
        imageDimensions(bytes, contentType);
        if (page.contentType && ![contentType, 'application/octet-stream'].includes(page.contentType.split(';')[0].toLowerCase())) throw new Error('Image content type does not match its bytes');
        if (this.validateImage && await this.validateImage(bytes, contentType) === false) throw new Error('Image cannot be decoded');
        const name = `${String(meta.pages.length + 1).padStart(4, '0')}.${types[contentType]}`;
        await fs.writeFile(path.join(stage, 'pages', name), bytes, { flag: 'wx', mode: 0o600 });
        meta.pages.push({ name, contentType, size: bytes.length }); meta.bytes += bytes.length;
        await onProgress?.({ completedPages: meta.pages.length, bytes: meta.bytes });
      }
      if (!meta.pages.length) throw new Error('This book has no readable pages');
      await writeArchive(path.join(stage, 'book.cbz'), meta.pages.map(page => ({ name: page.name, path: path.join(stage, 'pages', page.name) })), { signal, maxBytes: this.maxBookBytes });
      await this.writeState(`staging/${id}/book.json`, meta);
      signal?.throwIfAborted();
      const target = await this.confined(`books/${id}`, { absent: true });
      await fs.rename(stage, target); this.#books.set(id, meta);
      return this.#dto(meta);
    } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
  }
  async page(id, index) {
    const meta = this.#get(id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= meta.pages.length) throw new Error('Invalid offline page');
    const page = meta.pages[index], file = await fs.open(await this.confined(`books/${id}/pages/${page.name}`), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await file.stat(); if (!info.isFile() || info.size !== page.size || info.size > this.maxPageBytes) throw new Error('Offline page is damaged');
      return { bytes: await file.readFile(), contentType: page.contentType };
    } finally { await file.close(); }
  }
  #bookMutations = Promise.resolve();
  #mutateBook(operation) {
    const pending = this.#bookMutations.catch(() => {}).then(operation);
    this.#bookMutations = pending; return pending;
  }
  updateProgress(id, patch = {}) {
    const { validateLocalPreferences } = require('./local-reader-preferences.cjs');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['page', 'prefs'].includes(key))) throw new Error('Invalid offline reader state');
    if (Object.hasOwn(patch, 'prefs')) validateLocalPreferences(patch.prefs);
    const copy = structuredClone(patch);
    return this.#mutateBook(async () => {
      const current = this.#get(id);
      if (Object.hasOwn(copy, 'page') && (!Number.isSafeInteger(copy.page) || copy.page < 0 || copy.page >= current.pages.length)) throw new Error('Invalid reader position');
      const state = { ...current.state, ...copy, ...(copy.prefs ? { prefs: { ...current.state?.prefs, ...copy.prefs } } : {}) };
      const next = { ...current, state }; await this.writeState(`books/${id}/book.json`, next); this.#books.set(id, next); return structuredClone(state);
    });
  }
  remove(id) {
    return this.#mutateBook(async () => {
      this.#get(id); await fs.rm(await this.confined(`books/${id}`), { recursive: true, force: true }); this.#books.delete(id); return { removed: 1 };
    });
  }
  async #export(destination, create) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.basename(destination) === '.') throw new Error('Export destination must come from a native dialog');
    const temporary = path.join(path.dirname(destination), `.nyora-export-${randomUUID()}.tmp`);
    try { await create(temporary); await fs.rename(temporary, destination); return { ok: true, status: 'saved' }; }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async exportTo(id, destination) {
    this.#get(id); const archive = await this.confined(`books/${id}/book.cbz`);
    return this.#export(destination, temporary => fs.copyFile(archive, temporary, constants.COPYFILE_EXCL));
  }
  async exportBundleTo(ids, destination) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('Invalid download bundle');
    const entries = [];
    for (const id of ids) { this.#get(id); entries.push({ name: `${id}.cbz`, path: await this.confined(`books/${id}/book.cbz`) }); }
    return this.#export(destination, temporary => writeArchive(temporary, entries, { maxBytes: this.maxBookBytes }));
  }
  async close() { await this.#bookMutations.catch(() => {}); await this.#pending; }
}
module.exports = { OfflineStore, imageType, imageDimensions, text, ID };
