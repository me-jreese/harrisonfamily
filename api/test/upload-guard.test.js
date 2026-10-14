// privacy-guard-existing-paths AC5: api/src/upload-guard.js checkLocation(bucket, key) over synthetic fixtures only.
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  LOCATION_RANGE, MAX_EXIF_HEADERS, TAIL_RANGE, XMP_MAX_INFLATED, XMP_MAX_PROPERTIES, checkLocation, findLocation, tiffHasGpsPosition,
  xmpHasLocation,
} from "../src/upload-guard.js";
import { SOME_LAT, SOME_LON, ZERO, heicLike, jpeg, png, tiff, webp, xmpPacket } from "./photo-fixtures.js";
import { CLEAN_JPEG, createFakeS3 } from "./world.js";

const GPS = tiff({ gps: { version: true, lat: SOME_LAT, lon: SOME_LON } });
const NO_GPS = tiff();
const VERSION_ONLY = tiff({ gps: { version: true } });
const ZEROS = tiff({ gps: { version: true, lat: ZERO, lon: ZERO } });

describe("EXIF GPS (IFD 0x8825) with a position", () => {
  it("reads little- and big-endian TIFF, RATIONAL and SRATIONAL, and destination coordinates", () => {
    expect(tiffHasGpsPosition(GPS)).toBe(true);
    expect(tiffHasGpsPosition(tiff({ le: false, gps: { lat: SOME_LAT, lon: SOME_LON } }))).toBe(true);
    expect(tiffHasGpsPosition(tiff({ gps: { lat: SOME_LAT }, srational: true }))).toBe(true);
    expect(tiffHasGpsPosition(tiff({ gps: { destLat: SOME_LAT, destLon: SOME_LON } }))).toBe(true);
  });
  it("no GPS IFD, a GPS IFD without a position, or an all-zero position is not a location", () => {
    for (const t of [NO_GPS, VERSION_ONLY, ZEROS]) expect(tiffHasGpsPosition(t)).toBe(false);
    expect(tiffHasGpsPosition(Uint8Array.from([1, 2, 3]))).toBe(false); // not a TIFF header
  });
  it("a GPS pointer outside the bytes read fails closed", () => {
    expect(tiffHasGpsPosition(tiff({ gps: { lat: SOME_LAT }, gpsAt: 900_000 }))).toBe(true);
  });
  it("finds it in a JPEG APP1, a PNG eXIf (with or without the Exif prefix), a WebP EXIF chunk and a HEIC Exif item", () => {
    expect(findLocation(jpeg({ exif: GPS }))).toBe("exif_gps");
    expect(findLocation(png({ exif: GPS }))).toBe("exif_gps");
    expect(findLocation(png({ exif: GPS, exifPrefix: true }))).toBe("exif_gps");
    expect(findLocation(webp({ exif: GPS }))).toBe("exif_gps");
    expect(findLocation(webp({ exif: GPS, exifPrefix: true }))).toBe("exif_gps");
    expect(findLocation(heicLike({ exif: GPS }))).toBe("exif_gps");
  });
  it("the same containers without a position pass", () => {
    for (const exif of [NO_GPS, VERSION_ONLY, ZEROS]) {
      expect(findLocation(jpeg({ exif }))).toBe(null);
      expect(findLocation(png({ exif }))).toBe(null);
      expect(findLocation(webp({ exif }))).toBe(null);
      expect(findLocation(heicLike({ exif }))).toBe(null);
    }
    expect(findLocation(CLEAN_JPEG)).toBe(null);
    expect(findLocation(jpeg())).toBe(null);
    expect(findLocation(png())).toBe(null);
    expect(findLocation(webp())).toBe(null);
  });
});

