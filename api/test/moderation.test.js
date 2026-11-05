// HFY-TSK-258 (hfy-moderation-api-core; social.md section 11, BRD2 D2-19, R-32): POST/GET /api/moderation, the inline state, the MOD# item, the audit
// entry and the contribution event in one transaction, and the same visibility rule in every read path. Synthetic ids and text only.
import { describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { TABLE, cmds, makeApi, signToken, ticker } from "./world.js";
import { createContentSource } from "../src/content.js";
import { ROUTES, buildCaps } from "../src/routes.js";
import { archiveView, closedItem, commentHidden, createModeration, modItem, moderationVisible, parseTarget, postAttachmentId, targetKey } from "../src/moderation.js";
import { commentGuard } from "../src/comments.js";

const AUTHOR = "I0001"; // writes the items
const OTHER = "I0002"; // an ordinary member
const ADMIN = "I0099";
const THREAD = "person:I0042";
const FLAGS = { moderationV1: true, contribV1: true, inboxV1: true, commentPhotosV1: true };
const q = { warn() {}, error() {}, info() {} };

async function world(opts = {}) {
  const inbox = new InMemoryNotificationStore();
  const api = makeApi({ withPush: false, log: q, inbox, flags: FLAGS, ...opts });
  const [author, other, admin, admin2] = await Promise.all([AUTHOR, OTHER, ADMIN, "I0098"].map((s) => signToken(s)));
  const tok = { author, other, admin, admin2 };
  const call = (who, method, path, extra = {}) => api.call(method, path, { token: who === null ? undefined : tok[who], ...extra });
  const row = (pk, sk) => api.ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => api.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const photo = async (who = "author", purpose) => {
    const up = (await call(who, "POST", "/api/uploads", { body: { contentType: "image/jpeg", size: 9, ...(purpose ? { purpose } : {}) } })).body;
    return { kind: "image", url: up.publicUrl, mime: "image/jpeg" };
  };
  const post = async (body = {}, who = "author") => {
    const r = await call(who, "POST", "/api/posts", { body: { body: "a plain line", visibility: "published", ...body } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const comment = async (subject, body = "a plain comment", who = "author", extra = {}) => {
    const r = await call(who, "POST", "/api/comments", { body: { subject, body, ...extra } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const photoComment = async (subject = THREAD, body = "with a photo") => {
    const a = await photo("author", "comment");
    return comment(subject, body, "author", { attachments: [{ url: a.url, mime: a.mime }] });
  };
  const hide = (who, target, extra = {}) => call(who, "POST", "/api/moderation", { body: { target, action: "hide", ...extra } });
  const unhide = (who, target, extra = {}) => call(who, "POST", "/api/moderation", { body: { target, action: "unhide", ...extra } });
  const postRows = (id) => ["META", "IDX#AUTHOR", "IDX#SUBJECT"].map((sk) => row(`POST#${id}`, sk)).filter(Boolean);
  const events = () => rows(`CONTRIB#${AUTHOR}`).filter((r) => r.SK.startsWith("E#"));
  const mod = (key) => row(`MOD#${key}`, "META");
  return { api, inbox, tok, call, row, rows, photo, post, comment, photoComment, hide, unhide, postRows, events, mod };
}

describe("the routes", () => {
  it("are dark until moderationV1 is on (404 even for an admin and when signed out), carry no MCP tool and no policy row", async () => {
    const w = await world({ flags: { moderationV1: false } });
    const p = await w.post();
    for (const who of ["admin", "author", null]) {
      expect((await w.hide(who, { kind: "post", id: p.id })).status).toBe(404);
      expect((await w.call(who, "GET", "/api/moderation")).status).toBe(404);
    }
    expect(w.postRows(p.id)[0].post.moderation).toBeUndefined();
    const on = await world();
    expect((await on.call(null, "GET", "/api/moderation")).status).toBe(401);
    const caps = buildCaps();
    for (const name of ["moderation.post", "moderation.list"]) {
      const route = ROUTES.find((r) => r.name === name);
      expect(route.gate).toEqual({ type: "feature", name: "moderationV1" });
      expect(route.mcp).toBeUndefined();
      expect(caps.actions.find((a) => a.name === name).gate).toEqual({ feature: "moderationV1" });
    }
    expect(caps.mcp.tools.map((t) => t.action)).not.toContain("moderation.post");
    expect(caps.audit.ops).toContain("moderate");
  });

  it("answer 403 to a non-admin before they learn anything, and 400 for a malformed request", async () => {
    const w = await world();
    const p = await w.post();
    const target = { kind: "post", id: p.id };
    for (const body of [{ target, action: "hide" }, {}, { target: "nope", action: "x" }]) {
      const r = await w.call("other", "POST", "/api/moderation", { body });
      expect([r.status, r.body.error]).toEqual([403, "forbidden"]);
    }
    expect((await w.call("other", "GET", "/api/moderation")).status).toBe(403);
    expect((await w.call("author", "GET", "/api/moderation")).status).toBe(403);
    const bad = async (body) => {
      const r = await w.call("admin", "POST", "/api/moderation", { body });
      expect([r.status, r.body.error]).toEqual([400, "validation"]);
    };
    await bad({ action: "hide" });
    await bad({ target: "x", action: "hide" });
    await bad({ target, action: "burn" });
    await bad({ target: { kind: "post", id: "not-an-id" }, action: "hide" });
    await bad({ target: { kind: "comment", id: p.id, thread: "nope" }, action: "hide" });
    await bad({ target: { kind: "photo", parent: { kind: "post", id: p.id } }, action: "hide" });
    await bad({ target: { kind: "banana" }, action: "hide" });
    await bad({ target, action: "hide", reason: "x".repeat(201) });
    await bad({ target, action: "hide", reason: 5 });
    await bad({ target, action: "hide", version: 5 });
    expect((await w.call("admin", "GET", "/api/moderation", { query: { state: "weird" } })).status).toBe(400);
    expect((await w.call("admin", "GET", "/api/moderation", { query: { limit: "0" } })).status).toBe(400);
    expect((await w.call("admin", "GET", "/api/moderation", { query: { cursor: "AAAA" } })).body.error).toBe("cursor_invalid");
    expect(w.postRows(p.id)[0].post.moderation).toBeUndefined();
  });

  it("answer 400 self_moderation on your own post and comment, 404 for an unknown item, 409 for a stale version, 422 for the targets that wait", async () => {
    const w = await world();
    const mine = await w.post({}, "admin");
    const r = await w.hide("admin", { kind: "post", id: mine.id });
    expect([r.status, r.body.error]).toEqual([400, "self_moderation"]);
    const myComment = await w.comment(THREAD, "an admin's own", "admin");
    expect((await w.hide("admin", { kind: "comment", id: myComment.id, thread: THREAD })).body.error).toBe("self_moderation");
    expect(w.mod(`post:${mine.id}`)).toBeUndefined();

    const p = await w.post();
    const c = await w.comment(THREAD);
    expect((await w.hide("admin", { kind: "post", id: "01J00000000000000000000000" })).status).toBe(404);
    expect((await w.hide("admin", { kind: "comment", id: "01J00000000000000000000000", thread: THREAD })).status).toBe(404);
    expect((await w.hide("admin", { kind: "comment", id: c.id, thread: "person:I0777" })).status).toBe(404);
    expect((await w.hide("admin", { kind: "photo", parent: { kind: "post", id: p.id }, attachment: "01J00000000000000000000000" })).status).toBe(404);

    const stale = await w.hide("admin", { kind: "post", id: p.id }, { version: "2020-01-01T00:00:00.000Z" });
    expect([stale.status, stale.body.error]).toEqual([409, "conflict"]);
    const staleC = await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD }, { version: "2020-01-01T00:00:00.000Z" });
    expect([staleC.status, staleC.body.error]).toEqual([409, "conflict"]);
    expect(w.postRows(p.id)[0].post.moderation).toBeUndefined();
    expect(w.mod(`post:${p.id}`)).toBeUndefined();

    for (const kind of ["note", "mediaref", "media"]) {
      const t = await w.call("admin", "POST", "/api/moderation", { body: { target: { kind, id: "h1" }, action: "hide" } });
      expect([t.status, t.body.error]).toEqual([422, "unsupported_target"]);
    }
    expect(w.rows("MOD#")).toHaveLength(0);
  });
});

describe("hide and unhide a post: one transaction", () => {
  it("writes the main, IDX#AUTHOR and IDX#SUBJECT copies, the MOD# item, the audit entry with the private reason and the event's hide together", async () => {
    const w = await world();
    const p = await w.post({ subject: "person:I0042", title: "A title" });
    expect(w.postRows(p.id)).toHaveLength(3);
    const before = w.events();
    expect(before).toHaveLength(1);
    expect(before[0].hidden).toBeUndefined();
    const key = `post:${p.id}`;

    const r = await w.hide("admin", { kind: "post", id: p.id }, { reason: "private: off topic", version: p.updated_at });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.target).toEqual({ kind: "post", id: p.id });
    expect(r.body.moderation).toMatchObject({ state: "hidden", hidden: true, by: { id: ADMIN }, open: true });
    expect(r.body.item).toMatchObject({ id: p.id, moderation: { hidden: true }, can: { moderate: true } });
    expect(JSON.stringify(r.body)).not.toContain("off topic"); // the reason never leaves the audit trail

    // every copy of the post
    const copies = w.postRows(p.id);
    expect(copies.map((c) => c.SK)).toEqual(["META", "IDX#AUTHOR", "IDX#SUBJECT"]);
    for (const c of copies) {
      expect(c.post.moderation).toMatchObject({ state: "hidden", hidden: true, open: true, by: { id: ADMIN } });
      expect(c.post.updated_at).toBe(copies[0].post.updated_at);
      expect(c.post.updated_at > p.updated_at).toBe(true);
    }
    // the MOD# item
    expect(w.mod(key)).toMatchObject({
      PK: `MOD#${key}`, SK: "META", GSI1PK: "MODQ#open", entity: "mod", target: { kind: "post", id: p.id }, author_id: AUTHOR, author: { id: AUTHOR },
      state: "hidden", hidden: true, open: true, version: 1, by: { id: ADMIN },
    });
    expect(w.mod(key).GSI1SK).toBe(`${copies[0].post.moderation.at}#${key}`);
    expect(JSON.stringify(w.mod(key))).not.toContain("off topic");
    // the audit entry
    const audit = w.rows(`AUDIT#${p.id}`).filter((a) => a.op === "moderate");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principal: ADMIN, reason: "private: off topic", before: { id: p.id }, after: { id: p.id, moderation: { hidden: true } } });
    expect(audit[0].before.moderation).toBeUndefined();
    expect(JSON.stringify([audit[0].before, audit[0].after])).not.toContain("off topic");
    // the contribution event leaves the feed, its count stays
    expect(w.events()[0].hidden).toBe(true);
    expect(w.row("CSTAT#site", "TOTAL").n).toBe(1);

    // unhide: every copy clean, MOD# closed, a second audit entry, the event back
    const u = await w.unhide("admin", { kind: "post", id: p.id }, { reason: "fine after all" });
    expect(u.status).toBe(200);
    expect(u.body.moderation).toBeNull();
    for (const c of w.postRows(p.id)) expect(c.post.moderation).toBeUndefined();
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#closed", open: false, hidden: false, resolved_by: ADMIN, version: 2 });
    expect(w.mod(key).resolved_at).toEqual(expect.any(String));
    expect(w.rows(`AUDIT#${p.id}`).filter((a) => a.op === "moderate").map((a) => a.reason).sort()).toEqual(["fine after all", "private: off topic"]);
    expect(w.events()[0].hidden).toBe(false);

    // hiding again reopens the same MOD# item
    await w.hide("admin", { kind: "post", id: p.id });
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#open", open: true, hidden: true, version: 3 });
    expect(w.mod(key).resolved_by).toBeUndefined();
  });

  it("changes nothing when the write fails: the copies, MOD#, audit and event stay as they were", async () => {
    const w = await world();
    const p = await w.post({ subject: "person:I0042" });
    const snapshot = JSON.stringify(w.api.ddb.all());
    for (const code of ["ConditionalCheckFailed", "ThrottlingError"]) {
      w.api.ddb.failNext(code);
      const r = await w.hide("admin", { kind: "post", id: p.id });
      expect(r.status).toBeGreaterThanOrEqual(409);
    }
    expect(JSON.stringify(w.api.ddb.all())).toBe(snapshot);
    // a post edited by its author between the admin's read and write: the version guard cancels the moderation (409), nothing half-written
    let racing = true;
    const rw = await world({
      intercept: async (cmd) => {
        if (racing && cmd.constructor.name === "TransactWriteCommand" && JSON.stringify(cmd.input).includes('"op":"moderate"')) {
          racing = false;
          const r = await rw.call("author", "PATCH", `/api/posts/${rp.id}`, { body: { body: "edited meanwhile" } });
          expect(r.status).toBe(200);
        }
      },
    });
    const rp = await rw.post({ subject: "person:I0042" });
    const lost = await rw.hide("admin", { kind: "post", id: rp.id });
    expect([lost.status, lost.body.error]).toEqual([409, "conflict"]);
    expect(rw.mod(`post:${rp.id}`)).toBeUndefined();
    for (const c of rw.postRows(rp.id)) expect(c.post.moderation).toBeUndefined();
    expect(rw.rows(`AUDIT#${rp.id}`).filter((a) => a.op === "moderate")).toHaveLength(0);
  });

  it("repeating a hide, or unhiding what is not hidden, writes nothing and tells nobody", async () => {
    const w = await world();
    const p = await w.post();
    const t = { kind: "post", id: p.id };
    expect((await w.unhide("admin", t)).body.moderation).toBeNull();
    expect(w.rows("MOD#")).toHaveLength(0);
    await w.hide("admin", t);
    const state = JSON.stringify(w.api.ddb.all());
    const again = await w.hide("admin", t);
    expect(again.status).toBe(200);
    expect(JSON.stringify(w.api.ddb.all())).toBe(state);
    expect((await w.inbox.list(AUTHOR)).items).toHaveLength(1);
  });

  it("keeps a hide when the author edits (a plain hide waits for a moderator), and an author delete closes the MOD# item", async () => {
    const w = await world();
    const p = await w.post();
    await w.hide("admin", { kind: "post", id: p.id });
    const edited = await w.call("author", "PATCH", `/api/posts/${p.id}`, { body: { body: "tidied" } });
    expect(edited.body.moderation).toMatchObject({ state: "hidden", hidden: true });
    expect(w.mod(`post:${p.id}`).open).toBe(true);
    expect(w.events()[0].hidden).toBe(true);
    expect((await w.call("author", "DELETE", `/api/posts/${p.id}`)).status).toBe(204);
    expect(w.mod(`post:${p.id}`)).toMatchObject({ GSI1PK: "MODQ#closed", open: false, resolved_by: "author" });
    expect(w.events()).toHaveLength(0);
    expect(w.postRows(p.id)).toHaveLength(0);
  });

  it("a moderator's delete of a hidden post also closes it, and a withdrawn then republished hidden post stays out of the feed", async () => {
    const w = await world();
    const p = await w.post();
    await w.hide("admin", { kind: "post", id: p.id });
    expect((await w.call("author", "POST", `/api/posts/${p.id}/visibility`, { body: { visibility: "withdrawn" } })).status).toBe(200);
    expect((await w.call("author", "POST", `/api/posts/${p.id}/visibility`, { body: { visibility: "published" } })).status).toBe(200);
    expect(w.events()[0].hidden).toBe(true); // republished, but still hidden by moderation
    await w.unhide("admin", { kind: "post", id: p.id });
    expect(w.events()[0].hidden).toBe(false);
    await w.hide("admin", { kind: "post", id: p.id });
    expect((await w.call("admin", "DELETE", `/api/posts/${p.id}`)).status).toBe(204);
    expect(w.mod(`post:${p.id}`)).toMatchObject({ open: false, resolved_by: ADMIN });
  });
});

describe("the visibility matrix: author, admin and other viewer, hidden and not hidden", () => {
  const VIEWERS = ["author", "admin", "other"];

  it("posts.get, posts.list, lists by author and by subject, attachment stripping", async () => {
    const w = await world();
    const subject = "person:I0042";
    const shown = await w.post({ subject, body: "stays visible" });
    const gone = await w.post({ subject, body: "gets hidden", attachments: [await w.photo()] });
    const photoed = await w.post({ subject, body: "has two photos", attachments: [await w.photo(), await w.photo()] });
    await w.hide("admin", { kind: "post", id: gone.id });
    const first = postAttachmentId(photoed.attachments[0]);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await w.hide("admin", { kind: "photo", parent: { kind: "post", id: photoed.id }, attachment: first })).status).toBe(200);

    const ids = (r) => r.body.items.map((i) => i.id);
    for (const who of VIEWERS) {
      const privileged = who !== "other";
      const get = await w.call(who, "GET", `/api/posts/${gone.id}`);
      expect(get.status, who).toBe(privileged ? 200 : 404);
      if (privileged) expect(get.body.moderation).toMatchObject({ hidden: true });
      expect((await w.call(who, "GET", `/api/posts/${shown.id}`)).status).toBe(200);
      for (const query of [{}, { author: AUTHOR }, { subject }]) {
        const list = await w.call(who, "GET", "/api/posts", { query });
        expect(ids(list), `${who} ${JSON.stringify(query)}`).toEqual(privileged ? [photoed.id, gone.id, shown.id] : [photoed.id, shown.id]);
      }
      // attachment stripping: another viewer gets the post without the hidden photo (and without any moderation field)
      const view = (await w.call(who, "GET", `/api/posts/${photoed.id}`)).body;
      expect(view.attachments, who).toHaveLength(privileged ? 2 : 1);
      expect(view.moderation).toBeUndefined();
      if (privileged) expect(view.attachments[0].moderation).toMatchObject({ hidden: true, by: { id: ADMIN } });
      else expect(JSON.stringify(view)).not.toContain(first);
      expect(view.can.moderate).toBe(who === "admin");
    }
    // a page is filled to its limit with visible posts (the listing reads on past the hidden one)
    const page = await w.call("other", "GET", "/api/posts", { query: { limit: "2" } });
    expect(ids(page)).toEqual([photoed.id, shown.id]);
  });

  it("a photo-only post whose only photo is hidden disappears for other viewers and comes back on unhide", async () => {
    const w = await world();
    const p = await w.post({ body: "", attachments: [await w.photo()] });
    const id = postAttachmentId(p.attachments[0]);
    await w.hide("admin", { kind: "photo", parent: { kind: "post", id: p.id }, attachment: id });
    expect((await w.call("other", "GET", `/api/posts/${p.id}`)).status).toBe(404);
    expect((await w.call("author", "GET", `/api/posts/${p.id}`)).body.attachments).toHaveLength(1);
    expect(w.events()[0].hidden).toBe(true); // its contribution leaves the feed with it
    await w.unhide("admin", { kind: "photo", parent: { kind: "post", id: p.id }, attachment: id });
    expect((await w.call("other", "GET", `/api/posts/${p.id}`)).status).toBe(200);
    expect(w.events()[0].hidden).toBe(false);
  });

  it("a photo hide has its own MOD# item, survives the author's resubmit of the photo, and closes when the author removes the photo", async () => {
    const w = await world();
    const a = await w.photo();
    const b = await w.photo();
    const p = await w.post({ body: "two photos", attachments: [a, b] });
    const aid = postAttachmentId(p.attachments[0]);
    const key = `photo:post:${p.id}#${aid}`;
    const r = await w.hide("admin", { kind: "photo", parent: { kind: "post", id: p.id }, attachment: aid }, { reason: "private" });
    expect(r.body.moderation).toMatchObject({ hidden: true, by: { id: ADMIN } });
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#open", state: "hidden", target: { kind: "photo", attachment: aid } });
    expect(w.rows(`AUDIT#${p.id}`).find((x) => x.op === "moderate").reason).toBe("private");
    // the author resubmits both photos (and forges a flag on the hidden one): it stays hidden
    const resubmit = await w.call("author", "PATCH", `/api/posts/${p.id}`, { body: { attachments: [{ ...a, moderation: undefined, alt: "described" }, b] } });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect(resubmit.body.attachments[0].moderation).toMatchObject({ hidden: true });
    expect((await w.call("other", "GET", `/api/posts/${p.id}`)).body.attachments).toHaveLength(1);
    // the author drops the hidden photo: its MOD# closes in that edit
    const drop = await w.call("author", "PATCH", `/api/posts/${p.id}`, { body: { attachments: [b] } });
    expect(drop.status).toBe(200);
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#closed", open: false, resolved_by: "author" });
  });

  it("comments.list (a person thread and a post thread), reads on to fill the page, and a hidden comment answers not_found to other viewers", async () => {
    const w = await world();
    const c1 = await w.comment(THREAD, "first");
    const c2 = await w.comment(THREAD, "second");
    const c3 = await w.comment(THREAD, "third");
    const c4 = await w.comment(THREAD, "fourth");
    for (const c of [c2, c3]) expect((await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD })).status).toBe(200);
    const bodies = (r) => r.body.thread.comments.map((c) => c.body);
    for (const who of VIEWERS) {
      const privileged = who !== "other";
      const list = await w.call(who, "GET", "/api/comments", { query: { subject: THREAD } });
      expect(bodies(list), who).toEqual(privileged ? ["first", "second", "third", "fourth"] : ["first", "fourth"]);
      const hidden = list.body.thread.comments.find((c) => c.id === c2.id);
      if (privileged) expect(hidden.moderation).toMatchObject({ state: "hidden", hidden: true, by: { id: ADMIN } });
      expect(list.body.thread.comments.every((c) => (privileged ? true : c.moderation === undefined))).toBe(true);
      expect(JSON.stringify(list.body)).not.toContain("mod_v");
      // limit fills with visible comments in both orders, and the cursor walks on without a repeat or a gap
      for (const order of ["asc", "desc"]) {
        const seen = [];
        let cursor;
        for (let i = 0; i < 6; i += 1) {
          const page = await w.call(who, "GET", "/api/comments", { query: { subject: THREAD, limit: "2", order, ...(cursor ? { cursor } : {}) } });
          seen.push(...bodies(page));
          cursor = page.body.cursor;
          if (!cursor) break;
        }
        const all = privileged ? ["first", "second", "third", "fourth"] : ["first", "fourth"];
        expect(seen, `${who} ${order}`).toEqual(order === "asc" ? all : [...all].reverse());
      }
    }
    // a page of 1 for another viewer reads past the two hidden comments in the middle
    const first = await w.call("other", "GET", "/api/comments", { query: { subject: THREAD, limit: "1" } });
    expect(bodies(first)).toEqual(["first"]);
    const second = await w.call("other", "GET", "/api/comments", { query: { subject: THREAD, limit: "1", cursor: first.body.cursor } });
    expect(bodies(second)).toEqual(["fourth"]);
    expect(second.body.cursor).toBeUndefined();

    // edit, react, delete, reply and moderate on a hidden comment: not_found for another viewer
    expect((await w.call("other", "POST", `/api/comments/${c2.id}/react`, { body: { subject: THREAD, emoji: "👍" } })).status).toBe(404);
    expect((await w.call("other", "DELETE", `/api/comments/${c2.id}`, { query: { subject: THREAD } })).status).toBe(404);
    expect((await w.call("other", "PATCH", `/api/comments/${c2.id}`, { body: { subject: THREAD, body: "x" } })).status).toBe(404);
    expect((await w.call("other", "POST", "/api/comments", { body: { subject: THREAD, body: "reply", parentId: c2.id } })).status).toBe(404);
    expect((await w.call("admin", "POST", `/api/comments/${c2.id}/react`, { body: { subject: THREAD, emoji: "👍" } })).status).toBe(200);
    expect((await w.call("author", "PATCH", `/api/comments/${c2.id}`, { body: { subject: THREAD, body: "second, edited" } })).status).toBe(200);
    // the author's edit leaves a plain hide in place
    expect(bodies(await w.call("other", "GET", "/api/comments", { query: { subject: THREAD } }))).toEqual(["first", "fourth"]);
    expect(c1.id < c4.id).toBe(true);
  });

  it("a hidden post hides its whole thread from other viewers, exactly as a withdrawn one does", async () => {
    const w = await world();
    const p = await w.post();
    await w.comment(`post:${p.id}`, "under the post");
    const subject = `post:${p.id}`;
    expect((await w.call("other", "GET", "/api/comments", { query: { subject } })).body.thread.comments).toHaveLength(1);
    await w.hide("admin", { kind: "post", id: p.id });
    expect((await w.call("other", "GET", "/api/comments", { query: { subject } })).status).toBe(404);
    expect((await w.call("other", "POST", "/api/comments", { body: { subject, body: "hi" } })).status).toBe(404);
    for (const who of ["author", "admin"]) expect((await w.call(who, "GET", "/api/comments", { query: { subject } })).body.thread.comments).toHaveLength(1);
    await w.unhide("admin", { kind: "post", id: p.id });
    expect((await w.call("other", "GET", "/api/comments", { query: { subject } })).status).toBe(200);
  });

  it("contributions.list: a hidden post's and a hidden comment's events are seen only by the author and admins", async () => {
    const w = await world();
    const p = await w.post({ body: "a post" });
    const c = await w.comment(THREAD, "a comment");
    const kinds = async (who) => (await w.call(who, "GET", "/api/contributions", { query: { author: AUTHOR } })).body.items.map((i) => i.kind).sort();
    for (const who of VIEWERS) expect(await kinds(who)).toEqual(["comment", "post"]);
    await w.hide("admin", { kind: "post", id: p.id });
    await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD });
    expect(w.events().map((e) => e.hidden)).toEqual([true, true]);
    expect(await kinds("author")).toEqual(["comment", "post"]);
    expect(await kinds("admin")).toEqual(["comment", "post"]);
    expect(await kinds("other")).toEqual([]);
    await w.unhide("admin", { kind: "comment", id: c.id, thread: THREAD });
    expect(await kinds("other")).toEqual(["comment"]); // the comment's event is back; the post's stays out of the feed
  });

  it("the archive tier of On this day (GET /api/onthisday, surf-onthisday-api) filters its candidates through archiveView", () => {
    const post = (extra = {}) => ({ id: "01J00000000000000000000001", author: { id: AUTHOR, label: "Ann" }, visibility: "published", body: "x", title: "", attachments: [], ...extra });
    const view = (p, v) => archiveView(p, v);
    const author = { id: AUTHOR }, admin = { id: ADMIN, admin: true }, other = { id: OTHER };
    const hidden = post({ moderation: { state: "hidden", hidden: true, by: { id: ADMIN }, at: "2026-01-01T00:00:00.000Z", open: true } });
    expect(view(hidden, other)).toBeNull();
    expect(view(hidden, null)).toBeNull();
    expect(view(hidden, author)).toBe(hidden);
    expect(view(hidden, admin)).toBe(hidden);
    const asked = post({ moderation: { state: "question", hidden: false, by: { id: ADMIN }, at: "2026-01-01T00:00:00.000Z", note: "private note", open: true } });
    expect(view(asked, other).moderation).toBeUndefined();
    expect(view(asked, author).moderation.note).toBe("private note");
    const photos = post({ attachments: [{ kind: "image", url: "/a", mime: "image/png", moderation: { hidden: true } }, { kind: "image", url: "/b", mime: "image/png" }] });
    expect(view(photos, other).attachments.map((a) => a.url)).toEqual(["/b"]);
    expect(view(photos, admin).attachments).toHaveLength(2);
    expect(view(post({ visibility: "withdrawn" }), other)).toBeNull();
    // the one rule, as the design writes it
    expect(moderationVisible(hidden, other)).toBe(false);
    expect(moderationVisible(hidden, author)).toBe(true);
    expect(moderationVisible(hidden, admin)).toBe(true);
    expect(moderationVisible(hidden, { id: "I9", roles: ["admin"] })).toBe(true);
    expect(moderationVisible(asked, other)).toBe(true);
    expect(moderationVisible(post(), null)).toBe(true);
  });
});

