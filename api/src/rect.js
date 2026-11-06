// Rect helpers shared by member web uploads (web-upload.js) and the post-photo graduation (post-graduate.js). HFY-TSK-388-0A; ruling P4-R16, BRD D-02, D-03, D-07.
// The fixtures every implementation must agree on are tests/tagging/fixtures/tag-conformance.fixtures.json (api/test/rect.test.js loads them; the kit and the Gramps
// side read the same file).
//
// READ/COMPARE, normalizeRect: Gramps-exact. A rect is [x1, y1, x2, y2] in integer percent (0..100). The result is null ONLY for no region, the full frame
// (0,0,100,100) and a point (x1 == x2 and y1 == y2); a box with one zero-extent axis is kept as typed. Values are rounded half up, clamped to 0..100 and ordered.
// AUTHORING, validateNewRect: what a new tag or crop must be: integers on the 0..100 grid, x1 < x2 and y1 < y2, at least 2 x 2 units (D-07); the full frame is ok and null.
export class RectInvalid extends RangeError {
  constructor(message) {
    super(message);
    this.code = "RECT_INVALID";
  }
}

export const MIN_TAG_UNITS = 2;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v) => Math.min(100, Math.max(0, v));

/** normalizeRect(input) -> [int, int, int, int] | null. Throws RectInvalid (code RECT_INVALID) for any shape that is not null or four finite numbers. */
export function normalizeRect(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input) || input.length !== 4 || !input.every(isNum)) throw new RectInvalid("rect must be null or four finite numbers");
  const [a, b, c, d] = input.map((v) => Math.floor(clamp(v) + 0.5) + 0);
  const x1 = Math.min(a, c) + 0;
  const x2 = Math.max(a, c) + 0;
  const y1 = Math.min(b, d) + 0;
  const y2 = Math.max(b, d) + 0;
  if (x1 === 0 && y1 === 0 && x2 === 100 && y2 === 100) return null;
  if (x1 === x2 && y1 === y2) return null;
  return [x1, y1, x2, y2];
}

/** True when both axes of an (already normalized) rect span at least `min` units. */
export function meetsMinSize(rect, min = MIN_TAG_UNITS) {
  if (!Array.isArray(rect) || rect.length !== 4) return false;
  return rect[2] - rect[0] >= min && rect[3] - rect[1] >= min;
}

/** validateNewRect(rect) -> { ok: true, rect } | { ok: false, code }. Checked in order: shape (RECT_INVALID), NOT_INTEGER, OUT_OF_RANGE, INVERTED, ZERO_AREA, TOO_SMALL. A full frame is ok with rect null. */
export function validateNewRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(isNum)) return { ok: false, code: "RECT_INVALID" };
  if (!rect.every(Number.isInteger)) return { ok: false, code: "NOT_INTEGER" };
  if (rect.some((v) => v < 0 || v > 100)) return { ok: false, code: "OUT_OF_RANGE" };
  const [x1, y1, x2, y2] = rect;
  if (x1 > x2 || y1 > y2) return { ok: false, code: "INVERTED" };
  if (x1 === x2 || y1 === y2) return { ok: false, code: "ZERO_AREA" };
  if (x1 === 0 && y1 === 0 && x2 === 100 && y2 === 100) return { ok: true, rect: null };
  if (!meetsMinSize(rect)) return { ok: false, code: "TOO_SMALL" };
  return { ok: true, rect: rect.map((v) => v + 0) };
}
