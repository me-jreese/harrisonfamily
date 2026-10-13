// viz-geocode-offline: the offline matcher and its precedence, Natural Earth centroids, the checksum pins, the GeoNames
// attribution, a build with the network blocked, and fetch-gazetteer with a fake fetch. Synthetic gazetteer and places only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFamilyGraph } from '../src/build.mjs';
import { main } from '../src/cli.mjs';
import { main as fetchMain } from '../bin/fetch-gazetteer.mjs';
import { GAZETTEER_FILES, loadGazetteer, readLock, sha256 } from '../src/gazetteer.mjs';
import { GEONAMES_CREDIT, fold } from '../src/geocode.mjs';
import { readDbf, readZip } from '../src/archive.mjs';
import { verifyGraph } from '../src/verify.mjs';
import { Tree } from './fixtures/gramps.mjs';
import { OVERRIDES, dbf, writeGazetteer, zip } from './fixtures/gazetteer.mjs';
import { GENERATED_AT, HERE, NOW, scratch, writeJsonl } from './helpers.mjs';

const COUNTRY = 1, STATE = 2, COUNTY = 3, CITY = 4, REGION = 9;

/** A gazetteer directory and its lock file in a scratch directory. */
function gazetteerDir(opts) {
  const root = scratch('hfy-gaz-');
  const dir = join(root, 'cache');
  mkdirSync(dir);
  const lock = writeGazetteer(dir, opts);
  const lockPath = join(root, 'gazetteer.lock.json');
  writeFileSync(lockPath, JSON.stringify(lock));
  return { dir, lockPath };
}

/** Synthetic places, each used by one person's birth so the projection keeps it. */
function tree() {
  const t = new Tree();
  const places = [
    ['P100', 'Examplestan', COUNTRY, null],
    ['P101', 'Northshire', STATE, 'P100'],
    ['P102', 'Exampleton', CITY, 'P101'], // admin1 parent: 1001
    ['P103', 'Upper Example', COUNTY, 'P101'], // an admin2, no centroid source
    ['P104', 'Exampleton', CITY, 'P103'], // admin2 parent: 1001
    ['P105', 'Exampleton', CITY, 'P100'], // country only: 1001 and 1002 within 2x
    ['P106', 'Southmark', STATE, 'P100'],
    ['P107', 'Exampleton', CITY, 'P106'], // 1002
    ['P108', 'Altexample', CITY, 'P100'], // an alternate name of 1003
    ['P109', 'Harbourexample', CITY, 'P100'], // override: geonameId 1003
    ['P110', 'Sankt Exämpel', CITY, 'P106'], // override: search "Sankt Exaempel" (1004)
    ['P112', 'Sampleland', COUNTRY, null],
    ['P113', 'Samplelakes', STATE, 'P112'],
    ['P114', 'Ézampléville', CITY, 'P113'], // accent-folded to 1005
    ['P115', 'Samplevale', CITY, 'P113'], // 1007 beats 1006 by more than 2x
    ['P116', 'Twin Example', CITY, 'P101'], // equal populations
    ['P117', 'Nowhereville', CITY, 'P100'], // no candidate
    ['P118', 'Upper Example Region', REGION, 'P100'], // override: GeoNames files it as admin2 XE.01.001
    ['P119', 'Exampleton', CITY, 'P118'], // so this is 1001
    ['P120', 'Republic of Examplestan', COUNTRY, null], // override: country alias
    ['P123', 'Nowhere Two', CITY, 'P100'], // reviewed coordinates
    ['P124', 'Exampleton', CITY, 'P101'], // reviewed beats the GeoNames match
    ['P125', 'Примерград', CITY, 'P113'], // a non-Latin name: 1011
    ['P126', 'EXAMPLE COUNTY', COUNTY, 'P101'], // no match: an area without a point
  ];
  for (const [id, name, type, parent] of places) t.place(id, { name, type, parent });
  t.place('P122', { name: 'Exampleton', type: CITY, parent: 'P101', lat: '1.5', long: '2.5' }); // Gramps lat/long wins
  let n = 0;
  for (const id of [...places.map((p) => p[0]), 'P122']) t.person(`I${9100 + ++n}`, { birth: { when: { year: 1900 }, place: id } });
  return t;
}

