// The pure side of CappedSection (HFY-TSK-188, social.md section 8): the cap sizes, the cap expression and the anchor hash. No React and
// no DOM, so node:test reaches it; lib/capped.jsx draws with it.

// BRD2 section 8 (HFY-R72): the cap is a multiple of --io-space-9 (64 px): 448 px (7) below bp.medium (43rem), 576 px (9) from there up.
export const CAP_SMALL = 7;
export const CAP_WIDE = 9;
// The widest "show older" ever raises a cap: a stop for a runaway loop, not a limit a family will meet (40 steps is 40 pages of clipping).
export const MAX_STEPS = 40;
// The viewport query for the wide cap (bp.medium; media queries cannot read tokens).
export const WIDE_QUERY = "(min-width: 43rem)";

/** The CSS length of a cap raised `steps` times: one step is one more cap. Token arithmetic only, as theme-lint requires of CSS. */
export function capExpression(wide, steps = 0) {
  const base = wide ? CAP_WIDE : CAP_SMALL;
  return `calc(var(--io-space-9) * ${base * (1 + Math.max(0, Math.floor(steps)))})`;
}

/** The items (their tops, relative to the clipped list's top) that start at or below the cap: those are clipped away. */
export function hiddenIndexes(tops, cap) {
  const out = [];
  tops.forEach((t, i) => { if (Number.isFinite(cap) && t >= cap - 0.5) out.push(i); });
  return out;
}

const COMMENT_HASH = /^#comment-([0-9A-Za-z]{8,40})$/;
/** The comment id an `#comment-<ulid>` hash points at, or null. Only an id-shaped token passes, so the value is safe in a selector. */
export function commentFromHash(hash) {
  const m = COMMENT_HASH.exec(String(hash || ""));
  return m ? m[1] : null;
}
