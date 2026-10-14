import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../src/errors.mjs';
import { defaultReportPath } from '../src/cli.mjs';
import { writeAtomic } from '../src/write.mjs';
import { Tree, messyTree, shuffled } from './fixtures/gramps.mjs';
import { GENERATED_AT, GOLDEN, run, scratch, writeJsonl } from './helpers.mjs';

const objects = () => messyTree().list();
const common = (dir) => ['--generated-at', GENERATED_AT, '--quiet', '--report', join(dir, 'report.json')];
const graphPath = (out) => join(out, 'person', 'graph.json');
const noTemp = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('exit codes match viz.md section 17', () => {
  it('the table', () => {
    assert.deepEqual(
      { INPUT_MISSING: 2, SIZE_BUDGET: 3, PRIVACY_VIOLATION: 4, LIVING_MISMATCH: 5, GRAMPS_OPEN: 6, SNAPSHOT_SHAPE: 7, GAZETTEER_CHECKSUM: 8 },
      Object.fromEntries(['INPUT_MISSING', 'SIZE_BUDGET', 'PRIVACY_VIOLATION', 'LIVING_MISMATCH', 'GRAMPS_OPEN', 'SNAPSHOT_SHAPE', 'GAZETTEER_CHECKSUM'].map((k) => [k, EXIT[k]])),
    );
  });

  it('2: no input, a missing file, an input with no people', () => {
    const dir = scratch();
    let r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^INPUT_MISSING:/);
    assert.match(r.stderr, /usage:/);
    r = run([join(dir, 'missing.jsonl')]);
    assert.equal(r.status, 2);
    r = run(['-'], { input: '' });
    assert.equal(r.status, 2);
    r = run(['--bogus-flag']);
    assert.equal(r.status, 2);
    r = run(['a', 'b']);
    assert.equal(r.status, 2);
  });

  it('3: the gzip size budget, and nothing is written', () => {
    const dir = scratch();
    const f = writeJsonl(join(dir, 'in.jsonl'), objects());
    const out = join(dir, 'out');
    const r = run([f, '--out', out, '--max-gzip-bytes', '100', ...common(dir)]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^SIZE_BUDGET:/);
    assert.equal(existsSync(out), false);
  });

  it('4: PRIVACY_VIOLATION names pointers, never the value, and writes nothing', () => {
    const dir = scratch();
    const t = messyTree();
    t.person('I9900', { given: 'Leaky', surname: 'Reachme@example.invalid', gender: 0 });
    const f = writeJsonl(join(dir, 'in.jsonl'), t.list());
    const out = join(dir, 'out');
    const r = run([f, '--out', out, ...common(dir)]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /^PRIVACY_VIOLATION:/);
    assert.match(r.stderr, /\/people\/\d+\/surname \[email\]/);
    assert.ok(!r.stderr.includes('Reachme') && !r.stderr.includes('example.invalid'));
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(dir, 'report.json')), false);
  });

  for (const [label, name] of [['a phone number', 'Call 555-010-0100'], ['a day-precise date', 'Born 03/14/1950'], ['a URL', 'see http://example.invalid']]) {
    it(`4: ${label} in a name`, () => {
      const dir = scratch();
      const t = new Tree();
      t.person('I1', { given: name, surname: 'Test', gender: 1 });
      const r = run([writeJsonl(join(dir, 'in.jsonl'), t.list()), '--out', join(dir, 'out'), ...common(dir)]);
      assert.equal(r.status, 4);
      assert.equal(existsSync(join(dir, 'out')), false);
    });
  }

  it('4 keeps the previous graph.json byte for byte', () => {
    const dir = scratch();
    const out = join(dir, 'out');
    let r = run([writeJsonl(join(dir, 'good.jsonl'), objects()), '--out', out, ...common(dir)]);
    assert.equal(r.status, 0, r.stderr);
    const before = readFileSync(graphPath(out));
    const t = messyTree();
    t.person('I9900', { given: 'a@b.invalid', surname: 'X' });
    r = run([writeJsonl(join(dir, 'bad.jsonl'), t.list()), '--out', out, ...common(dir)]);
    assert.equal(r.status, 4);
    assert.deepEqual(readFileSync(graphPath(out)), before);
    assert.deepEqual(readdirSync(join(out, 'person')), ['graph.json']);
  });

  it('5: LIVING_MISMATCH lists gramps ids and writes nothing', () => {
    const dir = scratch();
    const f = writeJsonl(join(dir, 'in.jsonl'), objects());
    const people = personDir(dir, { I9009: false }); // Gus is living in the graph
    const out = join(dir, 'out');
    const r = run([f, '--out', out, '--verify-against', people, ...common(dir)]);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /^LIVING_MISMATCH:/);
    assert.match(r.stderr, /ids: I9009$/m);
    assert.equal(existsSync(out), false);
  });

  it('6: GRAMPS_OPEN', () => {
    const copy = scratch();
    writeFileSync(join(copy, 'sqlite.db'), '');
    writeFileSync(join(copy, 'lock'), '');
    assert.equal(run(['--from-gramps-copy', join(copy, 'sqlite.db')]).status, 6);
  });

  it('7: SNAPSHOT_SHAPE for an unknown class, a bad line and a wrong header', () => {
    const dir = scratch();
    const bad = [
      [{ _class: 'Bogus', handle: 'x' }],
      [{ _class: 'Header', schema_version: 20 }, ...objects()],
    ];
    for (const objs of bad) {
      const r = run([writeJsonl(join(dir, 'in.jsonl'), objs), ...common(dir)]);
      assert.equal(r.status, 7, r.stderr);
      assert.match(r.stderr, /^SNAPSHOT_SHAPE:/);
    }
    writeFileSync(join(dir, 'broken.jsonl'), '{"_class":"Person"\n');
    assert.equal(run([join(dir, 'broken.jsonl'), ...common(dir)]).status, 7);
  });
});

