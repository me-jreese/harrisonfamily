// HFY-TSK-295 (edit-admin-delete; Q2-15): the pure half (src/lib/admin-delete.js). Who gets the delete card, the request body, the sheet's words for
// a dry run, the words for every error the two routes answer, and the duplicate queue's rows. Synthetic data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COPY, DELETE_CLASSES, NOUN, canDelete, canSeeDuplicates, deleteBody, pairRow, planView, problemFor } from "../src/lib/admin-delete.js";

const admin = { admin: true, relation: "other" };
const flags = { adminDelete: true };

describe("who gets the delete card", () => {
  it("an admin, the flag on, one of the seven classes", () => {
    for (const cls of DELETE_CLASSES) assert.equal(canDelete({ cls, viewer: admin, flags }), true, cls);
    assert.deepEqual([...DELETE_CLASSES], ["Person", "Family", "Event", "Place", "Source", "Citation", "Media"]);
  });
  it("never a member, never with the flag off, never a repository or a note", () => {
    assert.equal(canDelete({ cls: "Person", viewer: { admin: false }, flags }), false);
    assert.equal(canDelete({ cls: "Person", viewer: { admin: "yes" }, flags }), false);
    assert.equal(canDelete({ cls: "Person", viewer: admin, flags: { adminDelete: false } }), false);
    assert.equal(canDelete({ cls: "Person", viewer: admin, flags: {} }), false);
    assert.equal(canDelete({ cls: "Person", viewer: admin }), false);
    assert.equal(canDelete({ cls: "Repository", viewer: admin, flags }), false);
    assert.equal(canDelete({ cls: "Note", viewer: admin, flags }), false);
    assert.equal(canDelete({}), false);
  });
  it("the duplicates tab needs an admin and the flag", () => {
    assert.equal(canSeeDuplicates({ admin: true, flags }), true);
    assert.equal(canSeeDuplicates({ admin: false, flags }), false);
    assert.equal(canSeeDuplicates({ admin: true, flags: {} }), false);
  });
});

describe("the request", () => {
  it("a dry run and the delete send the same targets and versions, and always ask to clean the links", () => {
    const plan = deleteBody({ key: "Person:abc", version: 4, dryRun: true });
    const real = deleteBody({ key: "Person:abc", version: 4 });
    assert.deepEqual(plan, { targets: ["Person:abc"], base_versions: { "Person:abc": 4 }, remove_references: true, dry_run: true });
    assert.deepEqual(real, { targets: ["Person:abc"], base_versions: { "Person:abc": 4 }, remove_references: true });
  });
});

describe("the sheet's view of a dry run", () => {
  const body = {
    plan: {
      delete: [
        { key: "Person:a", class: "Person", gramps_id: "I0003", label: "Cedar Testwood", why: "target" },
        { key: "Event:b", class: "Event", gramps_id: "E0001", label: "", why: "exclusive_event" },
        { key: "Family:c", class: "Family", gramps_id: "F0002", label: "", why: "emptied_family" },
        { key: "Citation:d", class: "Citation", gramps_id: "", label: "", why: "source_citation" },
      ],
      update: [{ key: "Family:e", class: "Family", gramps_id: "F0001", label: "" }],
      retired_ids: ["I0003"],
    },
    budget: { used: 2, adding: 4, limit: 10, over: false },
  };
  it("names what goes, with the reason when it is not the page itself, and what loses a link", () => {
    const v = planView(body);
    assert.deepEqual(v.deletes.map((d) => d.text), [
      "Cedar Testwood (I0003)",
      "event E0001: an event that only this page used",
      "family F0002: a family left with nobody in it",
      "source citation: a source citation that belongs only to this source",
    ]);
    assert.deepEqual(v.updates.map((d) => d.text), ["family F0001"]);
    assert.deepEqual(v.ids, ["I0003"]);
    assert.equal(COPY.idsNote(v.ids), "the id I0003 can never be used again.");
    assert.equal(COPY.idsNote(["I1", "I2"]), "the ids I1, I2 can never be used again.");
  });
  it("says the day's count, and when over the budget it says to use gramps and turns the delete off", () => {
    assert.deepEqual(planView(body).budget, { over: false, text: "2 deleted in the last day. a day's limit is 10." });
    const over = planView({ ...body, budget: { used: 9, adding: 4, limit: 10, over: true, reason: "budget" } });
    assert.equal(over.budget.over, true);
    assert.match(over.budget.text, /use gramps on the desktop/);
  });
  it("survives an empty or odd body", () => {
    assert.deepEqual(planView(undefined), { deletes: [], updates: [], ids: [], budget: null });
    assert.deepEqual(planView({ plan: { delete: "x" } }), { deletes: [], updates: [], ids: [], budget: null });
  });
});

describe("words for every error", () => {
  const e = (status, code) => Object.assign(new Error(code), { status, code });
  it("a stale sign-in asks to sign in again, and says why", () => {
    const p = problemFor(e(401, "step_up_required"));
    assert.equal(p.signIn, true);
    assert.equal(p.stepUp, true);
    assert.match(p.text, /sign in again/);
    assert.equal(problemFor(e(401, "unauthenticated")).signIn, true);
  });
  it("the others, in plain words", () => {
    assert.match(problemFor(e(403, "delete_budget")).text, /use gramps on the desktop/);
    assert.equal(problemFor(e(409, "version_conflict")).reload, true);
    assert.match(problemFor(e(409, "still_referenced")).text, /gramps on the desktop/);
    assert.match(problemFor(e(413, "too_large")).text, /more than 24/);
    assert.match(problemFor(e(403, "not_allowed")).text, /only an admin/);
    assert.match(problemFor(e(404, "not_found")).text, /already gone/);
    assert.match(problemFor(e(0, "network")).text, /check your connection/);
    assert.match(problemFor(e(500, "server")).text, /try again/);
    assert.equal(problemFor(undefined).signIn, false);
  });
  it("only an answer that never came or a site failure may be sent again as it is", () => {
    assert.equal(problemFor(e(0, "network")).retry, true);
    assert.equal(problemFor(e(503, "server")).retry, true);
    for (const [status, code] of [[401, "step_up_required"], [403, "delete_budget"], [409, "version_conflict"], [409, "still_referenced"], [413, "too_large"], [404, "not_found"], [422, "idempotency_mismatch"]]) {
      assert.equal(problemFor(e(status, code)).retry, false, `${status} ${code}`);
    }
  });
  it("no word a family member would not know", () => {
    const all = [COPY.lead, COPY.dupLead, ...Object.values(NOUN), ...[401, 403, 404, 409, 413].map((s) => problemFor(e(s, "x")).text)].join(" ");
    assert.doesNotMatch(all, /\b(gramps_id|handle|applyBatch|idempotency|step-up|api|403|409|payload)\b/i);
  });
});

describe("the duplicate queue's rows", () => {
  it("each side is a name, an id and a lifespan, linked to the person's page; a close score is worded", () => {
    const row = pairRow({ a: { key: "Person:1", gramps_id: "I0070", displayName: "Wren Fernley", lifespan: "1990-" }, b: { key: "Person:2", gramps_id: "I0071", displayName: "Wren Fernly", lifespan: "" }, score: 3 });
    assert.equal(row.a.text, "Wren Fernley (I0070, 1990-)");
    assert.equal(row.b.text, "Wren Fernly (I0071)");
    assert.equal(row.a.href, "/person/?id=I0070");
    assert.equal(row.strength, COPY.scoreClose);
    assert.equal(pairRow({ a: {}, b: {}, score: 5 }).strength, COPY.scoreSame);
    assert.equal(pairRow({}).a.href, null);
  });
});
