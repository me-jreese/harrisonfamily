// HFY-TSK-387-0G: post photos graduate to Gramps Media on publish, behind HFY_POST_GRADUATE (default off). In-memory DynamoDB and S3 fakes, the real
// applyBatch, synthetic ids and names only. The backfill script is covered at the end (dry run counts, the --apply approval refusal).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { POST_TAG, POST_TAG_HANDLE, createPostGraduation, markerKey, normalizeRect, plan, postGraduateFromEnv, tagsOf, uploadKeyOf } from "../src/post-graduate.js";
import { APPROVAL_REF_RE, describePlan, parseArgs, planBackfill, run } from "../scripts/post-graduate-backfill.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/post-graduate-backfill.mjs", import.meta.url));
const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [],
});
const AUTHOR = person(3);
const TAGGED = person(4);
const q = { warn() {}, error() {}, info() {} };
const POST_ID = "01J0000000000000000000PP01";

let w, hooks, store, tok;

async function world({ postGraduate, seeded = true } = {}) {
  hooks = createHookRegistry();
  const api = makeApi({
    admins: ["I0099"], log: q,
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(["I0099"]), txnOpts: { sleep: async () => {} }, ...(postGraduate !== undefined ? { postGraduate } : {}) },
  });
  registerRecordContributor({ ddb: api.ddb, cmds, table: TABLE, log: q }, hooks);
  api.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: api.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  for (const p of [AUTHOR, TAGGED]) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${p.handle}`, ops: [{ op: "create", class: "Person", handle: p.handle, base_version: null, obj: p }] });
  api.ddb.rows.get("SYNC#HEAD\u0000META").seeded = seeded;
  api.sctx = sctx;
  return api;
}
/** A direct instance over the world's tables (no HTTP), with the switch on unless told otherwise. */
function direct(extra = {}) {
  store = { ddb: w.ddb, cmds, table: TABLE, now: () => Date.now(), uid: (() => { let n = 0; return () => `d${++n}`; })(), log: q, hooks, idPolicy: { mode: "mint" }, txnOpts: { sleep: async () => {} } };
  return createPostGraduation({ ddb: w.ddb, cmds, table: TABLE, store, s3: w.s3, enabled: () => true, log: q, ...extra });
}
const presign = async (contentType = "image/jpeg") => (await w.call("POST", "/api/uploads", { token: tok, body: { contentType, size: 9 } })).body;
async function photo(extra = {}, contentType = "image/jpeg") {
  const up = await presign(contentType);
  return { kind: "image", url: `/${up.key}`, mime: contentType, width: 640, height: 480, alt: "a picnic", ...extra };
}
const mkPost = (attachments, extra = {}) => ({ id: POST_ID, type: "post", author: { id: AUTHOR.gramps_id, label: "A" }, body: "b", attachments, visibility: "published", ...extra });
const row = (pk, sk) => w.ddb.rows.get(`${pk}\u0000${sk}`);
const heads = (cls) => w.ddb.all().filter((r) => r.PK.startsWith(`REC#${cls}#`) && r.SK === "HEAD");
const obj = (r) => JSON.parse(r.obj_json);
const personObj = (p) => obj(row(`REC#Person#${p.handle}`, "HEAD"));
const markers = () => w.ddb.all().filter((r) => r.PK.startsWith("POSTGRAD#"));

beforeEach(async () => {
  w = await world();
  tok = await signToken(AUTHOR.gramps_id);
});

