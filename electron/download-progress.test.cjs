'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DownloadProgress } = require('./download-progress.cjs');
const job = (id, status, completedPages = 0, totalPages = 4) => ({ id, status, completedPages, totalPages });
function fixture(platform = 'darwin') {
  const calls = [];
  let window = { isDestroyed: () => false, setProgressBar: (...args) => calls.push(args) };
  const controller = new DownloadProgress({ window: () => window, platform });
  return { controller, calls, replace: value => { window = value; } };
}
test('progress tracks the current batch, excludes old completed jobs and clears when idle', () => {
  const { controller, calls } = fixture();
  controller.update({ entries: [job('old', 'COMPLETED', 4), job('a', 'RUNNING', 2), job('b', 'QUEUED')] });
  assert.deepEqual(calls.at(-1), [0.25, { mode: 'normal' }]);
  controller.update({ entries: [job('old', 'COMPLETED', 4), job('a', 'COMPLETED', 4), job('b', 'RUNNING', 2)] });
  assert.deepEqual(calls.at(-1), [0.75, { mode: 'normal' }]);
  controller.update({ entries: [job('a', 'COMPLETED', 4), job('b', 'COMPLETED', 4)] });
  assert.deepEqual(calls.at(-1), [-1, { mode: 'none' }]);
  controller.update({ entries: [job('a', 'COMPLETED', 4), job('c', 'RUNNING', 1)] });
  assert.equal(calls.at(-1)[0], 0.25);
});
test('page discovery is indeterminate; pause drains running chapters then holds pending work', () => {
  const { controller, calls } = fixture('win32');
  controller.update({ entries: [job('a', 'RUNNING', 0, 0), job('b', 'QUEUED')] });
  assert.deepEqual(calls.at(-1), [2, { mode: 'indeterminate' }]);
  controller.update({ queuePaused: true, entries: [job('a', 'RUNNING', 2), job('b', 'QUEUED')] });
  assert.deepEqual(calls.at(-1), [0.25, { mode: 'normal' }]);
  controller.update({ queuePaused: true, entries: [job('a', 'COMPLETED', 4), job('b', 'QUEUED')] });
  assert.deepEqual(calls.at(-1), [0.5, { mode: 'paused' }]);
  controller.update({ queuePaused: true, entries: [job('a', 'COMPLETED', 4), job('b', 'CANCELLED')] });
  assert.deepEqual(calls.at(-1), [-1, { mode: 'none' }]);
});
test('progress tolerates window startup/recreation and never fails a committed download', () => {
  const { controller, calls, replace } = fixture();
  replace(undefined);
  controller.update({ entries: [job('a', 'RUNNING', 2)] });
  assert.equal(calls.length, 0);
  replace({ isDestroyed: () => false, setProgressBar: (...args) => calls.push(args) });
  controller.refresh();
  assert.deepEqual(calls.at(-1), [0.5, { mode: 'normal' }]);
  controller.refresh();
  assert.equal(calls.length, 1, 'identical progress is not resent to same window');
  replace({ isDestroyed: () => false, setProgressBar: () => { throw new Error('OS unavailable'); } });
  assert.doesNotThrow(() => controller.refresh());
  replace({ isDestroyed: () => false, setProgressBar: (...args) => calls.push(args) });
  controller.close();
  assert.deepEqual(calls.at(-1), [-1, { mode: 'none' }]);
  controller.update({ entries: [job('b', 'RUNNING', 2)] });
  assert.equal(calls.at(-1)[0], -1, 'shutdown cannot revive progress');
});
test('failed/cancelled jobs do not hold the indicator and retries start with zero queued progress', () => {
  const { controller, calls } = fixture('linux');
  controller.update({ entries: [job('a', 'RUNNING', 0, 0)] });
  assert.deepEqual(calls.at(-1), [0, { mode: 'normal' }], 'Linux has no indeterminate mode');
  controller.update({ entries: [job('a', 'FAILED', 3), job('b', 'CANCELLED', 2)] });
  assert.equal(calls.at(-1)[0], -1);
  controller.update({ queuePaused: true, entries: [job('a', 'QUEUED', 3)] });
  assert.equal(calls.at(-1)[0], 0);
  controller.update({ entries: [job('a', 'RUNNING', 20)] });
  assert.equal(calls.at(-1)[0], 1, 'progress is clamped');
});
