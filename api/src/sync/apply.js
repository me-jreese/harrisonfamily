// applyBatch(): the one write path into the cloud record store (HFY-TSK-243, BRD2 D2-02). Every genealogy write from every origin
// (desktop push, seed, self-edit, admin edit, proposal approval, graduation, moderation marker, site tagging) is one call.
//
// One call is one TransactWriteItems of at most 100 actions:
//   SYNC#HEAD            update, condition seq = <seq read>              (the dense seq counter; a race fails here)
//   REC#<Class>#<handle> put per op, condition on base_version           (If-Match; a tombstone is kept)
//   SYNC#LOG/<seq>       put per op, one dense seq each                  (change log = history = outbox)
//   GID#<Class>#<id>     one write per distinct GID item                 (claim, re-point, retire or release)
//   IDALIAS#Person#<id>  put for a Person merge or an allowed renumber   (never deleted)
//   SYNC#BATCH#<id>      put, attribute_not_exists                       (the receipt; the cross-attempt idempotency guard)
//   AUDIT#records:<id>   put                                              (one audit item per batch)
//   SYNC#BUDGET#<hour>   update, only for a batch with a delete or withdraw (the destructive budget the validator reads; it is checked on
//                        the same view as the SYNC#HEAD seq condition, so concurrent batches cannot both pass it)
//   + caller `extra` items and registered contributors' items             (proposal state, contribution ops, comment updates)
// The SYNC#HEAD update also keeps `live_heads`, the count of live heads (the validator's 5 % share of the budget). It counts only from
// an empty tree or an existing count; a store filled another way needs a backfill (validator.js header).
//
// The server validator (validator.js, HFY-TSK-245) runs on every call, from every origin, before the version check.
//
// Not here: ID minting (store-id-policy), record-change notifications (the render outbox, D2-02), HTTP mapping (the sync and edit routes).
import { randomUUID } from "node:crypto";
import { HttpError, logSafeError } from "../http.js";
import { TxnCancelled, TxnTokenMismatch, assertTxnSize, auditItem, counterUpdate, mergeUpdates, transact } from "../txn.js";
import { canonicalJson, HANDLE_SHAPE } from "../records/ops.js";
import { canonicalJson as storedJson } from "../shared/canonical.mjs";
import { SyncError } from "./errors.js";
import { defaultHooks } from "./hooks.js";
import {
  BUDGET_TTL_SECONDS, CLASSES, FIXED_TXN_ITEMS, MAX_BATCH_OBJ_BYTES, MAX_BLOB_BYTES, MAX_OBJ_BYTES, MAX_OPS, OP_KINDS, ORIGINS, aliasItem, auditId, batchIdFor, batchItem, budgetBucket, budgetKey,
  getBatchReceipt, getGid, getRecordItem, getSyncHead, gidClaimItem, gidDelete, gidRetiredItem, headItem, headKey, isPermanentIdClass, keyId, logItem, objectJson, parseHead, requestTokenFor, sha256,
} from "./store.js";
import { defaultValidate, isFullValidator } from "./validator.js";
import { createStoreView } from "./view.js";

export { SyncError };

/** Internal retries after a lost seq race (sync design S07). */
export const MAX_SEQ_RETRIES = 3;

