// POST /api/proposals/:id/decision (HFY-TSK-209, proposal-decision-api; editing design 7.4 and 7.5, BRD2 D2-02, D2-30, DL-18, reviews PS-09, R2-28, P2-R38).
//
//   { verdict: "approve" | "deny" | "needs_changes", reason?, amend?: { ops, base_versions? } }   with If-Match: <etag> and Idempotency-Key
//   -> 200 { proposal, applied?: { versions } }
//
// Admins only (403 not_admin). The order of refusals, each before anything is written:
//   403 not_admin, 400 validation (the body), 422 (the privacy guard over the reason and over an amend's ops), 400 (no Idempotency-Key),
//   428 (no If-Match), a stored receipt of the key (replayed), 404, 412 precondition_failed (the etag moved: another admin acted, or the
//   proposer amended; the fresh view is in details.proposal), 409 invalid_state (not pending or stale), then per verdict:
//
//   deny, needs_changes   a reason is required (400) and guarded (422). ONE transaction: META (moved between PROPQ# queues), IDX#BY, every IDX#REC
//                         copy, AUDIT#proposal and the IDEM# receipt, with META pinned to the etag and state that were read. After the commit the
//                         proposer is told (proposal_declined | proposal_needs_changes, the reason as the inbox detail).
//   approve               the rebase (7.5): the proposal's ops are applied to the objects as they are NOW (a different field changed in the
//                         meantime is clean; an overlapping change is not), with the same engine, Gramps rules, schema and guard as POST /api/changes.
//                           - an overlap persists `stale` (audit proposal.stale), tells the proposer (proposal_stale) and answers 409 rebase_conflict;
//                             a target that is gone persists `superseded` the same way
//                           - the guard failing now (the rules may have tightened since) moves the proposal to needs_changes with a system reason;
//                             the matched text is never echoed, logged or stored
//                           - a destructive result (an object deleted, a parent, child or spouse link removed) needs auth_time within 900 s (401 step_up_required)
//                           - ONE applyBatch() transaction (origin "proposal", on behalf of the proposer) carries the record ops AND, through a contributor
//                             that is local to this call: the proposal META (pinned to etag and state), every IDX# copy, AUDIT#proposal, the IDEM# receipt,
//                             the completeAccessRequest fragment and contribOps(proposal_accepted, actor = the proposer). A concurrent second approval
//                             is cancelled by the pin (412) and credits nothing.
//
// Why a contributor and not `extra` (review P2-R38): applyBatch hashes `extra` into its idempotency key, and these items carry the batch time,
// the versions it assigns and the id it mints (Q2-03). The contributor (sync/hooks.js) is not hashed and runs on every attempt with the batch
// in hand, so the same request replays instead of failing 422 idempotency_key_reused. The handles of `new:n` objects are derived from the
// proposal id and rev for the same reason. The registry's own contributors (the self_edit and tag credit of hfy-record-change-fanout, DL-18) and
// afterCommit hooks run as for every batch: afterCommit fires exactly once per approval with origin "proposal". This task adds no self_edit or
// tag op. The record-change notifications of the applied records come from the render outbox, not from here.
import { HttpError } from "../http.js";
import { TxnCancelled, TxnTokenMismatch, transact } from "../txn.js";
import { applyBatch } from "../sync/apply.js";
import { defaultHooks } from "../sync/hooks.js";
import { batchIdFor, requestTokenFor } from "../sync/store.js";
import { contribOps, mergeOps } from "../contrib.js";
import { deriveUlid } from "../record-contributor.js";
import { contentHash } from "./ops.js";
import { createRecordGuard, RecordGuardError } from "./guard.js";
import { get, invalidateGraph } from "./index.js";
import {
  MAX_NOTE_CHARS, displayName, existingKey, isDestructive, keyParts, parseRequest, pick, planChanges, problem, requireRecentSignIn, sortedUnique, wireOps,
} from "./changes.js";
import {
  SYSTEM_PROPOSER, approvalHookFragment, idemKeys, idemPut, ownersList, ownersOf, proposalAuditItem, proposalRewrite, proposalView, sha256Hex, withState,
} from "./proposals.js";
import { ifMatchOf, loadProposal, preconditionFailed, rebaseOf, replyHeaders } from "./proposal-store.js";

