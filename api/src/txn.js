// DynamoDB helpers. `cmds` is the lib-dynamodb command-class bag (injected so tests never touch the network).
import { randomUUID } from "node:crypto";
import { auditKeys, gsiAudit } from "./keys.js";

/** Builds the D-15 AUDIT# item {op, id, principal, at, before, after}. */
export function auditItem(entry, uid, table) {
  const sk = `${entry.at}#${uid}`;
  return {
    ...auditKeys(entry.id ?? entry.commentId, sk),
    GSI1PK: gsiAudit,
    GSI1SK: sk,
    entity: "audit",
    op: entry.op,
    id: entry.id ?? entry.commentId,
    principal: entry.principalId,
    at: entry.at,
    before: entry.before,
    after: entry.after,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

const hasKeys = (o) => o && Object.keys(o).length > 0;
const conditionOf = (c) => ({
  ...(c.condition ? { ConditionExpression: c.condition } : {}),
  ...(hasKeys(c.names) ? { ExpressionAttributeNames: c.names } : {}),
  ...(hasKeys(c.values) ? { ExpressionAttributeValues: c.values } : {}),
});

/** DynamoDB allows at most 100 actions in one TransactWriteItems call. */
export const MAX_TXN_ITEMS = 100;
/** Jittered backoff before retry 1, 2 and 3 of a TransactionConflict (milliseconds, before jitter). */
export const CONFLICT_BACKOFF_MS = [20, 60, 150];

/**
 * Throws when a transaction would hold more than 100 actions. `items` is an array (the TransactItems), a count, or a
 * `{ puts, deletes, updates, checks }` fragment set. A programming error, not a runtime condition: callers size their batches.
 */
export function assertTxnSize(items) {
  const n =
    typeof items === "number"
      ? items
      : Array.isArray(items)
        ? items.length
        : ["puts", "deletes", "updates", "checks"].reduce((a, k) => a + (items?.[k]?.length ?? 0), 0);
  if (n > MAX_TXN_ITEMS) throw Object.assign(new RangeError(`transaction has ${n} items; the limit is ${MAX_TXN_ITEMS}`), { code: "txn_too_large" });
  return n;
}

/**
 * Maps the CancellationReasons of a TransactionCanceledException to per-item failure codes, by item index (the order of
 * TransactItems: puts, deletes, updates, checks). Only codes are read: a reason's Message and Item (which holds the old item
 * under ReturnValuesOnConditionCheckFailure=ALL_OLD) are never copied out, so nothing from the stored data can reach a log.
 *   codes:       one DynamoDB code per item ("None" for an item that did not fail)
 *   failures:    [{ index, code, tag? }] for the items that did fail; `tag` is the optional `tag` the caller put on that item
 *   failedIndex: index of the first failure, or -1
 *   kind:        "condition" (some ConditionalCheckFailed), "conflict" (every failure is a TransactionConflict: retryable) or
 *                "other" (throttling, size limit, validation, and a cancellation that carries no reasons at all: that is the
 *                store misbehaving, not a user-visible conflict, so the callers answer 503 unavailable rather than 409)
 */
export function mapCancellationReasons(error, tags = []) {
  const raw = Array.isArray(error?.CancellationReasons) ? error.CancellationReasons : [];
  const codes = raw.map((r) => (typeof r?.Code === "string" && /^\w{1,64}$/.test(r.Code) ? r.Code : "None"));
  const failures = [];
  codes.forEach((code, index) => {
    if (code !== "None") failures.push({ index, code, ...(tags[index] !== undefined ? { tag: tags[index] } : {}) });
  });
  let kind = "other";
  if (failures.some((f) => f.code === "ConditionalCheckFailed")) kind = "condition";
  else if (failures.length > 0 && failures.every((f) => f.code === "TransactionConflict")) kind = "conflict";
  return { codes, failures, failedIndex: failures.length ? failures[0].index : -1, kind };
}

/**
 * Thrown by transact() for a cancelled transaction. Carries codes and indexes only (see mapCancellationReasons); the message is
 * fixed text, so logging it can never leak stored data. `busy` is true when retries ran out on TransactionConflict only
 * (map to 503 busy); `conditionFailed` is true for a failed condition (map to 409). Neither: throttling or similar (503).
 */
export class TxnCancelled extends Error {
  constructor(info, attempts) {
    super("transaction cancelled");
    this.name = "TxnCancelled";
    this.code = info.kind === "conflict" ? "busy" : info.kind === "condition" ? "conflict" : "unavailable";
    this.reasons = info.codes;
    this.failures = info.failures;
    this.failedIndex = info.failedIndex;
    this.kind = info.kind;
    this.attempts = attempts;
  }

  get busy() {
    return this.kind === "conflict";
  }

  get conditionFailed() {
    return this.kind === "condition";
  }
}

/**
 * Thrown by transact() when DynamoDB rejects a caller-supplied ClientRequestToken that was already used for a different request
 * (IdempotentParameterMismatchException). A caller bug, not a runtime condition: fixed message and code, nothing from the store.
 */
export class TxnTokenMismatch extends Error {
  constructor() {
    super("clientRequestToken was already used for a different transaction");
    this.name = "TxnTokenMismatch";
    this.code = "token_mismatch";
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomic write: puts, deletes, updates and condition checks in one TransactWriteItems call (the audit item rides in the same call).
 *   puts:    `{ item, condition?, names?, values?, tag? }`
 *   deletes: a bare key `{PK, SK}` or `{ key, condition?, names?, values?, tag? }`
 *   updates: `{ key, update, condition?, names?, values?, tag? }`  (`update` is an UpdateExpression; build counters with counterUpdate)
 *   checks:  `{ key, condition, names?, values?, tag? }`            (ConditionCheck: asserts a condition on an item this call does not write)
 *   clientRequestToken: 1 to 36 characters; default a fresh UUID. Set once and reused on every retry, so DynamoDB applies a
 *   retry whose first attempt actually committed only once (10-minute window).
 * A cancellation whose reasons are only TransactionConflict is retried up to `retries` (3) times with jittered backoff and the
 * same token. ConditionalCheckFailed is never retried. Any cancellation that ends the call throws TxnCancelled. A
 * TransactionInProgressException (another request holds the same token) is retried the same way and ends as a busy TxnCancelled
 * with no reasons; an IdempotentParameterMismatchException (the token was used for a different payload) throws TxnTokenMismatch.
 * `opts`: `{ retries, sleep(ms), random(), backoff, onRetry, onBusy }` (injected by tests and by observability).
 *   onRetry({ attempt, delayMs, codes })  before each retry wait (txn_conflict_retry); attempt counts the failed attempts so far
 *   onBusy({ attempts, codes })           when retries ran out (txn_busy)
 * The hooks carry only counts and DynamoDB codes (never an item, message or key) and a throwing hook never breaks the write.
 * Returns `{ token, attempts }`.
 */
export async function transact(ddb, cmds, table, { puts = [], deletes = [], updates = [], checks = [], clientRequestToken } = {}, opts = {}) {
  const { retries = 3, sleep = sleepMs, random = Math.random, backoff = CONFLICT_BACKOFF_MS, onRetry, onBusy } = opts;
  const hook = (fn, info) => {
    try {
      fn?.(info);
    } catch {
      // observability must never fail a write
    }
  };
  const entries = [
    ...puts.map((p) => [{ Put: { TableName: table, Item: p.item, ...conditionOf(p) } }, p.tag]),
    ...deletes.map((d) => [{ Delete: { TableName: table, Key: d.key ?? d, ...(d.key ? conditionOf(d) : {}) } }, d.key ? d.tag : undefined]),
    ...updates.map((u) => [{ Update: { TableName: table, Key: u.key, UpdateExpression: u.update, ...conditionOf(u) } }, u.tag]),
    ...checks.map((c) => [{ ConditionCheck: { TableName: table, Key: c.key, ConditionExpression: c.condition, ...conditionOf({ ...c, condition: undefined }) } }, c.tag]),
  ];
  const TransactItems = entries.map(([item]) => item);
  const tags = entries.map(([, tag]) => tag);
  assertTxnSize(TransactItems);
  const token = clientRequestToken ?? randomUUID();
  if (typeof token !== "string" || token.length < 1 || token.length > 36) throw new TypeError("clientRequestToken must be 1 to 36 characters");
  for (let attempt = 0; ; attempt += 1) {
    let info;
    try {
      await ddb.send(new cmds.TransactWriteCommand({ TransactItems, ClientRequestToken: token }));
      return { token, attempts: attempt + 1 };
    } catch (e) {
      if (e?.name === "IdempotentParameterMismatchException") throw new TxnTokenMismatch();
      if (e?.name === "TransactionInProgressException") info = { codes: [], failures: [], failedIndex: -1, kind: "conflict" };
      else if (e?.name === "TransactionCanceledException") info = mapCancellationReasons(e, tags);
      else throw e;
    }
    if (info.kind !== "conflict" || attempt >= retries) {
      const cancelled = new TxnCancelled(info, attempt + 1);
      if (cancelled.busy) hook(onBusy, { attempts: attempt + 1, codes: info.codes });
      throw cancelled;
    }
    const base = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
    const delayMs = Math.round(base * (0.5 + random() / 2));
    hook(onRetry, { attempt: attempt + 1, delayMs, codes: info.codes });
    await sleep(delayMs);
  }
}

// ---- Update builders -------------------------------------------------------------------------------------------------
// Placeholder prefixes #cnt<i>/:cnt<i> (ADD deltas), #cs<i>/:cs<i> (SET if_not_exists) and #ttl/:ttl belong to counterUpdate;
// a caller's own condition placeholders must not use them.

function buildCounter(key, adds, ifNotExists, ttl, cond) {
  // DynamoDB rejects an expression with two actions on one path, and the fake store does not model it, so refuse it here.
  const paths = [...Object.keys(adds), ...Object.keys(ifNotExists), ...(ttl !== undefined ? ["ttl"] : [])];
  const dup = paths.find((a, i) => paths.indexOf(a) !== i);
  if (dup !== undefined) throw new TypeError(`counterUpdate: attribute ${dup} is targeted by more than one action (delta, ifNotExists, ttl)`);
  const names = {};
  const values = {};
  const addParts = [];
  Object.entries(adds).forEach(([attr, delta], i) => {
    names[`#cnt${i}`] = attr;
    values[`:cnt${i}`] = delta;
    addParts.push(`#cnt${i} :cnt${i}`);
  });
  const setParts = [];
  Object.entries(ifNotExists).forEach(([attr, v], i) => {
    names[`#cs${i}`] = attr;
    values[`:cs${i}`] = v;
    setParts.push(`#cs${i} = if_not_exists(#cs${i}, :cs${i})`);
  });
  if (ttl !== undefined) {
    names["#ttl"] = "ttl";
    values[":ttl"] = ttl;
    setParts.push("#ttl = if_not_exists(#ttl, :ttl)");
  }
  const update = [setParts.length ? `SET ${setParts.join(", ")}` : "", addParts.length ? `ADD ${addParts.join(", ")}` : ""].filter(Boolean).join(" ");
  return {
    key,
    update,
    names: { ...(cond?.names ?? {}), ...names },
    values: { ...(cond?.values ?? {}), ...values },
    ...(cond?.condition ? { condition: cond.condition } : {}),
    ...(cond?.tag !== undefined ? { tag: cond.tag } : {}),
    counter: { adds: { ...adds }, ifNotExists: { ...ifNotExists }, ttl, cond: cond ? { ...cond } : undefined },
  };
}

/**
 * An Update item that adds deltas to numeric attributes: `ADD #n :d, ...`, creating the item and the attributes when absent.
 * `deltas` maps attribute name to a number (negative to decrement). Options: `ttl` => `SET #ttl = if_not_exists(#ttl, :ttl)`
 * (the first writer's expiry stands); `ifNotExists` => `SET <attr> = if_not_exists(<attr>, <value>)` per entry (for example a
 * first-seen timestamp); `condition`/`names`/`values`/`tag` ride along. The result is a transact() `updates` entry; the `counter`
 * member (not sent to DynamoDB) is what mergeUpdates reads to sum deltas.
 */
export function counterUpdate(key, deltas, { ttl, ifNotExists = {}, condition, names, values, tag } = {}) {
  const adds = Object.fromEntries(Object.entries(deltas ?? {}).filter(([, d]) => d !== undefined));
  for (const [attr, d] of Object.entries(adds)) if (typeof d !== "number" || !Number.isFinite(d)) throw new TypeError(`delta for ${attr} must be a finite number`);
  if (Object.keys(adds).length === 0) throw new TypeError("counterUpdate needs at least one delta");
  const cond = condition || names || values || tag !== undefined ? { condition, names, values, tag } : undefined;
  return buildCounter(key, adds, ifNotExists, ttl, cond);
}

/** JSON with object keys sorted, so two structurally equal condition fragments compare equal whatever order they were built in. */
const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * One transaction may not touch an item twice, so updates that target the same key are folded into one: ADD deltas on the same
 * attribute are summed, if_not_exists values keep the first, the first ttl stands. Only counterUpdate results merge; two other
 * updates on one key, or two with a different condition, names, values or tag, throw (the caller must combine them). The
 * comparison ignores key order. Order of first appearance is kept.
 */
export function mergeUpdates(updates) {
  const out = new Map();
  for (const u of updates) {
    const id = JSON.stringify([u.key.PK, u.key.SK]);
    const prev = out.get(id);
    if (!prev) {
      out.set(id, u);
      continue;
    }
    if (!prev.counter || !u.counter) throw new Error("mergeUpdates: two non-counter updates target one key");
    const same = (a, b) => stable([a.condition, a.names, a.values, a.tag]) === stable([b.condition, b.names, b.values, b.tag]);
    const pc = prev.counter.cond ?? {};
    const uc = u.counter.cond ?? {};
    if (!same(pc, uc)) throw new Error("mergeUpdates: updates on one key carry different conditions");
    const adds = { ...prev.counter.adds };
    for (const [attr, d] of Object.entries(u.counter.adds)) adds[attr] = (adds[attr] ?? 0) + d;
    const ifNotExists = { ...u.counter.ifNotExists, ...prev.counter.ifNotExists };
    out.set(id, buildCounter(prev.key, adds, ifNotExists, prev.counter.ttl ?? u.counter.ttl, prev.counter.cond));
  }
  return [...out.values()];
}

/**
 * Optimistic-concurrency guard on a stored record's version field (`<doc>.<field>` inside the item).
 * `prev` undefined => the field must still be absent (e.g. a never-edited comment). Combined with attribute_exists(PK).
 */
export function versionGuard(doc, field, prev) {
  const names = { "#doc": doc, "#ver": field };
  return prev === undefined
    ? { condition: "attribute_exists(PK) AND attribute_not_exists(#doc.#ver)", names }
    : { condition: "attribute_exists(PK) AND #doc.#ver = :prev", names, values: { ":prev": prev } };
}

/** Pages a Query newest-first (or oldest-first) until `want` rows pass `accept`, or the partition is exhausted. */
export async function queryPartition(ddb, cmds, table, { pk, after, forward = false, accept, want }) {
  const out = [];
  let lastKey;
  for (let i = 0; i < 50; i += 1) {
    const r = await ddb.send(
      new cmds.QueryCommand({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: after ? `GSI1PK = :pk AND GSI1SK ${forward ? ">" : "<"} :after` : "GSI1PK = :pk",
        ExpressionAttributeValues: after ? { ":pk": pk, ":after": after } : { ":pk": pk },
        ScanIndexForward: forward,
        Limit: 100,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      if (accept(item)) out.push(item);
      if (out.length >= want) return out;
    }
    lastKey = r.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return out;
}
