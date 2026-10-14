// HFY-TSK-259 (review-island), AC1 and AC2: the proposal gate source (src/lib/proposal-gate-source.js). Every card passes the kit's own
// parseGateCard for every proposal state; the queue lists oldest first; approve, ask for changes and decline send If-Match and an
// Idempotency-Key, decline and ask for changes need text; a 412 becomes a GateHttpError the kit's cardFromConflict turns into the fresh card.
// Synthetic data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GateHttpError, GateVerdictError, cardFromConflict, parseGateCard } from "@io-kit/gates";
import { sortByExpiry } from "@io-kit/gates/react";
import { ApiError, createApi } from "../src/lib/api.js";
import { GATE_STATE, PROJECT, createProposalGateSource, isDestructive, proposalToCard, utc } from "../src/lib/proposal-gate-source.js";
import { ID, STATES, view } from "./fixtures/proposals.mjs";

/** A fake fetch that records requests and answers from `handler(url, init)`. */
function fakeApi(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = await handler(url, init);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status || 200, headers: { "Content-Type": "application/json" } });
  };
  return { api: createApi({ base: "/api", fetchImpl, skipWhenSignedOut: false }), calls };
}

describe("proposalToCard (AC1)", () => {
  for (const state of STATES) {
    it(`a ${state} suggestion passes parseGateCard`, () => {
      const card = proposalToCard(view(1, { state }));
      assert.doesNotThrow(() => parseGateCard(card));
      assert.equal(card.state, GATE_STATE[state]);
      assert.equal(card.project_id, PROJECT);
      assert.equal(card.kind, "acceptance");
      assert.equal(card.family, "decision");
      assert.equal(card.hfy.id, ID(1));
    });
  }

  it("passes for a stale-flagged, a destructive, a relationship, a create and a note-carrying suggestion", () => {
    const variants = [
      view(1, { stale: true }),
      view(2, { ops: [{ id: "o1", op: "remove", obj: "Person:hsyn0002", path: "/parent_family_list/@=hfam0001" }] }),
      view(3, { kind: "relationship", summary: ["adds a person as a child of two people"], ops: [{ id: "o1", op: "add", obj: "Family:hfam0001", path: "/child_ref_list", value: {} }] }),
      view(4, { kind: "create", subject: null, targets: [], base_versions: {}, ops: [{ id: "o1", op: "create", obj: "new:1", cls: "Person", value: { _class: "Person" } }] }),
      view(5, { note: "a note for the reviewer" }),
      view(6, { subject: null, targets: [], base_versions: {}, summary: [] }),
    ];
    for (const v of variants) assert.doesNotThrow(() => parseGateCard(proposalToCard(v)), v.id);
  });

  it("maps the fields as editing.md 7.4 says", () => {
    const stale = proposalToCard(view(1, { state: "stale" }));
    assert.equal(stale.state, "pending");
    assert.equal(stale.diff.drift, true);
    assert.equal(proposalToCard(view(2, { stale: true })).diff.drift, true);
    assert.equal(proposalToCard(view(3)).diff.drift, false);
    assert.equal(proposalToCard(view(4, { state: "needs_changes" })).state, "snoozed");
    for (const s of ["approved", "declined", "withdrawn"]) assert.equal(proposalToCard(view(5, { state: s })).state, "decided");
    assert.equal(proposalToCard(view(6, { state: "superseded" })).state, "superseded");

    const card = proposalToCard(view(1, { note: "please check" }));
    assert.equal(card.id, ID(1));
    assert.equal(card.risk, "low");
    assert.deepEqual(card.subject, { record_id: "Person:hsyn0002", project: PROJECT, version: "4" });
    assert.deepEqual(card.evidence, [{ label: "suggested by", ref: "person:I9001" }]);
    assert.equal(card.onExpire, "regenerate");
    assert.equal(card.requiredAuth, "interactive_human");
    assert.equal(card.etag, view(1).etag);
    assert.equal(card.why.summary, "please check");
    assert.equal(card.title, "change the first name from \"Tess\" to \"Tessa Marie\"");

    const destructive = proposalToCard(view(2, { ops: [{ id: "o1", op: "delete", obj: "Event:hevt0001", base_hash: "0".repeat(64) }] }));
    assert.equal(destructive.risk, "medium");
    assert.equal(destructive.requiredAuth, "step_up");
    assert.equal(proposalToCard(view(3, { kind: "relationship" })).risk, "medium");
  });

  it("isDestructive: a delete or a removed parent, child or spouse link; not a name edit", () => {
    assert.equal(isDestructive(view(1)), false);
    assert.equal(isDestructive(view(1, { ops: [{ op: "delete", obj: "Person:h1" }] })), true);
    assert.equal(isDestructive(view(1, { ops: [{ op: "remove", obj: "Family:h1", path: "/child_ref_list/@ref=h2" }] })), true);
    assert.equal(isDestructive(view(1, { ops: [{ op: "remove", obj: "Person:h1", path: "/note_list/@=hnote" }] })), false);
  });

  it("utc() drops the milliseconds the kit's timestamp check refuses", () => {
    assert.equal(utc("2026-03-01T10:00:00.123Z"), "2026-03-01T10:00:00Z");
    assert.equal(utc("nonsense"), "1970-01-01T00:00:00Z");
  });
});

