// HFY-TSK-400: the profile avatar is the member's first photo (the renderer's primaryPhoto rule), behind @io-kit/profile's uploadedMediaAvatar.
// Synthetic ids only. The lookup is table-driven over an in-memory store; one handler-level case reads it through GET /api/people/:id/links.
import { describe, expect, it } from "vitest";
import { createAvatarLookup } from "../src/links.js";
import { createEditWorld } from "./edit-e2e-world.js";

const BASE = "https://site.test";
const ref = (media, over = {}) => ({ _class: "MediaRef", ref: media, rect: null, private: false, ...over });
const idx = (handle, over = {}) => [handle, { handle, s3Key: `media/${handle}.jpg`, missing: false, thumb: { s320: `media/thumb/${handle}-320.jpg`, s800: `media/thumb/${handle}-800.jpg`, w: 10, h: 10 }, ...over }];

/** Person I1 (handle p1) with the given media_list; `media` maps handle -> object (absent = not in the cloud store, as a private Media is). */
function lookupFor({ person = {}, media = {}, index = [], hidden = [], throwOn } = {}) {
  const heads = { "Person:p1": { obj: { private: false, media_list: [], ...person } } };
  for (const [h, o] of Object.entries(media)) heads[`Media:${h}`] = { obj: { private: false, ...o } };
  const deps = {
    byGrampsId: async (_c, cls, gid) => (cls === "Person" && gid === "I1" ? [{ handle: "p1" }] : []),
    get: async (_c, cls, h) => { if (throwOn === h) throw new Error("store down"); return heads[`${cls}:${h}`] ?? null; },
    hidden: async () => new Set(hidden),
  };
  const calls = [];
  const log = { error: (...a) => calls.push(a) };
  return { lookup: createAvatarLookup({ ctx: {}, readIndex: async () => new Map(index), publicBase: `${BASE}/`, log, deps }), calls };
}

describe("createAvatarLookup: the first photo, by the renderer's rule", () => {
  const two = { m1: {}, m2: {} };
  it.each([
    ["the first photo", { person: { media_list: [ref("m1"), ref("m2")] }, media: two, index: [idx("m1"), idx("m2")] }, `${BASE}/media/thumb/m1-320.jpg`],
    ["no photo at all", { person: { media_list: [] } }, null],
    ["a private MediaRef first: skipped, the next one", { person: { media_list: [ref("m1", { private: true }), ref("m2")] }, media: two, index: [idx("m1"), idx("m2")] }, `${BASE}/media/thumb/m2-320.jpg`],
    ["a private Media first: skipped", { person: { media_list: [ref("m1"), ref("m2")] }, media: { m1: { private: true }, m2: {} }, index: [idx("m1"), idx("m2")] }, `${BASE}/media/thumb/m2-320.jpg`],
    ["a Media absent from the store (private, never synced): skipped", { person: { media_list: [ref("m1"), ref("m2")] }, media: { m2: {} }, index: [idx("m1"), idx("m2")] }, `${BASE}/media/thumb/m2-320.jpg`],
    ["only private photos", { person: { media_list: [ref("m1", { private: true })] }, media: { m1: {} }, index: [idx("m1")] }, null],
    ["unpublished media (no index entry) fails closed", { person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [] }, null],
    ["unpublished media (index says missing) is skipped", { person: { media_list: [ref("m1"), ref("m2")] }, media: two, index: [idx("m1", { missing: true }), idx("m2")] }, `${BASE}/media/thumb/m2-320.jpg`],
    ["an index entry without an image key fails closed", { person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1", { s3Key: undefined })] }, null],
    ["no thumbnail: the image itself", { person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1", { thumb: undefined })] }, `${BASE}/media/m1.jpg`],
    ["a hidden Media (open MOD# media:) is skipped", { person: { media_list: [ref("m1"), ref("m2")] }, media: two, index: [idx("m1"), idx("m2")], hidden: ["media:m1"] }, `${BASE}/media/thumb/m2-320.jpg`],
    ["a hidden MediaRef (open MOD# mediaref:) is skipped", { person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1")], hidden: ["mediaref:p1:m1"] }, null],
    ["a private Person has no avatar", { person: { private: true, media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1")] }, null],
    ["a junk media_list entry is ignored", { person: { media_list: [null, "x", { ref: 5 }, ref("m1")] }, media: { m1: {} }, index: [idx("m1")] }, `${BASE}/media/thumb/m1-320.jpg`],
  ])("%s", async (_n, world, want) => {
    expect(await lookupFor(world).lookup("I1")).toBe(want);
  });

  it("an unknown person, a blank id and a non-string id are null", async () => {
    const { lookup } = lookupFor({ person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1")] });
    for (const id of ["I404", "", undefined, 7, null]) expect(await lookup(id)).toBeNull();
  });

  it("a store failure is null (fail closed) and is logged without a name", async () => {
    const { lookup, calls } = lookupFor({ person: { media_list: [ref("m1")] }, media: { m1: {} }, index: [idx("m1")], throwOn: "m1" });
    expect(await lookup("I1")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("I1");
  });

  it("no media index (not configured) is null", async () => {
    expect(await createAvatarLookup({ ctx: {}, publicBase: BASE })("I1")).toBeNull();
  });
});

describe("GET /api/people/:id/links carries avatar_url", () => {
  const entry = (handle, over = {}) => [handle, { handle, s3Key: `media/${handle}.jpg`, missing: false, thumb: { s320: `media/thumb/${handle}-320.jpg`, s800: `media/thumb/${handle}-800.jpg`, w: 10, h: 10 }, ...over }];
  const build = async (index) => createEditWorld({ photo: true, flags: { profileLinks: true }, extraDeps: { readMediaIndex: async () => new Map(index), mediaPublicBase: BASE } });

  it("the member with a published first photo gets it, others do not, and the view stays {links, version, can} otherwise", async () => {
    const w = await build([entry("0".repeat(24) + "1388")]); // h(5000) is 4 hex digits 1388
    try {
      const withPhoto = await w.call("GET", "/api/people/I0003/links", "I0001");
      expect(withPhoto.status).toBe(200);
      expect(withPhoto.body).toEqual({ links: {}, version: 0, avatar_url: `${BASE}/media/thumb/${"0".repeat(24)}1388-320.jpg`, can: { edit: false } });
      const none = await w.call("GET", "/api/people/I0001/links", "I0001");
      expect(none.body).toEqual({ links: {}, version: 0, can: { edit: true } });
    } finally { w.dispose(); }
  });

  it("a photo the media index has not published yet gives no avatar_url", async () => {
    const w = await build([]);
    try {
      expect((await w.call("GET", "/api/people/I0003/links", "I0001")).body).toEqual({ links: {}, version: 0, can: { edit: false } });
    } finally { w.dispose(); }
  });
});
