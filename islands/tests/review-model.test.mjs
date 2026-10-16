// HFY-TSK-259 (review-island): the pure half (src/lib/review-model.js). Tabs, chips, the plain-words chips, the before -> after rows with a
// word diff, the conflict rows of a stale suggestion, the amend, and the words for every error. Synthetic data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHIPS, COPY, TAB_LABEL, allReviewText, amendReady, amendable, approveBlocked, buildAmend, conflictRows, firstSentence, isOutOfDate, kindBadge, locationFor, needsFreshSignIn,
  opRows, pageWord, parseLocation, pickTab, problemOf, reasonProblem, rebaseOf, resolvePath, signInHref, stateChip, tabsFor, touchedKeys, valueText, wordDiff,
} from "../src/lib/review-model.js";
import { ID, REBASE_CLEAN, REBASE_CONFLICT, view } from "./fixtures/proposals.mjs";

describe("tabs (AC4)", () => {
  it("an admin with proposalReview gets 'to review' first; a member never does", () => {
    assert.deepEqual(tabsFor({ admin: true, flags: { proposalReview: true, recordEdit: true } }), ["review", "mine", "about"]);
    assert.deepEqual(tabsFor({ admin: false, flags: { proposalReview: true, recordEdit: true } }), ["mine", "about"]);
    assert.deepEqual(tabsFor({ admin: false, flags: { proposalReview: true } }), []);
    assert.deepEqual(tabsFor({ admin: true, flags: { proposalReview: true } }), ["review"]);
    assert.deepEqual(tabsFor({ admin: true, flags: { recordEdit: true } }), ["mine", "about"]);
    assert.deepEqual(tabsFor({ admin: true, flags: {} }), []);
    assert.deepEqual(tabsFor({}), []);
    assert.deepEqual(tabsFor({ admin: "yes", flags: { proposalReview: true } }), [], "only admin === true");
  });

  it("the tab words are the design's", () => {
    assert.deepEqual(TAB_LABEL, { review: "to review", mine: "my suggestions", about: "about my page", duplicates: "possible duplicates" });
  });

  it("'possible duplicates' (HFY-TSK-295) is an admin's tab behind adminDelete, after the others; a member never has it", () => {
    assert.deepEqual(tabsFor({ admin: true, flags: { proposalReview: true, recordEdit: true, adminDelete: true } }), ["review", "mine", "about", "duplicates"]);
    assert.deepEqual(tabsFor({ admin: true, flags: { recordEdit: true, adminDelete: true } }), ["mine", "about", "duplicates"]);
    assert.deepEqual(tabsFor({ admin: true, flags: { recordEdit: true, adminDelete: false } }), ["mine", "about"]);
    assert.deepEqual(tabsFor({ admin: false, flags: { recordEdit: true, adminDelete: true } }), ["mine", "about"]);
    assert.deepEqual(tabsFor({ admin: "yes", flags: { adminDelete: true } }), [], "only admin === true");
    assert.deepEqual(parseLocation("?tab=duplicates"), { tab: "duplicates", id: null });
    assert.equal(pickTab(["mine", "duplicates"], "duplicates"), "duplicates");
  });

  it("the URL: ?tab and ?p round-trip; unknown tabs and non-ULID ids are dropped", () => {
    assert.deepEqual(parseLocation(`?tab=mine&p=${ID(7)}`), { tab: "mine", id: ID(7) });
    assert.deepEqual(parseLocation("?tab=admin&p=nope"), { tab: null, id: null });
    assert.deepEqual(parseLocation(""), { tab: null, id: null });
    assert.equal(locationFor({ tab: "review", id: ID(7) }), `?tab=review&p=${ID(7)}`);
    assert.equal(locationFor({}), "");
  });

  it("pickTab opens the asked tab only if the viewer has it", () => {
    assert.equal(pickTab(["mine", "about"], "review"), "mine", "a member asking for the queue gets their own list");
    assert.equal(pickTab(["review", "mine"], "mine"), "mine");
    assert.equal(pickTab([], "mine"), null);
  });
});

