// HFY-TSK-187 (R-01, R-18, PS-11): the comment side of photos. Synthetic hosts, addresses and names only.
//  - the comments island renders every body with the HFY SanitizePolicy (src [] and href https/http), forced over the kit's own;
//  - the comment source sends photo attachments and maps the API's photo refusals to their copy;
//  - the photo labels, the limits and the who-photo alt (ruling P2-R47).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importCommentsReact } from "../kit-content.mjs";
import { ApiError } from "../src/lib/api.js";
import { createHfyCommentSource } from "../src/lib/comment-source.js";
import { FEATURES, MAX_PHOTOS, PHOTO_LABELS, commentPhotoAlt, photoUploadMessage } from "../src/lib/comment-photos.js";
import { PHOTO_COPY, PhotoDecodeError } from "../src/lib/photo.js";

const { Comment, CommentBody, DEFAULT_LABELS } = await importCommentsReact();

const BODY = [
  "hello family",
  "",
  "![tracker](https://tracker.example.test/pixel.png)",
  "",
  "[write me](mailto:someone@example.test) and [read more](https://example.test/read) and [plain](http://example.test/plain) and [rel](/person/?id=I9001)",
  "",
  "<img src=\"https://tracker.example.test/raw.png\"> <a href=\"mailto:raw@example.test\">raw</a>"
].join("\n");
const T0 = "2026-01-01T00:00:00.000Z";
const comment = (over = {}) => ({ id: "01JZZZZZZZZZZZZZZZZZZZZ001", threadId: "person:I9001", author: { id: "I9002", label: "Test Person" }, body: BODY, created_at: T0, can: { edit: false, delete: false, react: false, moderate: false }, ...over });

test("a comment body is rendered with the HFY policy: no markdown image, no mailto: link, no raw html, https and http links stay", () => {
  const html = renderToStaticMarkup(createElement(CommentBody, { comment: comment() }));
  assert.doesNotMatch(html, /<img/, "no <img> from markdown or raw html: the browser requests no external host");
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /href="mailto:/i, "no mailto: link");
  assert.match(html, /&lt;img src=/, "raw html is escaped to inert text");
  assert.match(html, /href="https:\/\/example\.test\/read"/);
  assert.match(html, /href="http:\/\/example\.test\/plain"/);
  assert.match(html, /href="\/person\/\?id=I9001"/);
  assert.match(html, /<span data-hfy-md-image-omitted="">tracker<\/span>/);
  assert.match(html, /rel="noopener noreferrer nofollow ugc"/);
});

