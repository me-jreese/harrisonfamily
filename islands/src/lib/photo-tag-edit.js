// Site photo tagging, the editor's pure half (HFY-TSK-260, tag-editor-ui, flag photoTagEdit; HFY-PLN-002 BRD2 R-31, D2-24, SI-22; editing.md 5.3).
// No DOM and no React, so a node test pins it (tests/photo-tag-edit.test.mjs): the one rule that turns a drawn rectangle into the integer
// percent rect Gramps keeps, the geometry of drawing, moving and resizing a rectangle (pointer or keys), the match of a tag on the page to
// the MediaRef that stores it, and the EditOps that add, move or remove a tag.
//
// A photo tag is a Gramps MediaRef in the tagged person's `media_list`: `{ ref: <Media handle>, rect: [x1, y1, x2, y2] }`. It is addressed by
// the ops engine's key, `@ref=<handle>#<n>:<hash12>` (ref#n plus a base content hash, BRD2 11.2 item 5.3), computed by the same `keySegment`
// the API runs. The hash is the guard: a tag that changed after the editor read it has another hash, so the op reports a conflict and can
// never act on a different rectangle. The server decides on every write (field policy, validator, guard); nothing here is a policy.
import { keySegment } from "../../../api/src/records/ops.js";
import { areaWords, normalizeRect } from "./photo-tags.js";
import { isPersonId } from "./person-name.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---- the rect rule ---------------------------------------------------------------------------------------------------------------

/**
 * The one rule from a drawn rectangle to Gramps' integer percent (documented in docs/reference/front-end.md, pinned by the unit tests):
 *   1. The corners are put in order (the smaller x and y first) and held in 0..100. Values are first rounded to 6 decimals, so the
 *      29.999999999 a pointer sum leaves is 30 and does not grow a unit.
 *   2. x1 and y1 are floored, x2 and y2 are ceiled: the integer rectangle always contains the drawn one (outward rounding, sync design 9).
 *   3. The rectangle is at least 1 unit wide and 1 unit tall: a zero-size result grows by one unit toward the far edge, or toward the
 *      near edge when it already sits on the far one.
 *   4. [0, 0, 100, 100] is never sent: Gramps stores a full frame as `null`, which the site reads as a person tagged without an area. A
 *      drawn rectangle that rounds to the full frame is trimmed by one unit at the right and the bottom, [0, 0, 99, 99], so the tag stays a
 *      region.
 * Returns the four integers, or null when the input is not four finite numbers. The server validator accepts every result.
 */
export function toGrampsRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) return null;
  const snap = (v) => Math.round(clamp(v, 0, 100) * 1e6) / 1e6;
  const [a, b, c, d] = rect.map(snap);
  let x1 = Math.floor(Math.min(a, c));
  let y1 = Math.floor(Math.min(b, d));
  let x2 = Math.ceil(Math.max(a, c));
  let y2 = Math.ceil(Math.max(b, d));
  if (x2 - x1 < 1) { if (x1 < 100) x2 = x1 + 1; else x1 = 99; }
  if (y2 - y1 < 1) { if (y1 < 100) y2 = y1 + 1; else y1 = 99; }
  if (x1 === 0 && y1 === 0 && x2 === 100 && y2 === 100) { x2 = 99; y2 = 99; }
  return [x1, y1, x2, y2];
}

/** The box a new tag starts as when it is added by button rather than drawn: the middle quarter of the photo. */
export const DEFAULT_RECT = Object.freeze([35, 35, 65, 65]);

/** The smallest a tag is while it is edited, in percent of the photo. A drawn box smaller than this is a tap, not a tag. */
export const MIN_SIDE = 1;
export const DRAW_MIN = 2;

/** One nudge, in percent. */
export const STEP = 1;
/** One nudge with Shift held on a handle, in percent. */
export const BIG_STEP = 5;

// ---- geometry --------------------------------------------------------------------------------------------------------------------

/**
 * A pointer position as percent of the photo: (clientX, clientY) over `layer` (the layer's getBoundingClientRect(), the image's box), with
 * `contained` the picture inside it ({ x, y, w, h } in the layer's pixels, from photo-tags.js containedRect). Held in 0..100.
 * null when the picture has no size.
 */
export function pointToPercent(clientX, clientY, layer, contained) {
  if (!layer || !contained || !(contained.w > 0) || !(contained.h > 0)) return null;
  const px = ((clientX - layer.left - contained.x) / contained.w) * 100;
  const py = ((clientY - layer.top - contained.y) / contained.h) * 100;
  return { x: clamp(px, 0, 100), y: clamp(py, 0, 100) };
}