describe("pure helpers", () => {
  it.each([
    [[10, 10, 40, 40], [10, 10, 40, 40]],
    [[0, 0, 100, 100], null], [[10, 10, 10, 40], null], [[40, 10, 10, 40], null], [[1.5, 0, 20, 20], null], [[-1, 0, 20, 20], null],
    [[0, 0, 101, 20], null], [[1, 2, 3], null], ["x", null], [null, null],
  ])("normalizeRect(%j) is %j", (input, want) => expect(normalizeRect(input)).toEqual(want));

  it("reads the switch only when it is exactly on", () => {
    expect([undefined, "", "1", "true", "ON", "off", "on"].map((v) => postGraduateFromEnv({ HFY_POST_GRADUATE: v }))).toEqual([false, false, false, false, false, false, true]);
    expect(postGraduateFromEnv({})).toBe(false);
  });

  it("tagsOf keeps well-formed, distinct people, at most 20, with a normalized region", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ person: `I${i + 100}`, rect: [1, 1, 5, 5] }));
    expect(tagsOf({ tags: [{ person: "I0004", rect: [10, 10, 40, 40] }, { person: "I0004", rect: [1, 1, 2, 2] }, { person: 5 }, { person: "bad id" }, { person: "I0005", rect: [0, 0, 100, 100] }] }))
      .toEqual([{ person: "I0004", rect: [10, 10, 40, 40] }, { person: "I0005", rect: null }]);
    expect(tagsOf({ tags: many })).toHaveLength(20);
    expect(tagsOf({})).toEqual([]);
  });

  it("uploadKeyOf accepts a member post upload, relative or on the public base, and nothing else", () => {
    const k = "uploads/posts/01J0000000000000000000AA01/photo.jpg";
    expect(uploadKeyOf(`/${k}`)).toBe(k);
    expect(uploadKeyOf(`https://site.test/${k}`, "https://site.test")).toBe(k);
    for (const bad of [`https://elsewhere.test/${k}`, "/uploads/comments/01J0000000000000000000AA01/p.jpg", "/uploads/posts/short/p.jpg", undefined, 5]) expect(uploadKeyOf(bad, "https://site.test")).toBeUndefined();
  });

  it.each([
    ["png", { mime: "image/png" }, "unsupported_type"],
    ["hidden photo", { moderation: { hidden: true } }, "moderated"],
    ["bad path", { url: "/somewhere/else.jpg" }, "bad_upload_path"],
    ["jpeg", {}, undefined],
  ])("plan: %s", (_n, over, skip) => {
    const a = { kind: "image", url: "/uploads/posts/01J0000000000000000000AA01/p.jpg", mime: "image/jpeg", ...over };
    expect(plan(mkPost([a, { kind: "file", url: "/uploads/posts/01J0000000000000000000AA02/f.pdf", mime: "application/pdf" }]))).toMatchObject([{ index: 0, ...(skip ? { skip } : {}) }]);
    expect(plan(mkPost([a]))[0].skip).toBe(skip);
  });
  it("plan: a hidden post skips every photo", () => {
    const a = { kind: "image", url: "/uploads/posts/01J0000000000000000000AA01/p.jpg", mime: "image/jpeg" };
    expect(plan(mkPost([a], { moderation: { hidden: true } }))[0].skip).toBe("moderated");
  });
});

