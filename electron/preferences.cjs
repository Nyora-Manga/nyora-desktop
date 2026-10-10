'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { normalizeAiEndpoint } = require('./content-policy.cjs');

const choices = {
  appearance: ['DARK', 'LIGHT', 'SYSTEM'], gridSize: ['S', 'M', 'L'],
  darkStyle: ['BLACK', 'SOFT'], uiScale: ['S', 'M', 'L'], searchScope: ['pinned', 'all'],
  aiProvider: ['openai', 'anthropic'],
};
const booleans = new Set(['showCardTitles', 'reduceMotion', 'navRail', 'noBlur', 'showNsfw', 'noNsfwHistory', 'incognito', 'experimental', 'aiFandom', 'exploreShowNsfw', 'onboarded', 'hideCommunityLinks']);
const readerBooleans = new Set(['prefetch', 'colorize', 'translate', 'keepAwake', 'tapZones', 'edgeGestures', 'immersive']);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validatePatch(patch) {
  if (!plain(patch)) throw new Error('Preferences must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(choices, key)) {
      if (!choices[key].includes(value)) throw new Error(`Invalid preference: ${key}`);
    } else if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`Invalid preference: ${key}`);
    } else if (key === 'automation') {
      require('./automation.cjs').validateAutomation(value);
    } else if (key === 'sourceFilterPresets') {
      const str = (s, max) => typeof s === 'string' && s.length <= max;
      if (!Array.isArray(value) || value.length > 20 || Buffer.byteLength(JSON.stringify(value)) > 24000 || value.some(p =>
        !plain(p) || !str(p.sourceId, 160) || !p.sourceId || !str(p.name, 80) || !p.name.trim() || !str(p.query, 200) ||
        !Array.isArray(p.filters) || p.filters.length > 16 || p.filters.some(f => !plain(f) || !str(f.name, 80) || f.type !== 'text' || !str(f.value, 4096))
      ) || new Set(value.map(p => JSON.stringify([p.sourceId, p.name.trim().toLowerCase()]))).size !== value.length) throw new Error('Invalid source filter presets');
    } else if (key === 'searchRecent') {
      if (!Array.isArray(value) || value.length > 10 || value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim() || item.length > 200) || new Set(value.map(item => item.toLowerCase())).size !== value.length) throw new Error('Invalid recent searches');
    } else if (['searchLanguage', 'exploreLanguage'].includes(key)) {
      if (typeof value !== 'string' || !/^[a-zA-Z-]{2,32}$/.test(value)) throw new Error('Invalid source language');
    } else if (key === 'reader') {
      if (!plain(value)) throw new Error('Reader preferences must be an object');
      for (const [name, setting] of Object.entries(value)) {
        if (readerBooleans.has(name)) {
          if (typeof setting !== 'boolean') throw new Error(`Invalid reader preference: ${name}`);
        } else if (name === 'mode') {
          if (!['WEBTOON', 'PAGED', 'PAGED_RTL', 'VERTICAL'].includes(setting)) throw new Error('Invalid reader mode');
        } else if (name === 'fit') {
          if (!['WIDTH', 'HEIGHT'].includes(setting)) throw new Error('Invalid reader fit');
        } else if (name === 'autoScrollLevel') {
          if (!Number.isInteger(setting) || setting < 0 || setting > 10) throw new Error('Invalid scroll speed');
        } else if (name === 'webtoonWidth') {
          if (!Number.isFinite(setting) || setting < 10 || setting > 100) throw new Error('Invalid reader width');
        } else if (['translateTo', 'translateFrom'].includes(name)) {
          if (typeof setting !== 'string' || !/^[a-zA-Z-]{2,12}$/.test(setting)) throw new Error('Invalid translation language');
        } else throw new Error(`Unknown reader preference: ${name}`);
      }
    } else if (['accent', 'aiEndpoint', 'aiApiKey', 'aiModel'].includes(key)) {
      if (typeof value !== 'string' || value.length > (key === 'aiApiKey' ? 8192 : 2048)) throw new Error(`Invalid preference: ${key}`);
      if (key === 'aiEndpoint') normalizeAiEndpoint(value);
    } else throw new Error(`Unknown preference: ${key}`);
  }
}

class DevicePreferences {
  #pending = Promise.resolve();
  constructor(directory, encryption, { publish = fs.rename } = {}) {
    if (!path.isAbsolute(directory)) throw new Error('Preferences directory must be absolute');
    this.directory = directory;
    this.file = path.join(directory, 'device-preferences.json');
    this.encryption = encryption;
    this.publish = publish;
  }

  #secure() {
    return this.encryption?.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text';
  }

  async #read() {
    try {
      const metadata = await fs.lstat(this.file);
      if (!metadata.isFile() || metadata.size > 65536) throw new Error('Invalid native preferences file');
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (stored.version !== 1 || !plain(stored.preferences)) throw new Error('Unsupported native preferences file');
      // Previous releases accepted custom endpoints that their CSP then blocked.
      // Use the selected provider's default while retaining its model and key.
      const preferences = { ...stored.preferences };
      if (Object.hasOwn(preferences, 'aiEndpoint')) preferences.aiEndpoint = normalizeAiEndpoint(preferences.aiEndpoint, { legacy: true, provider: preferences.aiProvider || 'openai' });
      validatePatch(preferences);
      preferences.reader = { ...(preferences.reader || {}) };
      if (stored.encryptedAiKey) {
        if (!this.#secure()) throw new Error('The operating system credential store is unavailable');
        preferences.aiApiKey = this.encryption.decryptString(Buffer.from(stored.encryptedAiKey, 'base64'));
      }
      return preferences;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async get() { await this.#pending.catch(() => {}); return this.#read(); }

  save(patch) {
    validatePatch(patch);
    patch = structuredClone(patch);
    if (Object.hasOwn(patch, 'aiEndpoint')) patch.aiEndpoint = normalizeAiEndpoint(patch.aiEndpoint);
    const operation = this.#pending.catch(() => {}).then(async () => {
      const previous = await this.#read();
      const next = { ...previous, ...patch };
      if (Object.hasOwn(next, 'aiEndpoint')) {
        const switching = Object.hasOwn(patch, 'aiProvider') && !Object.hasOwn(patch, 'aiEndpoint');
        next.aiEndpoint = normalizeAiEndpoint(next.aiEndpoint, { provider: next.aiProvider || 'openai', legacy: switching });
      }
      if (patch.reader) next.reader = { ...(previous.reader || {}), ...patch.reader };
      const stored = { version: 1, preferences: { ...next } };
      delete stored.preferences.aiApiKey;
      if (next.aiApiKey) {
        if (!this.#secure()) throw new Error('The operating system credential store is unavailable; the API key was not saved');
        stored.encryptedAiKey = this.encryption.encryptString(next.aiApiKey).toString('base64');
      }
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Preferences directory cannot be a symlink');
      const pending = path.join(this.directory, `.preferences-${randomBytes(12).toString('hex')}.pending`);
      try {
        const handle = await fs.open(pending, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(stored)); await handle.sync(); }
        finally { await handle.close(); }
        await this.publish(pending, this.file);
      } finally { await fs.rm(pending, { force: true }); }
      return next;
    });
    this.#pending = operation;
    return operation;
  }
}

module.exports = { DevicePreferences, validatePatch };