describe("XMP exif:GPS*, photoshop:City/State, Iptc4xmpCore:Location", () => {
  const cases = [
    ['exif:GPSLatitude="12,34.5N"', "attribute GPSLatitude"],
    ['exif:GPSAltitude="120/1"', "any exif:GPS* property"],
    ['photoshop:City="Example City"', "photoshop:City"],
    ['photoshop:State="Example State"', "photoshop:State"],
    ['Iptc4xmpCore:Location="Example Park"', "Iptc4xmpCore:Location"],
  ];
  for (const [attr, label] of cases) {
    it(`refuses ${label} (attribute form) in JPEG, PNG, WebP and HEIC`, () => {
      const x = xmpPacket({ attrs: attr });
      expect(xmpHasLocation(x)).toBe(true);
      for (const bytes of [jpeg({ xmp: x }), png({ xmp: x }), png({ xmp: x, compressXmp: true }), webp({ xmp: x }), heicLike({ xmp: x })]) {
        expect(findLocation(bytes)).toBe("xmp_location");
      }
    });
  }
  it("reads the element form and a non-standard prefix bound to the namespace", () => {
    expect(xmpHasLocation(xmpPacket({ children: "<photoshop:City>Example City</photoshop:City>" }))).toBe(true);
    expect(xmpHasLocation(xmpPacket({ children: "<exif:GPSLongitude>98,7.65E</exif:GPSLongitude>" }))).toBe(true);
    expect(xmpHasLocation(xmpPacket({ ns: 'xmlns:e="http://ns.adobe.com/exif/1.0/"', attrs: 'e:GPSLatitude="12,34.5N"' }))).toBe(true);
    expect(xmpHasLocation(xmpPacket({ ns: 'xmlns:ps="http://ns.adobe.com/photoshop/1.0/"', children: "<ps:State>Example State</ps:State>" }))).toBe(true);
  });
  it("empty values, GPSVersionID alone and other properties are not a location", () => {
    for (const p of [
      xmpPacket({ attrs: 'photoshop:City="" photoshop:State="  "' }),
      xmpPacket({ attrs: 'exif:GPSVersionID="2.3.0.0"' }),
      xmpPacket({ attrs: 'exif:DateTimeOriginal="2001-02-03T04:05:06" photoshop:Country="Example Land"' }),
      xmpPacket({ children: "<Iptc4xmpCore:Location></Iptc4xmpCore:Location>" }),
    ]) {
      expect(xmpHasLocation(p)).toBe(false);
      expect(findLocation(jpeg({ xmp: p }))).toBe(null);
    }
  });
});

describe("IPTC IIM in a JPEG APP13 (the binary twins of photoshop:City/State)", () => {
  it("refuses City, Sub-location and Province/State; passes other records and empty values", () => {
    for (const ds of [90, 92, 95]) expect(findLocation(jpeg({ iptc: [[2, ds, "Example Place"]] }))).toBe("iptc_location");
    expect(findLocation(jpeg({ iptc: [[2, 5, "Example Title"], [2, 90, ""]] }))).toBe(null);
  });
});

describe("checkLocation(bucket, key)", () => {
  const s3With = (bytes, contentType = "image/jpeg") => createFakeS3(new Map([["uploads/posts/K/photo.jpg", { bytes, contentType }]]));

  it("reads only bytes=0-262143 with GetObject and resolves the stored content type", async () => {
    const s3 = s3With(jpeg({ exif: NO_GPS }));
    await expect(checkLocation("bucket-x", "uploads/posts/K/photo.jpg", { s3 })).resolves.toEqual({ contentType: "image/jpeg" });
    expect(s3.gets).toEqual([{ Bucket: "bucket-x", Key: "uploads/posts/K/photo.jpg", Range: LOCATION_RANGE }]);
    expect(LOCATION_RANGE).toBe("bytes=0-262143");
  });
  it("400 photo_has_location for each kind of location, with a message that names nothing found", async () => {
    for (const bytes of [jpeg({ exif: GPS }), png({ exif: GPS }), webp({ exif: GPS }), jpeg({ xmp: xmpPacket({ attrs: 'photoshop:City="Example City"' }) }), jpeg({ iptc: [[2, 90, "Example City"]] })]) {
      const e = await checkLocation("b", "uploads/posts/K/photo.jpg", { s3: s3With(bytes) }).catch((x) => x);
      expect(e).toMatchObject({ status: 400, code: "photo_has_location" });
      expect(e.message).not.toMatch(/example|12|34|city/i);
    }
  });
  it("metadata past the first 256 KiB of a JPEG, PNG or HEIC is outside the read (the range is the contract; HEIC is the known gap)", async () => {
    const late = new Uint8Array(300_000);
    late.set(CLEAN_JPEG.subarray(0, 2));
    late.set(heicLike({ exif: GPS, filler: 0 }), 280_000);
    expect(findLocation(late)).toBe("exif_gps"); // found when the whole file is scanned...
    await expect(checkLocation("b", "uploads/posts/K/photo.jpg", { s3: s3With(late) })).resolves.toBeTruthy(); // ...but not inside the range read
  });
  it("400 upload_missing for a missing (403 AccessDenied or 404) or empty object; other S3 errors pass through", async () => {
    await expect(checkLocation("b", "nope", { s3: createFakeS3() })).rejects.toMatchObject({ status: 400, code: "upload_missing" });
    const notFound = { send: async () => { throw Object.assign(new Error("x"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }); } };
    await expect(checkLocation("b", "k", { s3: notFound })).rejects.toMatchObject({ code: "upload_missing" });
    await expect(checkLocation("b", "uploads/posts/K/photo.jpg", { s3: s3With(new Uint8Array(0)) })).rejects.toMatchObject({ code: "upload_missing" });
    const down = { send: async () => { throw Object.assign(new Error("x"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }); } };
    await expect(checkLocation("b", "k", { s3: down })).rejects.toMatchObject({ name: "SlowDown" });
  });
});

