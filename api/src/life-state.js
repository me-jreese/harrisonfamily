// Life state, the API side (HFY-TSK-426, HFY-ISS-031; rulings P5-R4 and P5-R5). DISPLAY ONLY: this module reads activity evidence and keeps the admin's
// "confirmed living" marks so a page can choose between "living" and "status unknown" with the shared rule (shared/life-state.mjs). Nothing here writes
// or reads the published `isLiving` flag, a death or a protection, and "status unknown" never loosens one (scripts/ci/test/life-state-pins.test.mjs).
//
// Evidence of activity (P5-R4) for a person whose member account is linked to them. A member's principal IS their Gramps ID (the session sub), so no
// email or account id is ever read or returned. The sources, newest of them wins:
//   contribution  CONTRIB#<principal>/E#<ulid> events (post, comment, tag, edit, photo, accepted proposal), read through GSI1 CONTRIBS over the last
//                 24 months by the ULID time range (the ULID starts with the event time) and then by the event's own `at`.
//   passkey       PASSKEY# items (auth service): `rec.lastUsedAt` (each passkey sign-in) or else `rec.createdAt` (adding a passkey is a signed-in act),
//                 epoch ms, read per member through GSI1 PASSKEYSUB#<sub>. This is the ONLY sign-in time the tables hold: a sign-in through the
//                 identity provider (Google or an emailed code) leaves no time in this repository's tables, so such a sign-in is NOT evidence.
//   confirmed     LIFECONF#<person>/META, an admin's "confirmed living" mark (POST /api/life-state/confirm), dated `at`.
// A date after now is ignored and a date older than the window (24 months) is no evidence: both through shared evidenceActive().
import { evidenceActive, DEFAULTS } from "./shared/life-state.mjs";
import { HttpError, logSafeError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { ulidFloor } from "./onthisday/posts.js";
import { GSI_CONTRIBS } from "./contrib.js";

export const FLAG = "lifeStateV1";
export const CONFIRM_GSI = "LIFECONF";
/** Evidence is cached in the container for this long (the confirmed marks are always read fresh). */
export const EVIDENCE_TTL_MS = 10 * 60_000;
/** Pages of 500 events read for one evidence build; past it the newest events already decided who is active, so the rest is dropped with a warning. */
export const MAX_EVENT_PAGES = 100;
const PAGE = 500;
const DAY_MS = 86_400_000;
const PERSON_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const confirmKeys = (person) => ({ PK: `LIFECONF#${person}`, SK: "META" });
export const lifeAuditId = (person) => `lifestate:${person}`;

const bad = (message) => new HttpError(400, "validation", message);
const forbidden = () => new HttpError(403, "forbidden", "only an admin can do that");
const toIso = (ms) => new Date(ms).toISOString();
const dateOnly = (iso) => iso.slice(0, 10);

/** The oldest instant that can still count: 24 months before `nowMs` less a 2 day margin (the exact edge is decided by evidenceActive on each `at`). */
function readFloor(nowMs) {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - DEFAULTS.evidenceMonths - 1);
  return d.getTime() - 2 * DAY_MS;
}

/** Pure: keep the latest in-window `at` per person from `rows` of `{person, at}` (an ISO string or epoch ms). Future, invalid and out-of-window dates are dropped. */
export function latestInWindow(rows, nowMs) {
  const best = new Map();
  for (const { person, at } of rows) {
    if (typeof person !== "string" || !PERSON_RE.test(person)) continue;
    if (!evidenceActive(at, null, new Date(nowMs))) continue;
    const t = new Date(at).getTime();
    if (!best.has(person) || t > best.get(person)) best.set(person, t);
  }
  return best;
}

/**
 * createLifeState({ ddb, cmds, table, actor, now, uid, accountIds?, personExists?, cache?, log }).
 * `accountIds()` is the member principal set (the gramps_ids behind the sign-in lists): without it the passkey source is skipped.
 * `cache` is the container-wide `{ at, value, loading }` (createHandler owns one); without it the service keeps its own.
 */
