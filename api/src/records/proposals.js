// The proposal document and its items (HFY-TSK-183, edit-api-changes; editing design 5.2, 7.3, 7.4; BRD2 section 4.2 "Editing (proposals)", D2-30).
//
// POST /api/changes is the first writer of these items; proposal-store-api (reads, amend, withdraw) and proposal-decision-api (decide) build on the
// same layout, so the keys, the document and the etag live here and nowhere else:
//   PROP#<ulid> / META            GSI1 PROPQ#<state> / <ulid>        the proposal, in its state queue
//   PROP#<ulid> / IDX#BY          GSI1 PROPBY#<principal> / <ulid>   a full copy, for the proposer's list and the 24-hour rate limit
//   PROP#<ulid> / IDX#REC#<k>     GSI1 PROPREC#<k> / <ulid>          a full copy per target object (<k> = "Class:handle"), for pending[] on a page
//   IDEM#<principal>#<sha256(key)> / META                             the generic route receipt: { requestHash, result: { status, body } }, 24 h
//   AUDIT#proposal:<ulid>                                             one audit item per state change (proposal.create here; .decide and .stale in proposal-decision.js)
// A state change rewrites META and every IDX copy in one transaction. The document never holds an email (HFY-R68): the proposer label is the
// session label.
import { createHash } from "node:crypto";
import { auditItem } from "../txn.js";
import { FIXED_TXN_ITEMS, MAX_OPS as MAX_BATCH_OBJECTS } from "../sync/store.js";
import { contentHash } from "./ops.js";
import { get } from "./index.js";

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
export function newProposal({ id, actor, origin, kind, subject, targets, base_versions, ops, summary, note, warnings, at, owners, requestId, intent, read_versions }) {
  const p = {
    id, rev: 1, state: "pending", kind, proposer: { id: actor.id, label: actor.label }, origin, subject, targets, owners: ownersList(owners), base_versions, ops, summary,
    ...(intent !== undefined ? { intent } : {}), ...(read_versions !== undefined ? { read_versions } : {}),
    ...(note ? { note } : {}), ...(requestId ? { request_id: requestId } : {}), warnings: warnings ?? [], created_at: at, updated_at: at,
  };
  return { ...p, etag: proposalEtag(p) };
}

/** `owners[]`: the gramps ids of the owners of every targeted page (contrib-read's default proposalVisible reads it), sorted and unique. */
export const ownersList = (owners) => [...new Set((owners ?? []).filter((x) => typeof x === "string" && x))].sort();

/** The same proposal in another state (withdraw, decide, stale, supersede): `rev` stays, the etag follows the state. `patch` may add decision fields. */
export function withState(p, state, at, patch = {}) {
  const next = { ...p, ...patch, state, updated_at: at };
  delete next.etag;
  return { ...next, etag: proposalEtag(next) };
}

