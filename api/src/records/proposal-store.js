// The proposal store routes (HFY-TSK-184, proposal-store-api; editing design 7.4, BRD2 D2-13, D2-30, reviews PS-09 and R2-28).
//
//   GET    /api/proposals?view=queue|mine|about-me&state=&cursor=&limit=   the lists; queue is admin-only (403 for anyone else)
//   GET    /api/proposals/:id                                              ProposalView + { rebase }; 404 outside the visibility set
//   PATCH  /api/proposals/:id            If-Match: etag                    the proposer amends: rev + 1, back to pending
//   POST   /api/proposals/:id/withdraw   If-Match: etag                    the proposer withdraws
//   createSystem(ctx, input)                                               a system proposal for the access-request flow (not a route)
//
// POST /api/proposals/:id/decision is proposal-decision-api's. The document, its items and the etag live in proposals.js; this file reads and
// rewrites them. Every state change here is ONE transaction: META (moved between PROPQ#<state> partitions), IDX#BY, every IDX#REC copy and the
// AUDIT#proposal item, with META conditioned on the etag that was read (a concurrent change cancels the write: 412 with the fresh view).
//
// The visibility set (R2-28, PS-09): the proposer, every admin, and a member whose own Person is targeted or who is a spouse or child of a
// targeted Family. Anyone else gets 404, as for a proposal that does not exist. The same rule gates the comments of a `proposal:<ulid>` thread.
// Nothing in a list or a detail is shown outside it.
import { HttpError, json } from "../http.js";
import { TxnCancelled, queryPartition, transact } from "../txn.js";
import { contentHash, rebaseOps } from "./ops.js";
import { createRecordGuard } from "./guard.js";
import { get } from "./index.js";
import { ownPerson } from "./read.js";
import { relationView, targetsAboutMe } from "./edit-bundle.js";
import { existingKey, headerOf, keyParts, parseRequest, pick, planChanges, problem, sortedUnique, subjectOf } from "./changes.js";
import {
  MAX_PROPOSAL_BYTES, MAX_TXN_ACTIONS, OPEN_STATES, PROPOSAL_STATES, SYSTEM_ORIGIN, SYSTEM_PROPOSER, amendedProposal, idemKeys, idemPut, newProposal, ownersOf, proposalAuditItem,
  proposalKeys, proposalPuts, proposalRewrite, proposalView, withState,
} from "./proposals.js";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const LIST_VIEWS = Object.freeze(["queue", "mine", "about-me"]);
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
/** The states a queue shows when no `state` is asked for: what an admin can decide. */
export const QUEUE_STATES = Object.freeze(["pending"]);
const MAX_ABOUT_FAMILIES = 30;
const BODY_FIELDS = new Set(["ops", "base_versions", "note"]);

const notFound = () => new HttpError(404, "not_found", "no such suggestion");
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");

// ---- reading and visibility -----------------------------------------------------------------------------------------------------
/** The stored proposal document (a consistent read of PROP#<id>/META), or null. */
export async function loadProposal(ctx, id) {
  if (typeof id !== "string" || !ULID_RE.test(id)) return null;
  const res = await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: proposalKeys(id), ConsistentRead: true }));
  const p = res.Item?.entity === "proposal" ? res.Item.proposal : null;
  return isObj(p) && p.id === id ? p : null;
}

/** The viewer's side of the visibility rule, memoised for one request: their own Person and the Family checks. */
function circleFor(ctx, actor) {
  const related = new Map();
  let own;
  return {
    /** Is `p` inside the visibility set of the viewer? */
    async sees(p) {
      if (actor.admin === true || p.proposer?.id === actor.id) return true;
      if (own === undefined) own = (await ownPerson(ctx, actor)) ?? null;
      return targetsAboutMe(own, p.targets, relationView(ctx), related);
    },
    async own() {
      if (own === undefined) own = (await ownPerson(ctx, actor)) ?? null;
      return own;
    },
  };
}

/**
 * The proposal `id` when `actor` may see it, else null (a missing proposal and a hidden one are the same answer). The thread of a
 * `proposal:<ulid>` comment subject calls this for list, create, edit and react.
 */
export async function visibleProposal(ctx, actor, id) {
  if (!actor?.id) return null;
  const p = await loadProposal(ctx, id);
  if (!p) return null;
  return (await circleFor(ctx, actor).sees(p)) ? p : null;
}

/**
 * Everyone who may see `p`, as principal ids: the proposer, its owners[] and the admins. The mention and reply producers deliver to nobody else
 * (PS-09). `admins` is an iterable of ids (auth.js getAdmins); without it the set holds no admin, which fails closed.
 */
