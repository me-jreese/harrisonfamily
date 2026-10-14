import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildFamilyGraph, deriveEdges } from '../src/build.mjs';
import { stringify } from '../src/canonical.mjs';
import { GraphError } from '../src/errors.mjs';
import { assertSizeBudget, verifyGraph } from '../src/verify.mjs';
import { Tree, messyTree, shuffled, SENTINEL } from './fixtures/gramps.mjs';
import { GOLDEN, GENERATED_AT, NOW } from './helpers.mjs';

const build = (objects, extra = {}) => buildFamilyGraph(objects, { generatedAt: GENERATED_AT, now: NOW, ...extra });
const person = (graph, id) => graph.people.find((p) => p.id === id);

describe('messy genealogy golden', () => {
  const { graph, report } = build(messyTree().list());

  it('matches the committed golden byte for byte', () => {
    const text = stringify(graph);
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, text);
    assert.equal(text, readFileSync(GOLDEN, 'utf8'));
  });

  it('passes verify()', () => {
    assert.deepEqual(verifyGraph(graph, { now: NOW }), { ok: true, violations: [] });
  });

  it('has two partner families, a mother-only union, parentless siblings and every rel value', () => {
    const byId = Object.fromEntries(graph.unions.map((u) => [u.id, u]));
    // Ben has two unions
    assert.deepEqual(graph.unions.filter((u) => u.partners.includes('I9002')).map((u) => u.id), ['F9001', 'F9002']);
    // mother-only: one partner, one child
    assert.deepEqual(byId.F9003.partners, ['I9003']);
    assert.equal(byId.F9003.children.length, 1);
    // parentless siblings: no partners, two children, the duplicate child ref counted once
    assert.deepEqual(byId.F9004.partners, []);
    assert.deepEqual(byId.F9004.children.map((c) => c.id), ['I9010', 'I9011']);
    // every rel value shows up
    const rels = new Set(graph.edges.filter((e) => e.kind === 'parent').map((e) => e.rel));
    assert.deepEqual([...rels].sort(), ['adopted', 'birth', 'custom', 'foster', 'none', 'sponsored', 'step', 'unknown']);
    // every union type shows up
    assert.deepEqual([...new Set(graph.unions.map((u) => u.type))].sort(), ['civil_union', 'custom', 'married', 'unknown', 'unmarried']);
  });

  it('drops the private person, the private family and every reference to them', () => {
    assert.equal(person(graph, 'I9015'), undefined);
    assert.ok(!JSON.stringify(graph).includes('I9015'));
    assert.ok(!graph.unions.some((u) => u.id === 'F9008'));
    // the private partner of F9007 is gone and the union stays as a mother-only union
    const u = graph.unions.find((x) => x.id === 'F9007');
    assert.deepEqual(u.partners, ['I9006']);
    assert.deepEqual(u.children.map((c) => c.id), ['I9016']);
    // the private place is not emitted and the events that used it carry place null
    assert.ok(!graph.places.some((p) => p.name === 'Hidden Hollow'));
    assert.equal(person(graph, 'I9002').deathPlace, null);
    const codes = Object.fromEntries(report.warnings.map((w) => [w.code, w]));
    assert.ok(codes.PRIVATE_EXCLUDED.ids.includes('I9015'));
    assert.ok(codes.PRIVATE_EXCLUDED.ids.includes('F9008'));
    assert.ok(codes.PRIVATE_EXCLUDED.ids.includes('P9005'));
  });

  it('drops a family with one partner and no children, and a person with no family is a singleton component', () => {
    assert.ok(!graph.unions.some((u) => u.id === 'F9009'));
    const solo = graph.components.find((c) => c.roots.includes('I9018'));
    assert.equal(solo.size, 1);
    assert.equal(person(graph, 'I9017').name, 'unknown');
  });

  it('keeps dangling references out and reports them', () => {
    assert.deepEqual(report.warnings.find((w) => w.code === 'DANGLING_REF').ids, ['F9004']);
  });

  it('numbers components by size, then by the smallest id', () => {
    assert.deepEqual(graph.components.map((c) => [c.id, c.size]), [[0, 11], [1, 2], [2, 2], [3, 1], [4, 1]]);
    assert.equal(person(graph, 'I9010').component, 1);
    assert.equal(person(graph, 'I9012').component, 2);
  });

  it('counts agree with the arrays', () => {
    assert.deepEqual(graph.counts, {
      people: graph.people.length, unions: graph.unions.length, edges: graph.edges.length, places: graph.places.length,
      events: graph.events.length, components: graph.components.length, faces: 0,
    });
  });
});

