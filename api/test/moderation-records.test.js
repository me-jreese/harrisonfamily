// HFY-TSK-216 (hfy-moderation-record-targets; BRD2 D2-19, R2-25, review PS-07, DL-17): POST /api/moderation for note, mediaref and media targets. The MOD# overlay, its
// audit entry and a marker op commit in one applyBatch transaction; the records API, the edit bundle and MCP hide the item from a non-owner. Synthetic ids and text only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { makeApi, signToken, TABLE, cmds } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey } from "../src/sync/store.js";
import { ROUTES } from "../src/routes.js";
import { parseTarget, targetKey } from "../src/moderation.js";

const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, event_ref_list: [], family_list: [], parent_family_list: [], media_list: [], note_list: [], ...extra });
const note = (n, text) => ({ _class: "Note", handle: h(3000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: text } });
const media = (n) => ({ _class: "Media", handle: h(4000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, change: 1, private: false, path: "synthetic.jpg", mime: "image/jpeg", desc: `Synthetic photo ${n}` });
const ref = (m) => ({ _class: "MediaRef", ref: m.handle, rect: null });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

const OWNER = "I0001"; // a member: their own Person holds the items
const THIRD = "I0003"; // another member
const ADMIN = "I0099";
const IO = "I0098"; // the gramps-owner
const q = { warn() {}, error() {}, info() {} };
const FLAGS = { moderationV1: true, moderationRecordsV1: true, inboxV1: true, contribV1: true };

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

/** Tree: OWNER (a member) holds notes n1 and n2, photos m1 and m2. NOBODY (I0004, not a member) holds n3 and m3. */
async function world({ flags = FLAGS, members = [OWNER, THIRD], owners = [IO], ...opts } = {}) {
  const inbox = new InMemoryNotificationStore();
  const w = makeApi({ withPush: false, log: q, inbox, flags, extraDeps: { listMembers: async () => new Set(members), getOwners: async () => owners }, ...opts });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const ctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `u${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const apply = (ops) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `k${++k}`, ops });
  const [n1, n2, n3] = [note(1, "Synthetic story one"), note(2, "Synthetic story two"), note(3, "Synthetic story three")];
  const [m1, m2, m3] = [media(1), media(2), media(3)];
  const owner = person(1, { note_list: [n1.handle, n2.handle], media_list: [ref(m1), ref(m2)] });
  const nobody = person(4, { note_list: [n3.handle], media_list: [ref(m3)] });
  await apply([owner, nobody, n1, n2, n3, m1, m2, m3].map(create));
  const tok = {};
  for (const s of [OWNER, THIRD, ADMIN, IO]) tok[s] = await signToken(s);
  const call = (who, method, path, extra = {}) => w.call(method, path, { token: who === null ? undefined : tok[who], ...extra });
  const act = (who, target, action, extra = {}) => call(who, "POST", "/api/moderation", { body: { target, action, ...extra } });
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const logs = () => rows("SYNC#LOG").filter((r) => r.op === "marker");
  return { ...w, inbox, call, act, rows, logs, owner, nobody, n1, n2, n3, m1, m2, m3, apply, mod: (key) => w.ddb.rows.get(`MOD#${key}\u0000META`) };
}

describe("record targets are dark until moderationRecordsV1 is on", () => {
  it("answers 422 unsupported_target for every record kind, whatever its shape, and writes nothing", async () => {
    const w = await world({ flags: { ...FLAGS, moderationRecordsV1: false } });
    for (const target of [{ kind: "note", handle: w.n1.handle }, { kind: "media", handle: w.m1.handle }, { kind: "mediaref", person: w.owner.handle, media: w.m1.handle }, { kind: "note", id: "h1" }, { kind: "note" }]) {
      const r = await w.act(ADMIN, target, "hide");
      expect([r.status, r.body.error]).toEqual([422, "unsupported_target"]);
    }
    expect(w.rows("MOD#")).toHaveLength(0);
    expect(w.logs()).toHaveLength(0);
    expect((await w.act(OWNER, { kind: "note", handle: w.n1.handle }, "hide")).status).toBe(403);
  });
  it("is off when moderationV1 is off, for an admin too (404)", async () => {
    const w = await world({ flags: { ...FLAGS, moderationV1: false } });
    expect((await w.act(ADMIN, { kind: "note", handle: w.n1.handle }, "hide")).status).toBe(404);
  });
  it("has no MCP tool and keeps the one route gate", () => {
    expect(ROUTES.find((r) => r.name === "moderation.post").gate).toEqual({ type: "feature", name: "moderationV1" });
    expect(ROUTES.find((r) => r.name === "moderation.post").mcp).toBeUndefined();
  });
});

describe("parseTarget and targetKey for the record kinds", () => {
  it("checks the shape once the flag is on, and keys the MOD# item as the design names it", () => {
    expect(targetKey(parseTarget({ kind: "note", handle: "abc" }, { records: true }))).toBe("note:abc");
    expect(targetKey(parseTarget({ kind: "media", handle: "abc" }, { records: true }))).toBe("media:abc");
    expect(targetKey(parseTarget({ kind: "mediaref", person: "p1", media: "m1" }, { records: true }))).toBe("mediaref:p1:m1");
    for (const bad of [{ kind: "note" }, { kind: "note", handle: "a b" }, { kind: "mediaref", person: "p1" }, { kind: "media", handle: 5 }]) {
      expect(() => parseTarget(bad, { records: true })).toThrow(/must be a record handle/);
    }
    expect(parseTarget({ kind: "note", id: "x" })).toEqual({ kind: "note" });
  });
});

describe("hiding a note", () => {
  it("writes the MOD# overlay, an audit entry with the private reason and a marker op, in one transaction", async () => {
    const w = await world();
    const before = w.logs().length;
    const r = await w.act(ADMIN, { kind: "note", handle: w.n2.handle }, "hide", { reason: "private reason text" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ state: "hidden", hidden: true, open: true });
    expect(JSON.stringify(r.body)).not.toContain("private reason");
    const m = w.mod(`note:${w.n2.handle}`);
    expect(m).toMatchObject({ entity: "mod", state: "hidden", hidden: true, open: true, GSI1PK: "MODQ#open", author_id: OWNER, version: 1 });
    const audit = w.rows("AUDIT#note:");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ op: "moderate", principal: ADMIN, reason: "private reason text" });
    const marks = w.logs();
    expect(marks).toHaveLength(before + 1);
    expect(marks.at(-1)).toMatchObject({ op: "marker", reason: "moderation", origin: "moderation", principal: ADMIN });
    expect(marks.at(-1).marker).toEqual({ ref: { class: "Note", handle: w.n2.handle } });
  });

  it("sends the notice to the page owner when they are a member (story), and not to the acting admin", async () => {
    const w = await world();
    await w.act(ADMIN, { kind: "note", handle: w.n2.handle }, "request_changes", { note: "please reword this story" });
    const items = (await w.inbox.list(OWNER)).items;
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain("please reword this story");
    expect((await w.inbox.list(ADMIN)).items).toEqual([]);
    expect((await w.inbox.list(IO)).items).toEqual([]);
    expect(w.mod(`note:${w.n2.handle}`)).toMatchObject({ state: "changes_requested", hidden: true, note: "please reword this story" });
  });

  it("notifies io (gramps-owner) when no member owns the page", async () => {
    const w = await world();
    const r = await w.act(ADMIN, { kind: "note", handle: w.n3.handle }, "ask", { note: "where is this from?", hide: true });
    expect(r.status).toBe(200);
    expect(w.mod(`note:${w.n3.handle}`)).toMatchObject({ state: "question", hidden: true, author_id: IO });
    expect((await w.inbox.list(IO)).items).toHaveLength(1);
    expect((await w.inbox.list(OWNER)).items).toEqual([]);
  });

  it("a repeated hide is a no-op (no second marker, no second notice), and unhide closes the item and tells the owner", async () => {
    const w = await world();
    const t = { kind: "note", handle: w.n2.handle };
    await w.act(ADMIN, t, "hide");
    const n = w.logs().length;
    expect((await w.act(ADMIN, t, "hide")).status).toBe(200);
    expect(w.logs()).toHaveLength(n);
    expect((await w.inbox.list(OWNER)).items).toHaveLength(1);
    const un = await w.act(ADMIN, t, "unhide");
    expect(un.body.moderation).toBeNull();
    expect(w.mod(`note:${w.n2.handle}`)).toMatchObject({ open: false, hidden: false, GSI1PK: "MODQ#closed", resolved_by: ADMIN });
    expect(w.logs()).toHaveLength(n + 1);
    expect((await w.inbox.list(OWNER)).items).toHaveLength(2);
    const again = await w.act(ADMIN, t, "unhide");
    expect(again.status).toBe(200);
    expect(w.logs()).toHaveLength(n + 1);
  });

  it("refuses contact details in the note (422, nothing stored), a missing record (404), a non-admin (403) and a stale version (409)", async () => {
    const w = await world();
    const t = { kind: "note", handle: w.n2.handle };
    const g = await w.act(ADMIN, t, "ask", { note: "call me at 555-123-4567 please" });
    expect([g.status, g.body.error]).toEqual([422, "contact_info"]);
    expect((await w.act(ADMIN, { kind: "note", handle: h(9999) }, "hide")).status).toBe(404);
    expect((await w.act(ADMIN, { kind: "mediaref", person: w.owner.handle, media: w.m3.handle }, "hide")).status).toBe(404);
    expect((await w.act(OWNER, t, "hide")).status).toBe(403);
    expect((await w.act(ADMIN, t, "hide", { version: "99" })).status).toBe(409);
    expect(w.rows("MOD#")).toHaveLength(0);
    expect(w.logs()).toHaveLength(0);
  });

  it("an admin who owns the page cannot moderate it (self_moderation)", async () => {
    const w = await world({ members: [OWNER, ADMIN] });
    const own = note(50, "Synthetic story fifty");
    await w.apply([create(own), create(person(99, { note_list: [own.handle] }))]); // I0099 is the admin's own Person and a member
    const r = await w.act(ADMIN, { kind: "note", handle: own.handle }, "hide");
    expect([r.status, r.body.error]).toEqual([400, "self_moderation"]);
  });
});

