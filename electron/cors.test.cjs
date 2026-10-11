'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCors, allowAllCors } = require('./cors.cjs');

const origin = 'http://127.0.0.1:52667';

test('external responses are opened to the app origin, replacing their own CORS headers', () => {
  const result = openCors({ url: 'https://cdn.example.org/page.jpg', method: 'GET', statusCode: 200, responseHeaders: {
    'Content-Type': ['image/jpeg'], 'access-control-allow-origin': ['https://elsewhere.example'], 'Cross-Origin-Resource-Policy': ['same-site'] } }, origin);
  assert.deepEqual(result.responseHeaders['Content-Type'], ['image/jpeg']);
  assert.deepEqual(result.responseHeaders['Access-Control-Allow-Origin'], [origin]);
  assert.deepEqual(result.responseHeaders['Cross-Origin-Resource-Policy'], ['cross-origin']);
  assert.equal(Object.keys(result.responseHeaders).filter(k => k.toLowerCase() === 'access-control-allow-origin').length, 1);
  assert.equal(result.statusLine, undefined);
});

test('a rejected preflight is answered so the real request can proceed', () => {
  assert.equal(openCors({ url: 'https://llm.example.org/v1/chat/completions', method: 'OPTIONS', statusCode: 405, responseHeaders: {} }, origin).statusLine, 'HTTP/1.1 204 No Content');
  assert.equal(openCors({ url: 'https://llm.example.org/v1/chat/completions', method: 'OPTIONS', statusCode: 204, responseHeaders: {} }, origin).statusLine, undefined);
});

test('the app server itself, non-http schemes and an unknown origin are left untouched', () => {
  assert.equal(openCors({ url: `${origin}/index.html`, method: 'GET', statusCode: 200 }, origin), null);
  assert.equal(openCors({ url: 'data:text/plain,x', method: 'GET', statusCode: 200 }, origin), null);
  assert.equal(openCors({ url: 'https://cdn.example.org/a', method: 'GET', statusCode: 200 }, undefined), null);
});

test('the listener reads the current origin on every response', () => {
  let listener; let current = origin;
  allowAllCors({ webRequest: { onHeadersReceived: (filter, fn) => { assert.deepEqual(filter.urls, ['http://*/*', 'https://*/*']); listener = fn; } } }, () => current);
  current = 'http://127.0.0.1:60000';
  listener({ url: 'https://cdn.example.org/a', method: 'GET', statusCode: 200, responseHeaders: {} }, result => {
    assert.deepEqual(result.responseHeaders['Access-Control-Allow-Origin'], [current]);
  });
});
