// hfy-graph-render, thumbnail step (HFY-TSK-393). Synthetic images only, generated here with sharp: flat colour blocks, never a photo.
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fakeSite } from './cloud-helpers.mjs';
import { MIN_BUDGET_MS, SIDECAR_KEY, THUMB_PREFIX, parseSidecar, renderThumbnails, thumbKey } from '../cloud/thumbs.mjs';

const quiet = { info() {}, error() {} };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function jpeg(width, height, extra = (s) => s) {
  const raw = Buffer.alloc(width * height * 3, 120);
  return extra(sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 })).toBuffer();
}

/** A site holding media/index.json and the originals of `items` ({handle, bytes, ext?, missing?}). */
function siteWith(items, extraFiles = {}) {
  const files = { ...extraFiles };
  const index = items.map((it, n) => {
    const key = `media/${it.handle}${it.ext ?? '.jpg'}`;
    if (it.bytes && !it.absent) files[key] = it.bytes;
    return { handle: it.handle, grampsId: `O${String(n).padStart(4, '0')}`, s3Key: key, checksum: it.checksum ?? (it.bytes ? sha(it.bytes) : null), size: it.bytes?.length ?? null, missing: it.missing === true };
  });
  files['media/index.json'] = JSON.stringify(index);
  return { site: fakeSite(files), index };
}

function deps(site) {
  const emitted = [];
  return { site, metrics: { emit: async (name) => void emitted.push(name) }, log: quiet, emitted };
}

const sidecarOf = (site) => parseSidecar(site.files.get(SIDECAR_KEY));

