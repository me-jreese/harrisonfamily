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

// Given names: equal, same first word, a nickname or initial that starts the other, one slip in a word of four or more.
function givenClose(a, b) {
  if (!a || !b) return false;
  if (a === b) return "exact";
  const fa = words(a)[0];
  const fb = words(b)[0];
  if (fa === fb) return "close";
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (short.length === 1 && long.startsWith(short)) return "close"; // an initial
  if (short.length >= 3 && long.startsWith(short)) return "close"; // a short form that starts the longer one: "jon" / "jonathan"
  return Math.min(fa.length, fb.length) >= 4 && lev(fa, fb) <= 1 ? "close" : false;
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
    const g = fg && foldName(n.given) ? givenClose(fg, foldName(n.given)) : fg || foldName(n.given) ? false : "exact";
    const s = fs && foldName(n.surname) ? surnameClose(fs, foldName(n.surname)) : fs || foldName(n.surname) ? false : "exact";
    if (!g || !s) continue;
    best = Math.max(best, (g === "exact" ? 2 : 1) + (s === "exact" ? 2 : 1));
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

// The `new:n` ids that have candidates and were not listed in confirmDistinct.
export function unconfirmedDuplicates(duplicates, confirmDistinct) {
  const ok = new Set(Array.isArray(confirmDistinct) ? confirmDistinct : []);
  return (duplicates || []).filter((d) => !ok.has(d.for)).map((d) => d.for);
}
