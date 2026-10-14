// HFY-TSK-178 (hfy-record-change-fanout; BRD2 D2-02, D2-16, review SI-20, PS-06): the render-outbox consumer, the ONLY caller of
// notifier.onRecordChanged (test/notify-producers.test.js pins that).
//
// Record-change notifications come from one source: the SYNC#RENDERED/<seq_to> item the renderer writes in the same transaction that advances
// rendered_seq (live passes only; docs/reference/sync-render.md). The request path runs no record-change hook (applyBatch has none).
// `changed_people` there is already computed from the store's backrefs (a change to any referenced object maps to the people whose page it can
// alter), so this module does not recompute it. What it adds:
//
//   silent passes     A pass whose range holds a seed-origin entry (SYNC#SESSION.seed=true batches carry origin "seed"), a pass marked as an import, a
//                     baseline pass (the first live pass of a mode: the site simply came online) and a pass with nothing to say notify nobody and
//                     read no followers. Imports: the store has no origin or session flag for an import other than the seed session (ORIGINS in
//                     sync/store.js has no "import"; the only session whose batches are not "desktop" is the first one, SYNC#SESSION.seed=true), so
//                     today every import IS a seed session and is caught by the seed rule. BRD2 D2-16's `import:true` is honoured as well, for a
//                     later marker (item.import === true, an "import" origin, or entry.import === true), so the notifier is never reached for either.
//                     A seed entry silences the WHOLE pass on purpose: the outbox's changed_people is one union over the range, so live edits that
//                     share a range with seed batches cannot be told apart from it, and a notification storm is the worse failure (BRD2 R2-16).
//   withdraws         A withdraw is silent: the people whose page changed only because a withdrawn object left it are dropped from the subjects,
//                     and a withdrawn Person's follows (RSUB#) are deleted. Both happen even when notifications are off, because deleting a follow
//                     reduces exposure. (comments.list's 404 for a withdrawn person's thread is in comments.js.)
//   exactly once      Each subject is claimed with a conditional Put of RECFAN#<seq>/<subject> (dedupe key rec:<seq>:<subject>) before delivery and
//                     marked done after it. A redelivered outbox item, or a second consumer, finds the claim and sends nothing. A throw during
//                     delivery releases the claims so the retry sends; a hard crash between claim and done leaves a claim that expires after
//                     LEASE_MS, after which the retry delivers (at-least-once only in that window, never a duplicate while the lease holds).
//                     The notifier never throws (it is best-effort for requests), so it REPORTS: onRecordChanged returns { lost, error?, inactive? }.
//                     lost > 0 (an inbox write, a flag read or a follower lookup failed) or error gives the claims back and fails the pass, so the
//                     stream retries it (inbox items coalesce by group, so a retry of a partly delivered pass at worst raises a count). inactive (no
//                     push and no inbox configured) gives the claims back and ends the pass as "inactive" WITHOUT failing it: nothing is marked done,
//                     so an operator's replay (direct invoke) delivers once delivery is configured, and the stream does not retry in a loop.
//   chunks            A pass with more than `chunkSize` (MAX_SUBJECTS, 5000) subjects is claimed, delivered and marked done chunk by chunk; nothing is
//                     dropped. A failure in chunk k fails the pass; the retry finds chunks before k done and delivers k onward.
//   gate              Recipients are filtered by the recordSubsV1 flag (createFanoutNotifier): off for everyone but the uat group until the flip.
//
// Trigger: the API function's DynamoDB stream mapping filtered to SYNC#RENDERED inserts (infrastructure/cloudformation/app-stack.yaml), or a
// direct invoke { source: "record-fanout", seq } for a replay. Both end in processRendered(). The stream is KEYS_ONLY, so the item is read back
// (consistent) and a TTL-expired one is skipped.
import { randomUUID } from "node:crypto";
import { HttpError, logSafeError } from "./http.js";
import { createNotifier, personIdOf, MAX_SUBJECTS } from "./notify.js";
import { rsubKeys, recsubGsi } from "./subscriptions.js";
import { storeView } from "./records/index.js";
import { logKey, seqKey } from "./sync/store.js";

