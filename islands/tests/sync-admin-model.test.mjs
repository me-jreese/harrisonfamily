// HFY-TSK-279 (sync-admin-status-page): the pure model of /admin/sync/ on invented rows. The words, the conflict rows, the decision bodies and the errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, ago, confirmAsk, conflictRows, countsLine, decidedLine, decisionBody, describeError, lagLine, normalizeStatus, pathWords, recordLabel, reopenedNote, showValue, stamp } from "../src/lib/sync-admin-model.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const CONFLICT = { id: "01J00000000000000000000001", class: "Person", gramps_id: "I0001", paths: [{ path: "/primary_name/first_name", cloud: "Birch", desktop: "Cedar" }, { path: "/gender", cloud: 1, desktop: null }] };

test("stamp and ago read an ISO time and fall back to unknown", () => {
  assert.equal(stamp("2026-10-14T11:59:30.000Z"), "2026-10-14 11:59 utc");
  assert.equal(stamp("yesterday"), "unknown");
  assert.equal(stamp(undefined), "unknown");
  assert.equal(ago("2026-10-14T11:59:30.000Z", NOW), "just now");
  assert.equal(ago("2026-10-14T11:55:00.000Z", NOW), "5 minutes ago");
  assert.equal(ago("2026-10-14T11:00:00.000Z", NOW), "1 hour ago");
  assert.equal(ago("2026-10-11T12:00:00.000Z", NOW), "3 days ago");
  assert.equal(ago("nope", NOW), "unknown");
});

test("pathWords and showValue make a path and a value readable, and cut long values", () => {
  assert.equal(pathWords("/primary_name/first_name"), "primary name, first name");
  assert.equal(pathWords(""), "the whole record");
  assert.equal(showValue("Birch"), "Birch");
  assert.equal(showValue(null), "nothing");
  assert.equal(showValue(1), "1");
  assert.equal(showValue({ a: 1 }), '{"a":1}');
  assert.equal(showValue("x".repeat(300)).length, 201);
});

test("a conflict lists both sides for each path and is labelled by class and Gramps id, never a name", () => {
  assert.deepEqual(conflictRows(CONFLICT), [
    { label: "primary name, first name", website: "Birch", desktop: "Cedar" },
    { label: "gender", website: "1", desktop: "nothing" },
  ]);
  assert.equal(recordLabel(CONFLICT), "person I0001");
  assert.equal(recordLabel({}), "record");
  assert.deepEqual(conflictRows({}), []);
});

