'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { inflateRaw } = require('node:zlib');
const { promisify } = require('node:util');
const inflate = promisify(inflateRaw);
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return crc >>> 0; }
function crc32(bytes) { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
function safeEntry(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\0-\x1f\x7f\\]/.test(name)
    || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe archive entry');
  return name;
}
async function exact(file, length, position) {
  const bytes = Buffer.alloc(length);
  if ((await file.read(bytes, 0, length, position)).bytesRead !== length) throw new Error('Truncated archive');
  return bytes;
}
// ZIP32 only, stored/deflate only. Never extract entry paths. Central sizes,
// offsets, CRCs and actual inflated sizes are independently checked.
async function openArchive(filePath, { maxBytes = 512 * 1024 * 1024, maxEntries = 5000 } = {}) {
  const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 22 || info.size > maxBytes) throw new Error('Archive exceeds limits or is invalid');
    const tailSize = Math.min(info.size, 65557), tailStart = info.size - tailSize;
    const tail = await exact(file, tailSize, tailStart);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported or incomplete archive');
    const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count > maxEntries || count === 65535 || tail.readUInt16LE(end + 8) !== count
      || size > 8 * 1024 * 1024 || offset + size !== tailStart + end) throw new Error('Archive index exceeds limits');
    const central = await exact(file, size, offset), entries = [], names = new Set();
    let cursor = 0, advertisedTotal = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid archive index');
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20), length = central.readUInt32LE(cursor + 24);
      const n = central.readUInt16LE(cursor + 28), extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42), mode = central.readUInt32LE(cursor + 38) >>> 16;
      if (cursor + 46 + n + extra + comment > central.length || flags & 1 || flags & 0x40 || ![0, 8].includes(method)
        || central.readUInt16LE(cursor + 34) || localOffset === 0xffffffff || compressed === 0xffffffff || length === 0xffffffff
        || (mode & 0o170000) === 0o120000 || localOffset + 30 + compressed > offset) throw new Error('Unsupported archive entry');
      const rawName = central.subarray(cursor + 46, cursor + 46 + n);
      if (!(flags & 0x800) && rawName.some(byte => byte > 127)) throw new Error('Archive filenames need UTF-8 encoding');
      const name = safeEntry(new TextDecoder('utf-8', { fatal: true }).decode(rawName));
      if (names.has(name)) throw new Error('Duplicate archive entry');
      names.add(name); advertisedTotal += length;
      if (advertisedTotal > maxBytes) throw new Error('Expanded archive exceeds limits');
      entries.push({ name, length, compressed, method, flags, localOffset, crc: central.readUInt32LE(cursor + 16) });
      cursor += 46 + n + extra + comment;
    }
    if (cursor !== central.length) throw new Error('Invalid archive index length');
    return {
      entries,
      async read(entry, maxOutputBytes = 32 * 1024 * 1024) {
        if (!entries.includes(entry) || entry.length > maxOutputBytes || entry.compressed > maxOutputBytes) throw new Error('Archive page exceeds limits');
        const local = await exact(file, 30, entry.localOffset);
        if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) throw new Error('Archive headers disagree');
        const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
        const name = await exact(file, nameLength, entry.localOffset + 30);
        if (new TextDecoder('utf-8', { fatal: true }).decode(name) !== entry.name) throw new Error('Archive filenames disagree');
        const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
        if (dataOffset + entry.compressed > offset) throw new Error('Archive entry escapes data region');
        const compressedBytes = await exact(file, entry.compressed, dataOffset);
        const bytes = entry.method === 0 ? compressedBytes : await inflate(compressedBytes, { maxOutputLength: maxOutputBytes });
        if (bytes.length !== entry.length || crc32(bytes) !== entry.crc) throw new Error('Archive page is damaged');
        return bytes;
      },
      close: () => file.close(),
    };
  } catch (error) { await file.close(); throw error; }
}

// Streaming stored ZIP: one 64KiB file chunk in memory, data descriptors carry
// final CRC/size. The writer never relies on renderer-supplied archive paths.
async function writeArchive(destination, entries, { signal, maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!entries.length || entries.length > 5000) throw new Error('Invalid archive count');
  const file = await fs.open(destination, 'wx', 0o600), central = [];
  let position = 0, total = 0;
  async function write(bytes) {
    signal?.throwIfAborted();
    let offset = 0;
    while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
    position += bytes.length;
    if (position >= 0xffffffff) throw new Error('Archive is too large');
  }
  try {
    const names = new Set();
    for (const entry of entries) {
      const name = Buffer.from(safeEntry(entry.name));
      if (name.length > 65535 || names.has(entry.name)) throw new Error('Invalid archive filename');
      names.add(entry.name);
      const start = position, local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x808, 6); local.writeUInt16LE(name.length, 26);
      await write(local); await write(name);
      const input = await fs.open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let crc = 0xffffffff, size = 0;
      try {
        if (!(await input.stat()).isFile()) throw new Error('Archive source must be a regular file');
        const chunk = Buffer.alloc(65536);
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          total += bytesRead; size += bytesRead;
          if (total > maxBytes) throw new Error('Archive exceeds export limits');
          const bytes = chunk.subarray(0, bytesRead); crc = crcUpdate(crc, bytes); await write(bytes);
        }
      } finally { await input.close(); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x808, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(size, 20); record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42);
      central.push(Buffer.concat([record, name]));
    }
    const centralOffset = position;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - centralOffset, 12); end.writeUInt32LE(centralOffset, 16); await write(end);
    await file.sync();
  } finally { await file.close(); }
}
module.exports = { openArchive, writeArchive, crc32, safeEntry };
