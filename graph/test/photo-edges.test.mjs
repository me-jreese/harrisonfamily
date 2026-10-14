// photoEdges (graph minor 2, task viz-graph-v2-data): one entry per photo with at least one tagged, kept person.
// Synthetic fixtures only: invented ids, no names or dates beyond the generic Tree helper.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildFamilyGraph, MINOR } from '../src/build.mjs';
import { stringify } from '../src/canonical.mjs';
import { validateSchema } from '../src/schema-validate.mjs';
import { loadSchema, verifyGraph } from '../src/verify.mjs';
import { Tree, messyTree, shuffled, SENTINEL } from './fixtures/gramps.mjs';
import { GENERATED_AT, GOLDEN, NOW } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const ajvValidate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(loadSchema());

const build = (objects) => buildFamilyGraph(objects, { generatedAt: GENERATED_AT, now: NOW });
const verify = (g) => verifyGraph(g, { now: NOW });
const mref = (media, rect, extra = {}) => ({ _class: 'MediaRef', ref: `h_${media}`, rect, private: false, ...extra });
const media = (id, extra = {}) => ({ _class: 'Media', handle: `h_${id}`, gramps_id: id, path: `${SENTINEL}/${id}.jpg`, desc: `${SENTINEL}_MEDIA_DESC`, private: false, ...extra });

/**
 * Four people (I1..I4, I4 optionally private) and the given Media objects. `tags` maps a person id to its media_list
 * (MediaRefs); a person not in `tags` has no tags at all.
 */
function tree({ tags = {}, medias = [], privatePeople = [] } = {}) {
  const t = new Tree();
  for (const id of ['I1', 'I2', 'I3', 'I4']) t.person(id, { given: id, surname: 'Pic', private: privatePeople.includes(id) });
  const objects = t.list().map((o) => (o._class === 'Person' ? { ...o, media_list: tags[o.gramps_id] ?? [] } : o));
  return [...objects, ...medias];
}
const edges = (objects) => build(objects).graph.photoEdges;

describe('photoEdges: the block', () => {
  it('the minor is 3 (photoEdges was 2, layout bumped it) and the golden carries it', () => {
    assert.equal(MINOR, 3);
    assert.equal(JSON.parse(readFileSync(GOLDEN, 'utf8')).minor, 3);
  });

  it('one entry per photo with the sorted gramps ids of the people tagged in it, nothing else', () => {
    const e = edges(tree({
      medias: [media('O2'), media('O1')],
      tags: { I3: [mref('O1', [10, 10, 60, 60])], I1: [mref('O1', [20, 20, 40, 40]), mref('O2', [0, 0, 50, 50])], I2: [mref('O1', null)] },
    }));
    assert.deepEqual(e, [{ media: 'O1', people: ['I1', 'I2', 'I3'] }, { media: 'O2', people: ['I1'] }]);
    for (const x of e) assert.deepEqual(Object.keys(x).sort(), ['media', 'people']);
  });

  it('the messy golden has the one synthetic photo, with the kept people only', () => {
    const { graph } = build(messyTree().list());
    assert.equal(graph.photoEdges.length, 1);
    assert.equal(graph.photoEdges[0].media, 'O9001');
    assert.deepEqual(graph.photoEdges[0].people, graph.people.map((p) => p.id).sort());
    assert.ok(!graph.photoEdges[0].people.includes('I9015')); // the private person
  });

  it('no handle, rect, path, description or note reaches the block', () => {
    const { graph } = build(tree({ medias: [media('O1')], tags: { I1: [mref('O1', [11, 22, 33, 44])] } }));
    const text = JSON.stringify(graph.photoEdges);
    assert.equal(text, '[{"media":"O1","people":["I1"]}]');
    for (const banned of [SENTINEL, 'h_', '.jpg', '11', '44']) assert.ok(!text.includes(banned), `contains ${banned}`);
  });

  it('is an empty array, not absent, when nobody is tagged', () => {
    assert.deepEqual(build(tree({ medias: [media('O1')] })).graph.photoEdges, []);
  });

  it('a person tagged twice in one photo counts once; a media with no tag is not an entry', () => {
    const e = edges(tree({ medias: [media('O1'), media('O2')], tags: { I1: [mref('O1', [0, 0, 10, 10]), mref('O1', [50, 50, 90, 90])] } }));
    assert.deepEqual(e, [{ media: 'O1', people: ['I1'] }]);
  });

  it('a MediaRef with no rect (null, missing or Gramps [0,0,0,0]) is a whole-photo tag and counts', () => {
    const noRect = { _class: 'MediaRef', ref: 'h_O1', private: false }; // no rect key at all
    const e = edges(tree({ medias: [media('O1')], tags: { I1: [noRect], I2: [mref('O1', null)], I3: [mref('O1', [0, 0, 0, 0])], I4: [mref('O1', [60, 60, 10, 10])] } }));
    assert.deepEqual(e, [{ media: 'O1', people: ['I1', 'I2', 'I3', 'I4'] }]); // reversed corners are valid, as in faces.mjs
  });

  it('the snapshot id follows the edges', () => {
    const a = build(tree({ medias: [media('O1')], tags: { I1: [mref('O1', null)] } })).graph.source.snapshot;
    const b = build(tree({ medias: [media('O1')], tags: { I1: [mref('O1', null)], I2: [mref('O1', null)] } })).graph.source.snapshot;
    assert.notEqual(a, b);
  });
});

