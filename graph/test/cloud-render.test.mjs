// viz-graph-cloud-source (HFY-TSK-274): hfy-graph-render over an in-memory store, site bucket and metrics.
// Synthetic people, places and photos only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tree } from './fixtures/gramps.mjs';
import { applyModeration, loadHiddenMods } from '../cloud/cloud-source.mjs';
import { FACES_PREFIX, GRAPH_KEY, errorCode, renderGraph, s3MediaReader, smoke } from '../cloud/render.mjs';
import { handler } from '../cloud/index.mjs';
import { fakeMetrics, fakeSite, fakeTable, syntheticJpeg } from './cloud-helpers.mjs';

const NOW = new Date('2026-10-20T00:00:00Z');
const mref = (media, rect = [10, 10, 80, 80], extra = {}) => ({ _class: 'MediaRef', ref: `h_${media}`, rect, private: false, ...extra });
const mediaObj = (id, extra = {}) => ({ _class: 'Media', handle: `h_${id}`, gramps_id: id, path: `/synthetic/${id}.jpg`, mime: 'image/jpeg', desc: 'synthetic', ...extra });

/** Three people; I0001 and I0002 are tagged in photo O0001 (I0001's primary), I0003 has its own photo O0002. */
function tree({ tags } = {}) {
  const t = new Tree();
  t.person('I0001', { given: 'Ada', birth: { when: { year: 1900 } }, death: { when: { year: 1980 } } });
  t.person('I0002', { given: 'Ben', birth: { when: { year: 1902 } }, death: { when: { year: 1985 } } });
  t.person('I0003', { given: 'Cleo', birth: { when: { year: 1930 } }, death: { when: { year: 2000 } } });
  t.family('F0001', { father: 'I0001', mother: 'I0002', children: [{ id: 'I0003' }] });
  const given = tags ?? { I0001: [mref('O0001')], I0002: [mref('O0001', [20, 20, 70, 70])], I0003: [mref('O0002')] };
  const objects = t.list().map((o) => (o._class === 'Person' ? { ...o, media_list: given[o.gramps_id] ?? [] } : o));
  return [...objects, mediaObj('O0001'), mediaObj('O0002')];
}

async function world({ objects = tree(), photos = true, debounceMs = 0, ...extra } = {}) {
  const table = fakeTable();
  table.putAll(objects);
  const jpeg = await syntheticJpeg();
  const site = fakeSite(photos ? { 'media/h_O0001.jpg': jpeg, 'media/h_O0002.jpg': await syntheticJpeg(160, 160, { r: 20, g: 20, b: 200 }) } : {});
  const metrics = fakeMetrics();
  const logs = [];
  const log = { info: (m) => logs.push(m), error: (m) => logs.push(m) };
  const deps = { ctx: table.ctx, site, metrics, now: () => NOW, debounceMs, log, guard: null, ...extra };
  return { table, site, metrics, logs, deps, run: (event) => renderGraph(deps, event) };
}

const graphOf = (site) => JSON.parse(site.files.get(GRAPH_KEY).toString('utf8'));
const faceFiles = (site) => [...site.files.keys()].filter((k) => k.startsWith(FACES_PREFIX)).sort();

