'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const EXTRA_PREFS = Object.freeze(['readerFit', 'prefetch', 'webtoonWidth', 'autoScrollLevel', 'translateTo', 'translateFrom', 'invert']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validatePrefs(patch) {
  if (!plain(patch) || Object.keys(patch).some(key => !EXTRA_PREFS.includes(key))) throw new Error('Invalid title preferences');
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') continue;
    if (key === 'prefetch') { if (typeof value !== 'boolean') throw new Error('Invalid title preference'); }
    else if (key === 'invert') { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid image inversion'); }
    else if (key === 'readerFit') { if (!['WIDTH', 'HEIGHT'].includes(value)) throw new Error('Invalid reader fit'); }
    else if (key === 'webtoonWidth') { if (!Number.isFinite(value) || value < 10 || value > 100) throw new Error('Invalid reader width'); }
    else if (key === 'autoScrollLevel') { if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error('Invalid scroll speed'); }
    else if (typeof value !== 'string' || !/^[a-zA-Z-]{2,12}$/.test(value)) throw new Error('Invalid reader language');
  }
}
function validateMarks(value) {
  if (!plain(value) || Object.keys(value).some(key => !['read', 'unread'].includes(key))) throw new Error('Invalid chapter marks');
  for (const key of ['read', 'unread']) {
    if (!Array.isArray(value[key]) || value[key].length > 2000 || value[key].some(chapter => typeof chapter !== 'string' || !chapter || chapter.length > 8192 || /[\x00-\x1f]/.test(chapter))) throw new Error('Invalid chapter marks');
  }
  if (new Set(value.read).size !== value.read.length || new Set(value.unread).size !== value.unread.length || value.read.some(chapter => value.unread.includes(chapter))) throw new Error('Conflicting chapter marks');
}
class ReaderState {
  #pending = Promise.resolve();
  constructor(directory, { publish = fs.rename } = {}) { if (!path.isAbsolute(directory)) throw new Error('Invalid reader directory'); this.directory = directory; this.publish = publish; }
  #file(id) {
    if (!['string', 'number'].includes(typeof id) || !String(id) || String(id).length > 1024 || /[\x00-\x1f]/.test(String(id))) throw new Error('Invalid manga identity');
    return path.join(this.directory, `${createHash('sha256').update(String(id)).digest('hex')}.json`);
  }
  async #read(id) {
    const file = this.#file(id);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 524288) throw new Error('Invalid reader state');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || data.mangaId !== String(id)) throw new Error('Invalid reader state');
      validatePrefs(data.preferences); validateMarks(data.marks);
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, mangaId: String(id), preferences: {}, marks: { read: [], unread: [] } }; throw error; }
  }
  async get(id) { await this.#pending.catch(() => {}); return this.#read(id); }
  #write(id, change) {
    this.#file(id);
    const task = this.#pending.catch(() => {}).then(async () => {
      const data = change(await this.#read(id));
      const text = JSON.stringify(data);
      if (Buffer.byteLength(text) > 524288) throw new Error('This title has too many saved chapter marks');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Invalid reader directory');
      const temporary = path.join(this.directory, `.reader-${randomBytes(12).toString('hex')}.pending`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        await this.publish(temporary, this.#file(id));
      } finally { await fs.rm(temporary, { force: true }); }
      return structuredClone(data);
    });
    this.#pending = task; return task;
  }
  async clearAllMarks() {
    let files;try{files=await fs.readdir(this.directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const file of files.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))) {
      const target=path.join(this.directory,file),info=await fs.lstat(target);
      if(!info.isFile()||info.isSymbolicLink()||info.size>524288)throw new Error('Invalid reader state');
      const data=JSON.parse(await fs.readFile(target,'utf8'));
      if(this.#file(data.mangaId)!==target)throw new Error('Invalid reader state identity');
      await this.saveMarks(data.mangaId,{read:[],unread:[]});
    }
  }
  savePreferences(id, patch) { validatePrefs(patch); return this.#write(id, state => ({ ...state, preferences: { ...state.preferences, ...patch } })); }
  clearPreferences(id) { return this.#write(id, state => ({ ...state, preferences: {} })); }
  saveMarks(id, marks) { validateMarks(marks); const copy = structuredClone(marks); return this.#write(id, state => ({ ...state, marks: copy })); }
}
module.exports = { ReaderState, EXTRA_PREFS, validatePrefs, validateMarks };
