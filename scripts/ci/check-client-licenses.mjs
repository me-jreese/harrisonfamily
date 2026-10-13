#!/usr/bin/env node
// CI licence gate for client bundles (HFY-TSK-226, R-22).
//
// Reads the lockfile `license` fields of each client bundle (islands/ and, once it exists,
// chat-worker/) and checks every package in the PRODUCTION dependency closure. No install and
// no CodeArtifact: it only parses package-lock.json.
//
//   pass : MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0
//   fail : any GPL, AGPL, LGPL, EPL or SSPL licence; a missing licence; any other licence
//          unless scripts/ci/license-overrides.json holds a reviewed override for that exact
//          package AND version.
//
// SPDX expressions: "A OR B" passes when one alternative passes; "A AND B" needs every part.
// An override never rescues a GPL, AGPL, LGPL, EPL or SSPL licence.
//
// Usage: node scripts/ci/check-client-licenses.mjs [--lock <package-lock.json>]... [--overrides <file>]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0']);
const DENIED = /(^|[^A-Z])(A?GPL|LGPL|EPL|SSPL)/i;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
export const DEFAULT_OVERRIDES = resolve(HERE, 'license-overrides.json');
export const DEFAULT_LOCKS = ['islands/package-lock.json', 'chat-worker/package-lock.json'];

export function isDenied(id) {
  return DENIED.test(id);
}

// Evaluates an SPDX expression. Returns { ok, denied, unknown } for the expression.
function evalExpression(expr) {
  const tokens = expr.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  // Parentheses are flattened: OR binds loosest, AND tighter, which matches how a lockfile
  // writes real expressions; mixed nesting is rare and fails closed below.
  if (/[()]/.test(expr) && tokens.includes('AND') && tokens.includes('OR')) return { ok: false, denied: false, unknown: [expr] };
  const orParts = [[]];
  for (const t of tokens) {
    if (t === 'OR') orParts.push([]);
    else if (t !== 'AND') orParts[orParts.length - 1].push(t);
  }
  const andMode = tokens.includes('AND') && !tokens.includes('OR');
  const verdict = (id) => (ALLOWED.has(id) ? 'ok' : isDenied(id) ? 'denied' : 'unknown');
  if (andMode) {
    const ids = orParts[0];
    const v = ids.map((id) => [id, verdict(id)]);
    return {
      ok: v.every(([, s]) => s === 'ok'),
      denied: v.some(([, s]) => s === 'denied'),
      unknown: v.filter(([, s]) => s === 'unknown').map(([id]) => id),
    };
  }
  const flat = orParts.map((p) => p[0]).filter(Boolean);
  const v = flat.map((id) => [id, verdict(id)]);
  return {
    ok: v.some(([, s]) => s === 'ok'),
    denied: v.length > 0 && v.every(([, s]) => s === 'denied'),
    unknown: v.filter(([, s]) => s === 'unknown').map(([id]) => id),
  };
}

function nameFromPath(path, entry) {
  if (entry && entry.name) return entry.name;
  const i = path.lastIndexOf('node_modules/');
  return i === -1 ? path : path.slice(i + 'node_modules/'.length);
}

function normaliseLicense(entry) {
  const l = entry.license ?? entry.licenses;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean).join(' OR ');
  if (l && typeof l === 'object') return l.type || '';
  return typeof l === 'string' ? l.trim() : '';
}

