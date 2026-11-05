// On this day, the API service behind GET /api/onthisday and POST and DELETE /api/onthisday/hide (HFY-TSK-194; surfaces.md section 4.4).
//
// The index is one DynamoDB item (store.js) rebuilt lazily, with no scheduler:
//   1. a parsed copy is kept in Lambda memory for 5 minutes (`cache`, shared by every request of the container), and concurrent requests of a container share one load;
//   2. on a miss the item and the source's version() are read together; the same version serves;
//   3. a missing item or a changed version takes the lease (store.js); the winner builds, stores and serves, a loser serves the stale body (`stale: true`) or,
//      with no body at all, waits 1 s and reads again (error catalog E6);
//   4. a build that fails serves the stale body with `stale: true` (E5), and with none the answer is 503 `unavailable` (E4).
// A stored index built under another policy version is never served, stale or not (store.js POLICY_VERSION).
import { HttpError, logSafeError } from "../http.js";
import { TxnCancelled, auditItem, transact } from "../txn.js";
import { buildIndex } from "./build.js";
import { selectOnThisDay } from "./select.js";
import { collectSource } from "./source.js";
import { POLICY_VERSION, createIndexStore, indexOf } from "./store.js";
import { pastYearPosts } from "./posts.js";

export const CACHE_MS = 5 * 60_000;
export const TZ_LIMIT = 840;
export const LEASE_WAIT_MS = 1000;
export const LEASE_WAITS = 8;
export const MAX_HIDDEN = 1000;
export const hiddenKeys = Object.freeze({ PK: "OTD#HIDDEN", SK: "META" });
/** An item id as build.js mints it: evt:<event handle> or birth:<gramps id>. */
export const ITEM_ID_RE = /^(?:evt|birth):[A-Za-z0-9_-]{1,64}$/;
/**
 * The index as the year tier only: no day or week lists, and no month or day on any year item. Served while featureOn('onThisDayDays') is off (review DL-17),
 * so a cutover alone never opens the day and week tiers. Memoised per parsed index.
 */
const yearOnlyViews = new WeakMap();
export function yearOnly(index) {
  let v = yearOnlyViews.get(index);
  if (!v) {
    v = { ...index, day: {}, month: {}, year: (index.year ?? []).map(({ month, day, ...rest }) => rest) }; // eslint-disable-line no-unused-vars
    yearOnlyViews.set(index, v);
  }
  return v;
}
export const otdAuditId = (itemId) => `otd:${itemId}`;

const unavailable = () => new HttpError(503, "unavailable", "on this day is unavailable, try again later");
const pad = (n) => String(n).padStart(2, "0");

/** `date=YYYY-MM-DD` (a real calendar day) and `tzOffset` (whole minutes within +-840; default 0) from a query string. 400 `validation` otherwise. */
export function parseQuery(query) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof query?.date === "string" ? query.date : "");
  const bad = (message) => new HttpError(400, "validation", message);
  if (!m) throw bad("date must be YYYY-MM-DD");
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw bad("date must be a real calendar day");
  let tzOffset = 0;
  if (query.tzOffset !== undefined && query.tzOffset !== "") {
    if (typeof query.tzOffset !== "string" || !/^-?\d{1,4}$/.test(query.tzOffset)) throw bad("tzOffset must be whole minutes");
    tzOffset = Number(query.tzOffset);
    if (!Number.isInteger(tzOffset) || Math.abs(tzOffset) > TZ_LIMIT) throw bad(`tzOffset must be within +-${TZ_LIMIT} minutes`);
  }
  return { date: `${m[1]}-${pad(mo)}-${pad(d)}`, today: { y, mo, d }, tzOffset: tzOffset === 0 ? 0 : tzOffset };
}

/**
 * `cache` is the container-wide state `{ loading, index }` (createHandler owns one, so it outlives a request); without it the service keeps its own.
 * `source` is an OnThisDaySource (source.js); without one the index cannot be built and an empty store answers 503.
 * `daysOn()` says whether the day and week tiers may be served for this request (featureOn('onThisDayDays')); without it they are not.
 * `sleep(ms)` and `leaseWaits` are test seams.
 */