const REVIEWED = { version: 1, places: { P123: { lat: 3.14159, lon: -4.2 }, P124: { lat: 7.777, lon: 8.888 } } };

function build(gazetteer) {
  return buildFamilyGraph(tree().list(), { now: NOW, generatedAt: GENERATED_AT, gazetteer });
}
const at = (graph, id) => {
  const p = graph.places.find((x) => x.id === id);
  return p && [p.lat, p.lon, p.geo];
};
const warn = (report, code) => (report.warnings.find((w) => w.code === code) || { ids: [] }).ids;

describe('precedence and matching (synthetic gazetteer)', () => {
  const { dir, lockPath } = gazetteerDir({ overrides: OVERRIDES, reviewed: REVIEWED });
  const { graph, report } = build(loadGazetteer(dir, { lockPath }));

  it('Gramps lat/long first, then the reviewed coordinates, then the GeoNames match, then null (AC2)', () => {
    assert.deepEqual(at(graph, 'P122'), [1.5, 2.5, 'gramps']);
    assert.deepEqual(at(graph, 'P123'), [3.14, -4.2, 'geonames']);
    assert.deepEqual(at(graph, 'P124'), [7.78, 8.89, 'geonames']);
    assert.deepEqual(at(graph, 'P102'), [10.12, 20.46, 'geonames']);
    assert.deepEqual(at(graph, 'P117'), [null, null, null]);
  });

  it('country first, then a parent at admin1 or admin2, then name, asciiname or alternate names, folded (AC2)', () => {
    assert.deepEqual(at(graph, 'P104'), [10.12, 20.46, 'geonames'], 'parent matched as admin2');
    assert.deepEqual(at(graph, 'P107'), [11.5, 21.5, 'geonames'], 'parent matched as admin1');
    assert.deepEqual(at(graph, 'P108'), [12, -23, 'geonames'], 'alternate name');
    assert.deepEqual(at(graph, 'P114'), [-5.56, 30.11, 'geonames'], 'accent- and case-folded');
    assert.deepEqual(at(graph, 'P125'), [55, 37, 'geonames'], 'a non-Latin name');
    assert.deepEqual(at(graph, 'P115'), [-6.5, 31.5, 'geonames'], 'the most populous by more than 2x');
  });

  it('the override table: a region GeoNames files as admin2, a city by another name, a non-ASCII spelling, a country alias (AC2)', () => {
    assert.deepEqual(at(graph, 'P119'), [10.12, 20.46, 'geonames']);
    assert.deepEqual(at(graph, 'P109'), [12, -23, 'geonames']);
    assert.deepEqual(at(graph, 'P110'), [13.33, 23.33, 'geonames']);
    assert.deepEqual(at(graph, 'P120'), [15.01, 25.01, 'naturalearth']);
    // without the table the same places do not resolve
    const plain = gazetteerDir({});
    const g2 = build(loadGazetteer(plain.dir, { lockPath: plain.lockPath })).graph;
    assert.deepEqual(at(g2, 'P109'), [null, null, null]);
    assert.deepEqual(at(g2, 'P110'), [null, null, null]);
    assert.deepEqual(at(g2, 'P120'), [null, null, null]);
  });

  it('the top two within 2x is AMBIGUOUS; no candidate is UNRESOLVED; both leave null (AC2)', () => {
    assert.deepEqual(at(graph, 'P105'), [null, null, null]);
    assert.deepEqual(at(graph, 'P116'), [null, null, null]);
    assert.deepEqual(warn(report, 'AMBIGUOUS_PLACE'), ['P105', 'P116']);
    assert.deepEqual(warn(report, 'UNRESOLVED_PLACE'), ['P117']);
  });

  it('state, province and country places take a Natural Earth centroid; an admin2 area has no point (AC3)', () => {
    assert.deepEqual(at(graph, 'P100'), [15.01, 25.01, 'naturalearth']);
    assert.deepEqual(at(graph, 'P101'), [12.35, 22.22, 'naturalearth']);
    assert.deepEqual(at(graph, 'P113'), [-6, 31, 'naturalearth']);
    assert.deepEqual(at(graph, 'P103'), [null, null, null]);
    assert.deepEqual(at(graph, 'P118'), [null, null, null]);
    assert.deepEqual(at(graph, 'P126'), [null, null, null]);
  });

  it('coordinates have 2 decimals and the graph verifies', () => {
    for (const p of graph.places) for (const v of [p.lat, p.lon]) if (v !== null) assert.match(String(v), /^-?\d+(\.\d{1,2})?$/);
    assert.deepEqual(verifyGraph(graph, { now: NOW }).violations, []);
  });

  it('the local report has geonameId, population and runner-up per place, and none of it is in the graph (AC4)', () => {
    const row = (id) => report.geocode.find((e) => e.place === id);
    assert.deepEqual(row('P115'), { place: 'P115', status: 'geonames', lat: -6.5, lon: 31.5, geonameId: 1007, population: 100000, runnerUp: { geonameId: 1006, population: 1200 } });
    assert.deepEqual(row('P102').runnerUp, null);
    assert.deepEqual(row('P105'), { place: 'P105', status: 'ambiguous', candidates: [{ geonameId: 1001, population: 50000 }, { geonameId: 1002, population: 40000 }] });
    assert.equal(row('P123').status, 'reviewed');
    assert.equal(row('P122').status, 'gramps');
    assert.equal(row('P101').status, 'centroid');
    assert.ok(!JSON.stringify(graph).includes('geonameId'));
    assert.ok(!JSON.stringify(graph).includes('population'));
  });

  it('attribution.geonames is set when a GeoNames coordinate is used, and the credit text is fixed (AC6)', () => {
    assert.equal(graph.attribution.geonames, true);
    assert.equal(GEONAMES_CREDIT.text, 'Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified');
    assert.equal(GEONAMES_CREDIT.licence, 'https://creativecommons.org/licenses/by/4.0/');
  });
});