describe('photoEdges: what is skipped', () => {
  it('a photo with a private MediaRef has no edge for that person', () => {
    const e = edges(tree({ medias: [media('O1')], tags: { I1: [mref('O1', null, { private: true })], I2: [mref('O1', null)] } }));
    assert.deepEqual(e, [{ media: 'O1', people: ['I2'] }]);
  });

  it('a photo whose only tag is private emits nothing', () => {
    assert.deepEqual(edges(tree({ medias: [media('O1')], tags: { I1: [mref('O1', null, { private: true })] } })), []);
  });

  it('a private Media emits nothing, whoever is tagged in it, and is reported as excluded', () => {
    const objects = tree({ medias: [media('O1', { private: true }), media('O2')], tags: { I1: [mref('O1', null)], I2: [mref('O1', null), mref('O2', null)] } });
    const { graph, report } = build(objects);
    assert.deepEqual(graph.photoEdges, [{ media: 'O2', people: ['I2'] }]);
    assert.ok(report.warnings.find((w) => w.code === 'PRIVATE_EXCLUDED').ids.includes('O1'));
  });

  it('an excluded (private) person is never in an edge, and a photo of only that person emits nothing', () => {
    const e = edges(tree({ privatePeople: ['I4'], medias: [media('O1'), media('O2')], tags: { I1: [mref('O1', null)], I4: [mref('O1', null), mref('O2', null)] } }));
    assert.deepEqual(e, [{ media: 'O1', people: ['I1'] }]);
    assert.ok(!JSON.stringify(e).includes('I4'));
  });

  it('a RECT_INVALID tag adds no person (and a photo of only such tags emits nothing)', () => {
    const invalid = { degenerate: [5, 5, 5, 50], 'zero height': [5, 20, 60, 20], 'not integers': [1.5, 2, 30, 40], 'wrong length': [1, 2, 3], 'a string': ['a', 1, 2, 3], 'not an array': { x: 1 } };
    for (const [label, rect] of Object.entries(invalid)) {
      const objects = tree({ medias: [media('O1'), media('O2')], tags: { I1: [mref('O1', rect), mref('O2', rect)], I2: [mref('O1', [10, 10, 60, 60])] } });
      const { graph, report } = build(objects);
      assert.deepEqual(graph.photoEdges, [{ media: 'O1', people: ['I2'] }], label);
      assert.deepEqual(report.warnings.find((w) => w.code === 'PHOTO_TAG_RECT_INVALID').ids, ['I1'], label);
    }
  });

  it('a MediaRef to a Media that is not in the input, or a Media with an unusable id, is skipped and reported', () => {
    const objects = tree({ medias: [media('O1'), media('bad id!')], tags: { I1: [mref('gone', null), mref('bad id!', null), mref('O1', null)] } });
    const { graph, report } = build(objects);
    assert.deepEqual(graph.photoEdges, [{ media: 'O1', people: ['I1'] }]);
    const codes = report.warnings.map((w) => w.code);
    assert.ok(codes.includes('DANGLING_REF') && codes.includes('MEDIA_ID_INVALID'));
    assert.deepEqual(verify(graph), { ok: true, violations: [] });
  });
});

describe('photoEdges: kept people and ambiguous ids', () => {
  it('a living (kept) person is an edge; only a private person is dropped', () => {
    const objects = tree({ privatePeople: ['I4'], medias: [media('O1')], tags: { I1: [mref('O1', null)], I4: [mref('O1', null)] } });
    const { graph } = build(objects);
    const living = graph.people.filter((p) => p.living).map((p) => p.id);
    const ids = new Set(graph.people.map((p) => p.id));
    assert.ok(living.includes('I1'));
    assert.deepEqual(graph.photoEdges, [{ media: 'O1', people: ['I1'] }]);
    for (const e of graph.photoEdges) for (const id of e.people) assert.ok(ids.has(id), `${id} is not a graph person`);
  });

  it('two Media sharing a gramps id are not merged: their tags are skipped and reported, in any input order', () => {
    const dup = [media('O1'), { ...media('O1'), handle: 'h_O1_other' }, media('O2')];
    const tags = { I1: [mref('O1', null), { ...mref('O1', null), ref: 'h_O1_other' }, mref('O2', null)], I2: [mref('O1', null)] };
    for (const seed of [0, 1, 2]) {
      const objects = seed === 0 ? tree({ medias: dup, tags }) : shuffled(tree({ medias: dup, tags }), seed);
      const { graph, report } = build(objects);
      assert.deepEqual(graph.photoEdges, [{ media: 'O2', people: ['I1'] }]);
      assert.deepEqual(report.warnings.find((w) => w.code === 'MEDIA_ID_DUPLICATE').ids, ['I1', 'I2']);
    }
  });
});