describe("hiding a media reference and a media", () => {
  it("a mediaref hides one photo on one page: MOD#mediaref:<person>:<media>, a marker about the Person, a photo notice to the owner", async () => {
    const w = await world();
    const r = await w.act(ADMIN, { kind: "mediaref", person: w.owner.handle, media: w.m2.handle }, "hide");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w.mod(`mediaref:${w.owner.handle}:${w.m2.handle}`)).toMatchObject({ state: "hidden", hidden: true });
    expect(w.logs().at(-1).marker).toEqual({ ref: { class: "Person", handle: w.owner.handle } });
    expect((await w.inbox.list(OWNER)).items).toHaveLength(1);
  });
  it("a media hides the Media everywhere: MOD#media:<handle>, a marker about the Media", async () => {
    const w = await world();
    const r = await w.act(ADMIN, { kind: "media", handle: w.m3.handle }, "hide");
    expect(r.status).toBe(200);
    expect(w.mod(`media:${w.m3.handle}`)).toMatchObject({ state: "hidden", hidden: true, author_id: IO });
    expect(w.logs().at(-1).marker).toEqual({ ref: { class: "Media", handle: w.m3.handle } });
    expect((await w.inbox.list(IO)).items).toHaveLength(1);
  });
  it("the queue lists the record items with a link to the holder's page", async () => {
    const w = await world();
    await w.act(ADMIN, { kind: "note", handle: w.n2.handle }, "hide");
    await w.act(ADMIN, { kind: "media", handle: w.m2.handle }, "hide");
    const q1 = await w.call(ADMIN, "GET", "/api/moderation");
    expect(q1.body.items.map((i) => i.target.kind).sort()).toEqual(["media", "note"]);
    const n = q1.body.items.find((i) => i.target.kind === "note");
    expect(n.href).toBe("/person/?id=I0001#stories");
    expect(q1.body.items.find((i) => i.target.kind === "media").href).toBe("/person/?id=I0001#photos");
  });
});