describe("comments and comment photos", () => {
  it("hide and unhide a comment: inline state, MOD#, audit with the private reason and the event's hide in one transaction", async () => {
    const w = await world();
    const c = await w.comment(THREAD, "a hide candidate");
    const key = `comment:${THREAD}/${c.id}`;
    const r = await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD }, { reason: "private", version: c.created_at });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ state: "hidden", hidden: true, by: { id: ADMIN } });
    expect(r.body.item).toMatchObject({ id: c.id, can: { moderate: true } });
    const stored = w.row(`THREAD#${THREAD}`, `C#${c.id}`);
    expect(stored.comment.moderation).toMatchObject({ state: "hidden", hidden: true, open: true });
    expect(stored.comment.mod_v).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain("mod_v");
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#open", author_id: AUTHOR, state: "hidden", hidden: true, version: 1, target: { kind: "comment", id: c.id, thread: THREAD } });
    const audit = w.rows(`AUDIT#${c.id}`).filter((a) => a.op === "moderate");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principal: ADMIN, reason: "private" });
    expect(audit[0].before.moderation).toBeUndefined();
    expect(audit[0].after.moderation.hidden).toBe(true);
    expect(w.events().find((e) => e.kind === "comment").hidden).toBe(true);

    const u = await w.unhide("admin", { kind: "comment", id: c.id, thread: THREAD });
    expect(u.body.moderation).toBeNull();
    expect(w.row(`THREAD#${THREAD}`, `C#${c.id}`).comment.moderation).toBeUndefined();
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#closed", open: false, resolved_by: ADMIN, version: 2 });
    expect(w.events().find((e) => e.kind === "comment").hidden).toBe(false);
    // the author's delete of a hidden comment closes the item
    await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD });
    expect((await w.call("author", "DELETE", `/api/comments/${c.id}`, { query: { subject: THREAD } })).status).toBe(204);
    expect(w.mod(key)).toMatchObject({ open: false, resolved_by: "author" });
    expect(w.events().filter((e) => e.kind === "comment")).toHaveLength(0);
  });

  it("two admins hiding at once: the second write is cancelled (409), nothing is half-written", async () => {
    let racing = false;
    const w = await world({
      admins: [ADMIN, "I0098"],
      intercept: async (cmd) => {
        if (racing && cmd.constructor.name === "TransactWriteCommand" && JSON.stringify(cmd.input).includes('"op":"moderate"')) {
          racing = false;
          expect((await w.call("admin2", "POST", "/api/moderation", { body: { target, action: "hide" } })).status).toBe(200);
        }
      },
    });
    const c = await w.comment(THREAD, "contended");
    const target = { kind: "comment", id: c.id, thread: THREAD };
    racing = true;
    const lost = await w.hide("admin", target);
    expect([lost.status, lost.body.error]).toEqual([409, "conflict"]);
    const key = `comment:${THREAD}/${c.id}`;
    expect(w.mod(key)).toMatchObject({ by: { id: "I0098" }, version: 1 });
    expect(w.row(`THREAD#${THREAD}`, `C#${c.id}`).comment).toMatchObject({ moderation: { by: { id: "I0098" } }, mod_v: 1 });
    expect(w.rows(`AUDIT#${c.id}`).filter((a) => a.op === "moderate")).toHaveLength(1);
  });

  it("hides and unhides one comment photo; an author's edit keeps the hide; removing the photo closes it; a photo-only comment disappears with its last photo", async () => {
    const w = await world();
    const c = await w.photoComment(THREAD, "with a photo");
    const aid = c.attachments[0].id;
    const parent = { kind: "comment", id: c.id, thread: THREAD };
    const key = `photo:comment:${THREAD}/${c.id}#${aid}`;
    const r = await w.hide("admin", { kind: "photo", parent, attachment: aid }, { reason: "private" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.moderation).toMatchObject({ hidden: true, by: { id: ADMIN } });
    expect(w.mod(key)).toMatchObject({ GSI1PK: "MODQ#open", state: "hidden", target: { kind: "photo", attachment: aid } });
    expect(w.rows(`AUDIT#${c.id}`).find((a) => a.op === "moderate").reason).toBe("private");
    const view = async (who) => (await w.call(who, "GET", "/api/comments", { query: { subject: THREAD } })).body.thread.comments[0];
    expect((await view("other")).attachments).toBeUndefined();
    expect((await view("other")).body).toBe("with a photo");
    expect((await view("author")).attachments[0].moderation.hidden).toBe(true);
    expect((await view("admin")).attachments[0].moderation.hidden).toBe(true);
    // the author edits the body and resubmits the photo: still hidden
    const edit = await w.call("author", "PATCH", `/api/comments/${c.id}`, { body: { subject: THREAD, body: "edited", attachments: [{ url: c.attachments[0].url, mime: "image/jpeg", alt: "now described" }] } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.attachments[0].moderation.hidden).toBe(true);
    expect((await view("other")).attachments).toBeUndefined();
    await w.unhide("admin", { kind: "photo", parent, attachment: aid });
    expect((await view("other")).attachments).toHaveLength(1);
    expect(w.mod(key)).toMatchObject({ open: false, resolved_by: ADMIN });
    // hide again and let the author remove the photo: the MOD# item closes in that edit
    await w.hide("admin", { kind: "photo", parent, attachment: aid });
    const drop = await w.call("author", "PATCH", `/api/comments/${c.id}`, { body: { subject: THREAD, body: "edited", attachments: [] } });
    expect(drop.status).toBe(200);
    expect(w.mod(key)).toMatchObject({ open: false, resolved_by: "author" });

    // a photo-only comment whose only photo is hidden is hidden from other viewers, and its event leaves the feed
    const only = await w.photoComment(THREAD, "");
    expect((await w.call("other", "GET", "/api/comments", { query: { subject: THREAD } })).body.thread.comments.some((x) => x.id === only.id)).toBe(true);
    await w.hide("admin", { kind: "photo", parent: { kind: "comment", id: only.id, thread: THREAD }, attachment: only.attachments[0].id });
    expect((await w.call("other", "GET", "/api/comments", { query: { subject: THREAD } })).body.thread.comments.some((x) => x.id === only.id)).toBe(false);
    expect((await w.call("author", "GET", "/api/comments", { query: { subject: THREAD } })).body.thread.comments.some((x) => x.id === only.id)).toBe(true);
    expect(commentHidden(w.row(`THREAD#${THREAD}`, `C#${only.id}`).comment)).toBe(true);
    expect(w.events().find((e) => e.ref.id === only.id).hidden).toBe(true);
  });

  it("deleting a post takes its thread: the MOD# items of the hidden comments close with it", async () => {
    const w = await world();
    const p = await w.post();
    const subject = `post:${p.id}`;
    const c = await w.comment(subject, "under the post");
    await w.hide("admin", { kind: "comment", id: c.id, thread: subject });
    expect(w.mod(`comment:${subject}/${c.id}`).open).toBe(true);
    expect((await w.call("author", "DELETE", `/api/posts/${p.id}`)).status).toBe(204);
    expect(w.mod(`comment:${subject}/${c.id}`)).toMatchObject({ open: false });
  });

  it("commentGuard also pins the moderation counter", () => {
    const g = commentGuard({ id: "x", edited_at: "t", mod_v: 2 });
    expect(g.condition).toContain("#doc.#mv = :mv");
    expect(g.values[":mv"]).toBe(2);
    expect(commentGuard({ id: "x" }).condition).toContain("attribute_not_exists(#doc.#mv)");
  });
});