const bad = (code, message, details) => new SyncError(400, code, message, details);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- request shape ---------------------------------------------------------------------------------------------------
function normaliseOps(rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) throw bad("validation", "ops must be a non-empty array");
  if (rawOps.length > MAX_OPS) throw new SyncError(413, "batch_too_large", `a batch holds at most ${MAX_OPS} ops`);
  const seenIds = new Set();
  const seenObjs = new Set();
  let bytes = 0;
  const ops = rawOps.map((raw, i) => {
    const at = `ops[${i}]`;
    if (!isObj(raw)) throw bad("validation", `${at} must be an object`);
    const op_id = raw.op_id === undefined ? String(i + 1) : raw.op_id;
    if (typeof op_id !== "string" || op_id.length < 1 || op_id.length > 64) throw bad("validation", `${at}.op_id must be a short string`);
    if (seenIds.has(op_id)) throw bad("validation", `${at}.op_id repeats an earlier op`);
    seenIds.add(op_id);
    if (!OP_KINDS.includes(raw.op)) throw bad("validation", `${at}.op must be one of ${OP_KINDS.join(", ")}`);
    const reason = raw.reason;
    if (reason !== undefined && (typeof reason !== "string" || reason.length < 1 || reason.length > 64)) throw bad("validation", `${at}.reason must be a short string`);

    if (raw.op === "marker") {
      // A marker is a log entry with no head change (a session completion, a moderation mark). `ref` names the object it is about.
      let ref;
      if (raw.ref !== undefined) {
        if (!isObj(raw.ref) || !CLASSES.includes(raw.ref.class) || typeof raw.ref.handle !== "string" || !HANDLE_SHAPE.test(raw.ref.handle)) throw bad("validation", `${at}.ref must be {class, handle}`);
        ref = { class: raw.ref.class, handle: raw.ref.handle };
      }
      return { op_id, op: "marker", ...(reason !== undefined ? { reason } : {}), ...(ref ? { ref } : {}) };
    }

    if (!CLASSES.includes(raw.class)) throw new SyncError(422, "unknown_class", `${at}.class is not a Gramps class`);
    if (typeof raw.handle !== "string" || !HANDLE_SHAPE.test(raw.handle)) throw bad("validation", `${at}.handle is not a Gramps handle`);
    const objKey = `${raw.class}#${raw.handle}`;
    if (seenObjs.has(objKey)) throw bad("duplicate_object", `${at} repeats an object already in this batch`);
    seenObjs.add(objKey);

    const base = raw.base_version ?? null;
    const norm = { op_id, op: raw.op, class: raw.class, handle: raw.handle, base_version: base };
    if (raw.op === "create") {
      if (base !== null && !(Number.isInteger(base) && base >= 1)) throw bad("validation", `${at}.base_version must be null (new) or a tombstone's version`);
    } else if (!(Number.isInteger(base) && base >= 1)) throw bad("validation", `${at}.base_version is required for ${raw.op}`);

    if (raw.op === "create" || raw.op === "update") {
      const obj = raw.obj;
      if (!isObj(obj)) throw bad("validation", `${at}.obj must be an object`);
      if (obj._class !== raw.class) throw bad("validation", `${at}.obj._class must be ${raw.class}`);
      if (obj.handle !== raw.handle) throw bad("validation", `${at}.obj.handle must equal ${at}.handle`);
      if (raw.class !== "Tag" && (typeof obj.gramps_id !== "string" || obj.gramps_id.length < 1 || obj.gramps_id.length > 64)) throw bad("validation", `${at}.obj.gramps_id is required`);
      let objJson;
      try {
        objJson = objectJson(obj);
      } catch {
        throw bad("validation", `${at}.obj is not canonical JSON`);
      }
      const n = Buffer.byteLength(objJson);
      if (n > MAX_OBJ_BYTES) throw new SyncError(413, "batch_too_large", `${at}.obj exceeds ${MAX_OBJ_BYTES} bytes`);
      bytes += 2 * n;
      norm.obj = JSON.parse(objJson);
      norm.objJson = objJson;
      norm.gramps_id = raw.class === "Tag" ? "" : obj.gramps_id;
      if (raw.blob !== undefined) {
        // The blob descriptor rides on the head item next to obj_json, so it is capped and counted (the item limit is 400 KB).
        if (raw.class !== "Media" || !isObj(raw.blob)) throw bad("validation", `${at}.blob is only for a Media object and must be an object`);
        let blobJson;
        try {
          blobJson = storedJson(raw.blob); // stored next to obj_json, so the same shared rule (no fraction, no lone surrogate)
        } catch {
          throw bad("validation", `${at}.blob is not canonical JSON`);
        }
        const bn = Buffer.byteLength(blobJson);
        if (bn > MAX_BLOB_BYTES) throw new SyncError(413, "batch_too_large", `${at}.blob exceeds ${MAX_BLOB_BYTES} bytes`);
        bytes += bn;
        norm.blob = JSON.parse(blobJson);
      }
      if (raw.renumber === true) norm.renumber = true;
    } else if (raw.obj !== undefined && raw.obj !== null) {
      throw bad("validation", `${at}.obj must be absent for ${raw.op}`);
    }
    if (raw.op === "withdraw") {
      if (reason !== "private") throw bad("validation", `${at}.reason of a withdraw must be private`);
      norm.reason = "private";
    } else if (reason !== undefined) norm.reason = reason;
    if (raw.merged_into !== undefined) {
      if (raw.op !== "delete" || raw.class !== "Person" || reason !== "merge") throw bad("validation", `${at}.merged_into is only for a Person delete with reason merge`);
      if (typeof raw.merged_into !== "string" || raw.merged_into.length < 1 || raw.merged_into.length > 64) throw bad("validation", `${at}.merged_into must be a gramps_id of at most 64 characters`);
      norm.merged_into = raw.merged_into;
    }
    if (raw.class === "Person" && raw.op === "delete" && reason === "merge" && !norm.merged_into) throw bad("validation", `${at}.merged_into is required for a Person merge`);
    return norm;
  });
  if (bytes > MAX_BATCH_OBJ_BYTES) throw new SyncError(413, "batch_too_large", "the batch's objects are too large");
  // Refuse a batch that cannot fit 100 transaction items before any read. A renumbering Person update takes up to 5 items (head,
  // log, the old id's retire, the new id's claim, the alias), a merge 4, so 24 of them do not fit: clients split these batches.
  // The budget counter is one more item, but only for a batch with a delete or a withdraw (a duplicate op per object is refused above).
  const destructive = ops.some((op) => op.op === "delete" || op.op === "withdraw");
  const bound = FIXED_TXN_ITEMS + (destructive ? 1 : 0) + ops.reduce((n, op) => n + txnItemBound(op), 0);
  if (bound > 100) throw new SyncError(413, "batch_too_large", `these ops need up to ${bound} transaction items and the limit is 100; split renumber and merge ops into smaller batches`);
  return ops;
}

