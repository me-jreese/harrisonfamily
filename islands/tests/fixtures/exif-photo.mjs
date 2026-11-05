// Synthetic photo fixtures for comment-photos.spec.mjs (HFY-TSK-187). Nothing here is a real photo or a real place.
//  - withExif(jpeg): the same JPEG with an APP1 Exif segment after SOI that says orientation 6 (rotate 90 degrees clockwise to view it) and
//    carries a GPS IFD (latitude, longitude: invented numbers), so a test can prove the browser re-encode drops both.
//  - inspectJpeg(bytes): what is inside a JPEG file, read from its marker segments: the markers before the scan, whether an APP1 or an
//    "Exif" tag exists, and the frame size (SOF).

const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const entry = (tag, type, count, value4) => [...u16(tag), ...u16(type), ...u32(count), ...value4];
const rationals = (list) => list.flatMap(([n, d]) => [...u32(n), ...u32(d)]);

export function exifApp1() {
  const gpsAt = 8 + 2 + 2 * 12 + 4; // after IFD0 (count, 2 entries, next offset)
  const gpsEnd = gpsAt + 2 + 4 * 12 + 4;
  const ifd0 = [...u16(2), ...entry(0x0112, 3, 1, [...u16(6), 0, 0]), ...entry(0x8825, 4, 1, u32(gpsAt)), ...u32(0)];
  const gps = [
    ...u16(4),
    ...entry(0x0001, 2, 2, [0x4e, 0, 0, 0]), // GPSLatitudeRef "N"
    ...entry(0x0002, 5, 3, u32(gpsEnd)), // GPSLatitude
    ...entry(0x0003, 2, 2, [0x45, 0, 0, 0]), // GPSLongitudeRef "E"
    ...entry(0x0004, 5, 3, u32(gpsEnd + 24)), // GPSLongitude
    ...u32(0),
  ];
  const data = [...rationals([[10, 1], [20, 1], [30, 1]]), ...rationals([[40, 1], [50, 1], [0, 1]])];
  const tiff = [0x49, 0x49, 0x2a, 0, ...u32(8), ...ifd0, ...gps, ...data];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF
  const len = payload.length + 2;
  return Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

/** `jpeg` (a Buffer starting with SOI) with the Exif APP1 above inserted right after SOI. */
export function withExif(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  return Buffer.concat([jpeg.subarray(0, 2), exifApp1(), jpeg.subarray(2)]);
}

export function inspectJpeg(bytes) {
  const b = Buffer.from(bytes);
  const out = { jpeg: b[0] === 0xff && b[1] === 0xd8, markers: [], app1: 0, exif: false, orientationTag: false, gpsTag: false, width: 0, height: 0 };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    out.markers.push(m.toString(16).toUpperCase());
    if (m === 0xda) break; // start of scan: the entropy-coded data follows
    const len = (b[i + 2] << 8) | b[i + 3];
    const body = b.subarray(i + 4, i + 2 + len);
    if (m === 0xe1) {
      out.app1 += 1;
      if (body.subarray(0, 4).toString("latin1") === "Exif") {
        out.exif = true;
        // Tag ids in the TIFF directory: 0x0112 orientation, 0x8825 GPS pointer (little endian here).
        for (let k = 6 + 10; k + 12 <= body.length; k += 1) {
          if (body[k] === 0x12 && body[k + 1] === 0x01) out.orientationTag = true;
          if (body[k] === 0x25 && body[k + 1] === 0x88) out.gpsTag = true;
        }
      }
    }
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb)) {
      out.height = (body[1] << 8) | body[2];
      out.width = (body[3] << 8) | body[4];
    }
    i += 2 + len;
  }
  return out;
}
