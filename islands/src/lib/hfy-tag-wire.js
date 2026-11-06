// HFY-TSK-388-0G (plan HFY-PLN-004, pass 1): the wire half of the HFY tag adapter. Pure, no DOM, no kit import, so the CodeArtifact-free conformance suite
// (tests/tagging/wire-conformance.test.mjs) runs it. It turns a kit TagOp (BRD D-04: add always appends | move | remove, addressed by person, media, index and
// rect) into the SAME EditOps the shipped tag editor sends (HFY-TSK-260, lib/photo-tag-edit.js buildTagOps): the op ids, the paths, the key segment
// `@ref=<handle>#<n>:<hash12>` and the `base` guard are the shipped ones, so POST /api/changes treats both alike (own record direct, another person's by proposal,
// D-09; the server decides). The ruled differences from the shipped editor are two: a rect is rounded to the NEAREST whole percent, half up (P4-R16, D-02;
// the shipped editor rounds outward), and add always appends (D-04; the shipped editor refuses an identical second tag).
// A MediaRef is written with private=false on create (D-06); a move sets only `/rect` and a remove drops the element, so `private` on an existing ref is kept.
import { canonicalJson, hash12, keySegment } from "../../../api/src/records/ops.js";
import { MIN_TAG_UNITS, RectInvalid, normalizeRect, validateNewRect } from "../../../api/src/rect.js";

export { MIN_TAG_UNITS, RectInvalid, normalizeRect, validateNewRect };

/** The op ids the shipped editor uses; the server's field policy and the confirmation copy key on them. */
export const OP_IDS = Object.freeze({ add: "tag.add", move: "tag.rect", remove: "tag.remove" });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Two rects are the same box (null is the whole image). Both sides go through the Gramps-exact read first. */
export const sameRect = (a, b) => (a == null || b == null ? a == null && b == null : a.length === b.length && a.every((v, i) => v === b[i]));

/** A stored rect read the Gramps way, or `undefined` when it is garbage (so it never equals anything). */
export function readRect(raw) {
  try { return normalizeRect(raw === undefined ? null : raw); } catch { return undefined; }
}

/**
 * The integer rect a drawn (possibly fractional) box is stored as: nearest whole percent, half up, clamped and ordered; null for the whole image and a point.
 * It is the same function the read side uses (P4-R16), so what is written reads back unchanged. The kit editor snaps before it sends; this is for any other caller.
 */
export const emitRect = (drawn) => normalizeRect(drawn);

/** The authoring guard (D-07): the rect a new tag or a move target may be stored as, or a RectInvalid (code RECT_INVALID, `reason` the guard's code). */
export function authorRect(rect) {
  const r = validateNewRect(rect);
  if (!r.ok) throw Object.assign(new RectInvalid(`rect refused: ${r.code}`), { reason: r.code });
  return r.rect;
}

/** A new MediaRef exactly as the shipped editor and the desk write it (T-1: web equals desk twin, field for field). */
export const newMediaRef = (mediaHandle, rect) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: mediaHandle, rect });

/**
 * Plan one kit TagOp against a person's edit bundle `{ key, version, obj }` (GET /api/edit/Person/:ref) and the Media's handle.
 * -> { ok: true, ops, rect, index } | { ok: false, reason: "stale" | "nochange" | "invalid" | "identical" }
 *   add     appends a MediaRef; `index` is where it lands (the length of media_list). A second tag with an identical rect is not refused. One limit: when the person
 *           already holds a MediaRef byte-identical to the new one, the ops engine treats `add` as an idempotent no-op (api/src/records/ops.js, "an identical
 *           element is present"), so nothing can be appended; the plan says { ok: false, reason: "identical", index } with the index of the tag already there. D-04 wants
 *           an append here; that needs an API change and is raised on the record (docs/reference/BASELINE.md, row T-9).
 *   move    needs list[index] to be a MediaRef of this Media whose rect equals op.from; anything else is "stale" (never moves another rectangle).
 *   remove  the same address check against op.rect; the op carries the whole element as its `base`, as the shipped editor's does.
 */
export function planTagOp(bundle, mediaHandle, op) {
  const key = bundle && bundle.key;
  const obj = bundle && bundle.obj;
  if (typeof key !== "string" || !isObj(obj) || typeof mediaHandle !== "string" || !mediaHandle || !op) return { ok: false, reason: "invalid" };
  if (op.op === "add") {
    let rect;
    try { rect = authorRect(op.rect); } catch { return { ok: false, reason: "invalid" }; }
    const value = newMediaRef(mediaHandle, rect);
    const has = Array.isArray(obj.media_list);
    const twin = has ? obj.media_list.findIndex((el) => isObj(el) && canonicalJson(el) === canonicalJson(value)) : -1;
    if (twin >= 0) return { ok: false, reason: "identical", index: twin, rect };
    const o = has
      ? { id: OP_IDS.add, op: "add", obj: key, path: "/media_list", value }
      : { id: OP_IDS.add, op: "set", obj: key, path: "/media_list", base: null, value: [value] };
    return { ok: true, ops: [o], rect, index: has ? obj.media_list.length : 0 };
  }
  if (op.op !== "move" && op.op !== "remove") return { ok: false, reason: "invalid" };
  const list = Array.isArray(obj.media_list) ? obj.media_list : [];
  const el = Number.isInteger(op.index) ? list[op.index] : undefined;
  const expected = readRect(op.op === "move" ? op.from : op.rect);
  const current = isObj(el) ? readRect(el.rect) : undefined;
  if (!isObj(el) || el.ref !== mediaHandle || expected === undefined || current === undefined || !sameRect(current, expected)) return { ok: false, reason: "stale" };
  const seg = keySegment("media_list", list, op.index);
  if (op.op === "remove") return { ok: true, ops: [{ id: OP_IDS.remove, op: "remove", obj: key, path: `/media_list/${seg}`, base: clone(el) }], rect: current, index: op.index };
  let to;
  try { to = authorRect(op.to); } catch { return { ok: false, reason: "invalid" }; }
  if (sameRect(current, to)) return { ok: false, reason: "nochange" };
  return { ok: true, ops: [{ id: OP_IDS.move, op: "set", obj: key, path: `/media_list/${seg}/rect`, base: el.rect === undefined ? null : el.rect, value: to }], rect: to, index: op.index };
}

/** The POST /api/changes body for planned ops: the shipped editor's `changesBody` shape. */
export function changesBody({ bundle, ops, note = "" }) {
  const body = { target: bundle.key, base_versions: { [bundle.key]: bundle.version }, ops };
  if (note) body.note = note;
  return body;
}

/**
 * A deterministic Idempotency-Key (36 hex characters) for one planned op against one record version: a retry of the same op on the same version is the same
 * key, so the server answers it once; a new record version is a new key.
 */
export function idempotencyKey(parts) {
  const s = JSON.stringify(parts);
  return `${hash12(s)}${hash12(`1${s}`)}${hash12(`2${s}`)}`;
}