/** The most transaction items one op can take: its head and log, plus the GID writes and alias its kind may need. */
function txnItemBound(op) {
  if (op.op === "marker") return 1;
  if (op.op === "create") return 3; // head, log, the id claim
  if (op.op === "update") return op.renumber === true && op.class === "Person" ? 5 : 4; // + the old id's write (+ an alias for a Person)
  return op.class === "Person" && op.reason === "merge" ? 4 : 3; // delete or withdraw: head, log, the id write (+ an alias for a merge)
}

/** Strips the server-only members from an op, leaving what the caller sent: this is what the request hash covers. */
const wire = (op) => {
  const { objJson, ...rest } = op; // eslint-disable-line no-unused-vars
  return rest;
};

// ---- gate ------------------------------------------------------------------------------------------------------------
/**
 * The store gate, evaluated against SYNC#HEAD inside every call (review SI-36, DL-09). Until the seed completes, every origin but
 * `seed` is refused (503 store_not_seeded); while `writes_enabled` is false every origin, the seed included, is refused
 * (503 sync_paused). An absent head counts as not seeded; `writes_enabled` pauses only when it is explicitly false. When both
 * hold for a non-seed origin the answer is store_not_seeded, because the store is not usable at all yet.
 */
export function checkStoreGate(head, origin) {
  if (origin !== "seed" && (!head || head.seeded !== true)) throw new SyncError(503, "store_not_seeded", "the store has not been seeded yet");
  if (head && head.writes_enabled === false) throw new SyncError(503, "sync_paused", "writes are paused");
}

// ---- planning --------------------------------------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();

function conflictDetail(op, item) {
  return {
    op_id: op.op_id,
    class: op.class,
    handle: op.handle,
    reason: !item ? "not_found" : item.deleted === true ? "deleted" : op.op === "create" ? "exists" : "version_mismatch",
    current_version: item ? item.version : null,
    // The stored object is the redacted object (the store never holds anything else), so it is safe to return as it is.
    current: item && item.deleted !== true && item.obj_json != null ? JSON.parse(item.obj_json) : null,
  };
}

/** Compares each op's base_version with the head it read. Returns the ops' new versions, or throws 409 with the detail of every mismatch. */
function checkVersions(ops, heads) {
  const conflicts = [];
  const versions = ops.map((op) => {
    if (op.op === "marker") return undefined;
    const item = heads.get(`${op.class}#${op.handle}`);
    if (op.op === "create") {
      if (!item) return op.base_version === null ? 1 : (conflicts.push(conflictDetail(op, item)), undefined);
      if (item.deleted === true && op.base_version === item.version) return item.version + 1; // resurrecting a tombstone
      conflicts.push(conflictDetail(op, item));
      return undefined;
    }
    if (item && item.deleted !== true && item.version === op.base_version) return item.version + 1;
    conflicts.push(conflictDetail(op, item));
    return undefined;
  });
  if (conflicts.length) {
    const onlyExists = conflicts.every((c) => c.reason === "exists");
    throw new SyncError(409, onlyExists ? "exists" : "version_conflict", onlyExists ? "an object with that handle already exists" : "the base version is stale", { conflicts });
  }
  return versions;
}

const gidId = (cls, id) => `${cls}#${id}`;

/**
 * Plans the GID#/IDALIAS# writes of a batch. Each distinct GID item gets exactly one write, decided from the whole batch, so a swap
 * of two non-person ids, or a rotation of three, commits in one transaction (SI-29). `heads` holds the head items read for the ops,
 * `gids` the GID items (undefined when absent) read for every id the batch claims or gives up.
 * Returns { writes: [{ id, cls, id, kind: "claim"|"retire"|"release", handle, reason?, prior }], aliases: [...] }.
 */
