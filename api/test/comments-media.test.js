// HFY-TSK-387-0I (D-35, D-37): the `media:<gramps_id>` comment subject. Synthetic ids only; the in-memory DynamoDB fake.
import { describe, expect, it } from "vitest";
import { cmds, createFakeDdb, createUlidFactory, TABLE, ticker } from "./world.js";
import { SUBJECT_RE, createCommentSource } from "../src/comments.js";
import { isMediaPublished } from "../src/media-visible.js";

describe("SUBJECT_RE", () => {
  it.each([
    ["media:O0001", true],
    ["media:a_b.c-9", true],
    ["media:" + "x".repeat(64), true],
    ["media:" + "x".repeat(65), false],
    ["media:", false],
    ["media:O 1", false],
    ["media:O1/../x", false],
    ["Media:O0001", false],
    ["person:I0001", true],
    ["post:01J00000000000000000000001", true],
    ["proposal:01J00000000000000000000001", true],
    ["follow:O0001", false],
  ])("%s -> %s", (s, ok) => expect(SUBJECT_RE.test(s)).toBe(ok));
});

describe("media thread visibility", () => {
  const build = (mediaVisible) => {
    const ddb = createFakeDdb();
    const now = ticker();
    const ulid = createUlidFactory();
    const asked = [];
    const source = (viewer) => createCommentSource({
      ddb, cmds, table: TABLE, viewer, now, ulid, uid: () => ulid(now()),
      ...(mediaVisible ? { mediaVisible: async (id) => { asked.push(id); return mediaVisible(id); } } : {}),
    });
    return { source, asked };
  };
  const member = { id: "I0002", label: "Member" };
  const admin = { id: "I0009", label: "Admin", roles: ["admin"] };
  const code = (p) => p.then(() => "ok", (e) => e.code);

  it.each([
    ["public media", (id) => id === "O0001", "O0001", "ok"],
    ["private, withdrawn or missing media", (id) => id === "O0001", "O0002", "not_found"],
    ["a lookup that says nothing is true", () => undefined, "O0001", "not_found"],
  ])("%s: list is %s for a member and for an admin alike", async (_n, visible, id, want) => {
    const { source } = build(visible);
    expect(await code(source(member).list(`media:${id}`))).toBe(want);
    expect(await code(source(admin).list(`media:${id}`))).toBe(want);
  });

  it("fails closed without a lookup, and an error in the lookup is an error, never an open thread", async () => {
    expect(await code(build(null).source(member).list("media:O0001"))).toBe("not_found");
    const boom = build(() => { throw new Error("store down"); });
    await expect(boom.source(member).list("media:O0001")).rejects.toThrow("store down");
  });

  it("create and react follow the same gate; a public media thread takes a comment and lists it", async () => {
    const { source } = build((id) => id === "O0001");
    const created = await source(member).create({ threadId: "media:O0001", body: "a synthetic remark" });
    expect(created.threadId).toBe("media:O0001");
    expect((await source(member).list("media:O0001")).items.map((c) => c.body)).toEqual(["a synthetic remark"]);
    expect(await code(source(member).create({ threadId: "media:O0002", body: "x" }))).toBe("not_found");
    expect(await code(source(member).react("media:O0002", created.id, "👍"))).toBe("not_found");
  });

  it("asks only about media threads", async () => {
    const { source, asked } = build(() => true);
    await source(member).list("person:I0001");
    await source(member).list("media:O0001");
    expect(asked).toEqual(["O0001"]);
  });
});

describe("isMediaPublished (the person gallery rules)", () => {
  const world = (o) => ({
    byGrampsId: async (_c, cls, gid) => (cls === "Media" ? (o.media ?? []).filter((m) => m.gid === gid).map((m) => ({ handle: m.handle })) : []),
    get: async (_c, cls, h) => (cls === "Media" ? (o.media ?? []).find((m) => m.handle === h) : (o.people ?? {})[h]) && {
      obj: cls === "Media" ? { private: (o.media.find((m) => m.handle === h)).private } : o.people[h],
    },
    backrefs: async () => o.refs ?? [],
  });
  const person = (media_list, extra = {}) => ({ media_list, ...extra });
  it.each([
    ["a non-private ref of a non-private person", { media: [{ gid: "O1", handle: "m1" }], refs: ["Person:p1"], people: { p1: person([{ ref: "m1" }]) } }, true],
    ["no tombstoned or missing media", { media: [], refs: ["Person:p1"], people: { p1: person([{ ref: "m1" }]) } }, false],
    ["a private Media", { media: [{ gid: "O1", handle: "m1", private: true }], refs: ["Person:p1"], people: { p1: person([{ ref: "m1" }]) } }, false],
    ["a private MediaRef", { media: [{ gid: "O1", handle: "m1" }], refs: ["Person:p1"], people: { p1: person([{ ref: "m1", private: true }]) } }, false],
    ["a private person", { media: [{ gid: "O1", handle: "m1" }], refs: ["Person:p1"], people: { p1: person([{ ref: "m1" }], { private: true }) } }, false],
    ["media referenced only by an event", { media: [{ gid: "O1", handle: "m1" }], refs: ["Event:e1"], people: {} }, false],
    ["media nobody references", { media: [{ gid: "O1", handle: "m1" }], refs: [], people: {} }, false],
  ])("%s -> %s", async (_n, o, want) => expect(await isMediaPublished({}, "O1", world(o))).toBe(want));
  it("propagates a store failure", async () => {
    await expect(isMediaPublished({}, "O1", { byGrampsId: async () => { throw new Error("down"); } })).rejects.toThrow("down");
  });
});