describe('a pass over the cloud store', () => {
  it('writes person/graph.json and the faces, verified, and records the seq it built', async () => {
    const w = await world();
    const out = await w.run({ source: 'render' });
    assert.equal(out.status, 'rendered');
    const graph = graphOf(w.site);
    assert.equal(graph.source.kind, 'cloud');
    assert.equal(graph.counts.people, 3);
    assert.deepEqual(graph.people.map((p) => p.id).sort(), ['I0001', 'I0002', 'I0003']);
    assert.match(graph.people.find((p) => p.id === 'I0001').face, /^faces\/I0001-[0-9a-f]{8}\.webp$/);
    assert.equal(graph.counts.faces, 1 + 1 + 1);
    assert.equal(faceFiles(w.site).length, 3);
    assert.ok(graph.photoEdges.some((e) => e.media === 'O0001' && e.people.join() === 'I0001,I0002'));
    assert.equal(w.table.state().built_seq, w.table.seq);
    assert.equal(w.metrics.events.length, 0);
  });

  it('uses only stored coordinates: no gazetteer runs (the graph says so and nothing reads one)', async () => {
    const w = await world();
    await w.run();
    const graph = graphOf(w.site);
    assert.equal(graph.attribution.geonames, false);
    assert.ok(graph.places.every((p) => p.geo === null || p.geo === 'gramps'));
  });

  it('writes the faces before the graph, and nothing before verify() has passed', async () => {
    const w = await world();
    await w.run();
    const order = w.site.puts();
    assert.equal(order.at(-1), GRAPH_KEY);
    assert.ok(order.slice(0, -1).every((k) => k.startsWith(FACES_PREFIX)));
    assert.deepEqual(w.site.deletes(), []);
  });

  it('skips a seq it already built; a forced pass writes only what changed (no face, no graph)', async () => {
    const w = await world();
    await w.run();
    w.site.calls.length = 0;
    assert.deepEqual(await w.run({ source: 'render' }), { status: 'skipped', reason: 'current', seq: w.table.seq });
    assert.deepEqual(w.site.calls, []);
    const out = await w.run({ force: true });
    assert.equal(out.status, 'rendered');
    assert.equal(out.faces_written, 0);
    assert.equal(out.graph_written, false);
    assert.deepEqual(w.site.puts(), []);
  });

  it('writes only the face that changed, and prunes the one no longer referenced', async () => {
    const w = await world();
    await w.run();
    const before = faceFiles(w.site);
    w.site.files.set('media/h_O0002.jpg', await syntheticJpeg(160, 160, { r: 20, g: 200, b: 20 })); // a new photo for I0003
    w.table.put(tree().find((o) => o.gramps_id === 'I0003')); // any change moves the seq
    w.site.calls.length = 0;
    const out = await w.run({ source: 'render' });
    assert.equal(out.faces_written, 1);
    assert.equal(out.faces_pruned, 1);
    const after = faceFiles(w.site);
    assert.equal(after.length, 3);
    assert.equal(before.filter((f) => !after.includes(f)).length, 1);
    assert.ok(w.site.puts().length === 2 && w.site.puts().at(-1) === GRAPH_KEY);
  });

  it('a person without a readable photo keeps face null and the pass still succeeds', async () => {
    const w = await world({ photos: false });
    const out = await w.run();
    assert.equal(out.status, 'rendered');
    assert.equal(graphOf(w.site).counts.faces, 0);
    assert.ok(out.warnings >= 3);
  });

  it('an empty store, and an open push session, hold the pass', async () => {
    const empty = await world({ objects: [] });
    assert.deepEqual(await empty.run(), { status: 'skipped', reason: 'empty_store' });
    const w = await world();
    w.table.rows.get('SYNC#HEAD\u0000META').open_session = 's1';
    w.table.rows.set('SYNC#SESSION#s1\u0000META', { PK: 'SYNC#SESSION#s1', SK: 'META', state: 'open', opened_at: NOW.toISOString() });
    assert.equal((await w.run()).reason, 'push_session_open');
    assert.deepEqual(w.site.puts(), []);
    w.table.rows.get('SYNC#SESSION#s1\u0000META').opened_at = '2026-10-19T00:00:00Z'; // abandoned long ago
    assert.equal((await w.run()).status, 'rendered');
  });

  it('debounces: one wait, then the newest head is built', async () => {
    const naps = [];
    const w = await world({ debounceMs: 5000 });
    w.deps.sleep = async (ms) => {
      naps.push(ms);
      w.table.put(tree().find((o) => o.gramps_id === 'I0003')); // a second pass lands while it waits
    };
    const out = await w.run({ source: 'render', seq: 1 });
    assert.deepEqual(naps, [5000]);
    assert.equal(out.seq, w.table.seq);
    assert.equal(w.table.state().built_seq, w.table.seq);
    naps.length = 0;
    assert.equal((await w.run()).reason, 'current');
    assert.deepEqual(naps, [], 'a queued invocation that finds the marker current skips without waiting');
  });
});

