// The gates adapter for the approval queue (HFY-TSK-259, review-island; HFY-PLN-002 editing.md section 7.4, BRD2 D2-14 and DEC-E1).
// `createProposalGateSource(api)` implements @io-kit/gates' GateSourceLike `{id, list, decide}` over GET /api/proposals and
// POST /api/proposals/:id/decision, so the review island runs on the kit's `useGateInbox` unchanged. No DOM and no React: a node test pins
// it (tests/proposal-gate-source.test.mjs), and every card it makes must pass the kit's own `parseGateCard`.
//
// Two places where the installed kit (0.1.2) differs from the design text, and what this adapter does about each:
//   - parseGateCard refuses a decision-family card with no `expiresAt` (editing.md 7.4 had said to leave it out). A suggestion never expires
//     (DEC-E7), so `expiresAt` is the latest instant the kit accepts, created + 30 days, with onExpire "regenerate": nothing ever acts on it,
//     and sortByExpiry then orders the queue by creation time, oldest first, which is the order the review wants. The island does not show it.
//   - parseGateCard needs `createdAt` as a UTC timestamp without milliseconds; the proposal's own is an ISO string with them.
// "Ask for changes" is not a gates verdict, so it is `askForChanges` here, called by the card directly, beside `decide`.
import { GateHttpError, GateVerdictError, makeIdempotencyKey } from "@io-kit/gates";
import { ApiError } from "./api.js";

export const PROJECT = "harrisonfamily";
const DAY_MS = 24 * 60 * 60 * 1000;
export const NEVER_EXPIRES_MS = 30 * DAY_MS;

/** The proposal states the API stores (api/src/records/proposals.js PROPOSAL_STATES). `rejected` is read as `declined`, the design's older word. */
export const GATE_STATE = Object.freeze({
  pending: "pending",
  needs_changes: "snoozed",
  stale: "pending",
  approved: "decided",
  declined: "decided",
  rejected: "decided",
  withdrawn: "decided",
  superseded: "superseded",
});