describe('thumbnail step', () => {
  it('pins the key scheme that gramps/hfygramps/render/thumbs.py computes too', () => {
    const checksum = `a1b2c3d4${'0'.repeat(56)}`;
    assert.equal(thumbKey('hndl_01', checksum, 320), 'media/thumb/hndl_01-a1b2c3d4-320.jpg');
    assert.equal(thumbKey('hndl_01', checksum, 800), 'media/thumb/hndl_01-a1b2c3d4-800.jpg');
    assert.equal(SIDECAR_KEY, 'media/thumb/index.json');
  });

  it('derives 320 and 800 px JPEGs on the long edge, never upscales, strips metadata and writes the sidecar', async () => {
    const big = await jpeg(2000, 1000, (s) => s.withExif({ IFD0: { Copyright: 'synthetic' } }));
    const small = await jpeg(100, 50);
    const { site } = siteWith([{ handle: 'big', bytes: big }, { handle: 'small', bytes: small }]);
    const d = deps(site);
    const out = await renderThumbnails(d);
    assert.equal(out.status, 'rendered');
    assert.equal(out.derived, 2);
    assert.equal(out.sidecar_written, true);
    for (const [handle, bytes, dims] of [['big', big, { 320: [320, 160], 800: [800, 400] }], ['small', small, { 320: [100, 50], 800: [100, 50] }]]) {
      for (const size of [320, 800]) {
        const file = site.files.get(thumbKey(handle, sha(bytes), size));
        assert.ok(file, `${handle} ${size}`);
        const meta = await sharp(file).metadata();
        assert.equal(meta.format, 'jpeg');
        assert.deepEqual([meta.width, meta.height], dims[size]);
        assert.equal(meta.exif, undefined, 'EXIF stripped');
        assert.equal(meta.icc, undefined, 'ICC stripped');
        assert.ok(!file.includes(Buffer.from('synthetic')));
      }
    }
    const records = sidecarOf(site);
    assert.deepEqual(records.get('big'), { checksum: sha(big), w: 2000, h: 1000 });
    assert.deepEqual(records.get('small'), { checksum: sha(small), w: 100, h: 50 });
    assert.deepEqual(site.puts().filter((k) => k.startsWith(THUMB_PREFIX)).length, 5);
  });

  it('applies the EXIF orientation: w and h are the oriented size and the thumbnails are upright', async () => {
    const sideways = await jpeg(600, 300, (s) => s.withMetadata({ orientation: 6 })); // stored 600x300, shown 300x600
    const { site } = siteWith([{ handle: 'turned', bytes: sideways }]);
    await renderThumbnails(deps(site));
    assert.deepEqual(sidecarOf(site).get('turned'), { checksum: sha(sideways), w: 300, h: 600 });
    const meta320 = await sharp(site.files.get(thumbKey('turned', sha(sideways), 320))).metadata();
    assert.deepEqual([meta320.width, meta320.height], [160, 320]);
    const meta800 = await sharp(site.files.get(thumbKey('turned', sha(sideways), 800))).metadata();
    assert.deepEqual([meta800.width, meta800.height], [300, 600], 'not upscaled');
    assert.ok([undefined, 1].includes(meta800.orientation), 'orientation is baked in');
  });

  it('flattens a transparent PNG onto white', async () => {
    const png = await sharp(Buffer.alloc(40 * 30 * 4, 0), { raw: { width: 40, height: 30, channels: 4 } }).png().toBuffer();
    const { site } = siteWith([{ handle: 'clear', bytes: png, ext: '.png' }]);
    await renderThumbnails(deps(site));
    const { data } = await sharp(site.files.get(thumbKey('clear', sha(png), 320))).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240);
  });

  it('is idempotent by source checksum: a second pass reads and writes no image', async () => {
    const a = await jpeg(900, 600);
    const { site } = siteWith([{ handle: 'a', bytes: a }]);
    await renderThumbnails(deps(site));
    site.calls.length = 0;
    const out = await renderThumbnails(deps(site));
    assert.deepEqual([out.derived, out.reused, out.pruned, out.sidecar_written], [0, 1, 0, false]);
    assert.deepEqual(site.puts(), []);
    assert.deepEqual(site.deletes(), []);
    assert.ok(!site.calls.some((c) => c[0] === 'get' && c[1] === 'media/a.jpg'), 'the original is not read again');
  });

  it('a replaced original is a new thumbnail URL, and the old thumbnails are pruned', async () => {
    const v1 = await jpeg(900, 600);
    const v2 = await jpeg(800, 800);
    const first = siteWith([{ handle: 'a', bytes: v1 }]);
    await renderThumbnails(deps(first.site));
    const second = siteWith([{ handle: 'a', bytes: v2 }], Object.fromEntries([...first.site.files].filter(([k]) => k.startsWith(THUMB_PREFIX))));
    const out = await renderThumbnails(deps(second.site));
    assert.equal(out.derived, 1);
    assert.equal(out.pruned, 2);
    assert.ok(second.site.files.has(thumbKey('a', sha(v2), 320)) && !second.site.files.has(thumbKey('a', sha(v1), 320)));
    assert.deepEqual(sidecarOf(second.site).get('a'), { checksum: sha(v2), w: 800, h: 800 });
  });

  it('prunes the thumbnails of a media that is no longer published (hidden, made private or deleted)', async () => {
    const a = await jpeg(500, 400);
    const b = await jpeg(500, 300);
    const { site } = siteWith([{ handle: 'a', bytes: a }, { handle: 'b', bytes: b }]);
    await renderThumbnails(deps(site));
    const index = JSON.parse(site.files.get('media/index.json').toString()).filter((e) => e.handle !== 'b');
    site.files.set('media/index.json', JSON.stringify(index));
    const out = await renderThumbnails(deps(site));
    assert.equal(out.pruned, 2);
    assert.ok(![...site.files.keys()].some((k) => k.startsWith('media/thumb/b-')));
    assert.deepEqual([...sidecarOf(site).keys()], ['a']);
  });

  it('never writes or deletes an original, and writes only under media/thumb/', async () => {
    const a = await jpeg(500, 400);
    const { site } = siteWith([{ handle: 'a', bytes: a }]);
    await renderThumbnails(deps(site));
    await renderThumbnails(deps(site), { force: true });
    assert.ok(site.puts().every((k) => k.startsWith(THUMB_PREFIX)));
    assert.deepEqual(site.deletes(), []);
    assert.deepEqual(site.files.get('media/a.jpg'), a);
  });

  it('gives no thumb to a missing original, a PDF, an undecodable file, a placeholder or a checksum mismatch; the step still succeeds', async () => {
    const good = await jpeg(400, 300);
    const junk = Buffer.from('this is not an image');
    const { site } = siteWith([
      { handle: 'good', bytes: good },
      { handle: 'gone', missing: true, checksum: null },
      { handle: 'pdf', bytes: Buffer.from('%PDF-1.4'), ext: '.pdf' },
      { handle: 'junk', bytes: junk },
      { handle: 'empty', bytes: Buffer.alloc(0), checksum: sha(Buffer.alloc(0)) },
      { handle: 'stale', bytes: good, checksum: 'f'.repeat(64) },
      { handle: 'nofile', bytes: good, absent: true, checksum: sha(good) },
    ]);
    const out = await renderThumbnails(deps(site));
    assert.equal(out.status, 'rendered');
    assert.deepEqual([...sidecarOf(site).keys()], ['good']);
    assert.equal(out.not_images, 1);
    assert.deepEqual(out.warnings, { DECODE_FAILED: 1, PLACEHOLDER_MEDIA: 1, CHECKSUM_MISMATCH: 1, MEDIA_MISSING: 1 });
  });

  it('force derives again; an empty index never unpublishes everything; no index is a skip', async () => {
    const a = await jpeg(500, 400);
    const { site } = siteWith([{ handle: 'a', bytes: a }]);
    await renderThumbnails(deps(site));
    assert.equal((await renderThumbnails(deps(site), { force: true })).derived, 1);
    site.files.set('media/index.json', '[]');
    assert.deepEqual(await renderThumbnails(deps(site)), { status: 'skipped', reason: 'empty_index' });
    assert.ok(site.files.has(thumbKey('a', sha(a), 320)));
    site.files.delete('media/index.json');
    assert.deepEqual(await renderThumbnails(deps(site)), { status: 'skipped', reason: 'no_index' });
  });

  it('stops deriving when the invocation is nearly out of time and leaves the rest pending for the next pass', async () => {
    const a = await jpeg(500, 400);
    const b = await jpeg(500, 300);
    const { site } = siteWith([{ handle: 'a', bytes: a }, { handle: 'b', bytes: b }]);
    let derivedSoFar = 0;
    const remainingMs = () => (derivedSoFar++ === 0 ? MIN_BUDGET_MS + 1 : MIN_BUDGET_MS - 1);
    const out = await renderThumbnails(deps(site), { remainingMs });
    assert.deepEqual([out.derived, out.pending], [1, 1]);
    assert.equal((await renderThumbnails(deps(site))).derived, 1);
    assert.deepEqual([...sidecarOf(site).keys()], ['a', 'b']);
  });

  it('an unreadable index raises the RenderError metric and fails with a code, never a message', async () => {
    const site = fakeSite({ 'media/index.json': '{not json' });
    const d = deps(site);
    await assert.rejects(renderThumbnails(d), (e) => e.message === 'hfy-graph-render thumbnails failed: THUMB_INDEX_UNREADABLE');
    assert.deepEqual(d.emitted, ['RenderError']);
  });
});
