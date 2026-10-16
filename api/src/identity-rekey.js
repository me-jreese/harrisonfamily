// HFY-TSK-294 (identity-merge-rekey; review SI-11, BRD2 section 4, R-03, R-12): the identity domain's answer to a desktop Person merge.
//
// A merge retires a Person id: applyBatch writes IDALIAS#Person#<old> {current_gramps_id: <new>, reason: "merge"} (sync/apply.js). Several
// kinds of social data are keyed by that gramps id, so after the merge commits this job moves them onto the survivor:
//
//   comments      THREAD#person:<old>  C# and R# items         -> THREAD#person:<new> (comment.threadId follows)
//   follows       RSUB#<principal>/REC#person:<old> + RECSUB#   -> person:<new>; a principal who already follows <new> (or is <new>) just loses the old follow
//   hidden items  OTD#HIDDEN META ids "birth:<old>"             -> "birth:<new>" (deduplicated; "evt:<handle>" ids carry no person id)
//   post indexes  POST#<id> IDX#SUBJECT (GSI1 SUBJECT#person:<old>) and the post.subject copy on the post's three items
//
// NEVER re-keyed: member-principal identities (PLINKS#, CONTRIB#, INBOX#, ALLOW# items, userGrampsID, the session sub). The desktop add-on
// refuses to merge a member principal away (addon-push, hold D51), and this job refuses the alias too when it finds any trace of the old id
// as a principal: the alias is marked `refused` and nothing moves.
//
// Idempotent and resumable. Every step is "read what still sits under <old>, move it, repeat until nothing does", so a re-run finds nothing
// to do and a crash part-way is finished by the next run. Each move is one TransactWriteItems unit of a few actions; units are packed at most
// UNIT_BUDGET actions per transaction (the 100-action limit minus the headroom for the final audit and marker). Progress and outcome live in
// REKEY#Person#<old> (never in the IDALIAS# item, which sync recovery folds from the log byte for byte).
//
// The hook (`createRekeyHook`) runs from applyBatch's afterCommit registry, so it never fails the write; `rekeyPending` retries every alias
// that is not done, and sync-admin.mjs `rekey` / `merges-on` use the same code.
import { logSafeError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { commentGuard, hasPendingPhoto } from "./comments.js";
import { aliasKey } from "./sync/store.js";
import { allowSubKey } from "./shared/allowlist-store.mjs";
import { subSubject, rsubKeys, recsubGsi } from "./subscriptions.js";
import { postKeys, gsiSubject } from "./keys.js";

/** Actions per transaction, leaving room for the closing audit and marker items. */
export const UNIT_BUDGET = 90;
/** Query pages read per step and pass (100 items each at most). A bigger set is finished by the next pass or run. */
const MAX_PAGES = 50;
/** Passes of "plan, apply" per alias before it is left `partial` for the next run. */
const MAX_PASSES = 6;
/** Alias chain links followed to the live survivor. */
const MAX_CHAIN = 8;
/** Thrown when no member check is wired: the job fails closed (nothing moves, no marker) rather than guess an id is not a member. */
export class MemberCheckUnavailable extends Error {
  constructor() {
    super("member check unavailable");
    this.name = "MemberCheckUnavailable";
    this.code = "member_check_unavailable";
  }
}
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const markerKeys = (oldId) => ({ PK: `REKEY#Person#${oldId}`, SK: "META" });
export const OTD_HIDDEN = Object.freeze({ PK: "OTD#HIDDEN", SK: "META" });

const threadPk = (id) => `THREAD#person:${id}`;
const nothing = () => ({ comments: 0, reactions: 0, follows: 0, followsDropped: 0, hidden: 0, posts: 0 });

async function queryAll(ctx, input) {
  const out = [];
  let key;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({ TableName: ctx.table, ...input, ...(key ? { ExclusiveStartKey: key } : {}) }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return { items: out, more: false };
  }
  return { items: out, more: true };
}
const getItem = async (ctx, Key) => (await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key, ConsistentRead: true }))).Item;

// ---- planners: each returns units (atomic groups of actions) and a tally ---------------------------------------------------------------