describe('determinism', () => {
  const base = stringify(build(messyTree().list()).graph);
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`shuffled input (seed ${seed}) gives a byte-identical file`, () => {
      assert.equal(stringify(build(shuffled(messyTree().list(), seed)).graph), base);
    });
  }
  it('the snapshot id follows the content, not the order', () => {
    const a = build(messyTree().list()).graph.source.snapshot;
    const t = messyTree();
    t.person('I9099', { given: 'Extra', surname: 'Person', gender: 1, birth: { when: { year: 1999 } } });
    assert.notEqual(build(t.list()).graph.source.snapshot, a);
  });
  it('keys are sorted and the file ends with one newline', () => {
    assert.ok(base.endsWith('}\n') && !base.endsWith('\n\n'));
    assert.ok(base.startsWith('{"attribution":'));
  });
});

describe('unions and edges', () => {
  it('edges are exactly what the unions derive', () => {
    const { graph } = build(messyTree().list());
    assert.deepEqual(graph.edges, deriveEdges(graph.unions));
  });
  it('rel is keyed by parent id', () => {
    const { graph } = build(messyTree().list());
    const u = graph.unions.find((x) => x.id === 'F9001');
    assert.deepEqual(u.children[0], { id: 'I9003', rel: { I9001: 'birth', I9002: 'adopted' } });
    const e = graph.edges.filter((x) => x.kind === 'parent' && x.t === 'I9003');
    assert.deepEqual(e.map((x) => [x.s, x.rel]), [['I9001', 'birth'], ['I9002', 'adopted']]);
  });
});

