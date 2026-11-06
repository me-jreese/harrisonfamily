// HFY-TSK-388-0A: member portrait and new-media uploads behind the mediaAddV1 and portraitV1 flags (src/web-upload.js). In-memory DynamoDB and S3 fakes, the real
// applyBatch and /api/changes pipeline, synthetic ids and names only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { ATTR_ADDED_BY, ATTR_SOURCE, SOURCE_UPLOAD } from "../src/media-origin.js";
import { SERVER_SWITCHES } from "../src/features.js";
import { ROUTES } from "../src/routes.js";
import { WEB_UPLOAD_TAG, WEB_UPLOAD_TAG_HANDLE, cropToRect, parseItem } from "../src/web-upload.js";
import { jpeg, tiff, SOME_LAT, SOME_LON } from "./photo-fixtures.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const OLD = { _class: "Media", handle: h(5000), gramps_id: "O0001", private: false, path: "photo-0001.jpg", mime: "image/jpeg", desc: "A synthetic old photo", checksum: "", date: date(), attribute_list: [], citation_list: [], note_list: [], tag_list: [] };
const ref = (handle, rect = null) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: handle, rect });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const q = { warn() {}, error() {}, info() {} };
const ME = "I0001";
const OTHER = "I0002";

let w, saved, flags;
beforeEach(async () => {
  saved = { e: process.env.HFY_EDITING };
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
  await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "seed1", ops: [person(1, { media_list: [ref(OLD.handle)] }), person(2), OLD].map(create) });
});
afterEach(() => {
  for (const [k, v] of [["HFY_EDITING", saved.e]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const call = async (who, method, path, body) => w.call(method, path, { token: await signToken(who), body });
const presign = async (who, purpose, subject) => (await call(who, "POST", "/api/uploads", { purpose, subject })).body;
const commitRows = (rows) => ({ items: rows });
const row = (pk, sk) => w.ddb.rows.get(`${pk}\u0000${sk}`);
const heads = (cls) => w.ddb.all().filter((r) => r.PK.startsWith(`REC#${cls}#`) && r.SK === "HEAD");
const obj = (r) => JSON.parse(r.obj_json);
const personObj = (n) => obj(row(`REC#Person#${h(n)}`, "HEAD"));
const proposals = () => w.ddb.all().filter((r) => r.PK.startsWith("PROP#") && r.SK === "META");
const newMedia = () => heads("Media").map(obj).filter((m) => m.handle !== OLD.handle);
const attr = (m, name) => m.attribute_list.find((a) => a.type?.string === name)?.value;
async function graduated(who, purpose, subject, extra = {}) {
  const up = await presign(who, purpose, subject);
  const r = await call(who, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose, subject, ...extra }]));
  return { up, r };
}

describe("the switch and the routes", () => {
  it("gates the commit on mediaAddV1 and the portrait route on portraitV1, with no environment switch", () => {
    expect(SERVER_SWITCHES.some((n) => /WEB_UPLOAD|POST_GRADUATE/.test(n))).toBe(false);
    const gates = Object.fromEntries(ROUTES.filter((r) => r.name.startsWith("mediaUpload.")).map((r) => [r.name, [r.gate.type, r.gate.name]]));
    expect(gates).toEqual({ "mediaUpload.commit": ["feature", "mediaAddV1"], "mediaUpload.portrait": ["feature", "portraitV1"] });
  });
  it("answers 404 on every web route and refuses the web purposes while off, and a plain post presign is untouched", async () => {
    flags.mediaAddV1 = false;
    flags.portraitV1 = false;
    expect((await call(ME, "POST", "/api/uploads", { purpose: "portrait", subject: ME })).status).toBe(404);
    expect((await call(ME, "POST", "/api/media/uploads", commitRows([]))).status).toBe(404);
    expect((await call(ME, "POST", "/api/media/portrait", { personId: ME, mediaId: "O0001", crop: null })).status).toBe(404);
    expect((await call(ME, "POST", "/api/uploads", { contentType: "image/jpeg", size: 9 })).status).toBe(201);
  });
  it("each web purpose follows its own flag", async () => {
    const presignStatus = async (purpose) => (await call(ME, "POST", "/api/uploads", { purpose, subject: ME })).status;
    flags.portraitV1 = false;
    expect([await presignStatus("portrait"), await presignStatus("item")]).toEqual([404, 201]);
    flags.portraitV1 = true;
    flags.mediaAddV1 = false;
    expect([await presignStatus("portrait"), await presignStatus("item")]).toEqual([201, 404]);
  });
  it("needs a session", async () => {
    expect((await w.call("POST", "/api/media/uploads", { body: commitRows([]) })).status).toBe(401);
  });
});

describe("presign for the web purposes", () => {
  it("returns the upload id and expiry, binds the upload to the person, and takes only jpeg", async () => {
    const r = await call(ME, "POST", "/api/uploads", { purpose: "portrait", subject: OTHER });
    expect(r.status).toBe(201);
    expect(r.body.uploadId).toMatch(/^[0-9A-Z]{26}$/);
    expect(Date.parse(r.body.expiresAt)).toBeGreaterThan(Date.now() - 1);
    expect(r.body.key).toBe(`uploads/posts/${r.body.uploadId}/photo.jpg`);
    expect(row(`UPLOAD#${r.body.uploadId}`, "META")).toMatchObject({ owner: ME, purpose: "portrait", subject: OTHER });
  });
  it.each([
    [{ purpose: "item" }, "no subject"],
    [{ purpose: "item", subject: "x y" }, "a malformed subject"],
    [{ purpose: "item", subject: ME, contentType: "image/png" }, "png"],
    [{ purpose: "item", subject: ME, size: 11 * 1024 * 1024 }, "over 10 MB"],
  ])("refuses %j (%s)", async (body) => expect((await call(ME, "POST", "/api/uploads", body)).status).toBe(400));
});

describe("commit: the Media, its Tag and its origin Attributes", () => {
  it("graduates a portrait upload to a Media with the hfy-web-upload Tag and the two origin Attributes, and no MediaRef yet", async () => {
    const { r } = await graduated(ME, "portrait", ME);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([expect.objectContaining({ purpose: "portrait", state: "graduated", mediaId: expect.stringMatching(/^O\d+/) })]);
    const [m] = newMedia();
    expect(m.tag_list).toEqual([WEB_UPLOAD_TAG_HANDLE]);
    expect(attr(m, ATTR_SOURCE)).toBe(SOURCE_UPLOAD);
    expect(attr(m, ATTR_ADDED_BY)).toBe(ME);
    expect(m.private).toBe(false); // D-06
    expect(heads("Tag").map(obj)).toEqual([expect.objectContaining({ name: WEB_UPLOAD_TAG, handle: WEB_UPLOAD_TAG_HANDLE })]);
    expect(personObj(1).media_list.map((x) => x.ref)).toEqual([OLD.handle]);
  });
  it("is idempotent: the same upload twice makes one Media and one Tag", async () => {
    const { up, r } = await graduated(ME, "portrait", ME);
    const again = await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "portrait", subject: ME }]));
    expect(again.body.items[0].mediaId).toBe(r.body.items[0].mediaId);
    expect(newMedia()).toHaveLength(1);
    expect(heads("Tag")).toHaveLength(1);
    expect(row(`WEBUP#${up.uploadId}`, "MEDIA")).toMatchObject({ state: "done" });
  });
  it("a second upload reuses the Tag", async () => {
    await graduated(ME, "portrait", ME);
    await graduated(ME, "item", ME, { title: "A picnic" });
    expect(newMedia()).toHaveLength(2);
    expect(heads("Tag")).toHaveLength(1);
  });
  it("refuses bytes that carry a location with 400 photo_has_location and creates nothing", async () => {
    const up = await presign(ME, "item", ME);
    w.s3.objects.set(up.key, { bytes: jpeg({ exif: tiff({ gps: { version: true, lat: SOME_LAT, lon: SOME_LON } }) }), contentType: "image/jpeg" });
    const r = await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: ME, title: "A picnic" }]));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("photo_has_location");
    expect(newMedia()).toHaveLength(0);
  });
  it("refuses an upload that is not yours, a missing object, and a purpose or subject that differs from the presign", async () => {
    const up = await presign(ME, "item", ME);
    const other = await call(OTHER, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: ME, title: "A" }]));
    expect(other.status).toBe(404);
    expect((await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "portrait", subject: ME }]))).status).toBe(400);
    expect((await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: OTHER, title: "A" }]))).status).toBe(400);
    w.s3.objects.delete(up.key);
    expect((await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: ME, title: "A" }]))).status).toBe(400);
    expect(newMedia()).toHaveLength(0);
  });
  it("answers 503 and writes nothing while the store is not seeded", async () => {
    const up = await presign(ME, "portrait", ME);
    w.ddb.rows.get("SYNC#HEAD\u0000META").seeded = false;
    const r = await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "portrait", subject: ME }]));
    expect(r.status).toBe(503);
    expect(newMedia()).toHaveLength(0);
  });
});

