import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSizeBudget, assertVerified, loadSharedGuard, verifyGraph } from '../src/verify.mjs';
import { GraphError } from '../src/errors.mjs';
import { GOLDEN, NOW, scratch } from './helpers.mjs';

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));
const verify = (g, opts = {}) => verifyGraph(g, { now: NOW, ...opts });
const rules = (r) => r.violations.map((v) => `${v.pointer}|${v.rule}`);

describe('verify()', () => {
  it('passes the golden', () => assert.deepEqual(verify(golden()), { ok: true, violations: [] }));

  describe('rejects day-precise dates, e-mail, phone numbers and URLs in any string', () => {
    const bad = {
      'day-precise-date': ['born 03/14/1950', 'b. 3.4.50', '1950-03-14', 'March 3', 'Mar. 14th', '14 March', '3rd of May', 'Sept 9'],
      email: ['jo@example.invalid', '@someone'],
      url: ['http://example.invalid', 'HTTPS://example.invalid/x', 'www.example.invalid'],
      phone: ['555-010-0100', '(555) 010 0100', '555.010.0100', '+15550100100', '555 0100 123'],
    };
    for (const [rule, values] of Object.entries(bad)) {
      for (const v of values) {
        it(`${rule}: ${v}`, () => {
          const g = golden();
          g.people[0].given = v;
          const r = verify(g);
          assert.equal(r.ok, false);
          assert.ok(rules(r).includes(`/people/0/given|${rule}`), rules(r).join(', '));
        });
      }
    }
    it('in a place name, in object keys, and in a nested array', () => {
      let g = golden();
      g.places[0].name = 'Creek 555-010-0100';
      assert.ok(rules(verify(g)).includes('/places/0/name|phone'));
      g = golden();
      g.components[0].roots.push('a@b.invalid');
      assert.ok(verify(g).violations.some((v) => v.rule === 'email'));
      g = golden();
      const u = g.unions[0];
      u.children[0].rel['x@y.invalid'] = 'birth';
      assert.ok(verify(g).violations.some((v) => v.rule === 'email'));
    });
    it('does not flag ordinary names, places or years', () => {
      const g = golden();
      g.people[0].given = 'Mary-Ann';
      g.people[0].surname = "O'Neil Van Der Berg";
      g.places[0].name = 'Mount May Hill';
      assert.equal(verify(g).ok, true);
    });
  });

  it('never echoes the offending value', () => {
    const g = golden();
    g.people[0].given = 'secret.person@example.invalid';
    assert.throws(
      () => assertVerified(g, { now: NOW }),
      (e) => e instanceof GraphError && e.code === 'PRIVACY_VIOLATION' && e.exitCode === 4 && !JSON.stringify([e.message, e.pointers]).includes('secret'),
    );
  });

  it('rejects years after the current year and a living person with a death year', () => {
    let g = golden();
    g.people[0].birthYear = NOW.getUTCFullYear() + 1;
    assert.ok(rules(verify(g)).includes('/people/0/birthYear|year-range'));
    g = golden();
    const living = g.people.findIndex((p) => p.living);
    g.people[living].deathYear = 2000;
    assert.ok(rules(verify(g)).includes(`/people/${living}/deathYear|living-has-death-year`));
  });

  it('rejects coordinates with more than 2 decimals', () => {
    const g = golden();
    g.places[1].lat = 40.12345;
    assert.ok(rules(verify(g)).includes('/places/1/lat|coordinate-precision'));
  });

  it('rejects dangling references and edges that disagree with the unions', () => {
    let g = golden();
    g.people[0].birthPlace = 'P0000';
    assert.ok(verify(g).violations.some((v) => v.rule === 'dangling-reference'));
    g = golden();
    g.edges.pop();
    assert.ok(rules(verify(g)).includes('/edges|edges-disagree-with-unions'));
  });

  it('a schema failure is a violation too (extra property)', () => {
    const g = golden();
    g.people[0].notes = 'x';
    assert.ok(rules(verify(g)).includes('/people/0/notes|schema:additionalProperties'));
  });

  it('does not scan generatedAt, source or face (they have strict patterns of their own)', () => {
    const g = golden();
    assert.match(g.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(g.source.builder, /@/);
    g.people[0].face = 'faces/I9001-12345678.webp';
    assert.equal(verify(g).ok, true);
  });
});

describe('shared/privacy-guard.mjs', () => {
  it('is used when present: a finding from the shared guard is a violation', () => {
    const flagged = (text) => (text === 'Ada' ? [{ code: 'x' }] : []);
    const g = golden();
    g.people[0].given = 'Ada';
    assert.ok(rules(verify(g, { guard: flagged })).includes('/people/0/given|shared-guard'));
    assert.equal(verify(golden(), { guard: () => [] }).ok, true);
    assert.equal(verify(golden(), { guard: () => ({ ok: true }) }).ok, true);
    assert.equal(verify(golden(), { guard: () => ({ ok: false }) }).ok, false);
    assert.equal(verify(golden(), { guard: () => 'what' }).ok, false); // a result it does not understand is not a pass
  });

  it('loadSharedGuard imports scanText when the module exists, and returns null when it does not', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared', 'privacy-guard.mjs'), 'export function scanText(t) { return t.includes("BAD") ? [1] : []; }\n');
    const fn = await loadSharedGuard(pathToFileURL(join(dir, 'shared', 'privacy-guard.mjs')));
    assert.equal(typeof fn, 'function');
    assert.deepEqual(fn('BAD'), [1]);
    assert.equal(await loadSharedGuard(pathToFileURL(join(dir, 'none.mjs'))), null);
  });

  it('fails closed (PRIVACY_VIOLATION, exit 4) when the file exists but does not load or has no scanText', async () => {
    const dir = scratch();
    const isClosed = (e) => e instanceof GraphError && e.code === 'PRIVACY_VIOLATION' && e.exitCode === 4;
    writeFileSync(join(dir, 'other.mjs'), 'export const x = 1;\n');
    await assert.rejects(loadSharedGuard(pathToFileURL(join(dir, 'other.mjs'))), isClosed);
    writeFileSync(join(dir, 'syntax.mjs'), 'export function scanText( {\n');
    await assert.rejects(loadSharedGuard(pathToFileURL(join(dir, 'syntax.mjs'))), isClosed);
    writeFileSync(join(dir, 'throws.mjs'), 'throw new Error("boom");\n');
    await assert.rejects(loadSharedGuard(pathToFileURL(join(dir, 'throws.mjs'))), isClosed);
  });

  it('the built-in detector still runs when the shared guard passes everything', () => {
    const g = golden();
    g.people[0].given = 'a@b.invalid';
    assert.equal(verify(g, { guard: () => [] }).ok, false);
  });
});

