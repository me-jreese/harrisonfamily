// HFY-TSK-187 (BRD2 9.3): the browser JPEG normalization and the photo upload path, with the browser's decoder and canvas faked. The real
// bytes (orientation 6, GPS EXIF in, upright JPEG without EXIF out) are inspected in a browser by comment-photos.spec.mjs.
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JPEG_QUALITY, MAX_LONG_EDGE, PHOTO_ACCEPT, PHOTO_COPY, PhotoDecodeError, fitLongEdge, normalizePhoto, normalizePhotoDetailed } from "../src/lib/photo.js";
import { PURPOSES, UPLOAD_FILENAME, uploadPhoto } from "../src/lib/upload.js";

test("fitLongEdge keeps a small photo and scales a big one so the long edge is at most 2560", () => {
  assert.deepEqual(fitLongEdge(1200, 800), { width: 1200, height: 800 });
  assert.deepEqual(fitLongEdge(2560, 2560), { width: 2560, height: 2560 }, "exactly at the limit is untouched");
  assert.deepEqual(fitLongEdge(5120, 2560), { width: 2560, height: 1280 });
  assert.deepEqual(fitLongEdge(3000, 4000), { width: 1920, height: 2560 }, "portrait: the height is the long edge");
  const { width, height } = fitLongEdge(100000, 3);
  assert.equal(width, MAX_LONG_EDGE);
  assert.ok(height >= 1, "a sliver never rounds to zero");
  assert.equal(MAX_LONG_EDGE, 2560);
  assert.equal(JPEG_QUALITY, 0.85);
});

test("the picker accepts jpeg, png and webp and not heic (iOS then hands over a JPEG)", () => {
  assert.equal(PHOTO_ACCEPT, "image/jpeg,image/png,image/webp");
});

// A decoder and a canvas that record what they were asked, standing in for createImageBitmap and <canvas>.
function fakes({ width = 4000, height = 3000, fail = false, blob } = {}) {
  const log = { bitmapOpts: null, canvas: null, closed: false, encoded: null };
  const bitmap = { width, height, close: () => { log.closed = true; } };
  const makeCanvas = () => {
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage: (...a) => { log.drawn = a.slice(1); }, set fillStyle(v) { log.fill = v; } }),
      toBlob: (cb, type, quality) => { log.encoded = { type, quality, width: canvas.width, height: canvas.height }; cb(blob === undefined ? new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }) : blob); },
    };
    log.canvas = canvas;
    return canvas;
  };
  const createBitmap = async (file, opts) => { log.bitmapOpts = opts; if (fail) throw new DOMException("no decoder", "InvalidStateError"); return bitmap; };
  return { log, deps: { createBitmap, makeCanvas } };
}

test("normalizePhoto decodes with the EXIF orientation applied, scales to 2560, and encodes image/jpeg at 0.85", async () => {
  const { log, deps } = fakes({ width: 4000, height: 3000 });
  const { file, width, height } = await normalizePhotoDetailed(new Blob(["x"], { type: "image/heic" }), deps);
  assert.deepEqual(log.bitmapOpts, { imageOrientation: "from-image" });
  assert.deepEqual({ width, height }, { width: 2560, height: 1920 });
  assert.deepEqual(log.encoded, { type: "image/jpeg", quality: 0.85, width: 2560, height: 1920 });
  assert.deepEqual(log.drawn, [0, 0, 2560, 1920]);
  assert.equal(file.type, "image/jpeg");
  assert.equal(file.name, "photo.jpg", "the file's own name never survives");
  assert.ok(log.closed, "the bitmap is released");
  assert.equal((await normalizePhoto(new Blob(["x"]), fakes().deps)).type, "image/jpeg");
});

test("a photo that cannot be decoded or encoded raises PhotoDecodeError with the E10 copy and never the file name", async () => {
  for (const f of [fakes({ fail: true }), fakes({ blob: null }), fakes({ width: 0, height: 0 })]) {
    await assert.rejects(normalizePhoto({ name: "Birthday At Aunt Sue.heic", type: "image/heic" }, f.deps), (e) => {
      assert.ok(e instanceof PhotoDecodeError);
      assert.equal(e.code, "photo_decode");
      assert.equal(e.message, "that photo type didn't work here. try a jpeg or a screenshot.");
      assert.equal(e.message, PHOTO_COPY.decode);
      assert.doesNotMatch(String(e.message) + String(e.cause?.message ?? ""), /aunt|birthday/i);
      return true;
    });
  }
});

