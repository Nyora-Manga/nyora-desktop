import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeBackupBroker, MIME, MAX_BYTES } from '../electron/backup.cjs';

const sections = ['sources', 'categories', 'preferences', 'manga', 'chapters', 'library', 'history', 'bookmarks', 'tracking'];
const plan = () => ({ mode: 'merge', archiveId: '123e4567-e89b-12d3-a456-426614174000', createdAt: '2026-10-04T00:00:00.000Z', platform: 'desktop',
  sections: Object.fromEntries(sections.map(key => [key, { additions: 1, updates: 0, deletions: 0, unchanged: 0 }])),
  unresolvedSources: ['data:Synthetic'], omissions: { local: 2 }, warnings: ['Unavailable sources retained.'] });
const json = value => ({ bytes: Buffer.from(JSON.stringify(value)), contentType: 'application/json; charset=utf-8' });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyora-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'selected.nyorabk'), output = path.join(root, 'saved.nyorabk');
  // Intentionally opaque synthetic bytes: only the native helper is a codec.
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0, 0x31]);
  await fs.writeFile(input, bytes);
  const state = { root, input, output, bytes, active: false, calls: [], dialogs: [], confirmation: 1, plans: 0, failImport: false, failRestart: false };
  const helper = {
    async start() { assert(state.active); state.calls.push('start'); if (state.failRestart && state.calls.includes('stop')) throw new Error('restart failed'); },
    async stop() { assert(state.active); state.calls.push('stop'); },
    async request(route, options) {
      assert(state.active, 'all helper traffic is held within exclusive gate');
      state.calls.push(route);
      if (route === '/backup/export') return { bytes: state.bytes, contentType: state.exportMime || MIME };
      if (route.startsWith('/backup/')) {
        assert.equal(options.contentType, MIME); assert.equal(options.method, 'POST');
        assert.deepEqual(options.bytes, bytes, 'raw selected bytes remain identical');
        assert.notEqual(options.bytes, bytes);
      }
      if (route.startsWith('/backup/plan?mode=')) {
        state.plans++;
        if (state.invalid) throw new Error('Reference codec rejected truncated archive');
        const preview = {...plan(), mode:route.split('mode=')[1]}; if (state.stale && state.plans > 1) preview.sections.manga.additions++;
        return json(preview);
      }
      if (route.startsWith('/backup/import?mode=')) {
        const receipts = await fs.readdir(path.join(root, 'receipts'));
        const receipt = JSON.parse(await fs.readFile(path.join(root, 'receipts', receipts[0])));
        assert.equal(receipt.phase, 'before-commit', 'intent is durable before commit dispatch');
        if (state.failImport) throw new Error('transport lost after commit');
        return json({ ok: true, plan: {...plan(),mode:route.split('mode=')[1]}, applied: Object.fromEntries(sections.map(key => [key, 1])) });
      }
      if (route === '/stats') return json({ totalChapters: 1, distinctManga: 1, favouritesCount: state.changedRestartCounts && state.calls.includes('stop') ? 0 : 1, topSources: [] });
      throw new Error(`Unexpected route ${route}`);
    },
  };
  const dialogs = {
    async showOpenDialog(window, options) { assert(state.active); assert.equal(window, 'fixture-window'); state.dialogs.push(options); return { canceled: !!state.cancelOpen, filePaths: [state.input] }; },
    async showSaveDialog(window, options) { assert(state.active); state.dialogs.push(options); return { canceled: !!state.cancelSave, filePath: state.output }; },
    async showMessageBox(window, options) { assert(state.active); state.dialogs.push(options); if (state.changeSelectedAfterPreview) await fs.writeFile(input, 'replacement'); return { response: state.confirmation }; },
  };
  const options = { helper, dialogs, window: () => 'fixture-window', receiptDirectory: path.join(root, 'receipts'), exclusive: async action => {
    assert.equal(state.active, false); state.active = true;
    try { return await action(); } finally { state.active = false; }
  } };
  state.broker = new NativeBackupBroker(options); state.options = options;
  return state;
}