describe("the queue lists oldest first (AC1)", () => {
  it("sortByExpiry over the adapter's cards is creation order, whatever order the API answers in", async () => {
    const items = [view(3), view(1), view(2)];
    const { api } = fakeApi(async () => ({ status: 200, body: { items } }));
    const source = createProposalGateSource(api, { view: "queue", states: ["pending"] });
    const cards = await source.list({ projects: "all", state: ["pending", "snoozed"] });
    assert.deepEqual(cards.map((c) => c.id), [ID(1), ID(2), ID(3)]);
    assert.deepEqual(sortByExpiry([...cards].reverse()).map((c) => c.id), [ID(1), ID(2), ID(3)]);
    for (const c of cards) assert.doesNotThrow(() => parseGateCard(c));
  });

  it("asks the API for the view and each state; follows the cursor; drops what `keep` refuses; dedupes", async () => {
    const seen = [];
    const { api } = fakeApi(async (url) => {
      seen.push(url);
      const u = new URL(url, "http://x");
      if (u.searchParams.get("state") === "pending" && !u.searchParams.get("cursor")) return { status: 200, body: { items: [view(1), view(2, { stale: true })], cursor: "next" } };
      if (u.searchParams.get("state") === "pending") return { status: 200, body: { items: [view(3)] } };
      return { status: 200, body: { items: [view(2, { state: "stale", stale: true })] } };
    });
    const source = createProposalGateSource(api, { view: "queue", states: ["pending", "stale"], keep: (v) => v.stale !== true });
    const cards = await source.list({});
    assert.deepEqual(cards.map((c) => c.id), [ID(1), ID(3)]);
    assert.ok(seen.every((u) => u.startsWith("/api/proposals?")));
    assert.ok(seen.every((u) => u.includes("view=queue")));
    assert.ok(seen.some((u) => u.includes("state=pending")) && seen.some((u) => u.includes("state=stale")));
    assert.ok(seen.some((u) => u.includes("cursor=next")));
  });

  it("maps the hook's gates state filter when it was given no states of its own", async () => {
    const seen = [];
    const { api } = fakeApi(async (url) => { seen.push(new URL(url, "http://x").searchParams.get("state")); return { status: 200, body: { items: [] } }; });
    await createProposalGateSource(api, { view: "queue" }).list({ projects: "all", state: ["pending", "snoozed"] });
    assert.deepEqual(seen.sort(), ["needs_changes", "pending", "stale"]);
  });

  it("the personal lists are newest first", async () => {
    const { api } = fakeApi(async () => ({ status: 200, body: { items: [view(1), view(2)] } }));
    const cards = await createProposalGateSource(api, { view: "mine", states: ["pending"] }).list({});
    assert.deepEqual(cards.map((c) => c.id), [ID(2), ID(1)]);
  });
});

