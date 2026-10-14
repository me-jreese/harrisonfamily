// HFY-TSK-260 (tag-editor-ui): the photo tag editor's requests through POST /api/changes, end to end on the in-memory store. The ops are the ones
// the island builds (islands/src/lib/photo-tag-edit.js buildTagOps), so what the browser sends is what is judged here: a tag on your own record
// saves now, on someone else's it becomes a proposal, an admin's saves now; the commit credits a tag contribution; a stale key is a conflict
// that changes nothing. In-memory DynamoDB fake, synthetic ids, names and handles only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { buildTagOps } from "../../islands/src/lib/photo-tag-edit.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const photo = { _class: "Media", handle: h(5000), gramps_id: "O0001", private: false, path: "photo-0001.jpg", mime: "image/jpeg", desc: "A synthetic photo", checksum: "", date: date(), attribute_list: [], citation_list: [], note_list: [], tag_list: [] };
const mref = (rect, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: photo.handle, rect, ...extra });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const key = (obj) => `${obj._class}:${obj.handle}`;
const q = { warn() {}, error() {} };

const ME = "I0001";
const OTHER = "I0002";
const ADMIN = "I0099";

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world({ otherMedia = [] } = {}) {
  const hooks = createHookRegistry();
  const w = makeApi({
    admins: [ADMIN], log: q, flags: { inboxV1: true },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set([ADMIN]), txnOpts: { sleep: async () => {} } },
  });
  registerRecordContributor({ ddb: w.ddb, cmds, table: TABLE }, hooks);
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: (() => { let u = 0; return () => `s${++u}`; })(), unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  const me = person(1);
  const other = person(2, { media_list: otherMedia });
  await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "seed1", ops: [me, other, photo].map(create) });
  const post = async (who, body, { idem } = {}) => w.call("POST", "/api/changes", { token: await signToken(who), body, headers: idem ? { "idempotency-key": idem } : {} });
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const head = (obj) => { const row = w.ddb.rows.get(`REC#${obj._class}#${obj.handle}\u0000HEAD`); return { version: row.version, obj: JSON.parse(row.obj_json) }; };
  return { ...w, post, rows, head, me, other };
}
/** The edit bundle the island reads for a person: the stored object and its version. */
const bundleOf = (w, obj) => ({ key: key(obj), version: w.head(obj).version, obj: w.head(obj).obj });
const bodyOf = (w, obj, built) => ({ base_versions: { [key(obj)]: w.head(obj).version }, ops: built.ops });
const tagKinds = (w, who) => w.rows(`CONTRIB#${who}`).filter((x) => x.entity === "contrib").map((x) => x.kind).sort();

describe("a member tags themselves (their own record): saves now", () => {
  it("dry run puts it in the direct group; the save writes the MediaRef with the integer rect and credits a tag", async () => {
    const w = await world();
    const built = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [10.4, 20.2, 30.1, 40.9] });
    const dry = await w.post(ME, { ...bodyOf(w, w.me, built), dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.plan.direct.map((g) => g.opIds)).toEqual([["tag.add"]]);
    expect(dry.body.plan.review).toEqual([]);
    const r = await w.post(ME, bodyOf(w, w.me, built), { idem: "tag-self-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied).not.toBeNull();
    expect(r.body.proposal ?? null).toBeNull();
    expect(w.head(w.me).obj.media_list).toEqual([mref([10, 20, 31, 41])]);
    expect(tagKinds(w, ME)).toEqual(["self_edit", "tag"]);
  });

  it("move then undo: the set of rect saves now, the returned inverse puts the rect back", async () => {
    const w = await world();
    const added = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [10, 10, 30, 30] });
    await w.post(ME, bodyOf(w, w.me, added), { idem: "tag-self-add" });
    const moved = buildTagOps(bundleOf(w, w.me), { kind: "move", mediaHandle: photo.handle, from: [10, 10, 30, 30], rect: [12, 11, 33, 31] });
    const r = await w.post(ME, bodyOf(w, w.me, moved), { idem: "tag-self-move" });
    expect(r.status).toBe(201);
    expect(w.head(w.me).obj.media_list.map((m) => m.rect)).toEqual([[12, 11, 33, 31]]);
    const undo = r.body.applied.undo;
    expect(undo.ops.length).toBeGreaterThan(0);
    const back = await w.post(ME, { target: key(w.me), base_versions: undo.base_versions, ops: undo.ops }, { idem: "tag-self-undo" });
    expect(back.status).toBe(201);
    expect(w.head(w.me).obj.media_list.map((m) => m.rect)).toEqual([[10, 10, 30, 30]]);
  });

  it("remove your own tag: saves now, and the other tags of the same photo stay", async () => {
    const w = await world();
    const a = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [10, 10, 30, 30] });
    await w.post(ME, bodyOf(w, w.me, a), { idem: "a1" });
    const b = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [50, 50, 70, 70] });
    await w.post(ME, bodyOf(w, w.me, b), { idem: "a2" });
    expect(w.head(w.me).obj.media_list).toHaveLength(2);
    const rm = buildTagOps(bundleOf(w, w.me), { kind: "remove", mediaHandle: photo.handle, from: [50, 50, 70, 70] });
    const r = await w.post(ME, bodyOf(w, w.me, rm), { idem: "rm1" });
    expect(r.status).toBe(201);
    expect(w.head(w.me).obj.media_list.map((m) => m.rect)).toEqual([[10, 10, 30, 30]]);
  });
});