function planGids(ops, heads, head, gids) {
  const claims = new Map(); // gid id -> { cls, grampsId, handle }
  const gives = new Map(); // gid id -> { cls, grampsId, handle, reason }
  const aliases = [];
  const giveUp = (cls, grampsId, handle, reason) => {
    if (grampsId) gives.set(gidId(cls, grampsId), { cls, grampsId, handle, reason });
  };
  for (const op of ops) {
    if (op.op === "marker") continue;
    const item = heads.get(`${op.class}#${op.handle}`);
    if (op.class === "Tag") continue; // a Tag has no gramps_id
    if (op.op === "create" || op.op === "update") {
      // A Person's id is permanent and a tombstone keeps it retired, so a create over a deleted, withdrawn or merged Person is refused:
      // resurrection is operator tooling (sync-admin resurrect), not a batch op. This also closes a create under a different id.
      if (op.op === "create" && isPermanentIdClass(op.class) && item && item.deleted === true) {
        throw new SyncError(409, "gramps_id_retired", "that person's gramps_id is retired and the person is not recreated through a batch", { class: op.class, gramps_id: item.gramps_id });
      }
      const prev = item && item.deleted !== true ? item.gramps_id : undefined;
      if (prev !== undefined && prev !== op.gramps_id) {
        if (isPermanentIdClass(op.class) && op.renumber !== true) throw new SyncError(409, "renumber_blocked", "a person's gramps_id cannot change", { conflicts: [{ op_id: op.op_id, class: op.class, handle: op.handle }] });
        giveUp(op.class, prev, op.handle, "renumbered");
        if (isPermanentIdClass(op.class)) aliases.push({ cls: op.class, oldId: prev, handle: op.handle, current: op.gramps_id, reason: "renumber" });
      }
      if (prev === op.gramps_id) continue; // the id is already this object's: no GID write
      const key = gidId(op.class, op.gramps_id);
      const other = claims.get(key);
      if (other && other.handle !== op.handle) throw new SyncError(409, "gid_conflict", "two objects in this batch claim one gramps_id", { class: op.class, gramps_id: op.gramps_id });
      claims.set(key, { cls: op.class, grampsId: op.gramps_id, handle: op.handle });
    } else if (item && item.deleted !== true) {
      // delete or withdraw: the id goes (non-person) or is retired for ever (person)
      const reason = op.op === "withdraw" ? "withdrawn" : op.reason === "merge" ? "merged" : "deleted";
      giveUp(op.class, item.gramps_id, op.handle, reason);
      if (isPermanentIdClass(op.class) && op.reason === "merge") aliases.push({ cls: op.class, oldId: item.gramps_id, handle: op.handle, current: op.merged_into, reason: "merge" });
    }
  }
  // Person merges stay held until identity-merge-rekey ships (SYNC#HEAD.merges_enabled).
  const merging = ops.find((o) => o.op === "delete" && o.class === "Person" && o.reason === "merge");
  if (merging && head?.merges_enabled !== true) throw new SyncError(409, "merges_disabled", "person merges are held", { conflicts: [{ op_id: merging.op_id, class: merging.class, handle: merging.handle }] });

  const writes = [];
  const all = new Set([...claims.keys(), ...gives.keys()]);
  for (const key of all) {
    const claim = claims.get(key);
    const give = gives.get(key);
    const prior = gids.get(key);
    const cls = (claim ?? give).cls;
    const grampsId = (claim ?? give).grampsId;
    if (claim && prior) {
      // A retired id is never claimed again, by anyone, its own person included (an A to B to A renumber is refused too).
      if (prior.retired === true || (prior.handle !== claim.handle && give && give.handle === prior.handle && isPermanentIdClass(cls))) {
        throw new SyncError(409, "gramps_id_retired", "that gramps_id belongs to a retired person and is never reused", { class: cls, gramps_id: grampsId });
      }
      const freed = give && give.handle === prior.handle && !isPermanentIdClass(cls);
      if (prior.handle !== claim.handle && !freed) throw new SyncError(409, "gramps_id_taken", "that gramps_id is in use", { class: cls, gramps_id: grampsId });
    }
    if (claim) writes.push({ key, cls, grampsId, kind: "claim", handle: claim.handle, prior });
    else if (isPermanentIdClass(cls)) writes.push({ key, cls, grampsId, kind: "retire", handle: give.handle, reason: give.reason, prior });
    else writes.push({ key, cls, grampsId, kind: "release", handle: give.handle, prior });
  }
  return { writes, aliases };
}

/** The condition that pins a GID item to the state it was read in. */
function priorCondition(prior) {
  if (!prior) return { condition: "attribute_not_exists(PK)" };
  return prior.retired === true
    ? { condition: "#gh = :gh AND #gr = :gr", names: { "#gh": "handle", "#gr": "retired" }, values: { ":gh": prior.handle, ":gr": true } }
    : { condition: "#gh = :gh AND attribute_not_exists(#gr)", names: { "#gh": "handle", "#gr": "retired" }, values: { ":gh": prior.handle } };
}

