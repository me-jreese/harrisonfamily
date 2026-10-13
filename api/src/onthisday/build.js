// On this day, the pure index builder (HFY-PLN-002 surfaces section 4.3, R-14, R-19). No I/O, no clock, no randomness:
// the same source and options always give the same index. The caller (the lazy-rebuild route, a later task) supplies the
// source rows and stores the result. Birth month and day are dropped here by assertion, even if the input carries them.

export const SCHEMA = "hfy.onthisday.v1";

/** Gramps EventType codes this module understands (surfaces section 4.3). Anything else, DIVORCE (7) included, is never indexed. */
export const TYPE = Object.freeze({ MARRIAGE: 1, BIRTH: 12, DEATH: 13, BURIAL: 19, DEGREE: 25, EDUCATION: 26, GRADUATION: 31, RESIDENCE: 42 });

const KIND = new Map([
  [TYPE.MARRIAGE, "marriage"], [TYPE.BIRTH, "birth"], [TYPE.DEATH, "death"], [TYPE.BURIAL, "burial"],
  [TYPE.DEGREE, "degree"], [TYPE.EDUCATION, "education"], [TYPE.GRADUATION, "graduation"], [TYPE.RESIDENCE, "residence"],
]);
const CELEBRATE = new Set(["marriage", "graduation", "degree", "education"]);
// Only exact (modifier NONE 0, or FROM 7) dates at quality 0 count; about, before, after, range and estimated are skipped.
const USABLE_MODIFIER = new Set([0, 7]);
const MARRIAGE_ROLES = ["bride", "groom", "family"];
const LIFE_STATES = new Set(["living", "deceased", "unknown"]);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const pad = (n) => String(n).padStart(2, "0");
const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [...v]);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A usable date as `{ year, month?, day? }`, or null when the date is missing, imprecise or invalid. */
function usableDate(date) {
  if (!date || typeof date !== "object") return null;
  if (!USABLE_MODIFIER.has(date.modifier ?? 0) || (date.quality ?? 0) !== 0) return null;
  if (!isInt(date.year, 1, 9999)) return null;
  const out = { year: date.year };
  if (isInt(date.month, 1, 12)) {
    out.month = date.month;
    if (isInt(date.day, 1, 31)) out.day = date.day;
  }
  return out;
}

const personRef = (p) => ({ grampsId: p.grampsId, name: p.displayName, lifeState: LIFE_STATES.has(p.lifeState) ? p.lifeState : "unknown" });

/**
 * buildIndex(source, { policyVersion, generatedAt }) -> index.
 * `source` is `{ events, persons, version? }` where events and persons are arrays (or any iterable) of the record store's
 * projection: events `{ handle, typeCode, date: { year, month?, day?, modifier, quality }, participants: [{ grampsId, role }],
 * place, description, private }` and persons `{ grampsId, displayName, lifeState, private }`.
 * The index follows `hfy.onthisday.v1`, plus `report` counters (never served to the island).
 */
export function buildIndex(source, { policyVersion = null, generatedAt = null } = {}) {
  const report = { droppedBirthPrecision: 0, eventsSeen: 0, itemsBuilt: 0, skipped: { type: 0, private: 0, date: 0, people: 0, duplicate: 0 } };
  const persons = new Map();
  for (const p of list(source?.persons)) if (p && text(p.grampsId) && text(p.displayName)) persons.set(p.grampsId, p);
  const events = list(source?.events).filter((e) => e && typeof e === "object");

  // Burial stands in only for a person with no death event at all (dated or not, public or not).
  const hasDeath = new Set();
  for (const e of events) if (e.typeCode === TYPE.DEATH) for (const x of list(e.participants)) hasDeath.add(x?.grampsId);

  const items = [];
  const birthSeen = new Set();
  for (const e of [...events].sort((a, b) => String(a.handle).localeCompare(String(b.handle)))) {
    report.eventsSeen += 1;
    const kind = KIND.get(e.typeCode);
    if (!kind) { report.skipped.type += 1; continue; }
    const date = usableDate(e.date);
    // The assertion: a birth keeps its year only, and the drop is counted (even when the event is later skipped).
    const birthPrecisionPresent = kind === "birth" && e.date && typeof e.date === "object" && (e.date.month != null || e.date.day != null);
    if (birthPrecisionPresent) report.droppedBirthPrecision += 1;
    if (e.private === true) { report.skipped.private += 1; continue; }
    if (!date) { report.skipped.date += 1; continue; }

    const parts = list(e.participants).filter((x) => x && persons.has(x.grampsId));
    const roleOf = (x) => text(x.role).toLowerCase();
    let chosen;
    if (kind === "marriage") {
      // Marriage people are joined from the Bride, Groom and Family roles.
      const ranked = parts.filter((x) => MARRIAGE_ROLES.includes(roleOf(x))).sort((a, b) => MARRIAGE_ROLES.indexOf(roleOf(a)) - MARRIAGE_ROLES.indexOf(roleOf(b)));
      chosen = [...new Map(ranked.map((x) => [x.grampsId, x])).values()];
      // A participant who is private or unknown to the person list means the pair is not whole: nothing is shown.
      const declared = list(e.participants).filter((x) => x && MARRIAGE_ROLES.includes(roleOf(x)));
      if (declared.some((x) => !persons.has(x.grampsId) || persons.get(x.grampsId).private === true)) { report.skipped.private += 1; continue; }
      if (chosen.length < 2) { report.skipped.people += 1; continue; }
      chosen = chosen.slice(0, 2);
    } else {
      const primary = parts.filter((x) => ["primary", ""].includes(roleOf(x)));
      chosen = primary.slice(0, 1);
      if (!chosen.length) { report.skipped.people += 1; continue; }
    }
    if (chosen.some((x) => persons.get(x.grampsId).private === true)) { report.skipped.private += 1; continue; }
    if (kind === "burial" && chosen.some((x) => hasDeath.has(x.grampsId))) { report.skipped.type += 1; continue; }

    const people = chosen.map((x) => personRef(persons.get(x.grampsId)));
    let id = `evt:${e.handle}`;
    const item = { id, kind, tone: "neutral", year: date.year };
    if (kind === "birth") {
      id = `birth:${chosen[0].grampsId}`;
      if (birthSeen.has(id)) { report.skipped.duplicate += 1; continue; }
      birthSeen.add(id);
      item.id = id;
      item.tone = people[0].lifeState === "living" ? "celebrate" : "neutral";
    } else {
      if (date.month) item.month = date.month;
      if (date.day) item.day = date.day;
      item.tone = kind === "death" || kind === "burial" ? "remember" : CELEBRATE.has(kind) ? "celebrate" : "neutral";
    }
    item.people = people;
    const place = text(e.place);
    if (place) item.place = place;
    const detail = text(e.description);
    if (detail) item.detail = detail;
    items.push(item);
  }
  items.sort(byId);
  report.itemsBuilt = items.length;

  const day = {};
  const month = {};
  for (const it of items) {
    if (it.kind === "birth" || !it.month || !it.day) continue;
    (day[`${pad(it.month)}-${pad(it.day)}`] ||= []).push(it);
    (month[pad(it.month)] ||= []).push(it);
  }
  return {
    schema: SCHEMA, generatedAt, sourceVersion: source?.version ?? null, policyVersion,
    day, month, year: items, report,
  };
}