export async function circleIds(p, admins) {
  const out = new Set([p.proposer?.id, ...arr(p.owners)].filter((x) => typeof x === "string" && x));
  if (admins) for (const a of await admins()) if (typeof a === "string" && a) out.add(a);
  return out;
}

/** True when any base version is behind the store (the page moved on, or was deleted). Decided proposals are never stale. */
async function staleOf(ctx, p, memo = new Map()) {
  if (!OPEN_STATES.includes(p.state)) return false;
  // read_versions (a relationship proposal): the objects the compile read but its ops leave alone; a proposal built on a view that moved is stale too.
  for (const [k, base] of [...Object.entries(p.base_versions ?? {}), ...Object.entries(p.read_versions ?? {})]) {
    if (!memo.has(k)) {
      const [cls, handle] = keyParts(k);
      memo.set(k, get(ctx, cls, handle).then((h) => h?.version ?? null));
    }
    if ((await memo.get(k)) !== base) return true;
  }
  return false;
}

/** The view for `actor`. owners[] (other people's ids) and request_id stay with the proposer and the admins (D2-13). */
const viewOf = async (ctx, actor, p, memo) => {
  const view = proposalView(p, actor, { stale: await staleOf(ctx, p, memo) });
  if (actor.admin === true || p.proposer?.id === actor.id) return view;
  const { owners, request_id: requestId, ...rest } = view; // eslint-disable-line no-unused-vars
  return rest;
};

/** If-Match as a bare etag (quotes and a weak prefix stripped), or null when the header is absent. */
function ifMatchOf(c) {
  const raw = headerOf(c.event?.headers, "if-match");
  if (raw === undefined) return null;
  return raw.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}
const replyHeaders = (p) => ({ etag: `"${p.etag}"`, "cache-control": "private, no-store", vary: "Cookie" });

// ---- GET /api/proposals -----------------------------------------------------------------------------------------------------------
function limitOf(raw) {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw problem(400, "validation", `limit is a whole number from 1 to ${MAX_LIMIT}`, { errors: [{ pointer: "/limit", detail: "limit is out of range" }] });
  return n;
}
function cursorOf(raw, view) {
  if (raw === undefined || raw === "") return undefined;
  let text;
  try { text = unb64(String(raw)); } catch { text = ""; }
  const m = /^([a-z-]+):([0-9A-HJKMNP-TV-Z]{26})$/.exec(text);
  if (!m || m[1] !== view) throw new HttpError(400, "cursor_invalid", "that cursor is not valid for this list");
  return m[2];
}

/** The partitions a list reads, and whether it reads them oldest first. */
async function partitionsFor(c, view, states, circle) {
  const { actor } = c;
  if (view === "queue") return { pks: states.map((s) => `PROPQ#${s}`), forward: true, filterState: false };
  if (view === "mine") return { pks: [`PROPBY#${actor.id}`], forward: false, filterState: true };
  const own = await circle.own();
  if (!own) return { pks: [], forward: false, filterState: true };
  const keys = [`Person:${own.handle}`];
  for (const h of [...arr(own.obj.family_list), ...arr(own.obj.parent_family_list)]) if (typeof h === "string" && h && keys.length <= MAX_ABOUT_FAMILIES) keys.push(`Family:${h}`);
  return { pks: [...new Set(keys)].map((k) => `PROPREC#${k}`), forward: false, filterState: true };
}

/** GET /api/proposals */
export async function proposalsList(c) {
  const ctx = c.store;
  const { actor } = c;
  const view = c.query.view ?? "mine";
  if (!LIST_VIEWS.includes(view)) throw problem(400, "validation", "view is queue, mine or about-me", { errors: [{ pointer: "/view", detail: "view is queue, mine or about-me" }] });
  const state = c.query.state;
  if (state === "stale") throw problem(400, "validation", "stale is a flag on a suggestion, not a state: filter on `stale`", { errors: [{ pointer: "/state", detail: "stale is computed on read; ask for pending and filter on the stale flag" }] });
  if (state !== undefined && state !== "" && !PROPOSAL_STATES.includes(state)) throw problem(400, "validation", "that state is not known", { errors: [{ pointer: "/state", detail: "state is not known" }] });
  if (view === "queue" && actor.admin !== true) throw new HttpError(403, "not_admin", "only an admin can see the queue");
  const limit = limitOf(c.query.limit);
  const after = cursorOf(c.query.cursor, view);
  const wanted = state ? [state] : null;
  const circle = circleFor(ctx, actor);
  const { pks, forward, filterState } = await partitionsFor(c, view, wanted ?? QUEUE_STATES, circle);

  const found = new Map();
  for (const pk of pks) {
    const rows = await queryPartition(ctx.ddb, ctx.cmds, ctx.table, {
      pk, after, forward, want: limit + 1,
      accept: (it) => isObj(it.proposal) && typeof it.proposal.id === "string" && (!filterState || !wanted || wanted.includes(it.proposal.state)),
    });
    for (const it of rows) found.set(it.proposal.id, it.proposal);
  }
  const ordered = [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!forward) ordered.reverse();
  const page = [];
  const memo = new Map();
  for (const p of ordered) {
    if (page.length > limit) break;
    if (view !== "queue" && !(await circle.sees(p))) continue; // defence in depth: every row of a personal list is inside the set
    page.push(p);
  }
  const more = page.length > limit;
  const items = [];
  for (const p of page.slice(0, limit)) items.push(await viewOf(ctx, actor, p, memo));
  const cursor = more ? b64(`${view}:${items[items.length - 1].id}`) : undefined;
  return { status: 200, body: { items, ...(cursor ? { cursor } : {}) }, headers: { "cache-control": "private, no-store" } };
}