// ---- the batch -------------------------------------------------------------------------------------------------------
/**
 * Applies a batch of ops atomically.
 *
 * @param ctx  { ddb, cmds, table, validate?, storeView?, now?, uid?, log?, hooks?, maxSeqRetries?, txnOpts?, unsafeNoValidate? }
 *   applyBatch always runs the validator of validator.js with the policy and schema in the repository (the privacy checker, the id rules and
 *   the integrity rules cannot be wired out). `validate(view)` is an extra layer that runs after it, or, when it is a `createValidator({...})`
 *   result, the whole validator with other options in its place. `view` is
 *   { ops, origin, principal, on_behalf_of, sync_head: {seq, tree_id, live_heads}, record(cls, handle), store, stepUp, expected }:
 *   `store` is the store view (view.js; `ctx.storeView(store, {now, prefetched})` may supply another one, for example the store-view fold),
 *   `stepUp` and `expected` come from `req`. It throws an HttpError to refuse the batch, runs before the version check (a refused caller
 *   never sees conflict detail) and runs again on the refreshed view after every lost seq race. Only the seed and tests may pass
 *   `unsafeNoValidate: true` to skip the default (a `validate` then runs alone), and a seed that does so must have run the projection's own checks. `hooks` is a
 *   createHookRegistry() (default: the process-wide one). `txnOpts` goes to transact() (tests inject sleep and random).
 * @param req  { principal, origin, onBehalfOf?, idempotencyKey, ops, extra?, client?, stepUp?, expected? }
 *   `stepUp: true` says the route verified a fresh step-up for the caller (amr mfa within its window); the validator asks for it on a
 *   desktop delete and on a destructive batch over the budget. `expected` is the open push session's announced handles, an array of
 *   {class, handle} or "Class#handle": a reference to one resolves although it is not written yet.
 *   op:    { op_id?, op: create|update|delete|withdraw|marker, class, handle, base_version, obj?, reason?, renumber?, merged_into?, blob? }
 *          `renumber` (a Person update that changes its gramps_id), `merged_into` (a Person delete with reason merge: the survivor's
 *          gramps_id, at most 64 characters) and `blob` (a Media descriptor, at most MAX_BLOB_BYTES) are PROVISIONAL op fields invented
 *          here to serve the retire-plus-alias contract (AC5). validator-js, sync-push-routes and identity-merge-rekey must match or
 *          replace them; the renumber_blocked and merges_disabled checks duplicate rules the validator also owns.
 *   extra: transact() items { puts, deletes, updates, checks } committed in the same transaction (proposal state, contribution ops).
 * @returns { batch_id, seq_from, seq_to, results: [{ op_id, class, handle, version, seq, gramps_id }], replayed }
 *   A replay of a stored key returns the stored body with `replayed: true` and runs no hook.
 * @throws SyncError (400 validation, 409 version_conflict | exists | gid_conflict | gramps_id_taken | gramps_id_retired |
 *   renumber_blocked | merges_disabled, 413 batch_too_large, 422 idempotency_key_reused | unknown_class, 428 idempotency_key_required,
 *   503 store_not_seeded | sync_paused | retryable). A failed condition on a caller's own `extra` item is the TxnCancelled itself.
 */