/** The proposal after an amend: rev + 1, back to pending, the new ops, targets and summary. The id, proposer, origin and created_at stay. */
export function amendedProposal(p, { kind, subject, targets, owners, base_versions, ops, summary, note, warnings, at }) {
  const next = {
    ...p, kind, subject, targets, owners: ownersList(owners), base_versions, ops, summary, warnings: warnings ?? [], rev: p.rev + 1, state: "pending", updated_at: at,
  };
  if (note !== undefined) { if (note) next.note = note; else delete next.note; }
  delete next.etag;
  return { ...next, etag: proposalEtag(next) };
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

/**
 * The writes of a state change (AC3): META moves to its new PROPQ#<state> partition and IDX#BY and every IDX#REC copy follow in the same
 * transaction, so no copy ever shows an older state than META. META is written only if it still holds `prev` (compare-and-set on the etag, tag
 * "proposal:cas"); a target the new document no longer has loses its IDX#REC item.
 */
export function proposalRewrite(prev, next, { pinState = false } = {}) {
  const base = { entity: "proposal", proposal: next };
  // `pinState` (a decision, HFY-TSK-209) also pins the state it was read in: the proposal is still pending (or stale) when the write commits.
  const cas = pinState
    ? { condition: "attribute_exists(PK) AND #p.#e = :etag AND #p.#st = :st", names: { "#p": "proposal", "#e": "etag", "#st": "state" }, values: { ":etag": prev.etag, ":st": prev.state }, tag: "proposal:cas" }
    : { condition: "attribute_exists(PK) AND #p.#e = :etag", names: { "#p": "proposal", "#e": "etag" }, values: { ":etag": prev.etag }, tag: "proposal:cas" };
  const exists = { condition: "attribute_exists(PK)", tag: "proposal:copy" };
  const puts = [
    { item: { ...proposalKeys(next.id), GSI1PK: `PROPQ#${next.state}`, GSI1SK: next.id, ...base }, ...cas },
    { item: { PK: `PROP#${next.id}`, SK: "IDX#BY", GSI1PK: `PROPBY#${next.proposer.id}`, GSI1SK: next.id, ...base }, ...exists },
    ...next.targets.map((k) => ({ item: { PK: `PROP#${next.id}`, SK: `IDX#REC#${k}`, GSI1PK: `PROPREC#${k}`, GSI1SK: next.id, ...base } })),
  ];
  const keep = new Set(next.targets);
  const deletes = prev.targets.filter((k) => !keep.has(k)).map((k) => ({ PK: `PROP#${next.id}`, SK: `IDX#REC#${k}` }));
  return { puts, deletes };
}

/** The AUDIT#proposal:<ulid> item for a state change; `op` is proposal.create | .amend | .withdraw | .decide | .stale | .supersede. */
export function proposalAuditItem({ op, id, principalId, at, uid, table, before = null, after, reason }) {
  return { item: auditItem({ op, id: auditIdOf(id), principalId, at, before, after, ...(reason !== undefined ? { reason } : {}) }, uid, table), tag: "changes:audit" };
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

// ---- owners -----------------------------------------------------------------------------------------------------------------
const MAX_OWNER_PEOPLE = 60;
const gidOf = (head) => (typeof head?.obj?.gramps_id === "string" && head.obj.gramps_id ? head.obj.gramps_id : null);

/**
 * The gramps ids of the owners of every page `targets` ("Class:handle") names (the same circle pendingFor and GET use): a targeted Person is its own
 * owner, and a targeted Family is owned by its spouses and children. Any other target class (a shared Event, Place, Source...) has no owner. `known`
 * maps keys already loaded ({obj}) so the common case reads nothing; the rest is bounded (MAX_OWNER_PEOPLE people).
 */
export async function ownersOf(ctx, targets, known = new Map()) {
  const load = async (cls, handle) => known.get(`${cls}:${handle}`) ?? (await get(ctx, cls, handle));
  const ids = new Set();
  const people = new Set();
  for (const k of targets ?? []) {
    const i = typeof k === "string" ? k.indexOf(":") : -1;
    if (i < 0) continue;
    const cls = k.slice(0, i);
    const handle = k.slice(i + 1);
    if (cls === "Person") people.add(handle);
    else if (cls === "Family") {
      const f = await load("Family", handle);
      if (!f) continue;
      for (const h of [f.obj.father_handle, f.obj.mother_handle, ...(Array.isArray(f.obj.child_ref_list) ? f.obj.child_ref_list : []).map((r) => r?.ref)]) {
        if (typeof h === "string" && h) people.add(h);
      }
    }
  }
  for (const h of [...people].slice(0, MAX_OWNER_PEOPLE)) {
    const gid = gidOf(await load("Person", h));
    if (gid) ids.add(gid);
  }
  return ownersList([...ids]);
}

// ---- system proposals (the access-request flow) ----------------------------------------------------------------------------
/** The proposer of a system proposal. It is not a member and never an email; admins decide it like any other proposal. */
export const SYSTEM_PROPOSER = Object.freeze({ id: "system:access_request", label: "the site" });
export const SYSTEM_ORIGIN = "access_request";

/** The access request a proposal came from, or null (a web or MCP proposal). */
export const accessRequestOf = (p) => (p?.origin === SYSTEM_ORIGIN && typeof p.request_id === "string" && p.request_id ? p.request_id : null);

/**
 * The completeAccessRequest step of an approval (surfaces 7.4). `ctx.completeAccessRequest({ requestId, proposal, grampsId, by, at })` (`by`: the deciding admin, `at`: the batch time) is the access-request
 * domain's link transaction as a transact() fragment { puts, updates, checks, deletes }, which the approval merges into its `extra`, so the link
 * commits or fails with the approval. Null for a proposal that is not from an access request.
 */
export async function approvalHookFragment(ctx, proposal, { grampsId, by, at } = {}) {
  const requestId = accessRequestOf(proposal);
  if (!requestId) return null;
  if (typeof ctx.completeAccessRequest !== "function") return null; // the flow is not wired: io links by hand (surfaces 7.4)
  const fragment = await ctx.completeAccessRequest({ requestId, proposal, grampsId, by, at });
  return fragment ?? null;
}