export function createLifeState({ ddb, cmds, table, actor, now = () => Date.now(), uid, accountIds, personExists, cache = {}, log = console }) {
  const iso = () => toIso(now());

  async function contributionRows(nowMs) {
    const rows = [];
    let key;
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk AND GSI1SK >= :after",
        ExpressionAttributeValues: { ":pk": GSI_CONTRIBS, ":after": ulidFloor(readFloor(nowMs)) },
        ScanIndexForward: false, Limit: PAGE, ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const it of r.Items ?? []) rows.push({ person: it.actor?.id, at: it.at });
      key = r.LastEvaluatedKey;
      if (!key) return rows;
    }
    log.warn?.("life state: contribution read hit its page bound", { pages: MAX_EVENT_PAGES });
    return rows;
  }

  async function passkeyRows() {
    if (typeof accountIds !== "function") return [];
    let ids;
    try { ids = [...(await accountIds())]; } catch (e) { log.warn?.("life state: member list unavailable, no passkey evidence", logSafeError(e)); return []; }
    const rows = [];
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(ids.slice(i, i + 8).map(async (id) => {
        if (typeof id !== "string" || !PERSON_RE.test(id)) return;
        try {
          const r = await ddb.send(new cmds.QueryCommand({ TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `PASSKEYSUB#${id}` } }));
          for (const it of r.Items ?? []) {
            const at = it.rec?.lastUsedAt ?? it.rec?.createdAt;
            if (Number.isFinite(at)) rows.push({ person: id, at });
          }
        } catch (e) { log.warn?.("life state: a passkey read failed (no evidence from it)", logSafeError(e)); }
      }));
    }
    return rows;
  }

  /** person -> latest activity (ms) in the window, from contributions and passkey sign-ins. Cached; one build at a time per container. */
  async function activity() {
    if (cache.value && now() - cache.at < EVIDENCE_TTL_MS) return cache.value;
    cache.loading ??= (async () => {
      try {
        const nowMs = now();
        const [contrib, passkeys] = await Promise.all([
          contributionRows(nowMs),
          passkeyRows(),
        ]);
        cache.value = latestInWindow([...contrib, ...passkeys], nowMs);
        cache.at = nowMs;
        return cache.value;
      } finally { cache.loading = undefined; }
    })();
    return cache.loading;
  }

  /** person -> the admin's mark (ms), in-window marks only. Always fresh. */
  async function confirmed() {
    const rows = [];
    let key;
    for (let page = 0; page < 20; page += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": CONFIRM_GSI }, ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const it of r.Items ?? []) rows.push({ person: it.person, at: it.at });
      key = r.LastEvaluatedKey;
      if (!key) break;
    }
    return latestInWindow(rows, now());
  }

  const out = (m) => [...m].map(([person, ms]) => ({ person, at: dateOnly(toIso(ms)) })).sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));

  async function readMark(person) {
    return (await ddb.send(new cmds.GetCommand({ TableName: table, Key: confirmKeys(person), ConsistentRead: true }))).Item;
  }

  function parsePerson(v) {
    if (typeof v !== "string" || !PERSON_RE.test(v)) throw bad("person must be a Gramps ID");
    return v;
  }

  async function write(person, put, before, after, op) {
    const at = iso();
    const audit = auditItem({ op, id: lifeAuditId(person), principalId: actor.id, at, before, after }, uid(), table);
    try {
      await transact(ddb, cmds, table, put ? { puts: [{ item: put }, { item: audit }] } : { deletes: [confirmKeys(person)], puts: [{ item: audit }] });
    } catch (e) {
      if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
      throw e;
    }
  }

  return {
    /** GET /api/life-state: { asOf, evidence: [{person, at}], confirmed: [{person, at}] }, in-window entries only (a Gramps ID and a day, never an email or an account id). */
    async get() {
      const nowMs = now();
      const [ev, cf] = await Promise.all([activity(), confirmed()]);
      return { asOf: toIso(nowMs), evidence: out(ev), confirmed: out(cf) };
    },

    /** The raw maps for another module (on this day): { evidence: Map<person, ms>, confirmed: Map<person, ms> }. Throws when the table cannot be read. */
    async snapshot() {
      const [evidence, conf] = await Promise.all([activity(), confirmed()]);
      return { evidence, confirmed: conf };
    },

    /** POST /api/life-state/confirm { person, at? }: admins only. `at` is a past day (YYYY-MM-DD) or UTC timestamp, default now. Renews an existing mark. */
    async confirm(body) {
      if (actor?.admin !== true) throw forbidden();
      const person = parsePerson(body?.person);
      let at = iso();
      if (body?.at !== undefined) {
        const v = body.at;
        if (typeof v !== "string" || !(DATE_RE.test(v) || ISO_RE.test(v)) || Number.isNaN(Date.parse(v))) throw bad("at must be a day (YYYY-MM-DD) or a UTC timestamp");
        const ms = Date.parse(DATE_RE.test(v) ? `${v}T00:00:00.000Z` : v);
        if (toIso(ms).slice(0, 10) !== v.slice(0, 10)) throw bad("at must be a real calendar day"); // 2027-02-30 would roll over to March
        if (ms > now()) throw bad("at cannot be in the future");
        at = toIso(ms);
      }
      if (typeof personExists === "function" && !(await personExists(person))) throw new HttpError(404, "not_found", "no such person");
      const before = await readMark(person);
      const item = { ...confirmKeys(person), GSI1PK: CONFIRM_GSI, GSI1SK: person, entity: "life-confirmed", person, at, by: actor.id, updatedAt: iso() };
      await write(person, item, { confirmedAt: before?.at ?? null }, { confirmedAt: at }, "lifestate.confirm");
      return { person, at: dateOnly(at) };
    },

    /** DELETE /api/life-state/confirm/:person: admins only; idempotent (nothing is written, no audit, when there is no mark). */
    async unconfirm(rawPerson) {
      if (actor?.admin !== true) throw forbidden();
      const person = parsePerson(rawPerson);
      const before = await readMark(person);
      if (!before) return;
      await write(person, null, { confirmedAt: before.at }, { confirmedAt: null }, "lifestate.unconfirm");
    },
  };
}