describe("a member tags someone else: a proposal, and nothing changes until it is approved", () => {
  it("the dry run puts it in the review group and the save stores a proposal only", async () => {
    const w = await world();
    const built = buildTagOps(bundleOf(w, w.other), { kind: "add", mediaHandle: photo.handle, rect: [40, 40, 60, 60] });
    const dry = await w.post(ME, { ...bodyOf(w, w.other, built), dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.plan.direct).toEqual([]);
    expect(dry.body.plan.review.map((g) => g.opIds)).toEqual([["tag.add"]]);
    const r = await w.post(ME, bodyOf(w, w.other, built), { idem: "tag-other-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied ?? null).toBeNull();
    expect(r.body.proposal).toBeTruthy();
    expect(w.head(w.other).obj.media_list).toEqual([]);
    expect(w.rows("PROP#").length).toBeGreaterThan(0);
  });

  it("moving someone else's tag is a proposal too", async () => {
    const w = await world({ otherMedia: [mref([10, 10, 30, 30])] });
    const built = buildTagOps(bundleOf(w, w.other), { kind: "move", mediaHandle: photo.handle, from: [10, 10, 30, 30], rect: [11, 10, 31, 30] });
    const r = await w.post(ME, bodyOf(w, w.other, built), { idem: "tag-other-move" });
    expect(r.status).toBe(201);
    expect(r.body.applied ?? null).toBeNull();
    expect(w.head(w.other).obj.media_list.map((m) => m.rect)).toEqual([[10, 10, 30, 30]]);
  });
});

describe("an admin tags anyone: saves now, credited to the admin", () => {
  it("writes the MediaRef on the other person and credits a tag to the admin", async () => {
    const w = await world();
    const built = buildTagOps(bundleOf(w, w.other), { kind: "add", mediaHandle: photo.handle, rect: [40, 40, 60, 60] });
    const r = await w.post(ADMIN, bodyOf(w, w.other, built), { idem: "tag-admin-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied).not.toBeNull();
    expect(w.head(w.other).obj.media_list).toEqual([mref([40, 40, 60, 60])]);
    expect(tagKinds(w, ADMIN)).toContain("tag");
  });
});

describe("a stale key is a conflict that changes nothing", () => {
  it("a tag edited by someone else after the editor read it is not moved, and the other rectangle is untouched", async () => {
    const w = await world();
    const two = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [10, 10, 30, 30] });
    await w.post(ME, bodyOf(w, w.me, two), { idem: "s1" });
    const two2 = buildTagOps(bundleOf(w, w.me), { kind: "add", mediaHandle: photo.handle, rect: [50, 50, 70, 70] });
    await w.post(ME, bodyOf(w, w.me, two2), { idem: "s2" });
    // the editor reads the record now, then somebody else moves the first tag (a new version, and new content under the old key)
    const read = bundleOf(w, w.me);
    const stale = buildTagOps(read, { kind: "move", mediaHandle: photo.handle, from: [10, 10, 30, 30], rect: [11, 10, 31, 30] });
    const other = buildTagOps(read, { kind: "move", mediaHandle: photo.handle, from: [10, 10, 30, 30], rect: [15, 15, 35, 35] });
    await w.post(ME, bodyOf(w, w.me, other), { idem: "s3" });
    const before = structuredClone(w.head(w.me).obj.media_list);
    // sent against the version it read: the base is behind, so it is refused as a conflict and nothing is written
    const r = await w.post(ME, { base_versions: { [key(w.me)]: read.version }, ops: stale.ops }, { idem: "s4" });
    expect(r.status).toBe(409);
    expect(w.head(w.me).obj.media_list).toEqual(before);
    // sent against the new version, the key still carries the old hash: a conflict, never the other rectangle
    const r2 = await w.post(ME, { base_versions: { [key(w.me)]: w.head(w.me).version }, ops: stale.ops }, { idem: "s5" });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("version_conflict");
    expect(r2.body.details.conflicts.map((c) => c.opId)).toEqual(["tag.rect"]);
    expect(w.head(w.me).obj.media_list).toEqual(before);
  });

  it("a rect the validator would refuse never reaches the store (a float, the full frame)", async () => {
    const w = await world();
    const bad = (rect) => ({ base_versions: { [key(w.me)]: w.head(w.me).version }, ops: [{ id: "tag.add", op: "add", obj: key(w.me), path: "/media_list", value: mref(rect) }] });
    expect((await w.post(ME, bad([10.5, 10, 30, 30]), { idem: "b1" })).status).toBe(400);
    expect((await w.post(ME, bad([0, 0, 100, 100]), { idem: "b2" })).status).toBe(400);
    expect(w.head(w.me).obj.media_list).toEqual([]);
  });
});