describe("a new media item (purpose item)", () => {
  it("on your own page: title, year, about and description, and the MediaRef is appended, never index 0", async () => {
    const { r } = await graduated(ME, "item", ME, { title: "A picnic", year: 1962, about: true, description: "By the lake" });
    expect(r.body.items[0]).toMatchObject({ state: "applied", purpose: "item" });
    const [m] = newMedia();
    expect(m.desc).toBe("A picnic");
    expect(m.date.dateval).toEqual([0, 0, 1962, false]);
    expect(m.date.quality).toBe(1);
    expect(personObj(1).media_list.map((x) => [x.ref, x.rect])).toEqual([[OLD.handle, null], [m.handle, null]]);
    expect(personObj(1).media_list[1].private).toBe(false);
  });
  it("on another person's page: the Media exists, the page is untouched, and one suggestion is made (once, on a retry too)", async () => {
    const { up, r } = await graduated(ME, "item", OTHER, { title: "A picnic" });
    expect(r.body.items[0]).toMatchObject({ state: "pending-proposal", proposal: expect.any(String) });
    expect(personObj(2).media_list).toEqual([]);
    expect(proposals()).toHaveLength(1);
    const again = await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: OTHER, title: "A picnic" }]));
    expect(again.body.items[0].state).toBe("pending-proposal");
    expect(proposals()).toHaveLength(1);
    expect(newMedia()).toHaveLength(1);
  });
  it("a retry after the page write finds the ref and writes nothing more", async () => {
    const { up } = await graduated(ME, "item", ME, { title: "A picnic" });
    const again = await call(ME, "POST", "/api/media/uploads", commitRows([{ uploadId: up.uploadId, purpose: "item", subject: ME, title: "A picnic" }]));
    expect(again.body.items[0].state).toBe("applied");
    expect(personObj(1).media_list).toHaveLength(2);
  });
});

