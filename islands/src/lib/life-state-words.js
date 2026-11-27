// The words of the life-state display (HFY-TSK-427, HFY-ISS-031; rulings P5-R2, P5-R3). Pure and import-free, so the <family-navigator> bundle (which
// reaches yearsLabel in tree-data.js) takes no module from outside src/lib. The rule and the question the pages ask are in life-state-copy.js.
// 11ty/js/person-page.js carries the same strings; tests/client/person-page-life-state.test.mjs pins them equal.

export const FLAG = "lifeStateV1";
export const STATUS_UNKNOWN_COPY = "status unknown";
/** What a person with no birth year and no activity reads. io can switch it to "status unknown" here (and in person-page.js, pinned). */
export const NO_BIRTH_YEAR_COPY = "birth year unknown";
export const HELP_FILL_IN_COPY = "help fill in";
/** The life dates queue page; the link shows only with lifeDatesV1 on. */
export const HELP_FILL_IN_HREF = "/me/dates/";

const yearOf = (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v) : null);

/**
 * The line for a person whose state is unknown: "born 1920 · status unknown" with a birth year (`about` adds "about "), else the
 * NO_BIRTH_YEAR_COPY. `extra` (a place) goes between when given.
 */
export function unknownLine(birthYear, { about = false, extra = [] } = {}) {
  const y = yearOf(birthYear);
  if (y === null) return [NO_BIRTH_YEAR_COPY, ...extra].join(" · ");
  return [`born ${about ? "about " : ""}${y}`, ...extra, STATUS_UNKNOWN_COPY].join(" · ");
}
