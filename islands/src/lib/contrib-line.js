// The feed line "X contributions in the past Y ZZZZ" (HFY-TSK-190, flag contribV1; social.md 7.4, R-25). Shown under the homepage timeline
// heading and the /posts/ h1 as p.hfy-contrib-line. The server picks the window (GET /api/contributions/stats, line: {x,y,unit}|null); the
// client spells it, so the grammar is pinned by a node test (tests/contrib-line.test.mjs) whatever text the server sent.
/** The no-number line shown when the server's `line` is null (no window reaches 3 contributions). */
export const FALLBACK = "add a photo or a story to get things going.";

const UNITS = new Set(["day", "week", "month", "year"]);

/** `x contribution(s) in the past [y ]unit(s)`: singular at x = 1, the number dropped when y = 1 ("the past week"). Null for an unusable line. */
export function lineCopy(line) {
  if (!line || typeof line !== "object") return null;
  const { x, y, unit } = line;
  if (!Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 1 || !UNITS.has(unit)) return null;
  const span = y === 1 ? unit : `${y} ${unit}s`;
  return `${x} contribution${x === 1 ? "" : "s"} in the past ${span}`;
}

/** What to draw for a /contributions/stats body: the line, the fallback for a null line, or null (draw nothing) for anything else. */
export function lineFor(body) {
  if (!body || typeof body !== "object") return null;
  if (body.line === null) return FALLBACK;
  return lineCopy(body.line);
}