/** The proposal states a gates state asks for (the hook's `state` filter), used when the source was not given its own list. */
export const PROPOSAL_STATES_OF = Object.freeze({
  pending: ["pending", "stale"],
  snoozed: ["needs_changes"],
  decided: ["approved", "declined", "withdrawn"],
  superseded: ["superseded"],
  expired: [],
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

/** A UTC timestamp the kit accepts: `2026-01-02T03:04:05Z`, no milliseconds. Unparseable input is the epoch. */
export function utc(value) {
  const t = typeof value === "number" ? value : Date.parse(value);
  return new Date(Number.isFinite(t) ? t : 0).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The ops that remove a parent, child or spouse link or delete an object (editing.md 7.4 "Destructive approvals", DEC-E9). A hint: the server decides. */
const LINK_PATH = /(^|\/)(parent_family_list|family_list|child_ref_list|father_handle|mother_handle)(\/|$)/;
export function isDestructive(view) {
  return arr(view && view.ops).some((op) => isObj(op) && (op.op === "delete" || (op.op === "remove" && LINK_PATH.test(str(op.path))) || (op.op === "set" && /(^|\/)(father_handle|mother_handle)$/.test(str(op.path)) && !op.value)));
}

/** Is this a connection between people (a relationship) as opposed to a field edit? */
export const isRelationship = (view) => Boolean(view) && (view.kind === "relationship" || arr(view.ops).some((op) => isObj(op) && LINK_PATH.test(str(op.path))));

/** The page the suggestion is about, as a gates `record_id`: the subject's `Class:handle`, else the first target, else the proposal id. */
function recordIdOf(view) {
  const s = view.subject;
  if (isObj(s) && s.cls && s.handle) return `${s.cls}:${s.handle}`;
  return str(arr(view.targets)[0]) || str(view.id);
}

/** The before and after of the set ops, keyed by path, for the card's `diff` (the kit's own diff view is not shown; the island's ProposalCard draws the rows). */
function diffOf(view, drift) {
  const before = {};
  const after = {};
  for (const op of arr(view.ops)) {
    if (!isObj(op) || op.op !== "set") continue;
    const key = `${str(op.obj)}${str(op.path)}`;
    before[key] = op.base === undefined ? null : op.base;
    after[key] = op.value === undefined ? null : op.value;
  }
  return { before, after, renderedAt: utc(view.updated_at || view.created_at), drift };
}

/**
 * A ProposalView as a GateCard (editing.md 7.4 table). The whole view rides along as `hfy`, which is what the island's ProposalCard reads.
 * Every proposal state maps to a state the kit accepts, and the card passes `parseGateCard`.
 */
export function proposalToCard(view) {
  if (!isObj(view) || !str(view.id)) throw new GateVerdictError("a suggestion needs an id");
  const state = GATE_STATE[view.state] ?? "pending";
  const drift = view.state === "stale" || view.stale === true;
  const createdAt = utc(view.created_at);
  const destructive = isDestructive(view);
  const proposer = isObj(view.proposer) ? view.proposer : {};
  const recordId = recordIdOf(view);
  const versions = isObj(view.base_versions) ? view.base_versions : {};
  const note = str(view.note);
  const first = arr(view.summary).map((s) => (isObj(s) ? str(s.text) : str(s))).find(Boolean);
  const card = {
    id: view.id,
    project_id: PROJECT,
    kind: "acceptance",
    family: "decision",
    risk: destructive || isRelationship(view) ? "medium" : "low",
    state,
    title: first || "a suggested change",
    subject: { record_id: recordId, project: PROJECT, version: String(versions[recordId] ?? 0) },
    evidence: [{ label: "suggested by", ref: `person:${str(proposer.id) || "unknown"}` }],
    createdAt,
    expiresAt: utc(Date.parse(createdAt) + NEVER_EXPIRES_MS),
    onExpire: "regenerate",
    requiredAuth: destructive ? "step_up" : "interactive_human",
    diff: diffOf(view, drift),
    hfy: view,
  };
  if (str(view.etag)) card.etag = view.etag;
  if (str(proposer.id)) card.requestedBy = proposer.id;
  if (note) card.why = { summary: note };
  return card;
}

const quote = (etag) => (/^(W\/)?"/.test(etag) ? etag : `"${etag}"`);

/** The fresh card a 412 carries in `details.proposal` (the decision, amend and withdraw routes), or null. */
export function cardFromApiConflict(e) {
  if (!(e instanceof ApiError) || e.status !== 412 || !isObj(e.details) || !isObj(e.details.proposal)) return null;
  try { return proposalToCard(e.details.proposal); } catch { return null; }
}

/** A 412 from the decision route as the kit's GateHttpError, whose body the kit's own `cardFromConflict` reads the fresh card from. */
function asGateError(e) {
  const card = cardFromApiConflict(e);
  return card ? new GateHttpError(412, e.message || "this suggestion changed since you opened it", { card }, "card_changed") : e;
}

const MAX_PAGES = 4;
const PAGE = 50;

/**
 * `createProposalGateSource(api, { view, states, keep })`.
 *   view    "queue" (admins, oldest first) | "mine" | "about-me": GET /api/proposals?view=
 *   states  the proposal states to list; without it the hook's gates `state` filter picks them (PROPOSAL_STATES_OF)
 *   keep    an optional filter over the ProposalViews (the queue's "waiting" and "out of date" chips split the pending list)
 * `list` returns the cards of every asked state; `decide` and `askForChanges` post the decision with the card's etag as If-Match and a fresh
 * Idempotency-Key. Approve may carry an admin's amend in `inputs.amend` ({ops, base_versions}).
 */
export function createProposalGateSource(api, { view = "queue", states, keep, id = `hfy-proposals-${view}` } = {}) {
  async function fetchState(state) {
    const items = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await api.get("/proposals", { query: { view, ...(state ? { state } : {}), limit: PAGE, cursor } });
      items.push(...arr(res && res.items));
      cursor = res && typeof res.cursor === "string" ? res.cursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  async function list(q = {}) {
    const wanted = states || arr(q.state).flatMap((s) => PROPOSAL_STATES_OF[s] || []);
    const asked = wanted.length ? [...new Set(wanted)] : [undefined];
    const seen = new Map();
    for (const state of asked) {
      for (const v of await fetchState(state)) if (isObj(v) && str(v.id) && (!keep || keep(v))) seen.set(v.id, v);
    }
    const sorted = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // ULIDs: oldest first
    if (view !== "queue") sorted.reverse();
    return sorted.map(proposalToCard);
  }

  async function post(input, body) {
    if (!input || !str(input.id)) throw new GateVerdictError("a decision needs the suggestion's id");
    if (!str(input.etag)) throw new GateVerdictError("a decision needs the etag the admin saw");
    if (!str(input.idempotencyKey)) throw new GateVerdictError("a decision needs an idempotency key");
    try {
      return await api.post(`/proposals/${encodeURIComponent(input.id)}/decision`, body, { headers: { "If-Match": quote(input.etag), "Idempotency-Key": input.idempotencyKey } });
    } catch (e) {
      throw asGateError(e);
    }
  }

  return {
    id,
    list,
    /** The gates verdicts the review uses: approve (with an optional amend) and deny (a reason is required). */
    async decide(input) {
      const v = input && input.verdict;
      if (!v || (v.type !== "approve" && v.type !== "deny")) throw new GateVerdictError("a suggestion can be approved or declined here");
      if (v.type === "deny") {
        const reason = str(v.reason).trim();
        if (!reason) throw new GateVerdictError("say why, so the person can follow it");
        return post(input, { verdict: "deny", reason });
      }
      const amend = input.inputs && isObj(input.inputs.amend) ? input.inputs.amend : undefined;
      return post(input, { verdict: "approve", ...(amend ? { amend: { ops: arr(amend.ops), base_versions: isObj(amend.base_versions) ? amend.base_versions : {} } } : {}) });
    },
    /** The proposer's edit (PATCH, If-Match): `ops` and `base_versions` replace the suggestion's, `note` its note. Answers the new ProposalView; a 412 is a GateHttpError with the fresh card. */
    async amend(input) {
      if (!input || !str(input.id) || !str(input.etag)) throw new GateVerdictError("an edit needs the suggestion's id and etag");
      try {
        return await api.patch(`/proposals/${encodeURIComponent(input.id)}`, { ops: arr(input.ops), base_versions: isObj(input.base_versions) ? input.base_versions : {}, ...(typeof input.note === "string" ? { note: input.note } : {}) }, { headers: { "If-Match": quote(input.etag) } });
      } catch (e) {
        throw asGateError(e);
      }
    },
    /** The proposer takes the suggestion back (POST, If-Match). Answers the new ProposalView. */
    async withdraw(input) {
      if (!input || !str(input.id) || !str(input.etag)) throw new GateVerdictError("a withdrawal needs the suggestion's id and etag");
      try {
        return await api.post(`/proposals/${encodeURIComponent(input.id)}/withdraw`, {}, { headers: { "If-Match": quote(input.etag) } });
      } catch (e) {
        throw asGateError(e);
      }
    },
    /** "Ask for changes" is not a gates verdict: the card calls this beside `decide`. A message is required. */
    async askForChanges(input) {
      const reason = str(input && input.reason).trim();
      if (!reason) throw new GateVerdictError("say what you'd like changed, so the person can follow it");
      return post(input, { verdict: "needs_changes", reason });
    },
  };
}

/** A fresh Idempotency-Key for one attempt of one verdict (the kit's own format: `<id>:<verdict>:<nonce>`). */
export const idempotencyKeyFor = (id, verdict) => makeIdempotencyKey(id, verdict);
