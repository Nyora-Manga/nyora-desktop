'use strict';

// Main-process only. The shared Kotlin codec owns archive validation/planning;
// this broker retains the selected raw bytes and never parses an archive.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MIME = 'application/vnd.nyora.backup';
const MAX_BYTES = 64 * 1024 * 1024;
const SECTIONS = ['sources', 'categories', 'preferences', 'manga', 'chapters', 'library', 'history', 'bookmarks', 'tracking'];
const COUNTS = ['additions', 'updates', 'deletions', 'unchanged'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const safeFileError = error => {
  if (/^E[A-Z0-9]+$/.test(error?.code || '')) return new Error('The selected backup or its storage could not be accessed. Check file permissions and available space.');
  return error;
};

function jsonResponse(response) {
  if (!Buffer.isBuffer(response?.bytes) || response.bytes.length > 2 * 1024 * 1024
    || !/^application\/json(?:\s*;|$)/i.test(response.contentType || '')) throw new Error('Invalid native backup response');
  const result = JSON.parse(response.bytes.toString('utf8'));
  if (!object(result) || result.error) throw new Error('Native backup operation was rejected');
  return result;
}

function summarize(plan) {
  if (!object(plan) || !['merge', 'replace'].includes(plan.mode) || typeof plan.archiveId !== 'string'
    || !object(plan.sections) || !object(plan.omissions) || !Array.isArray(plan.unresolvedSources)
    || !plan.unresolvedSources.every(id => typeof id === 'string' && /^data:[A-Za-z0-9_.-]{1,200}$/.test(id))
    || (plan.warnings !== undefined && (!Array.isArray(plan.warnings) || !plan.warnings.every(value => typeof value === 'string')))) {
    throw new Error('Invalid native Merge preview');
  }
  const sections = {};
  for (const name of SECTIONS) {
    const section = plan.sections[name];
    if (!object(section) || COUNTS.some(key => !count(section[key]))) throw new Error('Invalid native Merge counts');
    sections[name] = Object.fromEntries(COUNTS.map(key => [key, section[key]]));
  }
  if (Object.values(plan.omissions).some(value => !count(value))) throw new Error('Invalid native omission counts');
  const omissions = Object.values(plan.omissions).reduce((sum, value) => sum + value, 0);
  if (!count(omissions)) throw new Error('Invalid native omission count');
  return { sections, omissions, unresolvedSources: plan.unresolvedSources.length, warnings: plan.warnings?.length || 0 };
}

async function readArchive(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file) !== '.nyorabk') throw new Error('Select a .nyorabk backup');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Select a regular backup file, not a symbolic link');
  if (before.size < 1 || before.size > MAX_BYTES) throw new Error('Backup must be nonempty and no larger than 64 MiB');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Backup file changed while opening');
    // readFile() alone could allocate unbounded memory if the selected file grew.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Backup file changed while reading');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  // Windows does not support opening directories with fs.open for fsync.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(file, bytes, publish) {
  const directory = path.dirname(file);
  try {
    const existing = await fs.lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Destination must be a regular file, not a symbolic link');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.nyora-backup-${randomUUID()}.pending`);
  let published = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await publish(temporary, file);
    published = true;
    await syncDirectory(directory);
  } catch (error) {
    if (published) throw Object.assign(new Error('The file was written, but durable storage could not be confirmed'), { code: 'BACKUP_WRITE_UNCONFIRMED' });
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
}

class NativeBackupBroker {
  constructor({ helper, dialogs, window, exclusive, receiptDirectory, publish = fs.rename, afterReplace = async () => {} }) {
    if (!helper || ['start', 'stop', 'request'].some(key => typeof helper[key] !== 'function')
      || !dialogs || ['showOpenDialog', 'showSaveDialog', 'showMessageBox'].some(key => typeof dialogs[key] !== 'function')
      || typeof window !== 'function' || typeof exclusive !== 'function'
      || typeof receiptDirectory !== 'string' || !path.isAbsolute(receiptDirectory) || typeof publish !== 'function') throw new Error('Native backup requires main-process services and an exclusive gate');
    this.helper = helper; this.dialogs = dialogs; this.window = window;
    this.exclusive = exclusive; this.receiptDirectory = receiptDirectory; this.publish = publish; this.afterReplace = afterReplace;
  }