describe("the portrait", () => {
  const setPortrait = (who, personId, mediaId, crop) => call(who, "POST", "/api/media/portrait", { personId, mediaId, crop });
  it("on your own page: one submission adds the MediaRef with the crop and moves it to index 0; the old portrait is index 1", async () => {
    const { r } = await graduated(ME, "portrait", ME);
    const mediaId = r.body.items[0].mediaId;
    const p = await setPortrait(ME, ME, mediaId, [10, 10, 60, 60]);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ state: "applied", tags: [{ personId: ME, mediaId, rect: [10, 10, 60, 60], index: 0, state: "applied" }] });
    const list = personObj(1).media_list;
    expect(list.map((x) => x.rect)).toEqual([[10, 10, 60, 60], null]);
    expect(list[0].ref).toBe(newMedia()[0].handle);
    expect(list[1].ref).toBe(OLD.handle);
    expect(proposals()).toHaveLength(0);
  });
  it("a full-frame crop stores null, and setting the same portrait again writes nothing", async () => {
    const { r } = await graduated(ME, "portrait", ME);
    const mediaId = r.body.items[0].mediaId;
    const full = await setPortrait(ME, ME, mediaId, [0, 0, 100, 100]);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.tags[0].rect).toBeNull();
    expect(personObj(1).media_list[0]).toMatchObject({ ref: newMedia()[0].handle, rect: null });
    const version = row("REC#Person#" + h(1), "HEAD").version;
    const again = await setPortrait(ME, ME, mediaId, null);
    expect(again.body.state).toBe("applied");
    expect(row("REC#Person#" + h(1), "HEAD").version).toBe(version);
  });
  it("moves a photo that is already on the page to index 0 (the previous portrait stays)", async () => {
    const p = await setPortrait(ME, ME, "O0001", null);
    expect(p.status).toBe(200);
    expect(personObj(1).media_list.map((x) => x.ref)).toEqual([OLD.handle]);
    const { r } = await graduated(ME, "item", ME, { title: "A picnic" });
    const mediaId = r.body.items[0].mediaId;
    expect((await setPortrait(ME, ME, mediaId, null)).status).toBe(200);
    expect(personObj(1).media_list.map((x) => x.ref)).toEqual([newMedia()[0].handle, OLD.handle]);
    expect((await setPortrait(ME, ME, "O0001", null)).status).toBe(200);
    expect(personObj(1).media_list.map((x) => x.ref)).toEqual([OLD.handle, newMedia()[0].handle]);
  });
  it("on another person's page it is a suggestion: the page is untouched, and a retry makes no second one", async () => {
    const { r } = await graduated(ME, "portrait", OTHER);
    const mediaId = r.body.items[0].mediaId;
    const p = await setPortrait(ME, OTHER, mediaId, [5, 5, 55, 55]);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ state: "pending-proposal", proposal: expect.any(String), tags: [{ state: "pending-proposal", index: 0 }] });
    expect(personObj(2).media_list).toEqual([]);
    expect(proposals()).toHaveLength(1);
    await setPortrait(ME, OTHER, mediaId, [5, 5, 55, 55]);
    expect(proposals()).toHaveLength(1);
  });
  it.each([
    [{ crop: [10, 10, 10, 40] }, "a zero-width crop"], [{ crop: [10.5, 10, 50, 50] }, "a fraction"], [{ crop: [10, 10, 11, 11] }, "under 2 x 2"], [{ crop: [60, 60, 10, 10] }, "inverted"], [{ crop: [0, 0, 101, 50] }, "out of range"],
    [{ crop: "x" }, "not a rect"], [{}, "no crop"], [{ personId: "bad id", crop: null }, "a malformed person"],
  ])("refuses %j (%s)", async (extra) => {
    const { r } = await graduated(ME, "portrait", ME);
    const res = await call(ME, "POST", "/api/media/portrait", { personId: ME, mediaId: r.body.items[0].mediaId, ...extra });
    expect(res.status).toBe(400);
  });
  it("404 for an unknown photo or person", async () => {
    expect((await setPortrait(ME, ME, "O9999", null)).status).toBe(404);
    expect((await setPortrait(ME, "I9999", "O0001", null)).status).toBe(404);
  });
});

