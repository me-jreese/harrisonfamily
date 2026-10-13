// node --test 'scripts/ci/test/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkLock, evalExpression, loadOverrides } from '../check-client-licenses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-client-licenses.mjs');
const FIX = (n) => resolve(HERE, 'fixtures', 'license-gate', n, 'package-lock.json');
const none = { overrides: [], shippedDevDependencies: [] };
const lock = (deps, extra = {}) => ({ lockfileVersion: 3, packages: { '': { dependencies: Object.fromEntries(Object.keys(deps).map((k) => [k, '*'])) }, ...Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, v])), ...extra } });
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });

test('CLI: AGPL transitive fixture (olli to ua-parser-js shape) fails', () => {
  const r = run('--lock', FIX('agpl'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ua-parser-js@2\.0\.3/);
});

test('CLI: allowed-only fixture passes, and dev-only GPL is ignored', () => {
  const r = run('--lock', FIX('allowed'));
  assert.equal(r.status, 0, r.stderr);
});

test('CLI: --lock without a value, and a missing lockfile, exit 2', () => {
  assert.equal(run('--lock').status, 2);
  assert.equal(run('--lock', '--overrides').status, 2);
  assert.equal(run('--lock', '/nonexistent/package-lock.json').status, 2);
});

test('every allowed licence passes', () => {
  for (const l of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0']) {
    assert.equal(checkLock(lock({ a: { version: '1.0.0', license: l } }), none).violations.length, 0, l);
  }
});

test('GPL, AGPL, LGPL, EPL and SSPL fail', () => {
  for (const l of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'EPL-2.0', 'SSPL-1.0', 'GPL-2.0-with-classpath-exception']) {
    assert.equal(checkLock(lock({ a: { version: '1.0.0', license: l } }), none).violations.length, 1, l);
  }
});

test('OR picks the allowed side; AND needs every side; a denied-only OR fails', () => {
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: '(MIT OR GPL-3.0-only)' } }), none).violations.length, 0);
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'MIT AND GPL-3.0-only' } }), none).violations.length, 1);
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'GPL-2.0 OR AGPL-3.0' } }), none).violations.length, 1);
});

test('an unlisted licence (MPL-2.0, Unlicense) fails without an override', () => {
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'MPL-2.0' } }), none).violations.length, 1);
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'Unlicense' } }), none).violations.length, 1);
});

const dn = { package: 'data-navigator', version: '3.0.0', license: 'MIT', licenseFile: 'LICENSE' };
test('missing licence fails; an exact-version override passes; another version fails', () => {
  const cfg = { overrides: [dn], shippedDevDependencies: [] };
  assert.equal(checkLock(lock({ 'data-navigator': { version: '3.0.0' } }), none).violations.length, 1);
  assert.equal(checkLock(lock({ 'data-navigator': { version: '3.0.0' } }), cfg).violations.length, 0);
  const v = checkLock(lock({ 'data-navigator': { version: '3.0.1' } }), cfg).violations;
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /override is for 3\.0\.0/);
});

test('an override cannot rescue a denied licence, and a denied override is rejected', () => {
  const cfg = { overrides: [{ ...dn, package: 'a', version: '1.0.0' }], shippedDevDependencies: [] };
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'AGPL-3.0' } }), cfg).violations.length, 1);
  const dir = mkdtempSync(resolve(tmpdir(), 'lic-'));
  try {
    const f = resolve(dir, 'o.json');
    writeFileSync(f, JSON.stringify({ overrides: [{ ...dn, license: 'GPL-3.0-only' }] }));
    assert.throws(() => loadOverrides(f), /denied licence/);
    writeFileSync(f, JSON.stringify({ overrides: [{ package: 'a', version: '1.0.0', license: 'MIT' }] }));
    assert.throws(() => loadOverrides(f), /licenseFile/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production closure only: a dev-flagged and an unreachable package are skipped; nested copies resolve', () => {
  const l = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '*' }, devDependencies: { d: '*' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '*' } },
      'node_modules/a/node_modules/b': { version: '2.0.0', license: 'GPL-3.0' },
      'node_modules/b': { version: '1.0.0', license: 'MIT' },
      'node_modules/d': { version: '1.0.0', license: 'GPL-3.0', dev: true },
    },
  };
  const res = checkLock(l, none);
  assert.deepEqual(res.violations.map((v) => `${v.name}@${v.version}`), ['b@2.0.0']);
});

