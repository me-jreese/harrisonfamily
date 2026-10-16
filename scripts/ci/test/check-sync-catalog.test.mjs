// Tests for scripts/ci/check-sync-catalog.mjs (HFY-TSK-150). CodeArtifact-free: runs in the io-kit CI `tests` list.
//   - the real map in this repository is complete, current and points at tests that exist
//   - a gap, an unknown row ID, a renamed test, a file outside the suites and a stale reference page each fail, in a throwaway repository
//   - the declaration finder reads Python methods, JavaScript titles (any quote style, no template titles) and infra labels
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, declaredNames, expectedIds, MAP_PATH, DOC_PATH, DOC_START, DOC_END, renderDoc } from '../check-sync-catalog.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'ci', 'check-sync-catalog.mjs');

/** A throwaway repository: one Python test, one JavaScript test and one infra label, every catalog row mapped to one of them. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hfy-catalog-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('gramps/tests/unit/test_a.py', 'class T:\n    def test_one(self):\n        pass\n');
  put('api/test/b.test.js', 'it("the title with \\"quotes\\"", () => {});\ndescribe("x", () => { it(\'single\', () => {}); });\n');
  put('scripts/infra/test/c.inc.sh', 'CURRENT="label one"\n');
  const tests = [
    { file: 'gramps/tests/unit/test_a.py', name: 'test_one' },
    { file: 'api/test/b.test.js', name: 'the title with "quotes"' },
    { file: 'scripts/infra/test/c.inc.sh', name: 'label one' },
  ];
  const rows = {};
  expectedIds().forEach((id, i) => {
    rows[id] = { failure: `row ${id}`, tests: [tests[i % tests.length]] };
  });
  const map = { version: 1, rows };
  put(MAP_PATH, JSON.stringify(map, null, 2));
  put(DOC_PATH, `# Page\n\n${DOC_START}\n\n${renderDoc(map)}\n\n${DOC_END}\n`);
  return { root, map, put, write: (m) => put(MAP_PATH, JSON.stringify(m, null, 2)) };
}

const problemsOf = (root) => check({ root }).problems;

describe('the repository', () => {
  it('maps all 74 rows to tests that exist, and the reference page is current', () => {
    const r = check({ root: REPO });
    assert.deepEqual(r.problems, []);
    assert.equal(r.rows, 74);
    assert.ok(r.tests >= 74);
  });

  it('expects D01-D52 and S01-S22', () => {
    const ids = expectedIds();
    assert.equal(ids.length, 74);
    assert.equal(ids[0], 'D01');
    assert.equal(ids[51], 'D52');
    assert.equal(ids[52], 'S01');
    assert.equal(ids[73], 'S22');
  });

  it('exits 0 from the command line with a one-line summary', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok, 74 rows \(D01-D52, S01-S22\)/);
  });

  it('carries no e-mail address or phone number in the map or the page', () => {
    for (const rel of [MAP_PATH, DOC_PATH]) {
      const text = readFileSync(join(REPO, rel), 'utf8');
      assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/, rel);
      assert.doesNotMatch(text, /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/, rel);
    }
  });
});

describe('a throwaway repository', () => {
  it('passes when every row has a test that exists', () => {
    const { root } = fixture();
    try {
      assert.deepEqual(problemsOf(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a gap: a row with no entry, with no tests, or with no failure text', () => {
    const f = fixture();
    try {
      delete f.map.rows.D07;
      f.map.rows.S03.tests = [];
      f.map.rows.D30.failure = '  ';
      f.write(f.map);
      const p = problemsOf(f.root);
      assert.ok(p.includes('gap: D07 has no entry'), p.join('\n'));
      assert.ok(p.includes('gap: S03 has no test'), p.join('\n'));
      assert.ok(p.includes('gap: D30 has no failure text'), p.join('\n'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails on an unknown row ID', () => {
    const f = fixture();
    try {
      f.map.rows.D53 = f.map.rows.D01;
      f.map.rows.S23 = f.map.rows.S01;
      f.map.rows.X01 = f.map.rows.S01;
      f.write(f.map);
      const p = problemsOf(f.root);
      for (const id of ['D53', 'S23', 'X01']) assert.ok(p.some((x) => x.startsWith(`unknown row ID ${id}`)), `${id}: ${p.join('\n')}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails on a renamed test, a missing file and a file outside the suites', () => {
    const f = fixture();
    try {
      f.put('gramps/tests/unit/test_a.py', 'class T:\n    def test_renamed(self):\n        pass\n');
      f.map.rows.D02.tests = [{ file: 'gramps/tests/unit/gone.py', name: 'test_one' }];
      f.map.rows.D03.tests = [{ file: 'scripts/ci/check-sync-catalog.mjs', name: 'check' }];
      f.map.rows.D04.tests = [{ file: '../outside.py', name: 'test_one' }];
      f.write(f.map);
      const p = problemsOf(f.root);
      assert.ok(p.some((x) => x.startsWith('D01: gramps/tests/unit/test_a.py :: test_one: no such test')), p.join('\n'));
      assert.ok(p.some((x) => x.includes('D02') && x.includes('does not exist')), p.join('\n'));
      assert.ok(p.some((x) => x.startsWith('D03') && x.includes('not in a test suite')), p.join('\n'));
      assert.ok(p.some((x) => x.startsWith('D04') && x.includes('inside the repository')), p.join('\n'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails when a test is listed twice or an entry has no name', () => {
    const f = fixture();
    try {
      const t = f.map.rows.D01.tests[0];
      f.map.rows.D01.tests = [t, t];
      f.map.rows.D02.tests = [{ file: 'gramps/tests/unit/test_a.py' }];
      f.write(f.map);
      const p = problemsOf(f.root);
      assert.ok(p.some((x) => x.includes('is listed twice')), p.join('\n'));
      assert.ok(p.some((x) => x.startsWith('D02: a test entry needs a file and a name')), p.join('\n'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails on a stale reference page, and --write-doc repairs it', () => {
    const f = fixture();
    try {
      const page = readFileSync(join(f.root, DOC_PATH), 'utf8').replace('| D01 |', '| D01 (edited by hand) |');
      writeFileSync(join(f.root, DOC_PATH), page);
      assert.ok(problemsOf(f.root).some((x) => x.includes('is not what the map renders')));
      const r = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--write-doc'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(problemsOf(f.root), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails when the page or its markers are missing, and when the map is not JSON', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, DOC_PATH), '# no markers\n');
      assert.ok(problemsOf(f.root).some((x) => x.includes('no table markers')));
      rmSync(join(f.root, DOC_PATH));
      assert.ok(problemsOf(f.root).some((x) => x.includes('is missing')));
      writeFileSync(join(f.root, MAP_PATH), '{not json');
      assert.ok(problemsOf(f.root)[0].includes('is not JSON'));
      rmSync(join(f.root, MAP_PATH));
      assert.ok(problemsOf(f.root)[0].includes('is missing'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('exits 1 from the command line and names every problem', () => {
    const f = fixture();
    try {
      delete f.map.rows.D01;
      f.write(f.map);
      const r = spawnSync(process.execPath, [SCRIPT, '--root', f.root], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /gap: D01 has no entry/);
      assert.match(r.stderr, /1 problem\(s\)/);
      assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe('declaredNames', () => {
  it('reads Python methods and functions, indented or not', () => {
    const names = declaredNames('x.py', 'def top(a):\n    pass\nclass T:\n    def test_a(self):\n        pass\n    async def test_b(self):\n        pass\n');
    assert.deepEqual([...names].sort(), ['test_a', 'test_b', 'top']);
  });

  it('reads JavaScript titles in any quote style and skips template titles', () => {
    const text = 'it("double", f);\ntest(\'single \\\'q\\\'\', f);\nit(`tick`, f);\nit(`has ${x}`, f);\nit.skip("skipped", f);\nit(\n  "wrapped",\n  f);\n';
    const names = declaredNames('x.test.js', text);
    assert.deepEqual([...names].sort(), ['double', "single 'q'", 'skipped', 'tick', 'wrapped']);
  });

  it('reads infra labels and nothing in another file type', () => {
    assert.deepEqual([...declaredNames('x.sh', 'CURRENT="guard: one"\n  CURRENT="guard: two"\nX="not a label"\n')], ['guard: one', 'guard: two']);
    assert.equal(declaredNames('x.md', 'def test_a(self)').size, 0);
  });
});

describe('the files stay where the check expects them', () => {
  it('has the map, the page and the script', () => {
    for (const rel of [MAP_PATH, DOC_PATH, 'scripts/ci/check-sync-catalog.mjs']) assert.ok(existsSync(join(REPO, rel)), rel);
  });

  it('is copied whole by a repository copy (no hidden dependency)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hfy-catalog-copy-'));
    try {
      for (const rel of [MAP_PATH, DOC_PATH, 'scripts/ci/check-sync-catalog.mjs']) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        cpSync(join(REPO, rel), join(root, rel));
      }
      const r = check({ root });
      assert.ok(r.problems.every((p) => p.includes('does not exist')), 'only the test files are missing from the copy');
      assert.ok(r.problems.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