describe("a WebP larger than the first read: its EXIF and XMP chunks follow the image data (HFY-TSK-240 review)", () => {
  const KEY = "uploads/posts/K/photo.webp";
  const s3With = (bytes) => createFakeS3(new Map([[KEY, { bytes, contentType: "image/webp" }]]));
  const BIG = 300 * 1024;
  const check = (s3) => checkLocation("b", KEY, { s3 }).catch((e) => e);

  it("reads the last 256 KiB too, and refuses EXIF GPS (with or without the Exif prefix) or XMP location found there", async () => {
    for (const bytes of [
      webp({ imageBytes: BIG, exif: GPS }),
      webp({ imageBytes: BIG, exif: GPS, exifPrefix: true }),
      webp({ imageBytes: BIG, xmp: xmpPacket({ attrs: 'photoshop:City="Example City"' }) }),
      webp({ imageBytes: 9 * 1024 * 1024, exif: GPS }),
    ]) {
      expect(bytes.length).toBeGreaterThan(262144);
      const s3 = s3With(bytes);
      expect(await check(s3)).toMatchObject({ status: 400, code: "photo_has_location" });
      expect(s3.gets.map((g) => g.Range)).toEqual([LOCATION_RANGE, TAIL_RANGE]);
    }
    expect(TAIL_RANGE).toBe("bytes=-262144");
  });
  it("accepts a large WebP whose trailing EXIF and XMP carry no location", async () => {
    const s3 = s3With(webp({ imageBytes: BIG, exif: NO_GPS, xmp: xmpPacket({ attrs: 'exif:GPSVersionID="2.3.0.0"' }) }));
    await expect(checkLocation("b", KEY, { s3 })).resolves.toEqual({ contentType: "image/webp" });
    expect(s3.gets).toHaveLength(2);
  });
  it("fails closed when the VP8X flags promise an EXIF or XMP chunk that neither read holds whole", async () => {
    const hidden = { imageBytes: BIG, trailer: BIG };
    expect(await check(s3With(webp({ ...hidden, exif: NO_GPS })))).toMatchObject({ code: "photo_has_location" });
    expect(await check(s3With(webp({ ...hidden, xmp: xmpPacket() })))).toMatchObject({ code: "photo_has_location" });
    // Without the flags nothing says the chunk is there: the middle of the file is not read (the documented residual).
    await expect(checkLocation("b", KEY, { s3: s3With(webp({ ...hidden, exif: GPS, flags: 0 })) })).resolves.toBeTruthy();
  });
  it("uses the RIFF size when S3 gives no Content-Range", async () => {
    const real = s3With(webp({ imageBytes: BIG, exif: GPS }));
    const s3 = { gets: real.gets, send: async (cmd) => ({ ...(await real.send(cmd)), ContentRange: undefined }) };
    expect(await check(s3)).toMatchObject({ code: "photo_has_location" });
    expect(s3.gets.map((g) => g.Range)).toEqual([LOCATION_RANGE, TAIL_RANGE]);
  });
  it("reads once when the file fits in the first read, and never reads the tail of other formats", async () => {
    const small = s3With(webp({ imageBytes: 1024, exif: NO_GPS }));
    await expect(checkLocation("b", KEY, { s3: small })).resolves.toBeTruthy();
    expect(small.gets).toHaveLength(1);
    const late = new Uint8Array(300_000);
    late.set(CLEAN_JPEG.subarray(0, 2));
    const jpg = createFakeS3(new Map([[KEY, { bytes: late, contentType: "image/jpeg" }]]));
    await expect(checkLocation("b", KEY, { s3: jpg })).resolves.toBeTruthy();
    expect(jpg.gets).toHaveLength(1);
  });
  it("a missing object at the second read is upload_missing", async () => {
    const real = s3With(webp({ imageBytes: BIG, exif: NO_GPS }));
    const s3 = { send: async (cmd) => (cmd.input.Range === TAIL_RANGE ? real.send({ ...cmd, input: { ...cmd.input, Key: "gone" }, constructor: cmd.constructor }) : real.send(cmd)) };
    expect(await check(s3)).toMatchObject({ status: 400, code: "upload_missing" });
  });
});

