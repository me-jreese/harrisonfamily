// verify(): schema + privacy checks (viz.md section 5.2). Runs before every write and in --verify mode.
// A failure is PRIVACY_VIOLATION (exit 4). Findings carry a JSON pointer and a rule, never the value.

import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { GraphError } from './errors.mjs';
import { validateSchema } from './schema-validate.mjs';
import { deriveEdges, resolveNow } from './build.mjs';
import { stringify } from './canonical.mjs';
import { ADDRESS_LIKE_NAME } from './gramps-enums.mjs';

export const SCHEMA_URL = new URL('../schema/family-graph.v1.schema.json', import.meta.url);
export const SHARED_GUARD_URL = new URL('../../shared/privacy-guard.mjs', import.meta.url);
export const GZIP_BUDGET_BYTES = 150 * 1024;

let schemaCache = null;
export function loadSchema() {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
  return schemaCache;
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** The built-in detector. Order does not matter; the first rule that hits names the finding. */
export const DETECTORS = [
  { rule: 'day-precise-date', re: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/ },
  { rule: 'day-precise-date', re: /\b\d{4}-\d{2}-\d{2}\b/ },
  { rule: 'day-precise-date', re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i') },
  { rule: 'day-precise-date', re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'i') },
  { rule: 'email', re: /@/ },
  { rule: 'url', re: /https?:\/\//i },
  { rule: 'url', re: /\bwww\./i },
  // 7 or more digits that run across at least one separator, or a + prefix with 7 or more digits
  { rule: 'phone', re: /(?:\+\s*)\d(?:[\s.()-]*\d){6,}/ },
  { rule: 'phone', re: /\d(?:[\s.()-]*\d){6,}/, needsSeparator: true },
];

function detect(str) {
  for (const d of DETECTORS) {
    const m = d.re.exec(str);
    if (!m) continue;
    if (d.needsSeparator && !/[\s.()-]/.test(m[0])) continue;
    return d.rule;
  }
  return null;
}

/** Paths whose value has a strict schema pattern of its own and is exempt from the free-text scan. */
function exemptFromScan(pointer) {
  return pointer === '/generatedAt' || pointer.startsWith('/source/') || /^\/people\/\d+\/face$/.test(pointer);
}

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

function* strings(value, pointer) {
  if (typeof value === 'string') yield [pointer, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${pointer}/${i}`);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield [`${pointer}/${esc(k)}`, k]; // keys are scanned as well (the rel map is keyed by id)
      yield* strings(v, `${pointer}/${esc(k)}`);
    }
  }
}

function guardFlags(result) {
  if (Array.isArray(result)) return result.length > 0;
  if (result && typeof result === 'object') {
    if (result.ok === false) return true;
    if (Array.isArray(result.findings)) return result.findings.length > 0;
    if (Array.isArray(result.violations)) return result.violations.length > 0;
    if (result.ok === true) return false;
  }
  return true; // a result the adapter does not understand is not a pass
}

/**
 * Loads `shared/privacy-guard.mjs` (privacy-guard-core) when it exists. Contract assumed here:
 * `export function scanText(text)` returns an array of findings (empty when clean) or `{ ok: boolean }`.
 * A MISSING file gives null (the built-in detector runs alone). A file that exists but fails to import, or has no
 * `scanText`, throws PRIVACY_VIOLATION (fail closed). The built-in detector always runs as well.
 * @returns {Promise<((text: string) => unknown) | null>}
 */
export async function loadSharedGuard(url = SHARED_GUARD_URL) {
  if (!existsSync(url)) return null; // not shipped yet (privacy-guard-core): the built-in detector runs alone
  // The file is there, so a broken or contract-less guard must not silently vanish: fail closed.
  let mod;
  try {
    mod = await import(url.href);
  } catch {
    throw new GraphError('PRIVACY_VIOLATION', 'shared/privacy-guard.mjs exists but could not be loaded, so the shared detector cannot run');
  }
  if (typeof mod.scanText !== 'function') {
    throw new GraphError('PRIVACY_VIOLATION', 'shared/privacy-guard.mjs exists but exports no scanText(text), so the shared detector cannot run');
  }
  return mod.scanText;
}

/**
 * @param {object} graph
 * @param {{ now?: Date|number, guard?: ((text: string) => unknown) | null }} [opts]
 * @returns {{ ok: boolean, violations: { pointer: string, rule: string }[] }}
 */
export function verifyGraph(graph, opts = {}) {
  const now = resolveNow(opts.now);
  const maxYear = now.getUTCFullYear();
  const violations = [];
  const add = (pointer, rule) => violations.push({ pointer, rule });

  // 1. schema (additionalProperties:false everywhere)
  for (const e of validateSchema(loadSchema(), graph)) add(e.pointer, `schema:${e.keyword}`);
  if (violations.length === 0) structuralChecks(graph, maxYear, add);
  scanStrings(graph, opts.guard, add);
  return finish(violations);
}

function structuralChecks(graph, maxYear, add) {

  // years never exceed the current year, so a sort value can never pass
  const yearAt = (ptr, y) => {
    if (y !== null && y > maxYear) add(ptr, 'year-range');
  };
  graph.people.forEach((p, i) => {
    yearAt(`/people/${i}/birthYear`, p.birthYear);
    yearAt(`/people/${i}/deathYear`, p.deathYear);
    if (p.living && p.deathYear !== null) add(`/people/${i}/deathYear`, 'living-has-death-year');
  });
  graph.events.forEach((e, i) => yearAt(`/events/${i}/year`, e.year));

  // 3. coordinates carry at most 2 decimals
  graph.places.forEach((p, i) => {
    for (const k of ['lat', 'lon']) {
      if (p[k] !== null && !/^-?\d+(\.\d{1,2})?$/.test(String(p[k]))) add(`/places/${i}/${k}`, 'coordinate-precision');
    }
  });

  // referential integrity and the unions/edges agreement
  const people = new Set(graph.people.map((p) => p.id));
  const places = new Set(graph.places.map((p) => p.id));
  graph.people.forEach((p, i) => {
    for (const k of ['birthPlace', 'deathPlace']) if (p[k] !== null && !places.has(p[k])) add(`/people/${i}/${k}`, 'dangling-reference');
  });
  graph.places.forEach((p, i) => {
    if (p.parent !== null && !places.has(p.parent)) add(`/places/${i}/parent`, 'dangling-reference');
  });
  graph.events.forEach((e, i) => {
    if (!people.has(e.person)) add(`/events/${i}/person`, 'dangling-reference');
    if (e.place !== null && !places.has(e.place)) add(`/events/${i}/place`, 'dangling-reference');
  });
  graph.unions.forEach((u, i) => {
    u.partners.forEach((id, j) => {
      if (!people.has(id)) add(`/unions/${i}/partners/${j}`, 'dangling-reference');
      if (u.partners.indexOf(id) !== j) add(`/unions/${i}/partners/${j}`, 'self-reference');
    });
    const seen = new Set();
    u.children.forEach((c, j) => {
      if (!people.has(c.id)) add(`/unions/${i}/children/${j}/id`, 'dangling-reference');
      if (u.partners.includes(c.id) || seen.has(c.id)) add(`/unions/${i}/children/${j}/id`, 'self-reference');
      seen.add(c.id);
    });
  });
  // a place name that reads as a street address is address-grade (rule S) whatever its type says
  graph.places.forEach((p, i) => {
    if (ADDRESS_LIKE_NAME.test(p.name)) add(`/places/${i}/name`, 'address-like-place-name');
  });
  if (stringify(graph.edges) !== stringify(deriveEdges(graph.unions))) add('/edges', 'edges-disagree-with-unions');
  if (graph.layout) layoutChecks(graph, add);
}

/** The layout block names only people and unions the graph has, each once, never a person without a generation. */
function layoutChecks(graph, add) {
  const person = new Map(graph.people.map((p) => [p.id, p]));
  const unions = new Set(graph.unions.map((u) => u.id));
  const componentIds = new Set(graph.components.map((c) => c.id));
  const seenPeople = new Set();
  const seenUnions = new Set();
  const seenComponents = new Set();
  graph.layout.components.forEach((c, i) => {
    const at = `/layout/components/${i}`;
    if (!componentIds.has(c.component) || seenComponents.has(c.component)) add(`${at}/component`, 'layout-component');
    seenComponents.add(c.component);
    c.people.forEach((n, j) => {
      const p = person.get(n.id);
      if (!p) add(`${at}/people/${j}/id`, 'dangling-reference');
      else if (p.generation === null || p.component !== c.component) add(`${at}/people/${j}/id`, 'layout-person-not-placed');
      if (seenPeople.has(n.id)) add(`${at}/people/${j}/id`, 'layout-duplicate');
      seenPeople.add(n.id);
    });
    c.unions.forEach((n, j) => {
      if (!unions.has(n.id)) add(`${at}/unions/${j}/id`, 'dangling-reference');
      if (seenUnions.has(n.id)) add(`${at}/unions/${j}/id`, 'layout-duplicate');
      seenUnions.add(n.id);
    });
    // one layer per generation, deeper generations below: y is a strictly increasing function of the generation within a component
    const yOf = new Map();
    for (const n of c.people) {
      const g = person.get(n.id)?.generation;
      if (g === null || g === undefined) continue;
      if (yOf.has(g) && yOf.get(g) !== n.y) add(`${at}/people`, 'layout-rank-order');
      yOf.set(g, n.y);
    }
    const byGeneration = [...yOf.entries()].sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < byGeneration.length; k++) if (byGeneration[k][1] <= byGeneration[k - 1][1]) add(`${at}/people`, 'layout-rank-order');
    const here = new Set([...c.people, ...c.unions].map((n) => n.id));
    c.bends.forEach((b, j) => {
      for (const k of ['s', 't']) if (!here.has(b[k])) add(`${at}/bends/${j}/${k}`, 'dangling-reference');
    });
  });
}

/** 2. deep string scan, over every value and key, whatever the shape (so it also runs on a graph the schema rejected) */
function scanStrings(graph, guard, add) {
  for (const [pointer, str] of strings(graph, '')) {
    if (exemptFromScan(pointer)) continue;
    const rule = detect(str);
    if (rule) {
      add(pointer, rule);
      continue;
    }
    if (guard && guardFlags(guard(str))) add(pointer, 'shared-guard');
  }
}

function finish(violations) {
  // dedupe, keep a stable order
  const seen = new Set();
  const list = violations.filter((v) => {
    const k = `${v.pointer}\u0000${v.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ok: list.length === 0, violations: list };
}

/** Throws PRIVACY_VIOLATION (exit 4) naming JSON pointers and rules only. */
export function assertVerified(graph, opts = {}) {
  const r = verifyGraph(graph, opts);
  if (!r.ok) {
    throw new GraphError('PRIVACY_VIOLATION', `verify() rejected the graph (${r.violations.length} finding${r.violations.length === 1 ? '' : 's'})`, {
      pointers: r.violations.map((v) => `${v.pointer} [${v.rule}]`),
    });
  }
}

/** SIZE_BUDGET (exit 3): the gzip size of the serialized graph against the budget. */
export function assertSizeBudget(text, max = GZIP_BUDGET_BYTES) {
  const size = gzipSync(text).length;
  if (size > max) throw new GraphError('SIZE_BUDGET', `graph.json is ${size} bytes gzipped, over the ${max} byte budget`);
  return size;
}
