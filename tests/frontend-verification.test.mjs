import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'acorn';
import { createImageRetries } from '../frontend/native-images.js';
import { createVerificationActions } from '../frontend/service-status.js';
import * as status from '../frontend/service-status.js';
import { verificationAction } from '../frontend/source-verification.js';
import { overlayNativeMisc } from '../scripts/native-service-overlay.mjs';
import { webRoot } from '../scripts/build-frontend.mjs';

const origin = 'http://127.0.0.1:31420';
function media(sourceId, name) {
  const query = new URLSearchParams({ u: `https://cdn.example.org/${name}.png?a=one&b=two`, sourceId, cap: 'signed-media-capability', h: 'Referer:https://source.example.org/chapter', _r: '123' });
  return `${origin}/helper-image?${query}`;
}

test('explicit image retry only replays failed issued media for the exact selected source', () => {
  const registry = createImageRetries({ origin: () => origin, now: () => 1000 });
  const requests = [];
  const firstUrl = media('data:ATSUMOE', 'failed-page');
  const token = registry.failed(firstUrl, (url) => requests.push(url));
  const success = registry.failed(media('data:ATSUMOE', 'loaded-cover'), () => assert.fail('successful image replayed'));
  registry.loaded(success);
  registry.failed(media('data:OTHER', 'failed-other'), () => assert.fail('another source replayed'));
  assert.equal(registry.failed('https://cdn.example.org/public.png', () => assert.fail()), null);
  assert.equal(registry.failed(`${origin}/helper-image?u=x&sourceId=data:ATSUMOE`, () => assert.fail()), null);
  assert.equal(requests.length, 0, 'registering/polling never fetches');
  assert.equal(registry.retrySource('data:atsumoe'), 0, 'source case is significant');
  assert.equal(registry.retrySource('data:ATSUMOE'), 1);
  assert.equal(registry.retrySource('data:ATSUMOE'), 1);
  const before = new URL(firstUrl);
  for (const request of requests) {
    const after = new URL(request);
    assert.equal(after.origin, origin);
    assert.equal(after.pathname, '/helper-image');
    assert.equal(after.searchParams.getAll('_r').length, 1);
    for (const key of ['u', 'sourceId', 'cap', 'h']) assert.deepEqual(after.searchParams.getAll(key), before.searchParams.getAll(key));
  }
  assert.notEqual(new URL(requests[0]).searchParams.get('_r'), new URL(requests[1]).searchParams.get('_r'));
  registry.loaded(token);
  assert.equal(registry.retrySource('data:ATSUMOE'), 0);
  assert(registry.has('data:OTHER'));
});

test('verification actions do not retry while open, never infer solved from close, and image retry cannot reload or mutate', async () => {
  let phase = 'verification-opened';
  const calls = [];
  const adapter = { verificationStatus: async () => [{ sourceId: 'data:ATSUMOE', phase }], openVerification: async (...args) => calls.push(['open', ...args]) };
  const services = { canRetryContent: (id) => id === 'data:ATSUMOE', retryContent: async (id) => calls.push(['read', id]) };
  const images = { retrySource: (id) => { calls.push(['images', id]); return 2; } };
  const actions = createVerificationActions(adapter, services, images, () => calls.push(['reload']));
  await assert.rejects(actions.retryImages('data:ATSUMOE'), /Close the verification window/);
  await assert.rejects(actions.retryContent('data:ATSUMOE'), /Close the verification window/);
  assert.deepEqual(calls, []);
  await actions.open('data:ATSUMOE');
  assert.deepEqual(calls, [['open', 'data:ATSUMOE']], 'main chooses URL');
  phase = 'retry-required';
  assert.equal(await actions.retryImages('data:ATSUMOE'), 2);
  assert.equal(phase, 'retry-required', 'closed/retried is not solved');
  assert.deepEqual(calls.slice(1), [['images', 'data:ATSUMOE']]);
  await assert.rejects(actions.retryContent('data:OTHER'), /No failed source request/);
  await actions.retryContent('data:ATSUMOE');
  assert.deepEqual(calls.slice(2), [['read', 'data:ATSUMOE'], ['reload']]);
});