// Walks the production closure of a v2/v3 lockfile. Returns [{ path, name, version, license }].
export function productionClosure(lock) {
  const pkgs = lock && lock.packages;
  if (!pkgs || !pkgs['']) throw new Error('lockfile has no "packages" map (lockfileVersion 2 or 3 is required)');
  const resolveDep = (fromPath, dep) => {
    let base = fromPath;
    for (;;) {
      const cand = `${base ? `${base}/` : ''}node_modules/${dep}`;
      if (pkgs[cand]) return cand;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i === -1 ? '' : base.slice(0, i);
    }
  };
  const seen = new Set();
  const queue = [''];
  while (queue.length) {
    const p = queue.pop();
    let e = pkgs[p];
    if (e && e.link && e.resolved && pkgs[e.resolved]) {
      if (p) seen.add(p);
      queue.push(e.resolved);
      continue;
    }
    if (seen.has(p) && p !== '') continue;
    seen.add(p);
    e = pkgs[p];
    const deps = { ...(e.dependencies || {}), ...(e.optionalDependencies || {}), ...(e.peerDependencies || {}) };
    for (const dep of Object.keys(deps)) {
      const r = resolveDep(p, dep);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return [...seen]
    .filter((p) => p !== '')
    .map((p) => {
      const e = pkgs[p];
      return { path: p, name: nameFromPath(p, e), version: e.version || '', license: normaliseLicense(e), link: !!e.link };
    })
    .filter((r) => !r.link);
}

export function loadOverrides(file = DEFAULT_OVERRIDES) {
  if (!existsSync(file)) return { overrides: [], firstPartyScopes: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const overrides = raw.overrides || [];
  for (const o of overrides) {
    for (const k of ['package', 'version', 'license', 'licenseFile']) {
      if (typeof o[k] !== 'string' || !o[k]) throw new Error(`license override ${JSON.stringify(o)} is missing "${k}"`);
    }
    if (isDenied(o.license)) throw new Error(`license override for ${o.package}@${o.version} names a denied licence (${o.license})`);
  }
  return { overrides, firstPartyScopes: raw.firstPartyScopes || [] };
}

// Returns { checked, violations: [{ name, version, license, reason }] }.
export function checkLock(lock, cfg = { overrides: [], firstPartyScopes: [] }) {
  const rows = productionClosure(lock);
  const violations = [];
  for (const r of rows) {
    const tag = (reason) => violations.push({ name: r.name, version: r.version, license: r.license || '(none)', reason });
    if (!r.license) {
      const o = cfg.overrides.find((x) => x.package === r.name && x.version === r.version);
      if (o) continue;
      const stale = cfg.overrides.find((x) => x.package === r.name);
      tag(stale ? `no license field; the reviewed override is for ${stale.version}, not ${r.version}` : 'no license field and no reviewed override');
      continue;
    }
    const ev = evalExpression(r.license);
    if (ev.ok) continue;
    if (ev.denied) {
      tag('denied licence (GPL, AGPL, LGPL, EPL or SSPL)');
      continue;
    }
    const fp = cfg.firstPartyScopes.find((s) => r.name.startsWith(s.scope) && s.license === r.license);
    if (fp) continue;
    const o = cfg.overrides.find((x) => x.package === r.name && x.version === r.version);
    if (o) continue;
    const stale = cfg.overrides.find((x) => x.package === r.name);
    tag(stale ? `licence not on the allow list; the reviewed override is for ${stale.version}, not ${r.version}` : 'licence not on the allow list and no reviewed override');
  }
  return { checked: rows.length, violations };
}

function main(argv) {
  const locks = [];
  let overridesFile = DEFAULT_OVERRIDES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lock') locks.push(resolve(argv[++i]));
    else if (argv[i] === '--overrides') overridesFile = resolve(argv[++i]);
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  const targets = locks.length ? locks : DEFAULT_LOCKS.map((p) => resolve(REPO, p)).filter((p) => existsSync(p));
  if (!targets.length) { console.error('no lockfile to check'); return 2; }
  const cfg = loadOverrides(overridesFile);
  let bad = 0;
  for (const file of targets) {
    let res;
    try { res = checkLock(JSON.parse(readFileSync(file, 'utf8')), cfg); } catch (e) { console.error(`${file}: ${e.message}`); return 2; }
    const label = file.startsWith(REPO) ? file.slice(REPO.length + 1) : file;
    if (res.violations.length) {
      console.error(`FAIL ${label}: ${res.violations.length} of ${res.checked} production packages break the licence policy`);
      for (const v of res.violations) console.error(`  ${v.name}@${v.version}  ${v.license}  ${v.reason}`);
      bad += res.violations.length;
    } else {
      console.log(`ok   ${label}: ${res.checked} production packages, all licences allowed`);
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
