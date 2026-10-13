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
// SPDX expressions use real precedence (WITH, then AND, then OR; parentheses group): "A OR B"
// passes when one alternative passes, "A AND B" needs every part, and a malformed expression fails.
//
// Scope: the PRODUCTION closure of the lockfile, plus every package named in the overrides file's
// "shippedDevDependencies" (devDependencies copied into the build output, such as the font
// packages) and their own closure. Any other devDependency is not checked. A library that is
// bundled into the output must stay in "dependencies" or be listed in "shippedDevDependencies".
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

const verdict = (id) => {
  const base = id.split(' WITH ')[0];
  return ALLOWED.has(base) ? 'ok' : isDenied(base) ? 'denied' : 'unknown';
};

// Parses an SPDX expression with the real precedence: WITH binds tightest, then AND, then OR,
// and parentheses group. Throws on anything malformed (empty, trailing operator, bad parens),
// which the caller turns into a failure.
function parseExpression(expr) {
  const tokens = expr.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
  let i = 0;
  const parseOr = () => {
    const parts = [parseAnd()];
    while (tokens[i] === 'OR') { i++; parts.push(parseAnd()); }
    return parts.length === 1 ? parts[0] : { op: 'OR', parts };
  };
  const parseAnd = () => {
    const parts = [parseAtom()];
    while (tokens[i] === 'AND') { i++; parts.push(parseAtom()); }
    return parts.length === 1 ? parts[0] : { op: 'AND', parts };
  };
  const parseAtom = () => {
    const t = tokens[i];
    if (t === undefined || t === 'AND' || t === 'OR' || t === 'WITH' || t === ')') throw new Error('malformed licence expression');
    i++;
    if (t === '(') {
      const inner = parseOr();
      if (tokens[i] !== ')') throw new Error('unbalanced parentheses');
      i++;
      return inner;
    }
    if (tokens[i] === 'WITH') {
      const ex = tokens[i + 1];
      if (ex === undefined || ['AND', 'OR', 'WITH', '(', ')'].includes(ex)) throw new Error('malformed WITH clause');
      i += 2;
      return { id: `${t} WITH ${ex}` };
    }
    return { id: t };
  };
  const tree = parseOr();
  if (i !== tokens.length) throw new Error('malformed licence expression');
  return tree;
}

function evalNode(n) {
  if (n.id) {
    const v = verdict(n.id);
    return { ok: v === 'ok', denied: v === 'denied', unknown: v === 'unknown' ? [n.id] : [] };
  }
  const rs = n.parts.map(evalNode);
  const unknown = rs.flatMap((r) => r.unknown);
  return n.op === 'AND'
    ? { ok: rs.every((r) => r.ok), denied: rs.some((r) => r.denied), unknown }
    : { ok: rs.some((r) => r.ok), denied: rs.every((r) => r.denied), unknown };
}

// Evaluates an SPDX expression. Returns { ok, denied, unknown }; a malformed expression fails closed.
export function evalExpression(expr) {
  try {
    return evalNode(parseExpression(expr));
  } catch {
    return { ok: false, denied: false, unknown: [expr] };
  }
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
export function productionClosure(lock, extraRoots = []) {
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
  for (const name of extraRoots) {
    const r = resolveDep('', name);
    if (r) queue.push(r); // a name absent from this lockfile ships nothing here
  }
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
  if (!existsSync(file)) return { overrides: [], shippedDevDependencies: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const overrides = raw.overrides || [];
  for (const o of overrides) {
    // licenseFile is evidence for the reviewer (the file or field the licence was read from); it is
    // required but advisory, and the gate does not open it.
    for (const k of ['package', 'version', 'license', 'licenseFile']) {
      if (typeof o[k] !== 'string' || !o[k]) throw new Error(`license override ${JSON.stringify(o)} is missing "${k}"`);
    }
    if (isDenied(o.license)) throw new Error(`license override for ${o.package}@${o.version} names a denied licence (${o.license})`);
  }
  return { overrides, shippedDevDependencies: raw.shippedDevDependencies || [] };
}

// Returns { checked, violations: [{ name, version, license, reason }] }.
export function checkLock(lock, cfg = { overrides: [], shippedDevDependencies: [] }) {
  const rows = productionClosure(lock, cfg.shippedDevDependencies || []);
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
    if (argv[i] === '--lock' || argv[i] === '--overrides') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { console.error(`${argv[i - 1]} needs a value`); return 2; }
      if (argv[i - 1] === '--lock') locks.push(resolve(v)); else overridesFile = resolve(v);
    }
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  // islands/package-lock.json is required; chat-worker/ is optional until it exists.
  const targets = locks.length ? locks : DEFAULT_LOCKS.map((p) => resolve(REPO, p)).filter((p, n) => n > 0 ? existsSync(p) : true);
  const missing = targets.filter((p) => !existsSync(p));
  if (missing.length) { console.error(`lockfile not found: ${missing.join(', ')}`); return 2; }
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
