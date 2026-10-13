// Face crops from Gramps region rects (viz.md 5.5, VIZ-D9; task viz-face-crops). sharp (Apache-2.0, exact pin) is a
// build-time dependency of graph/ only: it runs on io's Mac now and in the cloud renderer later, and neither node_modules nor
// the libvips binaries (LGPL) ever reach the site output. Only the encoded WebP files are written, with all metadata stripped.
//
// The crop keeps parity with Gramps thumbnails: the rect [x1, y1, x2, y2] is integer percent, measured on the STORED pixels
// (no EXIF auto-orient), converted by truncation (Gramps: int(x * width / 100)), expanded to a square around its centre and
// clamped to the image, then resized to 160x160 and encoded as WebP at quality 70 (lower if needed to stay within 8 KB).
//
// Files are named faces/<gramps_id>-<sha8>.webp, sha8 = sha256(source bytes || JSON(rect)), so a changed photo or rect is a new
// URL. An unchanged input writes nothing, and faces no longer referenced are pruned once the new graph.json is written.
// No failure stops the build: the person gets face null (or, for RECT_INVALID, the centre square) and a report warning.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './write.mjs';

export const FACE_SIZE = 160;
export const FACE_MAX_BYTES = 8 * 1024;
export const FACE_FILE = /^[A-Za-z0-9_-]{1,32}-[0-9a-f]{8}\.webp$/;
const QUALITIES = [70, 60, 50, 40, 30];

/** The rect as Gramps stores it, ordered and clamped to 0..100: `{ rect, invalid }`; a missing or [0,0,0,0] rect is null. */
export function normalizeRect(raw) {
  if (raw === null || raw === undefined) return { rect: null, invalid: false };
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(Number.isInteger)) return { rect: null, invalid: true };
  if (raw.every((v) => v === 0)) return { rect: null, invalid: false }; // Gramps' "no region"
  const c = (v) => Math.min(100, Math.max(0, v));
  const x1 = c(Math.min(raw[0], raw[2]));
  const x2 = c(Math.max(raw[0], raw[2]));
  const y1 = c(Math.min(raw[1], raw[3]));
  const y2 = c(Math.max(raw[1], raw[3]));
  if (x2 <= x1 || y2 <= y1) return { rect: null, invalid: true };
  return { rect: [x1, y1, x2, y2], invalid: false };
}

/**
 * The square crop box in stored pixels: `{ left, top, width, height, invalid }`. A rect that truncates to zero pixels is
 * invalid and falls back to the centre square of the whole image, as a null rect does.
 */
export function cropBox(width, height, rect) {
  let left = 0;
  let top = 0;
  let w = width;
  let h = height;
  let invalid = false;
  if (rect) {
    const l = Math.floor((rect[0] * width) / 100);
    const t = Math.floor((rect[1] * height) / 100);
    const r = Math.floor((rect[2] * width) / 100);
    const b = Math.floor((rect[3] * height) / 100);
    if (r > l && b > t) {
      left = l;
      top = t;
      w = r - l;
      h = b - t;
    } else invalid = true;
  }
  const side = Math.min(Math.max(w, h), width, height);
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  // centre the square on the box (2x the centre keeps it in integers), then clamp it inside the image
  const sl = clamp(Math.floor((2 * left + w - side) / 2), width - side);
  const st = clamp(Math.floor((2 * top + h - side) / 2), height - side);
  return { left: sl, top: st, width: side, height: side, invalid };
}

/** sha8 = the first 8 hex digits of sha256(source bytes || JSON(rect)). */
export function faceName(id, bytes, rect) {
  const sha8 = createHash('sha256').update(bytes).update(JSON.stringify(rect)).digest('hex').slice(0, 8);
  return `${id}-${sha8}.webp`;
}

