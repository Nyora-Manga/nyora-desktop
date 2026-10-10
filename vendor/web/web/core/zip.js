// core/zip.js — dependency-free ZIP/CBZ writer + reader for the browser.
//
// A CBZ is just a ZIP of page images, so the download manager builds archives
// with buildZip() (STORE method — images are already compressed, so deflating
// them again only wastes CPU) and the offline reader pulls pages back out with
// unzipImages(). This mirrors the in-place ZIP reader that screens/local.js uses
// for picked .cbz files, kept here as the single shared implementation.

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

// ---- CRC32 (table-based) -----------------------------------------------

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- DOS date/time -----------------------------------------------------

function dosDateTime(d) {
  const year = d.getFullYear();
  const time = ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = year < 1980
    ? (1 << 5) | 1 // 1980-01-01 floor
    : (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

// ---- ZIP writer (STORE only) -------------------------------------------
//
// buildZip([{ name: string, data: Uint8Array }]) -> Blob (application/zip).
// Filenames are written UTF-8 with the language-encoding flag set, so non-ASCII
// names survive (page entries are ASCII, but this keeps it correct in general).

export function buildZip(files, { date } = {}) {
  const enc = new TextEncoder();
  const when = dosDateTime(date instanceof Date ? date : new Date());

  // This writer is plain ZIP (no Zip64): entry count is a u16 and offsets are
  // u32. A single chapter never approaches these, but saveBundle() concatenates
  // many — fail loudly rather than emit a silently-corrupt archive.
  if (files.length > 0xffff) throw new Error('ZIP: too many entries (Zip64 unsupported)');

  const locals = [];   // Uint8Array chunks in file order (header + data)
  const centrals = []; // central-directory records
  let offset = 0;       // running offset for central-dir localHeaderOffset

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array
      ? f.data
      : new Uint8Array(f.data || []);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);      // signature
    ldv.setUint16(4, 20, true);              // version needed
    ldv.setUint16(6, 0x0800, true);          // flags: UTF-8 names
    ldv.setUint16(8, 0, true);               // method 0 = store
    ldv.setUint16(10, when.time, true);
    ldv.setUint16(12, when.date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true);           // compressed size
    ldv.setUint32(22, size, true);           // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);              // extra length
    lh.set(nameBytes, 30);

    locals.push(lh, data);

    if (offset + lh.length + data.length > 0xffffffff) {
      throw new Error('ZIP: archive exceeds 4 GB (Zip64 unsupported)');
    }

    // Central directory record (46 bytes + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);      // signature
    cdv.setUint16(4, 20, true);              // version made by
    cdv.setUint16(6, 20, true);              // version needed
    cdv.setUint16(8, 0x0800, true);          // flags: UTF-8
    cdv.setUint16(10, 0, true);              // method
    cdv.setUint16(12, when.time, true);
    cdv.setUint16(14, when.date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);              // extra length
    cdv.setUint16(32, 0, true);              // comment length
    cdv.setUint16(34, 0, true);              // disk number
    cdv.setUint16(36, 0, true);              // internal attrs
    cdv.setUint32(38, 0, true);              // external attrs
    cdv.setUint32(42, offset, true);         // local header offset
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);                 // disk
  edv.setUint16(6, 0, true);                 // central-dir disk
  edv.setUint16(8, files.length, true);      // entries on disk
  edv.setUint16(10, files.length, true);     // total entries
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true);                // comment length

  return new Blob([...locals, ...centrals, eocd], { type: 'application/zip' });
}

// ---- ZIP reader --------------------------------------------------------
//
// unzipImages(source) -> Promise<[{ name, bytes: Uint8Array }]> sorted by
// natural name. `source` may be a Blob/File, ArrayBuffer or Uint8Array.
// Supports stored (0) and deflate (8, via DecompressionStream) entries.

export async function unzipImages(source) {
  let buf;
  if (source instanceof Uint8Array) {
    buf = source;
  } else if (source instanceof ArrayBuffer) {
    buf = new Uint8Array(source);
  } else if (source && typeof source.arrayBuffer === 'function') {
    buf = new Uint8Array(await source.arrayBuffer());
  } else {
    throw new Error('unzipImages: unsupported source');
  }

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Find End Of Central Directory (0x06054b50), scanning back from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off < 0 || off + 46 > buf.length) break; // truncated / corrupt — stop, keep what we have
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    if (off + 46 + nameLen > buf.length) break;
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (IMAGE_RE.test(name)) entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const out = [];
  for (const e of entries) {
    if (e.localOff < 0 || e.localOff + 30 > buf.length) continue; // corrupt entry — skip
    const lnameLen = dv.getUint16(e.localOff + 26, true);
    const lextraLen = dv.getUint16(e.localOff + 28, true);
    const dataStart = e.localOff + 30 + lnameLen + lextraLen;
    if (dataStart + e.compSize > buf.length) continue;
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    let bytes;
    if (e.method === 0) {
      bytes = comp;
    } else if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([comp]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue; // unsupported compression
    }
    out.push({ name: e.name, bytes });
  }
  return out;
}

export default { buildZip, unzipImages };
