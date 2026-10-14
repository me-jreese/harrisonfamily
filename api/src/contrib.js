// The contributions ledger (BRD2 4.2 and D2-17; social.md 7.2). Pure builders: each returns a `{ puts, deletes, updates, checks }`
// fragment that the caller merges into its own transact() call, so an event and its counters commit in the same transaction as the
// write that earned them. Nothing here touches the network except selfEditCapped(), which reads one marker.
//
//   Event   PK CONTRIB#<principal>       SK E#<ulid>   GSI1 CONTRIBS / <ulid>
//   Cap     PK CONTRIB#<principal>       SK CAP#self_edit#<subject>#<YYYY-MM-DD>            ttl +2 d
//   Site    PK CSTAT#site                SK TOTAL | D#<YYYY-MM-DD> (ttl day + 800 d) | M#<YYYY-MM> | LINE (written by the read API)
//   Person  PK CSTAT#person:<principal>  SK TOTAL | M#<YYYY-MM>
//
// An event copies no body text (privacy by construction): only ids, the kind, the credited actor's label and counts.
import { assertTxnSize, counterUpdate, mergeUpdates } from "./txn.js";

export const GSI_CONTRIBS = "CONTRIBS";
/** What counts (D2-17). `weight` is the credit the event adds to `n`: 1 for the kind plus 1 per attached image. */
export const CONTRIB_KINDS = ["post", "comment", "proposal_accepted", "self_edit", "tag", "photo_to_record"];
/** The `ref.type` each kind carries. */
export const REF_TYPES = { post: "post", comment: "comment", proposal_accepted: "proposal", self_edit: "record", tag: "tag", photo_to_record: "media" };
/** `via:"sync"` (a desktop push) is maintenance and is never credited, so it is not a valid origin here. */
export const CONTRIB_VIA = ["ui", "mcp"];
export const MAX_PHOTOS = 10;
/** The `D#` day rows expire 800 days after their day (the feed line never looks further back). */
export const DAY_ROW_TTL_DAYS = 800;
export const CAP_TTL_DAYS = 2;

const DAY_MS = 86_400_000;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const eventKeys = (principal, id) => ({ PK: `CONTRIB#${principal}`, SK: `E#${id}` });
export const capKeys = (principal, subject, at) => ({ PK: `CONTRIB#${principal}`, SK: `CAP#self_edit#${subject}#${at.slice(0, 10)}` });
export const siteKeys = (sk) => ({ PK: "CSTAT#site", SK: sk });
export const personKeys = (principal, sk) => ({ PK: `CSTAT#person:${principal}`, SK: sk });
export const dayOf = (at) => at.slice(0, 10);
export const monthOf = (at) => at.slice(0, 7);
/** Epoch seconds at which the `D#` row of the UTC day holding `at` expires. */
export const dayRowTtl = (at) => Math.floor((Date.parse(`${dayOf(at)}T00:00:00Z`) + DAY_ROW_TTL_DAYS * DAY_MS) / 1000);

function checkAt(at) {
  if (typeof at !== "string" || !AT_RE.test(at) || Number.isNaN(Date.parse(at))) throw new TypeError("contribution: at must be an ISO-8601 UTC timestamp");
  return at;
}
function checkActor(actor) {
  if (!actor || typeof actor.id !== "string" || actor.id === "" || actor.id.includes("#")) throw new TypeError("contribution: actor.id is required");
  return actor;
}
function checkEvent(event) {
  checkActor(event?.actor);
  checkAt(event.at);
  if (typeof event.id !== "string" || !ULID_RE.test(event.id)) throw new TypeError("contribution: event.id must be a ULID");
  if (!CONTRIB_KINDS.includes(event.kind)) throw new TypeError(`contribution: unknown kind ${event.kind}`);
  if (!Number.isInteger(event.weight) || event.weight < 1 || !Number.isInteger(event.photos ?? 0)) throw new TypeError("contribution: event.weight must be a positive integer");
  return event;
}

/** The counter deltas an event adds (positive) or removes (negative): `n`, `n_<kind>` and `n_photo`. Zero deltas are left out. */
export function deltasOf({ kind, weight, photos = 0 }, sign = 1) {
  const d = { n: sign * weight, [`n_${kind}`]: sign * 1 };
  if (photos > 0) d.n_photo = sign * photos;
  return d;
}

/**
 * The five counter updates of one event, in the buckets of `event.at`: site TOTAL, site day, site month, person TOTAL, person month.
 * Adding sets `first_at` only if absent (TOTAL rows). Removing never touches `first_at`. A day row past its ttl has already gone: the
 * update recreates it with a ttl in the past (kept if already set), so the negative row is deleted within days and reads clamp at 0.
 */
function counterOps(event, sign) {
  const deltas = deltasOf(event, sign);
  const total = sign > 0 ? { ifNotExists: { first_at: event.at } } : {};
  const who = event.actor.id;
  return [
    counterUpdate(siteKeys("TOTAL"), deltas, total),
    counterUpdate(siteKeys(`D#${dayOf(event.at)}`), { n: deltas.n }, { ttl: dayRowTtl(event.at) }),
    counterUpdate(siteKeys(`M#${monthOf(event.at)}`), { n: deltas.n }),
    counterUpdate(personKeys(who, "TOTAL"), deltas, total),
    counterUpdate(personKeys(who, `M#${monthOf(event.at)}`), { n: deltas.n }),
  ];
}

/** An empty fragment. */
export const emptyOps = () => ({ puts: [], deletes: [], updates: [], checks: [] });

/**
 * The event item for a contribution. `id` defaults to `uid()`; the backfill passes a derived id so a second run finds the same event.
 * `ref` is `{ type, id, thread? }` (type must match the kind), `subject` the record or thread the contribution is about.
 */
