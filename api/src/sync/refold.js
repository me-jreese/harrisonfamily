// Refold the record store's derived items from the append-only change log (HFY-TSK-275, review SI-04; BRD2 4.1, 19.8).
//
// SYNC#LOG is the authority. Three kinds of item are derived from it, and `foldLog` rebuilds them with the same rules applyBatch() uses:
//
//   REC#<Class>#<handle>   the head of each object: its last log entry with a class.
//   GID#<Class>#<id>       the gramps_id guard. A live object claims its id; a Person id is retired for ever when the person is deleted,
//                          withdrawn, merged or renumbered; a non-Person id is released. The plan is made per batch (a swap of two ids
//                          commits as one), exactly as planGids() in apply.js does it.
//   IDALIAS#<Class>#<id>   the alias a Person renumber or merge leaves behind.
//
// Pure functions over plain items: no DynamoDB and no clock, so the same code serves the operator tool (scripts/sync-admin.mjs
// rebuild-heads) and its tests. Nothing here returns object text to a caller that prints: the tool names classes, opaque handles and counts.
import { CLASSES, EXPUNGE_GRACE_MS, OP_KINDS, aliasItem, gidClaimItem, gidRetiredItem, headItem, headKey, logItem, seqKey, sha256 } from "./store.js";
import { canonicalJson } from "../shared/canonical.mjs";

export const PRINCIPAL = "operator:sync-admin";
/** The partitions a store recovery may rewrite. Everything else in the table (members, posts, uploads, chat, audit) is another domain's. */
export const SYNC_PREFIXES = Object.freeze(["REC#", "SYNC#", "GID#", "IDALIAS#"]);
/** The audit trail of the recovery tools lives in a SYNC# partition that no recovery copies over or deletes. */
export const ADMIN_PK = "SYNC#ADMIN";
export const isSyncPartition = (pk) => typeof pk === "string" && SYNC_PREFIXES.some((p) => pk.startsWith(p)) && pk !== ADMIN_PK;

/** The grace a privacy withdraw keeps before its history may be expunged (the same 72 hours as store.js EXPUNGE_GRACE_MS). */
export const WITHDRAW_GRACE_MS = EXPUNGE_GRACE_MS;
/** The warning `resurrect` and `rebuild-heads` print when privacy-withdrawn records are being put back (one text, so the two cannot drift). */
export const withdrawWarning = (n) =>
  `WARNING: ${n} of these are privacy withdraws (reason private). Re-creating them puts the record back in the store and the next render republishes it. Proceed only on io's explicit go-ahead for the withdrawn records.`;

const pk = (item) => `${item.PK}\u0000${item.SK}`;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const PERMANENT = "Person";

// ---- checking the log ---------------------------------------------------------------------------------------------------------
/**
 * Checks a log read in key order against SYNC#HEAD.seq: dense seqs 1..headSeq whose key matches the entry, a known op, a hash that
 * matches the object text, and object versions that count up by one. Returns { ok, problems: [{ code, seq }] } (first 50 problems).
 * A log that fails is damaged: the folded heads could not be trusted, so the recovery is the side-table copy-back.
 */
export function checkLog(entries, headSeq) {
  const problems = [];
  const add = (code, seq) => problems.length < 50 && problems.push({ code, seq });
  if (Number.isInteger(headSeq)) {
    if (entries.length < headSeq) add("log_shorter_than_head", entries.length);
    if (entries.length > headSeq) add("log_beyond_head", headSeq + 1);
  }
  const versions = new Map();
  entries.forEach((e, i) => {
    const seq = i + 1;
    if (e.seq !== seq || e.SK !== seqKey(seq) || e.PK !== "SYNC#LOG") return add("seq_gap_or_key_mismatch", seq);
    if (!OP_KINDS.includes(e.op)) return add("unknown_op", seq);
    if (e.op === "marker") return undefined;
    if (!CLASSES.includes(e.class) || typeof e.handle !== "string" || !e.handle) return add("bad_class_or_handle", seq);
    const live = e.op === "create" || e.op === "update";
    if (live && e.expunged !== true) {
      if (typeof e.obj_json !== "string") return add("missing_object", seq);
      if (e.hash !== sha256(e.obj_json)) return add("hash_mismatch", seq);
    }
    if (!live && e.obj_json != null) return add("tombstone_with_object", seq);
    const key = `${e.class}#${e.handle}`;
    const prev = versions.get(key) ?? 0;
    if (!Number.isInteger(e.version) || e.version !== prev + 1) return add("version_gap", seq);
    versions.set(key, e.version);
    return undefined;
  });
  return { ok: problems.length === 0, problems };
}

