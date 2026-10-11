'use strict';

// The reader (in-image translator, colorizer, series lookups, AI refinement)
// talks to arbitrary hosts: page CDNs, translation and LLM APIs, wikis. Many of
// them send no CORS headers, and the window is cross-origin isolated (COEP
// require-corp), so the renderer could not read their responses. Open every
// external response to the local app origin. Only the app window's session is
// wired to this; source browsing sessions keep their normal web semantics.
const CORS_HEADERS = ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age', 'cross-origin-resource-policy'];

function openCors({ url, method, statusCode, responseHeaders = {} }, origin) {
  let target;
  try { target = new URL(url); } catch { return null; }
  if (!origin || target.origin === origin || !['http:', 'https:'].includes(target.protocol)) return null;
  const headers = {};
  for (const [name, value] of Object.entries(responseHeaders)) if (!CORS_HEADERS.includes(name.toLowerCase())) headers[name] = value;
  Object.assign(headers, {
    'Access-Control-Allow-Origin': [origin],
    'Access-Control-Allow-Methods': ['GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'],
    'Access-Control-Allow-Headers': ['*, Authorization'],
    'Access-Control-Expose-Headers': ['*'],
    'Access-Control-Max-Age': ['600'],
    'Cross-Origin-Resource-Policy': ['cross-origin'],
  });
  const result = { responseHeaders: headers };
  // A server that rejects the preflight itself would still block the request.
  if (method === 'OPTIONS' && (statusCode < 200 || statusCode >= 300)) result.statusLine = 'HTTP/1.1 204 No Content';
  return result;
}

function allowAllCors(ses, origin) {
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback(openCors(details, origin()) || {});
  });
}

module.exports = { openCors, allowAllCors };