export function buildEvent({ actor, kind, ref, subject, photos = 0, at, via = "ui", hidden, id, uid }) {
  checkActor(actor);
  checkAt(at);
  if (!CONTRIB_KINDS.includes(kind)) throw new TypeError(`contribution: unknown kind ${kind}`);
  if (!CONTRIB_VIA.includes(via)) throw new TypeError(`contribution: via must be one of ${CONTRIB_VIA.join(", ")}`);
  if (!Number.isInteger(photos) || photos < 0 || photos > MAX_PHOTOS) throw new TypeError(`contribution: photos must be an integer from 0 to ${MAX_PHOTOS}`);
  if (!ref || ref.type !== REF_TYPES[kind] || typeof ref.id !== "string" || ref.id === "") throw new TypeError(`contribution: a ${kind} needs ref.type ${REF_TYPES[kind]} and ref.id`);
  const eid = id ?? uid?.();
  if (typeof eid !== "string" || !ULID_RE.test(eid)) throw new TypeError("contribution: the event id must be a ULID (pass id or uid)");
  return {
    ...eventKeys(actor.id, eid),
    GSI1PK: GSI_CONTRIBS,
    GSI1SK: eid,
    entity: "contrib",
    id: eid,
    kind,
    actor: { id: actor.id, ...(typeof actor.label === "string" ? { label: actor.label } : {}) },
    at,
    weight: 1 + photos,
    photos,
    via,
    ref: { type: ref.type, id: ref.id, ...(ref.thread !== undefined ? { thread: ref.thread } : {}) },
    ...(subject !== undefined ? { subject } : {}),
    ...(hidden ? { hidden: true } : {}),
  };
}

/**
 * Credits a contribution: the event Put (condition attribute_not_exists(PK)) and the five counter updates. For `self_edit` it also
 * puts the daily `CAP#` marker (no condition: a race can at worst count twice, which is benign), so the caller reads the marker first
 * with selfEditCapped() and skips the call when it exists. Returns `{ event, puts, deletes, updates, checks }`; store `event.id` on the
 * written item as `contrib: { id }` so a later delete can revoke it.
 */
export function contribOps(args) {
  const event = buildEvent(args);
  const puts = [{ item: event, condition: "attribute_not_exists(PK)" }];
  if (event.kind === "self_edit") {
    if (typeof event.subject !== "string" || event.subject === "") throw new TypeError("contribution: a self_edit needs a subject (the record)");
    puts.push({ item: { ...capKeys(event.actor.id, event.subject, event.at), entity: "contrib_cap", ttl: Math.floor(Date.parse(event.at) / 1000) + CAP_TTL_DAYS * 86_400 } });
  }
  return { event, puts, deletes: [], updates: counterOps(event, 1), checks: [] };
}

/**
 * Takes a contribution back (a delete): deletes the event (condition: it exists) and applies the same five updates with negated
 * deltas, in the buckets of `event.at`. `event` is the stored event item.
 */
export function revokeOps(event) {
  checkEvent(event);
  return {
    puts: [],
    deletes: [{ key: eventKeys(event.actor.id, event.id), condition: "attribute_exists(PK)" }],
    updates: counterOps(event, -1),
    checks: [],
  };
}

/**
 * Hides or shows the event in the feed without changing any count (withdraw, republish, moderation). `event` needs only
 * `{ actor: { id }, id }`, so a caller that stores `{ contrib: { id } }` and knows the author need not read the event.
 */
export function hideOps(event, hidden) {
  if (!event?.actor?.id || typeof event.id !== "string" || !ULID_RE.test(event.id)) throw new TypeError("contribution: hideOps needs { actor: { id }, id }");
  if (typeof hidden !== "boolean") throw new TypeError("contribution: hidden must be a boolean");
  return {
    puts: [],
    deletes: [],
    updates: [{ key: eventKeys(event.actor.id, event.id), update: "SET #hidden = :hidden", condition: "attribute_exists(PK)", names: { "#hidden": "hidden" }, values: { ":hidden": hidden } }],
    checks: [],
  };
}

/**
 * Concatenates fragments (puts, deletes, checks in order) and folds the updates that share a key into one through mergeUpdates, so a
 * purge of 30 comments by one author in one month becomes one decrement per counter key, not 30 duplicate targets. Throws a
 * txn_too_large RangeError when the result would exceed 100 actions. Fragments may carry extra members (such as `event`); they are dropped.
 */
export function mergeOps(...fragments) {
  const out = emptyOps();
  for (const f of fragments) {
    if (!f) continue;
    out.puts.push(...(f.puts ?? []));
    out.deletes.push(...(f.deletes ?? []));
    out.updates.push(...(f.updates ?? []));
    out.checks.push(...(f.checks ?? []));
  }
  out.updates = mergeUpdates(out.updates);
  assertTxnSize(out);
  return out;
}

/** The number of actions mergeOps would produce (used to size purge batches without throwing past the limit). */
export function mergedSize(...fragments) {
  const count = (k) => fragments.reduce((a, f) => a + (f?.[k]?.length ?? 0), 0);
  return count("puts") + count("deletes") + count("checks") + mergeUpdates(fragments.flatMap((f) => f?.updates ?? [])).length;
}

/** Reads the self-edit daily marker: true when this member already earned a self_edit credit for `subject` on the UTC day of `at`. */
export async function selfEditCapped({ ddb, cmds, table }, { actor, subject, at }) {
  checkActor(actor);
  checkAt(at);
  const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: capKeys(actor.id, subject, at) }));
  return r.Item !== undefined;
}

/** Reads one stored event (undefined when it is gone). */
export async function getEvent({ ddb, cmds, table }, principal, id) {
  const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: eventKeys(principal, id) }));
  return r.Item;
}
