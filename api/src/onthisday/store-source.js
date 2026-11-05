// On this day, the record-store source (HFY-TSK-139, surf-onthisday-store-source; surfaces.md section 4.3, BRD2 D2-21 and Q2-04).
//
// StoreOnThisDaySource implements the OnThisDaySource interface of source.js over the cloud record store: the store view (every REC# head, brought up to
// SYNC#HEAD.seq by records/index.js storeView) is turned into builder rows. `version()` is `store:<SYNC#HEAD.seq>`, so the OTD#INDEX rebuilds after each
// committed batch, and the index records the seq the rows were read at.
//
// What it gives over the interim adapter: the day and month of NON-BIRTH events (Q2-04), so the day and week tiers can be served.
// What it never gives (Q2-18, HFY-R76): a birth event's day or month. The source drops them here, the builder drops them again by assertion, and
// the day and month reach members only through the session-checked GET /api/onthisday; person JSON stays year-only.
//
// Selection (createSelectingSource): the store serves only while RENDER_MODE=live, SYNC#HEAD.seq > 0 and Q2-04 allows it; otherwise the interim adapter
// serves, so an early flip never ships empty day or week tiers. With Q2-04 declined the interim adapter always serves (the year tier only).
import { storeView } from "../records/index.js";
import { getSyncHead } from "../sync/store.js";
import { scanText } from "../shared/privacy-guard.mjs";
import { TYPE } from "./build.js";

const ROLE_PRIMARY = 1;
const LIVING_YEARS = 110;
const GREGORIAN = 0;
const MODIFIER_ABOUT = 3;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Fail closed: only an explicit `false` marks a stored object public.
const isPrivate = (obj) => obj?.private !== false;

/** Free text (a place name or an event description) with a contact pattern, an address or a date-of-birth shape in it is dropped whole (R-18). */
const cleanText = (v) => {
  const t = str(v).trim();
  return t && scanText(t).length === 0 ? t : "";
};

const nameOf = (obj) => {
  const n = isObj(obj?.primary_name) ? obj.primary_name : {};
  const surname = arr(n.surname_list).map((s) => (isObj(s) ? str(s.surname).trim() : "")).filter(Boolean).join(" ");
  return [str(n.first_name).trim(), surname].filter(Boolean).join(" ");
};

const yearOfDate = (d) => {
  const y = isObj(d) && Array.isArray(d.dateval) ? d.dateval[2] : 0;
  return Number.isInteger(y) && y > 0 ? y : 0;
};

/**
 * A stored Gramps Date as the builder's `{ year, month?, day?, modifier, quality }`, or null. A birth keeps its year only (Q2-18). A date in another calendar, a dual
 * date or a text-only date cannot be read as a Gregorian day, so it takes modifier ABOUT and the builder skips it.
 */
export function dateRow(d, { birth = false } = {}) {
  if (!isObj(d) || !Array.isArray(d.dateval)) return null;
  const [day, month, year, dual] = d.dateval;
  if (!Number.isInteger(year) || year < 1) return null;
  const quality = Number.isInteger(d.quality) ? d.quality : 0;
  const exact = (d.calendar ?? GREGORIAN) === GREGORIAN && !dual;
  const modifier = exact && Number.isInteger(d.modifier) ? d.modifier : MODIFIER_ABOUT;
  const out = { year, modifier, quality };
  if (birth) return out;
  if (Number.isInteger(month) && month >= 1 && month <= 12) {
    out.month = month;
    if (Number.isInteger(day) && day >= 1 && day <= 31) out.day = day;
  }
  return out;
}

/** living, deceased or unknown, from the stored events (the edit bundle's display hint, made strict: no birth year means unknown). */
function lifeState(person, eventOf, nowYear) {
  let birth = 0;
  let hasDeath = false;
  for (const ref of arr(person.event_ref_list)) {
    const ev = eventOf(ref?.ref);
    if (!ev || ref?.role?.value !== ROLE_PRIMARY) continue;
    const type = ev.type?.value;
    if (type === TYPE.DEATH) hasDeath = true;
    else if (type === TYPE.BIRTH && !birth) birth = yearOfDate(ev.date);
  }
  if (hasDeath) return "deceased";
  if (!birth) return "unknown";
  return nowYear - birth > LIVING_YEARS ? "deceased" : "living";
}

/**
 * The builder snapshot `{ events, persons, counts }` of a store view. Pure: `view` is a StoreView, `nowYear` the current year.
 * Events: a person's own events (primary role, one row per event, participants sorted by id) and marriages from the Family heads (father as groom, mother as bride;
 * a spouse who is missing or private stays in the participants as an unknown id, so the builder skips the pair). Anything private is marked private.
 */