export const FANOUT_FLAG = "recordSubsV1";
/** How long a claim without a "done" mark blocks a retry: a crashed consumer's subjects are re-delivered after this. */
export const LEASE_MS = 120_000;
/** Claims live this long (the outbox item itself lives 400 days; a stream redelivery never reaches back further than the 24-hour stream). */
export const DEDUPE_TTL_DAYS = 35;
export const CLAIM_CONCURRENCY = 8;
/** Log pages read for one outbox item's range (100 entries per page). */
const MAX_LOG_PAGES = 400;
/** Stop claiming when less than this is left of the invocation. */
const MIN_REMAINING_MS = 2_000;

const SOURCE_OF = Object.freeze({ desktop: "gramps_sync", self: "self_edit", proposal: "proposal", admin: "admin_edit", tag: "tag", graduation: "graduation", moderation: "moderation" });
const SEQ_SK = /^\d{12}$/;

export const dedupeKey = (seq, subject) => `rec:${seq}:${subject}`;
export const markerKeys = (seq, subject) => ({ PK: `RECFAN#${seqKey(seq)}`, SK: subject });

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Like mapLimit, but waits for EVERY started worker to settle before returning, and stops starting new items after the first failure.
 * Returns one entry per item: { ok: true, value } | { ok: false, error } | undefined (never started). Nothing is in flight when it returns,
 * so a caller can undo exactly what landed.
 */
async function mapSettled(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { ok: false, error };
        failed = true;
      }
    }
  }));
  return out;
}

/**
 * Every live Person a change to any of `startKeys` ("Class:handle") can alter, from the Node store view's backrefs: the same rule as the
 * renderer's people_of (a Person maps to itself and to whatever references it; any other object maps through its referrers until people are
 * reached; a person reached from elsewhere is a result, not a hop). A withdrawn start is not live, so it maps to its referrers only.
 */
export function peopleReached(view, startKeys) {
  const out = new Set();
  const live = (k) => view.heads.get(k)?.deleted === false;
  for (const start of startKeys) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const node = queue.shift();
      const head = view.heads.get(node);
      if (head?.class === "Person" && head.deleted === false) {
        if (head.gramps_id) out.add(head.gramps_id);
        if (node !== start) continue;
      }
      for (const src of view.refs.get(node) ?? []) {
        if (seen.has(src) || !live(src)) continue;
        seen.add(src);
        queue.push(src);
      }
    }
  }
  return out;
}

/**
 * deps: { ddb, cmds, table, notifier, now?, log?, labelOf?, storeView? }
 *   notifier   createNotifier(...) (or createFanoutNotifier): onRecordChanged is called from here and nowhere else.
 *   labelOf    async (gramps_id) => display label | undefined, for the actor and the subject of a level-1 push. Failures leave the label out.
 *   storeView  async () => the Node store view (records/index.js); the default folds the log into the cached view.
 *   chunkSize  subjects per claim-deliver-done round (default and ceiling MAX_SUBJECTS); a test seam.
 */
