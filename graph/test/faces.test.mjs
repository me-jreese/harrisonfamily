// viz-face-crops: the Gramps crop rule, naming and caching, the failure codes, the CLI write order and pruning, and the
// sharp/libvips boundary. Synthetic images only, generated here with sharp: flat colour blocks, never a photo of anyone.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { FACE_MAX_BYTES, buildFaces, cropBox, faceName, normalizeRect, pruneFaces, stagingMediaReader } from '../src/faces.mjs';
import { main } from '../src/cli.mjs';
import { Tree } from './fixtures/gramps.mjs';
import { GENERATED_AT, HERE, NOW, scratch, writeJsonl } from './helpers.mjs';

const RED = { r: 220, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 220 };

/** A W x H JPEG: red in the top-left quarter, blue elsewhere. */
async function quadrantJpeg(width = 400, height = 300, extra = (s) => s) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = x < width / 2 && y < height / 2 ? RED : BLUE;
      raw.set([c.r, c.g, c.b], (y * width + x) * 3);
    }
  }
  return extra(sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 })).toBuffer();
}

async function meanColour(webp) {
  const { channels } = await sharp(webp).stats();
  return { r: channels[0].mean, g: channels[1].mean, b: channels[2].mean };
}

/** The RIFF chunk ids of a WebP file. */
function webpChunks(buf) {
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('latin1'), 'WEBP');
  const ids = [];
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.subarray(p, p + 4).toString('latin1');
    const size = buf.readUInt32LE(p + 4);
    ids.push(id);
    p += 8 + size + (size % 2);
  }
  return ids;
}

const mapReader = (map) => ({ read: (h) => (h in map ? map[h] : null) });

describe('the Gramps crop rule', () => {
  it('orders and clamps the corners; a missing or all-zero rect is null; anything else odd is RECT_INVALID', () => {
    assert.deepEqual(normalizeRect([60, 70, 10, 20]), { rect: [10, 20, 60, 70], invalid: false });
    assert.deepEqual(normalizeRect([-5, 10, 120, 50]), { rect: [0, 10, 100, 50], invalid: false });
    assert.deepEqual(normalizeRect(null), { rect: null, invalid: false });
    assert.deepEqual(normalizeRect([0, 0, 0, 0]), { rect: null, invalid: false });
    for (const bad of [[10, 10, 10, 50], [10, 10, 50], [10.5, 10, 50, 50], 'x', [10, 10, 50, '60'], [120, 10, 130, 50]]) {
      assert.equal(normalizeRect(bad).invalid, true, JSON.stringify(bad));
    }
  });

  it('truncates on stored pixels as Gramps does (int(x * width / 100)), then squares around the centre', () => {
    // 29 * 100 / 100 is exactly 29, where 29 / 100 * 100 would truncate to 28
    assert.equal(cropBox(100, 100, [29, 29, 71, 71]).left, 29);
    assert.deepEqual(cropBox(333, 250, [10, 20, 60, 70]), { left: 33, top: 29, width: 166, height: 166, invalid: false });
    // a tall box widens, and the square is clamped inside the image
    assert.deepEqual(cropBox(400, 300, [0, 0, 10, 100]), { left: 0, top: 0, width: 300, height: 300, invalid: false });
    assert.deepEqual(cropBox(400, 300, [90, 0, 100, 100]), { left: 100, top: 0, width: 300, height: 300, invalid: false });
    // no rect: the centre square of the whole image
    assert.deepEqual(cropBox(400, 300, null), { left: 50, top: 0, width: 300, height: 300, invalid: false });
    // a rect that truncates to no pixel falls back to the centre square
    assert.deepEqual(cropBox(10, 10, [1, 1, 5, 5]), { left: 0, top: 0, width: 10, height: 10, invalid: true });
  });

  it('names files <gramps_id>-<sha8>.webp from sha256(source bytes || JSON(rect))', () => {
    const bytes = Buffer.from('synthetic');
    const sha8 = createHash('sha256').update(bytes).update('[10,20,60,70]').digest('hex').slice(0, 8);
    assert.equal(faceName('I0001', bytes, [10, 20, 60, 70]), `I0001-${sha8}.webp`);
    assert.notEqual(faceName('I0001', bytes, [10, 20, 60, 71]), faceName('I0001', bytes, [10, 20, 60, 70]));
  });
});

