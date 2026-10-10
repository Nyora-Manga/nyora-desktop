import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopAdapter } from '../frontend/adapter.js';
import { createVerificationActions } from '../frontend/service-status.js';
import * as verification from '../frontend/source-verification.js';

test('source cookie save uses exact native identity and exposes save errors without cookie export', async () => {
  const calls = [];
  const bridge = { runtimeStatus() {}, openVerification() {}, resetSourceSession() {}, saveSourceCookies: async (args) => { calls.push(args); return { state: 'saved', persistentCookies: 1, sessionCookies: 2, savedAt: 1234 }; } };
  const adapter = createDesktopAdapter(bridge);
  assert.equal(typeof adapter.saveSourceCookies, 'function');
  assert.deepEqual(await adapter.saveSourceCookies('data:ATSUMOE'), { state: 'saved', persistentCookies: 1, sessionCookies: 2, savedAt: 1234 });
  assert.deepEqual(calls, [{ sourceId: 'data:ATSUMOE' }]);
  bridge.saveSourceCookies = async () => { throw new Error('Synthetic cookie save rejected'); };
  await assert.rejects(adapter.saveSourceCookies('data:ATSUMOE'), /Synthetic cookie save rejected/);
  await assert.rejects(createDesktopAdapter({ runtimeStatus() {}, openVerification() {}, resetSourceSession() {} }).saveSourceCookies('data:ATSUMOE'), /Cookie saving unavailable/);
});

test('verification UI actions offer no manual cookie save and still block image replay while open', async () => {
  const adapter = { verificationStatus: async () => [{ sourceId: 'data:ATSUMOE', phase: 'verification-opened' }] };
  const actions = createVerificationActions(adapter, {}, { retrySource: () => assert.fail('image retry') }, () => assert.fail('reload'));
  assert.equal(actions.saveCookies, undefined);
  await assert.rejects(actions.retryImages('data:ATSUMOE'), /Close the verification window/);
});

test('automatic session saving shows progress/failure only and no cookie counts or solved claims', () => {
  assert.equal(typeof verification.formatCookieStatus, 'function');
  const format = verification.formatCookieStatus;
  assert.equal(format({ state: 'saved', persistentCookies: 1, sessionCookies: 2 }), '');
  assert.equal(format({ state: 'saved', persistentCookies: 0, sessionCookies: 1 }), '');
  assert.equal(format({ state: 'saved', persistentCookies: 0, sessionCookies: 0 }), '');
  assert.equal(format({ state: 'saving' }), 'Saving your session…');
  assert.match(format({ state: 'failed' }), /could not be saved/);
  assert(!format({ state: 'failed' }).includes('Save cookies'));
  assert.equal(format({ state: 'idle' }), '');
  for (const state of ['saved', 'saving', 'failed', 'idle']) assert(!/solved|verified/i.test(format({ state, persistentCookies: 2, sessionCookies: 0 })));
});