test('native Merge keeps immutable bytes through preview/re-plan/apply and records reopened counts', async t => {
  const f = await fixture(t); f.changeSelectedAfterPreview = true;
  const result = await f.broker.import();
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.omissions, 2); assert.equal(result.summary.unresolvedSources, 1);
  assert.deepEqual(f.calls, ['start', '/backup/plan?mode=merge', '/backup/plan?mode=merge', '/backup/import?mode=merge', '/stats', 'stop', 'start', '/stats']);
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'receipts', `${result.receiptId}.json`)));
  assert.equal(receipt.phase, 'reopened'); assert.equal(receipt.reopenedCounts.favouritesCount, 1);
  assert(!JSON.stringify(receipt).includes(f.root)); assert(!JSON.stringify(receipt).includes('data:Synthetic'));
  assert.match(f.dialogs[1].detail, /Omitted records: 2/); assert.match(f.dialogs[1].detail, /Unavailable sources retained: 1/);
  assert.equal(f.dialogs[1].defaultId, 0); assert.deepEqual(f.dialogs[1].buttons, ['Cancel', 'Merge backup']);
});

test('open/confirmation cancellation never calls import or writes a receipt', async t => {
  const f = await fixture(t); f.cancelOpen = true;
  assert.equal((await f.broker.import()).status, 'cancelled'); assert.deepEqual(f.calls, []);
  f.cancelOpen = false; f.confirmation = 0;
  assert.equal((await f.broker.import()).status, 'cancelled');
  assert(!f.calls.some(route => route.includes('import')));
  await assert.rejects(fs.access(path.join(f.root, 'receipts')), { code: 'ENOENT' });
});

test('reference-codec rejection and a changed preview cannot dispatch commit', async t => {
  const f = await fixture(t); f.invalid = true;
  await assert.rejects(f.broker.import(), /Reference codec rejected truncated archive/);
  assert.equal(f.dialogs.length, 1);
  f.invalid = false; f.stale = true; f.plans = 0;
  await assert.rejects(f.broker.import(), /preview changed/);
  assert(!f.calls.some(route => route.includes('import')));
});

test('only regular bounded .nyorabk files reach the helper', async t => {
  const f = await fixture(t);
  const original = f.input;
  for (const name of ['legacy.json', 'old.tachibk', 'old.aib', 'old.bk.zip']) {
    f.input = path.join(f.root, name); await fs.writeFile(f.input, f.bytes);
    await assert.rejects(f.broker.import(), /\.nyorabk/);
  }
  f.input = path.join(f.root, 'link.nyorabk'); await fs.symlink(original, f.input);
  await assert.rejects(f.broker.import(), /regular backup file/);
  f.input = path.join(f.root, 'folder.nyorabk'); await fs.mkdir(f.input);
  await assert.rejects(f.broker.import(), /regular backup file/);
  f.input = path.join(f.root, 'large.nyorabk'); await fs.writeFile(f.input, ''); await fs.truncate(f.input, MAX_BYTES + 1);
  await assert.rejects(f.broker.import(), /64 MiB/);
  await fs.truncate(f.input, 0); await assert.rejects(f.broker.import(), /nonempty/);
  assert.deepEqual(f.calls, []);
});

test('unknown commit result persists an unconfirmed receipt and never auto-retries', async t => {
  const f = await fixture(t); f.failImport = true;
  await assert.rejects(f.broker.import(), error => error.code === 'BACKUP_COMMIT_UNKNOWN' && /may have completed/.test(error.message));
  assert.equal(f.calls.filter(route => route.includes('/backup/import')).length, 1);
  assert(!f.calls.includes('stop'));
  const names = await fs.readdir(path.join(f.root, 'receipts'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'receipts', names[0]))).phase, 'commit-unknown');
});

