const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceKey, publicHttps, trustedCaller, bundledUrl, contentKey } = require('./policy.cjs');

test('canonical source sessions have stable distinct path-independent keys', () => {
  for (const sourceId of ['', 'native:42', 'data:', 'data:../escape', 'data:a/b', 'data:a%2fb']) {
    assert.throws(() => sourceKey(sourceId));
  }
  assert.match(sourceKey('data:synthetic-fixture'), /^[a-f0-9]{64}$/);
  assert.equal(sourceKey('data:synthetic-fixture'), sourceKey('data:synthetic-fixture'));
  assert.notEqual(sourceKey('data:synthetic-fixture'), sourceKey('data:other-fixture'));
});

test('verification refuses privileged origins, credentials and private endpoints', () => {
  for (const value of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://tauri.localhost', 'https://host.local', 'https://example.com:8443', 'https://user:secret@example.com', 'nyora://app', 'file:///tmp/index.html', 'javascript:alert(1)']) {
    assert.equal(publicHttps(value), false, value);
  }
  assert.equal(publicHttps('https://example.com/challenge'), true);
});

test('privileged IPC only accepts current main top frame and bundled origin', () => {
  const appOrigin = 'http://127.0.0.1:43210';
  const frame = { url: `${appOrigin}/index.html` };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  assert.equal(trustedCaller({ sender: contents, senderFrame: frame }, window, appOrigin), true);
  assert.equal(trustedCaller({ sender: contents, senderFrame: { url: frame.url } }, window, appOrigin), false);
  assert.equal(trustedCaller({ sender: {}, senderFrame: frame }, window, appOrigin), false);
  frame.url = 'https://example.com';
  assert.equal(trustedCaller({ sender: contents, senderFrame: frame }, window, appOrigin), false);
  frame.url = 'nyora://app.evil/index.html';
  assert.equal(trustedCaller({ sender: contents, senderFrame: frame }, window, appOrigin), false);
});

test('local app trust binds the exact running loopback server origin', () => {
  const origin = 'http://127.0.0.1:43210';
  assert.equal(bundledUrl(`${origin}/index.html`, origin), true);
  for (const candidate of ['http://127.0.0.1:43211/index.html', 'http://localhost:43210/', 'nyora://app/index.html', 'https://127.0.0.1:43210/', 'http://user:pass@127.0.0.1:43210/']) {
    assert.equal(bundledUrl(candidate, origin), false);
  }
  assert.equal(bundledUrl(`${origin}/index.html`), false);
});

test('parser content keys stay opaque while unsafe absolute URLs are rejected', () => {
  for (const value of ['/manga/fixture', 'chapter/fixture?language=en', 'opaque-chapter-123', 'https://example.org/title']) assert.equal(contentKey(value), true, value);
  for (const value of ['', ' ', '//evil.org/title', 'http://127.0.0.1/private', 'https://127.0.0.1/private', 'file:///tmp/secret', 'javascript:alert(1)', 'a\\b', 'a\n']) assert.equal(contentKey(value), false, value);
});