describe("chips", () => {
  it("the queue's chips are waiting, needs changes, out of date and done", () => {
    assert.deepEqual(CHIPS.review.map((c) => c.label), ["waiting", "needs changes", "out of date", "done"]);
  });
  it("'waiting' and 'out of date' split the pending list", () => {
    const [waiting, , outOfDate] = CHIPS.review;
    const fresh = view(1);
    const moved = view(2, { stale: true });
    const stored = view(3, { state: "stale" });
    assert.deepEqual([fresh, moved, stored].map((v) => waiting.keep(v)), [true, false, false]);
    assert.deepEqual([fresh, moved, stored].map((v) => outOfDate.keep(v)), [false, true, true]);
    assert.equal(isOutOfDate(moved), true);
  });
  it("done lists every finished state", () => {
    assert.deepEqual(CHIPS.review[3].states, ["approved", "declined", "withdrawn", "superseded"]);
  });
});

describe("words for one suggestion", () => {
  it("the proposer's chips are the design's plain words", () => {
    assert.equal(stateChip(view(1)), "waiting for review");
    assert.equal(stateChip(view(1, { state: "needs_changes" })), "an admin asked a question");
    assert.equal(stateChip(view(1, { state: "stale" })), "needs a quick update — the page changed");
    assert.equal(stateChip(view(1, { stale: true })), "needs a quick update — the page changed");
    assert.equal(stateChip(view(1, { state: "approved" })), "added to the family tree");
    assert.equal(stateChip(view(1, { state: "declined", decision: { verdict: "deny", reason: "wrong cousin" } })), "not added: wrong cousin");
    assert.equal(stateChip(view(1, { state: "declined" })), "not added");
    assert.equal(stateChip(view(1, { state: "superseded" })), "the page was merged or removed");
  });
  it("the kind badge: edit, family connection, new person", () => {
    assert.equal(kindBadge(view(1)), "edit");
    assert.equal(kindBadge(view(1, { kind: "relationship" })), "family connection");
    assert.equal(kindBadge(view(1, { kind: "create", ops: [{ id: "c", op: "create", obj: "new:1", cls: "Person", value: {} }] })), "new person");
    assert.equal(kindBadge(view(1, { kind: "create", ops: [{ id: "c", op: "create", obj: "new:1", cls: "Event", value: {} }] })), "new page");
  });
  it("the first sentence, from a plan entry or a plain string; a fallback", () => {
    assert.equal(firstSentence(view(1)), "change the first name from \"Tess\" to \"Tessa Marie\"");
    assert.equal(firstSentence(view(1, { summary: ["adds a person"] })), "adds a person");
    assert.equal(firstSentence(view(1, { summary: [] })), "a suggested change");
  });
  it("what a page is called when it has no name to show", () => {
    assert.equal(pageWord(view(1, { subject: { cls: "Family" } })), "a family");
    assert.equal(pageWord(view(1, { subject: null })), "a page");
  });
  it("a destructive suggestion tells the admin about the fresh sign-in", () => {
    assert.equal(needsFreshSignIn(view(1)), false);
    assert.equal(needsFreshSignIn(view(1, { ops: [{ op: "delete", obj: "Person:h1" }] })), true);
  });
});

describe("before -> after rows", () => {
  it("a set op shows its sentence, the old and new values, and a word diff", () => {
    const [row] = opRows(view(1, { ops: [{ id: "n", op: "set", obj: "Person:h1", path: "/primary_name/first_name", base: "Anna Marie", value: "Anna Maria Lee" }], summary: [{ text: "change the first name", opIds: ["n"] }] }));
    assert.equal(row.text, "change the first name");
    assert.equal(row.before, "Anna Marie");
    assert.equal(row.after, "Anna Maria Lee");
    assert.deepEqual(row.diff, [{ t: "same", text: "Anna" }, { t: "del", text: "Marie" }, { t: "add", text: "Maria Lee" }]);
  });
  it("an add or a remove shows only the sentence", () => {
    const rows = opRows(view(1, { ops: [{ id: "a", op: "add", obj: "Person:h1", path: "/note_list", value: "hnote" }], summary: [{ text: "add a note", opIds: ["a"] }] }));
    assert.deepEqual(rows.map((r) => [r.text, r.set]), [["add a note", false]]);
  });
  it("a name object reads as the name; a date as its parts; an empty value is null", () => {
    assert.equal(valueText({ _class: "Name", first_name: "Test", surname_list: [{ surname: "Person" }] }), "Test Person");
    assert.equal(valueText({ _class: "Date", dateval: [0, 0, 1950, false] }), "1950");
    assert.equal(valueText(""), null);
    assert.equal(valueText(null), null);
    assert.equal(valueText(7), "7");
  });
  it("wordDiff: equal text is one part; a swap is a del and an add", () => {
    assert.deepEqual(wordDiff("a b", "a b"), [{ t: "same", text: "a b" }]);
    assert.deepEqual(wordDiff("a b c", "a x c"), [{ t: "same", text: "a" }, { t: "del", text: "b" }, { t: "add", text: "x" }, { t: "same", text: "c" }]);
    assert.deepEqual(wordDiff("", "new name"), [{ t: "add", text: "new name" }]);
  });
});

