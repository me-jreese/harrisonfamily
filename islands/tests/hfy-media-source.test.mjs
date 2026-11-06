// HFY-TSK-388-0A: the HFY adapter for @io-kit/media over a mocked fetch (islands/src/lib/hfy-media-source.js). Synthetic ids only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_CHUNK, MIN_TAG_UNITS, RECT_UNIT, createHfyMediaSource, normalizeRect } from "../src/lib/hfy-media-source.js";

function mock(responses) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const { status = 200, body } = queue.shift() ?? { status: 500, body: {} };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

test("declares the int-percent unit and the 2-unit minimum (D-02, D-07)", () => {
  const s = createHfyMediaSource({ fetch: async () => ({}) });
  assert.deepEqual(s.rectUnit, RECT_UNIT);
  assert.deepEqual(s.rectUnit, { kind: "int-percent", min: 0, max: 100 });
  assert.equal(s.minTagUnits, MIN_TAG_UNITS);
  assert.equal(s.minTagUnits, 2);
  assert.equal(s.normalizeRect, normalizeRect);
});

for (const [input, want] of [
  [null, null], [undefined, null], [[0, 0, 100, 100], null], [[10, 10, 10, 10], null], [[10, 10, 10, 40], [10, 10, 10, 40]], [[10, 10, 60, 60], [10, 10, 60, 60]], [[60, 60, 10, 10], [10, 10, 60, 60]], [[12.5, 7.5, 58.5, 93.5], [13, 8, 59, 94]], [[-1, 0, 20, 20], [0, 0, 20, 20]], [[0, 0, 101, 20], [0, 0, 100, 20]], [[1.5, 0, 20, 20], [2, 0, 20, 20]],
]) {
  test(`normalizeRect(${JSON.stringify(input)}) is ${JSON.stringify(want)}`, () => assert.deepEqual(normalizeRect(input), want));
}
for (const bad of [[1, 2, 3], "x", [NaN, 0, 1, 1], {}, [0, 0, Infinity, 1]]) {
  test(`normalizeRect(${JSON.stringify(bad)}) throws INVALID_RECT`, () => assert.throws(() => normalizeRect(bad), (e) => e.code === "INVALID_RECT"));
}

test("presign posts the purpose and the person and maps the answer to the kit's ticket", async () => {
  const m = mock([{ status: 201, body: { uploadUrl: "https://s3.test/pending", uploadId: "01J0000000000000000000XP01", expiresAt: "2026-11-07T00:00:00.000Z", key: "k" } }]);
  const s = createHfyMediaSource({ fetch: m.fetch });
  assert.deepEqual(await s.upload.presign({ purpose: "portrait", subject: "I0001" }), { uploadId: "01J0000000000000000000XP01", url: "https://s3.test/pending", expiresAt: "2026-11-07T00:00:00.000Z" });
  assert.deepEqual(m.calls, [{ url: "/api/uploads", method: "POST", body: { purpose: "portrait", subject: "I0001" } }]);
});

test("commit sends only the fields given (about only when true) and returns uploadId, mediaId and the state", async () => {
  const m = mock([{ body: { items: [{ uploadId: "a", mediaId: "O0001", purpose: "item", state: "applied" }, { uploadId: "b", mediaId: "O0002", purpose: "item", state: "pending-proposal", proposal: "p1" }] } }]);
  const s = createHfyMediaSource({ fetch: m.fetch });
  const out = await s.upload.commit([
    { uploadId: "a", purpose: "item", subject: "I0001", title: "A picnic", year: 1962, about: true, description: "By the lake" },
    { uploadId: "b", purpose: "item", subject: "I0002", title: "A boat", about: false },
  ]);
  assert.deepEqual(m.calls[0].body.items, [
    { uploadId: "a", purpose: "item", subject: "I0001", title: "A picnic", year: 1962, about: true, description: "By the lake" },
    { uploadId: "b", purpose: "item", subject: "I0002", title: "A boat" },
  ]);
  assert.deepEqual(out, [{ uploadId: "a", mediaId: "O0001", state: "applied" }, { uploadId: "b", mediaId: "O0002", state: "pending-proposal", proposal: "p1" }]);
});

