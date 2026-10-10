'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const INITIAL = '1970-01-01T00:00:00Z';
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validateSession(value) {
  if (!plain(value) || Object.keys(value).some(key => !['accessToken', 'refreshToken', 'userId', 'email', 'lastSyncTimestamp'].includes(key))) throw new Error('Invalid account session');
  for (const key of ['accessToken', 'refreshToken', 'userId', 'email', 'lastSyncTimestamp']) {
    if (typeof value[key] !== 'string' || value[key].length > (key.endsWith('Token') ? 16384 : 1024)) throw new Error('Invalid account session');
  }
  if (!Number.isFinite(Date.parse(value.lastSyncTimestamp))) throw new Error('Invalid account sync date');
  if (!!value.accessToken !== !!value.userId) throw new Error('Incomplete account session');
  return value;
}
class NativeSyncBroker {
  #pending = Promise.resolve();
  constructor({ directory, encryption, helper, publish = fs.rename }) {
    if (!path.isAbsolute(directory)) throw new Error('Account directory must be absolute');
    this.directory = directory; this.file = path.join(directory, 'cloud-session.json');
    this.encryption = encryption; this.helper = helper; this.publish = publish;
  }
  #secure() {
    if (!this.encryption?.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Unlock your operating system credential store to use Nyora Cloud.');
  }
  async #read() {
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new Error('Invalid saved account');
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || typeof data.encrypted !== 'string') throw new Error('Unsupported saved account');
      this.#secure();
      return validateSession(JSON.parse(this.encryption.decryptString(Buffer.from(data.encrypted, 'base64'))));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async #save(value) {
    this.#secure(); validateSession(value);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Invalid account directory');
    const file = path.join(this.directory, `.session-${randomBytes(12).toString('hex')}.pending`);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, encrypted: this.encryption.encryptString(JSON.stringify(value)).toString('base64') }));
        await handle.sync();
      } finally { await handle.close(); }
      await this.publish(file, this.file);
    } finally { await fs.rm(file, { force: true }); }
  }
  #status(session) {
    return { isConfigured: true, isAuthenticated: !!session?.accessToken, email: session?.email || '', lastSyncTimestamp: session?.lastSyncTimestamp || INITIAL };
  }
  request(operation, params = {}) {
    const allowed = ['sync.status', 'sync.signIn', 'sync.register', 'sync.now', 'sync.signOut'];
    if (!allowed.includes(operation) || !plain(params)) return Promise.reject(new Error('Invalid cloud operation'));
    const auth = ['sync.signIn', 'sync.register'].includes(operation);
    if (Object.keys(params).some(key => !auth || !['email', 'password'].includes(key))) return Promise.reject(new Error('Unexpected cloud parameter'));
    if (auth && (typeof params.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email.trim()) || params.email.length > 254 || typeof params.password !== 'string' || !params.password || params.password.length > 4096)) return Promise.reject(new Error('Enter a valid email address and password.'));
    const pending = this.#pending.catch(() => {}).then(async () => {
      if (operation === 'sync.signOut') {
        // The helper keeps a session only for one request; deleting this encrypted
        // file signs out durably without clearing any reading data.
        await fs.rm(this.file, { force: true });
        return this.#status(null);
      }
      const session = await this.#read();
      if (operation === 'sync.status') return this.#status(session);
      this.#secure();
      if (auth && session?.accessToken) throw new Error('Sign out before connecting another Nyora account. Your local library will stay on this device.');
      if (operation === 'sync.now' && !session?.accessToken) throw new Error('Sign in to Nyora Cloud first.');
      await this.helper.start();
      const result = await this.helper.request('/desktop/sync', { method: 'POST', json: { action: operation.slice(5), session, ...(auth ? { email: params.email.trim(), password: params.password } : {}) }, timeoutMs: 180000, maxBytes: 65536 });
      if (!result.contentType.includes('application/json')) throw new Error('Nyora Cloud returned an invalid response.');
      const data = JSON.parse(result.bytes.toString('utf8'));
      // A refresh can rotate credentials even when a later sync request fails.
      // Save that acknowledged rotation before exposing an error to the UI.
      if (data.session?.accessToken) await this.#save(validateSession(data.session));
      if (typeof data.error === 'string') throw new Error(data.error.slice(0, 500));
      if (!data.session?.accessToken) throw new Error('Nyora Cloud did not confirm your account.');
      return this.#status(data.session);
    });
    this.#pending = pending;
    return pending;
  }
  async close() { await this.#pending.catch(() => {}); }
}
module.exports = { NativeSyncBroker, validateSession };