describe("the queue and the notices", () => {
  it("lists open items newest first for admins only, closes them on unhide, pages by cursor and never shows the reason", async () => {
    const w = await world();
    const p1 = await w.post({ body: "one" });
    const c1 = await w.comment(THREAD, "two");
    const p2 = await w.post({ body: "three", attachments: [await w.photo()] });
    await w.hide("admin", { kind: "post", id: p1.id }, { reason: "private one" });
    await w.hide("admin", { kind: "comment", id: c1.id, thread: THREAD });
    await w.hide("admin", { kind: "photo", parent: { kind: "post", id: p2.id }, attachment: postAttachmentId(p2.attachments[0]) });

    const open = await w.call("admin", "GET", "/api/moderation", { query: { state: "open" } });
    expect(open.status).toBe(200);
    expect(open.body.items.map((i) => i.target.kind)).toEqual(["photo", "comment", "post"]);
    expect(open.body.items[0]).toMatchObject({ state: "hidden", hidden: true, open: true, by: { id: ADMIN }, author: { id: AUTHOR }, href: `/posts/?id=${p2.id}#photos` });
    expect(open.body.items[1].href).toBe(`/person/?id=I0042#comment-${c1.id}`);
    expect(open.body.items[2].href).toBe(`/posts/?id=${p1.id}`);
    expect(open.body.cursor).toBeNull();
    expect(JSON.stringify(open.body)).not.toContain("private one");
    expect((await w.call("admin", "GET", "/api/moderation")).body.items).toHaveLength(3); // open is the default

    const first = await w.call("admin", "GET", "/api/moderation", { query: { limit: "2" } });
    expect(first.body.items.map((i) => i.target.kind)).toEqual(["photo", "comment"]);
    const rest = await w.call("admin", "GET", "/api/moderation", { query: { limit: "2", cursor: first.body.cursor } });
    expect(rest.body.items.map((i) => i.target.kind)).toEqual(["post"]);
    expect(rest.body.cursor).toBeNull();

    expect((await w.call("admin", "GET", "/api/moderation", { query: { state: "closed" } })).body.items).toEqual([]);
    await w.unhide("admin", { kind: "post", id: p1.id });
    expect((await w.call("admin", "GET", "/api/moderation")).body.items.map((i) => i.target.kind)).toEqual(["photo", "comment"]);
    const closed = await w.call("admin", "GET", "/api/moderation", { query: { state: "closed" } });
    expect(closed.body.items).toHaveLength(1);
    expect(closed.body.items[0]).toMatchObject({ target: { kind: "post", id: p1.id }, open: false, hidden: false, resolved_by: ADMIN });
  });

  it("orders the closed queue by when each item was resolved, newest first, and pages through it by cursor", async () => {
    const w = await world();
    const a = await w.post({ body: "first opened" });
    const b = await w.post({ body: "second opened" });
    const c = await w.post({ body: "third opened" });
    const ta = { kind: "post", id: a.id };
    const tb = { kind: "post", id: b.id };
    const tc = { kind: "post", id: c.id };
    for (const t of [ta, tb, tc]) await w.hide("admin", t);
    // resolved in the order b, a, c: the opening order (a, b, c) must not decide the closed queue
    for (const t of [tb, ta, tc]) await w.unhide("admin", t);
    const ids = (r) => r.body.items.map((i) => i.target.id);
    const closed = await w.call("admin", "GET", "/api/moderation", { query: { state: "closed" } });
    expect(ids(closed)).toEqual([c.id, a.id, b.id]);
    expect(w.mod(`post:${a.id}`).GSI1SK).toBe(`${w.mod(`post:${a.id}`).resolved_at}#post:${a.id}`);
    const first = await w.call("admin", "GET", "/api/moderation", { query: { state: "closed", limit: "2" } });
    expect(ids(first)).toEqual([c.id, a.id]);
    const rest = await w.call("admin", "GET", "/api/moderation", { query: { state: "closed", limit: "2", cursor: first.body.cursor } });
    expect(ids(rest)).toEqual([b.id]);
    expect(rest.body.cursor).toBeNull();
  });

  it("sends no notice when the source reports no write (another admin changed the item between the read and the write)", async () => {
    const author = { id: AUTHOR, label: "Ann" };
    const sent = [];
    let writes = true;
    const post = { id: "01J00000000000000000000001", author, updated_at: "2026-01-01T00:00:00.000Z" };
    const content = {
      async get() { return post; },
      // a source that found the post already hidden by someone else: it returns that state and never calls onWrite
      async moderate(_id, _m, opts) {
        if (writes) opts.onWrite();
        return { ...post, moderation: { state: "hidden", hidden: true, by: { id: "I0098" }, at: "2026-01-02T00:00:00.000Z" } };
      },
    };
    const mod = createModeration({
      ddb: null, cmds: null, table: TABLE, actor: { id: ADMIN, label: "Admin", admin: true }, content, comments: {},
      notifier: { async onModeration(n) { sent.push(n); } },
    });
    await mod.post({ target: { kind: "post", id: post.id }, action: "hide" });
    expect(sent).toHaveLength(1);
    writes = false;
    const r = await mod.post({ target: { kind: "post", id: post.id }, action: "hide" });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("the author gets moderation_hidden and moderation_unhidden in the inbox, once per change, and the admin gets nothing", async () => {
    const w = await world();
    const p = await w.post({ subject: "person:I0042" });
    const c = await w.comment(THREAD, "a comment");
    await w.hide("admin", { kind: "post", id: p.id });
    let items = (await w.inbox.list(AUTHOR)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "moderation_hidden", navigate: `/posts/?id=${p.id}`, fields: { actor: ADMIN, item: "story" } });
    expect(items[0].detail).toBeUndefined();
    await w.hide("admin", { kind: "post", id: p.id }); // no change, no notice
    await w.unhide("admin", { kind: "post", id: p.id });
    items = (await w.inbox.list(AUTHOR)).items;
    expect(items.map((i) => i.type).sort()).toEqual(["moderation_hidden", "moderation_unhidden"]);
    await w.hide("admin", { kind: "comment", id: c.id, thread: THREAD });
    items = (await w.inbox.list(AUTHOR)).items;
    expect(items.find((i) => i.fields?.item === "comment")).toMatchObject({ type: "moderation_hidden", navigate: `/person/?id=I0042#comment-${c.id}` });
    expect((await w.inbox.list(ADMIN)).items).toEqual([]);
    expect((await w.inbox.list(OTHER)).items).toEqual([]);
  });

  it("a failing notice never fails the committed write", async () => {
    const inbox = new InMemoryNotificationStore();
    inbox.add = async () => { throw new Error("store down"); };
    const w = await world({ inbox });
    const p = await w.post();
    const r = await w.hide("admin", { kind: "post", id: p.id });
    expect(r.status).toBe(200);
    expect(w.postRows(p.id)[0].post.moderation.hidden).toBe(true);
  });
});

describe("a post photo without an upload id", () => {
  it("is refused with a validation error instead of keying a MOD# item '#undefined', and writes nothing", async () => {
    const w = await world();
    const p = await w.post({ attachments: [await w.photo()] });
    for (const r of w.postRows(p.id)) r.post.attachments[0].url = "/uploads/posts/not-a-ulid/photo.jpg";
    expect(postAttachmentId(w.postRows(p.id)[0].post.attachments[0])).toBeUndefined();
    const src = createContentSource({ ddb: w.api.ddb, cmds, table: TABLE, actor: { id: ADMIN, label: "Admin", admin: true }, now: ticker(), uid: () => "x" });
    await expect(src.moderate(p.id, { action: "hide", attachment: 0 })).rejects.toMatchObject({ code: "validation", details: { field: "attachment" } });
    expect(w.rows("MOD#")).toHaveLength(0);
    expect(w.postRows(p.id)[0].post.attachments[0].moderation).toBeUndefined();
  });
});

describe("the pieces", () => {
  it("target keys follow the design and a record target is recognised", () => {
    expect(targetKey({ kind: "post", id: "P" })).toBe("post:P");
    expect(targetKey({ kind: "comment", id: "C", thread: "person:I1" })).toBe("comment:person:I1/C");
    expect(targetKey({ kind: "photo", parent: { kind: "post", id: "P" }, attachment: "A" })).toBe("photo:post:P#A");
    expect(targetKey({ kind: "photo", parent: { kind: "comment", id: "C", thread: "post:T" }, attachment: "A" })).toBe("photo:comment:post:T/C#A");
    expect(parseTarget({ kind: "note", id: "h" })).toEqual({ kind: "note" });
    expect(() => parseTarget({ kind: "post", id: "p" })).toThrow();
  });

  it("MOD# items: open and closed, versions move on", () => {
    const base = { target: { kind: "post", id: "01J00000000000000000000000" }, author: { id: AUTHOR, label: "Ann" }, state: "hidden", hidden: true, by: { id: ADMIN, label: "Admin" }, at: "2026-01-01T00:00:00.000Z" };
    const open = modItem(base);
    expect(open).toMatchObject({ GSI1PK: "MODQ#open", open: true, version: 1, author_id: AUTHOR });
    const closed = closedItem(open, { resolvedBy: ADMIN, at: "2026-01-02T00:00:00.000Z" });
    expect(closed).toMatchObject({ GSI1PK: "MODQ#closed", GSI1SK: "2026-01-02T00:00:00.000Z#post:01J00000000000000000000000", open: false, hidden: false, version: 2, resolved_by: ADMIN });
    expect(open.GSI1SK).toBe("2026-01-01T00:00:00.000Z#post:01J00000000000000000000000");
    expect(modItem({ ...base, prior: closed }).version).toBe(3);
  });
});