describe("bounded work: any member can upload, so no bytes may cost more than linear time or a fixed amount of memory (HFY-TSK-240 review)", () => {
  const FAST_MS = 750;
  const timed = (fn) => {
    const t0 = performance.now();
    const r = fn();
    return [r, performance.now() - t0];
  };
  const NS = 'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ';
  const fill = (unit, n = 1 << 20) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  it("compressed XMP inflates to at most XMP_MAX_INFLATED in all; past it the photo is refused (fail closed)", () => {
    const bomb = png({ xmp: NS + fill("A", 4 * XMP_MAX_INFLATED), compressXmp: true });
    expect(bomb.length).toBeLessThan(262144);
    expect(findLocation(bomb)).toBe("xmp_location");
    expect(findLocation(png({ xmp: xmpPacket({ attrs: 'dc:format="image/png"' }) + fill(" ", XMP_MAX_INFLATED - 1024), compressXmp: true }))).toBe(null);
  });
  it("the budget spans every compressed chunk of the file", () => {
    const half = xmpPacket() + fill(" ", XMP_MAX_INFLATED / 2 + 1024);
    const one = png({ xmp: half, compressXmp: true });
    expect(findLocation(one)).toBe(null);
    const [sig, ihdr] = [one.subarray(0, 8), one.subarray(8, 33)];
    const itxt = one.subarray(33, one.length - 12 - 21);
    const two = Uint8Array.from([...sig, ...ihdr, ...itxt, ...itxt, ...one.subarray(one.length - 12 - 21)]);
    expect(findLocation(two)).toBe("xmp_location");
  });
  it("a compressed XMP cut short by the read is scanned as far as it goes", () => {
    const full = png({ xmp: xmpPacket({ attrs: 'photoshop:City="Example City"' }) + fill(" ", 400_000), compressXmp: true });
    const cut = full.subarray(0, full.length - 12 - 21 - 4 - 64); // IEND, IDAT, the iTXt CRC and the stream's last 64 bytes gone
    expect(() => inflateSync(cut.subarray(33 + 8 + 22))).toThrow(); // what a plain inflate made of it: nothing
    expect(findLocation(cut)).toBe("xmp_location");
  });
  it("the reviewer's 2 KiB PNG whose XMP inflates to 1.1 MB of unclosed <exif:GPSa> is refused at once", () => {
    const [r, ms] = timed(() => findLocation(png({ xmp: `xmlns:exif ${"<exif:GPSa>".repeat(100_000)}`, compressXmp: true })));
    expect(r).toBe("xmp_location");
    expect(ms).toBeLessThan(FAST_MS);
  });
  it("XMP texts built to make the old regexes quadratic finish in linear time", () => {
    for (const [text, want] of [
      [`${NS}<exif:GPSAltitude>${"<".repeat(60_000)}</exif:GPSAltitude>`, true], // was 1.7 s: /<[^>]*>/g over a run of "<"
      [Array.from({ length: 5_000 }, (_, i) => `xmlns:p${i}="http://ns.adobe.com/exif/1.0/" `).join("") + fill(' p1:GPSVersionID="2"', 32_768), false], // was O(prefixes x length)
      [NS + fill(' dc:title="'), false],
      [NS + fill("<"), false],
      [NS + fill(' exif:GPSVersionID="2.3.0.0"'), false],
      [`xmlns:exif${" ".repeat(1 << 20)}x`, false],
    ]) {
      const [r, ms] = timed(() => xmpHasLocation(text));
      expect(r).toBe(want);
      expect(ms).toBeLessThan(FAST_MS);
    }
  });
  it("an unterminated location value, or more location properties than XMP_MAX_PROPERTIES, fails closed", () => {
    expect(xmpHasLocation(`${NS}<rdf:Description photoshop:City="Example`)).toBe(true);
    expect(xmpHasLocation(`${NS}<photoshop:City>Example`)).toBe(true);
    expect(xmpHasLocation(`${NS}<rdf:Description dc:title="Example`)).toBe(false);
    expect(xmpHasLocation(`${NS}<photoshop:City/><photoshop:State rdf:parseType="Resource"/>`)).toBe(false);
    expect(xmpHasLocation(NS + ' photoshop:City=""'.repeat(XMP_MAX_PROPERTIES))).toBe(false);
    expect(xmpHasLocation(NS + ' photoshop:City=""'.repeat(XMP_MAX_PROPERTIES + 1))).toBe(true);
  });
  it("more Exif headers than MAX_EXIF_HEADERS fails closed; up to it, each is read", () => {
    const headers = (n) => {
      const one = [...Array.from("Exif\0\0", (c) => c.charCodeAt(0)), ...NO_GPS];
      return Uint8Array.from([0, 0, 0, 0, ...Array.from({ length: n }, () => one).flat()]);
    };
    expect(findLocation(headers(MAX_EXIF_HEADERS))).toBe(null);
    const [r, ms] = timed(() => findLocation(headers(Math.floor(200_000 / (6 + NO_GPS.length)))));
    expect(r).toBe("exif_gps");
    expect(ms).toBeLessThan(FAST_MS);
  });
});