describe('allowlist projection', () => {
  it('copies nothing outside the table: no notes, addresses, urls, attributes, handles or marker text', () => {
    const { graph } = build(messyTree().list());
    const { source, ...rest } = graph; // source.builder is "hfy-graph@x.y.z"
    const text = JSON.stringify(rest);
    for (const banned of [SENTINEL, 'h_I9', 'h_P9', 'h_F9', 'example.invalid', '555-010', 'Nowhere', '@', 'http']) {
      assert.ok(!text.includes(banned), `output contains ${banned}`);
    }
    assert.deepEqual(Object.keys(graph.people[0]).sort(), ['birthPlace', 'birthYear', 'component', 'deathPlace', 'deathYear', 'face', 'generation', 'given', 'id', 'living', 'name', 'sex', 'surname', 'yearApprox']);
  });

  it('names: "given surname" from the primary surname only, or "unknown"', () => {
    const { graph } = build(messyTree().list());
    assert.equal(person(graph, 'I9001').name, 'Ada Example');
    assert.equal(person(graph, 'I9001').surname, 'Example');
    assert.equal(person(graph, 'I9017').name, 'unknown');
  });

  it('sex: f, m, and u for both unknown and other', () => {
    const t = new Tree();
    [0, 1, 2, 3].forEach((g, i) => t.person(`I${9100 + i}`, { gender: g }));
    const { graph } = build(t.list());
    assert.deepEqual(graph.people.map((p) => p.sex), ['f', 'm', 'u', 'u']);
  });

  it('accepts enums serialized as bare integers', () => {
    const objs = [
      { _class: 'Person', handle: 'a', gramps_id: 'I1', gender: 0, primary_name: { first_name: 'Bare', surname_list: [{ surname: 'Int', primary: true }] }, event_ref_list: [{ ref: 'e', role: 1 }], birth_ref_index: 0, death_ref_index: -1 },
      { _class: 'Event', handle: 'e', gramps_id: 'E1', type: 12, date: { modifier: 0, quality: 0, dateval: [4, 5, 1901, false] }, place: '' },
    ];
    const { graph } = build(objs);
    assert.equal(graph.people[0].sex, 'f');
    assert.equal(graph.people[0].birthYear, 1901);
  });

  describe('years only', () => {
    const one = (when, extra = {}) => {
      const t = new Tree();
      t.person('I1', { given: 'Yr', surname: 'Test', birth: { when }, death: extra.death });
      return build(t.list());
    };
    it('reads dateval[2] and nothing else of the date', () => {
      const { graph } = one({ year: 1901, month: 9, day: 30 });
      assert.equal(graph.people[0].birthYear, 1901);
      assert.ok(!JSON.stringify(graph).includes('1901-'));
    });
    it('a text-only date and a zero year are null', () => {
      assert.equal(one({ modifier: 6, text: 'sometime', year: 0 }).graph.people[0].birthYear, null);
      assert.equal(one({ year: 0 }).graph.people[0].birthYear, null);
    });
    it('a sort value or a future year can never become a year', () => {
      const r = one({ year: 2400100 });
      assert.equal(r.graph.people[0].birthYear, null);
      assert.ok(r.report.warnings.some((w) => w.code === 'YEAR_OUT_OF_RANGE'));
      assert.equal(one({ year: NOW.getUTCFullYear() + 1 }).graph.people[0].birthYear, null);
      assert.equal(one({ year: 999 }).graph.people[0].birthYear, null);
    });
    it('yearApprox follows modifier and quality', () => {
      assert.equal(one({ year: 1901 }).graph.people[0].yearApprox, false);
      for (const modifier of [1, 2, 3, 4, 5]) assert.equal(one({ year: 1901, modifier }).graph.people[0].yearApprox, true, `modifier ${modifier}`);
      for (const quality of [1, 2]) assert.equal(one({ year: 1901, quality }).graph.people[0].yearApprox, true, `quality ${quality}`);
    });
    it('a range or span gives its start year', () => {
      assert.equal(one({ year: 1901, modifier: 4 }).graph.people[0].birthYear, 1901);
    });
  });

  describe('living follows rule L', () => {
    it('death_ref_index == -1 is living, and deathYear is null', () => {
      const t = new Tree();
      t.person('I1', { given: 'Liv', surname: 'Ing', birth: { when: { year: 1990 } } });
      const p = build(t.list()).graph.people[0];
      assert.equal(p.living, true);
      assert.equal(p.deathYear, null);
    });
    it('a death-typed event that is not the death_ref does not make someone dead, and it is not emitted', () => {
      const t = new Tree();
      t.person('I1', { given: 'Liv', surname: 'Ing', birth: { when: { year: 1990 } }, extra: [{ type: 13, when: { year: 2020 } }] });
      const { graph, report } = build(t.list());
      assert.equal(graph.people[0].living, true);
      assert.equal(graph.people[0].deathYear, null);
      assert.ok(!graph.events.some((e) => e.type === 'death'));
      assert.ok(report.warnings.some((w) => w.code === 'LIVING_DEATH_EVENT_DROPPED'));
    });
    it('a death_ref makes the person not living even when its date is unreadable', () => {
      const t = new Tree();
      t.person('I1', { given: 'Gone', surname: 'Away', birth: { when: { year: 1900 } }, death: { when: { modifier: 6, text: 'x', year: 0 } } });
      const p = build(t.list()).graph.people[0];
      assert.equal(p.living, false);
      assert.equal(p.deathYear, null);
    });
    describe('a living person keeps only birth, marriage, divorce, education, graduation and degree events (VIZ-D5)', () => {
      const living = (extra) => {
        const t = new Tree();
        t.place('P1', { name: 'Riverton', type: 4 });
        t.person('I1', { given: 'Liv', surname: 'Ing', birth: { when: { year: 1990 }, place: 'P1' }, extra: extra.map((x) => ({ place: 'P1', when: { year: 2015 }, ...x })) });
        return build(t.list());
      };
      const types = (r) => r.graph.events.map((e) => e.type);
      it('drops a custom-typed "Home" event, Medical Information and Cause of Death (no year, no place)', () => {
        const r = living([{ type: 0 }, { type: 32 }, { type: 4 }]); // custom, MEDICAL (32), CAUSE (4)
        assert.deepEqual(types(r), ['birth']);
        assert.deepEqual(r.graph.events[0], { person: 'I1', type: 'birth', year: 1990, place: 'P1' });
        assert.deepEqual(r.report.warnings.find((w) => w.code === 'LIVING_EVENT_DROPPED').ids, ['I1']);
      });
      it('drops occupation, military service, emigration, immigration and cremation as well', () => {
        assert.deepEqual(types(living([{ type: 37 }, { type: 33 }, { type: 28 }, { type: 30 }, { type: 11 }])), ['birth']);
      });
      it('keeps marriage, divorce, education, graduation and degree', () => {
        const r = living([{ type: 1 }, { type: 7 }, { type: 26 }, { type: 31 }, { type: 25 }]);
        assert.deepEqual(types(r).sort(), ['birth', 'degree', 'divorce', 'education', 'graduation', 'marriage']);
      });
      it('drops burial like death, with the same warning, and deathYear stays null', () => {
        const r = living([{ type: 19 }, { type: 13 }]);
        assert.deepEqual(types(r), ['birth']);
        assert.equal(r.graph.people[0].deathYear, null);
        assert.deepEqual(r.report.warnings.find((w) => w.code === 'LIVING_DEATH_EVENT_DROPPED').ids, ['I1']);
      });
      it('a person who is NOT living keeps burial, custom and every other event', () => {
        const t = new Tree();
        t.person('I1', { given: 'Gone', surname: 'Away', birth: { when: { year: 1900 } }, death: { when: { year: 1970 } }, extra: [{ type: 19, when: { year: 1970 } }, { type: 0, when: { year: 1930 } }, { type: 37, when: { year: 1920 } }] });
        assert.deepEqual(build(t.list()).graph.events.map((e) => e.type).sort(), ['birth', 'burial', 'death', 'occupation', 'other']);
      });
      it('a living spouse keeps the family marriage event but not family events of other types', () => {
        const t = new Tree();
        t.person('I1', { given: 'Liv', surname: 'One', birth: { when: { year: 1990 } } });
        t.person('I2', { given: 'Liv', surname: 'Two', birth: { when: { year: 1991 } } });
        t.family('F1', { father: 'I1', mother: 'I2', events: [{ type: 1, when: { year: 2015 } }, { type: 42, when: { year: 2016 } }, { type: 0, when: { year: 2017 } }] });
        assert.deepEqual([...new Set(build(t.list()).graph.events.map((e) => e.type))].sort(), ['birth', 'marriage']);
      });
    });
    it('residence events of living people are dropped by default and kept on request', () => {
      const t = new Tree();
      t.person('I1', { given: 'Liv', surname: 'Ing', birth: { when: { year: 1990 } }, extra: [{ type: 42, when: { year: 2015 } }] });
      assert.ok(!build(t.list()).graph.events.some((e) => e.type === 'residence'));
      assert.ok(build(t.list(), { keepLivingResidence: true }).graph.events.some((e) => e.type === 'residence'));
    });
  });

  describe('places (rule S)', () => {
    const withPlaces = (placeSetup, birthPlace) => {
      const t = new Tree();
      placeSetup(t);
      t.person('I1', { given: 'Pl', surname: 'Ace', birth: { when: { year: 1900 }, place: birthPlace } });
      return build(t.list());
    };
    it('address-grade types collapse to the enclosing settlement with a warning', () => {
      for (const [type, custom] of [[7, ''], [11, ''], [18, ''], [19, ''], [20, ''], [0, 'My Home Place']]) {
        const r = withPlaces((t) => t.place('P1', { name: 'Town', type: 4 }).place('P2', { name: 'Spot', type, customType: custom, parent: 'P1' }), 'P2');
        assert.equal(r.graph.people[0].birthPlace, 'P1', `type ${type}${custom}`);
        assert.deepEqual(r.graph.places.map((p) => p.name), ['Town']);
        assert.ok(r.report.warnings.some((w) => w.code === 'ADDRESS_GRADE_PLACE_COLLAPSED'));
      }
    });
    it('an address-grade place with no settlement above it gives null', () => {
      const r = withPlaces((t) => t.place('P2', { name: 'Spot', type: 7 }), 'P2');
      assert.equal(r.graph.people[0].birthPlace, null);
      assert.equal(r.graph.places.length, 0);
    });
    it('a private place gives null, not its parent; a private ancestor is skipped', () => {
      let r = withPlaces((t) => t.place('P1', { name: 'Town', type: 4 }).place('P2', { name: 'Secret', type: 4, parent: 'P1', private: true }), 'P2');
      assert.equal(r.graph.people[0].birthPlace, null);
      r = withPlaces((t) => t.place('P0', { name: 'Land', type: 1 }).place('P1', { name: 'Hidden', type: 2, parent: 'P0', private: true }).place('P2', { name: 'Town', type: 4, parent: 'P1' }), 'P2');
      assert.equal(r.graph.places.find((p) => p.id === 'P2').parent, 'P0');
    });
    it('only referenced places and their ancestors are emitted', () => {
      const r = withPlaces((t) => t.place('P1', { name: 'Land', type: 1 }).place('P2', { name: 'Town', type: 4, parent: 'P1' }).place('P3', { name: 'Unused', type: 4, parent: 'P1' }), 'P2');
      assert.deepEqual(r.graph.places.map((p) => p.id), ['P1', 'P2']);
    });
    it('coordinates round to 2 decimals, parse degrees, and unparseable ones are null with a warning', () => {
      const r = withPlaces((t) => t.place('P1', { name: 'A', type: 4, lat: '40.12678', long: '-100.99501' }).place('P3', { name: 'B', type: 4, lat: 'north', long: '1' }), 'P1');
      const a = r.graph.places.find((p) => p.id === 'P1');
      assert.deepEqual([a.lat, a.lon, a.geo], [40.13, -101, 'gramps']);
      const t2 = new Tree();
      t2.place('P3', { name: 'B', type: 4, lat: 'north', long: '1' });
      t2.person('I1', { given: 'X', surname: 'Y', birth: { when: { year: 1900 }, place: 'P3' } });
      const r2 = build(t2.list());
      assert.deepEqual([r2.graph.places[0].lat, r2.graph.places[0].lon, r2.graph.places[0].geo], [null, null, null]);
      assert.ok(r2.report.warnings.some((w) => w.code === 'COORD_UNPARSEABLE'));
    });
    it('a cycle in the place hierarchy terminates', () => {
      const r = withPlaces((t) => t.place('P1', { name: 'A', type: 4, parent: 'P2' }).place('P2', { name: 'B', type: 4, parent: 'P1' }), 'P1');
      assert.equal(r.graph.places.length, 2);
      assert.equal(verifyGraph(r.graph, { now: NOW }).ok, true);
    });
  });

  describe('events', () => {
    it('keeps the allowlisted roles and types, maps the rest to other, and never emits a description', () => {
      const { graph } = build(messyTree().list());
      const ada = graph.events.filter((e) => e.person === 'I9001').map((e) => e.type);
      assert.deepEqual(ada, ['birth', 'other', 'marriage', 'occupation', 'residence', 'death']);
      assert.ok(!graph.events.some((e) => e.person === 'I9001' && e.year === 1900)); // witness role
      assert.ok(!graph.events.some((e) => e.person === 'I9001' && e.year === 1895)); // private event
      assert.deepEqual(Object.keys(graph.events[0]).sort(), ['person', 'place', 'type', 'year']);
    });
    it('a residence on a farm collapses to the settlement', () => {
      const { graph } = build(messyTree().list());
      assert.equal(graph.events.find((e) => e.person === 'I9001' && e.type === 'residence').place, 'P9002');
    });
  });
});

