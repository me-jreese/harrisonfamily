// Duplicate matcher (HFY-TSK-251, relationship-compiler): "is this the same person?" Editing design section 8.2.
//
// Before a relationship proposal creates a stub Person, the server looks for people who may already be in the tree
// under a near-identical name. The matcher is case-folded and accent-stripped ("Zoë" meets "zoe", "MÜLLER" meets
// "Muller"), reads a married or alternate name as well as the primary name, and forgives a one-letter slip, a
// nickname that starts the given name ("Tom" for "Thomas") and an initial. It is advisory: the member sees the
// candidates and says "different person" (`confirmDistinct`), or picks the existing person instead.
//
// PURE. No imports: it runs under `node --test` and in a browser.
//
// PRIVACY. The matcher knows only what it is handed. The caller passes the people the VIEWER may see (the record
// API's redacted view), so a candidate's `lifespan` never carries a year the viewer could not read elsewhere. A
// candidate is `{ handle, displayName, lifespan }` and nothing else.
//
//   foldName(s)                         the comparison form of a name part
//   summarizePerson(person, eventOf)    a Gramps Person (JSON) -> the summary the matcher reads
//   findDuplicates(stubs, people, opts) -> [{ for: "new:1", candidates: [{ handle, displayName, lifespan }] }]
//   unconfirmedDuplicates(dups, confirmDistinct) -> ["new:1", ...]
//
// A summary is { handle, names: [{ given, surname }], gender?: 0|1|2|3, birthYear?: int|null, deathYear?: int|null };
// the first name is the primary name. A stub is { given, surname, gender?: "female"|"male"|"unknown", birthYear? }.

