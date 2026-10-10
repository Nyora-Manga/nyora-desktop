'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const ENDPOINT = 'https://graphql.anilist.co';
const STATUSES = Object.freeze({ reading: 'CURRENT', planning: 'PLANNING', completed: 'COMPLETED', paused: 'PAUSED', dropped: 'DROPPED', rereading: 'REPEATING' });
const fields = Object.freeze({ capabilities: [], connect: ['slug', 'token'], disconnect: ['slug'], setEnabled: ['slug', 'enabled'], link: ['slug', 'mangaId', 'mediaId'], unlink: ['slug', 'mangaId'], search: ['slug', 'title'], getState: ['slug', 'mediaId'], setState: ['slug', 'mediaId', 'status', 'progress', 'score'], scrobble: ['mangaId', 'chapter'] });
const QUERY_STATE = 'query NyoraTrackerState($mediaId:Int!){Media(id:$mediaId,type:MANGA){id mediaListEntry{status progress score(format:POINT_100)}}}';
const QUERY_SAVE = 'mutation NyoraTrackerSave($mediaId:Int!,$status:MediaListStatus,$progress:Int,$scoreRaw:Int){SaveMediaListEntry(mediaId:$mediaId,status:$status,progress:$progress,scoreRaw:$scoreRaw){id mediaId status progress score(format:POINT_100)}}';
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validId(value) { return Number.isInteger(value) && value > 0 && value <= 2147483647; }
function text(value, max = 512) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value); }
function mangaId(value) { return text(value, 1024) && !['__proto__', 'prototype', 'constructor'].includes(value); }
function https(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && value.length <= 4096 ? u.href : undefined; } catch { return undefined; } }