async function planThread(ctx, oldId, newId) {
  const { items, more } = await queryAll(ctx, { KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": threadPk(oldId) } });
  const units = [];
  // A comment whose photo graduation is pending stays put (the graduation job writes against THREAD#person:<old> and the comment's guard), with the
  // reactions that target it. They are reported as `blocked`, so the alias stays `partial` and the next run moves them once graduation has finished.
  const pending = new Set(items.filter((it) => it.SK.startsWith("C#") && hasPendingPhoto(it.comment)).map((it) => it.comment?.id ?? it.SK.slice(2)));
  let blocked = 0;
  for (const it of items) {
    const isComment = it.SK.startsWith("C#");
    if ((isComment && pending.has(it.comment?.id ?? it.SK.slice(2))) || (it.SK.startsWith("R#") && pending.has(it.target))) {
      blocked += 1;
      continue;
    }
    const moved = { ...it, PK: threadPk(newId) };
    if (isComment) moved.comment = { ...it.comment, threadId: `person:${newId}` };
    const del = isComment ? { key: { PK: it.PK, SK: it.SK }, ...commentGuard(it.comment) } : { key: { PK: it.PK, SK: it.SK }, condition: "attribute_exists(PK)" };
    units.push({ puts: [{ item: moved, condition: "attribute_not_exists(PK)" }], deletes: [del], t: isComment ? { comments: 1 } : it.SK.startsWith("R#") ? { reactions: 1 } : {} });
  }
  return { units, more: more || blocked > 0 };
}

async function planFollows(ctx, oldId, newId) {
  const oldSubject = subSubject(oldId);
  const newSubject = subSubject(newId);
  const { items, more } = await queryAll(ctx, { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": recsubGsi(oldSubject) } });
  const units = [];
  for (const it of items) {
    const principal = it.GSI1SK;
    if (typeof principal !== "string" || it.PK !== rsubKeys(principal, oldSubject).PK) continue; // not a follow item: leave it
    const del = { key: { PK: it.PK, SK: it.SK }, condition: "attribute_exists(PK)" };
    const existing = principal === newId ? true : Boolean(await getItem(ctx, rsubKeys(principal, newSubject)));
    if (existing) {
      // already following the survivor (or the survivor's own principal: a follow of one's own page is not allowed): deduplicate
      units.push({ deletes: [del], t: { followsDropped: 1 } });
    } else {
      units.push({
        puts: [{ item: { ...it, ...rsubKeys(principal, newSubject), subject: newSubject, GSI1PK: recsubGsi(newSubject), GSI1SK: principal }, condition: "attribute_not_exists(PK)" }],
        deletes: [del],
        t: { follows: 1 },
      });
    }
  }
  return { units, more };
}

async function planHidden(ctx, oldId, newId) {
  const row = await getItem(ctx, OTD_HIDDEN);
  if (!row || !Array.isArray(row.ids)) return { units: [], more: false };
  const from = `birth:${oldId}`;
  const to = `birth:${newId}`;
  if (!row.ids.includes(from)) return { units: [], more: false };
  const ids = [...new Set(row.ids.map((x) => (x === from ? to : x)))];
  const guard = row.version === undefined ? { condition: "attribute_exists(PK) AND attribute_not_exists(#v)", names: { "#v": "version" } } : { condition: "attribute_exists(PK) AND #v = :v", names: { "#v": "version" }, values: { ":v": row.version } };
  return { units: [{ puts: [{ item: { ...row, ids, version: (Number.isInteger(row.version) ? row.version : 0) + 1 }, ...guard }], t: { hidden: 1 } }], more: false };
}

async function planPosts(ctx, oldId, newId) {
  const oldSubject = subSubject(oldId);
  const newSubject = subSubject(newId);
  const { items, more } = await queryAll(ctx, { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": gsiSubject(oldSubject) } });
  const units = [];
  const names = { "#p": "post", "#s": "subject" };
  const guard = { condition: "attribute_exists(PK) AND #p.#s = :o", names, values: { ":o": oldSubject } };
  for (const it of items) {
    if (it.SK !== "IDX#SUBJECT" || typeof it.GSI1SK !== "string") continue;
    const id = it.GSI1SK;
    units.push({
      updates: [
        { key: postKeys(id), update: "SET #p.#s = :n", ...guard, values: { ...guard.values, ":n": newSubject } },
        { key: { PK: `POST#${id}`, SK: "IDX#AUTHOR" }, update: "SET #p.#s = :n", ...guard, values: { ...guard.values, ":n": newSubject } },
        { key: { PK: `POST#${id}`, SK: "IDX#SUBJECT" }, update: "SET #p.#s = :n, GSI1PK = :g", ...guard, values: { ...guard.values, ":n": newSubject, ":g": gsiSubject(newSubject) } },
      ],
      t: { posts: 1 },
    });
  }
  return { units, more };
}

const PLANNERS = [planThread, planFollows, planHidden, planPosts];

// ---- applying ---------------------------------------------------------------------------------------------------------------------------

const sizeOf = (u) => (u.puts?.length ?? 0) + (u.deletes?.length ?? 0) + (u.updates?.length ?? 0) + (u.checks?.length ?? 0);
const add = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};
const merge = (a, u) => ({ puts: [...(a.puts ?? []), ...(u.puts ?? [])], deletes: [...(a.deletes ?? []), ...(u.deletes ?? [])], updates: [...(a.updates ?? []), ...(u.updates ?? [])], t: add(a.t ?? {}, u.t) });

/** Packs units into transactions of at most `budget` actions. A unit is never split. Each fragment carries `t`, the tally of its units. */
export function pack(units, budget = UNIT_BUDGET) {
  const txns = [];
  let cur = { n: 0, frag: {} };
  for (const u of units) {
    const n = sizeOf(u);
    if (n > budget) throw new RangeError("a re-key unit exceeds the transaction budget");
    if (cur.n + n > budget) {
      txns.push(cur.frag);
      cur = { n: 0, frag: {} };
    }
    cur = { n: cur.n + n, frag: merge(cur.frag, u) };
  }
  if (cur.n > 0) txns.push(cur.frag);
  return txns;
}

/** One planning-and-applying pass over one step. A cancelled transaction (a concurrent edit) is dropped to units and retried one by one. */
async function runStep(ctx, planner, oldId, newId) {
  const { units, more } = await planner(ctx, oldId, newId);
  let tally = nothing();
  for (const { t, ...frag } of pack(units)) {
    try {
      await transact(ctx.ddb, ctx.cmds, ctx.table, frag, ctx.txnOpts);
      tally = add(tally, t);
    } catch (e) {
      if (!(e instanceof TxnCancelled)) throw e;
      // a concurrent writer changed an item in this transaction: the next pass re-plans from the store
    }
  }
  return { remaining: units.length > 0, more, tally };
}

/**
 * Evidence that `oldId` is a member principal: the member set (userGrampsID), an ALLOW# entry whose sub is the id, or any PLINKS#, CONTRIB# or
 * INBOX# partition keyed by it. `isMember` throwing is NOT evidence either way; it propagates so the alias stays pending. A ctx with no `isMember`
 * fails closed (MemberCheckUnavailable). PLINKS# counts as evidence because links.js only lets the owner (actor.id === :id, a member) write one;
 * an admin may only clear. So a PLINKS# partition under a gramps id exists only for a member principal.
 */
export async function memberEvidence(ctx, oldId) {
  if (typeof ctx.isMember !== "function") throw new MemberCheckUnavailable();
  if ((await ctx.isMember(oldId)) === true) return "member_list";
  const allow = await ctx.ddb.send(new ctx.cmds.QueryCommand({ TableName: ctx.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": allowSubKey(oldId) }, Limit: 1 }));
  if ((allow.Items ?? []).length > 0) return "allow_entry";
  for (const prefix of ["PLINKS#", "CONTRIB#", "INBOX#"]) {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({ TableName: ctx.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `${prefix}${oldId}` }, Limit: 1 }));
    if ((r.Items ?? []).length > 0) return `${prefix.slice(0, -1).toLowerCase()}_partition`;
  }
  return null;
}

/** Follows the alias chain from `startId` to the id no merge has retired. Returns null at a dead end, a cycle or past MAX_CHAIN links. */
export async function liveSurvivor(ctx, startId) {
  let id = startId;
  const seen = new Set([id]);
  for (let i = 0; i < MAX_CHAIN; i += 1) {
    const alias = await getItem(ctx, aliasKey("Person", id));
    if (!alias) return id;
    if (alias.reason !== "merge" || typeof alias.current_gramps_id !== "string" || seen.has(alias.current_gramps_id)) return null;
    id = alias.current_gramps_id;
    seen.add(id);
  }
  return null;
}

async function writeMarker(ctx, oldId, fields, audit) {
  const at = new Date(ctx.now()).toISOString();
  const prior = await getItem(ctx, markerKeys(oldId));
  const counts = fields.counts && prior?.counts ? add(prior.counts, fields.counts) : fields.counts ?? prior?.counts;
  const item = { ...markerKeys(oldId), entity: "rekey", class: "Person", old_gramps_id: oldId, ...fields, ...(counts ? { counts } : {}), at };
  const puts = [{ item }];
  if (audit) puts.push({ item: auditItem({ id: `rekey:Person:${oldId}`, op: audit, principalId: "system:identity-rekey", at, before: { state: prior?.state ?? null }, after: { state: fields.state, ...(counts ? { counts } : {}) } }, ctx.uid(), ctx.table) });
  await transact(ctx.ddb, ctx.cmds, ctx.table, { puts }, ctx.txnOpts);
  return item;
}

/**
 * Re-keys everything under `oldId` onto `newId` (the id the merge's alias names). Safe to call again: a call that finds nothing under <old> changes nothing.
 * Refuses (state "refused", nothing moved) when `oldId` is a member principal. Returns { state: "done"|"partial"|"refused", counts, reason? }.
 * ctx: { ddb, cmds, table, now, uid, isMember?(id), txnOpts?, log? }.
 */
export async function rekeyPerson(ctx, oldId, newId, { batchId } = {}) {
  if (!ID_RE.test(oldId ?? "") || !ID_RE.test(newId ?? "") || oldId === newId) throw new TypeError("rekeyPerson needs two different gramps ids");
  const evidence = await memberEvidence(ctx, oldId);
  if (evidence) {
    await writeMarker(ctx, oldId, { state: "refused", reason: "member_principal", evidence, new_gramps_id: newId, ...(batchId ? { batch_id: batchId } : {}) }, "identity.rekey.refused");
    ctx.log?.warn?.("rekey_refused", { reason: "member_principal", evidence });
    return { state: "refused", reason: "member_principal", counts: nothing() };
  }
  let counts = nothing();
  let clean = false;
  for (let pass = 0; pass < MAX_PASSES && !clean; pass += 1) {
    clean = true;
    for (const planner of PLANNERS) {
      const r = await runStep(ctx, planner, oldId, newId);
      counts = add(counts, r.tally);
      if (r.remaining || r.more) clean = false;
    }
  }
  const state = clean ? "done" : "partial";
  await writeMarker(ctx, oldId, { state, new_gramps_id: newId, ...(batchId ? { batch_id: batchId } : {}), counts }, `identity.rekey.${state}`);
  return { state, counts };
}

/**
 * Every merge alias whose job is not finished: [{ oldId, newId, batchId, state }]. A `done` or `refused` marker settles an alias.
 * opts.retryRefused also returns `refused` aliases (the operator's clear-the-refusal path); opts.resweep also returns `done` ones (orphans a stale
 * client wrote under the old id after completion); opts.settled is a Set of old ids the caller already knows are done (skips the marker read).
 */
export async function pendingAliases(ctx, { retryRefused = false, resweep = false, settled } = {}) {
  const { items } = await queryAll(ctx, { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "IDALIAS#Person" } });
  const out = [];
  for (const a of items) {
    if (a.reason !== "merge" || typeof a.current_gramps_id !== "string" || a.current_gramps_id === a.old_gramps_id) continue;
    if (!resweep && settled?.has(a.old_gramps_id)) continue;
    const marker = await getItem(ctx, markerKeys(a.old_gramps_id));
    if (marker?.state === "done" && !resweep) {
      settled?.add(a.old_gramps_id);
      continue;
    }
    if (marker?.state === "refused" && !retryRefused) continue;
    out.push({ oldId: a.old_gramps_id, newId: a.current_gramps_id, batchId: a.batch_id, state: marker?.state ?? "new" });
  }
  return out;
}

/** Runs the job for every pending alias, each against its live survivor. An alias whose chain does not end in a live person is left pending. */
export async function rekeyPending(ctx, opts = {}) {
  const results = [];
  for (const p of await pendingAliases(ctx, opts)) {
    const target = await liveSurvivor(ctx, p.newId);
    if (!target) {
      // persisted once (not on every retry) so the operator sees the diagnostic in REKEY#; still retried, since a later merge can fix the chain
      if (p.state !== "unresolved") await writeMarker(ctx, p.oldId, { state: "unresolved", reason: "no_live_survivor", new_gramps_id: p.newId, ...(p.batchId ? { batch_id: p.batchId } : {}) }, "identity.rekey.unresolved");
      results.push({ oldId: p.oldId, state: "unresolved" });
      continue;
    }
    try {
      results.push({ oldId: p.oldId, newId: target, ...(await rekeyPerson(ctx, p.oldId, target, { batchId: p.batchId })) });
    } catch (e) {
      if (!(e instanceof MemberCheckUnavailable)) throw e;
      results.push({ oldId: p.oldId, state: "member_check_unavailable" });
    }
  }
  return results;
}

/**
 * The afterCommit hook (sync/hooks.js): `fn({ batch_id, origin, seq_from, seq_to })`. It re-keys every pending merge alias, so a batch
 * that committed a merge is handled at once and an earlier crash is finished by the next batch. It logs codes only and never throws.
 */
export function createRekeyHook(ctx) {
  const settled = new Set(); // old ids this process has seen finished: no marker read per batch
  return async (info) => {
    if (info?.origin === "seed") return;
    try {
      await rekeyPending(ctx, { settled });
    } catch (e) {
      ctx.log?.warn?.("rekey_failed", logSafeError(e, { route: "identity-rekey" }));
    }
  };
}

/** Registers the hook once per registry. Returns the remover. */
const registered = new WeakMap();
export function registerRekeyHook(ctx, hooks) {
  const existing = registered.get(hooks);
  if (existing && hooks.afterCommitHooks().includes(existing.fn)) return existing.remove;
  const fn = createRekeyHook(ctx);
  const off = hooks.registerAfterCommit(fn);
  const remove = () => {
    off();
    if (registered.get(hooks)?.fn === fn) registered.delete(hooks);
  };
  registered.set(hooks, { fn, remove });
  return remove;
}
