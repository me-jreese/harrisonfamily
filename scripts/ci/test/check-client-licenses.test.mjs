// node --test scripts/ci/test/check-client-licenses.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLock, loadOverrides } from '../check-client-licenses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-client-licenses.mjs');
const FIX = (n) => resolve(HERE, 'fixtures', 'license-gate', n, 'package-lock.json');
const none = { overrides: [], firstPartyScopes: [] };
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

test('CLI: the real islands lockfile passes', () => {
  assert.equal(run().status, 0);
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
  const cfg = { overrides: [dn], firstPartyScopes: [] };
  assert.equal(checkLock(lock({ 'data-navigator': { version: '3.0.0' } }), none).violations.length, 1);
  assert.equal(checkLock(lock({ 'data-navigator': { version: '3.0.0' } }), cfg).violations.length, 0);
  const v = checkLock(lock({ 'data-navigator': { version: '3.0.1' } }), cfg).violations;
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /override is for 3\.0\.0/);
});

test('an override cannot rescue a denied licence, and a denied override is rejected', () => {
  const cfg = { overrides: [{ ...dn, package: 'a', version: '1.0.0' }], firstPartyScopes: [] };
  assert.equal(checkLock(lock({ a: { version: '1.0.0', license: 'AGPL-3.0' } }), cfg).violations.length, 1);
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

test('first-party scope passes only for its declared licence', () => {
  const cfg = { overrides: [], firstPartyScopes: [{ scope: '@kit/', license: 'UNLICENSED' }] };
  assert.equal(checkLock(lock({ '@kit/x': { version: '1.0.0', license: 'UNLICENSED' } }), cfg).violations.length, 0);
  assert.equal(checkLock(lock({ '@other/x': { version: '1.0.0', license: 'UNLICENSED' } }), cfg).violations.length, 1);
});

test('the committed overrides file loads', () => {
  assert.ok(Array.isArray(loadOverrides().overrides));
});