describe('photoEdges: determinism and verify()', () => {
  const rich = () => tree({
    medias: [media('O3'), media('O1'), media('O2', { private: true })],
    tags: { I4: [mref('O3', [1, 2, 30, 40]), mref('O1', null)], I2: [mref('O1', null), mref('O2', null)], I1: [mref('O3', null, { private: true }), mref('O1', null)] },
  });
  const base = stringify(build(rich()).graph);

  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`shuffled input (seed ${seed}) gives a byte-identical graph.json`, () => {
      assert.equal(stringify(build(shuffled(rich(), seed)).graph), base);
    });
  }
  it('the emitted block is sorted by media then person', () => {
    assert.deepEqual(JSON.parse(base).photoEdges, [{ media: 'O1', people: ['I1', 'I2', 'I4'] }, { media: 'O3', people: ['I4'] }]);
  });

  it('verify() passes on the emitted graph, and the schema validators (ajv and built-in) agree', () => {
    const { graph } = build(rich());
    assert.deepEqual(verify(graph), { ok: true, violations: [] });
    assert.equal(ajvValidate(graph), true, JSON.stringify(ajvValidate.errors));
    assert.deepEqual(validateSchema(loadSchema(), graph), []);
  });

  it('a graph without the block (minor 1) still verifies: the property is optional', () => {
    const { graph } = build(rich());
    delete graph.photoEdges;
    assert.deepEqual(verify(graph), { ok: true, violations: [] });
  });

  it('verify() still rejects day-precise dates, e-mail, phone numbers and URLs, inside the block too', () => {
    const cases = { 'day-precise-date': '2026-10-20', phone: '555-010-0100' };
    for (const [rule, value] of Object.entries(cases)) {
      const g = build(rich()).graph;
      g.photoEdges[0].media = value; // passes the id pattern, so the string scan is what catches it
      const r = verify(g);
      assert.equal(r.ok, false, rule);
      assert.ok(r.violations.some((v) => v.pointer === '/photoEdges/0/media' && v.rule === rule), JSON.stringify(r.violations));
    }
    for (const value of ['jo@example.invalid', 'https://example.invalid', 'www.example.invalid']) {
      const g = build(rich()).graph;
      g.photoEdges[0].people[0] = value;
      assert.equal(verify(g).ok, false, value);
    }
    // and the same detectors still fire elsewhere in a graph that carries the block
    const g = build(rich()).graph;
    g.people[0].given = 'born 03/14/1950';
    assert.equal(verify(g).ok, false);
  });

  it('verify() rejects an unknown property, a handle, an empty people list, an unknown person, and an unsorted or repeated entry', () => {
    const mutate = (fn) => {
      const g = build(rich()).graph;
      fn(g);
      return verify(g);
    };
    assert.equal(mutate((g) => (g.photoEdges[0].rect = [1, 2, 3, 4])).ok, false);
    assert.equal(mutate((g) => (g.photoEdges[0].handle = 'h_x')).ok, false);
    assert.equal(mutate((g) => (g.photoEdges[0].people = [])).ok, false);
    assert.equal(mutate((g) => (g.photoEdges[0].people = ['I9999'])).ok, false);
    assert.ok(mutate((g) => (g.photoEdges[0].people = ['I2', 'I1'])).violations.some((v) => v.rule === 'photo-edge-order'));
    assert.ok(mutate((g) => (g.photoEdges[0].people = ['I1', 'I1'])).violations.some((v) => v.rule === 'photo-edge-order'));
    assert.ok(mutate((g) => g.photoEdges.reverse()).violations.some((v) => v.rule === 'photo-edge-order'));
    assert.ok(mutate((g) => g.photoEdges.push({ ...g.photoEdges[1] })).violations.some((v) => v.rule === 'photo-edge-order'));
    assert.equal(mutate((g) => (g.photoEdges = {})).ok, false);
    assert.equal(mutate((g) => (g.extraBlock = [])).ok, false); // additionalProperties:false still holds at the top
  });
});