/** The states an admin can decide (a needs_changes proposal waits for its proposer). */
export const DECIDABLE_STATES = Object.freeze(["pending", "stale"]);
/** The verdict names the route takes; `decline` is read as `deny` (the stored verdict and gates' word). */
const VERDICTS = Object.freeze({ approve: "approve", deny: "deny", decline: "deny", needs_changes: "needs_changes" });
/** What the proposer is told when the privacy rules rejected their text at approval time. It names no matched text. */
export const GUARD_SYSTEM_REASON = "the rules for what we keep on the site changed since you sent this. please look it over and send it again.";
const BODY_FIELDS = new Set(["verdict", "reason", "amend"]);
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_APPLY_ROUNDS = 3;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const bad = (errors, message = "the request is not valid") => problem(400, "validation", message, { errors });
const iso = (ms) => new Date(ms).toISOString();

// ---- the request ----------------------------------------------------------------------------------------------------------------
/** The decision input, validated and guarded before any store read. */
function parseDecision(c, guard) {
  const b = isObj(c.body) ? c.body : null;
  if (!b) throw bad([{ pointer: "", detail: "the body is an object" }]);
  const errors = [];
  for (const k of Object.keys(b)) if (!BODY_FIELDS.has(k)) errors.push({ pointer: `/${k}`, detail: "not a field of this request" });
  const verdict = Object.hasOwn(VERDICTS, b.verdict) ? VERDICTS[b.verdict] : undefined;
  if (!verdict) errors.push({ pointer: "/verdict", detail: "verdict is approve, deny or needs_changes" });
  let reason;
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== "string" || b.reason.length > MAX_NOTE_CHARS) errors.push({ pointer: "/reason", detail: `reason is text of at most ${MAX_NOTE_CHARS} characters` });
    else reason = b.reason.trim() || undefined;
  }
  if ((verdict === "deny" || verdict === "needs_changes") && !reason && !errors.some((e) => e.pointer === "/reason")) errors.push({ pointer: "/reason", detail: "say why, so the person can follow it" });
  if (b.amend !== undefined && verdict !== "approve") errors.push({ pointer: "/amend", detail: "only an approval can carry an edit" });
  if (b.amend !== undefined && verdict === "approve" && !(isObj(b.amend) && Array.isArray(b.amend.ops) && (b.amend.base_versions === undefined || isObj(b.amend.base_versions)))) {
    errors.push({ pointer: "/amend", detail: "amend is {ops, base_versions}" });
  }
  if (errors.length) throw bad(errors);

  // R-18 over the admin's own text: the reason, and an amend's ops (shape, caps, op text) exactly as POST /api/changes reads them.
  if (reason) guard.assertValue(reason, "decision.reason", { surface: "decision", op: "reason" });
  let amend;
  if (b.amend !== undefined) {
    const parsed = parseRequest({ ...c, body: { ops: b.amend.ops, ...(b.amend.base_versions !== undefined ? { base_versions: b.amend.base_versions } : {}), dry_run: true } }, guard);
    amend = { ops: parsed.ops, base_versions: parsed.base_versions };
  }

  const key = headerValue(c, "idempotency-key");
  if (key === undefined) throw bad([{ pointer: "/headers/idempotency-key", detail: "an Idempotency-Key header is required" }], "an Idempotency-Key is required");
  if (!IDEM_KEY_RE.test(key)) throw bad([{ pointer: "/headers/idempotency-key", detail: "the Idempotency-Key is 1 to 128 visible characters" }]);
  const etag = ifMatchOf(c);
  if (etag === null) throw new HttpError(428, "precondition_required", "send the If-Match header with the etag you read");
  return { verdict, reason, amend, key, etag };
}