function personDir(dir, overrides = {}) {
  // person/<id>.json files whose isLiving agrees with the golden graph, except for the overrides
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const people = join(dir, 'staging', 'person');
  mkdirSync(people, { recursive: true });
  for (const p of g.people) {
    writeFileSync(join(people, `${p.id}.json`), JSON.stringify({ grampsId: p.id, displayName: 'Synthetic Person', isLiving: overrides[p.id] ?? p.living }));
  }
  writeFileSync(join(people, 'index.json'), '[]');
  return people;
}

describe('deterministic, atomic writes', () => {
  it('shuffled input gives a byte-identical file through the CLI', () => {
    const dir = scratch();
    const outs = [];
    [0, 1, 2, 3].forEach((seed) => {
      const list = seed === 0 ? objects() : shuffled(objects(), seed * 7919);
      const out = join(dir, `out${seed}`);
      const r = run([writeJsonl(join(dir, `in${seed}.jsonl`), list), '--out', out, ...common(dir)]);
      assert.equal(r.status, 0, r.stderr);
      outs.push(readFileSync(graphPath(out)));
    });
    for (const o of outs) assert.deepEqual(o, outs[0]);
    assert.deepEqual(outs[0], readFileSync(GOLDEN)); // and it is the golden, bytes included
  });

  it('writes <out>/person/graph.json and a local report, and leaves no temp file', () => {
    const dir = scratch();
    const out = join(dir, 'out');
    const r = run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--out', out, ...common(dir)]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(out, 'person')), ['graph.json']);
    assert.deepEqual(readdirSync(out), ['person']); // no media/faces yet: that is viz-face-crops
    assert.deepEqual(noTemp(dir), []);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.ok(report.warnings.some((w) => w.code === 'PRIVATE_EXCLUDED'));
    assert.equal(statSync(graphPath(out)).mode & 0o777, 0o644);
  });

  it('without --out it is a dry run and writes nothing', () => {
    const dir = scratch();
    const before = readdirSync(dir);
    const r = run([writeJsonl(join(scratch(), 'in.jsonl'), objects()), '--generated-at', GENERATED_AT], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /dry run/);
    assert.deepEqual(readdirSync(dir), before);
  });

  describe('writeAtomic', () => {
    it('writes a temp file next to the target, flushes it, then renames it over the target', () => {
      const dir = scratch();
      const target = join(dir, 'sub', 'graph.json');
      const calls = [];
      const fs = new Proxy(
        {},
        { get: (_, name) => (...args) => (calls.push([name, args[0]]), realFs[name](...args)) },
      );
      writeAtomic(target, 'DATA', fs);
      const names = calls.map((c) => c[0]);
      assert.deepEqual(names.filter((n) => ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'].includes(n)), ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']);
      const rename = calls.find((c) => c[0] === 'renameSync');
      assert.notEqual(rename[1], target);
      assert.match(rename[1], /\.graph\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
      assert.equal(join(rename[1], '..'), join(target, '..')); // same directory, so the rename is atomic
      assert.equal(readFileSync(target, 'utf8'), 'DATA');
      assert.deepEqual(noTemp(join(dir, 'sub')), []);
    });
    it('a failed rename leaves the previous file untouched and removes the temp file', () => {
      const dir = scratch();
      const target = join(dir, 'graph.json');
      writeFileSync(target, 'OLD');
      const fs = new Proxy({}, { get: (_, name) => (...args) => { if (name === 'renameSync') throw new Error('disk full'); return realFs[name](...args); } });
      assert.throws(() => writeAtomic(target, 'NEW', fs), /disk full/);
      assert.equal(readFileSync(target, 'utf8'), 'OLD');
      assert.deepEqual(readdirSync(dir), ['graph.json']);
    });
    it('a failed write leaves the previous file untouched and removes the temp file', () => {
      const dir = scratch();
      const target = join(dir, 'graph.json');
      writeFileSync(target, 'OLD');
      const fs = new Proxy({}, { get: (_, name) => (...args) => { if (name === 'writeFileSync') throw new Error('io error'); return realFs[name](...args); } });
      assert.throws(() => writeAtomic(target, 'NEW', fs), /io error/);
      assert.equal(readFileSync(target, 'utf8'), 'OLD');
      assert.deepEqual(readdirSync(dir), ['graph.json']);
    });
  });
});

import * as realFs from 'node:fs';

describe('the default report path', () => {
  it('is <project>/workspace-local/graph-build-report.json, and HFY_PROJECT_DIR names the project', () => {
    assert.equal(defaultReportPath({ HFY_PROJECT_DIR: '/p/root' }), '/p/root/workspace-local/graph-build-report.json');
    assert.match(defaultReportPath({}), /\/workspace-local\/graph-build-report\.json$/);
  });
  it('the CLI writes there when --report is not given', () => {
    const dir = scratch();
    const project = join(dir, 'project');
    const r = run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--out', join(dir, 'out'), '--generated-at', GENERATED_AT, '--quiet'], { env: { HFY_PROJECT_DIR: project } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(project, 'workspace-local', 'graph-build-report.json')));
  });
});

describe('--verify and --verify-against', () => {
  it('--verify passes the golden and a freshly built file', () => {
    const dir = scratch();
    let r = run(['--verify', GOLDEN]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /verified/);
    const out = join(dir, 'out');
    run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--out', out, ...common(dir)]);
    assert.equal(run(['--verify', graphPath(out), '--quiet']).status, 0);
  });

  it('--verify passes a staged synthetic output that carries photoEdges, and rejects a handle smuggled into the block', () => {
    const dir = scratch();
    const photo = { _class: 'Media', handle: 'h_photo', gramps_id: 'O1', path: 'ZZSENT/photo.jpg', private: false };
    const tagged = objects().map((o) => (o._class === 'Person' ? { ...o, media_list: [{ _class: 'MediaRef', ref: 'h_photo', rect: null, private: false }] } : o));
    const out = join(dir, 'out');
    const r = run([writeJsonl(join(dir, 'in.jsonl'), [...tagged, photo]), '--out', out, ...common(dir)]);
    assert.equal(r.status, 0, r.stderr);
    const g = JSON.parse(readFileSync(graphPath(out), 'utf8'));
    assert.equal(g.minor, 3);
    assert.deepEqual(g.photoEdges.map((e) => e.media), ['O1']);
    assert.equal(run(['--verify', graphPath(out), '--quiet']).status, 0);
    g.photoEdges[0].handle = 'h_photo';
    const f = join(dir, 'tampered.json');
    writeFileSync(f, JSON.stringify(g));
    const bad = run(['--verify', f]);
    assert.equal(bad.status, 4);
    assert.match(bad.stderr, /\/photoEdges\/0\/handle \[schema:additionalProperties\]/);
  });

  it('--verify rejects a tampered file with exit 4 and pointers only', () => {
    const dir = scratch();
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    g.people[0].given = 'Born 1950-03-14';
    g.places[0].name = 'visit http://example.invalid';
    g.people[1].notes = 'extra';
    const f = join(dir, 'graph.json');
    writeFileSync(f, JSON.stringify(g));
    const r = run(['--verify', f]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /\/people\/0\/given \[day-precise-date\]/);
    assert.match(r.stderr, /\/places\/0\/name \[url\]/);
    assert.match(r.stderr, /\/people\/1\/notes \[schema:additionalProperties\]/);
    assert.ok(!r.stderr.includes('example.invalid') && !r.stderr.includes('1950-03-14'));
  });

  it('--verify: a file that is not JSON is exit 4, a missing file exit 2', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'x.json'), '{nope');
    assert.equal(run(['--verify', join(dir, 'x.json')]).status, 4);
    assert.equal(run(['--verify', join(dir, 'absent.json')]).status, 2);
  });

  it('--verify-against passes when every living flag agrees and tolerates missing person files', () => {
    const dir = scratch();
    const people = personDir(dir);
    assert.equal(run(['--verify', GOLDEN, '--verify-against', people]).status, 0);
    // drop a person file: not a mismatch, but it is reported
    realFs.rmSync(join(people, 'I9001.json'));
    const r = run(['--verify', GOLDEN, '--verify-against', people]);
    assert.equal(r.status, 0);
    const b = run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--verify-against', people, '--generated-at', GENERATED_AT]);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stderr, /1 people have no person file/);
  });

  it('--verify-against with an empty, wrong or unrelated directory fails with INPUT_MISSING (exit 2) instead of comparing nothing', () => {
    const dir = scratch();
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    const unrelated = join(dir, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'Z0001.json'), JSON.stringify({ isLiving: true }));
    for (const people of [empty, unrelated]) {
      let r = run(['--verify', GOLDEN, '--verify-against', people]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /nothing was compared/);
      r = run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--verify-against', people, '--out', join(dir, 'o'), ...common(dir)]);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(existsSync(join(dir, 'o')), false);
    }
  });

  it('the report records how many people were compared and how many had no person file', () => {
    const dir = scratch();
    const people = personDir(dir);
    realFs.rmSync(join(people, 'I9001.json'));
    const out = join(dir, 'out');
    const r = run([writeJsonl(join(dir, 'in.jsonl'), objects()), '--out', out, '--verify-against', people, ...common(dir)]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.livingCheck.missing, 1);
    assert.ok(report.livingCheck.compared > 0);
  });

  it('--verify-against fails with LIVING_MISMATCH (exit 5) and lists the ids, sorted', () => {
    const dir = scratch();
    const people = personDir(dir, { I9012: false, I9001: true });
    const r = run(['--verify', GOLDEN, '--verify-against', people]);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /^LIVING_MISMATCH:/);
    assert.match(r.stderr, /ids: I9001 I9012$/m);
  });

  it('an unreadable or non-boolean isLiving counts as a mismatch', () => {
    const dir = scratch();
    const people = personDir(dir);
    writeFileSync(join(people, 'I9002.json'), '{"isLiving":"no"}');
    writeFileSync(join(people, 'I9003.json'), 'not json');
    const r = run(['--verify', GOLDEN, '--verify-against', people]);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /ids: I9002 I9003$/m);
  });

  it('a missing person directory is exit 2', () => {
    assert.equal(run(['--verify', GOLDEN, '--verify-against', join(scratch(), 'nope')]).status, 2);
  });
});