describe('self-referencing unions', () => {
  it('a child who is also a partner of the same family is dropped with a warning', () => {
    const t = new Tree();
    t.person('I1', { given: 'Pa', surname: 'One', birth: { when: { year: 1950 } } });
    t.person('I2', { given: 'Ma', surname: 'Two', birth: { when: { year: 1952 } } });
    t.person('I3', { given: 'Kid', surname: 'Three', birth: { when: { year: 1980 } } });
    t.family('F1', { father: 'I1', mother: 'I2', children: [{ id: 'I1' }, { id: 'I3' }] });
    const { graph, report } = build(t.list());
    assert.deepEqual(graph.unions[0].children.map((c) => c.id), ['I3']);
    assert.deepEqual(report.warnings.find((w) => w.code === 'SELF_UNION_REF_DROPPED').ids, ['F1']);
    assert.equal(verifyGraph(graph, { now: NOW }).ok, true);
  });
  it('the same person as father and mother is one partner, with a warning', () => {
    const t = new Tree();
    t.person('I1', { given: 'Pa', surname: 'One', birth: { when: { year: 1950 } } });
    t.person('I3', { given: 'Kid', surname: 'Three', birth: { when: { year: 1980 } } });
    t.family('F1', { father: 'I1', mother: 'I1', children: [{ id: 'I3' }] });
    const { graph, report } = build(t.list());
    assert.deepEqual(graph.unions[0].partners, ['I1']);
    assert.equal(graph.edges.filter((e) => e.s === e.t).length, 0);
    assert.ok(report.warnings.some((w) => w.code === 'SELF_UNION_REF_DROPPED'));
  });
});

