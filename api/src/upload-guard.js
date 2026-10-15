// Location-metadata refusal for member photos (HFY-PLN-002 D2-06, BRD2 5.3; task privacy-guard-existing-paths). The browser is
// meant to re-encode photos without EXIF, but the server does not trust it: before a post (and later a comment or a graduation)
// takes an upload, checkLocation reads the first 256 KiB of the stored object (and the last 256 KiB of a larger WebP, whose
// EXIF and XMP chunks follow the image data) and refuses 400 photo_has_location when it carries a position or a place:
//   - EXIF: the GPS IFD (IFD0 tag 0x8825) holds a non-zero GPSLatitude, GPSLongitude, GPSDestLatitude or GPSDestLongitude.
//     EXIF is found in a JPEG APP1 "Exif" segment, a PNG eXIf chunk, a WebP EXIF chunk, and anywhere else an "Exif\0\0" TIFF
//     header sits (HEIC keeps it in an item of its own). A GPS IFD that is present but cannot be read counts as a position.
//   - XMP (any container, plain or zlib-compressed PNG iTXt): a non-empty exif:GPS* property (GPSVersionID alone is not a
//     location), photoshop:City or photoshop:State, or Iptc4xmpCore:Location, under whatever prefix the packet binds to the
//     namespace.
//   - IPTC IIM in a JPEG APP13 Photoshop block: City (2:90), Sub-location (2:92) or Province/State (2:95), the binary twins of
//     the XMP fields above.
// Any member can upload, so the work is bounded whatever the bytes (HFY-TSK-240 review): every scan is linear in the bytes read,
// compressed XMP inflates to at most XMP_MAX_INFLATED in all, and a file that would take more than the caps below (more
// compressed XMP, more location properties, more EXIF headers or unterminated location values than any camera writes) is
// refused as if it carried a location (fail closed).
// Nothing here logs, and the bytes, the key and what was found never reach an error message.
import { constants as zlibConstants, inflateSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HttpError } from "./http.js";

/**
 * The bytes read. JPEG and PNG keep their metadata at the front; a larger WebP's end is read too (TAIL_RANGE); a HEIC's EXIF
 * item may sit later in the file (the known gap).
 */
export const LOCATION_RANGE = "bytes=0-262143";
export const LOCATION_BYTES = 262144;
/** The second read of a WebP whose RIFF data runs past LOCATION_BYTES: the end of the file, where its EXIF and XMP chunks sit. */
export const TAIL_RANGE = `bytes=-${LOCATION_BYTES}`;
/** Inflated bytes allowed across every compressed XMP chunk of one check; past it the check fails closed. */
export const XMP_MAX_INFLATED = 1024 * 1024;
/** Location properties examined in one XMP text before the check fails closed (a camera writes a few dozen GPS tags at most). */
export const XMP_MAX_PROPERTIES = 256;
/** How far past a location property's name its value (attribute) or closing tag (element) is looked for; beyond it, fail closed. */
export const XMP_VALUE_WINDOW = 65536;
/** "Exif\0\0" headers (or WebP EXIF chunk headers at the end of the file) examined before the check fails closed. */
export const MAX_EXIF_HEADERS = 16;

