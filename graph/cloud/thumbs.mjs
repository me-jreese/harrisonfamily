// Derived media thumbnails (HFY-TSK-393, BRD D-38, ruling P4-R17). A step of hfy-graph-render, which already decodes originals with sharp
// and writes derived images to the site bucket, so no new layer, binary or resource is added.
//
//   read media/index.json (what hfy-sync-render published: the privacy and moderation decisions are already made there)
//   -> for each published image, two JPEGs (320 and 800 px on the long edge, quality 80, EXIF and ICC stripped, never upscaled,
//      orientation applied) at media/thumb/<handle>-<10 letters>-s<size>.jpg with the handle and the hash written as letters only: the
//      handle's UTF-8 bytes and the first 10 hex digits of the original's checksum, each hex digit written as a letter (0 -> a ... f -> p).
//      HFY-TSK-402: the first scheme (<handle>-<sha8>-<size>.jpg) put digit runs beside dashes, and the privacy gate of hfy-sync-render read
//      some of them (the handle's own digits included) as a phone number and withheld media/index.json. The only digits left in a key are
//      the 320 or 800 after an "s", so no handle or checksum can make one.
//   -> media/thumb/index.json (the sidecar hfy-sync-render reads to add `thumb` to media/index.json and media/<handle>.json)
//   -> prune thumbnails that no published image references any more (a media made private or deleted loses its thumbnails).
//
// Idempotent by source checksum: a handle whose sidecar record has the entry's checksum and whose two files exist is not read again. The
// sidecar is version 2; a version 1 sidecar (first key scheme) reads as empty, so every image is derived again under the new keys, and the
// first-scheme JPEGs are pruned with the rest of the thumbnails that no published image references. The key scheme is mirrored in gramps/hfygramps/render/thumbs.py. Originals are only read. A failure on one image gives that image no thumb and
// a counted warning; only an unreadable index fails the step. Only counts and error codes are logged, never a handle or a path.
import { createHash } from 'node:crypto';

export const INDEX_KEY = 'media/index.json';
export const THUMB_PREFIX = 'media/thumb/';
export const SIDECAR_KEY = 'media/thumb/index.json';
export const SIZES = Object.freeze([320, 800]);
export const SIDECAR_VERSION = 2;
const DIGEST_LETTERS = 10;
export const QUALITY = 80;
/** Stop deriving when less than this is left of the invocation; the next pass continues (the step is idempotent). */
export const MIN_BUDGET_MS = 45_000;

const HANDLE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_KEY = /^media\/([A-Za-z0-9_-]{1,64})\.(jpe?g|png|gif|tiff?|webp)$/i;
// A thumbnail object under media/thumb/: the current scheme or the first one (HFY-TSK-393, <handle>-<sha8>-<size>.jpg), which is pruned.
const THUMB_FILE = /^(?:[a-p]{2,128}-[a-p]{10}-s|[A-Za-z0-9_-]{1,64}-[0-9a-f]{8}-)(?:320|800)\.jpg$/;
const MAX_SIDE = 100_000;

/** Hex digits as letters a-p (0 -> a ... f -> p): a segment with no digit in it. */
const hexLetters = (hex) => Array.from(hex, (c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
/** The handle (injective: its UTF-8 bytes in hex) and the first 10 hex digits of the checksum, both as letters. */
export const handleLetters = (handle) => hexLetters(Buffer.from(handle, 'utf8').toString('hex'));
export const digestLetters = (checksum) => hexLetters(checksum.slice(0, DIGEST_LETTERS));
export const thumbKey = (handle, checksum, size) => `${THUMB_PREFIX}${handleLetters(handle)}-${digestLetters(checksum)}-s${size}.jpg`;
const fail = (code) => Object.assign(new Error(code), { code });
const isDim = (v) => Number.isInteger(v) && v > 0 && v <= MAX_SIDE;

/** The sidecar bytes as a Map handle -> {checksum, w, h}; anything malformed reads as empty. */
export function parseSidecar(raw) {
  const out = new Map();
  if (!raw) return out;
  let doc;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    return out;
  }
  if (!doc || doc.version !== SIDECAR_VERSION || !doc.thumbs || typeof doc.thumbs !== 'object' || Array.isArray(doc.thumbs)) return out;
  for (const [handle, rec] of Object.entries(doc.thumbs)) {
    if (HANDLE.test(handle) && rec && SHA256.test(rec.checksum ?? '') && isDim(rec.w) && isDim(rec.h)) out.set(handle, { checksum: rec.checksum, w: rec.w, h: rec.h });
  }
  return out;
}

/** The sidecar text: keys sorted, so an unchanged set of thumbnails is the same bytes. */
export function sidecarText(records) {
  const thumbs = {};
  for (const handle of [...records.keys()].sort()) {
    const { checksum, w, h } = records.get(handle);
    thumbs[handle] = { checksum, w, h };
  }
  return `${JSON.stringify({ version: SIDECAR_VERSION, thumbs })}\n`;
}

/** The published images of media/index.json: present originals with a plain handle, a sha-256 and an image file key. */
export function publishedImages(index) {
  const out = [];
  let skipped = 0;
  for (const e of index) {
    if (!e || e.missing === true) continue;
    const m = typeof e.s3Key === 'string' ? SOURCE_KEY.exec(e.s3Key) : null;
    if (typeof e.handle !== 'string' || !HANDLE.test(e.handle) || typeof e.checksum !== 'string' || !SHA256.test(e.checksum) || !m || m[1] !== e.handle) {
      skipped += 1; // a PDF, an unknown extension or a malformed entry: no thumbnail, no thumb field
      continue;
    }
    out.push({ handle: e.handle, checksum: e.checksum, s3Key: e.s3Key });
  }
  return { images: out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)), skipped };
}