describe('an expunge does not move the seq, so the marker also holds SYNC#HEAD.expunge_epoch', () => {
  // The scrubbed name stands in for the value `api/scripts/expunge.mjs --path` removed from a live record.
  const scrubName = (w) => w.table.scrub('h_I0001', (o) => void (o.primary_name.first_name = 'Scrubbed'));
  const named = (w, name) => w.site.files.get(GRAPH_KEY).toString('utf8').includes(name);

  it('rebuilds after an expunge that left the seq alone, and no longer names the removed value', async () => {
    const w = await world();
    await w.run({ source: 'render' });
    assert.ok(named(w, 'Ada'));
    assert.equal(w.table.state().expunge_epoch, 0, 'a store that was never expunged is epoch 0');
    const seq = w.table.seq;
    scrubName(w);
    assert.equal(w.table.seq, seq);
    const out = await w.run({ source: 'render', seq });
    assert.equal(out.status, 'rendered');
    assert.equal(out.graph_written, true);
    assert.ok(!named(w, 'Ada'), 'the removed value is gone from person/graph.json');
    assert.ok(named(w, 'Scrubbed'));
    assert.equal(w.table.state().expunge_epoch, 1);
    assert.deepEqual(await w.run({ source: 'render', seq }), { status: 'skipped', reason: 'current', seq }, 'the epoch it built is current');
  });

  it('rebuilds for the schedule tick and the operator render too: neither carries force', async () => {
    const w = await world();
    await w.run({ source: 'render', seq: w.table.seq });
    scrubName(w);
    assert.equal((await w.run({ source: 'render', seq: w.table.seq })).status, 'rendered');
    scrubName(w);
    assert.equal((await w.run({})).status, 'rendered');
    assert.equal(w.table.state().expunge_epoch, 2);
  });

  it('builds the epoch it finds after the debounce wait, not the one it saw first', async () => {
    const w = await world({ debounceMs: 5000 });
    await w.run({ force: true });
    scrubName(w); // epoch 1: the first check finds the marker behind, so the pass waits
    w.deps.sleep = async () => w.table.scrub('h_I0001', (o) => void (o.primary_name.first_name = 'Scrubbed twice'));
    const out = await w.run({ source: 'render', seq: w.table.seq });
    assert.equal(out.status, 'rendered');
    assert.ok(named(w, 'Scrubbed twice') && !named(w, 'Ada'));
    assert.equal(w.table.state().expunge_epoch, 2);
    assert.equal((await w.run({ source: 'render', seq: w.table.seq })).reason, 'current');
  });

  it('reads a marker from before the field existed as epoch 0', async () => {
    const w = await world();
    await w.run();
    const marker = w.table.rows.get('SYNC#GRAPH\u0000META');
    delete marker.expunge_epoch;
    assert.equal((await w.run({ source: 'render' })).reason, 'current', 'an unexpunged store is still current');
    scrubName(w);
    assert.equal((await w.run({ source: 'render' })).status, 'rendered', 'the first expunge rebuilds a marker without the field');
    assert.equal(w.table.state().expunge_epoch, 1);
  });

  it('a lower epoch than the marker (a restored table) rebuilds as well', async () => {
    const w = await world();
    scrubName(w);
    await w.run();
    assert.equal(w.table.state().expunge_epoch, 1);
    const head = w.table.rows.get('SYNC#HEAD\u0000META');
    delete head.expunge_epoch;
    assert.equal((await w.run({ source: 'render' })).status, 'rendered');
    assert.equal(w.table.state().expunge_epoch, 0);
  });
});

