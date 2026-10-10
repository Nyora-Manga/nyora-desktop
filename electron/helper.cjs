'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');

const PROTOCOL = 'nyora-desktop-helper/1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Main-process only. This object, its credentials and its raw request method
// must never be exposed by contextBridge. Renderer operations require DTOs and
// a separate fixed operation allowlist.
class ManagedHelper extends EventEmitter {
  #child;
  #starting;
  #stopping;
  #aborted = false;
  #base;
  #token;
  #runDirectory;
  #relay;

  constructor({ profileRoot, javaPath, jarPath, timeout = process.platform === 'win32' ? 60000 : 20000, launcher, relay }) {
    super();
    for (const [name, value] of Object.entries({ profileRoot, javaPath, jarPath })) {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
    }
    this.options = { profileRoot, javaPath, jarPath, timeout };
    if (relay) {
      const url = new URL(relay.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/fetch'
        || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(relay.token)) throw new Error('Invalid private source relay');
      this.#relay = Object.freeze({ url: url.href, token: relay.token });
    }
    // Injection supports lifecycle tests without launching a real JVM.
    this.launcher = launcher || ((file, args, options) => spawn(file, args, options));
    this.status = Object.freeze({ state: 'stopped' });
  }

  #setStatus(state, detail = {}) {
    this.status = Object.freeze({ state, ...detail });
    this.emit('status', this.status);
  }

  async start() {
    if (this.#stopping) await this.#stopping;
    if (this.status.state === 'ready') return this.status;
    if (this.#starting) return this.#starting;
    this.#aborted = false;
    const starting = this.#launch().catch(async (error) => {
      await this.#terminate();
      if (!this.#aborted) this.#setStatus('unavailable', { code: error.code || 'HELPER_START_FAILED' });
      throw error;
    });
    this.#starting = starting;
    try { return await starting; }
    finally { if (this.#starting === starting) this.#starting = undefined; }
  }

  async #launch() {
    this.#setStatus('starting');
    const { profileRoot, javaPath, jarPath, timeout } = this.options;
    await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(profileRoot)).isSymbolicLink()) throw new Error('Helper profile cannot be a symlink');
    const root = await fs.realpath(profileRoot);
    const runtime = path.join(root, 'runtime');
    const temporary = path.join(root, 'tmp');
    for (const directory of [runtime, temporary]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Helper writable directory cannot be a symlink');
    }
    this.#runDirectory = await fs.mkdtemp(path.join(runtime, 'launch-'));
    const portFile = path.join(this.#runDirectory, 'helper.port');
    this.#token = randomBytes(32).toString('hex');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(NYORA_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/i.test(key)));
    env.NYORA_HELPER_TOKEN = this.#token;
    if (this.#relay) {
      env.NYORA_DESKTOP_RELAY_URL = this.#relay.url;
      env.NYORA_DESKTOP_RELAY_TOKEN = this.#relay.token;
    }
    if (this.#aborted) throw new Error('Helper startup cancelled');
    const child = this.launcher(javaPath, [
      '-Dnyora.desktop.isolated=true', `-Dnyora.data.dir=${root}`,
      `-Dnyora.helper.port-file=${portFile}`, `-Djava.io.tmpdir=${temporary}`,
      `-Dnyora.watch.pid=${process.pid}`, '-jar', jarPath,
    ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;
    let launchError;
    // Drain output without leaking source URLs, titles or secrets into logs.
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('error', (error) => { launchError = error; });
    child.once('exit', (code, signal) => {
      this.#base = undefined;
      if (this.#child === child && !this.#aborted) this.#setStatus('unavailable', { code: 'HELPER_EXITED', exitCode: code, signal });
    });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.#aborted) throw new Error('Helper startup cancelled');
      if (launchError) throw Object.assign(new Error('Cannot launch the bundled Java runtime'), { code: 'HELPER_LAUNCH_FAILED' });
      if (child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error('Helper exited before becoming ready'), { code: 'HELPER_EXITED' });
      let port;
      try {
        const metadata = await fs.lstat(portFile);
        if (!metadata.isFile() || metadata.size > 8) throw new Error('Invalid helper readiness file');
        const text = (await fs.readFile(portFile, 'utf8')).trim();
        if (!/^\d{1,5}$/.test(text) || Number(text) < 1024 || Number(text) > 65535) throw new Error('Invalid helper port');
        port = Number(text);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (port) {
        const base = `http://127.0.0.1:${port}`;
        try {
          const response = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${this.#token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' });
          if (!response.ok) throw Object.assign(new Error('Helper authentication failed'), { code: 'HELPER_AUTH_FAILED' });
          const health = await response.json();
          if (health.status !== 'ok' || health.isolated !== true || health.protocol !== PROTOCOL || typeof health.revision !== 'string' || !health.revision
            || (this.#relay && health.sourceTransport !== 'chromium')) {
            throw Object.assign(new Error('Bundled helper protocol or isolation does not match'), { code: 'HELPER_PROTOCOL_MISMATCH' });
          }
          if (this.#aborted || child.exitCode !== null || child.signalCode !== null) throw new Error('Helper startup cancelled');
          this.#base = base;
          this.#setStatus('ready', { protocol: health.protocol, revision: health.revision, ...(this.#relay ? { sourceTransport: 'chromium' } : {}) });
          return this.status;
        } catch (error) {
          if (error.code === 'HELPER_AUTH_FAILED' || error.code === 'HELPER_PROTOCOL_MISMATCH') throw error;
        }
      }
      await sleep(50);
    }
    throw Object.assign(new Error('The bundled helper did not become ready in time'), { code: 'HELPER_START_TIMEOUT' });
  }

  async request(resource, { method = 'GET', json, bytes, contentType, maxBytes = 16 * 1024 * 1024, signal, timeoutMs = 30000 } = {}) {
    if (!this.#base || this.status.state !== 'ready') throw new Error('The native library service is unavailable');
    if (!/^\/[a-zA-Z0-9/_-]+(?:\?[^#]*)?$/.test(resource) || !['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Invalid internal helper request');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('Invalid internal request timeout');
    const headers = { Authorization: `Bearer ${this.#token}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    else if (contentType) headers['Content-Type'] = contentType;
    const response = await fetch(`${this.#base}${resource}`, {
      method, headers, body: json !== undefined ? JSON.stringify(json) : bytes,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Native service response exceeds its size limit');
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    if (!response.ok) {
      let message = `Native service request failed (${response.status})`;
      let code = `HELPER_HTTP_${response.status}`;
      try {
        const detail = JSON.parse(result.toString('utf8'));
        if (typeof detail.error === 'string') message = detail.error.slice(0, 500).replaceAll(this.#token || '\0', '[redacted]');
        if (response.status === 409 && detail.code === 'verification_required') code = 'SOURCE_VERIFICATION_REQUIRED';
      } catch { /* Never render raw HTML error responses. */ }
      throw Object.assign(new Error(message), { code });
    }
    return { bytes: result, contentType: response.headers.get('content-type') || '' };
  }

  async #terminate() {
    const child = this.#child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 3000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        const killed = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < killed) await sleep(25);
        if (child.exitCode === null && child.signalCode === null) throw new Error('Helper process did not stop');
      }
    }
    this.#child = undefined;
    this.#base = undefined;
    this.#token = undefined;
    if (this.#runDirectory) await fs.rm(this.#runDirectory, { recursive: true, force: true });
    this.#runDirectory = undefined;
  }

  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#aborted = true;
    this.#stopping = (async () => {
      await this.#starting?.catch(() => {});
      await this.#terminate();
      this.#setStatus('stopped');
    })();
    try { await this.#stopping; } finally { this.#stopping = undefined; }
  }
}

module.exports = { ManagedHelper, PROTOCOL };