describe("the stale card (AC3)", () => {
  it("rebaseOf reads the detail, defaulting to current", () => {
    assert.deepEqual(rebaseOf(null), { status: "current", conflicts: [] });
    assert.equal(rebaseOf({ rebase: REBASE_CLEAN }).status, "clean");
    assert.equal(rebaseOf({ rebase: REBASE_CONFLICT }).conflicts.length, 1);
  });
  it("a conflict gives a per-op row with the three values, and blocks approve", () => {
    const v = view(1);
    const rows = conflictRows(v, REBASE_CONFLICT);
    assert.equal(rows.length, 1);
    assert.deepEqual({ opId: rows[0].opId, base: rows[0].base, current: rows[0].current, proposed: rows[0].proposed, canKeep: rows[0].canKeep }, { opId: "names.first_name", base: "Tess", current: "Tessie", proposed: "Tessa Marie", canKeep: true });
    assert.equal(approveBlocked(REBASE_CONFLICT), true);
    assert.equal(approveBlocked(REBASE_CLEAN), false);
    assert.equal(approveBlocked(null), false);
  });
  it("a page that was removed has a 'gone' row that cannot be kept", () => {
    const rows = conflictRows(view(1), { status: "conflict", conflicts: [{ opId: "names.first_name", obj: "Person:hsyn0002", path: "", reason: "deleted" }] });
    assert.equal(rows[0].gone, true);
    assert.equal(rows[0].canKeep, false);
  });
  it("amendReady needs a choice for every conflict, and something left to approve", () => {
    const v = view(1);
    assert.deepEqual(amendReady({ view: v, rebase: REBASE_CONFLICT }), { ok: false, why: "pick" });
    assert.equal(amendReady({ view: v, rebase: REBASE_CONFLICT, choices: { "names.first_name": "keep" } }).ok, true);
    assert.deepEqual(amendReady({ view: v, rebase: REBASE_CONFLICT, choices: { "names.first_name": "page" } }), { ok: false, why: "empty" });
    assert.equal(amendReady({ view: v, rebase: REBASE_CLEAN }).ok, true);
    assert.deepEqual(amendReady({ view: v, rebase: REBASE_CLEAN, leaveOut: new Set(["names.first_name"]) }), { ok: false, why: "empty" });
  });
  it("buildAmend: 'keep' re-bases the op onto what the page says now; 'page' drops it; fresh versions go with it", () => {
    const two = view(1, { ops: [
      { id: "names.first_name", op: "set", obj: "Person:hsyn0002", path: "/primary_name/first_name", base: "Tess", value: "Tessa Marie" },
      { id: "names.nick", op: "set", obj: "Person:hsyn0002", path: "/primary_name/nick", base: null, value: "Tee" },
    ] });
    const versions = { "Person:hsyn0002": 9 };
    const kept = buildAmend({ view: two, rebase: REBASE_CONFLICT, choices: { "names.first_name": "keep" }, versions });
    assert.deepEqual(kept.ops.map((o) => [o.id, o.base, o.value]), [["names.first_name", "Tessie", "Tessa Marie"], ["names.nick", null, "Tee"]]);
    assert.deepEqual(kept.base_versions, { "Person:hsyn0002": 9 });
    const dropped = buildAmend({ view: two, rebase: REBASE_CONFLICT, choices: { "names.first_name": "page" }, versions });
    assert.deepEqual(dropped.ops.map((o) => o.id), ["names.nick"]);
    const edited = buildAmend({ view: two, rebase: REBASE_CLEAN, values: { "names.nick": "Teddy" }, leaveOut: new Set(["names.first_name"]), versions });
    assert.deepEqual(edited.ops.map((o) => [o.id, o.value]), [["names.nick", "Teddy"]]);
    assert.equal(two.ops[1].value, "Tee", "the proposal's own ops are not changed");
  });
  it("touchedKeys skips objects an op creates", () => {
    assert.deepEqual(touchedKeys([{ obj: "Person:h2" }, { obj: "new:1" }, { obj: "Person:h1" }, { obj: "Person:h2" }]), ["Person:h1", "Person:h2"]);
  });
  it("resolvePath follows a plain pointer and refuses a keyed list segment", () => {
    const obj = { primary_name: { first_name: "Tess" }, list: ["a", "b"] };
    assert.deepEqual(resolvePath(obj, "/primary_name/first_name"), { found: true, value: "Tess" });
    assert.deepEqual(resolvePath(obj, "/list/1"), { found: true, value: "b" });
    assert.equal(resolvePath(obj, "/primary_name/nick").found, false);
    assert.equal(resolvePath(obj, "/event_ref_list/@ref=h1").found, false);
  });
  it("a relationship suggestion is not amendable", () => {
    assert.equal(amendable(view(1)), true);
    assert.equal(amendable(view(1, { kind: "relationship" })), false);
  });
});

