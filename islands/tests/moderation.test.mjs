// HFY-TSK-191 (R-32; social.md 11): the moderation model the islands share. Synthetic ids and names only.
//  - the POST /api/moderation targets and bodies (post, comment, photo of a post, photo of a comment) and the version the admin saw;
//  - the menu rows, the ask form's defaults and its note rule, the pings, the visibility rule and the notice parts;
//  - the error lines (the API's code to one DS line, the R-18 refusal to the guard's copy);
//  - the comment source's optional moderate(): present only with the flag, POSTs the comment target, returns the admin's view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/lib/api.js";
import { createHfyCommentSource } from "../src/lib/comment-source.js";
import { COPY, NOTE_MAX, commentTarget, createModerationClient, errorLine, hideDefault, menuItems, moderationBody, moderationVisible, noteError, noticeParts, photoTarget, pingFor, postPhotoId, postTarget, versionOf } from "../src/lib/moderation.js";
import { GUARD_COPY } from "../src/lib/contact-precheck.js";

const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const BY = { id: "I9002", label: "Ada Example" };

test("targets: post, comment (with its thread), and a photo of either, named by the upload ulid or the attachment id", () => {
  assert.deepEqual(postTarget({ id: ULID(1), body: "x" }), { kind: "post", id: ULID(1) });
  assert.deepEqual(commentTarget("post:" + ULID(1), ULID(2)), { kind: "comment", id: ULID(2), thread: `post:${ULID(1)}` });
  const a = { kind: "image", url: `/uploads/posts/${ULID(71)}/a.jpg` };
  assert.equal(postPhotoId(a), ULID(71));
  assert.equal(postPhotoId({ url: "https://example.test/uploads/posts/NOT-A-ULID/a.jpg" }), undefined);
  assert.equal(postPhotoId({ url: "/uploads/comments/x/a.jpg" }), undefined);
  assert.deepEqual(photoTarget(postTarget({ id: ULID(1) }), postPhotoId(a)), { kind: "photo", parent: { kind: "post", id: ULID(1) }, attachment: ULID(71) });
});

test("the version the admin saw: a post's updated_at, a comment's edited_at else created_at", () => {
  assert.equal(versionOf({ updated_at: T1, created_at: T0 }), T1);
  assert.equal(versionOf({ edited_at: T1, created_at: T0 }), T1);
  assert.equal(versionOf({ created_at: T0 }), T0);
  assert.equal(versionOf(undefined), undefined);
});

test("the body: a note goes only with request_changes and ask, hide only with ask, version when known", () => {
  const t = postTarget({ id: ULID(1) });
  assert.deepEqual(moderationBody(t, { action: "hide", note: "stray", hide: true }, T0), { target: t, action: "hide", version: T0 });
  assert.deepEqual(moderationBody(t, { action: "unhide" }), { target: t, action: "unhide" });
  assert.deepEqual(moderationBody(t, { action: "request_changes", note: "  add names  ", hide: false }, T0), { target: t, action: "request_changes", note: "add names", version: T0 });
  assert.deepEqual(moderationBody(t, { action: "ask", note: "which year?", hide: true }), { target: t, action: "ask", note: "which year?", hide: true });
  assert.deepEqual(moderationBody(t, { action: "ask", note: "which year?" }), { target: t, action: "ask", note: "which year?", hide: false });
});

test("the client POSTs /moderation with that body and returns the answer", async () => {
  const calls = [];
  const api = { post: async (path, body) => { calls.push([path, body]); return { target: body.target, moderation: null, item: { id: "x" } }; } };
  const r = await createModerationClient(api).act(postTarget({ id: ULID(1) }), { action: "hide" }, T0);
  assert.deepEqual(calls, [["/moderation", { target: { kind: "post", id: ULID(1) }, action: "hide", version: T0 }]]);
  assert.deepEqual(r.item, { id: "x" });
});