test('an UNLICENSED package passes only with an exact-version override, whatever its scope', () => {
  const ov = { package: '@kit/x', version: '1.0.0', license: 'UNLICENSED', licenseFile: 'package.json' };
  const cfg = { overrides: [ov], shippedDevDependencies: [] };
  assert.equal(checkLock(lock({ '@kit/x': { version: '1.0.0', license: 'UNLICENSED' } }), cfg).violations.length, 0);
  assert.equal(checkLock(lock({ '@kit/x': { version: '1.0.1', license: 'UNLICENSED' } }), cfg).violations.length, 1);
  assert.equal(checkLock(lock({ '@io-kit/y': { version: '1.0.0', license: 'UNLICENSED' } }), cfg).violations.length, 1);
  assert.equal(checkLock(lock({ other: { version: '1.0.0', license: 'UNLICENSED' } }), cfg).violations.length, 1);
});

test('SPDX precedence: AND binds tighter than OR, and mixed expressions are judged correctly', () => {
  const ok = (e) => evalExpression(e).ok;
  assert.equal(ok('GPL-3.0 OR MIT AND GPL-3.0'), false);
  assert.equal(evalExpression('GPL-3.0 OR MIT AND GPL-3.0').denied, true);
  assert.equal(ok('GPL-3.0 OR MIT AND ISC'), true);
  assert.equal(ok('MIT AND GPL-2.0 OR ISC'), true);
  assert.equal(ok('(MIT OR GPL-3.0) AND ISC'), true);
  assert.equal(ok('(MIT OR GPL-3.0) AND GPL-2.0'), false);
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'GPL-3.0 OR MIT AND GPL-3.0' } }), none).violations.length, 1);
});

test('malformed expressions fail closed', () => {
  for (const e of ['MIT OR', 'OR MIT', 'MIT AND', '(MIT', 'MIT)', 'MIT ISC', 'MIT WITH', '()']) {
    const r = evalExpression(e);
    assert.equal(r.ok, false, e);
  }
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'MIT OR' } }), none).violations.length, 1);
});

test('WITH exceptions follow the base licence', () => {
  assert.equal(evalExpression('Apache-2.0 WITH LLVM-exception').ok, true);
  assert.equal(evalExpression('GPL-2.0-only WITH Classpath-exception-2.0').denied, true);
});

test('optional and peer dependencies are walked; unreachable dev packages are not', () => {
  const l = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '*' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', optionalDependencies: { o: '*' }, peerDependencies: { p: '*' } },
      'node_modules/o': { version: '1.0.0', license: 'GPL-3.0' },
      'node_modules/p': { version: '1.0.0', license: 'AGPL-3.0' },
    },
  };
  assert.deepEqual(checkLock(l, none).violations.map((v) => v.name).sort(), ['o', 'p']);
});

test('shippedDevDependencies are gated with their closure; other dev packages are not', () => {
  const l = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: {}, devDependencies: { font: '*', tool: '*' } },
      'node_modules/font': { version: '1.0.0', license: 'OFL-1.1', dev: true },
      'node_modules/tool': { version: '1.0.0', license: 'GPL-3.0', dev: true },
    },
  };
  assert.equal(checkLock(l, none).violations.length, 0);
  assert.equal(checkLock(l, { overrides: [], shippedDevDependencies: ['font'] }).violations.length, 1);
  const rev = { package: 'font', version: '1.0.0', license: 'OFL-1.1', licenseFile: 'LICENSE' };
  assert.equal(checkLock(l, { overrides: [rev], shippedDevDependencies: ['font'] }).violations.length, 0);
  assert.equal(checkLock(l, { overrides: [], shippedDevDependencies: ['gone'] }).violations.length, 0);
});

test('the committed overrides file loads', () => {
  assert.ok(Array.isArray(loadOverrides().overrides));
});