test("the buttons map to the API's decisions, and anything else is refused", () => {
  assert.deepEqual(decisionBody("keep_website"), { decision: "keep_cloud" });
  assert.deepEqual(decisionBody("keep_desktop"), { decision: "keep_desktop" });
  assert.throws(() => decisionBody("manual"), TypeError);
  assert.equal(confirmAsk(CONFLICT, "keep_website"), "keep the website's value for person I0001?");
  assert.equal(confirmAsk(CONFLICT, "keep_desktop"), "keep the desktop's value for person I0001?");
  assert.match(decidedLine("keep_website"), /website's value/);
  assert.match(decidedLine("keep_desktop"), /desktop's value/);
});

test("normalizeStatus gives every member its type from a missing or odd body", () => {
  const empty = normalizeStatus(undefined);
  assert.deepEqual([empty.owner, empty.desktop, empty.conflicts, empty.batches], [false, [], [], []]);
  assert.deepEqual(empty.website, { headSeq: 0, renderedSeq: 0, lag: 0, mode: null, error: null, errorAt: null, paused: false, seeded: false, bound: false });
  const s = normalizeStatus({
    owner: true,
    desktop: [{ id: "instance-0001", addon_version: "0.1.0", gramps_version: "6.0.6", updated_at: "2026-10-14T11:59:30.000Z", last_run: { action: "sync", result: "ok", counts: { pulled: 3, pushed: 1 }, finished_at: "2026-10-14T11:59:00Z" } }, "bad"],
    website: { head_seq: 12, rendered_seq: 9, render_lag: 3, render_mode: "live", last_render_error: "RenderFailed", writes_enabled: false },
    conflicts: [CONFLICT, { nope: 1 }], batches: [{ id: "B1", at: "2026-10-14T10:00:00.000Z", by: "I9001", origin: "desktop", ops: 3, seq_from: 4, seq_to: 6 }],
  });
  assert.equal(s.owner, true);
  assert.equal(s.desktop.length, 1);
  assert.equal(s.desktop[0].run.result, "ok");
  assert.deepEqual([s.website.headSeq, s.website.lag, s.website.error, s.website.paused], [12, 3, "RenderFailed", true]);
  assert.equal(s.conflicts.length, 1);
  assert.deepEqual(s.batches[0], { id: "B1", at: "2026-10-14T10:00:00.000Z", by: "I9001", origin: "desktop", ops: 3, from: 4, to: 6 });
});

test("countsLine and lagLine are short", () => {
  assert.equal(countsLine({ pulled: 3, held_back: 1, junk: "x" }), "pulled 3, held back 1");
  assert.equal(countsLine({}), "no counts");
  assert.equal(lagLine(0), "up to date");
  assert.equal(lagLine(1), "1 change not on the site yet");
  assert.equal(lagLine(3), "3 changes not on the site yet");
});

test("errors: a stale sign-in asks for a fresh one, a non-owner and a non-admin get their lines, the switch off reads not available", () => {
  assert.deepEqual(describeError({ status: 401, code: "step_up_required" }), { kind: "signin", fresh: true, text: "to decide this, sign in again first." });
  assert.equal(describeError({ status: 401, code: "unauthenticated" }).fresh, false);
  assert.equal(describeError({ status: 403, code: "not_owner" }).text, COPY.ownerOnly);
  assert.equal(describeError({ status: 403, code: "not_allowed" }).text, COPY.notAllowed);
  assert.equal(describeError({ status: 404, code: "not_enabled" }).text, COPY.off);
  assert.equal(describeError({ status: 409, code: "already_resolved" }).kind, "reload");
  assert.equal(describeError({ status: 500 }).text, COPY.loadFailed);
});

test("a conflict reopened because the website's value moved reads open, with a 'cloud value changed' note and the earlier decision (HFY-TSK-338)", () => {
  const reopened = (reason, decision = "keep_cloud") => ({ ...CONFLICT, state: "open", decision: null, reopened_at: "2026-10-14T10:00:00.000Z", history: [{ decision, reason, reopened_at: "2026-10-14T10:00:00.000Z" }] });
  const a = reopenedNote(reopened("version_changed"));
  assert.match(a.text, /^cloud value changed\./);
  assert.equal(a.was, "keep website");
  assert.equal(reopenedNote(reopened("value_changed", "keep_desktop")).was, "keep desktop");
  assert.match(reopenedNote(reopened("no_hash")).text, /could not be checked/);
  assert.equal(reopenedNote(reopened("version_changed", "manual")).was, null);
  // the newest history entry speaks
  assert.equal(reopenedNote({ ...reopened("version_changed"), history: [{ decision: "keep_desktop", reason: "value_changed" }, { decision: "keep_cloud", reason: "version_changed" }] }).was, "keep website");
});

test("a conflict that was never reopened, or is not open, has no note", () => {
  assert.equal(reopenedNote(CONFLICT), null);
  assert.equal(reopenedNote({ ...CONFLICT, history: [] }), null);
  assert.equal(reopenedNote({ ...CONFLICT, state: "resolved", history: [{ decision: "keep_cloud", reason: "version_changed" }] }), null);
  assert.equal(reopenedNote(null), null);
  assert.equal(reopenedNote({ ...CONFLICT, state: "open", history: "x" }), null);
});
