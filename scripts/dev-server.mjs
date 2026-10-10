import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

// Serve generated dist only. Decode before normalization so encoded traversal
// never becomes a filesystem request; realpath also rejects symlink escapes.
export async function createFrontendServer(directory, { port = 1420 } = {}) {
  const root = await realpath(directory);
  const server = createServer(async (request, response) => {
    const send = (code, message) => { response.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(message); };
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Method not allowed');
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (request.headers.host !== expectedHost) return send(403, 'Invalid host');
    let path;
    try { path = decodeURIComponent(request.url.split(/[?#]/, 1)[0]); }
    catch { return send(400, 'Invalid URL'); }
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes('%') || path.split('/').some((part) => part === '.' || part === '..')) return send(403, 'Forbidden path');
    if (path === '/') path = '/index.html';
    // No directory listings, hidden files, arbitrary SPA fallback, or source.
    if (path.split('/').some((part) => part.startsWith('.'))) return send(403, 'Forbidden path');
    const candidate = resolve(root, '.' + path);
    try {
      const absolute = await realpath(candidate);
      if (!absolute.startsWith(root + sep)) return send(403, 'Forbidden path');
      if (!(await stat(absolute)).isFile()) return send(404, 'Not found');
      const bytes = await readFile(absolute);
      response.writeHead(200, {
        'Content-Type': mime[extname(absolute)] || 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return send(404, 'Not found');
      console.error('Frontend server read failed:', error.message);
      return send(500, 'Read failed');
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server;
}