// ---- GET /api/proposals/:id ---------------------------------------------------------------------------------------------------------
async function rebaseOf(ctx, actor, p) {
  if (!OPEN_STATES.includes(p.state)) return { status: "current", conflicts: [] };
  const keys = sortedUnique(arr(p.ops).map(existingKey).filter(Boolean));
  const objects = {};
  const versions = {};
  const gone = [];
  for (const k of keys) {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    if (!head) { gone.push(k); continue; }
    objects[k] = head.obj;
    versions[k] = head.version;
  }
  const rows = gone.map((k) => ({ opId: arr(p.ops).find((o) => o.obj === k)?.id ?? null, obj: k, path: "", reason: "deleted" }));
  let status;
  if (gone.length) status = "conflict";
  else {
    const r = rebaseOps(p.ops, objects, { versions, baseVersions: p.base_versions });
    status = r.status;
    for (const x of r.conflicts) rows.push({ opId: x.opId, obj: x.obj, path: x.path ?? "", reason: x.reason, base: x.base, current: x.current, proposed: x.proposed });
  }
  // The stored values stay with the admins: another viewer learns where the conflict is, not what the page now says.
  const conflicts = actor.admin === true ? rows : rows.map(({ opId, obj, path, reason, proposed }) => ({ opId, obj, path, reason, ...(proposed !== undefined ? { proposed } : {}) }));
  return { status, conflicts };
}

/** GET /api/proposals/:id */
export async function proposalsGet(c) {
  const ctx = c.store;
  const p = await visibleProposal(ctx, c.actor, c.params.id);
  if (!p) throw notFound();
  const body = { ...(await viewOf(ctx, c.actor, p)), rebase: await rebaseOf(ctx, c.actor, p) };
  return json(200, body, replyHeaders(p));
}

// ---- the writers: amend and withdraw ------------------------------------------------------------------------------------------------
/** The proposer's own open proposal, with the If-Match checked: 404, 403, 409 not_amendable, 428, 412 (with the fresh view), in that order. */
async function loadForWrite(c, { verb }) {
  const ctx = c.store;
  const p = await visibleProposal(ctx, c.actor, c.params.id);
  if (!p) throw notFound();
  if (p.proposer?.id !== c.actor.id) throw new HttpError(403, "not_allowed", `only the person who made this suggestion can ${verb} it`);
  if (!OPEN_STATES.includes(p.state)) throw new HttpError(409, verb === "amend" ? "not_amendable" : "invalid_state", "this suggestion was already handled");
  const given = ifMatchOf(c);
  if (given === null) throw new HttpError(428, "precondition_required", "send the If-Match header with the etag you read");
  if (given !== p.etag) throw await preconditionFailed(c, p);
  return p;
}
async function preconditionFailed(c, p) {
  return new HttpError(412, "precondition_failed", "this suggestion changed since you opened it", { proposal: await viewOf(c.store, c.actor, p) });
}

/** Commits `{ puts, deletes }` of a state change; a failed etag is a 412 with the document as it is now. */
async function commitRewrite(c, prev, fragment, audit) {
  const ctx = c.store;
  const actions = fragment.puts.length + fragment.deletes.length + 1; // the audit item
  if (actions > MAX_TXN_ACTIONS) throw problem(413, "too_large", "the suggestion touches too many pages to change in one step");
  try {
    await transact(ctx.ddb, ctx.cmds, ctx.table, { puts: [...fragment.puts, audit], deletes: fragment.deletes }, ctx.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) {
      const fresh = await loadProposal(ctx, prev.id);
      if (fresh) throw await preconditionFailed(c, fresh);
      throw notFound();
    }
    if (e instanceof TxnCancelled) throw new HttpError(503, "unavailable", "the store is busy; try again");
    throw e;
  }
}

