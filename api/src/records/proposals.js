// The proposal document and its items (HFY-TSK-183, edit-api-changes; editing design 5.2, 7.3, 7.4; BRD2 section 4.2 "Editing (proposals)", D2-30).
//
// POST /api/changes is the first writer of these items; proposal-store-api (reads, amend, withdraw) and proposal-decision-api (decide) build on the
// same layout, so the keys, the document and the etag live here and nowhere else:
//   PROP#<ulid> / META            GSI1 PROPQ#<state> / <ulid>        the proposal, in its state queue
//   PROP#<ulid> / IDX#BY          GSI1 PROPBY#<principal> / <ulid>   a full copy, for the proposer's list and the 24-hour rate limit
//   PROP#<ulid> / IDX#REC#<k>     GSI1 PROPREC#<k> / <ulid>          a full copy per target object (<k> = "Class:handle"), for pending[] on a page
//   IDEM#<principal>#<sha256(key)> / META                             the generic route receipt: { requestHash, result: { status, body } }, 24 h
//   AUDIT#proposal:<ulid>                                             one audit item per state change (proposal.create here)
// A state change rewrites META and every IDX copy in one transaction. The document never holds an email (HFY-R68): the proposer label is the
// session label.
import { createHash } from "node:crypto";
import { auditItem } from "../txn.js";
import { FIXED_TXN_ITEMS, MAX_OPS as MAX_BATCH_OBJECTS } from "../sync/store.js";
import { contentHash } from "./ops.js";

export const PROPOSAL_STATES = Object.freeze(["pending", "needs_changes", "stale", "approved", "declined", "withdrawn", "superseded"]);
/** The states in which a proposal is still waiting on someone. */
export const OPEN_STATES = Object.freeze(["pending", "needs_changes", "stale"]);

/** Size caps (editing design 5.2): with them a decision transaction stays under 40 items. */
export const MAX_PROPOSAL_OPS = 50;
export const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_NEW_OBJECTS = 10;
/** At most this many proposals per principal per 24 hours, counted from the PROPBY index (no counter item). */
export const PROPOSAL_RATE_LIMIT = 50;
export const PROPOSAL_RATE_WINDOW_MS = 24 * 3600 * 1000;
/** The receipt of an Idempotency-Key lives this long. */
export const IDEM_TTL_SECONDS = 24 * 3600;
/** An approval commits as one applyBatch, which takes at most this many objects (D2-30). */
export const MAX_APPROVAL_OBJECTS = MAX_BATCH_OBJECTS;
/** A DynamoDB transaction holds at most 100 actions. */
export const MAX_TXN_ACTIONS = 100;
/** The accepted-proposal contribution credit adds an event row and the counters (contrib.js); reserved so a decision never overflows. */
export const CONTRIB_RESERVE = 6;

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

// ---- keys -----------------------------------------------------------------------------------------------------------------
export const proposalKeys = (id) => ({ PK: `PROP#${id}`, SK: "META" });
export const idemKeys = (principal, key) => ({ PK: `IDEM#${principal}#${sha256Hex(key)}`, SK: "META" });
export const auditIdOf = (id) => `proposal:${id}`;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * The smallest ULID of the millisecond `ms` (the 10-character time prefix, then zeros): a GSI1SK lower bound for "created after". Encoded here
 * rather than taken from the monotonic factory, which clamps an earlier time up to its last one.
 */
export function ulidFloor(ms) {
  let t = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out + "0".repeat(16);
}

// ---- the document ---------------------------------------------------------------------------------------------------------
/** sha256 hex of the canonical { id, rev, state, base_versions, ops }: the If-Match token of the amend, withdraw and decision routes. */
export const proposalEtag = (p) => contentHash({ id: p.id, rev: p.rev, state: p.state, base_versions: p.base_versions, ops: p.ops });

/**
 * A new proposal document (editing design 5.2). `subject` is the page it is about ({cls, handle, gramps_id}) or null; `targets` are the stored
 * objects it touches ("Class:handle"), sorted. `warnings` are the semantic warnings that do not block.
 */
export function newProposal({ id, actor, origin, kind, subject, targets, base_versions, ops, summary, note, warnings, at }) {
  const p = {
    id, rev: 1, state: "pending", kind, proposer: { id: actor.id, label: actor.label }, origin, subject, targets, base_versions, ops, summary,
    ...(note ? { note } : {}), warnings: warnings ?? [], created_at: at, updated_at: at,
  };
  return { ...p, etag: proposalEtag(p) };
}