describe('address-like place names', () => {
  it('collapse to the enclosing settlement whatever the place type says', () => {
    for (const [name, type] of [['12 Elm Street', 4], ['Birch Road', 6], ['7 Oak', -1], ['Pine Ave', 0]]) {
      const t = new Tree();
      t.place('P1', { name: 'Riverton', type: 4 }).place('P2', { name, type, parent: 'P1' });
      t.person('I1', { given: 'Pl', surname: 'Ace', birth: { when: { year: 1900 }, place: 'P2' } });
      const r = build(t.list());
      assert.equal(r.graph.people[0].birthPlace, 'P1', name);
      assert.deepEqual(r.graph.places.map((p) => p.name), ['Riverton']);
      assert.ok(r.report.warnings.some((w) => w.code === 'ADDRESS_GRADE_PLACE_COLLAPSED'), name);
    }
  });
  it('an ordinary place that merely contains a street word as its first word stays', () => {
    const t = new Tree();
    t.place('P1', { name: 'Lane County', type: 3 });
    t.person('I1', { given: 'Pl', surname: 'Ace', birth: { when: { year: 1900 }, place: 'P1' } });
    assert.equal(build(t.list()).graph.people[0].birthPlace, 'P1');
  });
});

describe('the clock', () => {
  it('an invalid now is INPUT_MISSING (exit 2), not a RangeError', () => {
    for (const now of [new Date('nope'), 'nope', NaN]) {
      assert.throws(() => build(messyTree().list(), { now }), (e) => e instanceof GraphError && e.code === 'INPUT_MISSING' && e.exitCode === 2);
    }
  });
});

