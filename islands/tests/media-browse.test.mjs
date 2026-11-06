// HFY-TSK-388-0B: the browse ports of the media adapter (src/lib/hfy-media-browse.js) and the tag-editor host's tag mapping. Synthetic data only.
// Run: node --test tests/media-browse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHfyMediaBrowse, toCard, toDetail } from "../src/lib/hfy-media-browse.js";

const card = (id, over = {}) => ({ mediaId: id, thumbUrl: `/t/${id}-320.jpg`, width: 320, height: 240, section: "media", tagCount: 1, needsTags: false, title: "Picnic", year: 1952, grampsId: id, addedAt: 5, thumb: { s320: `/t/${id}-320.jpg`, s800: `/t/${id}-800.jpg`, w: 320, h: 240 }, ...over });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const calls = [];
const make = (r) => createHfyMediaBrowse({ fetch: async (url, init) => { calls.push({ url, init }); return typeof r === "function" ? r(url) : r; } });

test("listMedia asks for the section, filter and cursor and returns the kit page without the API's extras", async () => {
  const src = make(reply(200, { cards: [card("M1"), card("M2", { thumb: undefined, width: 0, height: 0 })], nextCursor: "c2", counts: { media: 5, posts: 2 } }));
  const page = await src.listMedia({ section: "media", filter: "needs_tags", cursor: "c1", limit: 30 });
  assert.equal(calls.at(-1).url, "/api/media?section=media&filter=needs_tags&cursor=c1&limit=30");
  assert.equal(calls.at(-1).init.credentials, "same-origin");
  assert.deepEqual(page.counts, { media: 5, posts: 2 });
  assert.equal(page.nextCursor, "c2");
  assert.equal(page.cards[0].grampsId, undefined);
  assert.equal(page.cards[0].thumb.s800, "/t/M1-800.jpg");
  assert.equal(page.cards[1].thumb, undefined);
  assert.equal(page.cards[1].width, 0);
});

test("listMedia defaults an unknown section or filter and maps an absent cursor to null", async () => {
  const src = make(reply(200, { cards: [], counts: {} }));
  const page = await src.listMedia({ section: "x", filter: "y" });
  assert.match(calls.at(-1).url, /section=media&filter=all$/);
  assert.deepEqual(page, { cards: [], nextCursor: null, counts: { media: 0, posts: 0 } });
});

test("errors: 404 NOT_FOUND, 401 and 403 FORBIDDEN, 500 and a network failure REQUEST_FAILED with the status", async () => {
  for (const [status, code] of [[404, "NOT_FOUND"], [401, "FORBIDDEN"], [403, "FORBIDDEN"], [500, "REQUEST_FAILED"]]) {
    await assert.rejects(make(reply(status, { error: "x" })).getMedia("M1"), (e) => e.code === code && e.status === status);
  }
  await assert.rejects(createHfyMediaBrowse({ fetch: async () => { throw new Error("offline"); } }).listMedia({ section: "media", filter: "all" }), (e) => e.code === "REQUEST_FAILED" && e.status === 0);
  await assert.rejects(make(reply(200, null)).listMedia({}), (e) => e.code === "REQUEST_FAILED");
});

const api = (over = {}) => ({
  card: card("M1"), imageUrl: "/media/M1.jpg", description: "At the lake.", origin: "post", originRef: "POST1", originBy: { displayName: "Ruth Example" },
  tags: [{ personId: "I1", mediaId: "M1", rect: [10, 10, 40, 50], index: 0, state: "applied", person: { displayName: "Ada Example" } }, { personId: "I2", mediaId: "M1", rect: null, index: 1, state: "applied", person: { displayName: "Bo Example" } }],
  version: "v1", commentsSubject: "media:M1", handle: "hM1", previousId: "M0", nextId: "M2", position: 2, total: 9, ...over,
});

test("getMedia asks with the section and filter of the context and maps previous and next, the origin name and the tags", async () => {
  const d = await make(reply(200, api())).getMedia("M 1", { section: "posts", filter: "of_me" });
  assert.equal(calls.at(-1).url, "/api/media/M%201?section=posts&filter=of_me");
  assert.deepEqual(d.neighbors, { prevId: "M0", nextId: "M2", position: 2, total: 9 });
  assert.equal(d.originName, "Ruth Example");
  assert.equal(d.originRef, "POST1");
  assert.equal(d.origin, "post");
  assert.equal(d.handle, "hM1");
  assert.equal(d.commentsSubject, "media:M1");
  assert.equal(d.tags[1].person.displayName, "Bo Example");
  assert.equal("living" in d.tags[1].person, false);
  assert.equal(d.tags[1].rect, null);
  assert.equal(d.version, "v1");
});

test("an item outside the list has no neighbours; a gramps import has neither origin name nor ref; an older reply without position gives 0 and 0", () => {
  const out = toDetail(api({ previousId: null, nextId: null, position: undefined, total: undefined, origin: "gramps", originRef: undefined, originBy: undefined }), "M1");
  assert.equal(out.neighbors, undefined);
  assert.equal(out.originName, undefined);
  assert.equal(out.originRef, undefined);
  const old = toDetail(api({ position: undefined, total: undefined }), "M1");
  assert.deepEqual(old.neighbors, { prevId: "M0", nextId: "M2", position: 0, total: 0 });
});

test("toCard falls back to the section media and keeps a card without a thumbnail", () => {
  const c = toCard({ mediaId: "M9", thumbUrl: "/o.jpg", section: "weird" });
  assert.deepEqual(c, { mediaId: "M9", thumbUrl: "/o.jpg", width: 0, height: 0, section: "media", tagCount: 0, needsTags: false });
});