/** PATCH /api/proposals/:id  { ops, base_versions, note? } with If-Match: the full resulting state goes through the guard before anything is written. */
export async function proposalsAmend(c) {
  const ctx = c.store;
  const { actor } = c;
  const prev = await loadForWrite(c, { verb: "amend" });
  const body = isObj(c.body) ? c.body : {};
  const unknown = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (unknown.length) throw problem(400, "validation", "the request is not valid", { errors: unknown.map((k) => ({ pointer: `/${k}`, detail: "not a field of this request" })) });
  const guard = createRecordGuard({ dob: true, log: ctx.log });
  const target = prev.subject?.cls && prev.subject?.handle ? `${prev.subject.cls}:${prev.subject.handle}` : undefined;
  // parseRequest is POST /api/changes' own parser: shape, size caps, R-18 over the op text. `dry_run` only lifts the Idempotency-Key requirement.
  const parsed = parseRequest({ ...c, body: { ops: body.ops, ...(body.base_versions !== undefined ? { base_versions: body.base_versions } : {}), ...(body.note !== undefined ? { note: body.note } : {}), ...(target ? { target } : {}), dry_run: true } }, guard);
  const req = { ...parsed, route: "review", dry_run: false };
  const nowMs = ctx.now();
  const planned = await planChanges(c, req, nowMs, guard, { skipRateLimit: true }); // the full resulting state, guarded (422 contact_info | dob_not_allowed | never_in_cloud)
  if (!planned.review) throw problem(400, "validation", "these edits change nothing", { errors: [{ pointer: "/ops", detail: "the suggestion would change nothing" }] });
  const review = planned.review;
  const at = new Date(nowMs).toISOString();
  const next = amendedProposal(prev, {
    kind: review.ops.some((o) => o.op === "create") ? "create" : "edit",
    subject: subjectOf(req, planned.stored, review.ops) ?? prev.subject,
    targets: review.targets,
    owners: await ownersOf(ctx, review.targets, planned.stored),
    base_versions: pick(req.base_versions, sortedUnique(review.ops.map(existingKey).filter(Boolean))),
    ops: review.ops, summary: planned.plan.review.flatMap((g) => g.summary), note: body.note !== undefined ? req.note ?? "" : undefined, warnings: review.warnings, at,
  });
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_PROPOSAL_BYTES) throw problem(413, "too_large", "the suggestion is too large");
  const audit = proposalAuditItem({ op: "proposal.amend", id: prev.id, principalId: actor.id, at, uid: ctx.uid(), table: ctx.table, before: { state: prev.state, rev: prev.rev }, after: { state: next.state, rev: next.rev, targets: next.targets.length } });
  await commitRewrite(c, prev, proposalRewrite(prev, next), audit);
  return { status: 200, body: await viewOf(ctx, actor, next), headers: replyHeaders(next) };
}

/** POST /api/proposals/:id/withdraw  with If-Match: the proposer takes the suggestion back. */
export async function proposalsWithdraw(c) {
  const ctx = c.store;
  const { actor } = c;
  const prev = await loadForWrite(c, { verb: "withdraw" });
  const at = new Date(ctx.now()).toISOString();
  const next = withState(prev, "withdrawn", at);
  const audit = proposalAuditItem({ op: "proposal.withdraw", id: prev.id, principalId: actor.id, at, uid: ctx.uid(), table: ctx.table, before: { state: prev.state, rev: prev.rev }, after: { state: next.state, rev: next.rev } });
  await commitRewrite(c, prev, proposalRewrite(prev, next), audit);
  return { status: 200, body: await viewOf(ctx, actor, next), headers: replyHeaders(next) };
}