describe('moderation (MOD# overlay): hidden items never reach the graph or the faces', () => {
  it('a hidden primary Media gives face null, no crop is uploaded, and the old face is pruned', async () => {
    const w = await world();
    await w.run();
    const oldFace = graphOf(w.site).people.find((p) => p.id === 'I0003').face;
    assert.ok(oldFace);
    w.table.hide('media:h_O0002'); // the seq does not move: the digest of the hidden set does
    const out = await w.run();
    assert.equal(out.status, 'rendered');
    assert.equal(out.hidden_media, 1);
    assert.equal(out.hidden_primary_photos, 1);
    const graph = graphOf(w.site);
    assert.equal(graph.people.find((p) => p.id === 'I0003').face, null);
    assert.ok(!w.site.files.has(`media/${oldFace}`));
    assert.equal(graph.counts.faces, 2);
  });

  it('a hidden MediaRef of the primary photo gives face null and leaves the photo edge of the others', async () => {
    const w = await world();
    w.table.hide('mediaref:h_I0001:h_O0001');
    await w.run();
    const graph = graphOf(w.site);
    assert.equal(graph.people.find((p) => p.id === 'I0001').face, null);
    assert.notEqual(graph.people.find((p) => p.id === 'I0002').face, null);
    // I0001 is no longer tagged in O0001, and one tag makes no co-occurrence edge to name I0001
    assert.ok(!graph.photoEdges.some((e) => e.people.includes('I0001')));
  });

  it('a hidden primary photo does not let the next photo stand in for it', async () => {
    const objects = tree({ tags: { I0001: [mref('O0001'), mref('O0002')], I0002: [], I0003: [] } });
    const w = await world({ objects });
    w.table.hide('media:h_O0001');
    await w.run();
    const graph = graphOf(w.site);
    assert.equal(graph.people.find((p) => p.id === 'I0001').face, null);
    assert.deepEqual(graph.photoEdges.map((e) => e.media), ['O0002']);
  });

  it('hidden notes are dropped; an unhide brings the face back at once', async () => {
    const w = await world();
    w.table.hide('media:h_O0002');
    await w.run();
    assert.equal(graphOf(w.site).counts.faces, 2);
    w.table.unhide('media:h_O0002');
    const out = await w.run();
    assert.equal(out.status, 'rendered');
    assert.equal(graphOf(w.site).counts.faces, 3);
  });

  it('applyModeration leaves the stored objects untouched and counts what it drops', () => {
    const objects = [...tree(), { _class: 'Note', handle: 'h_N1', gramps_id: 'N0001', text: { string: 'synthetic' } }];
    const frozen = JSON.stringify(objects);
    const mods = new Map([['note:h_N1', {}], ['media:h_O0001', {}]]);
    const { objects: out, hiddenFaces, counts } = applyModeration(objects, mods);
    assert.equal(JSON.stringify(objects), frozen);
    assert.deepEqual(counts, { notes: 1, media: 1 });
    assert.deepEqual([...hiddenFaces].sort(), ['I0001', 'I0002']);
    assert.ok(!out.some((o) => o.handle === 'h_N1' || o.handle === 'h_O0001'));
    assert.ok(out.filter((o) => o._class === 'Person').every((p) => p.media_list.every((r) => r.ref !== 'h_O0001')));
  });

  it('loadHiddenMods reads only open, hidden items, across pages, and re-reads a row the index returned without its flag', async () => {
    const table = fakeTable();
    table.hide('note:a');
    table.hide('media:b');
    table.hide('media:c', { open: false });
    table.hide('media:d', { hidden: false });
    table.hide('media:e');
    table.rows.set('MOD#media:f\u0000META', { PK: 'MOD#media:f', SK: 'META', hidden: true, open: true }); // the full item, not in the index
    table.rows.set('x\u0000y', { PK: 'MOD#media:g', SK: 'META', GSI1PK: 'MODQ#open', GSI1SK: '2026#g' }); // an index row without the flag
    table.rows.set('MOD#media:g\u0000META', { PK: 'MOD#media:g', SK: 'META', hidden: true, open: true, author_id: 'someone' });
    const mods = await loadHiddenMods(table.ctx);
    assert.deepEqual([...mods.keys()].sort(), ['media:b', 'media:e', 'media:g', 'note:a']);
  });
});