test('checked shared Explore overlay exposes verification for catalog, picker and active browse without filtering CF rows', async () => {
  const path = resolve(webRoot, 'web/screens/explore.js');
  const before = await readFile(path, 'utf8');
  const result = overlayNativeMisc('screens/explore.js', before);
  parse(result, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.match(result, /sourceVerificationButton\(e\)/);
  assert.equal((result.match(/sourceVerificationButton\(src\)/g) || []).length, 2);
  assert.match(result, /close the window.*automatically/);
  assert(!result.includes('Try another source.'));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.throws(() => overlayNativeMisc('screens/explore.js', before.replace('          installBtn,', '          changedInstallButton,')), /Shared frontend drift/);
});

test('automatic resume claims each closed verification ID once, including a missed open poll, and waits for saving', async () => {
  assert.equal(typeof status.createVerificationResumer, 'function');
  const calls = [];
  const resumer = status.createVerificationResumer(async (sourceId, manual) => { calls.push([sourceId, manual]); });
  const entry = { sourceId: 'data:ATSUMOE', phase: 'retry-required', verificationId: 'first-open', manual: false, cookies: { state: 'saving' } };
  await resumer.observe([entry]); assert.deepEqual(calls, []);
  entry.cookies.state = 'saved';
  await Promise.all([resumer.observe([entry]), resumer.observe([entry])]);
  assert.deepEqual(calls, [['data:ATSUMOE', false]]);
  await resumer.observe([{ ...entry, phase: 'verification-required' }, entry]);
  assert.equal(calls.length, 1, 'continued challenge cannot loop');
  await resumer.observe([{ ...entry, verificationId: 'second-open', manual: true, cookies: { state: 'failed' } }]);
  assert.deepEqual(calls.at(-1), ['data:ATSUMOE', true], 'in-memory access can resume with persistence warning');
});

test('automatic resume failure is retained once per close and never opens another window', async () => {
  assert.equal(typeof status.createVerificationResumer, 'function');
  let count = 0;
  const resumer = status.createVerificationResumer(async () => { count++; throw new Error('Still needs verification'); });
  const entry = { sourceId: 'data:ATSUMOE', phase: 'retry-required', verificationId: 'failed-open' };
  await resumer.observe([entry]); await resumer.observe([entry]);
  assert.equal(count, 1);
  assert.equal(resumer.status(entry.sourceId, entry.verificationId).state, 'failed');
});

test('closed network/read failure offers an explicit retry rather than claiming another verification is required', async () => {
  assert.deepEqual(verificationAction({ phase: 'retry-required', manual: false }, { state: 'failed' }), { label: 'Open website', disabled: false });
  assert.deepEqual(verificationAction({ phase: 'verification-required', manual: false }), { label: 'Verify source', disabled: false });
  let count = 0, resolve;
  const resumer = status.createVerificationResumer(() => { count++; return new Promise(done => { resolve = done; }); });
  const entry = { sourceId: 'data:ATSUMOE', phase: 'retry-required', verificationId: 'network-failure' };
  assert.equal(typeof resumer.retry, 'function');
  const retry = resumer.retry(entry);
  await Promise.resolve(); assert.equal(resumer.status(entry.sourceId, entry.verificationId).state, 'checking');
  const duplicate = resumer.retry(entry); await Promise.resolve(); assert.equal(count, 1);
  resolve(); await Promise.all([retry, duplicate]);
});

test('new close cycle waits for an older resume without consuming or losing the new verification ID', async () => {
  let finish;
  const calls = [];
  const resumer = status.createVerificationResumer(async id => { calls.push(id); if (calls.length === 1) await new Promise(done => { finish = done; }); });
  const entry = { sourceId: 'data:ATSUMOE', phase: 'retry-required', verificationId: 'old-close' };
  const first = resumer.observe([entry]); await Promise.resolve();
  try {
    await resumer.observe([{ ...entry, verificationId: 'new-close' }]);
    assert.equal(calls.length, 1, 'another cycle must not share or race an older pending request');
  } finally { finish(); await first; }
  await resumer.observe([{ ...entry, verificationId: 'new-close' }]);
  assert.equal(calls.length, 2, 'new cycle must remain unconsumed until its actual retry');
});

test('resume independently awaits failed media despite partial read failure and reloads only successful exact operations', async () => {
  const calls = [];
  const retriedRequests = [{ operation: 'content.details', params: { id: 'data:ATSUMOE', url: 'opaque-title' } }];
  const services = { canRetryContent: () => true, retryContent: async () => { throw Object.assign(new Error('Still blocked'), { retriedRequests }); } };
  const actions = createVerificationActions({ verificationStatus: async () => [] }, services, { retrySourceAndWait: async (id) => { calls.push(['media', id]); } }, async (id, operations) => calls.push(['reload', id, operations]));
  assert.equal(typeof actions.resume, 'function');
  await assert.rejects(actions.resume('data:ATSUMOE', false), /Still blocked/);
  assert(calls.some(([name]) => name === 'media'));
  assert.deepEqual(calls.find(([name]) => name === 'reload'), ['reload', 'data:ATSUMOE', retriedRequests]);
});

test('proactive closed website checks access once without a failed request and without blindly reloading a reader', async () => {
  const calls = [];
  const actions = createVerificationActions({ verificationStatus: async () => [] }, { canRetryContent: () => false, checkSourceAccess: async id => calls.push(['check', id]) }, { retrySource: id => calls.push(['media', id]) }, () => assert.fail('blind route reload'));
  assert.equal(typeof actions.resume, 'function');
  await actions.resume('data:ATSUMOE', true);
  assert.deepEqual(calls, [['check', 'data:ATSUMOE'], ['media', 'data:ATSUMOE']]);
});

test('Explore resumes matching failed SEARCH in place and ignores stale recovery without resetting mode/query/results', async () => {
  const result = overlayNativeMisc('screens/explore.js', await readFile(resolve(webRoot, 'web/screens/explore.js'), 'utf8'));
  const start = result.indexOf('  _onSourceContentRecovered = ');
  const end = result.indexOf("  window.addEventListener('nyora:source-content-recovered'", start);
  assert(start >= 0 && end > start, 'Explore needs a checked recovery handler');
  const calls = [];
  const state = { screen: 'browse', mode: 'SEARCH', query: 'fixture query', page: 2, browseError: 'Verification required', browseLoading: false, entries: [{ id: 'existing-page' }] };
  const root = { isConnected: true }, sourceId = 'data:ATSUMOE';
  const handler = Function('root', 'router', 'state', 'store', 'loadBrowse', `let _onSourceContentRecovered; ${result.slice(start, end)} return _onSourceContentRecovered;`)(root, { current: () => ({ name: 'explore' }) }, state, { source: { id: sourceId } }, (...args) => calls.push(args));
  const event = (operation = 'content.search', params = { id: sourceId, q: 'fixture query', page: 2 }) => ({ detail: { sourceId, requests: [{ operation, params }] }, prevented: false, preventDefault() { this.prevented = true; } });
  const matching = event(); handler(matching); assert(matching.prevented); assert.deepEqual(calls, [[2, true]]);
  const stale = event('content.popular', { id: sourceId, page: 1 }); handler(stale); assert(stale.prevented); assert.equal(calls.length, 1);
  const otherQuery = event('content.search', { id: sourceId, q: 'old query', page: 2 }); handler(otherQuery); assert(otherQuery.prevented); assert.equal(calls.length, 1);
  assert.equal(state.mode, 'SEARCH'); assert.equal(state.query, 'fixture query'); assert.deepEqual(state.entries, [{ id: 'existing-page' }]);
  root.isConnected = false; const disposed = event(); handler(disposed); assert.equal(disposed.prevented, false);
});