test("a whole Comment (the thread's row) draws no markdown image either, and no attachment reactions when the island turns them off", () => {
  const withPhoto = comment({ attachments: [{ id: "01JZZZZZZZZZZZZZZZZZZZZ002", url: "/uploads/comments/01JZZZZZZZZZZZZZZZZZZZZ002/photo.jpg", mime: "image/jpeg", width: 800, height: 600 }] });
  const html = renderToStaticMarkup(createElement(Comment, { comment: withPhoto, viewer: { id: "I9001", label: "Me" }, features: FEATURES, onReact: () => {} }));
  const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 1, "only the attachment is an image");
  assert.match(imgs[0], /src="\/uploads\/comments\//);
  assert.doesNotMatch(html, /(src|href)="https?:\/\/tracker\.example\.test/, "nothing carries the external host as a src or href");
  assert.doesNotMatch(html, /href="mailto:/i);
  // Only the comment itself is reactable: the single reactions row is the comment's, none sits inside the photo's <li>.
  assert.doesNotMatch(html, /io-comments-photo[^]*io-comments-reactions[^]*<\/li>/);
});

test("the photo labels read lowercase, the caption field is 'add a caption' (P2-R47) and the kit's own labels are all still there", () => {
  assert.equal(PHOTO_LABELS.addPhoto, "add a photo");
  assert.equal(PHOTO_LABELS.photoDescription, "add a caption");
  assert.equal(PHOTO_LABELS.photoDescriptionHint, "add a caption");
  for (const k of Object.keys(PHOTO_LABELS)) assert.ok(Object.hasOwn(DEFAULT_LABELS, k), `${k} is a kit label`);
  assert.equal(MAX_PHOTOS, 4);
  assert.deepEqual({ ...FEATURES }, { attachmentReactions: false, photoCaptions: false });
});

test("a comment photo's img alt is the who-photo line; the typed caption is never repeated as the alt", () => {
  const one = { author: { label: "Test Person" }, attachments: [{ alt: "the garden in spring" }] };
  assert.equal(commentPhotoAlt(one, 0), "a photo from Test Person");
  const three = { author: { label: "Test Person" }, attachments: [{}, {}, {}] };
  assert.equal(commentPhotoAlt(three, 1), "photo 2 of 3 from Test Person");
  assert.equal(commentPhotoAlt({ author: { label: "  " }, attachments: [{}] }, 0), "a photo");
  assert.doesNotMatch(commentPhotoAlt(one, 0), /garden/);
});

test("a photo upload failure shows E10 for a decode failure, the sign-in line for a 401, and 'that didn't upload' otherwise", () => {
  assert.equal(photoUploadMessage(new PhotoDecodeError()), "that photo type didn't work here. try a jpeg or a screenshot.");
  assert.equal(photoUploadMessage(new ApiError(401, "unauthenticated", "x")), "you got signed out. sign in again?");
  assert.equal(photoUploadMessage(new ApiError(503, "unavailable", "x")), "that didn't upload. try again.");
  assert.equal(photoUploadMessage(new Error("Upload failed (HTTP 500).")), PHOTO_COPY.upload);
});

// ---- the comment source ---------------------------------------------------------------------------------------------------------
const fakeApi = (reply) => { const calls = []; return { calls, post: async (path, body) => { calls.push({ path, body }); return reply(body); } }; };
const ATT = { url: "/uploads/comments/01JZZZZZZZZZZZZZZZZZZZZ002/photo.jpg", mime: "image/jpeg", width: 800, height: 600, alt: "the garden" };

test("create sends the photo attachments, and a photo-only comment goes with an empty body", async () => {
  const api = fakeApi((b) => ({ id: "c1", ...b }));
  const src = createHfyCommentSource(api);
  await src.create("person:I9001", { body: "", attachments: [ATT] });
  await src.create("person:I9001", { body: "hi" });
  assert.deepEqual(api.calls[0].body, { subject: "person:I9001", body: "", attachments: [ATT] });
  assert.deepEqual(api.calls[1].body, { subject: "person:I9001", body: "hi" }, "no attachments key without photos");
});

test("a caption with contact details is held before it is sent (R-18), with the DS copy", async () => {
  const api = fakeApi(() => ({}));
  const src = createHfyCommentSource(api);
  await assert.rejects(src.create("person:I9001", { body: "", attachments: [{ ...ATT, alt: "call me on 555-010-0199 or write test@example.test" }] }), (e) => e.code === "validation");
  assert.equal(api.calls.length, 0);
});

test("the API's photo refusals become their copy, the comment text is not lost, and other failures stay 'didn't post'", async () => {
  for (const [code, copy] of [["photo_has_location", PHOTO_COPY.location], ["upload_missing", PHOTO_COPY.missing], ["upload_not_owned", PHOTO_COPY.missing]]) {
    const src = createHfyCommentSource({ post: async () => { throw new ApiError(code === "photo_has_location" ? 400 : 403, code, "server words") ; } });
    await assert.rejects(src.create("person:I9001", { body: "hi", attachments: [ATT] }), (e) => e.code === "validation" && e.message === copy && e.field === "attachments");
  }
  const src = createHfyCommentSource({ post: async () => { throw new ApiError(500, "server", "boom"); } });
  await assert.rejects(src.create("person:I9001", { body: "hi", attachments: [ATT] }), (e) => e.code === "server" && /didn't post/.test(e.message));
});
