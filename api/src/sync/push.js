// HFY-TSK-173 (sync-push-routes; sync.md 7.2, BRD2 11.1 7.2): the desktop push routes behind the sync-bearer middleware (guard.js).
//
//   POST /api/sync/sessions                open a multi-batch push (the seed, a large edit). One session is open at a time.
//   POST /api/sync/sessions/:id/complete   close it: the whole session's references resolve and its person-family links are symmetric, then a
//                                          `marker` log entry (which wakes the renderer); the first session after bind also sets SYNC#HEAD.seeded.
//   POST /api/sync/sessions/:id/abort      close an abandoned session (owner bearer, audited). Objects already pushed stay: every batch is atomic.
//   POST /api/sync/batches                 push ops through applyBatch(), origin `desktop` (origin `seed` inside the seed session)
//   POST /api/sync/media/presign           blob upload (media.js)
//
// Notifications: none is produced in the request. A batch writes the change log; the renderer's outbox is the only source of record-change
// notifications, and it recognises seed batches by their origin (silent). The one hook point is applyBatch's afterCommit registry, called once
// per committed batch with origin "desktop" (or "seed"), never for a replay.
import { HttpError, logSafeError } from "../http.js";
import { TxnCancelled, auditItem, transact } from "../txn.js";
import { applyBatch } from "./apply.js";
import { CLASSES, SESSION_TTL_SECONDS, batchIdFor, getBatchReceipt, getRecordItem, getSession, headKey, logKey, sessionKey } from "./store.js";
import { checkIntegrity } from "./validator.js";
import { createStoreView } from "./view.js";
import { HANDLE_SHAPE } from "../records/ops.js";
import { finalizeBlobs, prepareBlobs } from "./media.js";

const ok = (body, status = 200, headers) => ({ status, body, ...(headers ? { headers } : {}) });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (field, message) => new HttpError(400, "validation", message ?? `${field} is invalid`, { fields: [{ field, code: "invalid" }] });
const retryable = () => new HttpError(503, "retryable", "the store is busy; retry with the same Idempotency-Key");

