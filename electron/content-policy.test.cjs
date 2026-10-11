'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_SECURITY_POLICY, normalizeAiEndpoint } = require('./content-policy.cjs');
const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([key, ...values]) => [key, values]));
test('reader may connect to any https host and local AI servers, while scripts stay first-party', () => {
  assert.deepEqual(directives['connect-src'], ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*']);
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(directives['worker-src'], ["'self'", 'blob:']);
  assert.deepEqual(directives['object-src'], ["'none'"]); assert.deepEqual(directives['frame-src'], ["'none'"]);
});
test('AI endpoints accept any https base or a local server and reject everything else', () => {
  for (const input of ['', 'https://api.openai.com/v1', 'https://api.openai.com/v1/']) assert.equal(normalizeAiEndpoint(input), input.replace(/\/$/, ''));
  for (const input of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/']) assert.equal(normalizeAiEndpoint(input), 'https://api.anthropic.com');
  for (const [input, out] of [['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1'], ['https://custom.example.org:8443/v1', 'https://custom.example.org:8443/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'], ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1']]) assert.equal(normalizeAiEndpoint(input), out);
  for (const input of ['/', 'not a url', 'http://api.openai.com/v1', 'http://192.168.1.5/v1', 'https://key@api.openai.com/v1', 'ftp://example.org/v1', 'https://example.org/v1#x']) {
    assert.throws(() => normalizeAiEndpoint(input), /https:\/\/ URL, or http:\/\/localhost/);
    assert.equal(normalizeAiEndpoint(input, { legacy: true }), '');
  }
  assert.throws(() => normalizeAiEndpoint('https://api.openai.com/v1', { provider: 'anthropic' }), /other provider/);
  assert.throws(() => normalizeAiEndpoint('https://api.anthropic.com', { provider: 'openai' }), /other provider/);
});