/**
 * Both JPEGs of one original: `{ w, h, files: Map<size, Buffer> }`, w and h the oriented size of the original. No withMetadata():
 * EXIF, XMP and ICC are all dropped (sharp converts a profiled image to sRGB first). An alpha channel is flattened onto white.
 */
export async function deriveThumbnails(sharp, bytes) {
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  if (!meta.width || !meta.height || (meta.format === 'heif' && meta.compression !== 'av1')) throw fail('UNSUPPORTED_FORMAT');
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  const w = swap ? meta.height : meta.width;
  const h = swap ? meta.width : meta.height;
  if (!isDim(w) || !isDim(h)) throw fail('UNSUPPORTED_FORMAT');
  const files = new Map();
  for (const size of SIZES) {
    files.set(
      size,
      await sharp(bytes, { failOn: 'error' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY, progressive: true })
        .toBuffer(),
    );
  }
  return { w, h, files };
}

/**
 * @param {{ site: {get(key: string): Promise<Buffer|null>, put(key: string, body: Buffer|string, contentType: string): Promise<void>, delete(key: string): Promise<void>, list(prefix: string): Promise<string[]>},
 *   metrics: {emit(name: string, value?: number): Promise<void>|void}, log?: {info: Function, error: Function}, sharp?: Function }} deps
 * @param {{ force?: boolean, remainingMs?: () => number }} [event]
 */
export async function renderThumbnails(deps, event = {}) {
  const { site, metrics } = deps;
  const log = deps.log ?? console;
  const remaining = event.remainingMs ?? (() => Number.POSITIVE_INFINITY);
  try {
    const rawIndex = await site.get(INDEX_KEY);
    if (!rawIndex) return { status: 'skipped', reason: 'no_index' };
    let index;
    try {
      index = JSON.parse(rawIndex.toString('utf8'));
    } catch {
      throw fail('THUMB_INDEX_UNREADABLE');
    }
    if (!Array.isArray(index)) throw fail('THUMB_INDEX_UNREADABLE');
    const { images, skipped } = publishedImages(index);
    // An index with no media at all is never read as "unpublish everything": the thumbnails stay until a real index says otherwise.
    if (index.length === 0) return { status: 'skipped', reason: 'empty_index' };

    const rawSidecar = await site.get(SIDECAR_KEY);
    const prev = parseSidecar(rawSidecar);
    const existing = new Set((await site.list(THUMB_PREFIX)).filter((k) => THUMB_FILE.test(k.slice(THUMB_PREFIX.length))));
    const sharp = deps.sharp ?? (await import('sharp')).default;
    const next = new Map();
    const keep = new Set();
    const warnings = {};
    const warn = (code) => void (warnings[code] = (warnings[code] ?? 0) + 1);
    let derived = 0;
    let reused = 0;
    let pending = 0;
    for (const img of images) {
      const keys = SIZES.map((size) => thumbKey(img.handle, img.checksum, size));
      const rec = prev.get(img.handle);
      if (!event.force && rec && rec.checksum === img.checksum && keys.every((k) => existing.has(k))) {
        next.set(img.handle, rec);
        for (const k of keys) keep.add(k);
        reused += 1;
        continue;
      }
      if (remaining() < MIN_BUDGET_MS) {
        pending += 1;
        continue;
      }
      const bytes = await site.get(img.s3Key);
      if (!bytes) {
        warn('MEDIA_MISSING');
        continue;
      }
      if (bytes.length === 0) {
        warn('PLACEHOLDER_MEDIA');
        continue;
      }
      // The index and the original must agree: a replaced original that the index has not caught up with is derived on a later pass.
      if (createHash('sha256').update(bytes).digest('hex') !== img.checksum) {
        warn('CHECKSUM_MISMATCH');
        continue;
      }
      let out;
      try {
        out = await deriveThumbnails(sharp, bytes);
      } catch (e) {
        warn(e && e.code === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED_FORMAT' : 'DECODE_FAILED');
        continue;
      }
      for (const size of SIZES) await site.put(thumbKey(img.handle, img.checksum, size), out.files.get(size), 'image/jpeg');
      next.set(img.handle, { checksum: img.checksum, w: out.w, h: out.h });
      for (const k of keys) keep.add(k);
      derived += 1;
    }

    // The sidecar goes after the files it names, and only when its bytes changed.
    const text = sidecarText(next);
    const sidecarWritten = !rawSidecar || rawSidecar.toString('utf8') !== text;
    if (sidecarWritten) await site.put(SIDECAR_KEY, text, 'application/json');
    let pruned = 0;
    for (const key of existing) {
      if (!keep.has(key)) {
        await site.delete(key);
        pruned += 1;
      }
    }
    const result = { status: 'rendered', published: images.length, not_images: skipped, derived, reused, pending, pruned, sidecar_written: sidecarWritten, warnings };
    log.info?.(`thumbnails ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    const code = e && typeof e.code === 'string' && /^[\w.-]{1,64}$/.test(e.code) ? e.code : e && typeof e.name === 'string' && /^[\w.-]{1,64}$/.test(e.name) ? e.name : 'Error';
    log.error?.(`thumbnails failed code=${code}`);
    try {
      await metrics.emit('RenderError', 1);
    } catch {
      /* best effort: the thrown error below still fails the invocation */
    }
    throw new Error(`hfy-graph-render thumbnails failed: ${code}`);
  }
}