function headerValue(c, name) {
  const h = c.event?.headers;
  if (!isObj(h)) return undefined;
  if (typeof h[name] === "string") return h[name];
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name && typeof h[k] === "string");
  return hit === undefined ? undefined : h[hit];
}

// ---- idempotency --------------------------------------------------------------------------------------------------------------------
async function readIdem(ctx, principal, key) {
  const res = await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: idemKeys(principal, key), ConsistentRead: true }));
  return res.Item ?? null;
}
function replayOf(item, requestHash) {
  if (item.requestHash !== requestHash) throw problem(422, "idempotency_mismatch", "that Idempotency-Key was used with a different request");
  return { status: item.result.status, body: item.result.body, headers: { "idempotent-replayed": "true" } };
}

// ---- small builders --------------------------------------------------------------------------------------------------------------------
/** The handles of the objects an approval creates are a function of (proposal id, rev, order): a retry builds the same ops. */
const mintFor = (p) => () => {
  let n = 0;
  return () => sha256Hex(`${p.id}:${p.rev}:${n++}`).slice(0, 24);
};

const byOf = (actor) => ({ id: actor.id, label: actor.label });
const authTimeOf = (actor) => (typeof actor.authTime === "number" && Number.isFinite(actor.authTime) ? actor.authTime : 0);

/** The decision member of a decided proposal. `applied` is the new versions of an approval. */
function decisionOf(actor, verdict, at, { reason, amended = false, applied, system } = {}) {
  return { verdict, by: byOf(actor), at, ...(reason ? { reason } : {}), amended, ...(applied ? { applied } : {}), ...(system ? { system: true } : {}), auth_time: authTimeOf(actor) };
}

const isSystemProposer = (p) => p.proposer?.id === SYSTEM_PROPOSER.id;
const personSubject = (p) => (p.subject?.cls === "Person" && typeof p.subject.gramps_id === "string" && p.subject.gramps_id ? `person:${p.subject.gramps_id}` : undefined);

/** After the commit, never failing it: the proposer is told (R-11). A system proposal (the access-request flow) has no member to tell. */
async function notifyProposer(c, p, decision, note) {
  try {
    if (isSystemProposer(p)) return;
    let label;
    const s = p.subject;
    if (s?.cls === "Person") {
      const head = await get(c.store, s.cls, s.handle).catch(() => null);
      label = head ? displayName(head.obj) || undefined : undefined;
    }
    await c.notifier?.onProposalDecided?.({
      proposal: { id: p.id, subject: personSubject(p), subjectLabel: label, proposer: p.proposer },
      decision, ...(note ? { note } : {}), by: byOf(c.actor),
    });
  } catch { /* a notification is a nicety and must not fail a committed decision */ }
}

function logDecision(ctx, info) {
  try { ctx.log?.info?.("proposal_decided", info); } catch { /* logging never changes the answer */ }
}

/** The one-transaction write of a state change that touches no record: deny, needs_changes, stale, superseded, and the system move-back. */
async function commitState(c, prev, next, { op, reason, auditAfter, receipt }) {
  const ctx = c.store;
  const at = next.updated_at;
  const rewrite = proposalRewrite(prev, next, { pinState: true });
  const audit = proposalAuditItem({
    op, id: prev.id, principalId: c.actor.id, at, uid: ctx.uid(), table: ctx.table, before: { state: prev.state, rev: prev.rev }, after: { state: next.state, rev: next.rev, ...auditAfter }, reason,
  });
  const puts = [...rewrite.puts, audit, ...(receipt ? [receipt] : [])];
  try {
    await transact(ctx.ddb, ctx.cmds, ctx.table, { puts, deletes: rewrite.deletes }, ctx.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) throw await lostRace(c, prev, e, receipt);
    if (e instanceof TxnCancelled) throw new HttpError(503, "unavailable", "the store is busy; try again");
    throw e;
  }
}

