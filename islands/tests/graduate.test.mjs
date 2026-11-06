// HFY-TSK-215: the graduation model (lib/graduate.js): request, marker states, the 15-minute "retry", error lines. Pure, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/lib/api.js";
import { COPY, STALE_PENDING_MS, alreadyOn, errorLine, graduate, graduateBody, graduatePath, initialTitle, markerState, onPage, photosHref, threadPerson } from "../src/lib/graduate.js";

test("threadPerson: a person thread names its person, a post thread none", () => {
  assert.equal(threadPerson("person:I9001"), "I9001");
  assert.equal(threadPerson("post:01JZZZZZZZZZZZZZZZZZZZZZZZ"), null);
  assert.equal(threadPerson("person:not-an-id"), null);
});

test("the title starts as the alt text, trimmed and capped; the badge goes to the photos section", () => {
  assert.equal(initialTitle({ alt: "  a photo from Sam Example " }), "a photo from Sam Example");
  assert.equal(initialTitle({}), "");
  assert.equal(initialTitle({ alt: "x".repeat(300) }).length, 200);
  assert.equal(photosHref("I9001"), "/person/?id=I9001#photos");
  assert.equal(onPage("Sam Example"), "on Sam Example’s page");
});

test("graduateBody and the route path", () => {
  assert.deepEqual(graduateBody({ subject: "person:I9001", person: "I9002", title: " Hello " }), { subject: "person:I9001", person: "I9002", title: "Hello" });
  assert.deepEqual(graduateBody({ subject: "person:I9001", person: "I9002", title: "  " }), { subject: "person:I9001", person: "I9002" });
  assert.equal(graduatePath("C1", "att 1"), "/comments/C1/attachments/att%201/graduate");
});

test("graduate posts the body to the route", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push([path, body]); return { state: "done", person: "I9002" }; } };
  const r = await graduate(client, { commentId: "C1", attachmentId: "a1", subject: "person:I9001", person: "I9002", title: "T" });
  assert.equal(r.person, "I9002");
  assert.deepEqual(calls, [["/comments/C1/attachments/a1/graduate", { subject: "person:I9001", person: "I9002", title: "T" }]]);
});

test("markerState: done, a fresh pending, a stale pending, failed and none", () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  assert.deepEqual(markerState(undefined, now), { kind: "none" });
  assert.deepEqual(markerState({ state: "failed", code: "validation" }, now), { kind: "none" });
  assert.deepEqual(markerState({ state: "done", person: "I9002" }, now), { kind: "done", person: "I9002" });
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(markerState({ state: "pending", person: "I9002", at: at(STALE_PENDING_MS - 1000) }, now).stale, false);
  assert.equal(markerState({ state: "pending", person: "I9002", at: at(STALE_PENDING_MS + 1000) }, now).stale, true);
});

test("errorLine: a missing person is not a missing photo", () => {
  assert.deepEqual(errorLine(new ApiError(404, "person_not_found", "x")), { text: COPY.personGone });
  assert.deepEqual(errorLine(new ApiError(404, "not_found", "x")), { text: COPY.gone });
});

test("errorLine: E15 and E17 share a line, E16 sits under the title, E18 names the page", () => {
  assert.deepEqual(errorLine(new ApiError(503, "graduate_copy_failed", "x")), { text: COPY.unavailable });
  assert.deepEqual(errorLine(new ApiError(503, "graduate_conflict", "x")), { text: COPY.unavailable });
  assert.deepEqual(errorLine(new ApiError(400, "validation", "x", "title", { field: "title" })), { text: COPY.invalid, field: "title" });
  assert.deepEqual(errorLine(new ApiError(409, "already_graduated", "x", undefined, { person: "I9003" }), (id) => (id === "I9003" ? "Ann Other" : undefined)), { text: alreadyOn("Ann Other") });
  assert.equal(alreadyOn("Ann Other"), "this photo is already on Ann Other’s page.");
  assert.deepEqual(errorLine(new Error("boom")), { text: COPY.failed });
  assert.deepEqual(errorLine(new ApiError(401, "unauthenticated", "x")), { text: COPY.signedOut });
});
