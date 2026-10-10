'use strict';
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

function sourceKey(sourceId) {
  if (typeof sourceId !== 'string' || !/^data:[A-Za-z0-9_.-]{1,200}$/.test(sourceId)) {
    throw new Error('Use a canonical data:<catalogue-id> source identity');
  }
  return createHash('sha256').update(sourceId, 'utf8').digest('hex');
}

function publicHttps(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && !isIP(host) && !host.includes(':') && host.includes('.')
      && !['localhost', 'app'].includes(host)
      && !['.localhost', '.local', '.internal', '.test', '.invalid', '.example'].some(suffix => host.endsWith(suffix));
  } catch { return false; }
}

function bundledUrl(value, appOrigin) {
  try {
    const expected = new URL(appOrigin);
    const url = new URL(value);
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1' && Boolean(expected.port)
      && expected.origin === appOrigin && url.origin === appOrigin && !url.username && !url.password;
  } catch { return false; }
}

function trustedCaller(event, mainWindow, appOrigin) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && bundledUrl(event.senderFrame?.url, appOrigin));
}

// A parser's content key is not necessarily its public URL. Preserve relative
// paths/opaque IDs exactly; the source-bound relay still validates every fetch.
function contentKey(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 16384
    || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) || publicHttps(value);
}

module.exports = { sourceKey, publicHttps, bundledUrl, trustedCaller, contentKey };