export function createOnThisDay({ ddb, cmds, table, actor, now = () => Date.now(), uid, source, daysOn = async () => false, cache = {}, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), leaseWaits = LEASE_WAITS }) {
  const store = createIndexStore({ ddb, cmds, table, now });
  const isoNow = () => new Date(now()).toISOString();

  async function build(mine) {
    const snap = await collectSource(source);
    const { report, ...index } = buildIndex(snap, { policyVersion: POLICY_VERSION, generatedAt: isoNow() });
    // E7: counts only, never a value. `report` is not part of the schema and is not stored or served.
    if (report.droppedBirthPrecision > 0) log.warn?.("onthisday builder dropped birth precision", { count: report.droppedBirthPrecision });
    await store.put(index, mine); // a lost lease means a newer holder will store its own; this result is still the freshest we have
    return { index, stale: false };
  }

  async function load() {
    const [item, ver] = await Promise.all([
      store.read(),
      source ? Promise.resolve().then(() => source.version()).then((v) => ({ ok: true, v: String(v) }), (e) => ({ ok: false, e })) : { ok: false, e: new Error("no on-this-day source") },
    ]);
    const have = indexOf(item);
    if (have && ver.ok && ver.v === item.sourceVersion) return { index: have, fresh: true, version: ver.v };
    if (!ver.ok) {
      log.warn?.("onthisday source version unavailable", logSafeError(ver.e));
      if (have) return { index: have, fresh: false };
      throw unavailable();
    }
    const mine = await store.lease();
    if (mine !== null) {
      try {
        const built = await build(mine);
        return { ...built, fresh: true, version: built.index.sourceVersion };
      } catch (e) {
        log.error?.(have ? "onthisday build failed, serving the stale index" : "onthisday build failed", logSafeError(e));
        if (have) return { index: have, fresh: false };
        throw unavailable();
      }
    }
    // Another caller holds the lease (E6).
    log.info?.("onthisday rebuild in progress elsewhere");
    if (have) return { index: have, fresh: false };
    for (let i = 0; i < leaseWaits; i += 1) {
      await sleep(LEASE_WAIT_MS);
      const again = await store.read();
      const index = indexOf(again);
      if (index) return { index, fresh: again.sourceVersion === ver.v, version: again.sourceVersion };
    }
    throw unavailable();
  }

  /** `{ index, stale }` for this request. */
  async function currentIndex() {
    const hit = cache.index;
    if (hit && now() - hit.at < CACHE_MS) return { index: hit.index, stale: false };
    cache.loading ??= (async () => {
      try {
        const r = await load();
        // A parsed copy lives 5 minutes, keyed by the sourceVersion it was built from; the same version after the 5 minutes is not parsed again.
        if (r.fresh) cache.index = { index: r.index, version: r.index.sourceVersion, at: now() };
        return { index: r.index, stale: !r.fresh };
      } catch (e) {
        // The store itself failed (not the build): the parsed copy we hold is the stale answer.
        if (e instanceof HttpError) throw e;
        log.error?.("onthisday index read failed", logSafeError(e));
        if (cache.index) return { index: cache.index.index, stale: true };
        throw unavailable();
      } finally {
        cache.loading = undefined;
      }
    })();
    return cache.loading;
  }

  async function readHidden() {
    return (await ddb.send(new cmds.GetCommand({ TableName: table, Key: hiddenKeys, ConsistentRead: true }))).Item;
  }

  return {
    /** GET /api/onthisday: the section 4.4 body plus `stale`. */
    async get(query) {
      const q = parseQuery(query);
      const { index, stale } = await currentIndex();
      const hidden = new Set((await readHidden())?.ids ?? []);
      let posts = [];
      try {
        posts = await pastYearPosts({ ddb, cmds, table, viewer: actor, today: q.today, tzOffset: q.tzOffset, hidden });
      } catch (e) {
        // The archive is one tier of several: without it the module still answers from the index.
        log.warn?.("onthisday archive tier unavailable", logSafeError(e));
      }
      const days = await Promise.resolve().then(() => daysOn()).then(Boolean, () => false);
      return { ...selectOnThisDay(days ? index : yearOnly(index), { date: q.date, posts, hidden }), stale };
    },

    /** The hide and unhide rule: an admin, or a member whose own gramps id is among the item's people. 403 `forbidden` otherwise (also for an id the index does not hold). */
    async hide(rawId) {
      return setHidden(rawId, true);
    },
    async unhide(rawId) {
      return setHidden(rawId, false);
    },
  };

  async function setHidden(rawId, hide) {
    if (typeof rawId !== "string" || !ITEM_ID_RE.test(rawId)) throw new HttpError(400, "validation", "itemId must be an on-this-day item id");
    const admin = actor?.admin === true;
    const { index } = await currentIndex();
    const item = (index.year ?? []).find((it) => it.id === rawId);
    const owner = Boolean(item) && Array.isArray(item.people) && item.people.some((p) => p?.grampsId === actor?.id);
    if (!admin && !owner) throw new HttpError(403, "forbidden", "only family on that line can hide it");
    if (hide && !item) throw new HttpError(404, "not_found", "no such item");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await readHidden();
      const ids = Array.isArray(before?.ids) ? before.ids : [];
      if (ids.includes(rawId) === hide) return; // already so: no write, no audit
      if (hide && ids.length >= MAX_HIDDEN) throw new HttpError(409, "conflict", "too many hidden items");
      const at = isoNow();
      const next = {
        ...hiddenKeys, entity: "otd-hidden", ids: (hide ? [...ids, rawId] : ids.filter((x) => x !== rawId)).sort(), version: (before?.version ?? 0) + 1, updatedAt: at, updatedBy: actor.id,
      };
      const audit = auditItem(
        { op: hide ? "onthisday.hide" : "onthisday.unhide", id: otdAuditId(rawId), principalId: actor.id, at, before: { hidden: !hide }, after: { hidden: hide } },
        uid(), table,
      );
      const guard = before
        ? { condition: "#v = :v", names: { "#v": "version" }, values: { ":v": before.version ?? 0 } }
        : { condition: "attribute_not_exists(PK)" };
      try {
        await transact(ddb, cmds, table, { puts: [{ item: next, ...guard }, { item: audit }] });
        return;
      } catch (e) {
        if (e instanceof TxnCancelled && e.conditionFailed) continue; // somebody else changed the list: read it again
        if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
        if (e instanceof TxnCancelled) throw unavailable();
        throw e;
      }
    }
    throw new HttpError(503, "busy", "busy, try again");
  }
}