// ---- folding ------------------------------------------------------------------------------------------------------------------
/**
 * Folds log entries (in seq order) up to `toSeq` into the derived items.
 *   opts.blobs    Map "Class#handle" -> the blob descriptor of the stored Media head. The descriptor is on the head, not in the log, so the
 *                 fold keeps the one the head holds.
 *   opts.aliases  Map "Class#oldId" -> the stored alias item. A merge alias names the survivor's id, which the log does not hold.
 * Returns { state, heads, gids, aliases, live, expunged, blobsUnknown, mergeAliasesUnknown }:
 *   state    Map "Class#handle" -> { entry, deleted } (the last entry per object)
 *   heads    Map pk -> expected head item          gids  Map pk -> expected GID item          aliases  Map pk -> expected alias item
 *   live     the number of live heads              expunged  the "Class#handle" keys whose last entry was expunged (their head is kept)
 */
export function foldLog(entries, { toSeq = Infinity, blobs = new Map(), aliases: storedAliases = new Map() } = {}) {
  const state = new Map();
  const gidState = new Map(); // "Class#id" -> item | null
  const aliasState = new Map(); // "Class#oldId" -> item
  const used = entries.filter((e) => e.seq <= toSeq);
  let mergeAliasesUnknown = 0;

  const foldBatch = (batch) => {
    const claims = new Map();
    const gives = new Map();
    const aliasPlans = [];
    const at = batch[0].at;
    const batchId = batch[0].batch_id;
    for (const e of batch) {
      if (!e.class || e.class === "Tag") continue; // a marker has no class; a Tag has no gramps_id
      const prior = state.get(`${e.class}#${e.handle}`);
      const prev = prior && !prior.deleted ? prior.entry.gramps_id : undefined;
      const idKey = (id) => `${e.class}#${id}`;
      if (e.op === "create" || e.op === "update") {
        if (prev !== undefined && prev !== "" && prev !== e.gramps_id) {
          gives.set(idKey(prev), { id: prev, handle: e.handle, reason: "renumbered" });
          if (e.class === PERMANENT) aliasPlans.push({ cls: e.class, oldId: prev, handle: e.handle, current: e.gramps_id, reason: "renumber" });
        }
        if (prev === e.gramps_id || !e.gramps_id) continue;
        claims.set(idKey(e.gramps_id), { id: e.gramps_id, handle: e.handle });
      } else if (prior && !prior.deleted && prev) {
        const reason = e.op === "withdraw" ? "withdrawn" : e.reason === "merge" ? "merged" : "deleted";
        gives.set(idKey(prev), { id: prev, handle: e.handle, reason });
        if (e.class === PERMANENT && e.reason === "merge") aliasPlans.push({ cls: e.class, oldId: prev, handle: e.handle, current: undefined, reason: "merge" });
      }
    }
    for (const key of new Set([...claims.keys(), ...gives.keys()])) {
      const cls = key.slice(0, key.indexOf("#"));
      const claim = claims.get(key);
      const give = gives.get(key);
      const id = (claim ?? give).id;
      if (claim) gidState.set(key, gidClaimItem(cls, id, claim.handle, { at, batch_id: batchId }));
      else if (cls === PERMANENT) gidState.set(key, gidRetiredItem(cls, id, give.handle, give.reason, { at, batch_id: batchId }));
      else gidState.set(key, null);
    }
    for (const a of aliasPlans) {
      const key = `${a.cls}#${a.oldId}`;
      let current = a.current;
      if (a.reason === "merge") {
        const stored = storedAliases.get(key);
        current = stored && stored.handle === a.handle ? stored.current_gramps_id ?? null : null;
        if (current === null) mergeAliasesUnknown += 1;
      }
      aliasState.set(key, aliasItem(a.cls, a.oldId, { handle: a.handle, current_gramps_id: current ?? null, reason: a.reason, batch_id: batchId, at }));
    }
    for (const e of batch) {
      if (!e.class) continue;
      state.set(`${e.class}#${e.handle}`, { entry: e, deleted: !(e.op === "create" || e.op === "update") });
    }
  };

  for (let i = 0; i < used.length; ) {
    let j = i;
    while (j < used.length && used[j].batch_id === used[i].batch_id) j += 1;
    foldBatch(used.slice(i, j));
    i = j;
  }

  const heads = new Map();
  const expunged = [];
  let live = 0;
  let blobsUnknown = 0;
  for (const [key, { entry: e, deleted }] of state) {
    if (e.expunged === true) {
      expunged.push(key);
      continue;
    }
    if (!deleted) live += 1;
    const blob = !deleted && e.class === "Media" ? blobs.get(key) : undefined;
    if (!deleted && e.class === "Media" && blob === undefined) blobsUnknown += 1;
    const item = headItem({
      class: e.class, handle: e.handle, gramps_id: e.gramps_id, version: e.version, seq: e.seq, deleted, objJson: deleted ? null : e.obj_json, blob,
      reason: deleted ? e.reason : undefined, at: e.at, by: e.principal, origin: e.origin,
    });
    heads.set(pk(item), item);
  }
  const gids = new Map();
  for (const item of gidState.values()) if (item) gids.set(pk(item), item);
  const aliases = new Map([...aliasState.values()].map((item) => [pk(item), item]));
  return { state, heads, gids, aliases, live, expunged, blobsUnknown, mergeAliasesUnknown };
}