export async function applyBatch(ctx, req) {
  const { ddb, cmds, table } = ctx;
  const now = ctx.now ?? Date.now;
  const log = ctx.log ?? console;
  const hooks = ctx.hooks ?? defaultHooks;
  const maxSeqRetries = ctx.maxSeqRetries ?? MAX_SEQ_RETRIES;
  const { principal, origin, onBehalfOf, idempotencyKey, extra, client, stepUp, expected } = req ?? {};

  // The version-conflict body returns stored objects, which is safe only because the validator runs first: a caller cannot skip it by
  // omission or by wiring a partial one. The repository's own validator always runs. A plain ctx.validate is an extra layer after it; a
  // createValidator(...) result is the whole validator with other options and takes its place. Only the seed and tests may opt out.
  if (ctx.validate !== undefined && typeof ctx.validate !== "function") throw new TypeError("ctx.validate must be a function");
  const validators = [];
  if (ctx.unsafeNoValidate !== true && !isFullValidator(ctx.validate)) validators.push(defaultValidate);
  if (ctx.validate !== undefined) validators.push(ctx.validate);
  if (typeof principal !== "string" || !principal) throw bad("validation", "principal is required");
  // batch_id hashes `principal:key`; with no ':' in a principal the pair is unambiguous (principal 'a:b' + key 'c' is not 'a' + 'b:c').
  if (principal.includes(":")) throw bad("validation", "principal must not contain ':'");
  if (!ORIGINS.includes(origin)) throw bad("validation", "origin is not a known origin");
  if (onBehalfOf !== undefined && (typeof onBehalfOf !== "string" || !onBehalfOf)) throw bad("validation", "onBehalfOf must be a string");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) throw new SyncError(428, "idempotency_key_required", "an Idempotency-Key is required");
  const ops = normaliseOps(req.ops);
  if (extra !== undefined && !isObj(extra)) throw bad("validation", "extra must be a transaction fragment");
  const expectedKeys = normaliseExpected(expected);

  const batchId = batchIdFor(principal, idempotencyKey);
  let requestHash;
  try {
    requestHash = sha256(canonicalJson(JSON.parse(JSON.stringify({ origin, on_behalf_of: onBehalfOf ?? null, ops: ops.map(wire), extra: extra ?? null }))));
  } catch {
    throw bad("validation", "the batch is not canonical JSON");
  }
  const store = { ddb, cmds, table };

  const replay = (receipt) => {
    if (receipt.request_hash !== requestHash) throw new SyncError(422, "idempotency_key_reused", "that Idempotency-Key was used with a different request");
    return { batch_id: receipt.batch_id, seq_from: receipt.seq_from, seq_to: receipt.seq_to, results: receipt.results, replayed: true };
  };

  for (let attempt = 0; ; attempt += 1) {
    // 1. The idempotency receipt, then the gate on the freshly read SYNC#HEAD. A replay of a committed batch writes nothing, so a
    //    client that lost the response gets the stored body even while writes are paused (sync design D23). Provisional: io may
    //    prefer the pause to refuse replays too; swap these two steps.
    const headItemNow = await getSyncHead(store);
    const receipt = await getBatchReceipt(store, batchId);
    if (receipt) return replay(receipt);
    checkStoreGate(headItemNow, origin);

    // 2. Read the view: the head of every object and the GID item of every id the batch touches.
    const heads = new Map();
    await Promise.all(ops.filter((o) => o.op !== "marker").map(async (o) => heads.set(`${o.class}#${o.handle}`, await getRecordItem(store, o.class, o.handle))));
    const gidWanted = new Map();
    for (const o of ops) {
      if (o.op === "marker" || o.class === "Tag") continue;
      const item = heads.get(`${o.class}#${o.handle}`);
      if (o.gramps_id) gidWanted.set(gidId(o.class, o.gramps_id), [o.class, o.gramps_id]);
      if (item && item.deleted !== true && item.gramps_id) gidWanted.set(gidId(o.class, item.gramps_id), [o.class, item.gramps_id]);
    }
    const gids = new Map();
    await Promise.all([...gidWanted].map(async ([key, [cls, id]]) => gids.set(key, await getGid(store, cls, id))));

    // 3. Validate on this view (it is re-run on the refreshed view after a lost race), then check versions and ids.
    if (validators.length) {
      const readOnly = { now, prefetched: heads };
      const view = {
        ops: ops.map(wire),
        origin,
        principal,
        on_behalf_of: onBehalfOf,
        sync_head: headItemNow ? { seq: headItemNow.seq ?? 0, tree_id: headItemNow.tree_id, live_heads: headItemNow.live_heads } : undefined,
        record: (cls, handle) => parseHead(heads.get(`${cls}#${handle}`)),
        store: ctx.storeView ? ctx.storeView(store, readOnly) : createStoreView(store, readOnly),
        stepUp: stepUp === true,
        expected: (cls, handle) => expectedKeys.has(`${cls}#${handle}`),
      };
      for (const validate of validators) await validate(view);
    }
    const versions = checkVersions(ops, heads);
    const plan = planGids(ops, heads, headItemNow, gids);

    // 4. Build the transaction.
    const nowMs = now();
    const at = iso(nowMs);
    const seqFrom = (headItemNow?.seq ?? 0) + 1;
    const seqTo = seqFrom + ops.length - 1;
    const ident = { at, batch_id: batchId };
    const puts = [];
    const deletes = [];
    const results = [];
    const changes = [];
    const before = [];
    const after = [];
    let liveDelta = 0; // the change in live heads, for SYNC#HEAD.live_heads
    let destructive = 0; // deletes and withdraws, for the budget counter
    ops.forEach((op, i) => {
      const seq = seqFrom + i;
      if (op.op === "marker") {
        puts.push({ item: logItem({ seq, batch_id: batchId, op: "marker", reason: op.reason, marker: op.ref ? { ref: op.ref } : undefined, principal, origin, on_behalf_of: onBehalfOf, at }), condition: "attribute_not_exists(PK)", tag: "sync:log" });
        results.push({ op_id: op.op_id, op: "marker", seq });
        return;
      }
      const prev = heads.get(`${op.class}#${op.handle}`);
      const version = versions[i];
      const live = op.op === "create" || op.op === "update";
      if (op.op === "create") liveDelta += 1; // a create is over no head or over a tombstone (checkVersions)
      else if (!live) {
        liveDelta -= 1;
        destructive += 1;
      }
      const grampsId = live ? op.gramps_id : prev.gramps_id;
      const fields = { class: op.class, handle: op.handle, gramps_id: grampsId, version, seq, deleted: !live, objJson: live ? op.objJson : null, blob: op.blob, reason: live ? undefined : op.reason, at, by: principal, origin };
      const cond =
        !prev
          ? { condition: "attribute_not_exists(PK)" }
          : op.op === "create"
            ? { condition: "#d = :t AND #v = :b", names: { "#d": "deleted", "#v": "version" }, values: { ":t": true, ":b": prev.version } }
            : { condition: "#d = :f AND #v = :b", names: { "#d": "deleted", "#v": "version" }, values: { ":f": false, ":b": prev.version } };
      puts.push({ item: headItem(fields), ...cond, tag: `sync:rec:${i}` });
      puts.push({
        item: logItem({ seq, batch_id: batchId, op: op.op, class: op.class, handle: op.handle, gramps_id: grampsId, version, base_version: op.base_version, objJson: fields.objJson, reason: fields.reason, principal, origin, on_behalf_of: onBehalfOf, at }),
        condition: "attribute_not_exists(PK)",
        tag: "sync:log",
      });
      results.push({ op_id: op.op_id, class: op.class, handle: op.handle, version, seq, gramps_id: grampsId });
      changes.push({
        op_id: op.op_id, op: op.op, class: op.class, handle: op.handle, gramps_id: grampsId, version, base_version: op.base_version, seq,
        before: prev && prev.deleted !== true && prev.obj_json != null ? JSON.parse(prev.obj_json) : null,
        after: live ? op.obj : null,
      });
      before.push({ class: op.class, handle: op.handle, version: prev ? prev.version : null });
      after.push({ class: op.class, handle: op.handle, version });
    });

    for (const w of plan.writes) {
      const pc = priorCondition(w.prior);
      if (w.kind === "release") deletes.push({ key: gidDelete(w.cls, w.grampsId), ...pc, tag: `sync:gid:${w.key}` });
      else puts.push({ item: w.kind === "claim" ? gidClaimItem(w.cls, w.grampsId, w.handle, ident) : gidRetiredItem(w.cls, w.grampsId, w.handle, w.reason, ident), ...pc, tag: `sync:gid:${w.key}` });
    }
    for (const a of plan.aliases) {
      puts.push({
        item: aliasItem(a.cls, a.oldId, { handle: a.handle, current_gramps_id: a.current, reason: a.reason, batch_id: batchId, at }),
        condition: "attribute_not_exists(PK) OR #ah = :ah",
        names: { "#ah": "handle" },
        values: { ":ah": a.handle },
        tag: "sync:alias",
      });
    }
    puts.push({ item: batchItem({ batch_id: batchId, request_hash: requestHash, principal, origin, client, seq_from: seqFrom, seq_to: seqTo, results, at }), condition: "attribute_not_exists(PK)", tag: "sync:batch" });
    puts.push({
      item: {
        ...auditItem({ op: "records.batch", id: auditId(batchId), principalId: principal, at, before, after }, ctx.uid?.() ?? randomUUID(), table),
        batch_id: batchId,
        origin,
        ...(onBehalfOf !== undefined ? { on_behalf_of: onBehalfOf } : {}),
      },
      tag: "sync:audit",
    });
    // A non-empty tree whose live_heads was never counted (or holds something that is not a number) keeps it as it is (no partial count): the validator then fails closed on
    // destructive batches until the count is backfilled with the real number.
    const lh = headItemNow?.live_heads;
    const countable = typeof lh === "number" || (lh === undefined && (headItemNow?.seq ?? 0) === 0);
    const updates = [
      headUpdate(headItemNow, seqTo, at, origin, countable ? liveDelta : 0),
    ];
    if (destructive > 0) {
      updates.push(counterUpdate(budgetKey(budgetBucket(nowMs)), { count: destructive }, { ttl: Math.floor(nowMs / 1000) + BUDGET_TTL_SECONDS, ifNotExists: { entity: "syncbudget" } }));
    }

    // 5. Caller extra items and the registered contributors' items ride in the same transaction.
    const batch = { batch_id: batchId, origin, principal, on_behalf_of: onBehalfOf, at, seq_from: seqFrom, seq_to: seqTo, results: results.map((r) => ({ ...r })), changes };
    const fragments = [extra, ...(await runContributors(hooks, batch, origin))];
    const txn = { puts, deletes, updates, checks: [] };
    const ours = puts.length + deletes.length + updates.length;
    if (ours > 100) throw new SyncError(413, "batch_too_large", `the batch needs ${ours} transaction items; the limit is 100`);
    const extraUpdates = [];
    for (const f of fragments) {
      if (!f) continue;
      txn.puts.push(...(f.puts ?? []));
      txn.deletes.push(...(f.deletes ?? []));
      extraUpdates.push(...(f.updates ?? []));
      txn.checks.push(...(f.checks ?? []));
    }
    txn.updates = [...updates, ...mergeUpdates(extraUpdates)];
    assertNoDuplicateTargets(txn);
    assertTxnSize(txn);

    // 6. Commit. The token changes with seq_from, so a rebuilt item set never reuses a token (SI-28, S20).
    try {
      await transact(ddb, cmds, table, { ...txn, clientRequestToken: requestTokenFor(batchId, seqFrom) }, ctx.txnOpts);
    } catch (e) {
      // The same key committed concurrently under the same (batch_id, seq_from) token with a different timestamp: read the receipt next.
      if (e instanceof TxnTokenMismatch) {
        if (attempt >= maxSeqRetries) throw new SyncError(503, "retryable", "the store is busy; retry with the same Idempotency-Key");
        continue;
      }
      // An item over DynamoDB's 400 KB limit is not transient: never answer 503 (the client would retry the same batch for ever).
      if (e?.name === "ValidationException" && /size/i.test(e.message ?? "")) throw new SyncError(413, "batch_too_large", "the batch holds an item larger than the store allows");
      if (!(e instanceof TxnCancelled)) throw e;
      if (!e.conditionFailed && e.reasons.includes("ValidationError")) throw new SyncError(413, "batch_too_large", "the batch holds an item larger than the store allows");
      if (e.conditionFailed) {
        const tags = e.failures.map((f) => f.tag);
        const ours = tags.filter((t) => typeof t === "string" && t.startsWith("sync:"));
        if (ours.length === 0) throw e; // a caller's own extra item: theirs to map
        if (ours.includes("sync:batch")) continue; // the same key committed concurrently: the receipt is read next round
        if (attempt >= maxSeqRetries) throw new SyncError(503, "retryable", "the store is busy; retry with the same Idempotency-Key");
        continue; // a lost seq race or a changed head or GID: re-read, re-validate, and report a real conflict from the fresh view
      }
      throw new SyncError(503, "retryable", "the store is busy; retry with the same Idempotency-Key");
    }

    // 7. Committed: after-commit hooks run once, and never fail the write.
    const info = { batch_id: batchId, origin, seq_from: seqFrom, seq_to: seqTo };
    for (const fn of hooks.afterCommitHooks()) {
      try {
        await fn({ ...info });
      } catch (e) {
        log.warn?.("after_commit_failed", logSafeError(e, { route: "applyBatch" }));
      }
    }
    return { batch_id: batchId, seq_from: seqFrom, seq_to: seqTo, results, replayed: false };
  }
}

