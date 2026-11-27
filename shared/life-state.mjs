// Life state (DISPLAY ONLY), HFY-ISS-031, rulings P5-R3 to P5-R5. Pure, no imports, so the islands, the API and tests share one rule.
//
// The published `isLiving` flag means only "no death recorded" and stays exactly as it is: every protection that reads it (the graph
// projection, the renderer, the search index, the edit-bundle hint, access requests, on this day) is pinned by
// scripts/ci/test/life-state-pins.test.mjs and none of them may import this module. This rule only decides which of three words a
// page may use. "unknown" never writes a death and never loosens a protection.
//
// Rule (P5-R3, P5-R4):
//   deceased  a death is recorded (hasDeath true, or a deathYear present).
//   living    no death, and either activity evidence inside the window (evidenceAt or confirmedLivingAt within evidenceMonths of
//             now) or a known birth year with now.year - birthYear <= thresholdYears.
//   unknown   no death, no evidence in the window, and either no birth year or a birth year older than the threshold.
//
// Date handling: evidence dates are Date, epoch-ms number or ISO string; an invalid date is no evidence. A date in the FUTURE (after
// now) is ignored and counts as no evidence, because a clock-skewed or mistyped date must not keep someone "living" indefinitely.
// birthYear and deathYear are integers or numeric strings; anything else (0, negative, NaN, a non-numeric string) counts as absent.

export const LIFE_STATE = Object.freeze({ deceased: "deceased", living: "living", unknown: "unknown" });
export const DEFAULTS = Object.freeze({ thresholdYears: 85, evidenceMonths: 24 });

function toDate(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A positive integer year from an int or a string of digits, else null. */
function toYear(v) {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\s*\d{1,4}\s*$/.test(v)) { const n = Number(v); return n > 0 ? n : null; }
  return null;
}

function posNumber(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** True when one date is inside the window: not in the future, and no more than `months` calendar months before `now`. */
function withinWindow(value, now, months) {
  const d = toDate(value);
  if (!d || d.getTime() > now.getTime()) return false;
  const cutoff = new Date(now.getTime());
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1); // clamp the day so 31 March minus one month is 28 February, not 3 March
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  cutoff.setUTCDate(Math.min(day, new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime() >= cutoff.getTime();
}

/** Activity evidence (P5-R4): a member signed in or contributed (evidenceAt), or an admin marked "confirmed living" (confirmedLivingAt), within `months` of `now`. Future and invalid dates are ignored. */
export function evidenceActive(evidenceAt, confirmedLivingAt, now = new Date(), months = DEFAULTS.evidenceMonths) {
  const n = toDate(now) || new Date();
  const m = posNumber(months, DEFAULTS.evidenceMonths);
  return withinWindow(evidenceAt, n, m) || withinWindow(confirmedLivingAt, n, m);
}

/** The display state of one person: "deceased", "living" or "unknown". Never throws on odd input. */
export function lifeState({ hasDeath, deathYear, birthYear, evidenceAt, confirmedLivingAt, now, thresholdYears, evidenceMonths } = {}) {
  if (hasDeath === true || toYear(deathYear) !== null) return LIFE_STATE.deceased;
  const n = toDate(now) || new Date();
  if (evidenceActive(evidenceAt, confirmedLivingAt, n, posNumber(evidenceMonths, DEFAULTS.evidenceMonths))) return LIFE_STATE.living;
  const born = toYear(birthYear);
  if (born !== null && n.getUTCFullYear() - born <= posNumber(thresholdYears, DEFAULTS.thresholdYears)) return LIFE_STATE.living;
  return LIFE_STATE.unknown;
}