test("the ask form: the hide box starts checked for changes and unchecked for a question; the note is required and at most 1000 characters", () => {
  assert.equal(hideDefault("request_changes"), true);
  assert.equal(hideDefault("ask"), false);
  assert.equal(noteError(""), "required");
  assert.equal(noteError("   \n"), "required");
  assert.equal(noteError(undefined), "required");
  assert.equal(noteError("ok"), null);
  assert.equal(noteError("x".repeat(NOTE_MAX)), null);
  assert.equal(noteError("x".repeat(NOTE_MAX + 1)), "too long");
  assert.equal(noteError(` ${"x".repeat(NOTE_MAX)} `), null, "counted after trimming, as the server does");
});

test("menu rows: hide, ask for changes, ask a question; unhide (or close) once open; a photo only hides or unhides", () => {
  const ids = (m) => menuItems(m).map((r) => r.id);
  assert.deepEqual(ids({}), ["hide", "request_changes", "ask"]);
  assert.deepEqual(ids({ moderation: { state: "hidden", hidden: true } }), ["request_changes", "ask", "unhide"]);
  assert.deepEqual(ids({ moderation: { state: "changes_requested", hidden: true } }), ["hide", "request_changes", "ask", "unhide"]);
  const q = menuItems({ moderation: { state: "question", hidden: false } });
  assert.equal(q.at(-1).label, COPY.close, "an open question that is visible is closed, not unhidden");
  assert.deepEqual(menuItems({ photo: true }).map((r) => r.label), [COPY.hidePhoto]);
  assert.deepEqual(menuItems({ photo: true, moderation: { hidden: true } }).map((r) => r.label), [COPY.unhidePhoto]);
  assert.ok(menuItems({}).filter((r) => r.form).every((r) => r.label.endsWith("…")), "the rows that open a form end in an ellipsis");
  // every label is lowercase (DS voice)
  for (const r of menuItems({ moderation: { state: "hidden", hidden: true } })) assert.equal(r.label, r.label.toLowerCase());
});

test("pings: hidden says they'll get a note, an ask says sent", () => {
  assert.equal(pingFor("hide"), "hidden. they'll get a note.");
  assert.equal(pingFor("request_changes"), "sent.");
  assert.equal(pingFor("ask"), "sent.");
  assert.equal(pingFor("unhide"), "unhidden.");
  assert.equal(pingFor("hide", { photo: true }), "photo hidden.");
  assert.equal(pingFor("unhide", { photo: true }), "photo unhidden.");
});

test("visibility: a hidden item is for its author and admins only (the server already withholds it)", () => {
  const hidden = { author: { id: "I9003" }, moderation: { hidden: true } };
  const asked = { author: { id: "I9003" }, moderation: { hidden: false, state: "question" } };
  assert.equal(moderationVisible(hidden, { id: "I9003", admin: false }), true);
  assert.equal(moderationVisible(hidden, { id: "I9002", admin: true }), true);
  assert.equal(moderationVisible(hidden, { id: "I9004", admin: false }), false);
  assert.equal(moderationVisible(hidden, null), false, "not known yet: held back");
  assert.equal(moderationVisible(hidden, { id: null, admin: false }), false);
  assert.equal(moderationVisible(asked, { id: "I9004" }), true, "a visible question draws for everyone");
  assert.equal(moderationVisible({ author: { id: "I9003" } }, null), true);
});

test("notice parts: the author's edit line only where editing shows it again; a plain hide has none", () => {
  const ask = { state: "changes_requested", hidden: true, by: BY, note: "add names" };
  assert.deepEqual(noticeParts(ask, { own: true }), { asked: true, note: "add names", by: BY, hidden: true, state: "changes_requested", editToShow: true, plainHide: false });
  assert.equal(noticeParts({ ...ask, state: "question", hidden: false }, { own: true }).editToShow, false);
  const plain = noticeParts({ state: "hidden", hidden: true, by: BY }, { own: true });
  assert.equal(plain.asked, false);
  assert.equal(plain.plainHide, true);
  assert.equal(noticeParts({ state: "hidden", hidden: true, by: BY }, { own: false }).plainHide, false);
  assert.equal(noticeParts(undefined, { own: true }), null);
});