/** The most handles a session can announce: the session item carries them and DynamoDB items stop at 400 KB. */
export const MAX_EXPECTED = 8000;
/** Pages of SYNC#LOG that completing a session reads (1 MB each) before it gives up. */
const MAX_LOG_PAGES = 400;
const SESSION_ID = /^[0-9A-Za-z]{10,40}$/;
const EXPECTED_ENTRY = /^([A-Za-z]+)#(.+)$/;
const THROTTLED = new Set(["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "InternalServerError", "ServiceUnavailable", "TimeoutError", "RequestTimeout", "TransactionInProgressException"]);

/**
 * Wraps a route handler so a throttled or failing store read (S08) answers 503 retryable instead of 500: every push route is safe to retry with
 * the same Idempotency-Key, and a batch is atomic. An HttpError passes through; so does a TxnCancelled, which the routes map themselves.
 */
const guarded = (fn) => async (c) => {
  try {
    return await fn(c);
  } catch (e) {
    if (e instanceof HttpError || e instanceof TxnCancelled) throw e;
    const status = e?.$metadata?.httpStatusCode;
    if (THROTTLED.has(e?.name) || e?.$retryable || (Number.isInteger(status) && status >= 500)) {
      c.log?.warn?.("sync store busy", logSafeError(e, { route: "sync.push" }));
      throw retryable();
    }
    throw e;
  }
};

const iso = (ms) => new Date(ms).toISOString();
const expiresAt = (openedAt) => iso(Date.parse(openedAt) + SESSION_TTL_SECONDS * 1000);

/** "open" | "complete" | "aborted" | "expired" (an open session past opened_at + 7 d counts as expired without waiting for the TTL delete). */
export function sessionState(item, nowMs) {
  if (!item) return "missing";
  if (item.state === "open") return Date.parse(item.opened_at) + SESSION_TTL_SECONDS * 1000 <= nowMs ? "expired" : "open";
  return item.state === "complete" || item.state === "aborted" ? item.state : "expired";
}

const sessionId = (c) => {
  const id = c.params.id;
  if (!SESSION_ID.test(id)) throw new HttpError(404, "session_not_found", "no such push session");
  return id;
};
async function loadSession(c, id) {
  const item = await getSession(c.sync.store, id);
  if (!item) throw new HttpError(404, "session_not_found", "no such push session");
  return item;
}
const sessionDetails = (item) => ({ session_id: item.session_id, opened_at: item.opened_at, expires_at: expiresAt(item.opened_at), seed: item.seed === true });
const closed = (item, state) => new HttpError(409, state === "expired" ? "session_expired" : "session_closed", `this push session is ${state}`, { session_id: item.session_id, state });

function expectedList(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad("expected", "expected must be an array of \"Class#handle\" strings");
  if (raw.length > MAX_EXPECTED) throw new HttpError(413, "batch_too_large", `a session announces at most ${MAX_EXPECTED} objects`);
  const seen = new Set();
  for (const e of raw) {
    const m = typeof e === "string" ? EXPECTED_ENTRY.exec(e) : null;
    if (!m || !CLASSES.includes(m[1]) || !HANDLE_SHAPE.test(m[2])) throw bad("expected", "expected holds \"Class#handle\" strings");
    seen.add(e);
  }
  return [...seen];
}

const sessionAudit = (c, op, id, at, before, after) =>
  auditItem({ op, id: `sync:session:${id}`, principalId: c.actor.id, at, before, after }, c.sync.store.uid(), c.sync.store.table);

// ---- sessions -------------------------------------------------------------------------------------------------------

/**
 * POST /api/sync/sessions {expected?: ["Class#handle", ...]}. 201 {session_id, expires_at, seed}. 409 not_bound before a bind, 409 session_open
 * (details: the open session's id, opened_at, expires_at, seed) while another is open and unexpired. The first session while the store is not
 * seeded has seed true: its batches carry origin "seed" and are silent. A pointer to a session that is closed or expired is replaced.
 */
export const sessionsOpen = guarded(async (c) => {
  c.sync.checkTree();
  const { head, store } = c.sync;
  if (!head?.tree_id || !head.bound) throw new HttpError(409, "not_bound", "bind the tree before opening a push session");
  const expected = expectedList(c.body.expected);
  const nowMs = store.now();
  let stale;
  if (head.open_session) {
    const cur = await getSession(store, head.open_session);
    if (sessionState(cur, nowMs) === "open") throw new HttpError(409, "session_open", "a push session is already open", sessionDetails(cur));
    stale = head.open_session;
  }
  const at = iso(nowMs);
  const id = store.uid();
  const seed = head.seeded !== true;
  const item = {
    ...sessionKey(id), entity: "syncsession", session_id: id, state: "open", seed, expected, opened_at: at, start_seq: Number.isInteger(head.seq) ? head.seq : 0,
    principal: c.actor.id, client: c.sync.handshake.client, ttl: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
  };
  try {
    await transact(store.ddb, store.cmds, store.table, {
      puts: [
        { item, condition: "attribute_not_exists(PK)", tag: "session:put" },
        { item: sessionAudit(c, "sync.session.open", id, at, null, { session_id: id, seed, expected: expected.length }), tag: "session:audit" },
      ],
      updates: [{
        key: headKey(), update: "SET #os = :id, #u = :at", tag: "session:head",
        condition: stale ? "attribute_exists(PK) AND #os = :prev" : "attribute_exists(PK) AND attribute_not_exists(#os)",
        names: { "#os": "open_session", "#u": "updated_at" }, values: { ":id": id, ":at": at, ...(stale ? { ":prev": stale } : {}) },
      }],
    }, store.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) throw new HttpError(409, "session_open", "a push session is already open");
    if (e instanceof TxnCancelled) throw retryable();
    throw e;
  }
  return ok({ session_id: id, expires_at: expiresAt(at), seed }, 201);
});

/** The session's own log entries: the latest per object since the session opened, as heads and as ops for the integrity check. */
async function sessionChanges(store, session) {
  const latest = new Map();
  let startKey;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const r = await store.ddb.send(new store.cmds.QueryCommand({
      TableName: store.table, KeyConditionExpression: "PK = :pk AND SK > :sk", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": logKey(0).PK, ":sk": logKey(session.start_seq ?? 0).SK }, ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const e of r.Items ?? []) if (e.class && ["create", "update", "delete", "withdraw"].includes(e.op)) latest.set(`${e.class}#${e.handle}`, e);
    startKey = r.LastEvaluatedKey;
    if (!startKey) {
      const prefetched = new Map();
      const ops = [];
      let n = 0;
      for (const [key, e] of latest) {
        const live = e.op === "create" || e.op === "update";
        prefetched.set(key, {
          PK: `REC#${e.class}#${e.handle}`, SK: "HEAD", class: e.class, handle: e.handle, gramps_id: e.gramps_id, version: e.version, seq: e.seq, deleted: !live,
          obj_json: live ? e.obj_json : null, hash: e.hash ?? null, origin: e.origin, updated_at: e.at, ...(e.reason !== undefined ? { reason: e.reason } : {}),
        });
        n += 1;
        ops.push(live ? { op_id: String(n), op: "update", class: e.class, handle: e.handle, obj: JSON.parse(e.obj_json) } : { op_id: String(n), op: e.op, class: e.class, handle: e.handle });
      }
      return { prefetched, ops };
    }
  }
  throw new HttpError(413, "batch_too_large", "this session is too large to verify in one call");
}

/**
 * The session's integrity check: every reference of every object it wrote resolves (the announced handles no longer count, they must exist now)
 * and every person-family link is symmetric. 422 integrity_violation (or withdrawn_reference) with {violations: [{rule, class, handle, pointer}]}.
 */
async function verifySession(c, session) {
  const { store } = c.sync;
  const { prefetched, ops } = await sessionChanges(store, session);
  if (ops.length === 0) return;
  const view = { ops, origin: "desktop", store: createStoreView(store, { now: store.now, prefetched }), expected: () => false };
  await checkIntegrity(view, ops, ops.filter((o) => o.op === "update"), true);
}

/**
 * POST /api/sync/sessions/:id/complete. 200 {seq} (the marker's seq). Idempotent: a session already complete answers the same seq. 422
 * integrity_violation when the session leaves a dangling reference or a half-linked relationship. 404 session_not_found; 409 session_closed
 * (aborted) or session_expired. The marker batch carries the session's origin, so the renderer sees a seed session as silent.
 */
export const sessionsComplete = guarded(async (c) => {
  c.sync.checkTree();
  const { store } = c.sync;
  const id = sessionId(c);
  const session = await loadSession(c, id);
  const state = sessionState(session, store.now());
  if (state !== "complete" && state !== "open") throw closed(session, state);
  if (state === "open") await verifySession(c, session);
  let r;
  try {
    r = await applyBatch(batchCtx(c), {
      principal: c.actor.id, origin: session.seed === true ? "seed" : "desktop", idempotencyKey: `session-complete:${id}`,
      ops: [{ op_id: "1", op: "marker", reason: "session_complete" }], client: { agent: c.sync.handshake.client },
      // Deterministic, so a repeat of this call replays the same receipt: no timestamps in `extra`.
      extra: { updates: [{ key: sessionKey(id), update: "SET #st = :c", condition: "#st = :o", names: { "#st": "state" }, values: { ":c": "complete", ":o": "open" }, tag: "session:state" }] },
    });
  } catch (e) {
    throw sessionRace(e, session) ?? e;
  }
  // Closing the head is not part of the marker's transaction (applyBatch owns SYNC#HEAD's update). Both writes are idempotent, so a failure
  // here is a 503 the client retries, and the retry replays the receipt above.
  const at = iso(store.now());
  if (session.seed === true) {
    await store.ddb.send(new store.cmds.UpdateCommand({ TableName: store.table, Key: headKey(), UpdateExpression: "SET #sd = :t, #u = :at", ExpressionAttributeNames: { "#sd": "seeded", "#u": "updated_at" }, ExpressionAttributeValues: { ":t": true, ":at": at } }));
  }
  await clearOpenSession(store, id);
  return ok({ seq: r.seq_to });
});

/** REMOVE SYNC#HEAD.open_session when it still names this session. A different value (a newer session) or none is left alone. */
async function clearOpenSession(store, id) {
  try {
    await store.ddb.send(new store.cmds.UpdateCommand({
      TableName: store.table, Key: headKey(), UpdateExpression: "REMOVE #os", ConditionExpression: "#os = :id", ExpressionAttributeNames: { "#os": "open_session" }, ExpressionAttributeValues: { ":id": id },
    }));
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
  }
}

/**
 * POST /api/sync/sessions/:id/abort (owner bearer, audited: the audit item holds the opener and the aborting principal). Any gramps-owner may abort any
 * session, not only the one that opened it: there is one owner group and an abandoned session's opener may be a laptop that is gone. 200 {session_id, state: "aborted"}. Idempotent for an aborted session; an expired
 * one can be aborted too; a complete one is 409 session_closed. Nothing already pushed is undone.
 */
export const sessionsAbort = guarded(async (c) => {
  c.sync.checkTree();
  const { store } = c.sync;
  const id = sessionId(c);
  const session = await loadSession(c, id);
  const state = sessionState(session, store.now());
  if (state === "complete") throw closed(session, state);
  if (state !== "aborted") {
    const at = iso(store.now());
    try {
      await transact(store.ddb, store.cmds, store.table, {
        updates: [{ key: sessionKey(id), update: "SET #st = :a, #ab = :at, #by = :by", condition: "#st = :o", names: { "#st": "state", "#ab": "aborted_at", "#by": "aborted_by" }, values: { ":a": "aborted", ":o": "open", ":at": at, ":by": c.actor.id }, tag: "session:state" }],
        puts: [{ item: sessionAudit(c, "sync.session.abort", id, at, { state, opened_by: session.principal ?? null }, { state: "aborted" }), tag: "session:audit" }],
      }, store.txnOpts);
    } catch (e) {
      if (e instanceof TxnCancelled && e.conditionFailed) throw closed(session, "closed"); // completed or aborted by someone else a moment ago
      if (e instanceof TxnCancelled) throw retryable();
      throw e;
    }
  }
  await clearOpenSession(store, id);
  return ok({ session_id: id, state: "aborted" });
});

/** A failed `session:*` condition inside a batch transaction: the session was closed between the check and the commit. */
function sessionRace(e, session) {
  if (e instanceof TxnCancelled && e.failures.some((f) => typeof f.tag === "string" && f.tag.startsWith("session:"))) return closed(session, "closed");
  return undefined;
}

// ---- batches --------------------------------------------------------------------------------------------------------

/** The ctx applyBatch gets: the store handles plus the wiring (hooks, id policy) the handler passed in `c.sync.store`. */
function batchCtx(c) {
  const { ddb, cmds, table, now, uid, log, hooks, idPolicy, txnOpts } = c.sync.store;
  return { ddb, cmds, table, now, uid, log, ...(hooks ? { hooks } : {}), ...(idPolicy ? { idPolicy } : {}), ...(txnOpts ? { txnOpts } : {}) };
}

const idempotencyKeyOf = (event) => {
  const headers = event?.headers ?? {};
  const name = Object.keys(headers).find((k) => k.toLowerCase() === "idempotency-key");
  const v = name ? headers[name] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/**
 * POST /api/sync/batches {tree_id?, session_id?, client_run_id?, ops}, header Idempotency-Key. 200 {batch_id, seq_from, seq_to, results}; a replay
 * returns the stored body with `Idempotent-Replayed: true`. All the validation and the codes of applyBatch apply (400, 403, 409, 413, 422, 428,
 * 503); in addition 403 tree_mismatch, 404 session_not_found, 409 session_closed | session_expired, 422 blob_not_uploaded | blob_mismatch.
 */
export const batchesPush = guarded(async (c) => {
  c.sync.checkTree();
  const { head, store } = c.sync;
  const b = c.body;
  if (b.tree_id !== undefined && b.tree_id !== null) {
    if (typeof b.tree_id !== "string") throw bad("tree_id");
    if (head?.tree_id && b.tree_id !== head.tree_id) throw new HttpError(403, "tree_mismatch", "this request is for a different tree than the one bound to the cloud");
  }
  if (b.client_run_id !== undefined && b.client_run_id !== null && (typeof b.client_run_id !== "string" || b.client_run_id.length < 1 || b.client_run_id.length > 64)) throw bad("client_run_id");
  if (!Array.isArray(b.ops)) throw bad("ops", "ops must be a non-empty array");
  const key = idempotencyKeyOf(c.event);
  if (key === undefined) throw new HttpError(428, "idempotency_key_required", "an Idempotency-Key header is required");
  const principal = c.actor.id;
  const batchId = batchIdFor(principal, key);
  const receipt = await getBatchReceipt(store, batchId);

  // The session: the origin (seed inside the seed session), the announced handles, and a check inside the transaction that it is still open.
  let session;
  let origin = "desktop";
  let extra;
  let expected;
  if (b.session_id !== undefined && b.session_id !== null) {
    if (typeof b.session_id !== "string" || !SESSION_ID.test(b.session_id)) throw new HttpError(404, "session_not_found", "no such push session");
    session = await loadSession(c, b.session_id);
    origin = session.seed === true ? "seed" : "desktop";
    expected = Array.isArray(session.expected) ? session.expected : [];
    // A replay of a committed batch is answered even after its session closed (the client lost the response); a new batch is not.
    const state = sessionState(session, store.now());
    if (state !== "open" && !receipt) throw closed(session, state);
    extra = { checks: [{ key: sessionKey(session.session_id), condition: "#st = :o", names: { "#st": "state" }, values: { ":o": "open" }, tag: "session:check" }] };
    // The seed session is not a way round the step-up that deletes need from the desktop (the validator asks for it by origin).
    if (origin === "seed" && b.ops.some((o) => isObj(o) && o.op === "delete")) c.sync.requireStepUp("delete");
  }

  const plan = await prepareBlobs(store, b.ops, { head: (cls, handle) => getRecordItem(store, cls, handle), replay: Boolean(receipt) });

  let r;
  try {
    r = await applyBatch(batchCtx(c), {
      principal, origin, idempotencyKey: key, ops: b.ops, ...(extra ? { extra } : {}), ...(expected ? { expected } : {}),
      client: { agent: c.sync.handshake.client, ...(b.client_run_id ? { run_id: b.client_run_id } : {}) }, stepUp: c.sync.stepUp(),
    });
  } catch (e) {
    // A batch that passed applyBatch's bound on its own ops can still need a 101st transaction item once the session check rides along: 24
    // withdraws take 4 each (head, log, id write, scheduled expunge), so with the 3 fixed items and the budget counter they fill all 100 (23 fit
    // beside the check). Nothing was written; it is a size the client splits, never a 500.
    if (e instanceof RangeError && e.code === "txn_too_large") {
      throw new HttpError(413, "batch_too_large", "this batch and the session check need more than 100 transaction items; send fewer ops (a withdraw takes 4, so at most 23 withdraws fit in a session)");
    }
    throw (session && sessionRace(e, session)) ?? e;
  }
  if (plan.length) await finalizeBlobs(store, plan);
  const body = { batch_id: r.batch_id, seq_from: r.seq_from, seq_to: r.seq_to, results: r.results };
  return ok(body, 200, r.replayed ? { "idempotent-replayed": "true" } : undefined);
});