describe('attribution and degradation', () => {
  it('Natural Earth centroids alone do not need the GeoNames credit', () => {
    const { dir, lockPath } = gazetteerDir({});
    const t = new Tree().place('P1', { name: 'Examplestan', type: COUNTRY }).person('I1', { birth: { when: { year: 1900 }, place: 'P1' } });
    const { graph } = buildFamilyGraph(t.list(), { now: NOW, gazetteer: loadGazetteer(dir, { lockPath }) });
    assert.deepEqual(at(graph, 'P1'), [15.01, 25.01, 'naturalearth']);
    assert.equal(graph.attribution.geonames, false);
  });

  it('a missing gazetteer degrades to GAZETTEER_MISSING: Gramps coordinates only (AC5)', () => {
    assert.equal(loadGazetteer(join(HERE, 'no-such-gazetteer')), null);
    const { graph, report } = build(null);
    assert.deepEqual(at(graph, 'P122'), [1.5, 2.5, 'gramps']);
    assert.deepEqual(at(graph, 'P102'), [null, null, null]);
    assert.equal(graph.attribution.geonames, false);
    assert.ok(report.warnings.some((w) => w.code === 'GAZETTEER_MISSING'));
    // one pinned file missing is a missing gazetteer too
    const partial = gazetteerDir({});
    rmSync(join(partial.dir, 'admin2Codes.txt'));
    assert.equal(loadGazetteer(partial.dir, { lockPath: partial.lockPath }), null);
  });

  it('a cached file that differs from its pin is GAZETTEER_CHECKSUM (exit 8) and nothing is written', async () => {
    const { dir, lockPath } = gazetteerDir({});
    writeFileSync(join(dir, 'countryInfo.txt'), 'XE\tXEX\t990\tXE\tChanged\n');
    assert.throws(() => loadGazetteer(dir, { lockPath }), (e) => e.code === 'GAZETTEER_CHECKSUM' && e.exitCode === 8);
    const work = scratch();
    const input = writeJsonl(join(work, 'in.jsonl'), tree().list());
    const errs = [];
    const code = await main([input, '--gazetteer', dir, '--out', join(work, 'out'), '--report', join(work, 'r.json'), '--quiet'], {
      now: NOW, guard: null, gazetteerLock: lockPath, stderr: { write: (s) => errs.push(s) },
    });
    assert.equal(code, 8, errs.join(''));
    assert.match(errs.join(''), /^GAZETTEER_CHECKSUM:/);
    assert.equal(existsSync(join(work, 'out')), false);
  });

  it('the committed lock pins every gazetteer file with a sha256 and a retrieval date, and only dump URLs (AC1)', () => {
    const lock = readLock();
    assert.deepEqual(Object.keys(lock.files).sort(), GAZETTEER_FILES.map((f) => f.name).sort());
    for (const f of GAZETTEER_FILES) {
      assert.match(lock.files[f.name].sha256, /^[0-9a-f]{64}$/, f.name);
      assert.match(lock.files[f.name].retrieved, /^\d{4}-\d{2}-\d{2}$/, f.name);
      assert.equal(lock.files[f.name].url, f.url);
      assert.match(f.url, /^https:\/\/(download\.geonames\.org\/export\/dump\/|naciscdn\.org\/naturalearth\/)/);
    }
  });
});