describe('structural checks', () => {
  it('rejects a person who is their own partner or a child of the union they are a partner in', () => {
    let g = golden();
    const u = g.unions.find((x) => x.partners.length === 2);
    u.partners[1] = u.partners[0];
    assert.ok(rules(verify(g)).some((r) => r.endsWith('|self-reference')));
    g = golden();
    const u2 = g.unions.find((x) => x.partners.length >= 1 && x.children.length >= 1);
    u2.children[0].id = u2.partners[0];
    assert.ok(rules(verify(g)).some((r) => r.endsWith('|self-reference')));
  });
  it('rejects a place name that reads as a street address, whatever its type', () => {
    for (const name of ['12 Elm Street', 'Birch Road', '7 Oak', 'Maple Ave', 'Pine St.']) {
      const g = golden();
      g.places[0].name = name;
      g.places[0].type = 'city';
      assert.ok(rules(verify(g)).includes('/places/0/name|address-like-place-name'), name);
    }
    const ok = golden();
    ok.places[0].name = 'Lane County';
    assert.equal(verify(ok).ok, true);
  });
  it('an invalid clock is INPUT_MISSING, not a RangeError', () => {
    assert.throws(() => verifyGraph(golden(), { now: new Date('nope') }), (e) => e instanceof GraphError && e.code === 'INPUT_MISSING');
    assert.throws(() => verifyGraph(golden(), { now: 'nope' }), (e) => e instanceof GraphError && e.code === 'INPUT_MISSING');
  });
});

describe('size budget', () => {
  it('passes under the budget and throws SIZE_BUDGET (exit 3) over it', () => {
    const text = readFileSync(GOLDEN, 'utf8');
    assert.ok(assertSizeBudget(text) > 0);
    assert.throws(() => assertSizeBudget(text, 10), (e) => e instanceof GraphError && e.code === 'SIZE_BUDGET' && e.exitCode === 3);
  });
});