class TrackingBroker {
  #directory; #encryption; #fetch; #tail = Promise.resolve(); #closing = false; #loaded = false; #account = null; #progress = new Map();
  constructor({ directory, encryption, fetch = globalThis.fetch }) {
    if (!path.isAbsolute(directory) || typeof fetch !== 'function') throw new TypeError('Tracking requires an absolute private directory and native fetch');
    this.#directory = directory; this.#encryption = encryption; this.#fetch = fetch;
  }
  request(operation, params = {}) {
    if (this.#closing) return Promise.reject(failure('TRACKER_CLOSING', 'Tracking is closing'));
    const work = this.#tail.then(() => this.#request(operation, params));
    this.#tail = work.catch(() => {}); return work;
  }
  async close() { this.#closing = true; await this.#tail; this.#progress.clear(); }
  #secure() {
    try { return this.#encryption?.isEncryptionAvailable() === true && this.#encryption.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }
  async #load() {
    if (this.#loaded) return;
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.#directory)).isSymbolicLink()) throw failure('TRACKER_STORAGE_FAILED', 'Tracking storage is unavailable');
    const file = path.join(this.#directory, 'tracking.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid storage');
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      const a = stored.account;
      if (stored.version !== 1 || (a && (!validId(a.user?.id) || !text(a.user?.name, 256) || typeof a.enabled !== 'boolean' || !a.links || typeof a.links !== 'object' || Array.isArray(a.links) || Object.keys(a.links).length > 10000 || Object.entries(a.links).some(([key, id]) => !mangaId(key) || !validId(id)) || (a.encryptedToken !== undefined && (typeof a.encryptedToken !== 'string' || a.encryptedToken.length > 32768))))) throw new Error('Invalid storage');
      this.#account = a ? { user: { id: a.user.id, name: a.user.name }, enabled: a.enabled, links: { ...a.links }, ...(a.encryptedToken ? { encryptedToken: a.encryptedToken } : {}) } : null;
    } catch (error) { if (error.code !== 'ENOENT') throw failure('TRACKER_STORAGE_FAILED', 'Tracking storage could not be read'); }
    this.#loaded = true;
  }
  async #persist(account) {
    const serialized = JSON.stringify({ version: 1, account });
    if (Buffer.byteLength(serialized) > 512 * 1024) throw failure('TRACKER_INPUT_INVALID', 'Tracking link storage is full; remove an unused link first');
    const file = path.join(this.#directory, 'tracking.json'), temporary = path.join(this.#directory, `.tracking-${randomBytes(12).toString('hex')}`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file);
      if (process.platform !== 'win32') {
        let directory;
        try { directory = await fs.open(this.#directory, 'r'); await directory.sync(); }
        catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }
        finally { await directory?.close(); }
      }
      this.#account = account;
    } catch { throw failure('TRACKER_STORAGE_FAILED', 'Tracking changes could not be saved'); }
    finally { if (handle) await handle.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  #capabilities() {
    const available = this.#secure(), a = this.#account;
    return { trackers: [{ slug: 'anilist', name: 'AniList', auth: 'access-token', available, ...(available ? {} : { reason: 'A secure native credential store is unavailable' }), connected: Boolean(available && a?.encryptedToken), enabled: Boolean(available && a?.encryptedToken && a.enabled), links: a ? { ...a.links } : {}, ...(a ? { user: { ...a.user } } : {}) }, ...[['myanimelist', 'MyAnimeList'], ['mangabaka', 'MangaBaka']].map(([slug, name]) => ({ slug, name, available: false, reason: 'Desktop OAuth registration is not configured and verified', connected: false, enabled: false, links: {} }))] };
  }
  #credential() {
    if (!this.#secure()) throw failure('TRACKER_STORAGE_UNAVAILABLE', 'A secure native credential store is required');
    if (!this.#account?.encryptedToken) throw failure('TRACKER_AUTH_REQUIRED', 'Connect your AniList account first');
    try { const token = this.#encryption.decryptString(Buffer.from(this.#account.encryptedToken, 'base64')); if (!text(token, 8192)) throw new Error(); return token; }
    catch { throw failure('TRACKER_STORAGE_FAILED', 'The saved tracking credential could not be read'); }
  }
  async #graphql(query, variables, token, persisted = false) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    let result;
    try {
      const response = await this.#fetch(ENDPOINT, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: controller.signal });
      if (response.status === 401) throw failure('TRACKER_AUTH_REQUIRED', 'AniList needs a new access token');
      if (!response.ok) throw failure('TRACKER_REQUEST_FAILED', 'AniList could not complete this request');
      if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error();
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks = []; let size = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw new Error(); chunks.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Array.isArray(result.errors) && result.errors.length) {
        if (result.errors.some(e => /invalid.?token|unauthenticated|unauthorized|not authenticated|authentication/i.test(String(e?.message || '')) || e?.status === 401)) throw failure('TRACKER_AUTH_REQUIRED', 'AniList needs a new access token');
        throw failure('TRACKER_REQUEST_FAILED', 'AniList rejected this request');
      }
      if (!result.data || typeof result.data !== 'object') throw new Error();
      return result.data;
    } catch (error) {
      if (error.code === 'TRACKER_AUTH_REQUIRED') {
        if (persisted && this.#account) { const a = { ...this.#account, enabled: false }; delete a.encryptedToken; await this.#persist(a); this.#progress.clear(); }
        throw error;
      }
      throw failure('TRACKER_REQUEST_FAILED', 'AniList could not complete this request; a write may not have been acknowledged');
    } finally { clearTimeout(timer); }
  }
  async #state(mediaId) {
    const data = await this.#graphql(QUERY_STATE, { mediaId }, this.#credential(), true), entry = data.Media?.mediaListEntry;
    if (!entry) return null;
    const status = Object.keys(STATUSES).find(key => STATUSES[key] === entry.status);
    if (!status || !Number.isInteger(entry.progress) || entry.progress < 0 || entry.progress > 1000000 || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 100) throw failure('TRACKER_RESPONSE_INVALID', 'AniList returned an invalid reading state');
    return { linked: true, status, progress: entry.progress, score: entry.score / 100 };
  }
  async #set(mediaId, patch) {
    const variables = { mediaId };
    if (patch.status !== undefined) variables.status = STATUSES[patch.status];
    if (patch.progress !== undefined) variables.progress = patch.progress;
    if (patch.score !== undefined) variables.scoreRaw = Math.round(patch.score * 100);
    const data = await this.#graphql(QUERY_SAVE, variables, this.#credential(), true), entry = data.SaveMediaListEntry;
    if (!validId(entry?.id) || entry.mediaId !== mediaId || (patch.progress !== undefined && entry.progress !== patch.progress) || (patch.status !== undefined && entry.status !== variables.status) || (patch.score !== undefined && entry.score !== variables.scoreRaw)) throw failure('TRACKER_RESPONSE_INVALID', 'AniList did not acknowledge the requested change');
    return { ok: true };
  }
  async #request(operation, params) {
    const method = typeof operation === 'string' && operation.startsWith('tracking.') ? operation.slice(9) : '';
    if (!Object.hasOwn(fields, method) || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields[method].includes(key))) throw failure('TRACKER_INPUT_INVALID', 'Invalid tracking request');
    if (method !== 'capabilities' && method !== 'scrobble') {
      if (params.slug !== 'anilist') throw failure('TRACKER_UNAVAILABLE', 'This provider requires a verified desktop OAuth registration');
      if (!this.#secure()) throw failure('TRACKER_STORAGE_UNAVAILABLE', 'A secure native credential store is required');
    }
    if (['link', 'unlink', 'scrobble'].includes(method) && !mangaId(params.mangaId)) throw failure('TRACKER_INPUT_INVALID', 'Invalid title identifier');
    if (['link', 'getState', 'setState'].includes(method) && !validId(params.mediaId)) throw failure('TRACKER_INPUT_INVALID', 'Invalid AniList identifier');
    if (method === 'setEnabled' && typeof params.enabled !== 'boolean') throw failure('TRACKER_INPUT_INVALID', 'Invalid tracking preference');
    if (method === 'connect' && !text(params.token, 8192)) throw failure('TRACKER_INPUT_INVALID', 'Enter a valid AniList access token');
    if (method === 'search' && !text(params.title, 256)) throw failure('TRACKER_INPUT_INVALID', 'Enter a title to search');
    if (method === 'scrobble' && (!Number.isFinite(params.chapter) || params.chapter < 0 || params.chapter > 1000000)) throw failure('TRACKER_INPUT_INVALID', 'Invalid chapter progress');
    if (method === 'setState' && ((params.status !== undefined && !Object.hasOwn(STATUSES, params.status)) || (params.progress !== undefined && (!Number.isInteger(params.progress) || params.progress < 0 || params.progress > 1000000)) || (params.score !== undefined && (!Number.isFinite(params.score) || params.score < 0 || params.score > 1)) || ['status', 'progress', 'score'].every(key => params[key] === undefined))) throw failure('TRACKER_INPUT_INVALID', 'Invalid reading state');
    await this.#load();
    if (method === 'capabilities') return this.#capabilities();
    if (method === 'connect') {
      const data = await this.#graphql('query NyoraTrackerViewer{Viewer{id name}}', {}, params.token), user = data.Viewer;
      if (!validId(user?.id) || !text(user?.name, 256)) throw failure('TRACKER_RESPONSE_INVALID', 'AniList did not confirm your account');
      let encryptedToken; try { encryptedToken = this.#encryption.encryptString(params.token).toString('base64'); } catch { throw failure('TRACKER_STORAGE_FAILED', 'The tracking credential could not be saved'); }
      const previous = this.#account;
      await this.#persist({ encryptedToken, user: { id: user.id, name: user.name }, enabled: previous?.user.id === user.id ? previous.enabled : true, links: previous?.user.id === user.id ? { ...previous.links } : {} });
      this.#progress.clear(); return { ok: true };
    }
    if (method === 'disconnect') { await this.#persist(null); this.#progress.clear(); return { ok: true }; }
    if (method === 'search') {
      const data = await this.#graphql('query NyoraTrackerSearch($title:String!){Page(page:1,perPage:20){media(type:MANGA,sort:SEARCH_MATCH,search:$title){id title{userPreferred} coverImage{medium} siteUrl}}}', { title: params.title });
      if (!Array.isArray(data.Page?.media)) throw failure('TRACKER_RESPONSE_INVALID', 'AniList returned invalid search results');
      return { results: data.Page.media.slice(0, 20).filter(item => validId(item?.id) && text(item.title?.userPreferred, 512)).map(item => ({ id: item.id, title: item.title.userPreferred, ...(https(item.coverImage?.medium) ? { cover: https(item.coverImage.medium) } : {}), url: `https://anilist.co/manga/${item.id}` })) };
    }
    if (method === 'getState') return this.#state(params.mediaId);
    if (method === 'setState') { const result = await this.#set(params.mediaId, params); this.#progress.clear(); return result; }
    if (method === 'scrobble') {
      const a = this.#account, mediaId = a && Object.hasOwn(a.links, params.mangaId) ? a.links[params.mangaId] : undefined, chapter = Math.floor(params.chapter);
      if (!a?.encryptedToken || !a.enabled || !mediaId || !this.#secure()) return { updated: [], skipped: true };
      const key = `${a.user.id}:${mediaId}`;
      if ((this.#progress.get(key) ?? -1) >= chapter) return { updated: [], skipped: true };
      const state = await this.#state(mediaId);
      if (state && state.progress >= chapter) { this.#remember(key, state.progress); return { updated: [], skipped: true }; }
      await this.#set(mediaId, { progress: chapter, ...(state ? {} : { status: 'reading' }) }); this.#remember(key, chapter);
      return { updated: [{ slug: 'anilist', mediaId }], skipped: false };
    }
    this.#credential();
    const a = { ...this.#account, links: { ...this.#account.links } };
    if (method === 'setEnabled') a.enabled = params.enabled;
    if (method === 'link') { if (Object.keys(a.links).length >= 10000 && !Object.hasOwn(a.links, params.mangaId)) throw failure('TRACKER_INPUT_INVALID', 'Tracking link limit reached'); a.links[params.mangaId] = params.mediaId; }
    if (method === 'unlink') delete a.links[params.mangaId];
    await this.#persist(a); this.#progress.clear(); return { ok: true };
  }
  #remember(key, value) { this.#progress.delete(key); this.#progress.set(key, value); if (this.#progress.size > 1024) this.#progress.delete(this.#progress.keys().next().value); }
}
module.exports = { TrackingBroker };