test('failed restart retains applied receipt and never reports completion', async t => {
  const f = await fixture(t); f.failRestart = true;
  await assert.rejects(f.broker.import(), error => error.code === 'BACKUP_REOPEN_UNCONFIRMED');
  const names = await fs.readdir(path.join(f.root, 'receipts'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'receipts', names[0]))).phase, 'applied');
});

test('valid statistics from a changed destination cannot certify restart success', async t => {
  const f = await fixture(t); f.changedRestartCounts = true;
  await assert.rejects(f.broker.import(), error => error.code === 'BACKUP_REOPEN_UNCONFIRMED');
  const names = await fs.readdir(path.join(f.root, 'receipts'));
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'receipts', names[0])));
  assert.equal(receipt.phase, 'applied'); assert.equal(receipt.committedCounts.favouritesCount, 1);
  assert.equal(receipt.reopenedCounts, undefined);
});

test('export saves exact native bytes and rejects incorrect MIME', async t => {
  const f = await fixture(t);
  const result = await f.broker.export(); assert.equal(result.status, 'saved');
  assert.deepEqual(await fs.readFile(f.output), f.bytes);
  f.exportMime = 'application/json';
  await assert.rejects(f.broker.export(), /bounded .nyorabk/);
  assert.deepEqual(await fs.readFile(f.output), f.bytes);
  f.cancelSave = true; const count = f.calls.length;
  assert.equal((await f.broker.export()).status, 'cancelled'); assert.equal(f.calls.length, count);
});

test('failed atomic export preserves the existing destination and cleans temporary output', async t => {
  const f = await fixture(t); const previous = Buffer.from('previous backup'); await fs.writeFile(f.output, previous);
  const broker = new NativeBackupBroker({ ...f.options, publish: async () => { throw new Error('disk full'); } });
  await assert.rejects(broker.export(), /disk full/);
  assert.deepEqual(await fs.readFile(f.output), previous);
  assert(!(await fs.readdir(f.root)).some(name => name.endsWith('.pending')));
});

test('failure to persist pre-commit receipt prevents native apply', async t => {
  const f = await fixture(t);
  const broker = new NativeBackupBroker({ ...f.options, publish: async () => { throw new Error('receipt write failed'); } });
  await assert.rejects(broker.import(), /receipt write failed/);
  assert(!f.calls.some(route => route.includes('import')));
});


test('Replace uses a matching reviewed preview, defaults to Cancel, and records its mode', async t => {
  const f = await fixture(t);
  assert.equal((await f.broker.import('replace')).status,'completed');
  assert(f.calls.includes('/backup/import?mode=replace'));
  const confirmation=f.dialogs.find(d=>d.buttons);
  assert.match(confirmation.message,/Replace/);
  assert.equal(confirmation.defaultId,0);
  const [name]=await fs.readdir(path.join(f.root,'receipts'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'receipts',name))).mode,'replace');
});
test('Replace cancellation cannot dispatch a restore', async t => {
  const f=await fixture(t);f.confirmation=0;
  assert.equal((await f.broker.import('replace')).status,'cancelled');
  assert(!f.calls.some(route=>route.startsWith('/backup/import')));
});

test('scheduled backups retain seven automatic archives and preserve unrelated files',async t=>{
  const f=await fixture(t),folder=path.join(f.root,'automatic');await fs.mkdir(folder);
  for(let i=0;i<8;i++)await fs.writeFile(path.join(folder,`nyora-auto-100000000000${i}-123e4567-e89b-12d3-a456-426614174000.nyorabk`),'old');
  await fs.writeFile(path.join(folder,'personal.nyorabk'),'keep');
  assert.equal((await f.broker.scheduledExport(folder)).status,'saved');
  const files=await fs.readdir(folder);assert.equal(files.length,8);assert(files.includes('personal.nyorabk'));
});