// ---- rolling the heads back to a seq ------------------------------------------------------------------------------------------
/**
 * The log entries that make the store's current state equal its state at `toSeq`, appended after the log's tail so the log stays
 * append-only (seqs, versions and history are never rewritten): for every object whose state differs between `toSeq` and the tail, a
 * delete (the object did not exist then), an update back to the older text, or a create over a tombstone. They carry origin `admin`,
 * principal operator:sync-admin and one batch id, like `resurrect`.
 *
 * A create over a tombstone brings back what a delete or withdraw removed, so it keeps the refusals `sync-admin resurrect` (planOne) keeps:
 *   withdrawn_private_needs_flag  the tail is a privacy withdraw and `includeWithdrawn` is not set: re-creating it republishes a withdrawn record
 *   merge                         the tail is the delete of a merge: the alias and the survivor are the merge's business
 *   media_blob_not_in_log         the object is a Media: its blob descriptor is on the head, which the delete dropped, and not in the log
 *   past_grace                    the tail is a privacy withdraw older than the 72-hour grace: its expunge is queued, and no flag brings it back
 * A refused object keeps its tombstone and is listed. The delete of any other class is rolled back whatever its age (that is what the command is for).
 *
 * Returns { entries, skipped, refused, withdrawn, media }:
 *   entries    the appended log entries ([] when toSeq is the tail or nothing differs)
 *   skipped    the "Class#handle" keys left as they are because privacy-expunge rewrote the entry at `toSeq` or at the tail (its object text
 *              is gone on purpose, so a rollback could neither restore it nor tell what it was, and must not write a live entry without it)
 *   refused    [{ key, reason }] the tombstones left as they are for one of the reasons above
 *   withdrawn  the "Class#handle" keys of privacy withdraws that `includeWithdrawn` re-creates (the caller prints the warning)
 *   media      the Media "Class#handle" keys rolled back to different text while live: the blob descriptor lives on the head, not in the log,
 *              so such a head keeps its newest blob, which may no longer match the older text
 */