export function rowsFromView(view, { nowYear }) {
  const heads = view.live();
  const obj = (cls) => heads.filter((h) => h.class === cls && isObj(h.obj));
  const events = new Map(obj("Event").map((h) => [h.handle, h.obj]));
  const places = new Map(obj("Place").map((h) => [h.handle, h.obj]));
  const eventOf = (handle) => events.get(handle);
  const placeName = (ev) => {
    const p = places.get(str(ev.place));
    return p && !isPrivate(p) ? cleanText(p.name?.value) : "";
  };

  const personById = new Map();
  const personByHandle = new Map();
  const persons = [];
  for (const h of obj("Person")) {
    const grampsId = str(h.obj.gramps_id || h.gramps_id);
    const displayName = nameOf(h.obj);
    if (!grampsId || !displayName) continue;
    const row = { grampsId, displayName, lifeState: lifeState(h.obj, eventOf, nowYear), private: isPrivate(h.obj) };
    persons.push(row);
    personById.set(h.handle, h.obj);
    personByHandle.set(h.handle, row);
  }
  persons.sort((a, b) => byText(a.grampsId, b.grampsId));

  const owners = new Map(); // event handle -> [gramps id]
  for (const [handle, p] of personById) {
    const row = personByHandle.get(handle);
    for (const ref of arr(p.event_ref_list)) {
      if (!isObj(ref) || typeof ref.ref !== "string" || ref.role?.value !== ROLE_PRIMARY || ref.private === true) continue;
      const ev = events.get(ref.ref);
      if (!ev || ev.type?.value === TYPE.MARRIAGE) continue;
      (owners.get(ref.ref) ?? owners.set(ref.ref, []).get(ref.ref)).push(row.grampsId);
    }
  }

  const counts = { birthPrecisionDropped: 0 };
  const rows = new Map();
  const base = (handle, ev) => {
    const typeCode = ev.type?.value;
    const birth = typeCode === TYPE.BIRTH;
    if (birth && isObj(ev.date) && Array.isArray(ev.date.dateval) && (ev.date.dateval[0] || ev.date.dateval[1])) counts.birthPrecisionDropped += 1;
    return { handle, typeCode, date: dateRow(ev.date, { birth }), participants: [], place: placeName(ev), description: cleanText(ev.description), private: isPrivate(ev) };
  };
  for (const [handle, ids] of owners) {
    const row = base(handle, events.get(handle));
    row.participants = [...new Set(ids)].sort(byText).map((grampsId) => ({ grampsId, role: "primary" }));
    rows.set(handle, row);
  }
  for (const h of obj("Family")) {
    const fam = h.obj;
    const spouse = (handle, role) => {
      if (typeof handle !== "string" || !handle) return null;
      const known = personByHandle.get(handle);
      return { grampsId: known ? known.grampsId : `h:${handle}`, role };
    };
    const participants = [spouse(fam.father_handle, "groom"), spouse(fam.mother_handle, "bride")].filter(Boolean);
    const familyPrivate = isPrivate(fam);
    for (const ref of arr(fam.event_ref_list)) {
      const ev = isObj(ref) ? events.get(ref.ref) : undefined;
      if (!ev || ev.type?.value !== TYPE.MARRIAGE || ref.private === true) continue;
      const row = rows.get(ref.ref) ?? base(ref.ref, ev);
      if (familyPrivate) row.private = true;
      for (const x of participants) if (!row.participants.some((y) => y.grampsId === x.grampsId && y.role === x.role)) row.participants.push({ ...x });
      rows.set(ref.ref, row);
    }
  }
  return { events: [...rows.values()].sort((a, b) => byText(a.handle, b.handle)), persons, counts };
}

/**
 * The record-store OnThisDaySource. `ctx` is the store context `{ ddb, cmds, table, now? }` (records/index.js); `log` receives counts only, never a value.
 * `snapshot()` reads one store view and returns its own seq as the version, so `version` and the rows always agree.
 */
export function createStoreSource({ ctx, log = console }) {
  const nowYear = () => new Date(typeof ctx.now === "function" ? ctx.now() : Date.now()).getUTCFullYear();
  async function snapshot() {
    const view = await storeView(ctx);
    const { events, persons, counts } = rowsFromView(view, { nowYear: nowYear() });
    if (counts.birthPrecisionDropped > 0) log.warn?.("onthisday store source dropped birth precision", { count: counts.birthPrecisionDropped });
    return { version: `store:${view.seq}`, events, persons };
  }
  let running;
  const shared = () => (running ??= snapshot().finally(() => { running = undefined; }));
  return {
    kind: "store",
    snapshot,
    async version() {
      return `store:${(await getSyncHead(ctx))?.seq ?? 0}`;
    },
    async *events() { yield* (await shared()).events; },
    async *persons() { yield* (await shared()).persons; },
  };
}

/**
 * Chooses between the interim adapter and the store source on every call.
 *   renderMode()  -> "off" | "shadow" | "live"   the stack's RENDER_MODE
 *   headSeq()     -> Promise<number>             SYNC#HEAD.seq (0 when there is no head)
 *   daysApproved  -> boolean                      io's Q2-04 answer; false (declined) means the year tier only, so the store is never selected
 * The store serves only while RENDER_MODE=live and seq > 0; every other state serves the interim adapter. A failed seq read serves the interim adapter too.
 */
export function createSelectingSource({ interim, store, renderMode, headSeq, daysApproved = true, log = console }) {
  async function pick() {
    if (!daysApproved || renderMode() !== "live") return interim;
    try {
      return (await headSeq()) > 0 ? store : interim;
    } catch (e) {
      log.warn?.("onthisday source selection fell back to the interim adapter", { name: e?.name ?? "Error" });
      return interim;
    }
  }
  return {
    kind: "selecting",
    pick,
    async version() { return (await pick()).version(); },
    async snapshot() { return (await pick()).snapshot(); },
    async *events() { yield* (await pick()).events(); },
    async *persons() { yield* (await pick()).persons(); },
  };
}

/** The Q2-04 switch: `OTD_DAY_TIERS=off` records a decline (year tier only); anything else keeps the recommended default (yes, non-birth dates). */
export const daysApprovedFromEnv = (env) => String(env?.OTD_DAY_TIERS ?? "").trim().toLowerCase() !== "off";