describe('no network during a build (AC5)', () => {
  it('a build with fetch, http, https, net, tls and dns blocked still geocodes', async () => {
    const { dir, lockPath } = gazetteerDir({ overrides: OVERRIDES });
    const work = scratch();
    const input = writeJsonl(join(work, 'in.jsonl'), tree().list());
    const mods = await Promise.all(['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns'].map((m) => import(m)));
    const saved = [];
    const block = (obj, key) => {
      saved.push([obj, key, obj[key]]);
      obj[key] = () => {
        throw new Error(`network blocked: ${key}`);
      };
    };
    block(globalThis, 'fetch');
    for (const m of mods) for (const k of ['request', 'get', 'connect', 'createConnection', 'lookup']) if (typeof m.default[k] === 'function') block(m.default, k);
    let code;
    const errs = [];
    try {
      code = await main([input, '--gazetteer', dir, '--out', join(work, 'out'), '--report', join(work, 'r.json'), '--generated-at', GENERATED_AT, '--quiet'], {
        now: NOW, guard: null, gazetteerLock: lockPath, stderr: { write: (s) => errs.push(s) },
      });
    } finally {
      for (const [obj, key, v] of saved.reverse()) obj[key] = v;
    }
    assert.equal(code, 0, errs.join(''));
    const graph = JSON.parse(readFileSync(join(work, 'out', 'person', 'graph.json'), 'utf8'));
    assert.deepEqual(at(graph, 'P102'), [10.12, 20.46, 'geonames']);
    assert.equal(graph.attribution.geonames, true);
  });

  it('only bin/fetch-gazetteer.mjs can reach the network, and nothing calls the GeoNames web service', () => {
    const root = join(HERE, '..');
    const files = ['src', 'bin'].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.mjs')).map((f) => join(d, f)));
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8');
      assert.doesNotMatch(src, /(?:api|secure|ws)\.geonames\.org|geonames\.org\/(?:search|get|postal|find)/i, f);
      if (f === join('bin', 'fetch-gazetteer.mjs')) continue;
      assert.doesNotMatch(src, /\bfetch\s*\(|node:https?|node:net|node:tls|node:dns|XMLHttpRequest|WebSocket/, f);
    }
  });

  it('no gazetteer dump is tracked by git', () => {
    const r = spawnSync('git', ['ls-files', '--', '.'], { cwd: join(HERE, '..'), encoding: 'utf8' });
    if (r.status !== 0) return; // not a git checkout
    const names = new Set(GAZETTEER_FILES.map((f) => f.name.replace(/\.zip$/, '')));
    for (const f of r.stdout.split('\n').filter(Boolean)) {
      const base = f.split('/').pop().replace(/\.(zip|txt|dbf)$/, '');
      assert.ok(!names.has(base) && !/^cities\d+$/.test(base) && !/^ne_10m_/.test(base), `${f} looks like a gazetteer dump`);
    }
  });
});