export function planRollback(entries, toSeq, { at, batchId, includeWithdrawn = false }) {
  const tailSeq = entries.length;
  const out = { entries: [], skipped: [], refused: [], withdrawn: [], media: [] };
  if (toSeq >= tailSeq) return out;
  const tail = foldLog(entries).state;
  const target = foldLog(entries, { toSeq }).state;
  const keys = [...tail.keys()].sort((a, b) => (CLASSES.indexOf(a.split("#")[0]) - CLASSES.indexOf(b.split("#")[0])) || (a < b ? -1 : 1));
  for (const key of keys) {
    const cur = tail.get(key);
    const was = target.get(key);
    if (cur.entry.expunged === true || was?.entry.expunged === true) {
      out.skipped.push(key);
      continue;
    }
    const wasLive = was && !was.deleted;
    const sameState = wasLive ? !cur.deleted && cur.entry.obj_json === was.entry.obj_json && cur.entry.gramps_id === was.entry.gramps_id : cur.deleted;
    if (sameState) continue;
    if (wasLive && cur.deleted) {
      const withdraw = cur.entry.op === "withdraw";
      const reason = cur.entry.reason === "merge" ? "merge"
        : withdraw && !includeWithdrawn ? "withdrawn_private_needs_flag"
        : cur.entry.class === "Media" ? "media_blob_not_in_log"
        : withdraw && !(Date.parse(at) - Date.parse(cur.entry.at) <= WITHDRAW_GRACE_MS) ? "past_grace"
        : undefined;
      if (reason) {
        out.refused.push({ key, reason });
        continue;
      }
      if (withdraw) out.withdrawn.push(key);
    }
    const seq = tailSeq + out.entries.length + 1;
    const base = { seq, batch_id: batchId, class: cur.entry.class, handle: cur.entry.handle, version: cur.entry.version + 1, base_version: cur.entry.version, principal: PRINCIPAL, origin: "admin", at };
    if (wasLive) {
      out.entries.push(logItem({ ...base, op: cur.deleted ? "create" : "update", gramps_id: was.entry.gramps_id, objJson: was.entry.obj_json }));
      if (cur.entry.class === "Media" && !cur.deleted && cur.entry.obj_json !== was.entry.obj_json) out.media.push(key);
    } else out.entries.push(logItem({ ...base, op: "delete", gramps_id: cur.entry.gramps_id, reason: "rollback" }));
  }
  return out;
}

// ---- comparing with the store ------------------------------------------------------------------------------------------------
/**
 * What it takes to turn `stored` (Map pk -> item) into `expected` (Map pk -> item): items to put, keys to delete, and how many match.
 * `keep` lists pks the fold does not speak for (an expunged head), which are neither put nor deleted.
 */
export function diffItems(expected, stored, keep = new Set()) {
  const puts = [];
  const deletes = [];
  let unchanged = 0;
  for (const [k, item] of expected) {
    const have = stored.get(k);
    if (have === undefined) puts.push({ item, kind: "missing" });
    else if (!same(have, item)) puts.push({ item, kind: "changed", fields: Object.keys({ ...have, ...item }).filter((f) => canonicalJson(have[f] ?? null) !== canonicalJson(item[f] ?? null)).sort() });
    else unchanged += 1;
  }
  for (const [k, item] of stored) if (!expected.has(k) && !keep.has(k)) deletes.push({ key: { PK: item.PK, SK: item.SK }, item });
  return { puts, deletes, unchanged };
}

export const headPk = (cls, handle) => `REC#${cls}#${handle}\u0000HEAD`;
export const syncHeadPk = pk(headKey());
export { pk as itemPk };
