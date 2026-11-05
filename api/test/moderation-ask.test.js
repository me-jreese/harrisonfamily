// HFY-TSK-159 (hfy-moderation-ask-api; social.md 11.2 and 11.5, BRD2 D2-19, R-32): request_changes and ask through POST /api/moderation, with a note that is
// guarded, stored on the inline state and on MOD#, and delivered as the notice's detail; the author's edit that answers an ask (clears the state, closes
// MOD#, unhides the event inside the edit's transaction, and tells the asking admin); and one table-driven case per row of the 11.2 transition table, for a
// post and for a comment. Synthetic ids and text only.
import { describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken } from "./world.js";
import { createModeration, parseAction } from "../src/moderation.js";

const AUTHOR = "I0001";
const OTHER = "I0002";
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const THREAD = "person:I0042";
const FLAGS = { moderationV1: true, contribV1: true, inboxV1: true, commentPhotosV1: true };
const q = { warn() {}, error() {}, info() {} };
const NOTE = "please add the year to the first line";

async function world(opts = {}) {
  const inbox = new InMemoryNotificationStore();
  const api = makeApi({ withPush: false, log: q, inbox, flags: FLAGS, admins: [ADMIN, ADMIN2], ...opts });
  const [author, other, admin, admin2] = await Promise.all([AUTHOR, OTHER, ADMIN, ADMIN2].map((s) => signToken(s)));
  const tok = { author, other, admin, admin2 };
  const call = (who, method, path, extra = {}) => api.call(method, path, { token: who === null ? undefined : tok[who], ...extra });
  const row = (pk, sk) => api.ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => api.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const post = async (body = {}, who = "author") => {
    const r = await call(who, "POST", "/api/posts", { body: { body: "a plain line", visibility: "published", ...body } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const comment = async (body = "a plain comment", who = "author") => {
    const r = await call(who, "POST", "/api/comments", { body: { subject: THREAD, body } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const act = (who, target, action, extra = {}) => call(who, "POST", "/api/moderation", { body: { target, action, ...extra } });
  const events = () => rows(`CONTRIB#${AUTHOR}`).filter((r) => r.SK.startsWith("E#"));
  const mod = (key) => row(`MOD#${key}`, "META");
  const inboxOf = async (who) => (await inbox.list(who)).items;
  return { api, inbox, call, row, rows, post, comment, act, events, mod, inboxOf };
}

/** The two item kinds the table runs over: how to make one, name it, read its stored state, edit it and delete it as its author. */
const KINDS = {
  post: {
    async make(w) { const p = await w.post({ subject: "person:I0042" }); return { id: p.id, target: { kind: "post", id: p.id }, key: `post:${p.id}`, version: p.updated_at }; },
    stored: (w, it) => w.row(`POST#${it.id}`, "META").post,
    edit: (w, it, body = "a tidied line, now with the year") => w.call("author", "PATCH", `/api/posts/${it.id}`, { body: { body } }),
    del: (w, it, who) => w.call(who, "DELETE", `/api/posts/${it.id}`),
    read: (w, it, who) => w.call(who, "GET", `/api/posts/${it.id}`),
    item: "story",
    href: (it) => `/posts/?id=${it.id}`,
    noEvent: false,
  },
  comment: {
    async make(w) { const c = await w.comment(); return { id: c.id, target: { kind: "comment", id: c.id, thread: THREAD }, key: `comment:${THREAD}/${c.id}`, version: c.created_at }; },
    stored: (w, it) => w.row(`THREAD#${THREAD}`, `C#${it.id}`).comment,
    edit: (w, it, body = "a tidied comment, now with the year") => w.call("author", "PATCH", `/api/comments/${it.id}`, { body: { subject: THREAD, body } }),
    del: (w, it, who) => w.call(who, "DELETE", `/api/comments/${it.id}`, { query: { subject: THREAD } }),
    read: (w, it, who) => w.call(who, "GET", "/api/comments", { query: { subject: THREAD } }),
    item: "comment",
    href: (it) => `/person/?id=I0042#comment-${it.id}`,
    noEvent: false,
  },
};

const STATE_OF = { hide: "hidden", request_changes: "changes_requested", ask: "question" };

describe.each(Object.entries(KINDS))("the 11.2 transition table, %s", (kindName, K) => {
  const START = {
    none: async () => ({}),
    hidden: (w, it) => w.act("admin", it.target, "hide"),
    changes_requested: (w, it) => w.act("admin", it.target, "request_changes", { note: NOTE }),
    question_visible: (w, it) => w.act("admin", it.target, "ask", { note: NOTE }),
    question_hidden: (w, it) => w.act("admin", it.target, "ask", { note: NOTE, hide: true }),
  };

  it("row 1: none + hide -> hidden, hidden:true; MOD# open, audit, event hidden; moderation_hidden to the author, with no detail", async () => {
    const w = await world();
    const it = await K.make(w);
    const r = await w.act("admin", it.target, "hide", { reason: "private: off topic" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ state: "hidden", hidden: true, open: true, by: { id: ADMIN } });
    expect(r.body.moderation.note).toBeUndefined();
    expect(w.mod(it.key)).toMatchObject({ state: "hidden", hidden: true, open: true, GSI1PK: "MODQ#open" });
    expect(w.mod(it.key).note).toBeUndefined();
    expect(w.events()[0].hidden).toBe(true);
    const items = await w.inboxOf(AUTHOR);
    expect(items.map((i) => i.type)).toEqual(["moderation_hidden"]);
    expect(items[0].detail).toBeUndefined();
  });

  it("row 2: none + request_changes + note -> changes_requested, hidden:true; the note on the inline state and on MOD#; moderation_request with detail = the note", async () => {
    const w = await world();
    const it = await K.make(w);
    const r = await w.act("admin", it.target, "request_changes", { note: `  ${NOTE}  `, reason: "private: tone" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ state: "changes_requested", hidden: true, note: NOTE, open: true, by: { id: ADMIN } });
    expect(K.stored(w, it).moderation).toMatchObject({ state: "changes_requested", hidden: true, note: NOTE });
    expect(w.mod(it.key)).toMatchObject({ state: "changes_requested", hidden: true, note: NOTE, open: true, version: 1 });
    expect(w.events()[0].hidden).toBe(true);
    const audit = w.rows("AUDIT#").filter((a) => a.op === "moderate");
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe("private: tone");
    expect(JSON.stringify(r.body)).not.toContain("private: tone");
    const items = await w.inboxOf(AUTHOR);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "moderation_request", detail: NOTE, navigate: K.href(it), fields: { actor: ADMIN, item: K.item } });
    // another member neither sees the item nor the note
    if (kindName === "post") expect((await K.read(w, it, "other")).status).toBe(404);
    else expect((await K.read(w, it, "other")).body.thread.comments).toEqual([]);
    expect((await w.inboxOf(OTHER))).toEqual([]);
    expect((await w.inboxOf(ADMIN))).toEqual([]);
  });

  it("row 3: none + ask + note, hide false by default -> question, hidden:false (visible to everyone); moderation_question with detail = the note", async () => {
    const w = await world();
    const it = await K.make(w);
    const r = await w.act("admin", it.target, "ask", { note: NOTE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ state: "question", hidden: false, note: NOTE, open: true });
    expect(w.mod(it.key)).toMatchObject({ state: "question", hidden: false, note: NOTE, open: true });
    expect(w.events()[0].hidden ?? false).toBe(false);
    const items = await w.inboxOf(AUTHOR);
    expect(items[0]).toMatchObject({ type: "moderation_question", detail: NOTE, navigate: K.href(it) });
    // visible to another member, who gets the item without the private note
    const seen = await K.read(w, it, "other");
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toContain(NOTE);
    // the author and admins do see the moderation
    const mine = await K.read(w, it, "author");
    expect(JSON.stringify(mine.body)).toContain(NOTE);
  });

  it("row 3b: ask with hide:true hides the item", async () => {
    const w = await world();
    const it = await K.make(w);
    const r = await w.act("admin", it.target, "ask", { note: NOTE, hide: true });
    expect(r.body.moderation).toMatchObject({ state: "question", hidden: true, note: NOTE });
    expect(w.mod(it.key)).toMatchObject({ state: "question", hidden: true });
    expect(w.events()[0].hidden).toBe(true);
    if (kindName === "post") expect((await K.read(w, it, "other")).status).toBe(404);
    expect((await w.inboxOf(AUTHOR))[0]).toMatchObject({ type: "moderation_question", detail: NOTE });
  });

  it.each(["hidden", "changes_requested", "question_visible", "question_hidden"])("row 4: %s + unhide -> none, MOD# closed, event back; moderation_unhidden", async (start) => {
    const w = await world();
    const it = await K.make(w);
    await START[start](w, it);
    expect(w.mod(it.key).open).toBe(true);
    const r = await w.act("admin", it.target, "unhide");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toBeNull();
    expect(K.stored(w, it).moderation).toBeUndefined();
    expect(w.mod(it.key)).toMatchObject({ open: false, hidden: false, GSI1PK: "MODQ#closed", resolved_by: ADMIN });
    expect(w.events()[0].hidden ?? false).toBe(false);
    expect((await w.inboxOf(AUTHOR)).map((i) => i.type)).toContain("moderation_unhidden");
  });

  it.each(["changes_requested", "question_visible", "question_hidden"])("row 5: %s + effective author edit -> none, MOD# closed (resolved_by author), event unhidden, in the edit's transaction; moderation_resolved to the asking admin", async (start) => {
    const w = await world();
    const it = await K.make(w);
    await START[start](w, it);
    const before = w.mod(it.key);
    const r = await K.edit(w, it);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toBeUndefined();
    expect(K.stored(w, it).moderation).toBeUndefined();
    expect(w.mod(it.key)).toMatchObject({ open: false, hidden: false, GSI1PK: "MODQ#closed", resolved_by: "author", version: before.version + 1 });
    expect(w.events()[0].hidden ?? false).toBe(false);
    // visible again to everyone
    expect((await K.read(w, it, "other")).status).toBe(200);
    const asking = await w.inboxOf(ADMIN);
    expect(asking).toHaveLength(1);
    expect(asking[0]).toMatchObject({ type: "moderation_resolved", navigate: K.href(it), fields: { actor: AUTHOR, item: K.item } });
    expect(asking[0].detail).toBeUndefined();
    expect(await w.inboxOf(ADMIN2)).toEqual([]); // only the admin who asked
    expect((await w.inboxOf(AUTHOR)).map((i) => i.type).sort()).toEqual(start.startsWith("question") ? ["moderation_question"] : ["moderation_request"]);
  });

  it("row 5, atomic: when the edit's transaction fails, the state, MOD#, event and edit stay as they were and the admin is told nothing", async () => {
    const w = await world();
    const it = await K.make(w);
    await START.changes_requested(w, it);
    const snapshot = JSON.stringify(w.api.ddb.all());
    w.api.ddb.failNext("ConditionalCheckFailed");
    const r = await K.edit(w, it);
    expect(r.status).toBeGreaterThanOrEqual(409);
    expect(JSON.stringify(w.api.ddb.all())).toBe(snapshot);
    expect(w.mod(it.key).open).toBe(true);
    expect(await w.inboxOf(ADMIN)).toEqual([]);
  });

  it("row 5, not effective: an author edit that changes nothing leaves the ask open and tells nobody", async () => {
    const w = await world();
    const it = await K.make(w);
    await START.changes_requested(w, it);
    const same = kindName === "post" ? "a plain line" : "a plain comment";
    const r = await K.edit(w, it, same);
    expect(r.status).toBe(200);
    expect(K.stored(w, it).moderation).toMatchObject({ state: "changes_requested", open: true });
    expect(w.mod(it.key).open).toBe(true);
    expect(await w.inboxOf(ADMIN)).toEqual([]);
  });

  it("row 6: hidden (a plain hide) + author edit -> stays hidden; no notice", async () => {
    const w = await world();
    const it = await K.make(w);
    await START.hidden(w, it);
    const r = await K.edit(w, it);
    expect(r.status).toBe(200);
    expect(K.stored(w, it).moderation).toMatchObject({ state: "hidden", hidden: true, open: true });
    expect(w.mod(it.key)).toMatchObject({ open: true, hidden: true, state: "hidden" });
    expect(w.events()[0].hidden).toBe(true);
    expect(await w.inboxOf(ADMIN)).toEqual([]);
    if (kindName === "post") expect((await K.read(w, it, "other")).status).toBe(404);
  });

  it.each(["hidden", "changes_requested", "question_visible", "question_hidden"])("row 7: %s + delete by the author -> gone, MOD# closed", async (start) => {
    const w = await world();
    const it = await K.make(w);
    await START[start](w, it);
    expect([200, 204]).toContain((await K.del(w, it, "author")).status);
    expect(w.mod(it.key)).toMatchObject({ open: false, GSI1PK: "MODQ#closed", resolved_by: "author" });
    expect(w.events()).toHaveLength(0);
    expect(await w.inboxOf(ADMIN)).toEqual([]); // a delete is not an edit that answers the ask
  });

  it.each(["hidden", "changes_requested", "question_visible", "question_hidden"])("row 7: %s + delete by a moderator -> gone, MOD# closed", async (start) => {
    const w = await world();
    const it = await K.make(w);
    await START[start](w, it);
    expect([200, 204]).toContain((await K.del(w, it, "admin")).status);
    expect(w.mod(it.key)).toMatchObject({ open: false, GSI1PK: "MODQ#closed", resolved_by: ADMIN });
  });

  it.each(["hide", "unhide", "request_changes", "ask"])("row 8: your own item + %s -> 400 self_moderation, nothing written", async (action) => {
    const w = await world();
    const mine = kindName === "post" ? await w.post({}, "admin") : await w.comment("an admin's own", "admin");
    const target = kindName === "post" ? { kind: "post", id: mine.id } : { kind: "comment", id: mine.id, thread: THREAD };
    const r = await w.act("admin", target, action, action === "request_changes" || action === "ask" ? { note: NOTE } : {});
    expect([r.status, r.body.error]).toEqual([400, "self_moderation"]);
    expect(w.rows("MOD#")).toHaveLength(0);
  });

  it.each([
    ["changes_requested", "ask", { note: "which year?" }, "question", false],
    ["question_visible", "request_changes", { note: "please fix the date" }, "changes_requested", true],
    ["hidden", "ask", { note: "can you say more?", hide: true }, "question", true],
    ["changes_requested", "request_changes", { note: "a different request" }, "changes_requested", true],
  ])("row 9: an open ask (%s) replaced by %s closes the old record and opens a new one (one MOD# item, version moves on)", async (start, action, extra, state, hidden) => {
    const w = await world();
    const it = await K.make(w);
    await START[start](w, it);
    const first = w.mod(it.key);
    const r = await w.act("admin2", it.target, action, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w.mod(it.key)).toMatchObject({ state, hidden, open: true, note: extra.note, by: { id: ADMIN2 }, version: first.version + 1 });
    expect(K.stored(w, it).moderation).toMatchObject({ state, hidden, note: extra.note, by: { id: ADMIN2 } });
    // the author is told of the new ask; the later author edit tells the admin who asked last
    await K.edit(w, it);
    expect((await w.inboxOf(ADMIN2)).map((i) => i.type)).toEqual(["moderation_resolved"]);
    expect((await w.inboxOf(ADMIN)).map((i) => i.type)).toEqual([]);
  });
});

describe("the note and the other fields", () => {
  it.each(["request_changes", "ask"])("%s needs a note of 1 to 1000 characters (trimmed): missing, blank, non-text and too long are 400 validation on `note`, and nothing is written", async (action) => {
    const w = await world();
    const p = await w.post();
    const target = { kind: "post", id: p.id };
    for (const note of [undefined, null, "", "   ", 5, "x".repeat(1001)]) {
      const r = await w.act("admin", target, action, note === undefined ? {} : { note });
      expect([r.status, r.body.error], JSON.stringify(note)).toEqual([400, "validation"]);
      expect(r.body.details?.fields ?? r.body.fields).toEqual([{ field: "note", code: "invalid" }]);
    }
    expect(w.rows("MOD#")).toHaveLength(0);
    const edge = await w.act("admin", target, action, { note: "x".repeat(1000) });
    expect(edge.status).toBe(200);
    expect(edge.body.moderation.note).toHaveLength(1000);
    const one = await w.act("admin2", target, action, { note: "y" });
    expect(one.status).toBe(200);
    expect(one.body.moderation.note).toBe("y");
  });

  it.each(["post", "comment"])("the privacy guard runs on the note of a %s: contact information is 422 contact_info and nothing is stored or sent", async (kind) => {
    const w = await world();
    const target = kind === "post" ? { kind, id: (await w.post()).id } : { kind, id: (await w.comment()).id, thread: THREAD };
    const snapshot = JSON.stringify(w.api.ddb.all());
    for (const action of ["request_changes", "ask"]) {
      const r = await w.act("admin", target, action, { note: "write to me at someone@example.com please" });
      expect([r.status, r.body.error]).toEqual([422, "contact_info"]);
      expect(JSON.stringify(r.body)).not.toContain("someone@example.com");
    }
    expect(JSON.stringify(w.api.ddb.all())).toBe(snapshot);
    expect(await w.inboxOf(AUTHOR)).toEqual([]);
  });

  it("refuses a note on hide and unhide, a note on a photo, and a hide flag that is not a boolean", async () => {
    const w = await world();
    const p = await w.post();
    const target = { kind: "post", id: p.id };
    for (const action of ["hide", "unhide"]) {
      const r = await w.act("admin", target, action, { note: "stray" });
      expect([r.status, r.body.error]).toEqual([400, "validation"]);
    }
    expect((await w.act("admin", target, "hide", { note: "" })).status).toBe(200); // an empty note counts as none
    const bad = await w.act("admin", target, "ask", { note: NOTE, hide: "yes" });
    expect([bad.status, bad.body.error]).toEqual([400, "validation"]);
    const photo = await w.act("admin", { kind: "photo", parent: target, attachment: "01J00000000000000000000000" }, "ask", { note: NOTE });
    expect([photo.status, photo.body.error]).toEqual([400, "validation"]);
  });

  it("a note on a record target is 422 unsupported_target (the record kinds wait for hfy-moderation-record-targets) and a non-admin is 403", async () => {
    const w = await world();
    const r = await w.act("admin", { kind: "note", id: "h1" }, "ask", { note: NOTE });
    expect([r.status, r.body.error]).toEqual([422, "unsupported_target"]);
    const p = await w.post();
    expect((await w.act("other", { kind: "post", id: p.id }, "ask", { note: NOTE })).status).toBe(403);
    expect((await w.act("author", { kind: "post", id: p.id }, "request_changes", { note: NOTE })).status).toBe(403);
  });

  it("a stale version is 409 for request_changes and ask too, and writes nothing", async () => {
    const w = await world();
    const p = await w.post();
    for (const action of ["request_changes", "ask"]) {
      const r = await w.act("admin", { kind: "post", id: p.id }, action, { note: NOTE, version: "2020-01-01T00:00:00.000Z" });
      expect([r.status, r.body.error]).toEqual([409, "conflict"]);
    }
    expect(w.rows("MOD#")).toHaveLength(0);
    const ok = await w.act("admin", { kind: "post", id: p.id }, "ask", { note: NOTE, version: p.updated_at });
    expect(ok.status).toBe(200);
  });

  it("the note reaches the admin queue and never the other members; the private reason never does", async () => {
    const w = await world();
    const p = await w.post();
    await w.act("admin", { kind: "post", id: p.id }, "ask", { note: NOTE, reason: "private: tone" });
    const list = await w.call("admin", "GET", "/api/moderation");
    expect(list.body.items[0]).toMatchObject({ state: "question", hidden: false, note: NOTE });
    expect(JSON.stringify(list.body)).not.toContain("private: tone");
    expect((await w.call("other", "GET", "/api/moderation")).status).toBe(403);
  });

  it("an edit that removes a photo hidden by a moderator while a request_changes is open closes both records", async () => {
    const w = await world();
    const up = (await w.call("author", "POST", "/api/uploads", { body: { contentType: "image/jpeg", size: 9 } })).body;
    const a = { kind: "image", url: up.publicUrl, mime: "image/jpeg" };
    const p = await w.post({ attachments: [a] });
    const attachment = /\/uploads\/posts\/([0-9A-HJKMNP-TV-Z]{26})\//.exec(up.publicUrl)[1];
    await w.act("admin", { kind: "photo", parent: { kind: "post", id: p.id }, attachment }, "hide");
    await w.act("admin", { kind: "post", id: p.id }, "request_changes", { note: NOTE });
    const r = await w.call("author", "PATCH", `/api/posts/${p.id}`, { body: { body: "edited, photo kept" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w.mod(`post:${p.id}`).open).toBe(false);
    expect(w.mod(`photo:post:${p.id}#${attachment}`).open).toBe(true); // a hidden photo the edit keeps stays hidden
    expect((await w.inboxOf(ADMIN)).map((i) => i.type)).toEqual(["moderation_resolved"]);
  });

  it("a failing resolution notice never fails the author's committed edit", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = await world({ inbox });
    const p = await w.post();
    await w.act("admin", { kind: "post", id: p.id }, "request_changes", { note: NOTE });
    inbox.add = async () => { throw new Error("store down"); };
    const r = await w.call("author", "PATCH", `/api/posts/${p.id}`, { body: { body: "now with more" } });
    expect(r.status).toBe(200);
    expect(w.mod(`post:${p.id}`).open).toBe(false);
  });
});

describe("the pieces", () => {
  it("parseAction: note, hide, reason and version", () => {
    expect(parseAction({ action: "hide" })).toEqual({ action: "hide" });
    expect(parseAction({ action: "ask", note: " q ", reason: " r " })).toEqual({ action: "ask", note: "q", hide: false, reason: "r" });
    expect(parseAction({ action: "ask", note: "q", hide: true })).toMatchObject({ hide: true });
    expect(parseAction({ action: "request_changes", note: "q", hide: false })).toEqual({ action: "request_changes", note: "q" }); // always hidden: the flag is not read
    expect(() => parseAction({ action: "ask" })).toThrow();
    expect(() => parseAction({ action: "unhide", note: "x" })).toThrow();
  });

  it("the route sends request and question notices with the note, and nothing for a no-op write", async () => {
    const sent = [];
    const post = { id: "01J00000000000000000000001", author: { id: AUTHOR, label: "Ann" }, updated_at: "2026-01-01T00:00:00.000Z" };
    let wrote = true;
    const content = {
      async get() { return post; },
      async moderate(_id, m, opts) {
        if (wrote) opts.onWrite();
        expect(m).toMatchObject({ action: m.action });
        return { ...post, moderation: wrote ? { state: STATE_OF[m.action], hidden: m.action !== "ask" || m.hide === true, by: { id: ADMIN }, at: "2026-01-02T00:00:00.000Z", note: m.note, open: true } : undefined };
      },
    };
    const mod = createModeration({ ddb: null, cmds, table: "t", actor: { id: ADMIN, label: "Admin", admin: true }, content, comments: {}, notifier: { async onModeration(n) { sent.push(n); } } });
    await mod.post({ target: { kind: "post", id: post.id }, action: "request_changes", note: "n1" });
    await mod.post({ target: { kind: "post", id: post.id }, action: "ask", note: "n2" });
    wrote = false;
    await mod.post({ target: { kind: "post", id: post.id }, action: "ask", note: "n3" });
    expect(sent.map((n) => [n.kind, n.note])).toEqual([["request", "n1"], ["question", "n2"]]);
  });
});