/**
 * A decision write that did not commit because the proposal moved (or the same key committed first). The key's own receipt answers a double
 * submit; anything else is 412 with the fresh view, as the document stands now.
 */
async function lostRace(c, prev, e, receipt) {
  const ctx = c.store;
  const fresh = await loadProposal(ctx, prev.id);
  if (!fresh) return new HttpError(404, "not_found", "no such suggestion");
  const tags = arr(e?.failures).map((f) => f.tag);
  if (receipt && (tags.includes("changes:idem") || fresh.etag !== prev.etag)) {
    const item = await readIdem(ctx, c.actor.id, receiptKeyOf(receipt));
    if (item) return new ReplaySignal(item);
  }
  if (fresh.etag === prev.etag && !tags.includes("proposal:cas")) return new HttpError(503, "unavailable", "the store is busy; try again");
  return await preconditionFailed(c, fresh);
}
/** Carries a stored receipt out of a failed write so the route can answer it. */
class ReplaySignal extends Error {
  constructor(item) { super("replay"); this.item = item; }
}
const receiptKeyOf = (receipt) => receipt.idemKey;

function receiptFor(c, input, requestHash, result, at) {
  const put = idemPut({ principal: c.actor.id, key: input.key, requestHash, result, at, nowMs: Date.parse(at) });
  return Object.assign(put, { idemKey: input.key });
}

// ---- deny and needs_changes ----------------------------------------------------------------------------------------------------------
async function decideWithoutRecords(c, prev, input, requestHash) {
  const { actor } = c;
  const ctx = c.store;
  const at = iso(ctx.now());
  const state = input.verdict === "deny" ? "declined" : "needs_changes";
  const next = withState(prev, state, at, { decision: decisionOf(actor, input.verdict, at, { reason: input.reason }) });
  const body = { proposal: proposalView(next, actor, { stale: false }) };
  const receipt = receiptFor(c, input, requestHash, { status: 200, body }, at);
  await commitState(c, prev, next, { op: "proposal.decide", reason: input.reason, auditAfter: { verdict: input.verdict }, receipt });
  logDecision(ctx, { verdict: input.verdict, state });
  await notifyProposer(c, prev, input.verdict === "deny" ? "declined" : "needs_changes", input.reason);
  return { status: 200, body, headers: replyHeaders(next) };
}

// ---- approve ------------------------------------------------------------------------------------------------------------------------------
/** A target that is gone, or an overlap: not an error of the admin's, so the proposal is moved aside (stale or superseded) and the proposer told. */
const isConflict = (e) => e instanceof HttpError && ((e.status === 409 && e.code === "version_conflict") || (e.status === 400 && e.code === "validation"));

async function planApproval(c, prev, amend, nowMs, guard) {
  const ctx = c.store;
  const ops = amend ? amend.ops : prev.ops;
  const versions = {};
  const gone = [];
  for (const k of sortedUnique(ops.map(existingKey).filter(Boolean))) {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    if (head) versions[k] = head.version;
    else gone.push(k);
  }
  if (gone.length) return { gone };
  // A relationship proposal also names the objects its decision was based on but its ops leave alone (read_versions, relationship-api): if any of
  // them moved, the suggestion was judged on a page that is no longer there.
  const readRows = [];
  for (const [k, v] of Object.entries(isObj(prev.read_versions) ? prev.read_versions : {})) {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    if (!head || head.version !== v) readRows.push({ opId: null, obj: k, path: "", reason: "read_version_changed" });
  }
  if (readRows.length) return { readRows };
  // The rebase: the ops meet the objects as they are now. base_versions is the version of each, so a stale base_version alone is never a conflict.
  const req = { base_versions: versions, ops, note: prev.note, route: "review", dry_run: false };
  return { planned: await planChanges(c, req, nowMs, guard, { skipRateLimit: true, mint: mintFor(prev) }) };
}