/** The interim MediaReader: the ETL staging `media/<handle>.<ext>`, `.json` excluded. A missing directory reads as missing. */
export function stagingMediaReader(dir) {
  let byHandle = null;
  const index = () => {
    byHandle = new Map();
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const dot = f.lastIndexOf('.');
      if (dot <= 0 || f.slice(dot).toLowerCase() === '.json') continue;
      const handle = f.slice(0, dot);
      if (!byHandle.has(handle) && statSync(join(dir, f)).isFile()) byHandle.set(handle, join(dir, f));
    }
  };
  return {
    read(handle) {
      if (!byHandle) index();
      const path = byHandle.get(handle);
      return path ? readFileSync(path) : null;
    },
  };
}

async function encode(sharp, bytes, box) {
  let out = null;
  for (const quality of QUALITIES) {
    out = await sharp(bytes, { failOn: 'error' })
      .extract(box)
      .resize(FACE_SIZE, FACE_SIZE, { fit: 'cover' })
      .webp({ quality, effort: 6 })
      .toBuffer(); // no withMetadata()/keepMetadata(): EXIF, XMP and ICC are all stripped
    if (out.length <= FACE_MAX_BYTES) break;
  }
  return out;
}

/**
 * Crops and writes the faces for `jobs` ({id, media, rect}: the person's gramps id, the media handle of Person.media_list[0]
 * and its rect). Writes only files that do not exist yet. Prune separately, after graph.json is written.
 * @param {{ id: string, media: string, rect: unknown }[]} jobs
 * @param {{ read(handle: string): Buffer | null }} reader
 * @param {string} mediaOut  <staging>/media (faces go to <mediaOut>/faces)
 * @returns {Promise<{ faces: Map<string, string|null>, keep: Set<string>, written: number, warnings: { code: string, id: string }[] }>}
 */
export async function buildFaces(jobs, reader, mediaOut) {
  const { default: sharp } = await import('sharp'); // loaded only when faces are built
  const dir = join(mediaOut, 'faces');
  const faces = new Map();
  const keep = new Set();
  const warnings = [];
  const warn = (code, id) => warnings.push({ code, id });
  let written = 0;
  for (const job of jobs) {
    faces.set(job.id, null);
    const bytes = reader.read(job.media);
    if (bytes === null || bytes === undefined) {
      warn('MEDIA_MISSING', job.id);
      continue;
    }
    if (bytes.length === 0) {
      warn('PLACEHOLDER_MEDIA', job.id); // a Dropbox placeholder
      continue;
    }
    let meta;
    try {
      meta = await sharp(bytes, { failOn: 'error' }).metadata();
    } catch {
      warn('UNSUPPORTED_FORMAT', job.id);
      continue;
    }
    if (!meta.width || !meta.height || (meta.format === 'heif' && meta.compression !== 'av1')) {
      warn('UNSUPPORTED_FORMAT', job.id); // HEIC with HEVC: the prebuilt binaries cannot decode it
      continue;
    }
    if (meta.orientation && meta.orientation !== 1) {
      warn('ORIENTATION_NOT_BAKED', job.id); // the rect is on stored pixels; a sideways crop is worse than initials
      continue;
    }
    const norm = normalizeRect(job.rect);
    const box = cropBox(meta.width, meta.height, norm.rect);
    const rect = box.invalid ? null : norm.rect;
    if (norm.invalid || box.invalid) warn('RECT_INVALID', job.id);
    const name = faceName(job.id, bytes, rect);
    const target = join(dir, name);
    if (!existsSync(target)) {
      let out;
      try {
        out = await encode(sharp, bytes, box);
      } catch {
        warn('UNSUPPORTED_FORMAT', job.id);
        continue;
      }
      writeAtomic(target, out);
      written += 1;
    }
    faces.set(job.id, `faces/${name}`);
    keep.add(name);
  }
  return { faces, keep, written, warnings };
}

/** Removes face files that the current graph no longer references (so the --delete sync removes them from S3). */
export function pruneFaces(mediaOut, keep) {
  const dir = join(mediaOut, 'faces');
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (FACE_FILE.test(f) && !keep.has(f)) {
      rmSync(join(dir, f), { force: true });
      removed += 1;
    }
  }
  return removed;
}