/** The ordered rectangle between two points ([x1, y1, x2, y2], min first). */
export const rectBetween = (p, q) => [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];

/** True when a drag from p to q is big enough to be a drawn box (both sides at least DRAW_MIN percent). */
export const isDrawn = (p, q) => Math.abs(p.x - q.x) >= DRAW_MIN && Math.abs(p.y - q.y) >= DRAW_MIN;

/** The rect shifted by (dx, dy) percent, kept inside the photo at its own size. */
export function moveRect(rect, dx, dy) {
  const [x1, y1, x2, y2] = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const nx = clamp(x1 + dx, 0, 100 - w);
  const ny = clamp(y1 + dy, 0, 100 - h);
  return [nx, ny, nx + w, ny + h];
}

export const EDGES = Object.freeze(["left", "right", "top", "bottom"]);
export const CORNERS = Object.freeze(["nw", "ne", "sw", "se"]);

/**
 * One edge moved by `delta` percent (negative is left or up): the edge stops at the photo's border and at MIN_SIDE from the opposite
 * edge, so the box never inverts and never leaves the photo.
 */
export function moveEdge(rect, edge, delta) {
  const [x1, y1, x2, y2] = rect;
  if (edge === "left") return [clamp(x1 + delta, 0, x2 - MIN_SIDE), y1, x2, y2];
  if (edge === "right") return [x1, y1, clamp(x2 + delta, x1 + MIN_SIDE, 100), y2];
  if (edge === "top") return [x1, clamp(y1 + delta, 0, y2 - MIN_SIDE), x2, y2];
  if (edge === "bottom") return [x1, y1, x2, clamp(y2 + delta, y1 + MIN_SIDE, 100)];
  return rect;
}

/** A corner dragged to a point (percent): the two edges that meet there follow it, with the same limits as moveEdge. */
export function dragCorner(rect, corner, point) {
  let out = rect;
  if (corner === "nw" || corner === "sw") out = moveEdge(out, "left", point.x - out[0]);
  else out = moveEdge(out, "right", point.x - out[2]);
  if (corner === "nw" || corner === "ne") out = moveEdge(out, "top", point.y - out[1]);
  else out = moveEdge(out, "bottom", point.y - out[3]);
  return out;
}

/** A corner nudged by (dx, dy) percent, for the keys on a handle. */
export function nudgeCorner(rect, corner, dx, dy) {
  const x = corner === "nw" || corner === "sw" ? rect[0] : rect[2];
  const y = corner === "nw" || corner === "ne" ? rect[1] : rect[3];
  return dragCorner(rect, corner, { x: x + dx, y: y + dy });
}

/** True when two rects (arrays or null) are the same four numbers. */
export const sameRect = (a, b) => (a == null || b == null ? a == null && b == null : Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));

// ---- who may do what -------------------------------------------------------------------------------------------------------------

/** Is the viewer the person (the Gramps id the session names, or the record /api/me names as theirs)? */
export function isSelf(me, grampsId) {
  if (!me || !grampsId) return false;
  const own = isObj(me.ownRecord) ? me.ownRecord.gramps_id : null;
  return me.id === grampsId || own === grampsId;
}

/** May the viewer open the tag editor at all? Signed in, and the server has not said editing is off (a missing `editing` is not "off"). */
export const canUseTagEditor = (me) => Boolean(me) && typeof me.id === "string" && me.id !== "" && me.editing !== false;

/**
 * May the viewer remove this tag? Their own (the tag names them: "untagging oneself", surfaces SURF-D20), or any for an admin. Moving or
 * resizing a tag, and adding one, are open to every member; the field policy decides whether that saves now or goes to review.
 */
export const canRemoveTag = (me, tag) => Boolean(me) && Boolean(tag) && (me.admin === true || isSelf(me, tag.grampsId));

/**
 * The route a change to `grampsId`'s record is expected to take, before the server has said so: "direct" for an admin or the viewer's own
 * record, else "review". A hint only (the dry run's plan is what the sheet shows).
 */
export const expectedRoute = (me, grampsId) => (me && (me.admin === true || isSelf(me, grampsId)) ? "direct" : "review");

// ---- the MediaRef of a tag -------------------------------------------------------------------------------------------------------

/** The elements of `obj.media_list` that point at the Media `mediaHandle`: [{ index, el, rect (as stored), segment (the op key) }]. */
export function mediaRefsOf(obj, mediaHandle) {
  const list = isObj(obj) && Array.isArray(obj.media_list) ? obj.media_list : [];
  const out = [];
  list.forEach((el, index) => {
    if (isObj(el) && el.ref === mediaHandle) out.push({ index, el, rect: el.rect === undefined ? null : el.rect, segment: keySegment("media_list", list, index) });
  });
  return out;
}