describe('buildFaces', () => {
  it('crops the rect, squares it, and writes a 160 px WebP within 8 KB with no metadata (AC1)', async () => {
    const out = scratch();
    const jpeg = await quadrantJpeg(400, 300, (s) => s.withMetadata({ orientation: 1 }));
    const r = await buildFaces([{ id: 'I0001', media: 'h1', rect: [0, 0, 50, 50] }], mapReader({ h1: jpeg }), out);
    assert.deepEqual(r.warnings, []);
    const rel = r.faces.get('I0001');
    assert.equal(rel, `faces/${faceName('I0001', jpeg, [0, 0, 50, 50])}`);
    const webp = readFileSync(join(out, rel));
    const meta = await sharp(webp).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 160);
    assert.equal(meta.height, 160);
    assert.ok(webp.length <= FACE_MAX_BYTES, `${webp.length} bytes`);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(meta.xmp, undefined);
    assert.ok(webpChunks(webp).every((id) => ['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(id)), webpChunks(webp).join(','));
    // the top-left quarter is red, so the crop is red: the rect was read on the stored pixels
    const c = await meanColour(webp);
    assert.ok(c.r > 150 && c.b < 100, JSON.stringify(c));
  });

  it('inverted rects give the same crop and the same file; an unchanged input writes nothing (AC2, AC4)', async () => {
    const out = scratch();
    const jpeg = await quadrantJpeg();
    const reader = mapReader({ h1: jpeg });
    const a = await buildFaces([{ id: 'I0001', media: 'h1', rect: [50, 50, 0, 0] }], reader, out);
    assert.equal(a.written, 1);
    const file = join(out, a.faces.get('I0001'));
    const before = statSync(file).mtimeMs;
    const b = await buildFaces([{ id: 'I0001', media: 'h1', rect: [0, 0, 50, 50] }], reader, out);
    assert.equal(b.written, 0);
    assert.equal(b.faces.get('I0001'), a.faces.get('I0001'));
    assert.equal(statSync(file).mtimeMs, before);
  });

  it('missing, placeholder, undecodable, HEIC, rotated and bad-rect sources never throw (AC3, AC4)', async () => {
    const out = scratch();
    const jpeg = await quadrantJpeg();
    const rotated = await quadrantJpeg(400, 300, (s) => s.withMetadata({ orientation: 6 }));
    // a HEIF container whose image is HEVC-coded: the prebuilt sharp cannot decode it
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic'), Buffer.alloc(64)]);
    const reader = mapReader({ zero: Buffer.alloc(0), junk: Buffer.from('not an image at all'), heic, rotated, ok: jpeg });
    const jobs = [
      { id: 'I1', media: 'gone', rect: null },
      { id: 'I2', media: 'zero', rect: null },
      { id: 'I3', media: 'junk', rect: null },
      { id: 'I4', media: 'heic', rect: null },
      { id: 'I5', media: 'rotated', rect: [0, 0, 50, 50] },
      { id: 'I6', media: 'ok', rect: [40, 40, 40, 90] },
    ];
    const r = await buildFaces(jobs, reader, out);
    const codes = Object.fromEntries(r.warnings.map((w) => [w.id, w.code]));
    assert.deepEqual(codes, { I1: 'MEDIA_MISSING', I2: 'PLACEHOLDER_MEDIA', I3: 'UNSUPPORTED_FORMAT', I4: 'UNSUPPORTED_FORMAT', I5: 'ORIENTATION_NOT_BAKED', I6: 'RECT_INVALID' });
    // every code gives face null (AC3); an invalid rect is never replaced by a guessed crop
    for (const id of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']) assert.equal(r.faces.get(id) ?? null, null, id);
    assert.deepEqual(existsSync(join(out, 'faces')) ? readdirSync(join(out, 'faces')) : [], []);
  });

  it('pruneFaces removes faces no longer referenced and leaves other files alone (AC2)', async () => {
    const out = scratch();
    mkdirSync(join(out, 'faces'));
    writeFileSync(join(out, 'faces', 'I9999-deadbeef.webp'), 'stale');
    writeFileSync(join(out, 'faces', 'README.txt'), 'not a face');
    const jpeg = await quadrantJpeg();
    const r = await buildFaces([{ id: 'I0001', media: 'h1', rect: null }], mapReader({ h1: jpeg }), out);
    assert.equal(pruneFaces(out, r.keep), 1);
    assert.deepEqual(readdirSync(join(out, 'faces')).sort(), ['README.txt', faceName('I0001', jpeg, null)].sort());
  });

  it('the staging reader matches media/<handle>.<ext> and skips .json', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'h1.json'), '{}');
    writeFileSync(join(dir, 'h1.jpg'), 'jpeg bytes');
    writeFileSync(join(dir, 'h2.json'), '{}');
    const r = stagingMediaReader(dir);
    assert.equal(r.read('h1').toString(), 'jpeg bytes');
    assert.equal(r.read('h2'), null);
    assert.equal(stagingMediaReader(join(dir, 'missing')).read('h1'), null);
  });
});