export function createRecordFanout(deps) {
  const { ddb, cmds, table, notifier } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? console;
  const view = deps.storeView ?? (() => storeView({ ddb, cmds, table, now }));
  const chunkSize = Math.max(1, Math.min(MAX_SUBJECTS, Math.floor(deps.chunkSize ?? MAX_SUBJECTS)));

  async function getOutbox(seq) {
    const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: { PK: "SYNC#RENDERED", SK: seqKey(seq) }, ConsistentRead: true }));
    return r.Item;
  }

  /** The log entries of a pass's range, without their bodies. */
  async function readRange(from, to) {
    const out = [];
    let start;
    for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": logKey(1).PK, ":lo": seqKey(from), ":hi": seqKey(to) },
        ConsistentRead: true, ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      for (const it of r.Items ?? []) out.push({ seq: it.seq, op: it.op, class: it.class, handle: it.handle, gramps_id: it.gramps_id, principal: it.principal, origin: it.origin, import: it.import });
      start = r.LastEvaluatedKey;
      if (!start) return out;
    }
    throw new Error("fanout_range_too_long");
  }

  /** Deletes every follow of `subject` (idempotent). Returns how many were removed. */
  async function sweepFollows(gid) {
    const subject = `person:${gid}`;
    const principals = new Set();
    let key;
    for (let i = 0; i < 20; i += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": recsubGsi(subject) }, ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const it of r.Items ?? []) if (typeof it.GSI1SK === "string") principals.add(it.GSI1SK);
      key = r.LastEvaluatedKey;
      if (!key) break;
    }
    await mapLimit([...principals], CLAIM_CONCURRENCY, (p) => ddb.send(new cmds.DeleteCommand({ TableName: table, Key: rsubKeys(p, subject) })));
    return principals.size;
  }

  const claim = async (seq, subject, at, ttl, lease, owner) => {
    try {
      await ddb.send(new cmds.PutCommand({
        TableName: table,
        Item: { ...markerKeys(seq, subject), entity: "recfan", dedupe: dedupeKey(seq, subject), state: "claimed", lease_until: lease, owner, claimed_at: at, ttl },
        // A fresh claim, or the expired lease of a consumer that died between the claim and the done mark (AND binds tighter than OR).
        ConditionExpression: "attribute_not_exists(PK) OR #st = :claimed AND #lease < :now",
        ExpressionAttributeNames: { "#st": "state", "#lease": "lease_until" },
        ExpressionAttributeValues: { ":claimed": "claimed", ":now": now() },
      }));
      return true;
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  };
  // Gives back only a claim THIS call made (owner is a per-call token), so an ambiguous failed Put or a late release never deletes another consumer's claim.
  const release = (seq, subject, owner) =>
    ddb.send(new cmds.DeleteCommand({
      TableName: table, Key: markerKeys(seq, subject), ConditionExpression: "#st = :claimed AND #own = :own",
      ExpressionAttributeNames: { "#st": "state", "#own": "owner" }, ExpressionAttributeValues: { ":claimed": "claimed", ":own": owner },
    })).catch((e) => { if (e?.name !== "ConditionalCheckFailedException") log.error?.("fanout claim release failed", logSafeError(e)); });
  const done = (seq, subject, at) =>
    ddb.send(new cmds.UpdateCommand({
      TableName: table, Key: markerKeys(seq, subject), UpdateExpression: "SET #st = :done, #da = :at",
      ExpressionAttributeNames: { "#st": "state", "#da": "done_at" }, ExpressionAttributeValues: { ":done": "done", ":at": at },
    }));

  const label = async (gid) => {
    if (!deps.labelOf || !gid) return undefined;
    try {
      const l = await deps.labelOf(gid);
      return typeof l === "string" && l ? l : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Handles one SYNC#RENDERED item (the item as stored). Returns a summary of counts and a status; never includes ids or labels.
   * `remainingMs` (optional) is the invocation's remaining time: claiming stops, and the pass is retried, when it runs short.
   */
  async function processRendered(item, { remainingMs } = {}) {
    const seq = item?.seq_to;
    if (!item || item.entity !== "rendered" || !Number.isInteger(seq) || seq < 1 || !Number.isInteger(item.seq_from) || item.seq_from > seq) return { status: "invalid" };
    const changedRaw = Array.isArray(item.changed_people) ? item.changed_people : [];
    const entries = await readRange(item.seq_from, seq);
    const real = entries.filter((e) => e.op !== "marker");

    // 1. Withdraws: delete the follows of every withdrawn Person (also when notifications are off).
    const withdrawnPeople = new Set(real.filter((e) => e.op === "withdraw" && e.class === "Person" && personIdOf(`person:${e.gramps_id}`)).map((e) => e.gramps_id));
    let swept = 0;
    for (const gid of withdrawnPeople) swept += await sweepFollows(gid);

    // 2. Silent passes.
    const origins = new Set([...(Array.isArray(item.origins) ? item.origins : []), ...entries.map((e) => e.origin)]);
    const seeded = origins.has("seed");
    const imported = item.import === true || origins.has("import") || entries.some((e) => e.import === true);
    if (item.baseline === true) return { status: "silent", reason: "baseline", swept, subjects: 0 };
    if (seeded) return { status: "silent", reason: "seed", swept, subjects: 0 };
    if (imported) return { status: "silent", reason: "import", swept, subjects: 0 };

    // 3. Subjects: the outbox's changed people, minus those a withdraw alone changed.
    let subjects = [...new Set(changedRaw.filter((id) => typeof id === "string" && personIdOf(`person:${id}`)))].filter((id) => !withdrawnPeople.has(id));
    const withdraws = real.filter((e) => e.op === "withdraw" && e.class && e.handle);
    if (withdraws.length && subjects.length) {
      const v = await view(); // a failure throws: better a retry than a notification a withdraw should have silenced
      const keyOf = (e) => `${e.class}:${e.handle}`;
      const only = peopleReached(v, withdraws.map(keyOf));
      const others = peopleReached(v, real.filter((e) => e.op !== "withdraw" && e.class && e.handle).map(keyOf));
      subjects = subjects.filter((id) => !only.has(id) || others.has(id));
    }
    if (!subjects.length) return { status: "empty", swept, subjects: 0 };

    // 4. The actor is named only when exactly one principal made the range; the source from its origins.
    const principals = [...new Set(real.map((e) => e.principal).filter((p) => typeof p === "string" && p))];
    const liveOrigins = [...new Set(real.map((e) => e.origin).filter(Boolean))];
    const actorId = principals.length === 1 ? principals[0] : undefined;
    const actor = actorId ? { id: actorId, label: await label(actorId) } : null;
    const source = liveOrigins.length === 1 ? SOURCE_OF[liveOrigins[0]] ?? liveOrigins[0] : "mixed";

    // 5. and 6. Chunk by chunk: claim, deliver, mark done. A failure stops the pass; the chunks before it stay done.
    const at = new Date(now()).toISOString();
    const ttl = Math.floor(now() / 1000) + DEDUPE_TTL_DAYS * 86_400;
    let delivered = 0;
    for (let i = 0; i < subjects.length; i += chunkSize) {
      const r = await deliverChunk(seq, subjects.slice(i, i + chunkSize), { actor, source, at, ttl, remainingMs });
      if (r.inactive) return { status: "inactive", swept, subjects: subjects.length, delivered };
      delivered += r.delivered;
    }
    return { status: delivered ? "notified" : "duplicate", swept, subjects: subjects.length, delivered, ...(subjects.length > chunkSize ? { chunks: Math.ceil(subjects.length / chunkSize) } : {}) };
  }

  /** Claims `gids` (rec:<seq>:<subject>), delivers the ones this call won with one notifier call, and marks them done. */
  async function deliverChunk(seq, gids, { actor, source, at, ttl, remainingMs }) {
    const lease = now() + LEASE_MS;
    const owner = randomUUID();
    const attempted = new Set(); // claims that landed, and Puts that failed ambiguously (they may have landed): all are ours to give back
    const settled = await mapSettled(gids, CLAIM_CONCURRENCY, async (gid) => {
      if (typeof remainingMs === "function" && remainingMs() < MIN_REMAINING_MS) throw new Error("fanout_out_of_time");
      try {
        const won = await claim(seq, `person:${gid}`, at, ttl, lease, owner);
        if (won) attempted.add(gid);
        return won ? gid : null;
      } catch (e) {
        attempted.add(gid);
        throw e;
      }
    });
    // mapSettled has waited for every in-flight Put, so every claim that will ever land has landed: give back exactly ours, then fail.
    const giveBack = (list) => Promise.all([...list].map((gid) => release(seq, `person:${gid}`, owner)));
    const failure = settled.find((x) => x && !x.ok);
    if (failure) {
      await giveBack(attempted);
      throw failure.error;
    }
    const won = settled.map((x) => x?.value).filter(Boolean);
    if (!won.length) return { delivered: 0 };

    // The notifier applies the digest rules (more than 50 subjects, or more than 3 followed pages per follower) and never throws; it reports.
    let result;
    try {
      const changes = await mapLimit(won, CLAIM_CONCURRENCY, async (gid) => ({ subject: `person:${gid}`, subjectLabel: await label(gid), actor, source }));
      result = await notifier.onRecordChanged(changes, { silent: false, import: false, seed: false });
    } catch (e) {
      await giveBack(won);
      throw e;
    }
    if (result?.inactive) {
      await giveBack(won); // nothing could be sent; leave no done mark so a replay delivers once push or the inbox is configured
      log.error?.("record change fan-out skipped: no push and no inbox configured");
      return { delivered: 0, inactive: true };
    }
    if (result?.error || (Number.isInteger(result?.lost) && result.lost > 0)) {
      await giveBack(won);
      throw new Error("fanout_delivery_failed");
    }
    await mapLimit(won, CLAIM_CONCURRENCY, (gid) => done(seq, `person:${gid}`, at));
    return { delivered: won.length };
  }

  /** The stream handler: SYNC#RENDERED inserts only. Returns the partial-batch response the event source mapping expects. */
  async function handleStream(event, { remainingMs } = {}) {
    const batchItemFailures = [];
    for (const rec of event.Records) {
      const keys = rec?.dynamodb?.Keys;
      if (keys?.PK?.S !== "SYNC#RENDERED" || !SEQ_SK.test(keys?.SK?.S ?? "")) continue;
      try {
        const item = await getOutbox(Number(keys.SK.S));
        if (item) await processRendered(item, { remainingMs });
      } catch (e) {
        log.error?.("record change fan-out failed", logSafeError(e, { route: "record-fanout" }));
        const id = rec.dynamodb?.SequenceNumber;
        if (!id) throw e;
        batchItemFailures.push({ itemIdentifier: id });
      }
    }
    return { batchItemFailures };
  }

  /** A direct invoke { source: "record-fanout", seq } (an operator's replay of one outbox item; the claims make it safe to repeat). */
  async function handleInvoke(event, { remainingMs } = {}) {
    const seq = event?.seq;
    if (!Number.isInteger(seq) || seq < 1) throw new HttpError(400, "validation", "seq must be a positive whole number");
    const item = await getOutbox(seq);
    if (!item) return { status: "missing" };
    return processRendered(item, { remainingMs });
  }

  return { processRendered, handleStream, handleInvoke, sweepFollows };
}

/** True for an event the DynamoDB stream mapping (and not the Function URL) delivered. */
export const isStreamEvent = (event) =>
  event !== null && typeof event === "object" && event.requestContext === undefined && Array.isArray(event.Records) && event.Records.length > 0 && event.Records.every((r) => r?.eventSource === "aws:dynamodb");
/** True for an operator's direct invoke { source: "record-fanout", seq }; a Function URL event always carries requestContext. */
export const isReplayEvent = (event) => event !== null && typeof event === "object" && event.requestContext === undefined && event.source === "record-fanout";

/** How long a recipient's recordSubsV1 answer is reused within one container (the flag moves rarely; this bounds flag-store reads per pass). */
export const FLAG_CACHE_MS = 30_000;

/**
 * The notifier the consumer calls: the same producers as the request path, with the owner and follower sources filtered by `recordSubsV1`
 * for the recipient (so the flag is off for everyone but the uat group until the flip). deps are createNotifier's, plus `featureOn(name, principal)`
 * which createNotifier already takes for the inbox, and an optional `now`.
 * A flag READ failure is not "off": it throws out of the source, the producer reports `error`, and the consumer fails the pass so the stream retries
 * (an unreadable flag must not drop a notification and still be marked done). Only a successful answer is cached (FLAG_CACHE_MS, one read per
 * recipient per window, concurrent callers share the read).
 */
export function createFanoutNotifier(deps) {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map(); // principal -> { at, value: Promise<boolean> }
  const on = (principal) => {
    const hit = cache.get(principal);
    if (hit && now() - hit.at < FLAG_CACHE_MS) return hit.value;
    const value = Promise.resolve(deps.featureOn?.(FANOUT_FLAG, principal)).then((v) => v === true);
    const entry = { at: now(), value };
    cache.set(principal, entry);
    value.catch(() => { if (cache.get(principal) === entry) cache.delete(principal); }); // never cache a failed read
    return value;
  };
  const keepOn = async (ids) => {
    const list = [...ids];
    const flags = await Promise.all(list.map(on));
    return list.filter((_, i) => flags[i]);
  };
  return createNotifier({
    ...deps,
    listMembers: deps.listMembers ? async () => new Set(await keepOn(await deps.listMembers())) : undefined,
    followersOf: deps.followersOf ? async (subject) => keepOn(await deps.followersOf(subject)) : undefined,
  });
}
