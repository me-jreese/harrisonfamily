// The names form's small pure helpers (HFY-TSK-156). Kept apart from editor-sections.js (which pulls in the ops engine) because editor-model.js
// needs them and the edit entry on every person page loads editor-model.js: this file must stay tiny and import nothing.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

/** The names form: `[field, title]`, the Name properties plus the virtual `surname` (the primary surname of `surname_list`). */
export const NAME_FIELDS = Object.freeze([
  ["first_name", "given names"],
  ["surname", "last name at birth"],
  ["call", "name you go by"],
  ["nick", "nickname"],
  ["title", "title"],
  ["suffix", "suffix"]
]);

/** The given-name tokens of a first_name string ("Mary Ann" -> ["Mary", "Ann"]). */
export const givenTokens = (first) => str(first).split(/\s+/).filter(Boolean);
/** The first and middle parts of the given names, for the read-only labels. */
export function givenParts(first) {
  const t = givenTokens(first);
  return { first: t[0] || "", middle: t.slice(1).join(" ") };
}

/** The index of the surname element the form edits: the primary one, else the first, else -1. */
export function primarySurnameIndex(name) {
  const l = list(isObj(name) ? name.surname_list : null);
  const i = l.findIndex((s) => isObj(s) && s.primary === true);
  return i >= 0 ? i : l.length ? 0 : -1;
}

/** The values of the names form, read from the primary name. */
export function nameValues(obj) {
  const n = isObj(obj && obj.primary_name) ? obj.primary_name : {};
  const out = {};
  for (const f of ["first_name", "call", "nick", "title", "suffix"]) if (typeof n[f] === "string" && n[f] !== "") out[f] = n[f];
  const i = primarySurnameIndex(n);
  const s = i >= 0 ? list(n.surname_list)[i] : null;
  if (s && typeof s.surname === "string" && s.surname !== "") out.surname = s.surname;
  return out;
}