/**
 * The MediaRef that is the tag the page shows: the one for `mediaHandle` whose rect is `shown` (compared in normal order, so a rect the data
 * lists with reversed corners still matches). `nth` picks among identical elements (two tags of one person with one rect), in list order.
 * null when no element matches: the tag changed since the page's data was built, and nothing may act on it.
 */
export function findTagElement(obj, mediaHandle, shown, nth = 0) {
  const want = normalizeRect(shown);
  const hits = mediaRefsOf(obj, mediaHandle).filter((r) => (want === null ? normalizeRect(r.rect) === null : sameRect(normalizeRect(r.rect), want)));
  return hits[nth] || null;
}

/** A new MediaRef as Gramps keeps it: no notes, attributes or citations, not private. */
export const newMediaRef = (mediaHandle, rect) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: mediaHandle, rect });

// ---- the ops ---------------------------------------------------------------------------------------------------------------------

export const OP_IDS = Object.freeze({ add: "tag.add", move: "tag.rect", remove: "tag.remove" });

/** Op id -> the words an error names it by. */
export const OP_LABELS = Object.freeze({ "tag.add": "the new tag", "tag.rect": "the tag's place in the photo", "tag.remove": "the tag" });

/**
 * The ops of one change, against the tagged person's edit bundle ({ key, obj }).
 *   change = { kind: "add",    mediaHandle, rect }                 rect: drawn percent, converted here by toGrampsRect
 *          | { kind: "move",   mediaHandle, rect, from, nth }      from: the rect the page shows for the tag
 *          | { kind: "remove", mediaHandle, from, nth }
 * -> { ok: true, ops, labels, rect } or { ok: false, reason }: "stale" (no element is the tag the page shows, so nothing is sent),
 * "exists" (the person already has this very tag), "nochange", "invalid" (not a rect, or no media).
 * `add` is an `add` op on `/media_list`; `move` a `set` of `rect` at the element's key with the stored rect as base; `remove` a `remove` at
 * the key with the element as base. Every key carries the element's content hash.
 */
export function buildTagOps(bundle, change) {
  const key = bundle && bundle.key;
  const obj = bundle && bundle.obj;
  if (typeof key !== "string" || !isObj(obj) || !change || typeof change.mediaHandle !== "string" || !change.mediaHandle) return { ok: false, reason: "invalid" };
  const labels = OP_LABELS;
  if (change.kind === "add") {
    const rect = toGrampsRect(change.rect);
    if (!rect) return { ok: false, reason: "invalid" };
    // Compared in normal order, like findTagElement: a stored rect with reversed corners is the same box.
    if (mediaRefsOf(obj, change.mediaHandle).some((r) => sameRect(normalizeRect(r.rect), rect))) return { ok: false, reason: "exists" };
    const value = newMediaRef(change.mediaHandle, rect);
    const op = Array.isArray(obj.media_list)
      ? { id: OP_IDS.add, op: "add", obj: key, path: "/media_list", value }
      : { id: OP_IDS.add, op: "set", obj: key, path: "/media_list", base: null, value: [value] };
    return { ok: true, ops: [op], labels, rect };
  }
  if (change.kind !== "move" && change.kind !== "remove") return { ok: false, reason: "invalid" };
  const found = findTagElement(obj, change.mediaHandle, change.from, change.nth || 0);
  if (!found) return { ok: false, reason: "stale" };
  if (change.kind === "remove") {
    return { ok: true, ops: [{ id: OP_IDS.remove, op: "remove", obj: key, path: `/media_list/${found.segment}`, base: JSON.parse(JSON.stringify(found.el)) }], labels, rect: null };
  }
  const rect = toGrampsRect(change.rect);
  if (!rect) return { ok: false, reason: "invalid" };
  if (sameRect(rect, found.rect)) return { ok: false, reason: "nochange" };
  return { ok: true, ops: [{ id: OP_IDS.move, op: "set", obj: key, path: `/media_list/${found.segment}/rect`, base: found.rect, value: rect }], labels, rect };
}

// ---- the page's own copy of the tags ---------------------------------------------------------------------------------------------

/**
 * The raw `tags[]` of a mediaGallery item after a change that saved now, so the lightbox shows it without a reload. Returns a new array;
 * `rect` is the integer rect that was stored. A change that went to review changes nothing here (it is a suggestion, not a tag yet).
 * The tag is matched like the MediaRef is: same person, same rect in normal order, `nth` among identical ones.
 */