describe('the CLI writes faces before graph.json and prunes after it', () => {
  async function stage(withMedia) {
    const t = new Tree();
    t.person('I0001', { given: 'Ada', birth: { when: { year: 1900 } } });
    t.person('I0002', { given: 'Ben', birth: { when: { year: 1901 } } });
    const objects = t.list().map((o) => (o._class === 'Person' && o.gramps_id === 'I0002' ? { ...o, media_list: [] } : o));
    const work = scratch();
    const out = join(work, 'staging');
    mkdirSync(join(out, 'media'), { recursive: true });
    const jpeg = await quadrantJpeg();
    if (withMedia) writeFileSync(join(out, 'media', `${objects.find((o) => o._class === 'Person').media_list[0].ref}.jpg`), jpeg);
    return { input: writeJsonl(join(work, 'in.jsonl'), objects), out, work, jpeg };
  }
  const run = (input, out, work) => main([input, '--out', out, '--report', join(work, 'r.json'), '--generated-at', GENERATED_AT, '--quiet'], { now: NOW, guard: null });

  it('sets face and counts.faces, verifies, and a re-run writes nothing', async () => {
    const { input, out, work } = await stage(true);
    assert.equal(await run(input, out, work), 0);
    const graph = JSON.parse(readFileSync(join(out, 'person', 'graph.json'), 'utf8'));
    const face = graph.people.find((p) => p.id === 'I0001').face;
    assert.match(face, /^faces\/I0001-[0-9a-f]{8}\.webp$/);
    assert.equal(graph.people.find((p) => p.id === 'I0002').face, null);
    assert.equal(graph.counts.faces, 1);
    assert.ok(existsSync(join(out, 'media', face)));
    const report = JSON.parse(readFileSync(join(work, 'r.json'), 'utf8'));
    assert.deepEqual(report.faces, { referenced: 1, written: 1, removed: 0 });
    assert.equal(await run(input, out, work), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'r.json'), 'utf8')).faces, { referenced: 1, written: 0, removed: 0 });
  });

  it('a photo that goes missing loses its face, and the old file is pruned', async () => {
    const { input, out, work } = await stage(true);
    assert.equal(await run(input, out, work), 0);
    for (const f of readdirSync(join(out, 'media'))) if (f.endsWith('.jpg')) writeFileSync(join(out, 'media', f), ''); // now a placeholder
    assert.equal(await run(input, out, work), 0);
    const graph = JSON.parse(readFileSync(join(out, 'person', 'graph.json'), 'utf8'));
    assert.equal(graph.counts.faces, 0);
    assert.deepEqual(readdirSync(join(out, 'media', 'faces')), []);
    const report = JSON.parse(readFileSync(join(work, 'r.json'), 'utf8'));
    assert.deepEqual(report.warnings.find((w) => w.code === 'PLACEHOLDER_MEDIA').ids, ['I0001']);
    assert.equal(report.faces.removed, 1);
  });
});

describe('sharp stays a build-time dependency of graph/ (AC5)', () => {
  it('is pinned exactly at 0.35.x and the package needs Node 20.9 or later', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.match(pkg.dependencies.sharp, /^0\.35\.\d+$/);
    assert.ok(!pkg.devDependencies || !('sharp' in pkg.devDependencies));
    const lock = JSON.parse(readFileSync(join(HERE, '..', 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/sharp'].version, pkg.dependencies.sharp);
  });

  it('no node_modules or libvips binary is tracked in the site output', () => {
    const r = spawnSync('git', ['ls-files', '--', '11ty'], { cwd: join(HERE, '..', '..'), encoding: 'utf8' });
    if (r.status !== 0) return; // not a git checkout
    const hits = r.stdout.split('\n').filter((f) => /node_modules|libvips|sharp|\.node$|\.so(\.\d+)*$|\.dylib$/i.test(f));
    assert.deepEqual(hits, []);
  });

  it('the faces directory holds only the WebP files, which carry no metadata', async () => {
    const out = scratch();
    const jpeg = await quadrantJpeg(640, 480, (s) => s.withMetadata({ orientation: 1 }));
    const r = await buildFaces([{ id: 'I0001', media: 'h', rect: [10, 10, 60, 60] }, { id: 'I0002', media: 'h', rect: null }], mapReader({ h: jpeg }), out);
    const files = readdirSync(join(out, 'faces'));
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.match(f, /^I000[12]-[0-9a-f]{8}\.webp$/);
      const buf = readFileSync(join(out, 'faces', f));
      assert.ok(!buf.includes('Exif') && !buf.includes('XMP') && !buf.includes('ICCP') && !buf.toString('latin1').includes('libvips'));
    }
    assert.equal(r.keep.size, 2);
  });
});
