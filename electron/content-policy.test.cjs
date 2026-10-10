'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_SECURITY_POLICY, normalizeAiEndpoint } = require('./content-policy.cjs');
const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([key, ...values]) => [key, values]));
test('reader model policy covers current pinned sources without enabling old hosts or arbitrary connections', () => {
  const web = path.resolve(__dirname, '../vendor/web/web/core');
  for (const file of ['colorize/model.js', 'translate/tl-worker.js']) {
    const source = fs.readFileSync(path.join(web, file), 'utf8');
    const models = source.match(/https:\/\/raw\.githubusercontent\.com\/Nyora-Manga\/[^'\s]+/g);
    assert.ok(models.length);
    for (const url of models) assert.ok(directives['connect-src'].some(rule => rule.endsWith('/') && url.startsWith(rule)), `Current pinned model URL missing: ${url}`);
  }
  assert.ok(!directives['connect-src'].some(rule => ['https:', '*', 'https://raw.githubusercontent.com', 'https://huggingface.co'].includes(rule)));
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(directives['worker-src'], ["'self'", 'blob:']);
});
test('translation requests have exact known endpoints and only the Fandom API host/path wildcard', () => {
  for (const endpoint of ['https://translate.googleapis.com/translate_a/single', 'https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages', 'https://*.fandom.com/api.php']) assert.ok(directives['connect-src'].includes(endpoint));
  assert.equal(directives['connect-src'].filter(rule => rule.includes('*')).length, 1);
  assert.deepEqual(directives['object-src'], ["'none'"]); assert.deepEqual(directives['frame-src'], ["'none'"]);
});
test('endpoint inputs normalize to reader-compatible default paths and reject custom authority', () => {
  for (const input of ['', 'https://api.openai.com/v1', 'https://api.openai.com/v1/']) assert.equal(normalizeAiEndpoint(input), input.replace(/\/$/, ''));
  for (const input of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/']) assert.equal(normalizeAiEndpoint(input), 'https://api.anthropic.com');
  for (const input of ['/', 'https://custom.example.org/v1', 'http://api.openai.com/v1', 'https://api.openai.com/v1?custom=1', 'https://api.openai.com:8443/v1', 'https://key@api.openai.com/v1', 'https://api.openai.com/v1/other', 'https://api.anthropic.com/v1/messages']) {
    assert.throws(() => normalizeAiEndpoint(input), /Custom AI endpoints are not yet supported on desktop/);
    assert.equal(normalizeAiEndpoint(input, { legacy: true }), '');
  }
});