describe("graduation", () => {
  it("two photos make two Media on the author, each with the hfy-post Tag, and one Tag", async () => {
    const g = direct();
    const post = mkPost([await photo({ alt: "first" }), await photo({ alt: "second" })]);
    const r = await g.graduate(post);
    expect(r.state).toBe("ok");
    expect(r.photos.map((p) => p.state)).toEqual(["done", "done"]);
    const media = heads("Media").map(obj);
    expect(media).toHaveLength(2);
    const tags = heads("Tag").map(obj);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ name: POST_TAG, handle: POST_TAG_HANDLE });
    for (const m of media) {
      expect(m.tag_list).toEqual([POST_TAG_HANDLE]);
      expect(m.attribute_list.some((a) => a.type.string === "hfy:source" && a.value.startsWith(`post-photo:post:${POST_ID}/`))).toBe(true);
    }
    expect(media.map((m) => m.desc).sort()).toEqual(["first", "second"]);
    const refs = personObj(AUTHOR).media_list;
    expect(refs.map((x) => x.ref)).toEqual(r.photos.map((p) => p.media_handle)); // appended in the post's order
    expect(refs.every((x) => x.rect === null)).toBe(true);
    expect(w.s3.copies).toHaveLength(2);
    expect(markers().map((m) => m.state)).toEqual(["done", "done"]);
  });

  it("a tagged person gets an appended MediaRef with the region; an unknown person is left out; a bad region is null", async () => {
    const g = direct();
    const post = mkPost([
      await photo({ tags: [{ person: TAGGED.gramps_id, rect: [10, 10, 40, 40] }, { person: "I7777", rect: [1, 1, 9, 9] }] }),
      await photo({ tags: [{ person: TAGGED.gramps_id, rect: [0, 0, 100, 100] }, { person: AUTHOR.gramps_id, rect: [20, 20, 60, 60] }] }),
    ]);
    const r = await g.graduate(post);
    expect(r.photos.map((p) => p.state)).toEqual(["done", "done"]);
    const [m1, m2] = r.photos.map((p) => p.media_handle);
    expect(personObj(TAGGED).media_list).toMatchObject([{ ref: m1, rect: [10, 10, 40, 40] }, { ref: m2, rect: null }]);
    expect(personObj(AUTHOR).media_list).toMatchObject([{ ref: m1, rect: null }, { ref: m2, rect: [20, 20, 60, 60] }]);
    expect(heads("Media")).toHaveLength(2);
  });

  it("is idempotent: a republish or retry makes no second Media, Tag or MediaRef", async () => {
    const g = direct();
    const post = mkPost([await photo(), await photo()]);
    const first = await g.graduate(post);
    const second = await g.graduate(post);
    expect(second.photos.every((p) => p.state === "done" && p.already === true)).toBe(true);
    expect(second.photos.map((p) => p.media_handle)).toEqual(first.photos.map((p) => p.media_handle));
    expect(heads("Media")).toHaveLength(2);
    expect(heads("Tag")).toHaveLength(1);
    expect(personObj(AUTHOR).media_list).toHaveLength(2);
    expect(w.s3.copies).toHaveLength(2);
  });

  it.each(["reserve", "copy", "apply"])("a failure after %s leaves the photo pending and the retry finishes it exactly once", async (name) => {
    let fault = name;
    const g = direct({ afterPhase: async (n) => { if (fault === n) { fault = null; throw new Error("injected"); } } });
    const post = mkPost([await photo()]);
    const a = await g.graduate(post);
    expect(a.photos[0].state).toBe("pending");
    const handle = markers()[0].media_handle;
    const b = await g.graduate(post);
    expect(b.photos[0]).toMatchObject({ state: "done", media_handle: handle });
    expect(heads("Media")).toHaveLength(1);
    expect(personObj(AUTHOR).media_list).toHaveLength(1);
    expect(markers()[0].state).toBe("done");
  });

  it("reuses a Tag named hfy-post that the store already has", async () => {
    await applyBatch(w.sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "seed-tag", ops: [{ op: "create", class: "Tag", handle: h(77), base_version: null, obj: { _class: "Tag", handle: h(77), name: POST_TAG, color: "#000000000000", priority: 0, change: 1 } }] });
    const g = direct();
    await g.graduate(mkPost([await photo()]));
    expect(heads("Tag")).toHaveLength(1);
    expect(obj(heads("Media")[0]).tag_list).toEqual([h(77)]);
  });

  it.each([
    ["a draft", async () => mkPost([await photo()], { visibility: "draft" }), "not_published"],
    ["a hidden post", async () => mkPost([await photo()], { moderation: { hidden: true } }), "moderated"],
    ["a hidden photo", async () => mkPost([await photo({ moderation: { hidden: true } })]), "moderated"],
    ["a png", async () => mkPost([await photo({}, "image/png")]), "unsupported_type"],
  ])("%s is not graduated", async (_n, build, why) => {
    const g = direct();
    const r = await g.graduate(await build());
    if (why === "not_published") expect(r.state).toBe("not_published");
    else expect(r.photos).toMatchObject([{ state: "skipped", reason: why }]);
    expect(heads("Media")).toHaveLength(0);
    expect(heads("Tag")).toHaveLength(0);
    expect(markers()).toHaveLength(0);
  });

  it("a photo that failed leaves the others alone, and a missing upload is a failed marker", async () => {
    const g = direct();
    const a = await photo();
    const b = await photo();
    w.s3.objects.delete(a.url.slice(1)); // the first upload is gone
    const r = await g.graduate(mkPost([a, b]));
    expect(r.photos.map((p) => p.state).sort()).toEqual(["done", "skipped"]);
    expect(heads("Media")).toHaveLength(1);
    expect(markers().map((m) => m.state).sort()).toEqual(["done", "failed"]);
  });

  it("an author with no Person graduates nothing (failed marker, no Media)", async () => {
    const g = direct();
    const r = await g.graduate(mkPost([await photo()], { author: { id: "I7777", label: "A" } }));
    expect(r.photos).toMatchObject([{ state: "skipped", reason: "author_person_missing" }]);
    expect(heads("Media")).toHaveLength(0);
    expect(markers()[0].state).toBe("failed");
  });

  it("writes nothing while the store is not seeded", async () => {
    w = await world({ seeded: false });
    const g = direct();
    const r = await g.graduate(mkPost([await photo()]));
    expect(r.state).toBe("unavailable");
    expect(heads("Media")).toHaveLength(0);
    expect(markers()).toHaveLength(0);
  });

  it("is off unless enabled: no read, no write", async () => {
    const g = createPostGraduation({ ddb: w.ddb, cmds, table: TABLE, store: { ddb: w.ddb, cmds, table: TABLE }, s3: w.s3 });
    expect(await g.graduate(mkPost([await photo()]))).toEqual({ state: "disabled", photos: [] });
    expect(markers()).toHaveLength(0);
    expect(row(...Object.values(markerKey(POST_ID, "x")))).toBeUndefined();
  });
});