/**
 * A synthetic tree of n people (invented names and ids, seeded by index only) with 40% of them in two-partner families of two
 * children, and ONE tagged photo per person: photo k tags person k and up to three neighbours (1 to 4 people, rect or whole
 * photo), as in the viz ADR's photoEdges measurement.
 */
function synthTree(n) {
  const t = new Tree();
  t.place('P1', { name: 'Examplestate', type: 2 }).place('P2', { name: 'Riverton', type: 4, parent: 'P1', lat: '40.01', long: '-100.02' }).place('P3', { name: 'Lakeside', type: 16, parent: 'P1', lat: '41.5', long: '-99.5' });
  const idOf = (i) => `I${String(i).padStart(5, '0')}`;
  for (let i = 0; i < n; i++) {
    const year = 1800 + (i % 200);
    t.person(idOf(i), {
      given: `Given${i % 97}`, surname: `Family${i % 41}`, gender: i % 3,
      birth: { when: { year }, place: i % 2 ? 'P2' : 'P3' },
      death: i % 5 === 0 ? undefined : { when: { year: Math.min(year + 60, 2020) }, place: 'P2' },
      extra: [{ type: 37, when: { year: year + 25 } }, { type: 26, when: { year: year + 18 }, place: 'P3' }],
    });
  }
  // families of two partners and two children each (40% of the people are partners)
  const families = Math.floor(n * 0.4);
  let child = Math.floor(n * 0.8);
  for (let f = 0; f < families; f++) {
    const kids = child + 2 <= n ? [{ id: idOf(child++) }, { id: idOf(child++) }] : [];
    t.family(`F${String(f).padStart(5, '0')}`, { father: idOf(f * 2), mother: idOf(f * 2 + 1), children: kids, events: [{ type: 1, when: { year: 1820 + (f % 150) }, place: 'P2' }] });
  }
  const tags = new Map(); // person id -> MediaRefs
  const medias = [];
  for (let k = 0; k < n; k++) {
    const oid = `O${String(k).padStart(5, '0')}`;
    medias.push({ _class: 'Media', handle: `h_${oid}`, gramps_id: oid, path: `${SENTINEL}/${oid}.jpg`, desc: `${SENTINEL}_DESC`, private: false });
    for (let j = 0; j <= k % 4; j++) {
      const who = idOf((k + j * 7) % n);
      if (!tags.has(who)) tags.set(who, []);
      tags.get(who).push({ _class: 'MediaRef', ref: `h_${oid}`, rect: j % 2 ? [10 + j, 10, 60, 60] : null, private: false });
    }
  }
  const objects = t.list().map((o) => (o._class === 'Person' ? { ...o, media_list: tags.get(o.gramps_id) ?? [] } : o));
  return [...objects, ...medias];
}