describe("decisions (AC2)", () => {
  const card = proposalToCard(view(1));
  const input = (verdict, extra = {}) => ({ id: card.id, project: PROJECT, etag: card.etag, verdict, idempotencyKey: `${card.id}:test:1`, ...extra });

  it("approve posts the verdict with If-Match (the etag) and the Idempotency-Key", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: { proposal: view(1, { state: "approved" }), applied: { versions: {} } } }));
    const r = await createProposalGateSource(api).decide(input({ type: "approve" }));
    assert.equal(r.proposal.state, "approved");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/proposals/${ID(1)}/decision`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].headers["If-Match"], `"${card.etag}"`);
    assert.equal(calls[0].headers["Idempotency-Key"], `${card.id}:test:1`);
    assert.deepEqual(calls[0].body, { verdict: "approve" });
  });

  it("approve with an amend carries {ops, base_versions}", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: { proposal: view(1, { state: "approved" }) } }));
    const amend = { ops: [{ id: "a", op: "set", obj: "Person:h1", path: "/x", base: "a", value: "b" }], base_versions: { "Person:h1": 5 } };
    await createProposalGateSource(api).decide(input({ type: "approve" }, { inputs: { amend } }));
    assert.deepEqual(calls[0].body, { verdict: "approve", amend });
    assert.ok(calls[0].headers["If-Match"] && calls[0].headers["Idempotency-Key"]);
  });

  it("decline sends deny with the reason, If-Match and the Idempotency-Key; it needs text", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: { proposal: view(1, { state: "declined" }) } }));
    const source = createProposalGateSource(api);
    await assert.rejects(() => source.decide(input({ type: "deny", reason: "   " })), GateVerdictError);
    assert.equal(calls.length, 0, "nothing is sent without text");
    await source.decide(input({ type: "deny", reason: "  not sure this is right " }));
    assert.deepEqual(calls[0].body, { verdict: "deny", reason: "not sure this is right" });
    assert.equal(calls[0].headers["If-Match"], `"${card.etag}"`);
    assert.equal(calls[0].headers["Idempotency-Key"], `${card.id}:test:1`);
  });

  it("ask for changes sends needs_changes with the reason, If-Match and an Idempotency-Key; it needs text", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: { proposal: view(1, { state: "needs_changes" }) } }));
    const source = createProposalGateSource(api);
    await assert.rejects(() => source.askForChanges({ id: card.id, etag: card.etag, idempotencyKey: "k", reason: "" }), GateVerdictError);
    assert.equal(calls.length, 0);
    await source.askForChanges({ id: card.id, etag: card.etag, idempotencyKey: "k-1", reason: "which cousin?" });
    assert.deepEqual(calls[0].body, { verdict: "needs_changes", reason: "which cousin?" });
    assert.equal(calls[0].headers["If-Match"], `"${card.etag}"`);
    assert.equal(calls[0].headers["Idempotency-Key"], "k-1");
  });

  it("refuses a decision with no etag or no key, and the verdicts the review does not use", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: {} }));
    const source = createProposalGateSource(api);
    await assert.rejects(() => source.decide(input({ type: "approve" }, { etag: "" })), GateVerdictError);
    await assert.rejects(() => source.decide(input({ type: "approve" }, { idempotencyKey: "" })), GateVerdictError);
    await assert.rejects(() => source.decide(input({ type: "snooze", until: "2026-01-01T00:00:00Z" })), GateVerdictError);
    assert.equal(calls.length, 0);
  });

  it("a 412 becomes a GateHttpError whose body the kit's cardFromConflict reads as the fresh card", async () => {
    const fresh = view(1, { rev: 2, etag: "freshetag0000000", state: "pending", note: "edited" });
    const { api } = fakeApi(async () => ({ status: 412, body: { error: "precondition_failed", message: "this suggestion changed since you opened it", details: { proposal: fresh } } }));
    let err;
    try { await createProposalGateSource(api).decide(input({ type: "approve" })); } catch (e) { err = e; }
    assert.ok(err instanceof GateHttpError);
    assert.equal(err.status, 412);
    const next = cardFromConflict(err);
    assert.equal(next.etag, "freshetag0000000");
    assert.equal(next.hfy.note, "edited");
  });

  it("other errors pass through as the API's own (a 409 rebase_conflict, a 401 step_up_required)", async () => {
    for (const [status, code] of [[409, "rebase_conflict"], [401, "step_up_required"], [403, "not_admin"]]) {
      const { api } = fakeApi(async () => ({ status, body: { error: code, message: code } }));
      await assert.rejects(() => createProposalGateSource(api).decide(input({ type: "approve" })), (e) => e instanceof ApiError && e.status === status && e.code === code);
    }
  });
});

describe("the proposer's routes", () => {
  it("amend PATCHes ops, base_versions and note with If-Match; a 412 carries the fresh card", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: view(1, { rev: 2 }) }));
    const source = createProposalGateSource(api, { view: "mine" });
    const r = await source.amend({ id: ID(1), etag: "abc", ops: [{ id: "a" }], base_versions: { "Person:h1": 3 }, note: "hi" });
    assert.equal(r.rev, 2);
    assert.equal(calls[0].init.method, "PATCH");
    assert.equal(calls[0].url, `/api/proposals/${ID(1)}`);
    assert.equal(calls[0].headers["If-Match"], '"abc"');
    assert.deepEqual(calls[0].body, { ops: [{ id: "a" }], base_versions: { "Person:h1": 3 }, note: "hi" });
    const { api: stale } = fakeApi(async () => ({ status: 412, body: { error: "precondition_failed", details: { proposal: view(1, { etag: "newer" }) } } }));
    await assert.rejects(() => createProposalGateSource(stale).amend({ id: ID(1), etag: "abc", ops: [] }), (e) => e instanceof GateHttpError && cardFromConflict(e).etag === "newer");
  });

  it("withdraw POSTs to /withdraw with If-Match", async () => {
    const { api, calls } = fakeApi(async () => ({ status: 200, body: view(1, { state: "withdrawn" }) }));
    const r = await createProposalGateSource(api).withdraw({ id: ID(1), etag: "abc" });
    assert.equal(r.state, "withdrawn");
    assert.equal(calls[0].url, `/api/proposals/${ID(1)}/withdraw`);
    assert.equal(calls[0].headers["If-Match"], '"abc"');
  });
});