describe("the publish paths", () => {
  const publishBody = async (n = 2) => ({ type: "post", visibility: "published", body: "two photos", attachments: await Promise.all(Array.from({ length: n }, () => photo())) });
  const stripAtt = (b) => ({ ...b, attachments: b.attachments.map(({ tags: _t, ...a }) => a) });

  it("with the switch off (the default) publishing graduates nothing", async () => {
    const r = await w.call("POST", "/api/posts", { token: tok, body: stripAtt(await publishBody()) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(heads("Media")).toHaveLength(0);
    expect(markers()).toHaveLength(0);
  });

  it("with the switch on, publishing two photos makes two Media on the author, and deleting the post leaves them", async () => {
    w = await world({ postGraduate: true });
    tok = await signToken(AUTHOR.gramps_id);
    const r = await w.call("POST", "/api/posts", { token: tok, body: await publishBody() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(heads("Media")).toHaveLength(2);
    expect(heads("Media").every((m) => obj(m).tag_list.includes(POST_TAG_HANDLE))).toBe(true);
    expect(personObj(AUTHOR).media_list).toHaveLength(2);
    const del = await w.call("DELETE", `/api/posts/${r.body.id}`, { token: tok });
    expect(del.status).toBe(204);
    expect(heads("Media")).toHaveLength(2);
    expect(personObj(AUTHOR).media_list).toHaveLength(2);
  });

  it("a draft graduates at its first publish, and withdraw then republish adds nothing", async () => {
    w = await world({ postGraduate: true });
    tok = await signToken(AUTHOR.gramps_id);
    const r = await w.call("POST", "/api/posts", { token: tok, body: { ...(await publishBody(1)), visibility: "draft" } });
    expect(r.status).toBe(201);
    expect(heads("Media")).toHaveLength(0);
    for (const v of ["published", "draft", "published"]) expect((await w.call("POST", `/api/posts/${r.body.id}/visibility`, { token: tok, body: { visibility: v } })).status).toBe(200);
    expect(heads("Media")).toHaveLength(1);
    expect(markers()).toHaveLength(1);
  });

  it("a graduation failure never fails the publish", async () => {
    w = await world({ postGraduate: true, seeded: false });
    tok = await signToken(AUTHOR.gramps_id);
    const r = await w.call("POST", "/api/posts", { token: tok, body: await publishBody(1) });
    expect(r.status).toBe(201);
    expect(heads("Media")).toHaveLength(0);
  });
});

describe("the backfill", () => {
  const A = (n) => `/uploads/posts/01J0000000000000000000A${String(n).padStart(3, "0")}/p.jpg`;
  const img = (n, over = {}) => ({ kind: "image", url: A(n), mime: "image/jpeg", ...over });
  const putPost = (p) => w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: `POST#${p.id}`, SK: "META", GSI1PK: "POSTS", GSI1SK: p.id, entity: "post", post: p } }));
  const base = { type: "post", author: { id: "I0003", label: "A" }, body: "b", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  async function seed() {
    await putPost({ ...base, id: "01J0000000000000000000B001", visibility: "published", attachments: [img(1), img(2)] });
    await putPost({ ...base, id: "01J0000000000000000000B002", visibility: "published", attachments: [img(3, { mime: "image/png" }), img(4, { moderation: { hidden: true } })] });
    await putPost({ ...base, id: "01J0000000000000000000B003", visibility: "draft", attachments: [img(5)] });
    await putPost({ ...base, id: "01J0000000000000000000B004", visibility: "published", attachments: [{ kind: "file", url: "/uploads/posts/01J0000000000000000000A009/f.pdf", mime: "application/pdf" }] });
    await w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { ...markerKey("01J0000000000000000000B001", "01J0000000000000000000A001"), entity: "postgrad", state: "done", media_handle: h(9) } }));
  }

  it("a dry run counts, prints counts only, and writes nothing", async () => {
    await seed();
    const before = w.ddb.all().length;
    const lines = [];
    const out = await run({ ddb: w.ddb, cmds, table: TABLE, log: (l) => lines.push(l), graduate: () => { throw new Error("a dry run must not graduate"); } });
    expect(out.plan).toMatchObject({ posts: 4, publishedWithPhotos: 2, draftsWithPhotos: 1, photos: 4, alreadyGraduated: 1, wouldGraduate: 1, wouldSkip: { total: 2, reasons: { unsupported_type: 1, moderated: 1, bad_upload_path: 0 } } });
    expect(lines).toEqual([...describePlan(out.plan), "dry run: nothing written"]);
    expect(lines.join("\n")).not.toMatch(/01J0|I0003|uploads/);
    expect(w.ddb.all()).toHaveLength(before);
  });

  it("apply refuses without an approval reference, before it reads or writes anything", async () => {
    await seed();
    const before = w.ddb.all().length;
    for (const ref of [undefined, "", "DOC-123", "doc-5BB4A7956A88", "DOC-5BB4A7956A88 "]) {
      await expect(run({ ddb: w.ddb, cmds, table: TABLE, apply: true, approvalRef: ref, graduate: async () => ({ photos: [] }), log() {} })).rejects.toThrow(/approval-ref/);
    }
    expect(w.ddb.all()).toHaveLength(before);
    expect(APPROVAL_REF_RE.test("DOC-5BB4A7956A88")).toBe(true);
  });

  it("apply with a reference graduates the posts the plan names, and counts the outcome", async () => {
    await seed();
    const seen = [];
    const lines = [];
    const out = await run({ ddb: w.ddb, cmds, table: TABLE, apply: true, approvalRef: "DOC-5BB4A7956A88", log: (l) => lines.push(l), graduate: async (post) => { seen.push(post.id); return { photos: [{ state: "done" }, { state: "done", already: true }, { state: "skipped", reason: "moderated" }, { state: "pending" }] }; } });
    expect(seen).toEqual(["01J0000000000000000000B001"]);
    expect(out.result).toEqual({ done: 1, skipped: 1, pending: 1, reasons: { moderated: 1 } });
    expect(lines.at(-1)).toBe("applied: 1 graduated, 1 skipped (moderated: 1), 1 pending");
  });

  it("planBackfill on an empty store plans nothing", async () => {
    expect(await planBackfill({ ddb: w.ddb, cmds, table: TABLE })).toMatchObject({ posts: 0, photos: 0, wouldGraduate: 0, todo: [] });
  });

  it("parseArgs: dry run is the default; apply needs a reference; the two together are refused", () => {
    expect(parseArgs([], {})).toMatchObject({ apply: false, table: "hfy-app", region: "us-west-2" });
    expect(parseArgs(["--dry-run", "--table", "t"], {})).toMatchObject({ apply: false, table: "t" });
    expect(parseArgs(["--apply", "--approval-ref", "DOC-5BB4A7956A88"], {})).toMatchObject({ apply: true, approvalRef: "DOC-5BB4A7956A88" });
    expect(() => parseArgs(["--apply"], {})).toThrow(/approval-ref/);
    expect(() => parseArgs(["--apply", "--approval-ref", "nope"], {})).toThrow(/approval-ref/);
    expect(() => parseArgs(["--approval-ref", "DOC-5BB4A7956A88"], {})).toThrow(/for --apply/);
    expect(() => parseArgs(["--apply", "--dry-run", "--approval-ref", "DOC-5BB4A7956A88"], {})).toThrow(/not both/);
    expect(() => parseArgs(["--bogus"], {})).toThrow(/unknown argument/);
  });

  it("the command line refuses --apply without a reference before opening any client", () => {
    for (const args of [["--apply"], ["--apply", "--approval-ref", "bogus"]]) {
      let err;
      try { execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, AWS_REGION: "us-west-2" } }); } catch (e) { err = e; }
      expect(err?.status).toBe(1);
      expect(err.stderr).toMatch(/approval-ref/);
    }
  });
});