test("error lines: one DS line per code; the R-18 refusal shows the guard's own copy", async () => {
  const e = (status, code) => new ApiError(status, code, "m");
  assert.equal(await errorLine(e(403, "forbidden")), COPY.forbidden);
  assert.equal(await errorLine(e(400, "self_moderation")), COPY.selfModeration);
  assert.equal(await errorLine(e(404, "not_found")), COPY.gone);
  assert.equal(await errorLine(e(409, "conflict")), COPY.conflict);
  assert.equal(await errorLine(e(503, "busy")), COPY.busy);
  assert.equal(await errorLine(e(422, "unsupported_target")), COPY.unsupported);
  assert.equal(await errorLine(e(401, "unauthenticated")), COPY.signedOut);
  assert.equal(await errorLine(e(500, "server")), COPY.failed);
  assert.equal(await errorLine(new Error("boom")), COPY.failed);
  assert.equal(await errorLine(e(422, "contact_info")), GUARD_COPY.contact_info);
  // a ContentError from source.update keeps the API's code on apiCode
  assert.equal(await errorLine(Object.assign(new Error("x"), { apiCode: "contact_info" })), GUARD_COPY.contact_info);
  assert.equal(await errorLine(Object.assign(new Error("x"), { signedOut: true })), COPY.signedOut);
});

// ---- the comment source ----------------------------------------------------------------------------------------------------
const THREAD = `post:${ULID(1)}`;
const comment = (over = {}) => ({ id: ULID(3), threadId: THREAD, author: { id: "I9003", label: "Ann Other" }, body: "hello", created_at: T0, can: { edit: false, delete: false, react: false, moderate: true }, ...over });

test("the comment source has moderate() only with moderation on", () => {
  assert.equal(createHfyCommentSource({}).moderate, undefined);
  assert.equal(typeof createHfyCommentSource({}, { moderation: true }).moderate, "function");
});

test("moderate(): POST /moderation for the comment with the version it listed, resolving the admin's view and calling onModerated", async () => {
  const c = comment({ edited_at: T1 });
  const posts = [];
  const done = [];
  const api = {
    get: async () => ({ thread: { id: THREAD, topic: "comments", comments: [c], reactions: {} } }),
    post: async (path, body) => { posts.push([path, body]); return { target: body.target, moderation: { state: "question" }, item: { ...c, moderation: { state: "question", hidden: false, by: BY, at: T1, note: body.note, open: true } } }; },
  };
  const src = createHfyCommentSource(api, { moderation: true, onModerated: (input) => done.push(input.action) });
  await src.list(THREAD, {});
  const next = await src.moderate(THREAD, c.id, { action: "ask", note: " which year? ", hide: false });
  assert.deepEqual(posts, [["/moderation", { target: { kind: "comment", id: c.id, thread: THREAD }, action: "ask", note: "which year?", hide: false, version: T1 }]]);
  assert.equal(next.moderation.note, "which year?");
  assert.deepEqual(done, ["ask"]);
});

test("moderate(): a refusal becomes a CommentError with the DS line (the kit shows it under the comment)", async () => {
  const api = { get: async () => ({ thread: { id: THREAD, topic: "t", comments: [], reactions: {} } }), post: async () => { throw new ApiError(400, "self_moderation", "no"); } };
  const src = createHfyCommentSource(api, { moderation: true });
  await assert.rejects(() => src.moderate(THREAD, ULID(3), { action: "hide" }), (e) => e.name === "CommentError" && e.code === "self_moderation" && e.message === COPY.selfModeration && e.cause instanceof ApiError);
  const refused = createHfyCommentSource({ post: async () => { throw new ApiError(422, "contact_info", "no"); } }, { moderation: true });
  await assert.rejects(() => refused.moderate(THREAD, ULID(3), { action: "ask", note: "x" }), (e) => e.code === "validation" && e.field === "note" && e.message === GUARD_COPY.contact_info);
  const empty = createHfyCommentSource({ post: async () => ({}) }, { moderation: true });
  await assert.rejects(() => empty.moderate(THREAD, ULID(3), { action: "hide" }), (e) => e.message === COPY.failed);
});