test(`commit sends at most ${COMMIT_CHUNK} uploads per request, in order`, async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ uploadId: `u${i}`, purpose: "portrait", subject: "I0001" }));
  const m = mock([
    { body: { items: items.slice(0, COMMIT_CHUNK).map((x, i) => ({ uploadId: x.uploadId, mediaId: `O${i}`, state: "graduated" })) } },
    { body: { items: items.slice(COMMIT_CHUNK).map((x, i) => ({ uploadId: x.uploadId, mediaId: `O${COMMIT_CHUNK + i}`, state: "graduated" })) } },
  ]);
  const out = await createHfyMediaSource({ fetch: m.fetch }).upload.commit(items);
  assert.deepEqual(m.calls.map((c) => c.body.items.length), [COMMIT_CHUNK, 2]);
  assert.deepEqual(out.map((o) => o.uploadId), items.map((i) => i.uploadId));
});

for (const [crop, sent] of [[null, null], [[0, 0, 100, 100], null], [[10, 10, 60, 60], [10, 10, 60, 60]]]) {
  test(`setPortrait with crop ${JSON.stringify(crop)} posts ${JSON.stringify(sent)} and returns the tags`, async () => {
    const tags = [{ personId: "I0001", mediaId: "O0001", rect: sent, index: 0, state: "applied" }];
    const m = mock([{ body: { state: "applied", tags } }]);
    assert.deepEqual(await createHfyMediaSource({ fetch: m.fetch }).portrait.setPortrait({ personId: "I0001", mediaId: "O0001", crop }), tags);
    assert.deepEqual(m.calls[0], { url: "/api/media/portrait", method: "POST", body: { personId: "I0001", mediaId: "O0001", crop: sent } });
  });
}

test("setPortrait refuses a malformed crop before any request", async () => {
  const m = mock([]);
  await assert.rejects(createHfyMediaSource({ fetch: m.fetch }).portrait.setPortrait({ personId: "I0001", mediaId: "O0001", crop: [1.5, 0, 9, 9] }), (e) => e.code === "INVALID_RECT");
  assert.equal(m.calls.length, 0);
});

for (const [status, body, code, serverCode] of [
  [400, { error: { code: "photo_has_location", message: "x" } }, "PHOTO_HAS_LOCATION", "photo_has_location"],
  [400, { code: "photo_has_location" }, "PHOTO_HAS_LOCATION", "photo_has_location"],
  [404, { error: { code: "not_found" } }, "REQUEST_FAILED", "not_found"],
  [503, {}, "REQUEST_FAILED", undefined],
]) {
  test(`an answer of ${status} ${JSON.stringify(body)} is a ${code} error carrying the status`, async () => {
    const m = mock([{ status, body }]);
    await assert.rejects(createHfyMediaSource({ fetch: m.fetch }).upload.presign({ purpose: "item", subject: "I0001" }), (e) => e.code === code && e.status === status && e.serverCode === serverCode);
  });
}

test("a network failure is REQUEST_FAILED with status 0", async () => {
  const s = createHfyMediaSource({ fetch: async () => { throw new Error("offline"); } });
  await assert.rejects(s.upload.presign({ purpose: "item", subject: "I0001" }), (e) => e.code === "REQUEST_FAILED" && e.status === 0);
});

test("listMedia and getMedia read GET /api/media with the section, filter and cursor", async () => {
  const m = mock([{ body: { cards: [], nextCursor: null, counts: { media: 0, posts: 0 } } }, { body: { card: {} } }]);
  const s = createHfyMediaSource({ fetch: m.fetch });
  await s.listMedia({ section: "media", filter: "needs_tags", cursor: "c1", limit: 24 });
  await s.getMedia("O0001", { section: "all", filter: "all" });
  assert.deepEqual(m.calls.map((c) => [c.method, c.url]), [["GET", "/api/media?section=media&filter=needs_tags&cursor=c1&limit=24"], ["GET", "/api/media/O0001?section=all&filter=all"]]);
});

test("the consent port is HFY policy: everyone visible is taggable, hideAll is a no-op (D-13)", async () => {
  const s = createHfyMediaSource({ fetch: async () => ({}) });
  assert.equal(await s.consent.isTaggable("I0001"), true);
  assert.equal(await s.consent.hideAll("I0001"), undefined);
  assert.deepEqual(s.consent.datamapClass.verbs, ["view", "export", "correct", "delete"]);
  for (const k of ["getTags", "putTags", "resolvePeople"]) assert.equal(typeof s[k], "function");
});
