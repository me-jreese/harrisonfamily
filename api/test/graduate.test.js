// HFY-TSK-214 (hfy-graduate-api): POST /api/comments/:id/attachments/:aid/graduate. In-memory DynamoDB and S3 fakes, the real applyBatch (and a
// wrapper that fails on demand), synthetic ids and names only.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, etagOf, makeApi, signToken, TABLE } from "./world.js";
import { SOME_LAT, SOME_LON, jpeg, tiff } from "./photo-fixtures.js";
import { applyBatch } from "../src/sync/apply.js";
import { SyncError } from "../src/sync/errors.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { PHASES, R_MEDIA_PREFIX, classifySyncError, createGraduation, graduationKey, parseRequest } from "../src/graduate.js";
import { syncMediaDownload } from "../src/sync/pull.js";
import { createIdPolicy, idPolicyFromEnv, policyOf } from "../src/sync/id-policy.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const AUTHOR = "I0001";
const ADMIN = "I0099";
const TARGET = person(3);
const OTHER = person(4);
const SUBJECT = "person:I0002";
const q = { warn() {}, error() {}, info() {} };
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

let w, ctl, inbox, author, admin, member;

async function world({ seed = true, seeded = true, admins = [ADMIN], idPolicy = { mode: "mint" } } = {}) {
  ctl = { fault: null, errors: [], applied: [] };
  inbox = new InMemoryNotificationStore();
  const hooks = createHookRegistry();
  const api = makeApi({
    admins, log: q, inbox, flags: { graduateV1: true, commentPhotosV1: true, inboxV1: true },
    extraDeps: {
      syncHooks: hooks, ...(idPolicy ? { idPolicy } : {}), getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} },
      applyBatch: async (ctx, req) => {
        ctl.applied.push(req);
        const e = ctl.errors.shift();
        if (e) throw e;
        return applyBatch(ctx, req);
      },
      graduateAfterPhase: async (name) => {
        if (ctl.fault === name) { ctl.fault = null; throw new Error(`injected fault after ${name}`); }
      },
    },
  });
  registerRecordContributor({ ddb: api.ddb, cmds, table: TABLE, log: q }, hooks);
  if (seed) {
    api.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
    let t = Date.parse("2026-10-14T00:00:00Z");
    let u = 0;
    const sctx = { ddb: api.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
    for (const p of [TARGET, OTHER]) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${p.handle}`, ops: [{ op: "create", class: "Person", handle: p.handle, base_version: null, obj: p }] });
    api.ddb.rows.get("SYNC#HEAD\u0000META").seeded = seeded; // seeded: false is the store before the seed completes
  }
  return api;
}

const presign = async (token = author, contentType = "image/jpeg") => (await w.call("POST", "/api/uploads", { token, body: { contentType, size: 9, purpose: "comment" } })).body;
/** A comment by AUTHOR with one photo; returns {cid, aid, key}. */
async function photoComment({ contentType = "image/jpeg", alt = "a picnic", body = "look at this" } = {}) {
  const up = await presign(author, contentType);
  const r = await w.call("POST", "/api/comments", { token: author, body: { subject: SUBJECT, body, attachments: [{ url: up.publicUrl, mime: contentType, width: 640, height: 480, alt }] } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { cid: r.body.id, aid: r.body.attachments[0].id, key: up.key };
}
const grad = (c, body = {}, token = admin) => w.call("POST", `/api/comments/${c.cid}/attachments/${c.aid}/graduate`, { token, body: { subject: SUBJECT, person: TARGET.gramps_id, ...body } });
const row = (pk, sk) => w.ddb.rows.get(`${pk}\u0000${sk}`);
const commentRow = (c) => row(`THREAD#${SUBJECT}`, `C#${c.cid}`);
const marker = (c) => commentRow(c).comment.attachments[0].graduated;
const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
const head = (cls, handle) => row(`REC#${cls}#${handle}`, "HEAD");
const mediaHeads = () => rows("REC#Media#");
const personObj = (p) => JSON.parse(head("Person", p.handle).obj_json);
const audits = (c) => rows(`AUDIT#${c.cid}`).filter((r) => r.op === "graduate");
const credits = () => rows(`CONTRIB#${AUTHOR}`).filter((r) => r.kind === "photo_to_record");
const notices = async (who = AUTHOR) => (await inbox.list(who)).items.filter((i) => i.type === "photo_graduated");

beforeEach(async () => {
  w = await world();
  [author, admin, member] = await Promise.all([AUTHOR, ADMIN, "I0005"].map((s) => signToken(s)));
});

describe("the route", () => {
  it("is registered behind graduateV1 with no MCP tool, and the audit ops name graduate", () => {
    const r = ROUTES.find((x) => x.name === "comments.graduate");
    expect(r).toMatchObject({ method: "POST", path: "/comments/:id/attachments/:aid/graduate", write: true, gate: { type: "feature", name: "graduateV1" } });
    expect(r.mcp).toBeUndefined();
    expect(buildCaps().actions.find((a) => a.name === "comments.graduate")).toMatchObject({ gate: { feature: "graduateV1" } });
    expect(buildCaps().audit.ops).toContain("graduate");
  });

  it("is a 404 while graduateV1 is off, a 401 signed out, and 403 not_admin for a member (nothing touched)", async () => {
    const c = await photoComment();
    const off = makeApi({ admins: [ADMIN], log: q, flags: { graduateV1: false } });
    expect((await off.call("POST", `/api/comments/${c.cid}/attachments/${c.aid}/graduate`, { token: admin, body: {} })).status).toBe(404);
    expect((await grad(c, {}, null)).status).toBe(401);
    const r = await grad(c, {}, member);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_admin");
    const own = await grad(c, {}, author);
    expect(own.status).toBe(403);
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
  });

  it("checks the request shape: subject, person, title and description", async () => {
    const c = await photoComment();
    for (const [body, field] of [
      [{ subject: "proposal:01J00000000000000000000000" }, "subject"], [{ person: "bad id" }, "person"], [{ person: undefined }, "person"],
      [{ title: "x".repeat(201) }, "title"], [{ title: 7 }, "title"], [{ description: "y".repeat(501) }, "description"], [{ title: "a\u0000b" }, "title"],
    ]) {
      const r = await grad(c, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.details.fields[0].field).toBe(field);
    }
    expect(() => parseRequest({ subject: SUBJECT, commentId: "nope", aid: c.aid, person: "I1" })).toThrow(/no such comment/);
    expect((await w.call("POST", `/api/comments/${c.cid}/attachments/${"0".repeat(26)}/graduate`, { token: admin, body: { subject: SUBJECT, person: "I0003" } })).status).toBe(404);
    expect((await w.call("POST", `/api/comments/${"0".repeat(26)}/attachments/${c.aid}/graduate`, { token: admin, body: { subject: SUBJECT, person: "I0003" } })).status).toBe(404);
    expect((await grad(c, { person: "I7777" })).status).toBe(404); // no such person: nothing reserved
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
  });

  it("refuses contact information in the title or the description (R-18, 422) before anything is written", async () => {
    const c = await photoComment();
    const r = await grad(c, { title: "call 555-0142 now" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("contact_info");
    expect(JSON.stringify(r.body)).not.toMatch(/555/);
    expect(r.body.errors[0].pointer).toBe("/title");
    expect(marker(c)).toBeUndefined();
    const d = await grad(c, { description: "reach me at someone@example.com" });
    expect(d.status).toBe(422);
    expect(d.body.errors[0].pointer).toBe("/description");
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
    expect(mediaHeads()).toHaveLength(0);
    expect(ctl.applied).toEqual([]);
  });

  it("cannot be wired without the R-18 guard (a missing guard is an error, not a skipped check)", () => {
    expect(() => createGraduation({ ddb: {}, cmds, table: TABLE, store: {}, s3: {} })).toThrow(TypeError);
  });
});

describe("the cloud ID policy", () => {
  for (const [label, idPolicy] of [["unset", null], ["assign", { mode: "assign" }]]) {
    it(`${label}: 503 id_policy_not_mint before anything is reserved, copied or applied`, async () => {
      w = await world({ idPolicy });
      [author, admin] = await Promise.all([AUTHOR, ADMIN].map((s) => signToken(s)));
      const c = await photoComment();
      const r = await grad(c);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("id_policy_not_mint");
      expect(marker(c)).toBeUndefined();
      expect(w.s3.copies).toEqual([]);
      expect(ctl.applied).toEqual([]);
      expect(mediaHeads()).toHaveLength(0);
    });
  }

  // HFY-TSK-334: app-stack.yaml sets HFY_ID_POLICY from IdPolicy (default mint, io's Q2-03 answer, gate HFY-TSK-102). With that env and graduateV1
  // on, the route mints instead of answering 503 id_policy_not_mint: once read from the env by policyOf (no ctx.idPolicy), once as index.js wires it.
  describe("HFY_ID_POLICY=mint, the stack default", () => {
    let envBefore;
    beforeEach(() => { envBefore = process.env.HFY_ID_POLICY; process.env.HFY_ID_POLICY = "mint"; });
    afterEach(() => { if (envBefore === undefined) delete process.env.HFY_ID_POLICY; else process.env.HFY_ID_POLICY = envBefore; });

    it("resolves to the mint policy", () => {
      expect(idPolicyFromEnv().mode).toBe("mint");
      expect(createIdPolicy({ mode: idPolicyFromEnv(process.env).mode }).mode).toBe("mint");
      expect(policyOf({}).mode).toBe("mint");
    });

    for (const [label, idPolicy] of [["read by policyOf", null], ["wired as index.js does", () => createIdPolicy({ mode: idPolicyFromEnv(process.env).mode })]]) {
      it(`${label}: the graduation mints (201), not 503 id_policy_not_mint`, async () => {
        w = await world({ idPolicy: idPolicy ? idPolicy() : null });
        [author, admin] = await Promise.all([AUTHOR, ADMIN].map((s) => signToken(s)));
        const c = await photoComment();
        const r = await grad(c);
        expect(r.body.error).not.toBe("id_policy_not_mint");
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.media.gramps_id).toMatch(/^O8\d{3}$/);
        expect(marker(c)).toMatchObject({ state: "done" });
        expect(mediaHeads()).toHaveLength(1);
      });
    }
  });
});

describe("a graduation", () => {
  it("reserves, copies, applies and finalizes: 201, then 200 for the same person on a repeat", async () => {
    const c = await photoComment();
    const r = await grad(c, { title: "Picnic at the lake", description: "Summer, early afternoon" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const handle = r.body.media.handle;
    expect(r.body).toMatchObject({ person: "I0003", state: "done", media: { handle } });
    expect(r.body.media.gramps_id).toMatch(/^O8\d{3}$/); // minted in the cloud block

    // AC3: CopyObject from uploads/comments/ to media/<handle>.jpg with SHA256; the returned checksum goes into the Media op.
    expect(R_MEDIA_PREFIX).toBe("media/");
    expect(w.s3.copies).toHaveLength(1);
    expect(w.s3.copies[0]).toMatchObject({ Bucket: "harrisonfamily-frontend", Key: `media/${handle}.jpg`, CopySource: `harrisonfamily-frontend/${c.key}`, ChecksumAlgorithm: "SHA256" });
    const m = head("Media", handle);
    expect(m.blob).toEqual({ s3_key: `media/${handle}.jpg`, sha256: hex(JPEG_BYTES), size: JPEG_BYTES.length, content_type: "image/jpeg", state: "present" });
    expect(w.s3.objects.get(`media/${handle}.jpg`).contentType).toBe("image/jpeg");
    const media = JSON.parse(m.obj_json);
    expect(media).toMatchObject({ desc: "Picnic at the lake", mime: "image/jpeg", path: `${handle}.jpg` });
    expect(media.attribute_list.map((a) => [a.type.string || a.type.value, a.value])).toEqual([
      ["hfy:source", `comment-photo:${SUBJECT}/${c.cid}/${c.aid}`], [2, "Summer, early afternoon"],
    ]);
    expect(personObj(TARGET).media_list).toEqual([expect.objectContaining({ _class: "MediaRef", ref: handle, rect: null, private: false })]);
    expect(head("Person", TARGET.handle).version).toBe(2);
    expect(head("Person", TARGET.handle).origin).toBe("graduation");

    expect(marker(c)).toMatchObject({ state: "done", media_handle: handle, person: "I0003", by: { id: ADMIN }, notified: true });
    expect(marker(c).title).toBeUndefined();
    expect(audits(c)).toHaveLength(1);
    expect(audits(c)[0]).toMatchObject({ principal: ADMIN, after: { attachment: c.aid, graduated: { state: "done", person: "I0003" } } });
    // The credit goes to the photo's author, not the admin.
    expect(credits()).toHaveLength(1);
    expect(credits()[0]).toMatchObject({ actor: { id: AUTHOR }, weight: 1, ref: { type: "media", id: handle }, subject: "person:I0003" });
    expect(rows(`CONTRIB#${ADMIN}`)).toEqual([]);
    expect(row("CSTAT#person:I0001", "TOTAL").n_photo_to_record).toBe(1);
    const n = await notices();
    expect(n).toHaveLength(1);
    expect(n[0].navigate).toBe("/person/?id=I0003#photos");
    expect(n[0].fields.actor).toBeTruthy();

    const again = await grad(c, { title: "ignored on a repeat" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(r.body);
    expect(w.s3.copies).toHaveLength(1);
    expect(mediaHeads()).toHaveLength(1);
    expect(audits(c)).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it("defaults the Media description to the alt text and passes the idempotency key graduate:<comment>:<attachment> as the principal's batch key", async () => {
    const c = await photoComment({ alt: "a picnic" });
    expect((await grad(c)).status).toBe(201);
    expect(JSON.parse(mediaHeads()[0].obj_json).desc).toBe("a picnic");
    expect(ctl.applied).toHaveLength(1);
    expect(ctl.applied[0]).toMatchObject({ principal: ADMIN, origin: "graduation", idempotencyKey: graduationKey(c.cid, c.aid) });
    expect(ctl.applied[0].idempotencyKey).toBe(`graduate:${c.cid}:${c.aid}`);
    expect(ctl.applied[0].ops.map((o) => [o.op, o.class])).toEqual([["create", "Media"], ["update", "Person"]]);
  });

  it("does not notify an admin who graduates their own photo, but still credits them", async () => {
    const own = await signToken(ADMIN);
    const up = (await w.call("POST", "/api/uploads", { token: own, body: { contentType: "image/jpeg", size: 9, purpose: "comment" } })).body;
    const r = await w.call("POST", "/api/comments", { token: own, body: { subject: SUBJECT, body: "mine", attachments: [{ url: up.publicUrl, mime: "image/jpeg", alt: "x" }] } });
    const c = { cid: r.body.id, aid: r.body.attachments[0].id };
    expect((await grad(c)).status).toBe(201);
    expect(await notices(ADMIN)).toEqual([]);
    expect(rows(`CONTRIB#${ADMIN}`).filter((e) => e.kind === "photo_to_record")).toHaveLength(1);
    expect(marker(c).notified).toBe(true);
  });

  it("a different person is 409 already_graduated, the same person is 200", async () => {
    const c = await photoComment();
    expect((await grad(c)).status).toBe(201);
    const other = await grad(c, { person: OTHER.gramps_id });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("already_graduated");
    expect((await grad(c)).status).toBe(200);
    expect(personObj(OTHER).media_list).toEqual([]);
    expect(mediaHeads()).toHaveLength(1);
  });

  it("a pending reservation for one person is 409 graduation_pending for another and resumes for the same one", async () => {
    const c = await photoComment();
    ctl.errors.push(new SyncError(503, "retryable", "busy"));
    const first = await grad(c, { title: "First title" });
    expect(first.status).toBe(503);
    expect(first.body.error).toBe("sync_unavailable");
    const handle = marker(c).media_handle;
    expect(marker(c)).toMatchObject({ state: "pending", person: "I0003", by: { id: ADMIN }, title: "First title" });
    const other = await grad(c, { person: OTHER.gramps_id });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("graduation_pending");
    const resumed = await grad(c, { title: "Second title" }); // the stored reservation wins
    expect(resumed.status).toBe(201);
    expect(resumed.body.media.handle).toBe(handle);
    expect(JSON.parse(head("Media", handle).obj_json).desc).toBe("First title");
  });

  it("a second admin resumes the first admin's reservation under the first admin's principal and key, so the batch commits once", async () => {
    const admin2 = await signToken("I0098");
    w = await world({ admins: [ADMIN, "I0098"] });
    [author, admin] = await Promise.all([AUTHOR, ADMIN].map((s) => signToken(s)));
    const c = await photoComment();
    ctl.errors.push(new SyncError(503, "retryable", "busy"));
    expect((await grad(c)).status).toBe(503);
    const r = await grad(c, {}, admin2);
    expect(r.status).toBe(201);
    expect(ctl.applied.map((a) => a.principal)).toEqual([ADMIN, ADMIN]);
    expect(mediaHeads()).toHaveLength(1);
    expect(audits(c)[0].principal).toBe(ADMIN);
  });
});

describe("a graduation: the copy and the record", () => {
  it("pins the copy to the object that was checked (CopySourceIfMatch from the HeadObject ETag)", async () => {
    const c = await photoComment();
    expect((await grad(c)).status).toBe(201);
    expect(w.s3.copies[0].CopySourceIfMatch).toBe(etagOf(w.s3.objects.get(c.key)));
  });

  it("a source that changes between the check and the copy is 503 graduate_source_changed, nothing is applied, and the retry reads it again", async () => {
    const c = await photoComment();
    const send = w.s3.send;
    let swapped = false;
    w.s3.send = async (cmd) => {
      const out = await send.call(w.s3, cmd);
      if (!swapped && cmd.constructor.name === "GetObjectCommand") { // checkLocation has read the bytes: the object is replaced before the copy
        swapped = true;
        w.s3.objects.set(c.key, { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x02, 0xff, 0xd9]), contentType: "image/jpeg" });
      }
      return out;
    };
    const first = await grad(c);
    expect(first.status).toBe(503);
    expect(first.body.error).toBe("graduate_source_changed");
    expect(marker(c).state).toBe("pending");
    expect(mediaHeads()).toHaveLength(0);
    expect(ctl.applied).toEqual([]);
    const retry = await grad(c);
    expect(retry.status).toBe(201);
    expect(mediaHeads()).toHaveLength(1);
    expect(w.s3.copies[1].CopySourceIfMatch).toBe(etagOf(w.s3.objects.get(c.key)));
    expect(head("Media", retry.body.media.handle).blob.sha256).toBe(hex(w.s3.objects.get(c.key).bytes));
  });

  it("a head answer without an ETag cannot pin the copy: 503, nothing copied", async () => {
    const c = await photoComment();
    const send = w.s3.send;
    w.s3.send = async (cmd) => {
      const out = await send.call(w.s3, cmd);
      if (cmd.constructor.name === "HeadObjectCommand") delete out.ETag;
      return out;
    };
    const r = await grad(c);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("graduate_copy_failed");
    expect(w.s3.copies).toEqual([]);
  });

  it("a failed reservation drops its title; a retry without one falls back to the alt text", async () => {
    const c = await photoComment({ alt: "a picnic" });
    ctl.errors.push(new SyncError(400, "validation", "bad", { violations: [{ pointer: "/desc" }] }));
    expect((await grad(c, { title: "Wrong title" })).status).toBe(400);
    const r = await grad(c);
    expect(r.status).toBe(201);
    expect(JSON.parse(head("Media", r.body.media.handle).obj_json).desc).toBe("a picnic");
  });

  it("the blob has no md5, and the sync download route still serves it (the desktop computes its own)", async () => {
    const c = await photoComment();
    const r = await grad(c);
    expect(head("Media", r.body.media.handle).blob.md5).toBeUndefined();
    const store = { ddb: w.ddb, cmds, table: TABLE, mediaBucket: "harrisonfamily-frontend", presignGet: async ({ key }) => `https://example.invalid/${key}` };
    const d = await syncMediaDownload({ sync: { checkTree() {}, store }, params: { handle: r.body.media.handle } });
    expect(d.status ?? 200).toBe(200);
    const body = d.body ?? d;
    expect(body).toMatchObject({ sha256: hex(JPEG_BYTES), size: JPEG_BYTES.length, content_type: "image/jpeg" });
    expect(body.md5).toBeUndefined();
  });
});

describe("a fault after any phase, then a retry, completes exactly once", () => {
  for (const phase of PHASES) {
    it(`after ${phase}`, async () => {
      const c = await photoComment();
      ctl.fault = phase;
      const first = await grad(c);
      expect(first.status).toBe(500);
      const retry = await grad(c);
      expect([200, 201]).toContain(retry.status);
      expect(retry.body.state).toBe("done");
      // one Media add, one MediaRef append, one audit entry, one credit to the author, one notice
      expect(mediaHeads()).toHaveLength(1);
      expect(rows("SYNC#LOG").filter((l) => l.class === "Media")).toHaveLength(1);
      const handle = retry.body.media.handle;
      expect(personObj(TARGET).media_list.filter((r) => r.ref === handle)).toHaveLength(1);
      expect(head("Person", TARGET.handle).version).toBe(2);
      expect(audits(c)).toHaveLength(1);
      expect(credits()).toHaveLength(1);
      expect(row("CSTAT#person:I0001", "TOTAL").n_photo_to_record).toBe(1);
      expect(await notices()).toHaveLength(1);
      expect(marker(c)).toMatchObject({ state: "done", media_handle: handle, notified: true });
      expect(ctl.applied.length).toBeLessThanOrEqual(1 + (phase === "reserve" || phase === "copy" ? 1 : 0));
      // and a third call changes nothing
      expect((await grad(c)).status).toBe(200);
      expect(mediaHeads()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
    });
  }

  it("a store failure on the finalize transaction leaves the Media in place; the retry finalizes once", async () => {
    const c = await photoComment();
    let armed = false;
    const send = w.ddb.send;
    w.ddb.send = async (cmd) => {
      if (armed && cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((i) => i.Put?.Item?.op === "graduate")) { armed = false; throw Object.assign(new Error("boom"), { name: "InternalServerError" }); }
      return send.call(w.ddb, cmd);
    };
    armed = true;
    expect((await grad(c)).status).toBe(500);
    expect(mediaHeads()).toHaveLength(1);
    expect(marker(c).state).toBe("pending");
    expect((await grad(c)).status).toBe(201);
    expect(mediaHeads()).toHaveLength(1);
    expect(audits(c)).toHaveLength(1);
    expect(credits()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it("a concurrent second request cannot reserve twice or finalize twice", async () => {
    const c = await photoComment();
    const [a, b] = await Promise.all([grad(c), grad(c)]);
    expect([a.status, b.status].every((s) => [200, 201, 409].includes(s))).toBe(true);
    expect([a.status, b.status]).toContain(201);
    if (b.status === 409 || a.status === 409) expect((a.status === 409 ? a : b).body.error).toBe("conflict");
    const r = await grad(c);
    expect(r.status).toBe(200);
    expect(mediaHeads()).toHaveLength(1);
    expect(audits(c)).toHaveLength(1);
    expect(credits()).toHaveLength(1);
  });
});

describe("SyncError handling", () => {
  it("a validation SyncError is 400 with the pointer, the reservation is failed, and a corrected retry completes with the same handle", async () => {
    const c = await photoComment();
    ctl.errors.push(new SyncError(400, "validation", "bad", { violations: [{ rule: "schema.pattern", class: "Media", handle: "x", pointer: "/desc" }] }));
    const r = await grad(c, { title: "Wrong title" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation");
    expect(r.body.details).toMatchObject({ pointer: "/desc", field: "title" });
    const failed = marker(c);
    expect(failed).toMatchObject({ state: "failed", code: "validation", pointer: "/desc", person: "I0003" });
    expect(failed.title).toBeUndefined();
    expect(mediaHeads()).toHaveLength(0);
    expect(audits(c)).toEqual([]);
    expect(credits()).toEqual([]);
    const ok = await grad(c, { title: "Right title" });
    expect(ok.status).toBe(201);
    expect(ok.body.media.handle).toBe(failed.media_handle);
    expect(JSON.parse(head("Media", failed.media_handle).obj_json).desc).toBe("Right title");
    expect(w.s3.copies).toHaveLength(2); // the copy target is a function of the handle: the same key again
    expect(new Set(w.s3.copies.map((x) => x.Key)).size).toBe(1);
  });

  it("the design's abstract errors work too: pointer on the error, code unavailable is 503 and leaves it pending", async () => {
    const c = await photoComment();
    ctl.errors.push(Object.assign(new SyncError(400, "validation", "bad"), { pointer: "/attribute_list/1/value" }));
    const r = await grad(c);
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ pointer: "/attribute_list/1/value", field: "description" });
    ctl.errors.push(new SyncError(503, "unavailable", "store down"));
    const u = await grad(c);
    expect(u.status).toBe(503);
    expect(u.body.error).toBe("sync_unavailable");
    expect(marker(c).state).toBe("pending");
    expect((await grad(c)).status).toBe(201);
  });

  it("classifies: conflict, validation and unavailable", () => {
    expect(classifySyncError(new SyncError(409, "version_conflict", "x"))).toBe("conflict");
    expect(classifySyncError(new SyncError(409, "exists", "x"))).toBe("conflict");
    expect(classifySyncError(new SyncError(409, "conflict", "x"))).toBe("conflict");
    for (const e of [new SyncError(400, "validation", "x"), new SyncError(422, "withdrawn_reference", "x"), new SyncError(413, "batch_too_large", "x"), new SyncError(409, "gid_conflict", "x")]) expect(classifySyncError(e)).toBe("validation");
    for (const e of [new SyncError(503, "retryable", "x"), new SyncError(503, "store_not_seeded", "x"), new SyncError(500, "x", "x"), new SyncError(428, "idempotency_key_required", "x"), Object.assign(new Error("x"), { code: "unavailable" })]) expect(classifySyncError(e)).toBe("unavailable");
  });

  it("a version conflict re-reads the person and retries once; a second conflict is 503 graduate_conflict and leaves it pending", async () => {
    const c = await photoComment();
    ctl.errors.push(new SyncError(409, "version_conflict", "stale"));
    expect((await grad(c)).status).toBe(201);
    expect(ctl.applied).toHaveLength(2);
    const d = await photoComment();
    ctl.errors.push(new SyncError(409, "version_conflict", "stale"), new SyncError(409, "version_conflict", "stale"));
    const r = await grad(d);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("graduate_conflict");
    expect(marker(d).state).toBe("pending");
    expect((await grad(d)).status).toBe(201);
  });

  it("a person who is withdrawn or deleted after the reservation releases it with 404 person_not_found", async () => {
    const c = await photoComment();
    ctl.errors.push(new SyncError(503, "retryable", "busy"));
    expect((await grad(c)).status).toBe(503);
    const t = Date.parse("2026-10-14T01:00:00Z");
    await applyBatch({ ddb: w.ddb, cmds, table: TABLE, now: () => t, uid: () => "sx", unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } }, { principal: "svc", origin: "desktop", idempotencyKey: "gone", ops: [{ op: "delete", class: "Person", handle: TARGET.handle, base_version: 1 }] });
    const r = await grad(c);
    expect(r.status).toBe(404); // caught before the copy: the person lookup precedes the reservation
    expect(r.body.error).toBe("person_not_found");
  });
});

describe("the target person", () => {
  it("a withdrawn person is 404 person_not_found: nothing reserved, copied or applied (BRD2: a withdrawn record is private)", async () => {
    const c = await photoComment();
    const t = Date.parse("2026-10-14T01:00:00Z");
    await applyBatch({ ddb: w.ddb, cmds, table: TABLE, now: () => t, uid: () => "sw", unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } }, { principal: "svc", origin: "desktop", idempotencyKey: "withdrawn", ops: [{ op: "withdraw", class: "Person", handle: TARGET.handle, base_version: 1, reason: "private" }] });
    const r = await grad(c);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("person_not_found");
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
    expect(ctl.applied).toEqual([]);
  });
});

describe("the gates", () => {
  it("before the seed (no SYNC#HEAD, or seeded false) it is 503 store_not_seeded and the comment and S3 are untouched (negative test)", async () => {
    for (const mode of [{ seed: false }, { seed: true, seeded: false }]) {
      w = await world(mode);
      [author, admin] = await Promise.all([AUTHOR, ADMIN].map((s) => signToken(s)));
      const c = await photoComment();
      const before = structuredClone(commentRow(c));
      const calls = w.s3.calls.length;
      const r = await grad(c);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("store_not_seeded");
      expect(commentRow(c)).toEqual(before);
      expect(w.s3.calls.length).toBe(calls);
      expect(w.s3.copies).toEqual([]);
      expect(ctl.applied).toEqual([]);
      expect(mediaHeads()).toHaveLength(0);
    }
  });

  it("while writes are paused it is 503 sync_paused and nothing is written", async () => {
    const c = await photoComment();
    w.ddb.rows.get("SYNC#HEAD\u0000META").writes_enabled = false;
    const r = await grad(c);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("sync_paused");
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
  });

  it("a hidden photo or a hidden comment is 409 moderated, with no reservation and no copy", async () => {
    const c = await photoComment();
    const item = commentRow(c);
    item.comment.attachments[0].moderation = { hidden: true, by: { id: ADMIN }, at: "2026-10-14T00:00:00.000Z" };
    let r = await grad(c);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("moderated");
    delete item.comment.attachments[0].moderation;
    item.comment.moderation = { state: "hidden", hidden: true, by: { id: ADMIN }, at: "2026-10-14T00:00:00.000Z", open: true };
    r = await grad(c);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("moderated");
    expect(marker(c)).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
    item.comment.moderation = { state: "question", hidden: false, by: { id: ADMIN }, at: "2026-10-14T00:00:00.000Z", open: true }; // a visible question does not block
    expect((await grad(c)).status).toBe(201);
  });

  it("checkLocation runs on the source before CopyObject: a photo with GPS is 400 photo_has_location, nothing is copied, and the reservation is released", async () => {
    const c = await photoComment();
    w.s3.objects.set(c.key, { bytes: jpeg({ exif: tiff({ gps: { version: true, lat: SOME_LAT, lon: SOME_LON } }) }), contentType: "image/jpeg" });
    const r = await grad(c);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("photo_has_location");
    expect(w.s3.copies).toEqual([]);
    expect(marker(c)).toMatchObject({ state: "failed", code: "photo_has_location" });
    expect(mediaHeads()).toHaveLength(0);
    // clean bytes: the order of S3 calls is read the source, then copy
    w.s3.objects.set(c.key, { bytes: JPEG_BYTES, contentType: "image/jpeg" });
    w.s3.calls.length = 0;
    expect((await grad(c)).status).toBe(201);
    const names = w.s3.calls;
    expect(names.indexOf("GetObjectCommand")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("GetObjectCommand")).toBeLessThan(names.indexOf("CopyObjectCommand"));
  });

  it("the source must be image/jpeg: a png or webp comment photo is 422 unsupported_photo and is not copied", async () => {
    for (const type of ["image/png", "image/webp"]) {
      const c = await photoComment({ contentType: type });
      const r = await grad(c);
      expect(r.status, type).toBe(422);
      expect(r.body.error).toBe("unsupported_photo");
      expect(marker(c)).toMatchObject({ state: "failed", code: "unsupported_photo" });
    }
    expect(w.s3.copies).toEqual([]);
    expect(mediaHeads()).toHaveLength(0);
  });

  it("a failed CopyObject is 503 graduate_copy_failed, leaves the reservation pending, and the retry copies and completes", async () => {
    const c = await photoComment();
    const send = w.s3.send;
    let fail = true;
    w.s3.send = async (cmd) => {
      if (fail && cmd.constructor.name === "CopyObjectCommand") { fail = false; throw Object.assign(new Error("slow down"), { name: "SlowDown" }); }
      return send.call(w.s3, cmd);
    };
    const r = await grad(c);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("graduate_copy_failed");
    expect(marker(c).state).toBe("pending");
    expect(ctl.applied).toEqual([]);
    expect((await grad(c)).status).toBe(201);
    expect(mediaHeads()).toHaveLength(1);
  });

  it("a copy answer without a checksum is 503 and nothing is applied", async () => {
    const c = await photoComment();
    const send = w.s3.send;
    w.s3.send = async (cmd) => (cmd.constructor.name === "CopyObjectCommand" ? { CopyObjectResult: {} } : send.call(w.s3, cmd));
    expect((await grad(c)).status).toBe(503);
    expect(ctl.applied).toEqual([]);
  });

  it("without an S3 client it is 503 and writes nothing", async () => {
    const bare = makeApi({ admins: [ADMIN], log: q, flags: { graduateV1: true }, extraDeps: { s3: undefined } });
    expect(bare.s3).toBeTruthy();
    // makeApi always wires s3; the deps spread above replaces it with undefined
    const t = await signToken(ADMIN);
    const r = await bare.call("POST", `/api/comments/${"0".repeat(26)}/attachments/${"0".repeat(26)}/graduate`, { token: t, body: { subject: SUBJECT, person: "I0003" } });
    expect(r.status).toBe(503);
  });
});

describe("the comment after a graduation", () => {
  it("an author's edit keeps the marker and does not leak grad_v; list shows the marker", async () => {
    const c = await photoComment();
    expect((await grad(c)).status).toBe(201);
    const list = await w.call("GET", "/api/comments", { token: author, query: { subject: SUBJECT } });
    const att = list.body.thread.comments[0].attachments[0];
    expect(att.graduated).toMatchObject({ state: "done", person: "I0003" });
    expect(list.body.thread.comments[0].grad_v).toBeUndefined();
    const edited = await w.call("PATCH", `/api/comments/${c.cid}`, { token: author, body: { subject: SUBJECT, body: "edited", attachments: [{ url: att.url, mime: "image/jpeg", alt: "new alt" }] } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.attachments[0]).toMatchObject({ alt: "new alt", graduated: { state: "done", person: "I0003" } });
    expect(edited.body.grad_v).toBeUndefined();
    expect(marker(c).state).toBe("done");
  });

  it("an author's edit cannot remove a photo whose graduation is pending (409), and an edit or delete after a graduation write is guarded", async () => {
    const c = await photoComment();
    ctl.errors.push(new SyncError(503, "retryable", "busy"));
    expect((await grad(c)).status).toBe(503);
    const r = await w.call("PATCH", `/api/comments/${c.cid}`, { token: author, body: { subject: SUBJECT, body: "no photo now", attachments: [] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("graduation_pending");
    // a graduation step lands between an edit's read and write: the edit is cancelled (409), not applied over the marker
    const send = w.ddb.send;
    let bumped = false;
    w.ddb.send = async (cmd) => {
      if (!bumped && cmd.constructor.name === "TransactWriteCommand") { bumped = true; commentRow(c).comment.grad_v += 1; }
      return send.call(w.ddb, cmd);
    };
    const e = await w.call("PATCH", `/api/comments/${c.cid}`, { token: author, body: { subject: SUBJECT, body: "late edit" } });
    expect(e.status).toBe(409);
    expect(commentRow(c).comment.body).not.toBe("late edit");
  });

  for (const phase of ["reserve", "copy", "apply"]) {
    it(`a delete by the author or an admin while the graduation is pending (fault after ${phase}) is 409 graduation_pending; the retry then finalizes once`, async () => {
      const c = await photoComment();
      ctl.fault = phase;
      expect((await grad(c)).status).toBe(500);
      expect(marker(c).state).toBe("pending");
      for (const token of [author, admin]) {
        const del = await w.call("DELETE", `/api/comments/${c.cid}`, { token, query: { subject: SUBJECT } });
        expect(del.status, JSON.stringify(del.body)).toBe(409);
        expect(del.body.error).toBe("graduation_pending");
      }
      expect(commentRow(c)).toBeTruthy();
      const retry = await grad(c);
      expect(retry.status).toBe(201);
      expect(mediaHeads()).toHaveLength(1);
      expect(audits(c)).toHaveLength(1);
      expect(credits()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
      expect((await w.call("DELETE", `/api/comments/${c.cid}`, { token: author, query: { subject: SUBJECT } })).status).toBe(204); // done: deletable
    });
  }

  it("a delete that read the comment before the reservation is cancelled by the write guard (409), not applied over it", async () => {
    const c = await photoComment();
    const send = w.ddb.send;
    let reserved = false;
    w.ddb.send = async (cmd) => {
      if (!reserved && cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((i) => i.Delete)) {
        reserved = true;
        commentRow(c).comment.grad_v = (commentRow(c).comment.grad_v ?? 0) + 1; // a reserve lands between the delete's read and its write
      }
      return send.call(w.ddb, cmd);
    };
    const del = await w.call("DELETE", `/api/comments/${c.cid}`, { token: author, query: { subject: SUBJECT } });
    expect(del.status).toBe(409);
    expect(commentRow(c)).toBeTruthy();
  });

  it("deleting a graduated comment leaves the record photo in place", async () => {
    const c = await photoComment();
    const r = await grad(c);
    const del = await w.call("DELETE", `/api/comments/${c.cid}`, { token: author, query: { subject: SUBJECT } });
    expect(del.status).toBe(204);
    expect(head("Media", r.body.media.handle)).toBeTruthy();
    expect(personObj(TARGET).media_list).toHaveLength(1);
  });
});

describe("a photo on a post's thread: the post delete never takes a comment whose graduation is pending", () => {
  let post, subject; // `member` is the post's author
  beforeEach(async () => {
    const p = await w.call("POST", "/api/posts", { token: member, body: { body: "news from the reunion", visibility: "published" } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    post = p.body.id;
    subject = `post:${post}`;
  });
  /** A photo comment by AUTHOR on the post's thread, and a plain comment by the post's author beside it. */
  async function postPhotoComment() {
    const up = await presign(author);
    const r = await w.call("POST", "/api/comments", { token: author, body: { subject, body: "look", attachments: [{ url: up.publicUrl, mime: "image/jpeg", width: 640, height: 480, alt: "a picnic" }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const plain = await w.call("POST", "/api/comments", { token: member, body: { subject, body: "lovely" } });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    return { cid: r.body.id, aid: r.body.attachments[0].id, plain: plain.body.id };
  }
  const gradPost = (c, token = admin) => w.call("POST", `/api/comments/${c.cid}/attachments/${c.aid}/graduate`, { token, body: { subject, person: TARGET.gramps_id } });
  const threadRow = (id) => row(`THREAD#${subject}`, `C#${id}`);
  const postRow = () => row(`POST#${post}`, "META");
  const deleteAudits = (id) => rows(`AUDIT#${id}`).filter((r) => r.op === "delete");

  it("the post delete is 409 graduation_pending while a photo is pending (author and admin, after the delete is allowed); the retry finalizes once and the post then goes with its thread", async () => {
    const c = await postPhotoComment();
    ctl.fault = "apply"; // applyBatch committed: the Media and the MediaRef are live, finalize has not run
    expect((await gradPost(c)).status).toBe(500);
    expect(threadRow(c.cid).comment.attachments[0].graduated.state).toBe("pending");
    expect((await w.call("DELETE", `/api/posts/${post}`, { token: author })).status).toBe(403); // not allowed comes first: no hint of the thread
    for (const token of [member, admin]) {
      const del = await w.call("DELETE", `/api/posts/${post}`, { token });
      expect(del.status, JSON.stringify(del.body)).toBe(409);
      expect(del.body.error).toBe("graduation_pending");
    }
    expect(postRow()).toBeTruthy();
    expect(threadRow(c.cid)).toBeTruthy();
    expect(threadRow(c.plain)).toBeTruthy();
    const retry = await gradPost(c);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(mediaHeads()).toHaveLength(1);
    expect(personObj(TARGET).media_list).toHaveLength(1);
    expect(audits(c)).toHaveLength(1);
    expect(credits()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
    expect((await w.call("DELETE", `/api/posts/${post}`, { token: member })).status).toBe(204); // done: the post and its thread go
    expect(postRow()).toBeUndefined();
    expect(threadRow(c.cid)).toBeUndefined();
    expect(threadRow(c.plain)).toBeUndefined();
    expect(head("Media", retry.body.media.handle)).toBeTruthy(); // the record photo stays
  });

  it("a reservation that lands between the post delete's check and its write: the purge keeps that comment, the retry finalizes once and then removes the rest of the thread", async () => {
    const c = await postPhotoComment();
    const send = w.ddb.send;
    let raced = false;
    w.ddb.send = async (cmd) => {
      if (!raced && cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((i) => i.Delete?.Key?.PK === `POST#${post}` && i.Delete.Key.SK === "META")) {
        raced = true;
        ctl.fault = "reserve";
        expect((await gradPost(c)).status).toBe(500); // reserved while the post still exists, then stopped
      }
      return send.call(w.ddb, cmd);
    };
    expect((await w.call("DELETE", `/api/posts/${post}`, { token: member })).status).toBe(204);
    w.ddb.send = send;
    expect(raced).toBe(true);
    expect(postRow()).toBeUndefined();
    expect(threadRow(c.plain)).toBeUndefined(); // the purge ran
    expect(deleteAudits(c.plain)).toHaveLength(1);
    expect(threadRow(c.cid).comment.attachments[0].graduated.state).toBe("pending"); // and kept the pending one
    expect(deleteAudits(c.cid)).toHaveLength(0);
    const retry = await gradPost(c);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(mediaHeads()).toHaveLength(1);
    expect(audits(c)).toHaveLength(1);
    expect(credits()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
    expect(threadRow(c.cid)).toBeUndefined(); // the deleted post's thread is gone once the graduation is done
    expect(deleteAudits(c.cid)).toHaveLength(1);
    expect(deleteAudits(c.cid)[0]).toMatchObject({ reason: "post deleted" });
    expect(head("Media", retry.body.media.handle)).toBeTruthy();
    expect(personObj(TARGET).media_list).toHaveLength(1);
    expect((await gradPost(c)).status).toBe(404); // a later retry: the comment is gone with its post
  });

  it("nothing new starts on the thread of a deleted post: 404, nothing reserved or copied, and the leftover thread is removed", async () => {
    const c = await postPhotoComment();
    w.ddb.rows.delete(`POST#${post}\u0000META`); // a post whose thread purge did not run (it is best effort)
    const r = await gradPost(c);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error).toBe("not_found");
    expect(w.s3.copies).toEqual([]);
    expect(mediaHeads()).toHaveLength(0);
    expect(threadRow(c.cid)).toBeUndefined();
    expect(threadRow(c.plain)).toBeUndefined();
  });

  it("a post deleted between the route's read and the reservation cancels the reservation (404): the reserve checks the post in its own transaction", async () => {
    const c = await postPhotoComment();
    const send = w.ddb.send;
    w.ddb.send = async (cmd) => {
      if (cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((i) => i.ConditionCheck?.Key?.PK === `POST#${post}`)) w.ddb.rows.delete(`POST#${post}\u0000META`);
      return send.call(w.ddb, cmd);
    };
    const r = await gradPost(c);
    w.ddb.send = send;
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(threadRow(c.cid).comment.attachments[0].graduated).toBeUndefined();
    expect(w.s3.copies).toEqual([]);
    expect(mediaHeads()).toHaveLength(0);
  });

  it("a done or failed marker does not block the post delete", async () => {
    const done = await postPhotoComment();
    expect((await gradPost(done)).status).toBe(201);
    const failed = await postPhotoComment();
    ctl.errors.push(new SyncError(422, "validation", "bad title", { pointer: "/desc" }));
    expect((await gradPost(failed)).status).toBe(400);
    expect(threadRow(failed.cid).comment.attachments[0].graduated.state).toBe("failed");
    expect((await w.call("DELETE", `/api/posts/${post}`, { token: member })).status).toBe(204);
    for (const id of [done.cid, done.plain, failed.cid, failed.plain]) expect(threadRow(id)).toBeUndefined();
  });
});

describe("no new IAM", () => {
  it("app-stack.yaml already grants the API role PutObject on media/* and GetObject on uploads/comments/* (app-stack-sync-infra)", () => {
    const yaml = readFileSync(resolve(import.meta.dirname, "../../infrastructure/cloudformation/app-stack.yaml"), "utf8");
    const media = yaml.slice(yaml.indexOf("media/*\n") - 1500, yaml.indexOf("media/*\n") + 200);
    expect(media).toMatch(/s3:PutObject/);
    expect(yaml).toMatch(/\$\{MediaBucket\}\/media\/\*/);
    expect(yaml).toMatch(/\$\{MediaBucket\}\/uploads\/comments\/\*/);
    expect(yaml).toMatch(/Sid: UploadReads/);
  });
});
