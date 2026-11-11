// HFY-TSK-408: POST /api/media/portrait, the tagged-photo variant {person, mediaId, rect}: a portrait from a photo the person is already tagged in (src/web-upload.js),
// and GET /api/media?person= (src/media-browser.js). In-memory DynamoDB fake, the real applyBatch and /api/changes pipeline, synthetic ids and names only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { pageOf } from "../src/media-browser.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const media = (n, gid, extra = {}) => ({ _class: "Media", handle: h(n), gramps_id: gid, private: false, path: `photo-${gid}.jpg`, mime: "image/jpeg", desc: `A synthetic photo ${gid}`, checksum: "", date: date(), attribute_list: [], citation_list: [], note_list: [], tag_list: [], ...extra });
const ref = (handle, rect = null, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: handle, rect, ...extra });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const q = { warn() {}, error() {}, info() {} };
const ME = "I0001";
const OTHER = "I0002";
const PORTRAIT = media(5000, "O0001"); // the current portrait of ME
const TAGGED = media(5001, "O0010"); // ME is tagged in it, with a face box
const OTHERS = media(5002, "O0011"); // OTHER is tagged in it
const PRIVATE = media(5003, "O0012", { private: true }); // a private Media (the store holds no private ref, so a third person lists it)
const HIDDEN = media(5004, "O0013"); // a Media no person lists: in no gallery
const STRANGER = media(5005, "O0014"); // visible, but only a third person is tagged in it
const BOX = [10, 10, 40, 40];

let w, flags;
beforeEach(async () => {
  process.env.HFY_EDITING = "on";
  flags = { inboxV1: true, mediaAddV1: true, portraitV1: true };
  const hooks = createHookRegistry();
  w = makeApi({
    admins: ["I0099"], log: q, flags,
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(["I0099"]), txnOpts: { sleep: async () => {} } },
  });
  registerRecordContributor({ ddb: w.ddb, cmds, table: TABLE, log: q }, hooks);
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  const seed = [
    person(1, { media_list: [ref(PORTRAIT.handle), ref(TAGGED.handle, BOX)] }),
    person(2, { media_list: [ref(OTHERS.handle, [20, 20, 50, 50])] }),
    person(3, { media_list: [ref(STRANGER.handle), ref(PRIVATE.handle)] }),
    PORTRAIT, TAGGED, OTHERS, PRIVATE, HIDDEN, STRANGER,
  ];
  await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "seed1", ops: seed.map(create) });
});
afterEach(() => { delete process.env.HFY_EDITING; });

const call = async (who, body) => w.call("POST", "/api/media/portrait", { token: await signToken(who), body });
const row = (pk, sk) => w.ddb.rows.get(`${pk}\u0000${sk}`);
const personObj = (n) => JSON.parse(row(`REC#Person#${h(n)}`, "HEAD").obj_json);
const version = (n) => row(`REC#Person#${h(n)}`, "HEAD").version;
const proposals = () => w.ddb.all().filter((r) => r.PK.startsWith("PROP#") && r.SK === "META");
const heads = (cls) => w.ddb.all().filter((r) => r.PK.startsWith(`REC#${cls}#`) && r.SK === "HEAD");
const refs = (n) => personObj(n).media_list.map((r) => [r.ref, r.rect]);

describe("the tagged-photo portrait, own page", () => {
  it("writes now: a new MediaRef with the square at index 0, the old portrait at index 1, no new Media and no upload marker", async () => {
    const media0 = heads("Media").length;
    const res = await call(ME, { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: ME });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: "applied", tags: [{ personId: ME, mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], index: 0, state: "applied" }] });
    expect(refs(1)).toEqual([[TAGGED.handle, [5, 5, 45, 45]], [PORTRAIT.handle, null], [TAGGED.handle, BOX]]);
    expect(heads("Media")).toHaveLength(media0);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("WEBUP#") || r.PK.startsWith("UPLOAD#"))).toHaveLength(0);
    expect(proposals()).toHaveLength(0);
  });
  it("a second photo shifts the first one to index 1 (P-1)", async () => {
    await call(ME, { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: ME });
    const first = personObj(1).media_list[0];
    expect(first.ref).toBe(TAGGED.handle);
    // ME is also tagged in the old portrait: pick it again with a square
    const res = await call(ME, { mediaId: PORTRAIT.gramps_id, rect: [20, 20, 60, 60], person: ME });
    expect(res.status).toBe(200);
    expect(refs(1).slice(0, 3)).toEqual([[PORTRAIT.handle, [20, 20, 60, 60]], [TAGGED.handle, [5, 5, 45, 45]], [PORTRAIT.handle, null]]);
  });
  it("an identical MediaRef (same photo, same rect) is moved to index 0, not repeated", async () => {
    const res = await call(ME, { mediaId: TAGGED.gramps_id, rect: BOX, person: ME });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(refs(1)).toEqual([[TAGGED.handle, BOX], [PORTRAIT.handle, null]]);
  });
  it("a full-frame rect (null) is stored as null", async () => {
    const res = await call(ME, { mediaId: TAGGED.gramps_id, rect: [0, 0, 100, 100], person: ME });
    expect(res.status).toBe(200);
    expect(personObj(1).media_list[0]).toMatchObject({ ref: TAGGED.handle, rect: null });
  });
  it("a repeated identical request writes nothing more", async () => {
    const body = { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: ME };
    expect((await call(ME, body)).status).toBe(200);
    const v = version(1);
    const len = personObj(1).media_list.length;
    const again = await call(ME, body);
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("applied");
    expect(version(1)).toBe(v);
    expect(personObj(1).media_list).toHaveLength(len);
  });
});

