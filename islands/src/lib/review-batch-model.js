// The review queue's batch, compare and deceased rules (HFY-TSK-388-0F; HFY-PLN-004 BRD D-19, D-27, Q-L2; board B9). No DOM and no React, so a node
// test pins the words and the rules (tests/review-batch-model.test.mjs). Everything here is behind the client flag lifeDatesV1 (HFY-TSK-388-0D creates it).
// Copy is lowercase and plain. The words event, life event, role, MediaRef and region never appear in it (tests/review-batch-model.test.mjs).
import { isOutOfDate } from "./review-model.js";

export const LIFE_DATES_FLAG = "lifeDatesV1";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

export const BATCH_COPY = Object.freeze({
  batchH: "ready to approve together",
  batchLead: "years and tags nobody disagrees on. untick any you want to look at on its own.",
  approveN: (n) => `approve ${n}`,
  nothingPicked: "tick at least one to approve.",
  contestedH: "left out of the batch",
  contestedLead: "different people sent different answers for these. they are never approved together; compare them one at a time.",
  compare: "compare",
  compareH: "two answers",
  compareLegend: (name) => `which answer is right for ${name}?`,
  compareLead: "pick one. nothing is overwritten until you approve it, and the other stays on the list as out of date.",
  useThis: "use this one",
  neither: "neither, ask them",
  closeCompare: "back to the list",
  sentBy: "sent by",
  askedBoth: "asked. they'll see your question.",
  askReason: "two people sent different years for this page. can you check with each other and send one?",
  deceasedH: "this will mark them as deceased",
  deceasedLead: (names) => (names.length === 1 ? `approving ${names[0]}'s death year does this:` : "approving these death years does this:"),
  deceasedWhat: "on the site they stop being treated as living, so their name and dates can show to members.",
  deceasedConfirm: "mark as deceased and approve",
  deceasedRow: "marks them deceased",
  keepWaiting: "cancel",
  doneN: (n) => `approved ${n}. they reach Gramps on the next sync.`,
  partial: (ok, bad) => `approved ${ok}. ${bad} didn't go through; they're still on the list.`,
  noneWent: "none of them went through. try again in a moment.",
  working: "working on it",
  notThisOne: "not this one",
  proposedBox: "the dashed box shows where it would go.",
  born: "born",
  died: "died",
  about: "about",
  yearUnknown: "year unknown",
  someone: "someone",
  tagLine: "a tag on a photo",
  photoLine: "a photo",
  portraitLine: "a new portrait",
  thumbAlt: "the photo, with the suggested tag box dashed",
});

// ---- what a suggestion is --------------------------------------------------------------------------------------------------------
export const intentOf = (view) => (view && isObj(view.intent) ? view.intent : {});

const yearField = (f) => {
  if (!isObj(f)) return null;
  if (f.unknown === true) return { unknown: true, year: null, about: false };
  return Number.isInteger(f.year) ? { unknown: false, year: f.year, about: f.about === true } : null;
};

/** A life-dates suggestion's rows: { target, birth, death } (each { year, about, unknown } or null), else null. */
export function lifeDatesOf(view) {
  const i = intentOf(view);
  if (i.type !== "life_dates") return null;
  const subject = isObj(view.subject) ? view.subject : {};
  return { target: str(i.target) || (subject.handle ? `Person:${subject.handle}` : ""), birth: yearField(i.birth), death: yearField(i.death) };
}

const isDeathEventValue = (v) => isObj(v) && (v.type === "Death" || (isObj(v.type) && (v.type.string === "Death" || v.type.value === 12)));

/** Does approving this add a death? The life-dates marker, or an op that adds a Death record (D-19: any approval that adds a death). */
export function deathAdded(view) {
  const i = intentOf(view);
  if (i.type === "life_dates") return i.marks_deceased === true;
  return arr(view && view.ops).some((o) => isObj(o) && (o.op === "add" || o.op === "create") && isDeathEventValue(o.value));
}

/** The first op that carries a photo box: { ref, rect: [x1, y1, x2, y2] (whole percent) | null, kind }. */
export function tagOf(view) {
  for (const o of arr(view && view.ops)) {
    if (!isObj(o) || !/(^|\/)media_list(\/|$)/.test(str(o.path))) continue;
    const v = isObj(o.value) ? o.value : null;
    const rect = v && Array.isArray(v.rect) && v.rect.length === 4 && v.rect.every(Number.isFinite) ? v.rect : (/\/rect$/.test(str(o.path)) && Array.isArray(o.value) && o.value.length === 4 ? o.value : null);
    const ref = v && str(v.ref);
    if (rect || (o.op === "remove" && /\/rect$/.test(str(o.path)))) return { ref: ref || "", rect, kind: o.op === "remove" ? "remove" : o.op === "add" ? "add" : "move" };
  }
  const i = intentOf(view);
  if (i.type === "photo_tag" || i.type === "tag") return { ref: str(i.media), rect: null, kind: "add" };
  return null;
}

