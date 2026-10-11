'use strict';
const http = require('node:http');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const { realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
});
const DEFAULT_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

class LocalAppServer {
  #server;
  #root;
  #origin;
  #secret;
  #sockets = new Set();
  #images = new Set();

  constructor({ distDirectory, image, localImage, csp = DEFAULT_CSP }) {
    if (typeof distDirectory !== 'string' || !path.isAbsolute(distDirectory) || typeof image !== 'function'
      || typeof csp !== 'string' || !csp || /[\r\n]/.test(csp)) throw new Error('Invalid local application server configuration');
    this.distDirectory = distDirectory;
    this.image = image;
    this.localImage = localImage;
    this.csp = csp;
  }
  get origin() { return this.#origin; }
  get indexUrl() { return this.#origin && `${this.#origin}/index.html`; }

  // The origin is the renderer's storage partition: the Cache API holds the
  // ~125 MB of downloaded translation/colorization models under it. Reusing the
  // previous launch's port keeps that origin (and those models) stable; a busy
  // or invalid preference falls back to an ephemeral port.
  async start(preferredPort) {
    if (this.#server) throw new Error('Local application server is already running');
    if (Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535) {
      try { return await this.#listen(preferredPort); }
      catch (error) { if (this.#server) throw error; }
    }
    return this.#listen(0);
  }

  async #listen(port) {
    // Electron's patched fs supports paths inside app.asar. Resolve each served
    // asset too: a bundled symlink may never expose files outside dist.
    this.#root = await realpath(this.distDirectory);
    if (!(await stat(this.#root)).isDirectory()) throw new Error('Bundled application directory is missing');
    const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
      this.#handle(request, response).catch(() => { this.#fail(response, 500); });
    });
    this.#server = server;
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 2000;
    server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    // Unexpected listener/socket failures never print capability-bearing URLs.
    server.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1');
      });
      this.#origin = `http://127.0.0.1:${server.address().port}`;
      this.#secret = randomBytes(32);
      return { origin: this.origin, indexUrl: this.indexUrl };
    } catch (error) { this.#server = undefined; throw error; }
  }

  mediaUrl(query) {
    if (!this.#origin || !this.#secret) throw new Error('Local application server is not running');
    if (!(query instanceof URLSearchParams) || query.has('cap') || query.has('_r') || query.toString().length > 60000) throw new Error('Invalid media parameters');
    const copy = new URLSearchParams(query); copy.set('cap', this.#signature(copy));
    return `${this.#origin}/helper-image?${copy}`;
  }

  localMediaUrl(id, index) {
    if (!this.#origin || !this.#secret || !/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(index) || index < 0 || index > 20000) throw new Error('Invalid offline page');
    const pathname = `/local-media/${id}/${index}`;
    const query = new URLSearchParams(); query.set('cap', this.#signature(query, pathname));
    return `${this.#origin}${pathname}?${query}`;
  }

  #signature(query, scope = 'nyora-media-v1') {
    const canonical = new URLSearchParams(query); canonical.delete('cap'); canonical.delete('_r'); canonical.sort();
    return createHmac('sha256', this.#secret).update(`${scope}:${canonical}`).digest('base64url');
  }

  #headers(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', this.csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
  #fail(response, status) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    this.#headers(response); response.statusCode = status;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(http.STATUS_CODES[status] || 'Request failed');
  }
  async #handle(request, response) {
    this.#headers(response);
    if (!this.#origin || request.headers.host !== new URL(this.#origin).host
      || (request.headers.origin !== undefined && request.headers.origin !== this.#origin)
      || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) return this.#fail(response, 403);
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return this.#fail(response, 405); }
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) return this.#fail(response, 400);
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 65536 || request.url.includes('#')) return this.#fail(response, 400);
    let requested, url;
    try {
      requested = decodeURIComponent(request.url.split('?')[0]);
      if (requested.includes('\0') || requested.includes('\\') || requested.split('/').some(part => part.startsWith('.'))) throw new Error('Unsafe asset path');
      url = new URL(request.url, this.#origin);
    } catch { return this.#fail(response, 400); }
    if (requested === '/helper-image') return this.#serveImage(request, response, url);
    if (/^\/local-media\/[a-f0-9-]{36}\/\d+$/.test(requested)) return this.#serveImage(request, response, url, true);
    const file = path.resolve(this.#root, `.${requested === '/' ? '/index.html' : requested}`);
    if (!inside(this.#root, file)) return this.#fail(response, 400);
    let canonical, info;
    try { canonical = await realpath(file); if (!inside(this.#root, canonical)) return this.#fail(response, 403); info = await stat(canonical); }
    catch { return this.#fail(response, 404); }
    if (!info.isFile()) return this.#fail(response, 404);
    response.statusCode = 200; response.setHeader('Content-Type', MIME[path.extname(canonical).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Content-Length', info.size);
    if (request.method === 'HEAD') return response.end();
    await pipeline(fs.createReadStream(canonical), response);
  }

  async #serveImage(request, response, url, local = false) {
    if (local && (typeof this.localImage !== 'function' || [...url.searchParams.keys()].some(key => !['cap', '_r'].includes(key)))) return this.#fail(response, 403);
    const values = url.searchParams.getAll('cap');
    const cap = values[0];
    if (!this.#secret || values.length !== 1 || typeof cap !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cap)) return this.#fail(response, 403);
    // Never forward the renderer-visible media capability to the helper.
    url.searchParams.delete('cap');
    const retries = url.searchParams.getAll('_r');
    if (retries.length > 1 || (retries.length === 1 && !/^\d{1,20}$/.test(retries[0]))) return this.#fail(response, 400);
    url.searchParams.delete('_r');
    if (!timingSafeEqual(Buffer.from(cap), Buffer.from(this.#signature(url.searchParams, local ? url.pathname : undefined)))) return this.#fail(response, 403);
    if (this.#images.size >= 8) return this.#fail(response, 429);
    const controller = new AbortController(); this.#images.add(controller);
    const closed = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', closed);
    let timeout;
    try {
      const cancelled = new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Image request cancelled')), { once: true });
        timeout = setTimeout(() => controller.abort(), 30000); timeout.unref();
      });
      const result = await Promise.race([Promise.resolve().then(() => local ? this.localImage(url.pathname.split('/')[2], Number(url.pathname.split('/')[3]), { signal: controller.signal }) : this.image(url.href, { signal: controller.signal })), cancelled]);
      if (!Buffer.isBuffer(result?.bytes) || result.bytes.length > 32 * 1024 * 1024
        || typeof result.contentType !== 'string' || /[\r\n]/.test(result.contentType)
        || !/^(image\/(?!svg\+xml)[a-z0-9.+-]+|application\/octet-stream)(?:;[^\r\n]*)?$/i.test(result.contentType)
        || (result.status !== undefined && result.status !== 200)) return this.#fail(response, 502);
      if (controller.signal.aborted || response.destroyed) return;
      response.statusCode = 200; response.setHeader('Content-Type', result.contentType); response.setHeader('Content-Length', result.bytes.length);
      response.end(request.method === 'HEAD' ? undefined : result.bytes);
    } catch (error) { this.#fail(response, error.code === 'SOURCE_VERIFICATION_REQUIRED' ? 409 : 502); }
    finally { clearTimeout(timeout); response.off('close', closed); this.#images.delete(controller); }
  }

  async stop() {
    const server = this.#server;
    this.#server = undefined; this.#origin = undefined; this.#secret = undefined;
    for (const controller of this.#images) controller.abort();
    if (!server) return;
    const closed = new Promise(resolve => server.close(() => resolve()));
    for (const socket of this.#sockets) socket.destroy();
    await closed;
  }
}
module.exports = { LocalAppServer };