/** What `can` the viewer do with a proposal. A proposer amends and withdraws while it is open; an admin decides; comments are for the circle. */
export function proposalCan(p, actor) {
  const mine = p.proposer?.id === actor.id;
  const open = OPEN_STATES.includes(p.state);
  return { amend: mine && open, withdraw: mine && open, decide: actor.admin === true && (p.state === "pending" || p.state === "stale"), comment: true };
}

/** A ProposalView: the proposal plus `can` and `stale` (computed on read by comparing base_versions with the current versions; false at submit). */
export const proposalView = (p, actor, { stale = false } = {}) => ({ ...p, can: proposalCan(p, actor), stale });

// ---- items ----------------------------------------------------------------------------------------------------------------
/** The puts of a new proposal: META, IDX#BY and one IDX#REC per target. Each is guarded so an id can never be written twice. */
export function proposalPuts(p) {
  const base = { entity: "proposal", proposal: p };
  const guard = { condition: "attribute_not_exists(PK)", tag: "changes:proposal" };
  return [
    { item: { ...proposalKeys(p.id), GSI1PK: `PROPQ#${p.state}`, GSI1SK: p.id, ...base }, ...guard },
    { item: { PK: `PROP#${p.id}`, SK: "IDX#BY", GSI1PK: `PROPBY#${p.proposer.id}`, GSI1SK: p.id, ...base }, ...guard },
    ...p.targets.map((k) => ({ item: { PK: `PROP#${p.id}`, SK: `IDX#REC#${k}`, GSI1PK: `PROPREC#${k}`, GSI1SK: p.id, ...base }, ...guard })),
  ];
}

/** The AUDIT#proposal:<ulid> item for a state change; `op` is proposal.create | .amend | .withdraw | .decide | .stale | .supersede. */
export function proposalAuditItem({ op, id, principalId, at, uid, table, before = null, after }) {
  return { item: auditItem({ op, id: auditIdOf(id), principalId, at, before, after }, uid, table), tag: "changes:audit" };
}

/** The generic route receipt (IDEM#): written in the same transaction as the change, so a replay finds it exactly when the change committed. */
export function idemPut({ principal, key, requestHash, result, at, nowMs }) {
  return { item: { ...idemKeys(principal, key), entity: "idem", requestHash, result, at, ttl: Math.floor(nowMs / 1000) + IDEM_TTL_SECONDS }, condition: "attribute_not_exists(PK)", tag: "changes:idem" };
}

// ---- limits ---------------------------------------------------------------------------------------------------------------
/** How many proposals `principal` created in the last 24 hours (one GSI1 Query on PROPBY#<principal>, at most PROPOSAL_RATE_LIMIT counted). */
export async function recentProposalCount(ctx, principal) {
  const res = await ctx.ddb.send(new ctx.cmds.QueryCommand({
    TableName: ctx.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk AND GSI1SK > :after", Select: "COUNT", Limit: PROPOSAL_RATE_LIMIT,
    ExpressionAttributeValues: { ":pk": `PROPBY#${principal}`, ":after": ulidFloor(ctx.now() - PROPOSAL_RATE_WINDOW_MS) },
  }));
  return res.Count ?? (res.Items ?? []).length;
}

/**
 * The transaction actions an approval of this proposal would take (D2-30, refused at submit with 422 proposal_too_large, never at approval):
 * applyBatch's fixed items (SYNC#HEAD, the batch receipt, the audit) plus the destructive budget counter when anything is deleted, two items per
 * written object (head and log) and one more for a create or a delete (the GID claim, or the retire), the proposal META, its IDX#BY, one IDX#REC
 * per target and the proposal audit, and the contribution reserve.
 */
export function approvalActions({ created = 0, updated = 0, deleted = 0, targets = 0 }) {
  return FIXED_TXN_ITEMS + (deleted > 0 ? 1 : 0) + created * 3 + updated * 2 + deleted * 3 + 1 + 1 + targets + 1 + CONTRIB_RESERVE;
}

/** True when an approval could not commit in one transaction. */
export const proposalTooLarge = (counts) => counts.created + counts.updated + counts.deleted > MAX_APPROVAL_OBJECTS || approvalActions(counts) > MAX_TXN_ACTIONS;
