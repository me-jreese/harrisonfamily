// Synthetic photo containers for upload-guard.js (privacy-guard-existing-paths AC5). Built byte by byte: no real photo, place or
// person; coordinates and place names are made up (12°34' and "Example City").
import { crc32, deflateSync } from "node:zlib";

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u16 = (le, v) => (le ? [v & 255, (v >> 8) & 255] : [(v >> 8) & 255, v & 255]);
const u32 = (le, v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
const be16 = (v) => u16(false, v);
const be32 = (v) => u32(false, v);
const le32 = (v) => u32(true, v);

export const SOME_LAT = [[12, 1], [34, 1], [5600, 100]];
export const SOME_LON = [[98, 1], [7, 1], [6500, 100]];
export const ZERO = [[0, 1], [0, 1], [0, 1]];

/**
 * A TIFF (EXIF) structure. `gps`: null for no GPS pointer, or { version, lat, lon, destLat, destLon } where each coordinate is
 * three [num, den] rationals; `gpsAt` overrides the pointer value (to point outside the data); `srational` writes type 10.
 */
export function tiff({ le = true, gps = null, gpsAt, srational = false, make = "SyntheticCam" } = {}) {
  const head = [...ascii(le ? "II" : "MM"), ...u16(le, 42), ...u32(le, 8)];
  const ifd0 = [];
  const makeBytes = [...ascii(make), 0];
  const ifd0Entries = 1 + (gps ? 1 : 0);
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const gpsTags = gps ? [
    ...(gps.version ? [[0x0000, 1, 4, [2, 3, 0, 0]]] : []),
    ...(gps.lat ? [[0x0001, 2, 2, [...ascii("N"), 0, 0, 0]], [0x0002, srational ? 10 : 5, 3, gps.lat]] : []),
    ...(gps.lon ? [[0x0003, 2, 2, [...ascii("E"), 0, 0, 0]], [0x0004, srational ? 10 : 5, 3, gps.lon]] : []),
    ...(gps.destLat ? [[0x0014, 5, 3, gps.destLat]] : []),
    ...(gps.destLon ? [[0x0016, 5, 3, gps.destLon]] : []),
  ] : [];
  const gpsIfdAt = 8 + ifd0Size;
  const gpsSize = gps ? 2 + gpsTags.length * 12 + 4 : 0;
  let dataAt = gpsIfdAt + gpsSize;
  const data = [];
  const place = (bytes) => { const at = dataAt + data.length; data.push(...bytes); return at; };
  const makeAt = place(makeBytes);
  ifd0.push(...u16(le, ifd0Entries));
  ifd0.push(...u16(le, 0x010f), ...u16(le, 2), ...u32(le, makeBytes.length), ...u32(le, makeAt));
  if (gps) ifd0.push(...u16(le, 0x8825), ...u16(le, 4), ...u32(le, 1), ...u32(le, gpsAt ?? gpsIfdAt));
  ifd0.push(...u32(le, 0));
  const gpsIfd = [];
  if (gps) {
    gpsIfd.push(...u16(le, gpsTags.length));
    for (const [tag, type, count, value] of gpsTags) {
      gpsIfd.push(...u16(le, tag), ...u16(le, type), ...u32(le, count));
      if (type === 5 || type === 10) gpsIfd.push(...u32(le, place(value.flatMap(([n, d]) => [...u32(le, n), ...u32(le, d)]))));
      else gpsIfd.push(...value);
    }
    gpsIfd.push(...u32(le, 0));
  }
  return Uint8Array.from([...head, ...ifd0, ...gpsIfd, ...data]);
}

const segment = (marker, payload) => [0xff, marker, ...be16(payload.length + 2), ...payload];
const SCAN = [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0x56, 0xff, 0xd9];
const JFIF = segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

/** JPEG with optional EXIF (APP1 Exif), XMP (APP1 xap) and IPTC (APP13 Photoshop) segments before the scan. */
export function jpeg({ exif, xmp, iptc } = {}) {
  return Uint8Array.from([
    0xff, 0xd8, ...JFIF,
    ...(exif ? segment(0xe1, [...ascii("Exif\0\0"), ...exif]) : []),
    ...(xmp ? segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/\0"), ...ascii(xmp)]) : []),
    ...(iptc ? segment(0xed, photoshopIptc(iptc)) : []),
    ...SCAN,
  ]);
}

/** A Photoshop 3.0 resource block holding an IPTC-NAA (0x0404) resource with the given [record, dataset, value] fields. */
function photoshopIptc(fields) {
  const iim = fields.flatMap(([rec, ds, value]) => [0x1c, rec, ds, ...be16(value.length), ...ascii(value)]);
  return [...ascii("Photoshop 3.0\0"), ...ascii("8BIM"), ...be16(0x0404), 0, 0, ...be32(iim.length), ...iim, ...(iim.length % 2 ? [0] : [])];
}

const chunk = (type, payload) => [...be32(payload.length), ...ascii(type), ...payload, ...be32(crc32(Buffer.from([...ascii(type), ...payload])))];
const IHDR = chunk("IHDR", [...be32(1), ...be32(1), 8, 2, 0, 0, 0]);

/** PNG with optional eXIf (raw TIFF, or with the "Exif\0\0" prefix) and an XMP iTXt chunk (plain or zlib-compressed). */
export function png({ exif, exifPrefix = false, xmp, compressXmp = false } = {}) {
  const itxt = xmp === undefined ? [] : chunk("iTXt", [
    ...ascii("XML:com.adobe.xmp"), 0, compressXmp ? 1 : 0, 0, 0, 0,
    ...(compressXmp ? [...deflateSync(Buffer.from(xmp, "latin1"))] : ascii(xmp)),
  ]);
  return Uint8Array.from([
    0x89, ...ascii("PNG\r\n\x1a\n"), ...IHDR,
    ...(exif ? chunk("eXIf", [...(exifPrefix ? ascii("Exif\0\0") : []), ...exif]) : []),
    ...itxt,
    ...chunk("IDAT", [0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1]),
    ...chunk("IEND", []),
  ]);
}

const riff = (type, payload) => [...ascii(type), ...le32(payload.length), ...payload, ...(payload.length % 2 ? [0] : [])];

/**
 * WebP (extended format) in the spec's order: VP8X, the image, then optional EXIF and XMP chunks, then `trailer` bytes of an
 * unknown "ZZZZ" chunk. `imageBytes` sizes the image chunk (past 256 KiB, the metadata lands after the first read). The VP8X
 * flags say which metadata chunks follow, unless `flags` overrides them.
 */
export function webp({ exif, exifPrefix = false, xmp, imageBytes = 5, trailer = 0, flags } = {}) {
  const parts = [
    Uint8Array.from(ascii("WEBP")),
    Uint8Array.from(riff("VP8X", [flags ?? ((exif ? 0x08 : 0) | (xmp ? 0x04 : 0)), 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    riffBig("VP8L", imageBytes, 0x2f),
    ...(exif ? [Uint8Array.from(riff("EXIF", [...(exifPrefix ? ascii("Exif\0\0") : []), ...exif]))] : []),
    ...(xmp ? [Uint8Array.from(riff("XMP ", ascii(xmp)))] : []),
    ...(trailer ? [riffBig("ZZZZ", trailer, 0x5a)] : []),
  ];
  return concat([Uint8Array.from([...ascii("RIFF"), ...le32(parts.reduce((n, x) => n + x.length, 0))]), ...parts]);
}

/** A RIFF chunk of `n` bytes, the first `first` and the rest a filler pattern (built as a typed array: n can be large). */
function riffBig(type, n, first) {
  const out = new Uint8Array(8 + n + (n % 2));
  out.set(ascii(type), 0);
  out.set(le32(n), 4);
  for (let i = 0; i < n; i += 1) out[8 + i] = i === 0 ? first : (i * 37) & 0xff;
  return out;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
};

/** An ISOBMFF (HEIC-like) file: ftyp, filler, then an Exif item payload (offset word, "Exif\0\0", TIFF) as HEIF stores it. */
export function heicLike({ exif, xmp, filler = 4096 } = {}) {
  const ftyp = [...be32(24), ...ascii("ftypheic"), ...be32(0), ...ascii("mif1heic")];
  return Uint8Array.from([
    ...ftyp, ...Array.from({ length: filler }, (_, i) => (i * 37) & 0xff),
    ...(exif ? [...be32(6), ...ascii("Exif\0\0"), ...exif] : []),
    ...(xmp ? ascii(xmp) : []),
  ]);
}

/** An XMP packet with the given rdf:Description attributes and child elements (strings of XML). */
export function xmpPacket({ attrs = "", children = "", ns = 'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"' } = {}) {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ${ns} ${attrs}>${children}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