// ---- system proposals ----------------------------------------------------------------------------------------------------------------
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * proposals.createSystem({ kind: "create" | "edit", ops, origin: "access_request", requestId, base_versions?, note?, target? }): a proposal made by the
 * site itself for the access-request flow (surfaces 7.4). `ctx` is the record-store context (the handler's `store`). The ops go through the same
 * pipeline as a member's submission (shape, caps, R-18, the engine, the Gramps rules, the guard over the resulting objects) as an admin would see
 * the store; it stays a proposal, and an admin decides it like any other. One request id makes one proposal: a repeat returns the first. The
 * document carries `origin: "access_request"` and `request_id`, which the approval hands to the completeAccessRequest hook (approvalHookFragment).
 * `onSubmitted(proposal)` runs after the commit (the flow's own admin notice); its failure is never the caller's.
 */
export async function createSystem(ctx, input = {}, { onSubmitted } = {}) {
  const { kind, ops, origin, requestId } = input;
  const bad = (pointer, detail) => problem(400, "validation", "the request is not valid", { errors: [{ pointer, detail }] });
  if (kind !== "create" && kind !== "edit") throw bad("/kind", "kind is create or edit");
  if (origin !== SYSTEM_ORIGIN) throw bad("/origin", `origin is ${SYSTEM_ORIGIN}`);
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) throw bad("/requestId", "requestId is 1 to 64 letters, digits, _ or -");
  const guard = createRecordGuard({ dob: true, log: ctx.log });
  const actor = { id: SYSTEM_PROPOSER.id, label: SYSTEM_PROPOSER.label, admin: true };
  const c = { actor, store: ctx, event: {}, body: { ops, base_versions: input.base_versions ?? {}, ...(input.note ? { note: input.note } : {}), ...(input.target ? { target: input.target } : {}), dry_run: true } };
  const req = { ...parseRequest(c, guard), route: "review", dry_run: false };
  if (req.ops.some((o) => o.op === "create") !== (kind === "create")) throw bad("/kind", kind === "create" ? "a create proposal creates an object" : "an edit proposal creates nothing");

  const key = `${SYSTEM_ORIGIN}:${requestId}`;
  const requestHash = contentHash({ kind, ops: req.ops, base_versions: req.base_versions, note: req.note ?? null, target: req.target ?? null });
  const reqKeys = { PK: `PROPREQ#${requestId}`, SK: "META" };
  const replay = async () => {
    const get1 = async (Key) => (await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key, ConsistentRead: true }))).Item;
    const item = (await get1(idemKeys(SYSTEM_PROPOSER.id, key))) ?? (await get1(reqKeys)); // the IDEM# receipt expires; PROPREQ# does not
    if (!item) return null;
    if (item.requestHash !== requestHash) throw problem(422, "idempotency_mismatch", "that request id was used with a different suggestion");
    return await loadProposal(ctx, item.result?.body?.id ?? item.id);
  };
  const first = await replay();
  if (first) return first;

  const nowMs = ctx.now();
  const planned = await planChanges(c, req, nowMs, guard, { skipRateLimit: true });
  if (!planned.review) throw bad("/ops", "the suggestion would change nothing");
  const review = planned.review;
  const at = new Date(nowMs).toISOString();
  const doc = newProposal({
    id: ctx.uid(), actor: SYSTEM_PROPOSER, origin: SYSTEM_ORIGIN, kind, subject: subjectOf(req, planned.stored, review.ops), targets: review.targets,
    base_versions: pick(req.base_versions, sortedUnique(review.ops.map(existingKey).filter(Boolean))), ops: review.ops, summary: planned.plan.review.flatMap((g) => g.summary),
    note: req.note, warnings: review.warnings, at, owners: await ownersOf(ctx, review.targets, planned.stored), requestId,
  });
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_PROPOSAL_BYTES) throw problem(413, "too_large", "the suggestion is too large");
  const puts = [
    idemPut({ principal: SYSTEM_PROPOSER.id, key, requestHash, result: { status: 201, body: { id: doc.id } }, at, nowMs }),
    { item: { ...reqKeys, entity: "proposal_request", id: doc.id, requestHash }, condition: "attribute_not_exists(PK)", tag: "changes:proposal_request" },
    ...proposalPuts(doc),
    proposalAuditItem({ op: "proposal.create", id: doc.id, principalId: SYSTEM_PROPOSER.id, at, uid: ctx.uid(), table: ctx.table, after: { state: doc.state, rev: doc.rev, targets: doc.targets.length, origin: SYSTEM_ORIGIN } }),
  ];
  try {
    await transact(ctx.ddb, ctx.cmds, ctx.table, { puts }, ctx.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) {
      const raced = await replay(); // another call with this request id committed first
      if (raced) return raced;
    }
    if (e instanceof TxnCancelled) throw new HttpError(503, "unavailable", "the store is busy; try again");
    throw e;
  }
  try { await onSubmitted?.(doc); } catch { /* a notice is a nicety and must not fail a committed write */ }
  return doc;
}

/** The proposals domain as the access-request flow imports it: `proposals.createSystem(ctx, { kind, ops, origin, requestId })`. */
export const proposals = Object.freeze({ createSystem });