/** The proposal as it is approved: the stored one, or the stored one with the admin's edit (amend) in place of its ops. */
async function effectiveProposal(c, prev, amend, planned) {
  const review = planned.review;
  if (!amend || !review) return prev;
  const touched = sortedUnique(review.ops.map(existingKey).filter(Boolean));
  return {
    ...prev, kind: review.ops.some((o) => o.op === "create") ? "create" : "edit", targets: review.targets, owners: ownersList(await ownersOf(c.store, review.targets, planned.stored)),
    base_versions: pick(amend.base_versions, touched), ops: review.ops, summary: planned.plan.review.flatMap((g) => g.summary), warnings: review.warnings ?? [],
  };
}

/** The gramps_id the access-request completion links: the Person the approval created, else the page the proposal is about. "" when none is set yet (assign mode). */
function grampsIdFor(batch, eff) {
  const created = arr(batch.changes).find((x) => x.class === "Person" && x.op === "create");
  if (created) return created.gramps_id ?? "";
  return eff.subject?.cls === "Person" ? eff.subject.gramps_id ?? "" : "";
}

/**
 * The fragment an approval adds to its own transaction, for one attempt of the batch. Pure in `batch` (applyBatch runs it on every attempt):
 * the time, the versions, the minted id and the audit id all come from the batch.
 */
function approvalBuilder(c, prev, eff, input, requestHash, amended) {
  const { actor } = c;
  const ctx = c.store;
  return async (batch) => {
    const at = batch.at;
    const atMs = Date.parse(at);
    const versions = {};
    for (const r of arr(batch.results)) if (typeof r.class === "string") versions[`${r.class}:${r.handle}`] = r.version;
    const next = withState(eff, "approved", at, { decision: decisionOf(actor, "approve", at, { reason: input.reason, amended, applied: versions }) });
    const body = { proposal: proposalView(next, actor, { stale: false }), applied: { versions } };
    const rewrite = proposalRewrite(prev, next, { pinState: true });
    const audit = proposalAuditItem({
      op: "proposal.decide", id: prev.id, principalId: actor.id, at, uid: batch.batch_id, table: ctx.table,
      before: { state: prev.state, rev: prev.rev }, after: { state: "approved", rev: next.rev, verdict: "approve", amended, objects: Object.keys(versions).length }, reason: input.reason,
    });
    const parts = [
      { puts: [...rewrite.puts, audit, receiptFor(c, input, requestHash, { status: 200, body }, at)], deletes: rewrite.deletes, updates: [], checks: [] },
    ];
    const grampsId = grampsIdFor(batch, eff);
    if (grampsId) {
      // The access-request link commits with the approval (surfaces 7.4); with no gramps_id yet (assign mode) the desktop's assignment completes it later.
      const hook = await approvalHookFragment(ctx, eff, { grampsId });
      if (hook) parts.push({ puts: hook.puts ?? [], deletes: hook.deletes ?? [], updates: hook.updates ?? [], checks: hook.checks ?? [] });
    }
    if (!isSystemProposer(prev)) {
      // R-25/26: the PROPOSER is credited, never the approver. One event per proposal however many fields it changed. No self_edit or tag op here (DL-18).
      const createdPerson = arr(batch.changes).find((x) => x.class === "Person" && x.op === "create" && x.gramps_id);
      const subject = personSubject(prev) ?? (createdPerson ? `person:${createdPerson.gramps_id}` : undefined);
      parts.push(contribOps({
        actor: { id: prev.proposer.id, label: prev.proposer.label }, kind: "proposal_accepted", ref: { type: "proposal", id: prev.id }, ...(subject ? { subject } : {}),
        at, via: prev.origin === "mcp" ? "mcp" : "ui", id: deriveUlid(atMs, `${batch.batch_id}:proposal_accepted`),
      }));
    }
    return { fragment: mergeOps(...parts), next, body, versions };
  };
}