// ---- uploadPhoto ----------------------------------------------------------------------------------------------------------------
const norm = async () => ({ file: new File([new Uint8Array(7)], "photo.jpg", { type: "image/jpeg" }), width: 800, height: 600 });
function world({ puts = [200] } = {}) {
  const w = { presigns: [], puts: [], n: 0 };
  w.api = { post: async (path, body) => { assert.equal(path, "/uploads"); w.presigns.push(body); w.n += 1; return { uploadUrl: `https://s3.test/put-${w.n}`, publicUrl: `https://harrisonfamily.us/uploads/${body.purpose === "comment" ? "comments" : "posts"}/01J00000000000000000000${w.n}/photo.jpg` }; } };
  w.fetchImpl = async (url, init) => { w.puts.push({ url, init }); const status = puts[Math.min(w.puts.length - 1, puts.length - 1)]; return { ok: status < 400, status }; };
  return w;
}

test("uploadPhoto({purpose: comment}) normalizes, presigns purpose comment, PUTs the JPEG and returns the same-origin path with the size", async () => {
  const w = world();
  const att = await uploadPhoto(w.api, { name: "Birthday At Aunt Sue.heic", type: "image/heic", size: 999 }, { purpose: "comment", fetchImpl: w.fetchImpl, normalizeImpl: norm });
  assert.deepEqual(w.presigns, [{ filename: UPLOAD_FILENAME, contentType: "image/jpeg", size: 7, purpose: "comment" }], "the normalized JPEG's type and size, never the picked file's");
  assert.doesNotMatch(JSON.stringify(w.presigns), /aunt|birthday/i);
  assert.equal(w.puts[0].init.body.type, "image/jpeg");
  assert.deepEqual(att, { kind: "image", url: "/uploads/comments/01J000000000000000000001/photo.jpg", mime: "image/jpeg", width: 800, height: 600 });
});

test("a 403 from S3 re-presigns once and retries the PUT; a second 403 is the error", async () => {
  const w = world({ puts: [403, 200] });
  const att = await uploadPhoto(w.api, { type: "image/jpeg", size: 1 }, { purpose: "comment", fetchImpl: w.fetchImpl, normalizeImpl: norm });
  assert.equal(w.presigns.length, 2, "presigned again");
  assert.deepEqual(w.puts.map((p) => p.url), ["https://s3.test/put-1", "https://s3.test/put-2"], "the retry goes to the fresh url");
  assert.match(att.url, /01J000000000000000000002/, "the attachment is the second upload");
  const bad = world({ puts: [403, 403, 200] });
  await assert.rejects(uploadPhoto(bad.api, { type: "image/jpeg", size: 1 }, { purpose: "comment", fetchImpl: bad.fetchImpl, normalizeImpl: norm }), (e) => e.status === 403 && /HTTP 403/.test(e.message));
  assert.equal(bad.presigns.length, 2, "never a third presign");
  assert.equal(bad.puts.length, 2);
  const other = world({ puts: [500] });
  await assert.rejects(uploadPhoto(other.api, { type: "image/jpeg", size: 1 }, { purpose: "comment", fetchImpl: other.fetchImpl, normalizeImpl: norm }), (e) => e.status === 500);
  assert.equal(other.presigns.length, 1, "only a 403 is retried");
});

test("a decode failure stops before anything is presigned or sent", async () => {
  const w = world();
  const failing = async () => { throw new PhotoDecodeError(); };
  await assert.rejects(uploadPhoto(w.api, { type: "image/heic", size: 1 }, { purpose: "comment", fetchImpl: w.fetchImpl, normalizeImpl: failing }), PhotoDecodeError);
  assert.deepEqual([w.presigns.length, w.puts.length], [0, 0]);
});

test("a post photo goes up as picked until normalize is on (commentPhotosV1), then through the same normalization", async () => {
  const off = world();
  const file = { type: "image/png", size: 5 };
  let calls = 0;
  const spy = async (f) => { calls += 1; return norm(f); };
  const a = await uploadPhoto(off.api, file, { fetchImpl: off.fetchImpl, normalizeImpl: spy });
  assert.equal(calls, 0, "flag off: no normalization");
  assert.deepEqual(off.presigns, [{ filename: "photo", contentType: "image/png", size: 5 }], "the post presign body is what it was: no purpose");
  assert.deepEqual(a, { kind: "image", url: "https://harrisonfamily.us/uploads/posts/01J000000000000000000001/photo.jpg", mime: "image/png" });
  const on = world();
  const b = await uploadPhoto(on.api, file, { purpose: "post", normalize: true, fetchImpl: on.fetchImpl, normalizeImpl: spy });
  assert.equal(calls, 1);
  assert.equal(on.presigns[0].contentType, "image/jpeg");
  assert.equal(b.mime, "image/jpeg");
  assert.deepEqual([b.width, b.height], [800, 600]);
  assert.match(b.url, /^https:\/\/harrisonfamily\.us\//, "a post photo keeps its absolute url");
});

test("only post and comment are upload purposes", async () => {
  assert.deepEqual([...PURPOSES], ["post", "comment"]);
  await assert.rejects(uploadPhoto(world().api, { type: "image/jpeg", size: 1 }, { purpose: "avatar" }), TypeError);
});