describe('fetch-gazetteer (fake fetch, the only network path)', () => {
  const bodies = () => Object.fromEntries(GAZETTEER_FILES.map((f) => [f.url, Buffer.from(`synthetic ${f.name}`)]));
  const fakeFetch = (map, calls = []) => async (url) => {
    calls.push(url);
    const body = map[url];
    return { ok: !!body, status: body ? 200 : 404, headers: new Map([['last-modified', 'Tue, 13 Oct 2026 01:00:00 GMT']]), arrayBuffer: async () => body };
  };
  const quiet = () => ({ write: () => {} });

  it('pins every file on the first run, writes them into the cache, and calls only the dump URLs', async () => {
    const root = scratch();
    const dir = join(root, 'cache');
    const lockPath = join(root, 'lock.json');
    const calls = [];
    const code = await fetchMain(['--dir', dir, '--lock', lockPath], { fetch: fakeFetch(bodies(), calls), now: NOW, stderr: quiet() });
    assert.equal(code, 0);
    assert.deepEqual(calls, GAZETTEER_FILES.map((f) => f.url));
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const f of GAZETTEER_FILES) {
      assert.equal(lock.files[f.name].sha256, sha256(Buffer.from(`synthetic ${f.name}`)));
      assert.equal(lock.files[f.name].retrieved, '2026-10-20');
      assert.ok(existsSync(join(dir, f.name)));
    }
  });

  it('a changed download fails with GAZETTEER_CHECKSUM (exit 8) and writes nothing; --update re-pins it', async () => {
    const root = scratch();
    const dir = join(root, 'cache');
    const lockPath = join(root, 'lock.json');
    await fetchMain(['--dir', dir, '--lock', lockPath], { fetch: fakeFetch(bodies()), now: NOW, stderr: quiet() });
    const before = readFileSync(lockPath, 'utf8');
    const changed = bodies();
    changed[GAZETTEER_FILES[0].url] = Buffer.from('a newer snapshot');
    const errs = [];
    assert.equal(await fetchMain(['--dir', dir, '--lock', lockPath], { fetch: fakeFetch(changed), now: NOW, stderr: { write: (s) => errs.push(s) } }), 8);
    assert.match(errs.join(''), /^GAZETTEER_CHECKSUM:/);
    assert.equal(readFileSync(lockPath, 'utf8'), before);
    assert.equal(readFileSync(join(dir, GAZETTEER_FILES[0].name), 'utf8'), `synthetic ${GAZETTEER_FILES[0].name}`);
    const later = new Date('2026-11-01T00:00:00Z');
    assert.equal(await fetchMain(['--dir', dir, '--lock', lockPath, '--update'], { fetch: fakeFetch(changed), now: later, stderr: quiet() }), 0);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.files[GAZETTEER_FILES[0].name].sha256, sha256(Buffer.from('a newer snapshot')));
    assert.equal(lock.files[GAZETTEER_FILES[0].name].retrieved, '2026-11-01');
    assert.equal(lock.files[GAZETTEER_FILES[1].name].retrieved, '2026-10-20', 'an unchanged file keeps its date');
  });

  it('refuses a cache directory inside the repository', async () => {
    const errs = [];
    const code = await fetchMain(['--dir', join(HERE, 'cache'), '--lock', join(scratch(), 'l.json')], { fetch: fakeFetch(bodies()), stderr: { write: (s) => errs.push(s) } });
    assert.equal(code, 2);
    assert.match(errs.join(''), /outside the repository/);
  });
});

describe('archive readers', () => {
  it('reads stored and deflated ZIP entries and NUL-padded dBASE fields', () => {
    for (const deflate of [true, false]) {
      const z = readZip(zip([['a.txt', Buffer.from('hello')], ['dir/', Buffer.alloc(0)], ['b.dbf', dbf([['NAME', 8]], [{ NAME: 'xy' }])]], { deflate }));
      assert.equal(z.get('a.txt').toString(), 'hello');
      assert.deepEqual(readDbf(z.get('b.dbf')), [{ name: 'xy' }]);
    }
    assert.throws(() => readZip(Buffer.from('not a zip')), (e) => e.code === 'GAZETTEER_CHECKSUM');
  });

  it('fold() strips accents, case and punctuation', () => {
    assert.equal(fold('Ézampléville'), 'ezampleville');
    assert.equal(fold('Sankt-Exämpel  Straße'), 'sankt exampel strasse');
    assert.equal(fold("St. Example's"), 'st example s');
  });
});