  async #receipt(receipt, phase, extra = {}) {
    await fs.mkdir(this.receiptDirectory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.receiptDirectory)).isSymbolicLink()) throw new Error('Backup receipt directory cannot be a symbolic link');
    const value = { ...receipt, phase, ...extra };
    await atomicWrite(path.join(this.receiptDirectory, `${receipt.receiptId}.json`), Buffer.from(JSON.stringify(value) + '\n'), this.publish);
  }

  async #plan(bytes, mode) {
    const plan = jsonResponse(await this.helper.request(`/backup/plan?mode=${mode}`, {
      method: 'POST', bytes: Buffer.from(bytes), contentType: MIME, maxBytes: 2 * 1024 * 1024,
    }));
    summarize(plan);
    if(plan.mode !== mode)throw new Error('Native restore mode did not match the request');
    return plan;
  }

  async #counts() {
    const stats = jsonResponse(await this.helper.request('/stats', { maxBytes: 2 * 1024 * 1024 }));
    const fields = ['totalChapters', 'distinctManga', 'favouritesCount'];
    if (fields.some(key => !count(stats[key]))) throw new Error('Invalid native statistics');
    return Object.fromEntries(fields.map(key => [key, stats[key]]));
  }

  export() {
    return this.exclusive(async () => {
      const selected = await this.dialogs.showSaveDialog(this.window(), {
        title: 'Create Nyora backup', defaultPath: 'Nyora.nyorabk',
        filters: [{ name: 'Nyora backup', extensions: ['nyorabk'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (selected.canceled || !selected.filePath) return { status: 'cancelled' };
      let file = selected.filePath;
      if (!path.extname(file)) file += '.nyorabk';
      if (!path.isAbsolute(file) || path.extname(file) !== '.nyorabk') throw new Error('Save backups with the .nyorabk extension');
      await this.helper.start();
      const result = await this.helper.request('/backup/export', { maxBytes: MAX_BYTES });
      if (result.contentType !== MIME || !Buffer.isBuffer(result.bytes) || !result.bytes.length || result.bytes.length > MAX_BYTES) throw new Error('Native helper did not return a bounded .nyorabk archive');
      await atomicWrite(file, result.bytes, this.publish);
      return { status: 'saved', archiveSha256: digest(result.bytes) };
    }).catch(error => { throw safeFileError(error); });
  }

  scheduledExport(directory, keep = 7) {
    return this.exclusive(async () => {
      if(!path.isAbsolute(directory) || !Number.isInteger(keep) || keep<1 || keep>30)throw new Error('Invalid scheduled backup destination');
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      if((await fs.lstat(directory)).isSymbolicLink())throw new Error('Invalid scheduled backup directory');
      await this.helper.start();
      const result=await this.helper.request('/backup/export',{maxBytes:MAX_BYTES});
      if(result.contentType!==MIME || !Buffer.isBuffer(result.bytes) || !result.bytes.length || result.bytes.length>MAX_BYTES)throw new Error('Invalid scheduled backup archive');
      const name=`nyora-auto-${Date.now()}-${randomUUID()}.nyorabk`;
      await atomicWrite(path.join(directory,name),result.bytes,this.publish);
      const names=(await fs.readdir(directory)).filter(value=>/^nyora-auto-[0-9]{13}-[0-9a-f-]{36}\.nyorabk$/.test(value)).sort().reverse();
      for(const old of names.slice(keep)) {
        const file=path.join(directory,old),info=await fs.lstat(file);
        if(info.isFile()&&!info.isSymbolicLink())await fs.unlink(file);
      }
      return {status:'saved'};
    });
  }

  import(mode = 'merge') {
    if(!['merge','replace'].includes(mode))return Promise.reject(new Error('Invalid restore mode'));
    return this.exclusive(async () => {
      const selected = await this.dialogs.showOpenDialog(this.window(), {
        title: 'Restore Nyora backup', filters: [{ name: 'Nyora backup', extensions: ['nyorabk'] }], properties: ['openFile'],
      });
      if (selected.canceled) return { status: 'cancelled' };
      if (!Array.isArray(selected.filePaths) || selected.filePaths.length !== 1) throw new Error('Select exactly one .nyorabk backup');
      const bytes = await readArchive(selected.filePaths[0]);
      await this.helper.start();
      const plan = await this.#plan(bytes, mode);
      const summary = summarize(plan);
      const detail = [
        ...SECTIONS.map(name => `${name}: ${summary.sections[name].additions} added, ${summary.sections[name].updates} updated, ${summary.sections[name].deletions} deleted, ${summary.sections[name].unchanged} unchanged`),
        `Omitted records: ${summary.omissions}`,
        `Unavailable sources retained: ${summary.unresolvedSources}`,
        `Warnings: ${summary.warnings}`,
        ...Object.entries(plan.omissions).slice(0, 50).map(([name, value]) => `Omission — ${name.slice(0, 100)}: ${value}`),
        ...plan.unresolvedSources.slice(0, 50).map(id => `Unavailable: ${id}`),
        ...(plan.unresolvedSources.length > 50 ? [`Plus ${plan.unresolvedSources.length - 50} other unavailable sources.`] : []),
        '', mode === 'replace' ? 'Replace deletes current portable library records and restores this backup. This cannot be undone. Manual desktop chapter marks are reset. Downloads, local files, credentials and device settings are kept separately.' : 'Merge applies newer records and deletion markers. Downloads, local files, credentials and device settings are not restored.',
      ].join('\n');
      const confirmation = await this.dialogs.showMessageBox(this.window(), {
        type: 'question', title: 'Review Nyora backup', message: mode === 'replace' ? 'Replace the current native library with this backup?' : 'Merge this backup into the current native library?', detail,
        buttons: ['Cancel', mode === 'replace' ? 'Replace library' : 'Merge backup'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1) return { status: 'cancelled', summary };
      const current = await this.#plan(bytes, mode);
      if (stable(plan) !== stable(current)) throw new Error('The restore preview changed. Nothing was imported; review the backup again.');
      const receipt = { schemaVersion: 1, receiptId: randomUUID(), archiveSha256: digest(bytes), mode, summary };
      await this.#receipt(receipt, 'before-commit');
      let imported;
      try {
        imported = jsonResponse(await this.helper.request(`/backup/import?mode=${mode}`, {
          method: 'POST', bytes: Buffer.from(bytes), contentType: MIME, maxBytes: 2 * 1024 * 1024,
        }));
        if (imported.ok !== true || stable(imported.plan) !== stable(current) || !object(imported.applied)
          || SECTIONS.some(name => !count(imported.applied[name]) || imported.applied[name] !== COUNTS.slice(0, 3).reduce((sum, key) => sum + summary.sections[name][key], 0))) throw new Error('Unconfirmed native restore result');
      } catch {
        await this.#receipt(receipt, 'commit-unknown').catch(() => {});
        throw Object.assign(new Error('The restore may have completed, but its result could not be confirmed. Do not automatically retry; reopen and inspect the native library.'), { code: 'BACKUP_COMMIT_UNKNOWN', receiptId: receipt.receiptId });
      }
      const applied = Object.fromEntries(SECTIONS.map(name => [name, imported.applied[name]]));
      try {
        await this.#receipt(receipt, 'applied', { applied });
        if(mode==='replace')await this.afterReplace();
        const committedCounts = await this.#counts();
        await this.#receipt(receipt, 'applied', { applied, committedCounts });
        await this.helper.stop();
        await this.helper.start();
        const reopenedCounts = await this.#counts();
        if (stable(committedCounts) !== stable(reopenedCounts)) throw new Error('Native counts changed across helper restart');
        await this.#receipt(receipt, 'reopened', { applied, committedCounts, reopenedCounts });
      } catch {
        throw Object.assign(new Error('The backup was applied, but restart verification could not be completed. Reopen and inspect the native library before retrying.'), { code: 'BACKUP_REOPEN_UNCONFIRMED', receiptId: receipt.receiptId });
      }
      return { status: 'completed', receiptId: receipt.receiptId, archiveSha256: receipt.archiveSha256, summary };
    }).catch(error => { throw safeFileError(error); });
  }
}

module.exports = { NativeBackupBroker, MIME, MAX_BYTES };