describe("pure helpers", () => {
  it.each([
    [null, null], [[0, 0, 100, 100], null], [[10, 10, 60, 60], [10, 10, 60, 60]],
  ])("cropToRect(%j) is %j", (c, want) => expect(cropToRect(c)).toEqual(want));
  it.each([[[10, 10, 10, 40]], [[1.5, 0, 20, 20]], [[1, 2, 3]], ["x"], [undefined]])("cropToRect(%j) throws 400", (c) => expect(() => cropToRect(c)).toThrow(expect.objectContaining({ status: 400 })));
  const base = { uploadId: "01J0000000000000000000XP01", purpose: "item", subject: "I0001", title: "A picnic" };
  it.each([
    [{}, true], [{ year: 1962, about: true }, true], [{ year: 1599 }, false], [{ year: 3000 }, false], [{ year: 19.5 }, false], [{ title: "" }, false],
    [{ title: "x".repeat(201) }, false], [{ description: "y".repeat(501) }, false], [{ purpose: "post" }, false], [{ uploadId: "nope" }, false], [{ about: "yes" }, false],
    [{ purpose: "portrait", title: "" }, true],
  ])("parseItem(%j) accepts: %s", (extra, ok) => {
    const run = () => parseItem({ ...base, ...extra }, 2026);
    if (ok) expect(run()).toMatchObject({ uploadId: base.uploadId }); else expect(run).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("about needs a year and is dropped without one", () => expect(parseItem({ ...base, about: true }, 2026)).not.toHaveProperty("about"));
});