/** "years" | "tag" | "media" | "other": which card a suggestion gets. */
export function classOf(view) {
  if (!view) return "other";
  if (lifeDatesOf(view)) return "years";
  if (tagOf(view)) return "tag";
  const i = intentOf(view);
  const cls = isObj(view.subject) ? view.subject.cls : "";
  if (["portrait", "media_add", "media"].includes(i.type) || cls === "Media") return "media";
  if (arr(view.ops).some((o) => isObj(o) && /(^|\/)media_list(\/|$)/.test(str(o.path)))) return "media";
  if (view.kind === "create" && arr(view.ops).some((o) => isObj(o) && (o.cls === "Media" || (isObj(o.value) && o.value._class === "Media")))) return "media";
  return "other";
}

export const isPortrait = (view) => intentOf(view).type === "portrait" || /portrait/i.test(arr(view && view.summary).map((s) => (isObj(s) ? str(s.text) : str(s))).join(" "));

/** A same-origin thumbnail path the suggestion names, or "". Nothing else is ever loaded. */
export function thumbOf(view) {
  const i = intentOf(view);
  const u = str(i.thumb_url) || str(i.media_url);
  return /^\/[^/]/.test(u) ? u : "";
}

const yearText = (f) => (!f ? "" : f.unknown ? BATCH_COPY.yearUnknown : `${f.about ? `${BATCH_COPY.about} ` : ""}${f.year}`);
/** "born about 1890 · died 1962" for a life-dates suggestion. */
export function yearsLine(view) {
  const l = lifeDatesOf(view);
  if (!l) return "";
  const parts = [];
  if (l.birth) parts.push(`${BATCH_COPY.born} ${yearText(l.birth)}`);
  if (l.death) parts.push(`${BATCH_COPY.died} ${yearText(l.death)}`);
  return parts.join(" · ");
}

// ---- the batch and the contested --------------------------------------------------------------------------------------------------
const subjectKey = (view) => {
  const l = lifeDatesOf(view);
  if (l && l.target) return l.target;
  const s = isObj(view.subject) ? view.subject : {};
  return s.handle ? `Person:${s.handle}` : str(s.gramps_id);
};

/** The person a suggestion is about, by Gramps id. */
export const personIdOf = (view) => (isObj(view && view.subject) ? str(view.subject.gramps_id) : "");

const waiting = (v) => Boolean(v) && v.state === "pending" && !isOutOfDate(v);

/**
 * Splits the waiting suggestions (Q-L2). `batch`: years and tags with no rival, in list order. `groups`: contested years, one per person and row
 * (birth or death), with every rival answer; `contested`: every suggestion that sits in a group or shares a photo and person with another tag.
 * Photos and portraits are never batched. `deceased`: the batch rows that add a death.
 */
export function splitQueue(views) {
  const list = arr(views).filter(waiting);
  const byField = new Map(); // `${person}|${field}` -> Map(answer -> [views])
  const tagCount = new Map();
  for (const v of list) {
    const l = lifeDatesOf(v);
    if (l) {
      for (const field of ["birth", "death"]) {
        if (!l[field]) continue;
        const key = `${subjectKey(v)}|${field}`;
        const ans = l[field].unknown ? "unknown" : String(l[field].year) + (l[field].about ? "~" : "");
        if (!byField.has(key)) byField.set(key, new Map());
        const m = byField.get(key);
        m.set(ans, [...(m.get(ans) || []), v]);
      }
    } else if (classOf(v) === "tag") {
      const t = tagOf(v);
      const key = `${subjectKey(v)}|${t.ref}`;
      tagCount.set(key, (tagCount.get(key) || 0) + 1);
    }
  }
  const groups = [];
  const contestedIds = new Set();
  for (const [key, answers] of byField) {
    if (answers.size < 2) continue;
    const entries = [...answers.values()].flat();
    const [target, field] = key.split("|");
    groups.push({ key, target, field, entries, personId: personIdOf(entries[0]) });
    for (const e of entries) contestedIds.add(e.id);
  }
  for (const v of list) {
    if (classOf(v) !== "tag") continue;
    const t = tagOf(v);
    if (tagCount.get(`${subjectKey(v)}|${t.ref}`) > 1) contestedIds.add(v.id);
  }
  const batch = list.filter((v) => (classOf(v) === "years" || classOf(v) === "tag") && !contestedIds.has(v.id));
  const contested = list.filter((v) => contestedIds.has(v.id));
  return { batch, contested, groups, deceased: batch.filter(deathAdded) };
}

/** The names to show in a deceased confirm, one per person, from the people index (a person with no name there is "someone"). */
export function deceasedNames(views, names) {
  const seen = new Set();
  const out = [];
  for (const v of arr(views)) {
    if (!deathAdded(v)) continue;
    const id = personIdOf(v);
    const key = id || v.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push((names && names.get && names.get(id)) || BATCH_COPY.someone);
  }
  return out;
}