/**
 * The SYNC#HEAD update. Its condition pins the seq AND the gate state that was read (writes_enabled, and seeded for a non-seed
 * origin), so a pause or an un-seed between the gate check and the commit fails the transaction; the retry re-reads and re-gates.
 */
function headUpdate(headItemNow, seqTo, at, origin, liveDelta = 0) {
  const key = headKey();
  const names = { "#s": "seq", "#u": "updated_at" };
  const values = { ":to": seqTo, ":at": at };
  if (liveDelta !== 0) {
    names["#lh"] = "live_heads";
    values[":lh"] = liveDelta;
  }
  const base = { key, update: liveDelta !== 0 ? "SET #s = :to, #u = :at ADD #lh :lh" : "SET #s = :to, #u = :at", tag: "sync:head" };
  if (!headItemNow) return { ...base, condition: "attribute_not_exists(PK)", names, values };
  const pins = [];
  if (headItemNow.seq === undefined) pins.push("attribute_not_exists(#s)");
  else {
    pins.push("#s = :old");
    values[":old"] = headItemNow.seq;
  }
  names["#we"] = "writes_enabled";
  if (headItemNow.writes_enabled === undefined) pins.push("attribute_not_exists(#we)");
  else {
    pins.push("#we = :we");
    values[":we"] = headItemNow.writes_enabled;
  }
  if (origin !== "seed") {
    names["#sd"] = "seeded";
    pins.push("#sd = :sd");
    values[":sd"] = true;
  }
  return { ...base, condition: pins.join(" AND "), names, values };
}