export function applyToTags(tags, change, rect) {
  const list = Array.isArray(tags) ? tags.slice() : [];
  const same = (t) => isObj(t) && t.grampsId === change.grampsId && sameRect(normalizeRect(t.rect), normalizeRect(change.from));
  if (change.kind === "add") {
    list.push({ grampsId: change.grampsId, name: change.name, rect, isPrimary: false, attributes: [], notes: [], citations: [], source: "site" });
    return list;
  }
  let seen = 0;
  const at = list.findIndex((t) => same(t) && seen++ === (change.nth || 0));
  if (at < 0) return list;
  if (change.kind === "remove") list.splice(at, 1);
  else list[at] = { ...list[at], rect };
  return list;
}

/** Which of the identical tags (same person, same rect) the tag at `index` of the raw list is: 0 for the first, 1 for the second. */
export function nthOf(tags, index) {
  const t = tags[index];
  if (!isObj(t)) return 0;
  const r = normalizeRect(t.rect);
  let n = 0;
  for (let i = 0; i < index; i += 1) if (isObj(tags[i]) && tags[i].grampsId === t.grampsId && sameRect(normalizeRect(tags[i].rect), r)) n += 1;
  return n;
}

// ---- the words -------------------------------------------------------------------------------------------------------------------
// DS voice: lowercase, plain, no Gramps terms (the copy test runs the JARGON pattern over every string).

export const TAG_COPY = Object.freeze({
  toggle: "tag people",
  heading: "tag people in this photo",
  intro: "draw a box around someone, or press add a tag. then pick who it is.",
  addTag: "add a tag",
  tagMyself: "tag myself",
  pick: "who is this?",
  pickHint: "pick a person from the list. typing a name alone isn't enough.",
  pickSearching: "searching",
  pickNone: "nobody matches.",
  pickPicked: "tagged:",
  pickAnother: "pick someone else",
  existing: "tag:",
  pickFirst: "pick who this is to save the tag.",
  boxHeading: "where in the photo",
  drag: "drag the box or its corners, or use the buttons.",
  moveBox: "move the whole box",
  edge: Object.freeze({ left: "left edge", right: "right edge", top: "top edge", bottom: "bottom edge" }),
  save: "save this tag",
  remove: "remove this tag",
  cancel: "cancel",
  routeDirect: "this saves now.",
  routeReview: "this goes to review, because it is on someone else's page.",
  removeOwn: "you can remove a tag of yourself.",
  working: "one moment",
  staleTag: "this tag changed while you were looking. close the photo and open it again to see it as it is now.",
  exists: "that person is already tagged there.",
  nochange: "nothing moved, so there is nothing to save.",
  invalid: "that box can't be saved. try drawing it again.",
  loadFailed: "we couldn't open that person's page to save the tag. try again in a moment.",
  tapHint: "tap a box to change it.",
  noAreaHeading: "tagged without a box",
  noAreaHint: "these people are tagged in this photo but no box is marked. give one a box, or remove the tag.",
  noAreaGive: (name) => `${name}: mark where they are`,
  finishFirst: "save or cancel the change you are making before you draw a new box.",
  regionLabel: (name) => `${name}: change this tag`,
  handleLabel: Object.freeze({ nw: "resize from the top left corner", ne: "resize from the top right corner", sw: "resize from the bottom left corner", se: "resize from the bottom right corner" }),
  nudgeLabel: (edge, dir) => `move the ${edge} ${dir}`,
  moveLabel: (dir) => `move the box ${dir}`,
  statusArea: (rect) => `the box now covers: ${areaWords(rect)}`,
  savedDirect: "saved. the tag is on the photo.",
  savedReview: "sent for review. you can change or withdraw it until an admin looks.",
  removedDirect: "the tag is removed.",
  tagsChanged: "this photo's tags just changed — please check your edits.",
  seeSuggestions: "see your suggestions",
  undo: "undo",
  undone: "undone. the tags are as they were.",
  undoConflict: "this photo's tags changed since, so the undo was not applied. please check them.",
  undoFailed: "we couldn't undo that. the change stays."
});

/** The sentence the confirmation sheet shows for one op, in plain words. `name` is the tagged person's name. */
export function tagSentence(kind, name) {
  const who = name || "someone";
  if (kind === "add") return `tag ${who} in this photo`;
  if (kind === "remove") return `remove ${who}'s tag from this photo`;
  return `change where ${who} is tagged in this photo`;
}

/** Every plain-words string above, for the copy test. */
export function allTagText() {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") out.push(String(v([1, 2, 3, 4], "y")));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(TAG_COPY);
  out.push(tagSentence("add", "x"), tagSentence("move", "x"), tagSentence("remove", "x"));
  return out;
}

/** True when `id` can be a tag's person (a Gramps person id). The picker only ever yields one. */
export const isTaggable = (id) => isPersonId(id);
