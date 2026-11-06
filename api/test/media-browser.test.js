// HFY-TSK-387-0E (V0): the Media Browser list and detail. Synthetic ids and names only; the store, the media index and the post list are in-memory fakes.
import { describe, expect, it } from "vitest";
import { LIVING_NAME, buildCatalog, createMediaBrowser, createMediaIndexReader, detailOf, pageOf } from "../src/media-browser.js";
import { isMediaPublished } from "../src/media-visible.js";
import { ROUTES, matchRoute } from "../src/routes.js";

const BASE = "https://site.test";
const POST_ID = "01J" + "0".repeat(17) + "PPPPPP";
const UPLOAD_A = "01J" + "0".repeat(20) + "AAA";
const UPLOAD_B = "01J" + "0".repeat(20) + "BBB";
const sha = (n) => `${String(n).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64);

const person = (gid, over = {}) => ({ class: "Person", handle: `p-${gid}`, gramps_id: gid, version: 1, obj: {
  _class: "Person", handle: `p-${gid}`, gramps_id: gid, private: false, death_ref_index: 0, media_list: [], primary_name: { first_name: `First${gid}`, surname_list: [{ primary: true, surname: "Sample" }] }, ...over } });
const ref = (media, over = {}) => ({ _class: "MediaRef", ref: media, rect: null, private: false, ...over });
const media = (gid, over = {}) => ({ class: "Media", handle: `m-${gid}`, gramps_id: gid, version: 3, obj: {
  _class: "Media", handle: `m-${gid}`, gramps_id: gid, private: false, desc: `Photo ${gid}`, change: 1_700_000_000, tag_list: [], attribute_list: [], date: { dateval: [0, 0, 1950, false] }, ...over } });
const tag = (name) => ({ class: "Tag", handle: `t-${name}`, obj: { name } });
const entry = (gid, over = {}) => [`m-${gid}`, { handle: `m-${gid}`, grampsId: gid, s3Key: `media/${gid}.jpg`, checksum: sha(1), size: 1, missing: false,
  thumb: { s320: `media/thumb/m-${gid}-aaaaaaaa-320.jpg`, s800: `media/thumb/m-${gid}-aaaaaaaa-800.jpg`, w: 640, h: 480 }, ...over }];
const post = (over = {}) => ({ id: POST_ID, visibility: "published", author: { id: "I9", label: "Label Nine" }, created_at: "2026-10-01T00:00:00.000Z", body: "x",
  attachments: [{ kind: "image", url: `/uploads/posts/${UPLOAD_A}/a.jpg`, mime: "image/jpeg", alt: "A photo", width: 100, height: 50 }], ...over });

/** A small world: I1 deceased, I2 living, I3 the viewer (deceased); media across sections. */
function world(extra = {}) {
  const heads = [
    person("I1", { media_list: [ref("m-O1", { rect: [10, 10, 40, 40] }), ref("m-O2")] }),
    person("I2", { death_ref_index: -1, media_list: [ref("m-O1", { rect: [50, 50, 90, 90] }), ref("m-O3")] }),
    person("I3", { media_list: [ref("m-O4")] }),
    person("I9", { death_ref_index: -1 }),
    media("O1", { change: 1_700_000_300 }), media("O2", { change: 1_700_000_200 }),
    media("O3", { change: 1_700_000_100, tag_list: ["t-hfy-post"], attribute_list: [{ type: { string: "hfy:source" }, value: `post:${POST_ID}/${UPLOAD_B}` }] }),
    media("O4", { change: 1_700_000_050, tag_list: ["t-hfy-web-upload"], attribute_list: [{ type: { string: "hfy:added-by" }, value: "I3" }] }),
    media("O5", { change: 1_700_000_900, private: true }),   // private Media: never listed
    media("O6", { change: 1_700_000_800 }),                  // no MediaRef from anyone: not in any gallery
    tag("hfy-post"), tag("hfy-web-upload"),
    ...(extra.heads ?? []),
  ];
  const index = new Map(["O1", "O2", "O3", "O4", "O5", "O6"].map((g) => entry(g)));
  return { heads, index, posts: extra.posts ?? [post()], hidden: new Set(extra.hidden ?? []), viewer: extra.viewer ?? { id: "I3" }, base: BASE };
}
const cat = (extra) => buildCatalog(world(extra));
const ids = (page) => page.cards.map((c) => c.mediaId);

describe("sections (M-1)", () => {
  it("media = imports and uploads; posts = hfy-post plus the ungraduated attachment; none in both", () => {
    const c = cat();
    expect(ids(pageOf(c, { section: "media" }))).toEqual(["O1", "O2", "O4"]);
    expect(ids(pageOf(c, { section: "posts" }))).toEqual([`pa-${UPLOAD_A}`, "O3"]); // the post (2026) is newer than every Media change
    expect(ids(pageOf(c, { section: "all" }))).toEqual([`pa-${UPLOAD_A}`, "O1", "O2", "O3", "O4"]);
  });
  it("an attachment that has graduated (its upload id on a Media) is listed once, as the Media", () => {
    const c = cat({ posts: [post({ attachments: [{ kind: "image", url: `/uploads/posts/${UPLOAD_B}/b.jpg`, mime: "image/jpeg" }] })] });
    expect(ids(pageOf(c, { section: "posts" }))).toEqual(["O3"]);
  });
  it("a bad section, filter or limit is 400 validation", () => {
    const c = cat();
    for (const q of [{ section: "x" }, { filter: "x" }, { limit: "0" }, { limit: "61" }, { cursor: "junk" }]) expect(() => pageOf(c, q)).toThrow(/must be|belong/);
  });
});

describe("filters (M-2, M-3)", () => {
  it("needs_tags lists exactly the Media with no visible MediaRef; of_me the Media tagged with the viewer's person", () => {
    // O1/O2/O3/O4 each have a ref; hide O2's only ref and it needs tags
    const c = cat({ hidden: ["mediaref:p-I1:m-O2"] });
    expect(ids(pageOf(c, { section: "all", filter: "needs_tags" }))).toEqual(["O2"]);
    expect(ids(pageOf(c, { section: "all", filter: "of_me" }))).toEqual(["O4"]);
    expect(pageOf(c, { section: "all", filter: "needs_tags" }).cards[0].needsTags).toBe(true);
  });
  it("post attachments are never in needs_tags or of_me", () => {
    const c = cat();
    expect(ids(pageOf(c, { section: "all", filter: "needs_tags" }))).not.toContain(`pa-${UPLOAD_A}`);
    expect(ids(pageOf(c, { section: "all", filter: "of_me" }))).not.toContain(`pa-${UPLOAD_A}`);
  });
  it("counts follow the filter and match the listing", () => {
    const c = cat();
    expect(pageOf(c, { section: "media" }).counts).toEqual({ media: 3, posts: 2 });
    expect(pageOf(c, { section: "media", filter: "of_me" }).counts).toEqual({ media: 1, posts: 0 });
  });
});

describe("visibility (M-4)", () => {
  it("never lists private, unreachable, hidden or unpublished Media", () => {
    const c = cat({ hidden: ["media:m-O4"] });
    const all = ids(pageOf(c, { section: "all", limit: "60" }));
    expect(all).not.toContain("O5");
    expect(all).not.toContain("O6");
    expect(all).not.toContain("O4");
    const noEntry = world();
    noEntry.index.delete("m-O1");
    noEntry.index.set("m-O2", { ...noEntry.index.get("m-O2"), missing: true });
    expect(ids(pageOf(buildCatalog(noEntry), { section: "media" }))).toEqual(["O4"]);
  });
  it("a private MediaRef or a private person does not make a Media reachable", () => {
    const w = world();
    w.heads.find((h) => h.handle === "p-I1").obj.media_list = [ref("m-O1", { private: true }), ref("m-O2")];
    w.heads.find((h) => h.handle === "p-I2").obj.private = true;
    const all = ids(pageOf(buildCatalog(w), { section: "all", limit: "60" }));
    expect(all).not.toContain("O1");
    expect(all).not.toContain("O3");
    expect(all).toContain("O2");
  });
  it("matches isMediaPublished on every Media of the world (the person gallery's rule)", async () => {
    const w = world({ hidden: [] });
    const heads = w.heads;
    const deps = {
      byGrampsId: async (_c, _cls, gid) => heads.filter((h) => h.class === "Media" && h.gramps_id === gid).map((h) => ({ handle: h.handle })),
      get: async (_c, cls, handle) => { const h = heads.find((x) => x.class === cls && x.handle === handle); return h ? { obj: h.obj } : null; },
      backrefs: async (_c, key) => heads.filter((h) => h.class === "Person" && h.obj.media_list.some((r) => `Media:${r.ref}` === key)).map((h) => `Person:${h.handle}`),
    };
    const listed = new Set(ids(pageOf(buildCatalog(w), { section: "media", limit: "60" })).concat(ids(pageOf(buildCatalog(w), { section: "posts", limit: "60" }))));
    for (const g of ["O1", "O2", "O3", "O4", "O5", "O6"]) expect(await isMediaPublished({}, g, deps)).toBe(listed.has(g));
  });
  it("a hidden or moderated post and a hidden photo are excluded for a member, kept for an admin", () => {
    const hiddenPost = post({ moderation: { hidden: true } });
    const hiddenPhoto = post({ attachments: [{ kind: "image", url: `/uploads/posts/${UPLOAD_A}/a.jpg`, mime: "image/jpeg", moderation: { hidden: true } }] });
    const draft = post({ visibility: "draft" });
    for (const p of [hiddenPost, hiddenPhoto, draft]) {
      expect(ids(pageOf(cat({ posts: [p] }), { section: "posts" }))).toEqual(["O3"]);
    }
    expect(ids(pageOf(cat({ posts: [hiddenPhoto], viewer: { id: "I3", roles: ["admin"] } }), { section: "posts" }))).toContain(`pa-${UPLOAD_A}`);
  });
});

describe("thumbnails (D-38)", () => {
  it("cards carry thumb {s320,s800,w,h} as site URLs, thumbUrl is the 320; absent thumb -> field omitted, the card falls back to the key", () => {
    const w = world();
    w.index.set("m-O2", { ...w.index.get("m-O2"), thumb: undefined });
    const cards = pageOf(buildCatalog(w), { section: "media" }).cards;
    const o1 = cards.find((c) => c.mediaId === "O1");
    expect(o1.thumb).toEqual({ s320: `${BASE}/media/thumb/m-O1-aaaaaaaa-320.jpg`, s800: `${BASE}/media/thumb/m-O1-aaaaaaaa-800.jpg`, w: 640, h: 480 });
    expect(o1.thumbUrl).toBe(o1.thumb.s320);
    expect(o1.width).toBe(640);
    const o2 = cards.find((c) => c.mediaId === "O2");
    expect("thumb" in o2).toBe(false);
    expect(o2.thumbUrl).toBe(`${BASE}/media/O2.jpg`);
  });
  it("card fields: title, year, tagCount, addedAt from the Gramps change time", () => {
    const o1 = pageOf(cat(), { section: "media" }).cards.find((c) => c.mediaId === "O1");
    expect(o1).toMatchObject({ section: "media", tagCount: 2, needsTags: false, title: "Photo O1", year: 1950, addedAt: new Date(1_700_000_300_000).toISOString() });
  });
});

describe("pagination and counts (M-6)", () => {
  it("newest first, no duplicates and no gaps across pages, stable when a newer item is inserted mid-way", () => {
    const w = world();
    const first = pageOf(buildCatalog(w), { section: "all", limit: "2" });
    expect(ids(first)).toEqual([`pa-${UPLOAD_A}`, "O1"]);
    w.heads.push(person("I5", { media_list: [ref("m-O7")] }), media("O7", { change: 1_700_001_000 })); // lands between the two cards already served
    w.index.set(...entry("O7"));
    const c2 = buildCatalog(w);
    const second = pageOf(c2, { section: "all", limit: "2", cursor: first.nextCursor });
    const third = pageOf(c2, { section: "all", limit: "2", cursor: second.nextCursor });
    expect(ids(second)).toEqual(["O2", "O3"]);
    expect(ids(third)).toEqual(["O4"]);
    expect(third.nextCursor).toBeNull();
    expect(second.nextCursor).not.toBeNull();
  });
  it("a cursor from one listing is refused by another", () => {
    const c = cat();
    const p = pageOf(c, { section: "all", limit: "1" });
    expect(() => pageOf(c, { section: "media", limit: "1", cursor: p.nextCursor })).toThrow(/belong/);
  });
});

describe("detail", () => {
  it("redacts a living person's name in tags, keeps a deceased one's, and carries rect, index, state and a base version", () => {
    const d = detailOf(cat(), "O1", {});
    expect(d.tags).toEqual([
      { personId: "I1", mediaId: "O1", rect: [10, 10, 40, 40], index: 0, state: "applied", person: { displayName: "FirstI1 Sample", living: false } },
      { personId: "I2", mediaId: "O1", rect: [50, 50, 90, 90], index: 0, state: "applied", person: { displayName: LIVING_NAME, living: true } },
    ]);
    expect(JSON.stringify(d)).not.toContain("FirstI2");
    expect(d).toMatchObject({ origin: "gramps", commentsSubject: "media:O1", imageUrl: `${BASE}/media/O1.jpg` });
    expect(d.originRef).toBeUndefined();
    expect(d.originBy).toBeUndefined();
  });
  it("the version moves when a tagged person's record moves", () => {
    const w = world();
    const before = detailOf(buildCatalog(w), "O1", {}).version;
    w.heads.find((h) => h.handle === "p-I1").version = 2;
    expect(detailOf(buildCatalog(w), "O1", {}).version).not.toBe(before);
  });
  it("origin line (M-8): post links the post, a living author is redacted; upload names the uploader; import shows none", () => {
    const d = detailOf(cat(), "O3", {});
    expect(d).toMatchObject({ origin: "post", originRef: POST_ID, originBy: { displayName: LIVING_NAME }, commentsSubject: "media:O3" });
    expect(JSON.stringify(d.originBy)).not.toContain("Nine");
    const up = detailOf(cat(), "O4", {});
    expect(up).toMatchObject({ origin: "upload", originRef: "I3", originBy: { displayName: "FirstI3 Sample" } });
    const unseen = detailOf(cat({ posts: [] }), "O3", {});
    expect(unseen.originRef).toBeUndefined(); // a post the viewer cannot see is not linked
    const w = world();
    w.heads.find((h) => h.handle === "p-I3").obj.death_ref_index = -1;
    const living = detailOf(buildCatalog(w), "O4", {});
    expect(living.originBy).toEqual({ displayName: LIVING_NAME });
    expect(living.originRef).toBeUndefined();
  });
  it("an ungraduated post photo has the post as origin, no tags, and the post as comment subject", () => {
    const d = detailOf(cat(), `pa-${UPLOAD_A}`, {});
    expect(d).toMatchObject({ origin: "post", originRef: POST_ID, tags: [], commentsSubject: `post:${POST_ID}`, version: expect.any(String) });
  });
  it("previous and next follow the section and filter", () => {
    const c = cat();
    expect(detailOf(c, "O2", { section: "media" })).toMatchObject({ previousId: "O1", nextId: "O4" });
    expect(detailOf(c, "O1", {})).toMatchObject({ previousId: null, nextId: "O2" }); // own section by default
    expect(detailOf(c, "O1", { section: "all" })).toMatchObject({ previousId: `pa-${UPLOAD_A}`, nextId: "O2" });
    expect(detailOf(c, "O1", { section: "posts" })).toMatchObject({ previousId: null, nextId: null }); // not in that list
    expect(detailOf(c, "O1", { section: "all", filter: "of_me" }).nextId).toBeNull();
  });
  it("an unknown id is 404", () => {
    expect(() => detailOf(cat(), "O9", {})).toThrow(/no such media/);
  });
});

describe("the service fails closed", () => {
  const make = (over = {}) => createMediaBrowser({
    ctx: {}, actor: { id: "I3" }, content: { list: async () => ({ items: [post()], cursor: null }) }, publicBase: BASE, log: { error() {} },
    readIndex: async () => world().index, loadHeads: async () => world().heads, loadHidden: async () => new Set(), isPublished: async () => true, ...over,
  });
  const code = (p) => p.then(() => "ok", (e) => e.code ?? e.message);
  it("lists, gets, and re-asks the person gallery rule for a Media", async () => {
    const s = make();
    expect((await s.list({ section: "media" })).cards.length).toBe(3);
    expect((await s.get("O1", {})).card.mediaId).toBe("O1");
    expect(await code(make({ isPublished: async () => false }).get("O1", {}))).toBe("not_found");
  });
  it.each([
    ["no media index wired", { readIndex: undefined }],
    ["a failed index read", { readIndex: async () => { throw new Error("boom Aunt Name"); } }],
    ["a failed store read", { loadHeads: async () => { throw new Error("boom"); } }],
    ["a failed post read", { content: { list: async () => { throw new Error("boom"); } } }],
    ["a failed moderation read", { loadHidden: async () => { throw new Error("boom"); } }],
  ])("%s is 503 unavailable", async (_n, over) => {
    expect(await code(make(over).list({ section: "media" }))).toBe("unavailable");
    expect(await code(make(over).get("O1", {}))).toBe("unavailable");
  });
  it("a failed gallery check on the detail is 503, never an open answer", async () => {
    expect(await code(make({ isPublished: async () => { throw new Error("boom"); } }).get("O1", {}))).toBe("unavailable");
  });
  it("logs a code, never a name", async () => {
    const lines = [];
    await make({ log: { error: (...a) => lines.push(JSON.stringify(a)) }, readIndex: async () => { throw new Error("Aunt Name was here"); } }).list({}).catch(() => {});
    expect(lines.join("")).not.toContain("Aunt Name");
  });
});

describe("the index reader", () => {
  it("caches for the ttl, does not cache a failure, and refuses a non-list", async () => {
    let t = 0;
    let n = 0;
    const read = createMediaIndexReader({ load: async () => { n += 1; return [{ handle: "m-1" }, { nope: 1 }]; }, now: () => t, ttlMs: 100 });
    expect((await read()).size).toBe(1);
    await read();
    expect(n).toBe(1);
    t = 200;
    await read();
    expect(n).toBe(2);
    await expect(createMediaIndexReader({ load: async () => ({}) })()).rejects.toThrow();
  });
});

describe("routes", () => {
  it("GET /media and GET /media/:id are registered, member-authenticated, behind mediaBrowserV1, with no MCP tool", () => {
    for (const [path, name] of [["/media", "media.list"], ["/media/O1", "media.get"]]) {
      const { route } = matchRoute("GET", path, ROUTES, {});
      expect(route?.name).toBe(name);
      expect(route.gate).toMatchObject({ type: "feature", name: "mediaBrowserV1" });
      expect(route.write).toBeFalsy();
      expect(route.mcp).toBeUndefined();
    }
    expect(matchRoute("POST", "/media", ROUTES, {}).route).toBeNull();
  });
});
