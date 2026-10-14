// The R-18 composer pre-check verdict (HFY-PLN-002 BRD2 5.3, task privacy-guard-existing-paths AC2): the same detector the API
// runs, shared/privacy-guard.mjs, bundled into the islands. No DOM and no CSS here, so the comment and content sources (and their
// Node contract tests) can use it; lib/contact-guard.js draws it on the composers.
//
// The DOB heuristic is off here until the API refuses one: its first dob_not_allowed answer (the HFY_GUARD_DOB switch is on)
// turns the same check on for this page (learnFromRefusal), so the highlight then matches what the server enforces.
import { COPY, DOB_KINDS, KINDS, scanText } from "../../../shared/privacy-guard.mjs";

export const GUARD_COPY = COPY;
export const GUARD_CODES = Object.freeze(["contact_info", "dob_not_allowed"]);
const CONTACT_KINDS = KINDS.filter((k) => !DOB_KINDS.includes(k));
let dob = false;
const listeners = new Set();

/** Calls `fn` when the kinds checked change (the DOB heuristic turned on); returns an unsubscribe. */
export function onKindsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The API refused with this code: dob_not_allowed means the server's DOB switch is on, so check birthdays here too. */
export function learnFromRefusal(code) {
  if (code !== "dob_not_allowed" || dob) return;
  dob = true;
  for (const fn of listeners) fn();
}

/** `null`, or `{code, message, spans: [{kind, start, end}]}` for one text, with the kinds the server refuses today. */
export function precheck(text) {
  if (typeof text !== "string" || text === "") return null;
  const hits = scanText(text, dob ? {} : { kinds: CONTACT_KINDS });
  if (hits.length === 0) return null;
  const code = hits.every((h) => DOB_KINDS.includes(h.kind)) ? "dob_not_allowed" : "contact_info";
  return { code, message: COPY[code], spans: hits.map(({ kind, start, end }) => ({ kind, start, end })) };
}

/** The first refusal over several texts (a post's body, title and alts), or null. */
export const precheckAll = (texts) => texts.map(precheck).find(Boolean) ?? null;

/** Overlapping or touching spans merged, in order (a phone number inside a street address marks once). */
export function mergeSpans(spans) {
  const out = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}
