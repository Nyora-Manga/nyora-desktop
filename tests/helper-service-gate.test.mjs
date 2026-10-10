import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceGate } from '../electron/service-gate.cjs';

test('backup waits for accepted writes and rejects new writes until preview closes', async () => {
  const gate = new ServiceGate();
  const write = Promise.withResolvers();
  const dialog = Promise.withResolvers();
  let preview = false;
  const saving = gate.run(() => write.promise);
  const backup = gate.exclusive(async () => { preview = true; await dialog.promise; return 'committed'; });
  await assert.rejects(gate.run(() => { throw new Error('must not run'); }), /backup/);
  assert.equal(preview, false);
  write.resolve();
  await saving;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preview, true);
  await assert.rejects(gate.exclusive(() => {}), /already/);
  dialog.resolve();
  assert.equal(await backup, 'committed');
  assert.equal(await gate.run(() => 'next'), 'next');
});

test('cancelled or failed backup releases the app service gate', async () => {
  const gate = new ServiceGate();
  await assert.rejects(gate.exclusive(() => { throw new Error('cancelled'); }), /cancelled/);
  assert.equal(await gate.run(() => 1), 1);
});

test('quit waits for the in-flight commit and refuses later service calls', async () => {
  const gate = new ServiceGate();
  const commit = Promise.withResolvers();
  const importing = gate.exclusive(() => commit.promise);
  let closed = false;
  const closing = gate.close().then(() => { closed = true; });
  await assert.rejects(gate.run(() => {}), /closing/);
  await assert.rejects(gate.exclusive(() => {}), /closing/);
  assert.equal(closed, false);
  commit.resolve();
  await Promise.all([importing, closing]);
  assert.equal(closed, true);
});
