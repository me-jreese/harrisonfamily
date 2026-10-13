// Minimal readers for the gazetteer files (viz-geocode-offline), so graph/ keeps no runtime dependency: ZIP (stored or deflated
// entries, no ZIP64) for the GeoNames and Natural Earth archives, and dBASE III tables for the Natural Earth attributes.

import { inflateRawSync } from 'node:zlib';
import { GraphError } from './errors.mjs';

const bad = (what) => new GraphError('GAZETTEER_CHECKSUM', `the gazetteer file ${what} is not a readable archive`);

/** Every file entry of a ZIP archive, by name. */
export function readZip(buf, label = 'archive') {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad(label);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad(label);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(label);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      try {
        out.set(name, inflateRawSync(data));
      } catch {
        throw bad(label);
      }
    } else throw bad(label);
  }
  return out;
}

/** The rows of a dBASE III table as plain objects keyed by lower-case field name; values are trimmed strings. */
export function readDbf(buf, label = 'table') {
  if (buf.length < 33) throw bad(label);
  const rows = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  let offset = 1; // the deletion flag
  for (let p = 32; p + 32 <= headerLen && buf[p] !== 0x0d; p += 32) {
    const raw = buf.subarray(p, p + 11);
    const end = raw.indexOf(0);
    const name = raw.subarray(0, end < 0 ? 11 : end).toString('latin1').toLowerCase();
    const len = buf[p + 16];
    fields.push({ name, offset, len });
    offset += len;
  }
  if (!fields.length || headerLen + rows * recordLen > buf.length) throw bad(label);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const at = headerLen + r * recordLen;
    if (buf[at] === 0x2a) continue; // deleted
    const row = {};
    for (const f of fields) row[f.name] = buf.subarray(at + f.offset, at + f.offset + f.len).toString('utf8').replace(/\0/g, '').trim();
    out.push(row);
  }
  return out;
}
