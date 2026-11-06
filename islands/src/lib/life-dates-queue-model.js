// Life dates rapid-entry queue (HFY-TSK-388-0E, flag lifeDatesV1; BRD 5.7, D-17..D-28, D-26, board B6; rulings P4-R2, P4-R20, P4-R28). Pure: no DOM, no CSS.
// Source: the published people list the person pages use (/person/index.json, `lifespanSummary` and `birthYear`). The cutoff is rolling now minus 100
// years (P4-R20). It orders the queue and unlocks 'died, year unknown'; it never marks anyone. Rows, in this order: people born before the cutoff with
// no death on file (oldest birth first, a 'death' card), then people with no birth year (a separate 'birth' card). Born after the cutoff with no death
// is not asked about (likely living). The words "event", "life event", "role", "MediaRef" and "region" never appear in anything the member reads.
import { COPY as LD, buildBody, errorText, readReply, sureText, validate } from "./life-dates-model.js";

export { errorText, readReply, sureText };
export const CUTOFF_YEARS = 100;
export const cutoffYear = (now = new Date()) => now.getFullYear() - CUTOFF_YEARS;

export const COPY = Object.freeze({
  title: "help fill in dates",
  lede: "add the years you know. skip anyone you aren't sure about.",
  save: "save and next",
  saving: "saving",
  skip: "skip",
  dontKnow: "i don't know",
  unknownDeath: "died, year unknown",
  unknownNote: "an admin will look at this before anything changes.",
  enterYear: "enter a year, like 1890.",
  yes: LD.sureYes,
  no: LD.sureNo,
  finding: "finding the next person",
  loading: "loading the people",
  loadFailed: "couldn't load the list of people. try again in a moment.",
  retry: "try again",
  signIn: "sign in to help fill in dates.",
  signInLink: "sign in",
  off: "help fill in dates isn't available yet.",
  emptyTitle: "nothing missing here.",
  emptyBody: "everyone we can ask about has their years. thank you.",
  doneTitle: "that's everyone in this branch. thank you.",
  pendingNote: "pending review"
});

export const ask = (row) => (row.kind === "birth" ? `what year was ${row.name} born?` : `what year did ${row.name} die?`);
export const knownLine = (row) => (row.kind === "death" ? `born ${row.bornYear}` : "birth year not recorded");
export const progressText = (n, total) => `${n} of ${total} people in this branch`;
export const addedText = (n) => `you've added ${n}`;
export const sentText = (next) => (next ? `sent for review. next: ${next}.` : "sent for review.");
export const askKey = (row) => (row.kind === "birth" ? "birth" : "death");

const yearsIn = (s) => { const out = []; const re = /(\d{4})/g; let m; while ((m = re.exec(s))) out.push(Number(m[1])); return out; };
const deathOnly = (s) => /^\s*(d\.|died\b|[-–—])/i.test(s);
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });

/** The queue rows from the published people list: [{id, name, kind: "death"|"birth", bornYear}]. */
export function candidatesFrom(manifest, now = new Date()) {
  const list = Array.isArray(manifest && manifest.people) ? manifest.people : Array.isArray(manifest) ? manifest : [];
  const cutoff = cutoffYear(now);
  const death = [];
  const birth = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p.grampsId !== "string" || !/^I\d+$/.test(p.grampsId) || seen.has(p.grampsId)) continue;
    const name = String(p.displayName || "").trim();
    if (!name) continue;
    seen.add(p.grampsId);
    const summary = String(p.lifespanSummary || "");
    const ys = yearsIn(summary);
    const donly = deathOnly(summary);
    const born = typeof p.birthYear === "number" && p.birthYear > 0 ? p.birthYear : donly ? null : ys[0] ?? null;
    const hasDeath = donly ? ys.length > 0 : ys.length > 1;
    if (born === null) birth.push({ id: p.grampsId, name, kind: "birth", bornYear: null });
    else if (!hasDeath && !donly && born < cutoff) death.push({ id: p.grampsId, name, kind: "death", bornYear: born });
  }
  death.sort((a, b) => a.bornYear - b.bornYear || byId(a, b));
  birth.sort(byId);
  return [...death, ...birth];
}

/** True when the date asked about is empty and not shared: a precise date, a shared date, or a year already on file skips the person. */
export function eligible(row, classes) {
  const c = classes && classes[askKey(row)];
  return Boolean(c) && c.cls === "none" && c.shared !== true;
}

const blank = { year: "", about: false, unknown: false };
const cardDraft = (row, text, unknown) => (row.kind === "birth"
  ? { draft: { birth: { year: text, about: false }, death: blank }, current: { birth: null, death: null } }
  : { draft: { birth: blank, death: { year: text, about: false, unknown } }, current: { birth: { year: row.bornYear, about: false, locked: true }, death: null } });

/** { error } for a bad year, else { years, needsSure } (died >= born, 1600..this year, over 120 years asks). */
export function checkCard(row, text, now = new Date()) {
  const { draft, current } = cardDraft(row, String(text).trim(), false);
  const v = validate(draft, current, now);
  const error = v.errors[askKey(row)];
  return error ? { error } : { years: v.years, needsSure: v.needsSure };
}

/** The body for POST /api/life-dates: only the asked year (or {unknown: true}); null when there is nothing to send. */
export function cardBody(handle, row, text, { confirm = false, unknown = false } = {}) {
  const { draft, current } = cardDraft(row, String(text).trim(), unknown && row.kind === "death");
  return buildBody(handle, draft, current, { confirm });
}

const pendingKey = (id) => `hfy:lifedates:pending:${id}`;
/** What this browser already sent for a person this session (the person page shows it as 'pending review' to the sender only). */
export function readPending(storage, id) {
  try { return JSON.parse(storage.getItem(pendingKey(id)) || "null") || {}; } catch { return {}; }
}
export function addPending(storage, id, saved) {
  try { storage.setItem(pendingKey(id), JSON.stringify({ ...readPending(storage, id), ...saved })); } catch { /* the queue still moves on */ }
}
export const alreadySent = (storage, row) => Boolean(readPending(storage, row.id)[askKey(row)]);