const latin1 = (b, s = 0, e = b.length) => {
  let out = "";
  for (let i = s; i < e; i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192)));
  return out;
};
const startsWith = (b, at, ascii) => {
  if (at < 0 || at + ascii.length > b.length) return false;
  for (let i = 0; i < ascii.length; i += 1) if (b[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
};
const indexOf = (b, ascii, from = 0) => {
  const first = ascii.charCodeAt(0);
  for (let i = b.indexOf(first, from); i !== -1 && i + ascii.length <= b.length; i = b.indexOf(first, i + 1)) {
    if (startsWith(b, i, ascii)) return i;
  }
  return -1;
};

// ---------------------------------------------------------------------------------------------------------------- EXIF

const GPS_POINTER = 0x8825;
const GPS_POSITION_TAGS = new Set([0x0002, 0x0004, 0x0014, 0x0016]); // GPSLatitude, GPSLongitude, GPSDestLatitude, GPSDestLongitude

/**
 * True when the TIFF structure at b[start..end) has a GPS IFD with a position. Every read is bounds-checked; a TIFF header
 * that is not one returns false, and a GPS pointer whose IFD cannot be read returns true (fail closed).
 */
export function tiffHasGpsPosition(b, start = 0, end = b.length) {
  if (start + 8 > end) return false;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  const be = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!le && !be) return false;
  const u16 = (o) => (o + 2 > end - start ? null : le ? b[start + o] | (b[start + o + 1] << 8) : (b[start + o] << 8) | b[start + o + 1]);
  const u32 = (o) => {
    if (o < 0 || o + 4 > end - start) return null;
    const p = start + o;
    return le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  };
  if (u16(2) !== 42) return false;
  const entries = (ifd) => {
    const n = u16(ifd);
    if (n === null || n > 1000 || ifd + 2 + n * 12 > end - start) return null;
    return Array.from({ length: n }, (_, i) => {
      const at = ifd + 2 + i * 12;
      return { tag: u16(at), type: u16(at + 2), count: u32(at + 4), value: u32(at + 8), at };
    });
  };
  const nonZeroRational = (e) => {
    if ((e.type !== 5 && e.type !== 10) || !e.count) return true; // a position tag of an unexpected type: fail closed
    for (let k = 0; k < Math.min(e.count, 4); k += 1) {
      const num = u32(e.value + k * 8);
      const den = u32(e.value + k * 8 + 4);
      if (num === null || den === null) return true; // points outside what was read: fail closed
      if (num !== 0 && den !== 0) return true;
    }
    return false;
  };
  const seen = new Set();
  for (let ifd = u32(4), hops = 0; ifd && hops < 4 && !seen.has(ifd); hops += 1) {
    seen.add(ifd);
    const list = entries(ifd);
    if (!list) return false;
    const ptr = list.find((e) => e.tag === GPS_POINTER);
    if (ptr) {
      const gps = entries(ptr.value);
      if (!gps) return true; // a GPS IFD that cannot be read
      if (gps.some((e) => GPS_POSITION_TAGS.has(e.tag) && nonZeroRational(e))) return true;
    }
    ifd = u32(ifd + 2 + list.length * 12);
  }
  return false;
}

/** EXIF payloads may start with "Exif\0\0" (JPEG, most HEIC, some PNG and WebP writers) or straight with the TIFF header. */
const exifHasPosition = (b, start, end) => tiffHasGpsPosition(b, startsWith(b, start, "Exif\0\0") ? start + 6 : start, end);

// ---------------------------------------------------------------------------------------------------------------- XMP

const NS_KIND = new Map([
  ["http://ns.adobe.com/exif/1.0/", "exif"],
  ["http://ns.adobe.com/photoshop/1.0/", "photoshop"],
  ["http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/", "iptc"],
]);
const DEFAULT_PREFIX = [["exif", "exif"], ["photoshop", "photoshop"], ["Iptc4xmpCore", "iptc"]];
const BINDING = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"'<>]{1,128})["']/g;
/** prefix:LocalName after a start-of-name boundary; the boundary is "<" for an element. */
const PROPERTY = /(^|[\s<"'])([A-Za-z_][\w.-]*):([A-Za-z]+)/g;
const isLocationName = (kind, local) =>
  kind === "exif" ? local.length > 3 && local.startsWith("GPS") && local !== "GPSVersionID"
    : kind === "photoshop" ? local === "City" || local === "State"
      : local === "Location";
/** A value that cannot be read inside XMP_VALUE_WINDOW (unterminated, or longer than any real one): treated as a location. */
const UNREADABLE = Symbol("unreadable");

/** Text with markup removed, as /<[^>]*>/g would, in one pass: once a "<" has no ">" after it, none later can either. */
function stripTags(s) {
  let out = "";
  for (let i = 0; ;) {
    const lt = s.indexOf("<", i);
    const gt = lt === -1 ? -1 : s.indexOf(">", lt + 1);
    if (gt === -1) return out + s.slice(i);
    out += s.slice(i, lt);
    i = gt + 1;
  }
}

/**
 * The value of the property whose name ends at `at`: the attribute value (p:n="v"), the element text with nested markup
 * stripped (<p:n ...>v</p:n>, only when `element`), null when neither form is there or the element is empty (<p:n/>), or
 * UNREADABLE when the value or the closing tag is not inside XMP_VALUE_WINDOW. O(XMP_VALUE_WINDOW) at most.
 */
function propertyValue(text, at, element, prefix, local) {
  const win = text.slice(at, at + XMP_VALUE_WINDOW);
  const attr = /^\s*=\s*(["'])/.exec(win);
  if (attr) {
    const close = win.indexOf(attr[1], attr[0].length);
    return close === -1 ? UNREADABLE : win.slice(attr[0].length, close);
  }
  if (!element || !/^[\s>]/.test(win)) return null;
  const gt = win.indexOf(">");
  if (gt === -1) return UNREADABLE;
  if (win[gt - 1] === "/") return null;
  const closeTag = `</${prefix}:${local}`;
  const tagEnd = /\s*>/y;
  for (let from = gt + 1; ;) {
    const c = win.indexOf(closeTag, from);
    if (c === -1) return UNREADABLE;
    tagEnd.lastIndex = c + closeTag.length;
    if (tagEnd.test(win)) return stripTags(win.slice(gt + 1, c));
    from = c + 1;
  }
}

/**
 * True when an XMP text carries a location (see the header). Works on a whole buffer decoded as latin1, in time linear in its
 * length: one pass for the namespace bindings, one for the property names, and at most XMP_MAX_PROPERTIES values of at most
 * XMP_VALUE_WINDOW each.
 */
export function xmpHasLocation(text) {
  if (!/xmp|rdf:|exif:|photoshop:|Iptc4xmpCore:|xmlns:/i.test(text)) return false;
  const kinds = new Map(DEFAULT_PREFIX.map(([p, k]) => [p, new Set([k])]));
  for (const [, prefix, uri] of text.matchAll(BINDING)) {
    const kind = NS_KIND.get(uri);
    if (kind) kinds.set(prefix, (kinds.get(prefix) ?? new Set()).add(kind));
  }
  let examined = 0;
  for (const m of text.matchAll(PROPERTY)) {
    const [whole, boundary, prefix, local] = m;
    const ks = kinds.get(prefix);
    if (!ks || ![...ks].some((k) => isLocationName(k, local))) continue;
    if (++examined > XMP_MAX_PROPERTIES) return true;
    const v = propertyValue(text, m.index + whole.length, boundary === "<", prefix, local);
    if (v === UNREADABLE || (v !== null && v.trim() !== "")) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------- containers

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** IPTC IIM records 2:90 City, 2:92 Sub-location, 2:95 Province/State with a non-empty value, inside a Photoshop APP13 block. */
function iptcHasLocation(b, start, end) {
  for (let i = indexOf(b.subarray(start, end), "8BIM"); i !== -1; ) {
    const at = start + i;
    if (at + 12 > end) return false;
    const id = be16(b, at + 4);
    const nameLen = b[at + 6];
    const nameField = nameLen + 1 + ((nameLen + 1) % 2); // Pascal string padded to even
    const sizeAt = at + 6 + nameField;
    if (sizeAt + 4 > end) return false;
    const size = be32(b, sizeAt);
    const data = sizeAt + 4;
    if (id === 0x0404) {
      for (let p = data; p + 5 <= Math.min(end, data + size); ) {
        if (b[p] !== 0x1c) break;
        const rec = b[p + 1];
        const ds = b[p + 2];
        const len = be16(b, p + 3);
        if (len & 0x8000) break; // extended length: not used for these short fields
        if (rec === 2 && (ds === 90 || ds === 92 || ds === 95) && latin1(b, p + 5, Math.min(end, p + 5 + len)).trim() !== "") return true;
        p += 5 + len;
      }
    }
    const next = data + size + (size % 2);
    const j = indexOf(b.subarray(next, end), "8BIM");
    i = j === -1 ? -1 : next - start + j;
  }
  return false;
}

function jpegFinds(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
  for (let p = 2; p + 4 <= b.length; ) {
    if (b[p] !== 0xff) return null; // lost sync: leave the rest to the generic scans
    const marker = b[p + 1];
    if (marker === 0xff) { p += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end of image: no metadata after this
    const len = be16(b, p + 2);
    const s = p + 4;
    const e = Math.min(b.length, p + 2 + len);
    if (marker === 0xe1 && startsWith(b, s, "Exif\0\0") && tiffHasGpsPosition(b, s + 6, e)) return "exif_gps";
    if (marker === 0xed && startsWith(b, s, "Photoshop 3.0\0") && iptcHasLocation(b, s, e)) return "iptc_location";
    if (len < 2) return null;
    p += 2 + len;
  }
  return null;
}

/**
 * Compressed XMP text, inflating at most `budget.left` more bytes (a truncated stream gives what it holds): a string, null when
 * the stream is corrupt, or UNREADABLE when it would inflate past the budget.
 */
function inflateXmp(data, budget) {
  if (budget.left <= 0) return UNREADABLE;
  try {
    const out = inflateSync(data, { maxOutputLength: budget.left, finishFlush: zlibConstants.Z_SYNC_FLUSH });
    budget.left -= out.length;
    return out.toString("latin1");
  } catch (e) {
    return e?.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError ? UNREADABLE : null;
  }
}

function pngFinds(b) {
  if (!startsWith(b, 0, "\x89PNG\r\n\x1a\n")) return null;
  const budget = { left: XMP_MAX_INFLATED };
  for (let p = 8; p + 12 <= b.length; ) {
    const len = be32(b, p);
    const type = latin1(b, p + 4, p + 8);
    const s = p + 8;
    const e = Math.min(b.length, s + len);
    if (type === "eXIf" && exifHasPosition(b, s, e)) return "exif_gps";
    if (type === "iTXt") {
      const kwEnd = b.indexOf(0, s);
      if (kwEnd !== -1 && kwEnd < e && latin1(b, s, kwEnd) === "XML:com.adobe.xmp") {
        const compressed = b[kwEnd + 1] === 1;
        let q = b.indexOf(0, kwEnd + 3); // language tag
        q = q === -1 ? -1 : b.indexOf(0, q + 1); // translated keyword
        if (q !== -1 && q < e) {
          const text = compressed ? inflateXmp(b.subarray(q + 1, e), budget) : latin1(b, q + 1, e);
          if (text === UNREADABLE) return "xmp_location"; // more compressed XMP than any camera writes: fail closed
          if (text !== null && xmpHasLocation(text)) return "xmp_location"; // null (corrupt): the generic scan still sees plain text
        }
      }
    }
    if (type === "IEND") return null;
    p = s + len + 4;
  }
  return null;
}

const isWebp = (b) => startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP");
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/**
 * The RIFF chunk walk of a WebP: `found` (as findLocation), the VP8X `flags` byte, and whether an EXIF or XMP chunk was seen
 * whole in these bytes (`exif`, `xmp`).
 */
function webpWalk(b) {
  const out = { found: null, flags: 0, exif: false, xmp: false };
  for (let p = 12; p + 8 <= b.length; ) {
    const type = latin1(b, p, p + 4);
    const len = le32(b, p + 4);
    const s = p + 8;
    const e = Math.min(b.length, s + len);
    if (type === "VP8X" && p === 12 && s < b.length) out.flags = b[s];
    if (type === "EXIF") {
      out.exif ||= s + len <= b.length;
      if (exifHasPosition(b, s, e)) return { ...out, found: "exif_gps" };
    }
    if (type === "XMP ") {
      out.xmp ||= s + len <= b.length;
      if (xmpHasLocation(latin1(b, s, e))) return { ...out, found: "xmp_location" };
    }
    p = s + len + (len % 2);
  }
  return out;
}

function webpFinds(b) {
  return isWebp(b) ? webpWalk(b).found : null;
}

/**
 * The last bytes of a WebP, read on their own: chunk boundaries are unknown there, so every "EXIF" and "XMP " header whose
 * length fits is tried (at most MAX_EXIF_HEADERS EXIF ones), then the generic scans. Same result shape as webpWalk.
 */
function webpTailWalk(t) {
  const out = { found: null, exif: false, xmp: false };
  let headers = 0;
  for (let i = indexOf(t, "EXIF"); i !== -1 && i + 8 <= t.length; i = indexOf(t, "EXIF", i + 1)) {
    const s = i + 8;
    const len = le32(t, i + 4);
    if (s + len > t.length) continue;
    if (++headers > MAX_EXIF_HEADERS) return { ...out, found: "exif_gps" };
    out.exif = true;
    if (exifHasPosition(t, s, s + len)) return { ...out, found: "exif_gps" };
  }
  for (let i = indexOf(t, "XMP "); i !== -1 && i + 8 <= t.length && !out.xmp; i = indexOf(t, "XMP ", i + 1)) {
    out.xmp = i + 8 + le32(t, i + 4) <= t.length; // its text is read by the generic scan below
  }
  return { ...out, found: generic(t) };
}

/** Any "Exif\0\0" followed by a TIFF header, wherever it sits (HEIC Exif items, unknown containers). */
function anyExifHasPosition(b) {
  let headers = 0;
  for (let i = indexOf(b, "Exif\0\0"); i !== -1; i = indexOf(b, "Exif\0\0", i + 1)) {
    if (++headers > MAX_EXIF_HEADERS) return true; // more than any file carries: fail closed
    if (tiffHasGpsPosition(b, i + 6, b.length)) return true;
  }
  return false;
}

/** The container-blind scans: any EXIF header, then XMP text anywhere. */
function generic(b) {
  if (anyExifHasPosition(b)) return "exif_gps";
  if (xmpHasLocation(latin1(b))) return "xmp_location";
  return null;
}

/**
 * What location metadata the bytes carry: "exif_gps", "xmp_location", "iptc_location", or null. Pure; for tests and callers
 * that already hold the bytes. Never logs.
 * @param {Uint8Array} bytes
 */
export function findLocation(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return jpegFinds(b) ?? pngFinds(b) ?? webpFinds(b) ?? generic(b);
}

/**
 * findLocation for a WebP whose head (the first LOCATION_BYTES) and tail (the last LOCATION_BYTES) were read apart. Beyond what
 * either read finds, a VP8X flag that promises an EXIF or XMP chunk neither read holds whole fails closed.
 */
export function findWebpLocation(head, tail) {
  const h = webpWalk(head);
  if (h.found) return h.found;
  const t = webpTailWalk(tail);
  if (t.found) return t.found;
  if (h.flags & VP8X_EXIF && !h.exif && !t.exif) return "exif_gps";
  if (h.flags & VP8X_XMP && !h.xmp && !t.xmp) return "xmp_location";
  return null;
}

let sharedS3;
const MISSING = new Set(["NoSuchKey", "NotFound", "AccessDenied", "InvalidRange"]);
const missing = () => new HttpError(400, "upload_missing", "that photo didn't finish uploading. add it again.");
const refused = () => new HttpError(400, "photo_has_location", "that photo still says where it was taken. we don't keep that on the site, so please share a copy without its location.");

async function getRange(client, bucket, key, range) {
  try {
    return await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    if (MISSING.has(e?.name) || MISSING.has(e?.Code) || status === 404 || status === 403 || status === 416) throw missing();
    throw e;
  }
}

/** The object's size from a ranged GetObject's Content-Range ("bytes 0-262143/<size>"), when S3 gives it. */
const totalSize = (contentRange) => {
  const m = /\/(\d+)\s*$/.exec(typeof contentRange === "string" ? contentRange : "");
  return m ? Number(m[1]) : undefined;
};

/**
 * GetObject Range bytes=0-262143 of s3://bucket/key and refuse it when it carries location metadata. A WebP whose data runs
 * past that read (the object's size by Content-Range, else the RIFF size) is read a second time, Range bytes=-262144, for the
 * EXIF and XMP chunks that follow its image data.
 *   400 photo_has_location  location found (see the header);
 *   400 upload_missing      no object (S3 answers 403 AccessDenied for a missing key without s3:ListBucket) or an empty one.
 * Resolves to `{ contentType }` (the stored Content-Type, for the caller's type check). `deps.s3` is injected by tests.
 */
export async function checkLocation(bucket, key, { s3 } = {}) {
  const client = s3 ?? (sharedS3 ??= new S3Client({}));
  const r = await getRange(client, bucket, key, LOCATION_RANGE);
  const read = await r.Body.transformToByteArray();
  if (read.length === 0) throw missing();
  const head = read.length > LOCATION_BYTES ? read.subarray(0, LOCATION_BYTES) : read;
  if (findLocation(head)) throw refused();
  if (isWebp(head) && (totalSize(r.ContentRange) ?? le32(head, 4) + 8) > head.length) {
    const tail = await (await getRange(client, bucket, key, TAIL_RANGE)).Body.transformToByteArray();
    if (findWebpLocation(head, tail.length > LOCATION_BYTES ? tail.subarray(tail.length - LOCATION_BYTES) : tail)) throw refused();
  }
  return { contentType: typeof r.ContentType === "string" ? r.ContentType : undefined };
}

/** How long a comment photo's HEAD may take before the write answers 503 instead of hanging on S3. */
export const HEAD_TIMEOUT_MS = 2000;

/**
 * HeadObject of s3://bucket/key (hfy-comments-photos-desc-api): resolves `{ contentType, size, etag? }`. `etag` is S3's quoted ETag of the
 * object as it was when read; graduation passes it as CopySourceIfMatch so the bytes it copies are the bytes it checked.
 *   400 upload_missing  no object (S3 answers 403 AccessDenied for a missing key without s3:ListBucket);
 *   503 unavailable     S3 failed or did not answer within `timeoutMs`.
 * `deps.s3` is injected by tests.
 */
export async function headUpload(bucket, key, { s3, timeoutMs = HEAD_TIMEOUT_MS } = {}) {
  const client = s3 ?? (sharedS3 ??= new S3Client({}));
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, "unavailable", "photos are unavailable, try again")), timeoutMs); });
  try {
    const r = await Promise.race([client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })), late]);
    return {
      contentType: typeof r.ContentType === "string" ? r.ContentType : undefined, size: typeof r.ContentLength === "number" ? r.ContentLength : undefined,
      ...(typeof r.ETag === "string" && r.ETag !== "" ? { etag: r.ETag } : {}),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const status = e?.$metadata?.httpStatusCode;
    if (MISSING.has(e?.name) || MISSING.has(e?.Code) || status === 404 || status === 403) throw missing();
    throw new HttpError(503, "unavailable", "photos are unavailable, try again");
  } finally {
    clearTimeout(timer);
  }
}