/** The registry of this call: the process's contributors and afterCommit hooks, plus the approval's own contributor. */
function hooksWith(base, mine) {
  return { contributors: () => [...base.contributors(), mine], afterCommitHooks: () => base.afterCommitHooks() };
}

async function moveAside(c, prev, { state, op, conflicts, errors, superseded }) {
  const ctx = c.store;
  const at = iso(ctx.now());
  if (prev.state !== state) {
    const next = withState(prev, state, at);
    await commitState(c, prev, next, { op, auditAfter: { conflicts: conflicts.length } });
    await notifyProposer(c, prev, "stale");
    const fresh = proposalView(next, c.actor, { stale: state === "stale" });
    throw problem(409, "rebase_conflict", superseded ? "the page was merged or removed" : "the page changed since this was suggested", { details: { proposal: fresh, conflicts }, errors });
  }
  const view = proposalView(prev, c.actor, { stale: true });
  throw problem(409, "rebase_conflict", "the page changed since this was suggested", { details: { proposal: view, conflicts }, errors });
}

/** A guard failure at approval time (the rules may have tightened): the proposal goes back to its proposer with a system reason. */
async function moveBack(c, prev, e) {
  const ctx = c.store;
  const at = iso(ctx.now());
  const next = withState(prev, "needs_changes", at, { decision: decisionOf(c.actor, "needs_changes", at, { reason: GUARD_SYSTEM_REASON, system: true }) });
  await commitState(c, prev, next, { op: "proposal.decide", reason: GUARD_SYSTEM_REASON, auditAfter: { verdict: "needs_changes", system: true, findings: arr(e.errors).length } });
  logDecision(ctx, { verdict: "needs_changes", state: "needs_changes", system: true });
  await notifyProposer(c, prev, "needs_changes", GUARD_SYSTEM_REASON);
}

async function approve(c, prev, input, requestHash) {
  const { actor } = c;
  const ctx = c.store;
  const guard = createRecordGuard({ dob: ctx.guardDob === true, log: ctx.log });
  const amended = input.amend !== undefined;
  const nowMs = ctx.now();

  let planned;
  for (let round = 0; ; round += 1) {
    let step;
    try {
      step = await planApproval(c, prev, input.amend, nowMs, guard);
    } catch (e) {
      if (!amended && e instanceof RecordGuardError) {
        await moveBack(c, prev, e);
        throw e;
      }
      if (!amended && isConflict(e)) {
        const rows = (await rebaseOf(ctx, actor, prev)).conflicts;
        await moveAside(c, prev, { state: "stale", op: "proposal.stale", conflicts: rows.length ? rows : arr(e.details?.conflicts), errors: e.errors });
      }
      throw e;
    }
    if (step.gone) {
      if (amended) throw new HttpError(404, "not_found", "no such record");
      const rows = (await rebaseOf(ctx, actor, prev)).conflicts;
      await moveAside(c, prev, { state: "superseded", op: "proposal.supersede", conflicts: rows, superseded: true });
    }
    if (step.readRows) {
      if (amended) throw problem(409, "rebase_conflict", "the page changed since this was suggested", { details: { conflicts: step.readRows } });
      await moveAside(c, prev, { state: "stale", op: "proposal.stale", conflicts: step.readRows });
    }
    planned = step.planned;

    const r = planned.review;
    if (r) {
      const before = Object.fromEntries([...planned.stored].map(([k, h]) => [k, h.obj]));
      if (isDestructive(before, r.final, r.changes)) requireRecentSignIn(actor, nowMs);
    }
    const eff = await effectiveProposal(c, prev, input.amend, planned);
    const build = approvalBuilder(c, prev, eff, input, requestHash, amended);
    let last;
    const mine = async (batch) => {
      last = await build(batch);
      return last.fragment;
    };
    const applyKey = `prop:${prev.id}:${prev.rev}`;

    try {
      if (r) {
        const batchCtx = { ...ctx, hooks: hooksWith(ctx.hooks ?? defaultHooks, mine) };
        const res = await applyBatch(batchCtx, { principal: actor.id, origin: "proposal", onBehalfOf: prev.proposer.id, idempotencyKey: applyKey, ops: wireOps(r) });
        if (res.replayed || !last) throw new ReplaySignal(null);
        invalidateGraph(ctx);
      } else {
        // Every op is already applied: nothing to write on the records. The proposal is still decided and its proposer credited, in one transaction.
        const batchId = batchIdFor(actor.id, applyKey);
        const at = iso(nowMs);
        last = await build({ batch_id: batchId, at, results: [], changes: [] });
        await transact(ctx.ddb, ctx.cmds, ctx.table, { ...last.fragment, clientRequestToken: requestTokenFor(batchId, 0) }, ctx.txnOpts);
      }
    } catch (e) {
      const mapped = await mapApplyFailure(c, prev, e, input, requestHash);
      if (mapped === "replan" && round + 1 < MAX_APPLY_ROUNDS) continue;
      throw mapped === "replan" ? e : mapped;
    }
    logDecision(ctx, { verdict: "approve", state: "approved", objects: Object.keys(last.versions).length, amended });
    await notifyProposer(c, prev, "accepted");
    return { status: 200, body: last.body, headers: replyHeaders(last.next) };
  }
}