/** The set of "Class#handle" keys of a request's `expected` list: {class, handle} objects or "Class#handle" strings. */
function normaliseExpected(expected) {
  const keys = new Set();
  if (expected === undefined) return keys;
  if (!Array.isArray(expected)) throw bad("validation", "expected must be an array");
  for (const e of expected) {
    if (typeof e === "string" && /^[A-Za-z]+#.+$/.test(e)) keys.add(e);
    else if (isObj(e) && CLASSES.includes(e.class) && typeof e.handle === "string" && e.handle) keys.add(`${e.class}#${e.handle}`);
    else throw bad("validation", "expected holds {class, handle} entries");
  }
  return keys;
}

async function runContributors(hooks, batch, origin) {
  const out = [];
  for (const fn of hooks.contributors()) {
    const f = await fn(structuredClone(batch), origin);
    if (f === undefined || f === null) continue;
    if (!isObj(f)) throw new TypeError("a contributor returns a transaction fragment or nothing");
    out.push(f);
  }
  return out;
}

/** One transaction may not touch an item twice (DynamoDB rejects it): a clash between our items, a caller's and a contributor's is a bug. */
function assertNoDuplicateTargets(txn) {
  const seen = new Set();
  const keys = [
    ...txn.puts.map((p) => p.item),
    ...txn.deletes.map((d) => d.key ?? d),
    ...txn.updates.map((u) => u.key),
    ...txn.checks.map((c) => c.key),
  ];
  for (const k of keys) {
    const id = keyId(k);
    if (seen.has(id)) throw Object.assign(new TypeError("a transaction item targets one key twice"), { code: "txn_duplicate_key" });
    seen.add(id);
  }
}