describe("the tagged-photo portrait, another person's page", () => {
  it("is a proposal: the page is untouched, one proposal, and a retry makes no second one", async () => {
    const body = { mediaId: OTHERS.gramps_id, rect: [15, 15, 55, 55], person: OTHER };
    const res = await call(ME, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: "pending-proposal", proposal: expect.any(String), tags: [{ personId: OTHER, rect: [15, 15, 55, 55], index: 0, state: "pending-proposal" }] });
    expect(refs(2)).toEqual([[OTHERS.handle, [20, 20, 50, 50]]]);
    expect(proposals()).toHaveLength(1);
    expect((await call(ME, body)).status).toBe(200);
    expect(proposals()).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("403 not_tagged when the person is not tagged in a photo that is visible", async () => {
    const res = await call(ME, { mediaId: STRANGER.gramps_id, rect: [5, 5, 45, 45], person: OTHER });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("not_tagged");
    expect(refs(2)).toEqual([[OTHERS.handle, [20, 20, 50, 50]]]);
    expect(proposals()).toHaveLength(0);
  });
  it.each([["a private Media", "O0012"], ["a Media that no gallery lists", "O0013"], ["a Media that does not exist", "O9999"]])("404 for %s", async (_name, mediaId) => {
    const v = version(1);
    const res = await call(ME, { mediaId, rect: [5, 5, 45, 45], person: ME });
    expect(res.status).toBe(404);
    expect(version(1)).toBe(v);
  });
  it("404 for an unknown person", async () => {
    expect((await call(ME, { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: "I9999" })).status).toBe(404);
  });
  it.each([
    [{ rect: [10, 10, 10, 40] }, "a zero-width rect"], [{ rect: [10.5, 10, 50, 50] }, "a fraction"], [{ rect: [10, 10, 11, 11] }, "under 2 x 2"], [{ rect: [60, 60, 10, 10] }, "inverted"],
    [{ rect: [0, 0, 101, 50] }, "out of range"], [{ rect: "x" }, "not a rect"], [{ rect: undefined }, "no rect"], [{ person: "bad id" }, "a malformed person"], [{ crop: null }, "the upload shape mixed in"],
  ])("400 for %j (%s)", async (extra) => {
    const v = version(1);
    const res = await call(ME, { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: ME, ...extra });
    expect(res.status).toBe(400);
    expect(version(1)).toBe(v);
  });
  it("404 while portraitV1 is off", async () => {
    flags.portraitV1 = false;
    expect((await call(ME, { mediaId: TAGGED.gramps_id, rect: [5, 5, 45, 45], person: ME })).status).toBe(404);
  });
});

describe("GET /api/media?person= (the filter)", () => {
  const tag = (gid) => ({ person: { gramps_id: gid } });
  const item = (id, at, gids) => ({ id, at, kind: "media", tags: gids.map(tag), card: { mediaId: id, section: "media" } });
  const cat = { viewerGid: ME, items: [item("O3", 3, [ME, OTHER]), item("O2", 2, [OTHER]), item("O1", 1, [ME]), { id: "pa-1", at: 0, kind: "attachment", tags: [], card: { mediaId: "pa-1", section: "media" } }] };
  it("lists only the photos that person is tagged in, with counts, and composes with of_me", () => {
    expect(pageOf(cat, { person: OTHER }).cards.map((c) => c.mediaId)).toEqual(["O3", "O2"]);
    expect(pageOf(cat, { person: OTHER }).counts).toEqual({ media: 2, posts: 0 });
    expect(pageOf(cat, { person: OTHER, filter: "of_me" }).cards.map((c) => c.mediaId)).toEqual(["O3"]);
    expect(pageOf(cat, { person: "I7777" }).cards).toEqual([]);
  });
  it("pages with a cursor that belongs to the person, and refuses another person's cursor or a bad id", () => {
    const first = pageOf(cat, { person: OTHER, limit: 1 });
    expect(first.cards.map((c) => c.mediaId)).toEqual(["O3"]);
    expect(pageOf(cat, { person: OTHER, limit: 1, cursor: first.nextCursor }).cards.map((c) => c.mediaId)).toEqual(["O2"]);
    expect(() => pageOf(cat, { person: ME, limit: 1, cursor: first.nextCursor })).toThrow();
    expect(() => pageOf(cat, { person: "bad id" })).toThrow();
  });
});