describe("reasons and errors (AC2)", () => {
  it("a decline or a request for changes needs text", () => {
    assert.equal(reasonProblem(""), COPY.textRequired);
    assert.equal(reasonProblem("   "), COPY.textRequired);
    assert.equal(reasonProblem("which cousin?"), "");
    assert.match(reasonProblem("x".repeat(1001)), /too long/);
  });
  it("problemOf: plain words, and which errors end in a sign-in", () => {
    assert.equal(problemOf({ status: 401, code: "step_up_required" }).stepUp, true);
    assert.equal(problemOf({ status: 401, code: "step_up_required" }).signIn, true);
    assert.equal(problemOf({ status: 401, code: "unauthenticated" }).stepUp, false);
    assert.equal(problemOf({ status: 409, code: "rebase_conflict" }).conflict, true);
    assert.equal(problemOf({ status: 412, code: "precondition_failed" }).conflict, true);
    assert.equal(problemOf({ status: 403, code: "not_admin" }).text, "only an admin can do that.");
    assert.equal(problemOf({ status: 0 }).text, "we couldn't reach the site. check your connection and try again.");
    assert.equal(problemOf({ status: 422, code: "contact_info" }).text.startsWith("this looks like a phone number"), true);
    assert.equal(problemOf({ status: 500 }).text, "something went wrong. try again in a moment.");
  });
  it("the sign-in link asks again (prompt=login) for a step-up and comes back to the card", () => {
    assert.equal(signInHref(true, "/me/review/?tab=review&p=X"), "/auth/login?prompt=login&returnTo=%2Fme%2Freview%2F%3Ftab%3Dreview%26p%3DX");
    assert.equal(signInHref(false, "/me/review/"), "/auth/login?returnTo=%2Fme%2Freview%2F");
  });
});

describe("copy", () => {
  it("is lowercase plain words: no 'record', no jargon", () => {
    for (const t of allReviewText()) {
      assert.equal(typeof t, "string");
      assert.ok(!/\brecords?\b|\busers?\b|\bmembers?\b|\bproposals?\b|\bendpoint\b|\bhandle\b|\betag\b|\bOpenAPI\b/i.test(t), `jargon in: ${t}`);
      assert.ok(t === t.toLowerCase() || /^[a-z]/.test(t), `starts lowercase: ${t}`);
      assert.ok(!/!/.test(t), `no exclamation: ${t}`);
    }
  });
});

describe("which copy is newer", () => {
  it("a higher rev, then a later updated_at; equal is not newer", async () => {
    const { isNewer, pickCard } = await import("../src/lib/review-model.js");
    const a = view(1, { rev: 1, updated_at: "2026-03-01T10:00:00.000Z" });
    assert.equal(isNewer(view(1, { rev: 2 }), a), true);
    assert.equal(isNewer(a, view(1, { rev: 2 })), false);
    assert.equal(isNewer(view(1, { rev: 1, updated_at: "2026-03-01T11:00:00.000Z" }), a), true);
    assert.equal(isNewer(a, a), false);
    assert.equal(isNewer(a, null), true);
    assert.equal(isNewer(null, a), false);
    const listed = { id: "x", hfy: a };
    const held = { id: "x", hfy: view(1, { rev: 2 }) };
    assert.equal(pickCard(listed, held), held, "a held card the list has not caught up with stays");
    assert.equal(pickCard({ id: "x", hfy: view(1, { rev: 3 }) }, held).hfy.rev, 3, "a newer read of the list wins");
    assert.equal(pickCard(listed, undefined), listed);
  });
});