describe('size with photoEdges (one tagged photo per person)', () => {
  it('231 synthetic people: builds, verifies and fits 25 KB gzipped, photoEdges included', (t) => {
    const { graph } = build(synthTree(231));
    assert.equal(graph.people.length, 231);
    assert.equal(graph.photoEdges.length, 231); // every photo has at least one tagged person
    assert.deepEqual(verifyGraph(graph, { now: NOW }), { ok: true, violations: [] });
    const gz = assertSizeBudget(stringify(graph), 25 * 1024); // throws SIZE_BUDGET over 25 KiB
    t.diagnostic(`231 people: ${gz} bytes gzipped`);
    assert.ok(gz > 0 && gz <= 25 * 1024, `${gz} bytes gzipped`);
  });

  it('2,000 synthetic people: builds, verifies and fits the 150 KiB gzip budget, photoEdges included', (t) => {
    const N = 2000;
    const { graph } = build(synthTree(N));
    assert.equal(graph.people.length, N);
    assert.equal(graph.photoEdges.length, N);
    assert.deepEqual(verifyGraph(graph, { now: NOW }), { ok: true, violations: [] });
    const gz = assertSizeBudget(stringify(graph)); // throws SIZE_BUDGET over 150 KiB
    t.diagnostic(`2,000 people: ${gz} bytes gzipped`);
    assert.ok(gz > 0 && gz <= 150 * 1024, `${gz} bytes gzipped`);
  });

  it('the block really is in the measured file, and the builder budget still throws SIZE_BUDGET (exit 3) over 150 KiB', () => {
    const { graph } = build(synthTree(231));
    const text = stringify(graph);
    assert.ok(text.includes('"photoEdges":[{"media":"O00000"'));
    assert.throws(() => assertSizeBudget(text, 1024), (e) => e instanceof GraphError && e.code === 'SIZE_BUDGET' && e.exitCode === 3);
    // a graph bloated past 150 KiB gzipped (random-looking ids do not compress) is refused by the default budget
    const bloated = structuredClone(graph);
    let x = 12345;
    const rnd = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0).toString(36);
    bloated.photoEdges = Array.from({ length: 40000 }, () => ({ media: `O${rnd()}${rnd()}`.slice(0, 20), people: [graph.people[0].id] }));
    assert.throws(() => assertSizeBudget(stringify(bloated)), (e) => e instanceof GraphError && e.code === 'SIZE_BUDGET' && e.exitCode === 3);
  });
});

describe('input shape', () => {
  const t = () => messyTree().list();
  const fails = (objects, re) => assert.throws(() => build(objects), (e) => e instanceof GraphError && e.code === 'SNAPSHOT_SHAPE' && e.exitCode === 7 && re.test(e.message));

  it('an unknown _class names the class and nothing else', () => fails([...t(), { _class: 'Bogus', handle: 'x' }], /unknown _class Bogus/));
  it('an object with no _class', () => fails([...t(), { handle: 'x' }], /no _class/));
  it('a missing core field names the field', () => fails([...t(), { _class: 'Person', handle: 'x' }], /Person\.gramps_id/));
  it('a missing death_ref_index names the field', () => fails([{ _class: 'Person', handle: 'x', gramps_id: 'I1', birth_ref_index: -1 }], /death_ref_index/));
  it('a schema other than 21 in the header', () => fails([{ _class: 'Header', schema_version: 22 }, ...t()], /schema/));
  it('accepts a header with schema 21', () => assert.doesNotThrow(() => build([{ _class: 'Header', schema_version: 21 }, ...t()])));
  it('duplicate handles', () => {
    const dup = t().find((o) => o._class === 'Person');
    fails([...t(), dup], /not unique/);
  });
  it('duplicate gramps ids', () => {
    const dup = { ...t().find((o) => o._class === 'Person'), handle: 'another' };
    fails([...t(), dup], /not unique/);
  });
  it('error messages never carry a value from the record', () => {
    const o = { _class: 'Person', handle: 'x', gramps_id: 'I1', birth_ref_index: -1, primary_name: { first_name: 'Secretname' } };
    assert.throws(() => build([o]), (e) => !/Secretname/.test(e.message));
  });
});