const SPECIAL = { "ß": "ss", "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };
const GENDER_NUM = { female: 0, male: 1, unknown: 2 };

// Case-folded, accent-stripped, punctuation turned to single spaces.
export function foldName(s) {
  if (s === null || s === undefined) return "";
  let t = String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  t = t.replace(/[ßøæœłđðþı]/g, (c) => SPECIAL[c]);
  return t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const words = (s) => (s ? s.split(" ") : []);

// Surnames: equal, one shared word of a compound surname, or one slip in a surname of five letters or more.
function surnameClose(a, b) {
  if (!a || !b) return false;
  if (a === b) return "exact";
  const wa = words(a);
  const wb = words(b);
  if (wa.some((w) => w.length >= 3 && wb.includes(w))) return "close";
  return Math.min(a.length, b.length) >= 5 && lev(a, b) <= 1 ? "close" : false;
}

// Given names: equal, same first word, a nickname or initial that starts the other ("prefix"), one slip in a word of
// four or more.
function givenClose(a, b) {
  if (!a || !b) return false;
  if (a === b) return "exact";
  const fa = words(a)[0];
  const fb = words(b)[0];
  if (fa === fb) return "close";
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (short.length === 1 && long.startsWith(short)) return "close"; // an initial
  if (Math.min(fa.length, fb.length) >= 4 && lev(fa, fb) <= 1) return "close"; // one slip
  // a short form that starts the longer one: "jon" / "jonathan". Weak on its own ("ann" starts anna, annabel,
  // anneliese): the caller accepts it only with an exact surname.
  return short.length >= 3 && long.startsWith(short) ? "prefix" : false;
}

const asYear = (n) => (Number.isInteger(n) && n > 0 ? n : null);

// A Gramps Person (JSON) as the matcher reads it. `eventOf(handle)` returns the Event, so a birth or death year can
// be read; without it the years are null.
export function summarizePerson(person, eventOf) {
  const names = [];
  const add = (n) => {
    if (!n || typeof n !== "object") return;
    const surnames = Array.isArray(n.surname_list) ? n.surname_list.map((s) => (s && s.surname) || "").filter(Boolean) : [];
    names.push({ given: n.first_name || "", surname: surnames.join(" ") });
  };
  add(person.primary_name);
  (Array.isArray(person.alternate_names) ? person.alternate_names : []).forEach(add);
  const yearAt = (idx) => {
    const ref = Array.isArray(person.event_ref_list) && idx >= 0 ? person.event_ref_list[idx] : null;
    const ev = ref && eventOf ? eventOf(ref.ref) : null;
    return ev && ev.date && Array.isArray(ev.date.dateval) ? asYear(ev.date.dateval[2]) : null;
  };
  return {
    handle: person.handle,
    names,
    gender: person.gender,
    birthYear: yearAt(person.birth_ref_index),
    deathYear: yearAt(person.death_ref_index),
  };
}

const displayName = (n) => [n.given, n.surname].map((s) => String(s || "").trim()).filter(Boolean).join(" ");

function lifespan(p) {
  if (p.birthYear === null || p.birthYear === undefined) {
    return p.deathYear ? `-${p.deathYear}` : "";
  }
  return `${p.birthYear}-${p.deathYear || ""}`;
}

// How well does one summary match one stub? 0 means not a candidate. Higher is better.
function score(stub, p) {
  const sg = GENDER_NUM[stub.gender];
  if (sg !== undefined && sg !== 2 && (p.gender === 0 || p.gender === 1) && p.gender !== sg) return 0;
  const sy = asYear(stub.birthYear);
  if (sy !== null && p.birthYear && Math.abs(sy - p.birthYear) > 3) return 0;
  const fg = foldName(stub.given);
  const fs = foldName(stub.surname);
  let best = 0;
  for (const n of p.names || []) {
    // A part that is empty on both sides matches by absence only: it adds no weight ("empty").
    const g = fg && foldName(n.given) ? givenClose(fg, foldName(n.given)) : fg || foldName(n.given) ? false : "empty";
    const s = fs && foldName(n.surname) ? surnameClose(fs, foldName(n.surname)) : fs || foldName(n.surname) ? false : "empty";
    if (!g || !s) continue;
    if (g === "empty" && s === "empty") continue;
    if (g === "prefix" && s !== "exact") continue;
    const w = (x) => (x === "exact" ? 2 : x === "empty" ? 0 : 1);
    best = Math.max(best, w(g) + w(s));
  }
  if (!best) return 0;
  if (sy !== null && p.birthYear && sy === p.birthYear) best += 1;
  return best;
}

// stubs: [{ for, stub }] or a plain array of stubs (then `for` is "new:<1-based index>").
// people: an iterable of summaries. opts.exclude: handles never offered (the people the request already names).
// opts.limit: candidates per stub (default 5).
export function findDuplicates(stubs, people, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const limit = opts.limit || 5;
  const pool = [...(people || [])].filter((p) => p && p.handle && !exclude.has(p.handle));
  const out = [];
  stubs.forEach((entry, i) => {
    const stub = entry && entry.stub ? entry.stub : entry;
    const id = entry && entry.for ? entry.for : `new:${i + 1}`;
    const hits = [];
    for (const p of pool) {
      const s = score(stub, p);
      if (s > 0) hits.push({ s, p });
    }
    hits.sort((a, b) => b.s - a.s || String(a.p.handle).localeCompare(String(b.p.handle)));
    if (hits.length) {
      out.push({
        for: id,
        candidates: hits.slice(0, limit).map(({ p }) => ({ handle: p.handle, displayName: displayName(p.names[0] || {}), lifespan: lifespan(p) })),
      });
    }
  });
  return out;
}

// ---- the possible-duplicate queue (HFY-TSK-295, edit-admin-delete) ---------------------------------------------------------------
// Pairs of people in the tree who may be one person, for an admin to look at and for io to merge on the desktop (a merge stays a desktop
// operation). It reads the same summaries and the same `score` as findDuplicates, so the queue and the relationship wizard agree on who
// "looks like" whom, and it writes nothing: there is no "flagged" state to store. The tree is not compared all against all. People are
// blocked first, by the first two and the last two letters of each surname word (a single slip leaves one end intact) and, when a block is
// large, by the first letter of the given name too. A pair that shares no block is never scored, which can miss a slip in a given name's
// first letter inside a big block; the wizard's per-stub search has no such limit. A small tree (SMALL_TREE people or fewer) is compared all
// against all instead, so the blocking's blind spots (a surname with no word of 3 letters or more, a slip at both ends of a surname) only
// exist in a large tree; the tests pin both.
//
// PRIVACY. The pair rows carry a `lifespan`. Scoring reads the raw years on the server (a year gap rules a pair out), but `opts.showYears(summary)`
// decides whether a person's lifespan is printed: the admin queue passes a predicate that blanks it for a living or unknown-status person, so a
// listing of the whole tree never carries a year the record API would withhold.
const GENDER_WORD = { 0: "female", 1: "male" };
const MAX_BLOCK = 300;
export const SMALL_TREE = 250;

/**
 * people: an iterable of summaries (summarizePerson). opts.minScore (default 3: an exact part and a close one, or two exact parts).
 * opts.showYears(summary) -> boolean: false blanks that person's `lifespan` in the output (default: shown). Scoring is unaffected.
 * -> [{ a: {handle, displayName, lifespan}, b: {...}, score }], best first, then by handle. A pair appears once.
 */
export function findDuplicatePairs(people, opts = {}) {
  const minScore = opts.minScore ?? 3;
  const showYears = typeof opts.showYears === "function" ? opts.showYears : () => true;
  const list = [...(people || [])].filter((p) => p && p.handle);
  const blocks = new Map();
  const put = (key, i) => { (blocks.get(key) ?? blocks.set(key, new Set()).get(key)).add(i); };
  list.forEach((p, i) => {
    for (const n of p.names || []) {
      const initial = foldName(n.given).slice(0, 1);
      for (const w of words(foldName(n.surname))) {
        if (w.length < 3) continue;
        put(`p:${w.slice(0, 2)}`, i);
        put(`s:${w.slice(-2)}`, i);
        put(`p:${w.slice(0, 2)}|${initial}`, i);
        put(`s:${w.slice(-2)}|${initial}`, i);
      }
    }
  });
  const seen = new Set();
  const out = [];
  const consider = (i, j) => {
    const [x, y] = i < j ? [i, j] : [j, i];
    const k = `${x}|${y}`;
    if (seen.has(k)) return;
    seen.add(k);
    const a = list[x];
    const b = list[y];
    let best = 0;
    for (const [from, to] of [[a, b], [b, a]]) { // the score is read from either side: "Tom" for "Thomas" only counts one way
      for (const n of from.names || []) {
        best = Math.max(best, score({ given: n.given, surname: n.surname, gender: GENDER_WORD[from.gender] ?? "unknown", birthYear: from.birthYear }, to));
      }
    }
    if (best >= minScore) {
      const [first, second] = String(a.handle) <= String(b.handle) ? [a, b] : [b, a];
      const view = (p) => ({ handle: p.handle, displayName: displayName((p.names || [])[0] || {}), lifespan: showYears(p) ? lifespan(p) : "" });
      out.push({ a: view(first), b: view(second), score: best });
    }
  };
  if (list.length <= SMALL_TREE) {
    for (let m = 0; m < list.length; m += 1) for (let n = m + 1; n < list.length; n += 1) consider(m, n);
    return sortPairs(out);
  }
  for (const [key, set] of blocks) {
    // A big block is compared only through its given-initial sub-blocks (the plain block of the same end is skipped).
    if (!key.includes("|") && set.size > MAX_BLOCK) continue;
    const ids = [...set];
    for (let m = 0; m < ids.length; m += 1) for (let n = m + 1; n < ids.length; n += 1) consider(ids[m], ids[n]);
  }
  return sortPairs(out);
}

const sortPairs = (out) => out.sort((p, q) => q.score - p.score || (p.a.handle < q.a.handle ? -1 : p.a.handle > q.a.handle ? 1 : p.b.handle < q.b.handle ? -1 : p.b.handle > q.b.handle ? 1 : 0));

// The `new:n` ids that have candidates and were not listed in confirmDistinct.
export function unconfirmedDuplicates(duplicates, confirmDistinct) {
  const ok = new Set(Array.isArray(confirmDistinct) ? confirmDistinct : []);
  return (duplicates || []).filter((d) => !ok.has(d.for)).map((d) => d.for);
}