describe('a failure keeps the previous graph and raises the renderer alarm', () => {
  it('a verify() failure writes nothing, emits RenderError, records only a code, and fails the invocation', async () => {
    const w = await world();
    await w.run();
    const before = new Map(w.site.files);
    w.table.put(tree().find((o) => o.gramps_id === 'I0003'));
    w.site.calls.length = 0;
    w.deps.guard = () => ({ ok: false });
    await assert.rejects(w.run(), /hfy-graph-render failed: PRIVACY_VIOLATION/);
    assert.deepEqual(w.site.puts(), []);
    assert.deepEqual(w.site.deletes(), []);
    assert.deepEqual([...w.site.files.entries()].map(([k, v]) => [k, v.toString('hex')]), [...before.entries()].map(([k, v]) => [k, v.toString('hex')]));
    assert.deepEqual(w.metrics.events, [['RenderError', 1]]);
    const state = w.table.state();
    assert.equal(state.last_error, 'GraphRenderError:PRIVACY_VIOLATION');
    assert.ok(state.built_seq < w.table.seq, 'the marker did not move, so the next pass retries');
    assert.ok(w.logs.every((l) => !/Ada|Ben|Cleo|I000/.test(l)), 'no name or id is logged');
  });

  it('a store with no people cannot replace a good graph', async () => {
    const w = await world();
    await w.run();
    const table = fakeTable();
    table.putAll([mediaObj('O0001')]);
    const deps = { ...w.deps, ctx: table.ctx };
    await assert.rejects(renderGraph(deps), /INPUT_MISSING/);
    assert.ok(w.site.files.has(GRAPH_KEY));
  });

  it('an unexpected error is reported by its name only', async () => {
    const w = await world();
    w.deps.ctx = { ...w.deps.ctx, ddb: { send: async () => { throw Object.assign(new Error('Ada Example at 12 Elm Street'), { name: 'ProvisionedThroughputExceededException' }); } } };
    await assert.rejects(w.run(), (e) => e.message === 'hfy-graph-render failed: ProvisionedThroughputExceededException');
    assert.deepEqual(w.metrics.events, [['RenderError', 1]]);
    assert.equal(errorCode(new Error('x')), 'Error');
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 'bad code with spaces' })), 'Error');
  });

  it('a failed alarm put or marker write does not mask the original failure', async () => {
    const w = await world();
    w.deps.guard = () => ({ ok: false });
    w.deps.metrics = { emit: async () => { throw new Error('throttled'); } };
    await assert.rejects(w.run(), /PRIVACY_VIOLATION/);
  });
});

describe('the S3 MediaReader', () => {
  it('tries the extension of the content type, then the one on the stored path; never a handle that is not plain', async () => {
    const site = fakeSite({ 'media/h_a.png': 'png-bytes', 'media/h_b.jpg': 'jpg-bytes' });
    const medias = [
      { _class: 'Media', handle: 'h_a', mime: 'image/png', path: 'x.jpg' },
      { _class: 'Media', handle: 'h_b', mime: 'image/heic', path: '/p/photo.JPG' },
      { _class: 'Media', handle: '../h_c', mime: 'image/png', path: 'c.png' },
    ];
    const reader = s3MediaReader(site, medias);
    assert.equal((await reader.read('h_a')).toString(), 'png-bytes');
    assert.equal((await reader.read('h_b')).toString(), 'jpg-bytes');
    assert.equal(await reader.read('../h_c'), null);
    assert.equal(await reader.read('h_unknown'), null);
    assert.ok(!site.calls.some((c) => c[1].includes('..')));
  });
});

describe('the function entry point', () => {
  it('a smoke invoke crops a synthetic face with the packaged sharp and touches no AWS service', async () => {
    const out = await smoke();
    assert.equal(out.ok, true);
    assert.deepEqual([out.format, out.width, out.height], ['webp', 160, 160]);
    assert.match(out.name, /^I0000-[0-9a-f]{8}\.webp$/);
    assert.deepEqual(await handler({ smoke: true }), out);
  });
});