/**
 * What a failed approval write means. Returns "replan" (the records moved under a plan the proposal is still entitled to: plan again), or an error
 * for the route to throw; a replay of this key's stored answer is thrown as a ReplaySignal. The proposal having moved is always 412.
 */
async function mapApplyFailure(c, prev, e, input, requestHash) {
  const ctx = c.store;
  if (e instanceof ReplaySignal || e instanceof TxnTokenMismatch || (e instanceof TxnCancelled && e.conditionFailed) || (e instanceof HttpError && [409, 422, 503].includes(e.status))) {
    const fresh = await loadProposal(ctx, prev.id);
    const item = await readIdem(ctx, c.actor.id, input.key);
    if (item) return new ReplaySignal(item);
    if (!fresh) return new HttpError(404, "not_found", "no such suggestion");
    if (fresh.etag !== prev.etag) return await preconditionFailed(c, fresh);
    if (e instanceof HttpError && e.status === 409 && (e.code === "version_conflict" || e.code === "exists")) return "replan"; // the records moved after the plan was made, the proposal did not
    if (e instanceof HttpError) return e;
    return new HttpError(503, "unavailable", "the store is busy; try again");
  }
  if (e instanceof RangeError && e.code === "txn_too_large") return problem(413, "too_large", "this suggestion is too big to approve in one step");
  return e;
}

// ---- the route ----------------------------------------------------------------------------------------------------------------------------
/** POST /api/proposals/:id/decision */
export async function proposalsDecide(c) {
  const ctx = c.store;
  const { actor } = c;
  if (actor.admin !== true) throw new HttpError(403, "not_admin", "only an admin can decide a suggestion");
  const guard = createRecordGuard({ dob: ctx.guardDob === true, log: ctx.log });
  const input = parseDecision(c, guard);
  const requestHash = contentHash({ id: c.params.id, verdict: input.verdict, reason: input.reason ?? null, amend: input.amend ?? null, etag: input.etag });

  const stored = await readIdem(ctx, actor.id, input.key);
  if (stored) return replayOf(stored, requestHash);

  const prev = await loadProposal(ctx, c.params.id);
  if (!prev) throw new HttpError(404, "not_found", "no such suggestion");
  if (input.etag !== prev.etag) throw await preconditionFailed(c, prev);
  if (!DECIDABLE_STATES.includes(prev.state)) throw new HttpError(409, "invalid_state", "this suggestion was already handled");

  try {
    return input.verdict === "approve" ? await approve(c, prev, input, requestHash) : await decideWithoutRecords(c, prev, input, requestHash);
  } catch (e) {
    if (e instanceof ReplaySignal) return replayOf(e.item, requestHash);
    throw e;
  }
}