describe("a hidden note and a hidden media are absent from every API response for a non-owner member (PS-07)", () => {
  it("the records API, the edit bundle and the MCP tool", async () => {
    const w = await world();
    expect((await w.act(ADMIN, { kind: "note", handle: w.n2.handle }, "hide")).status).toBe(200);
    expect((await w.act(ADMIN, { kind: "media", handle: w.m2.handle }, "hide")).status).toBe(200);
    expect((await w.act(ADMIN, { kind: "mediaref", person: w.owner.handle, media: w.m1.handle }, "hide")).status).toBe(200);
    const texts = [];
    for (const path of [`/api/records/Person/by-id/${OWNER}`, `/api/edit/Person/${OWNER}`]) {
      const r = await w.call(THIRD, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.body.obj.note_list).toEqual([w.n1.handle]);
      expect(r.body.obj.media_list).toEqual([]); // m1 by its mediaref, m2 by media
      expect(r.body.hidden).toBeUndefined();
      texts.push(JSON.stringify(r.body));
    }
    // The MCP tool hfy_records_get is the edit.get route (routes.js MCP map): the same bundle, over invoke().
    const mcp = await w.handler.invoke({ id: THIRD, admin: false, label: THIRD }, "edit.get", { params: { cls: "Person", ref: OWNER } });
    texts.push(JSON.stringify(mcp));
    expect(JSON.stringify(mcp)).toContain("Synthetic"); // it did read the record
    for (const [cls, handle] of [["Note", w.n2.handle], ["Media", w.m2.handle]]) {
      expect((await w.call(THIRD, "GET", `/api/records/${cls}/${handle}`)).status).toBe(404);
      expect((await w.call(THIRD, "GET", `/api/edit/${cls}/${cls === "Note" ? w.n2.gramps_id : w.m2.gramps_id}`)).status).toBe(404);
    }
    for (const body of texts) {
      expect(body).not.toContain("Synthetic story two");
      expect(body).not.toContain(w.n2.handle);
      expect(body).not.toContain(w.m2.handle);
      expect(body).not.toContain("Synthetic photo 2");
    }
  });
  it("admins and the record owner still see them, with a hidden badge", async () => {
    const w = await world();
    await w.act(ADMIN, { kind: "note", handle: w.n2.handle }, "hide");
    await w.act(ADMIN, { kind: "media", handle: w.m2.handle }, "hide");
    for (const who of [ADMIN, OWNER]) {
      const r = await w.call(who, "GET", `/api/records/Person/by-id/${OWNER}`);
      expect(r.body.obj.note_list).toEqual([w.n1.handle, w.n2.handle]);
      expect(r.body.hidden, who).toEqual([`media:${w.m2.handle}`, `note:${w.n2.handle}`]);
    }
    expect((await w.call(ADMIN, "GET", `/api/records/Note/${w.n2.handle}`)).body.hidden).toEqual([`note:${w.n2.handle}`]);
    expect((await w.call(THIRD, "GET", `/api/records/Person/by-id/${OWNER}`)).body.hidden).toBeUndefined();
  });
});
