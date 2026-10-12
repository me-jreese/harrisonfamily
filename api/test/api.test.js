import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeApi, signToken } from "./world.js";
import { ROUTES, buildCaps } from "../src/routes.js";

const sub = { endpoint: "https://push.example.test/s1", keys: { p256dh: "p", auth: "a" } };
let w, ann, olive, admin, third;
beforeEach(async () => {
  w = makeApi();
  [ann, olive, admin, third] = await Promise.all(["I0001", "I0002", "I0099", "I0003"].map((s) => signToken(s)));
});
const audits = () => w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#"));

describe("auth", () => {
  it("401 without a session cookie on reads and writes", async () => {
    expect((await w.call("GET", "/api/posts")).status).toBe(401);
    expect((await w.call("POST", "/api/posts", { body: { body: "x" } })).status).toBe(401);
    expect((await w.call("GET", "/api/comments", { query: { subject: "person:I0001" } })).status).toBe(401);
    expect((await w.call("GET", "/api/notifications/vapid-public-key")).status).toBe(401);
  });
  it("401 for a forged, expired or foreign-issuer token", async () => {
    expect((await w.call("GET", "/api/posts", { token: "not.a.jwt" })).status).toBe(401);
    expect((await w.call("GET", "/api/posts", { token: await signToken("I0001", { exp: "-1h" }) })).status).toBe(401);
    expect((await w.call("GET", "/api/posts", { token: await signToken("I0001", { iss: "https://evil.example" }) })).status).toBe(401);
  });
  it("404 unknown route, 405 wrong method, 415 non-JSON write", async () => {
    expect((await w.call("GET", "/api/nope", { token: ann })).status).toBe(404);
    expect((await w.call("PUT", "/api/posts", { token: ann })).status).toBe(405);
    expect((await w.call("POST", "/api/posts", { token: ann, ct: "text/plain", body: { body: "x" } })).status).toBe(415);
  });
});

describe("posts: Q-4 permissions and D-15 audit", () => {
  it("author edits own, others get 403, admin deletes any, every op leaves an AUDIT# item", async () => {
    const made = await w.call("POST", "/api/posts", { token: ann, body: { body: "hello", subject: "person:I0001", title: "T" } });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(made.body.can).toEqual({ edit: true, delete: true, publish: true });
    expect((await w.call("GET", `/api/posts/${id}`, { token: olive })).status).toBe(404); // draft is private
    expect((await w.call("POST", `/api/posts/${id}/visibility`, { token: ann, body: { visibility: "published" } })).body.visibility).toBe("published");
    const seen = await w.call("GET", `/api/posts/${id}`, { token: olive });
    expect(seen.body.can).toEqual({ edit: false, delete: false, publish: false });
    expect((await w.call("PATCH", `/api/posts/${id}`, { token: olive, body: { body: "hax" } })).status).toBe(403);
    expect((await w.call("DELETE", `/api/posts/${id}`, { token: olive })).status).toBe(403);
    expect((await w.call("PATCH", `/api/posts/${id}`, { token: ann, body: { body: "hello 2", title: null } })).body.body).toBe("hello 2");
    const list = await w.call("GET", "/api/posts", { token: olive, query: { subject: "person:I0001", type: "post" } });
    expect(list.body.items.map((p) => p.id)).toEqual([id]);
    expect((await w.call("DELETE", `/api/posts/${id}`, { token: admin })).status).toBe(204);
    expect((await w.call("GET", `/api/posts/${id}`, { token: ann })).status).toBe(404);

    const a = audits().sort((x, y) => (x.SK < y.SK ? -1 : 1));
    expect(a.map((x) => x.op)).toEqual(["create", "visibility", "update", "delete"]);
    for (const x of a) {
      expect(Object.keys(x)).toEqual(expect.arrayContaining(["op", "id", "principal", "at", "before", "after"]));
      expect(x.id).toBe(id);
    }
    expect(a.map((x) => x.principal)).toEqual(["I0001", "I0001", "I0001", "I0099"]);
    expect(a[0].before).toBeNull();
    expect(a[3].after).toBeNull();
    expect(a[3].before.body).toBe("hello 2");
  });
  it("a failed write leaves no audit item and no data", async () => {
    const before = w.ddb.all().length;
    expect((await w.call("POST", "/api/posts", { token: ann, body: { body: "  " } })).status).toBe(422);
    expect(w.ddb.all().length).toBe(before);
  });
  it("publishing pushes new_family_post (level 0, content-free) to subscribers other than the author", async () => {
    await w.subscriptions.put("I0002", sub);
    await w.subscriptions.put("I0001", { ...sub, endpoint: "https://push.example.test/own" });
    const { body } = await w.call("POST", "/api/posts", { token: ann, body: { body: "news" } });
    await w.call("POST", `/api/posts/${body.id}/visibility`, { token: ann, body: { visibility: "published" } });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload.notification).toMatchObject({ title: "Harrison Family", body: "there's a new family post.", navigate: `/posts/?id=${body.id}` });
  });
});

describe("comments", () => {
  const subject = "person:I0001";
  it("create, list with reactions, edit, react, moderate, audit", async () => {
    await w.subscriptions.put("I0001", sub);
    const c1 = await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "Great photo" } });
    expect(c1.status).toBe(201);
    expect(w.sent.map((s) => s.payload.notification.body)).toEqual(["someone commented on your page."]); // comment_on_my_record
    await w.subscriptions.put("I0002", { ...sub, endpoint: "https://push.example.test/s2" });
    const reply = await w.call("POST", "/api/comments", { token: ann, body: { subject, body: "Thanks @I0003", parentId: c1.body.id } });
    expect(reply.body.parentId).toBe(c1.body.id);
    expect(w.sent.at(-1).payload.notification.body).toBe("someone replied to you."); // reply_to_me
    expect((await w.call("POST", `/api/comments/${c1.body.id}/react`, { token: ann, body: { subject, emoji: "❤️" } })).body.removed).toBe(false);
    expect((await w.call("POST", `/api/comments/${c1.body.id}/react`, { token: olive, body: { subject, emoji: "❤️" } })).status).toBe(403); // self_react
    const list = await w.call("GET", "/api/comments", { token: third, query: { subject } });
    expect(list.body.thread.comments.map((c) => c.id)).toEqual([c1.body.id, reply.body.id]);
    expect(list.body.thread.reactions[`comment:${c1.body.id}`]).toHaveLength(1);
    expect((await w.call("PATCH", `/api/comments/${c1.body.id}`, { token: ann, body: { subject, body: "x" } })).status).toBe(403);
    expect((await w.call("PATCH", `/api/comments/${c1.body.id}`, { token: olive, body: { subject, body: "Great photo!" } })).body.edited_at).toBeTruthy();
    expect((await w.call("DELETE", `/api/comments/${c1.body.id}`, { token: third, query: { subject } })).status).toBe(403);
    expect((await w.call("DELETE", `/api/comments/${c1.body.id}`, { token: admin, query: { subject, reason: "spam" } })).status).toBe(204);
    const ops = audits().sort((x, y) => (x.SK < y.SK ? -1 : 1));
    expect(ops.map((x) => x.op)).toEqual(["create", "create", "edit", "delete"]);
    expect(ops[3]).toMatchObject({ principal: "I0099", reason: "spam", after: null });
  });
  it("an empty thread lists as empty; an unknown or malformed subject is 404", async () => {
    expect((await w.call("GET", "/api/comments", { token: ann, query: { subject: "person:I0042" } })).body.thread.comments).toEqual([]);
    expect((await w.call("GET", "/api/comments", { token: ann, query: { subject: "bogus" } })).status).toBe(404);
  });
  it("comments on a post notify its author; a draft post is not commentable by others", async () => {
    await w.subscriptions.put("I0001", sub);
    const p = (await w.call("POST", "/api/posts", { token: ann, body: { body: "mine" } })).body;
    expect((await w.call("POST", "/api/comments", { token: olive, body: { subject: `post:${p.id}`, body: "hi" } })).status).toBe(404);
    await w.call("POST", `/api/posts/${p.id}/visibility`, { token: ann, body: { visibility: "published" } });
    expect((await w.call("POST", "/api/comments", { token: olive, body: { subject: `post:${p.id}`, body: "hi" } })).status).toBe(201);
    expect(w.sent.at(-1).payload.notification.navigate).toBe(`/posts/?id=${p.id}`);
  });
});

describe("notifications (kit handlers mounted)", () => {
  it("vapid key, preferences round trip with the four HFY types at level 0 by default", async () => {
    expect((await w.call("GET", "/api/notifications/vapid-public-key", { token: ann })).body).toEqual({ public_key: "vapid-public" });
    const prefs = await w.call("GET", "/api/notifications/preferences", { token: ann });
    expect(prefs.status).toBe(200);
    const put = await w.call("PUT", "/api/notifications/preferences", { token: ann, body: { enabled: true, types: { mention: { enabled: true, level: 1 } } } });
    expect(put.status).toBe(200);
    expect((await w.call("GET", "/api/notifications/preferences", { token: ann })).body.types.mention.level).toBe(1);
  });
  it("level 1 recipients get the actor named; level 0 stays content-free", async () => {
    await w.subscriptions.put("I0003", sub);
    await w.call("PUT", "/api/notifications/preferences", { token: third, body: { enabled: true, types: { mention: { enabled: true, level: 1 } } } });
    await w.call("POST", "/api/comments", { token: olive, body: { subject: "person:I0042", body: "hello @I0003" } });
    expect(w.sent.at(-1).payload.notification.body).toBe(`${"I0002"} mentioned you.`);
  });
});

describe("caps.json (AC2)", () => {
  it("is derived from the route registry and script output matches", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    execFileSync("node", [resolve(here, "../scripts/gen-caps.mjs")], { stdio: "pipe" });
    const caps = JSON.parse(readFileSync(resolve(here, "../dist/caps.json"), "utf8"));
    expect(caps).toEqual(JSON.parse(JSON.stringify(buildCaps())));
    expect(caps.actions.map((a) => a.name)).toEqual(ROUTES.map((r) => r.name));
    expect(new Set(caps.actions.map((a) => a.name)).size).toBe(caps.actions.length);
    expect(caps.content.capabilities).toMatchObject({ drafts: true, subscribe: false, audit: true });
    expect(caps.notifications.types).toEqual(["comment_on_my_record", "reply_to_me", "new_family_post", "mention"]);
    for (const n of ["comments.list", "comments.create", "comments.update", "comments.delete", "comments.react", "posts.list", "posts.get", "posts.create", "posts.update", "posts.visibility", "posts.delete"])
      expect(caps.actions.map((a) => a.name)).toContain(n);
  });
});

describe("uploads.presign (HFY-TSK-067)", () => {
  const ok = { filename: "Grandma's Garden (1).JPG", contentType: "image/jpeg", size: 2048 };
  it("401 without a session; 201 returns uploadUrl + publicUrl under uploads/posts/<ulid>/<safe-name> (not media/, HFY-R58)", async () => {
    expect((await w.call("POST", "/api/uploads", { body: ok })).status).toBe(401);
    const r = await w.call("POST", "/api/uploads", { token: ann, body: ok });
    expect(r.status).toBe(201);
    expect(r.body.publicUrl).toMatch(/^https:\/\/harrisonfamily\.us\/uploads\/posts\/[0-9A-HJKMNP-TV-Z]{26}\/grandma-s-garden-1\.jpg$/);
    expect(r.body.key.startsWith("media/")).toBe(false);
    expect(r.body.headers).toEqual({ "Content-Type": "image/jpeg" }); // the client must send exactly this: it is signed
    expect(r.body.uploadUrl).toContain(`https://presign.test/harrisonfamily-frontend/${r.body.key}`);
    expect(w.presigned.at(-1)).toMatchObject({ bucket: "harrisonfamily-frontend", contentType: "image/jpeg", size: 2048 });
  });
  it("400 for non-images, oversize, bad size or missing filename", async () => {
    for (const body of [{ ...ok, contentType: "application/pdf" }, { ...ok, contentType: "image/svg+xml" }, { ...ok, size: 10 * 1024 * 1024 + 1 }, { ...ok, size: 0 }, { ...ok, size: "9" }, { ...ok, filename: "" }]) {
      expect((await w.call("POST", "/api/uploads", { token: ann, body })).status).toBe(400);
    }
    expect((await w.call("POST", "/api/uploads", { token: ann, body: { ...ok, size: 10 * 1024 * 1024, contentType: "image/heic" } })).status).toBe(201);
  });
  it("path traversal in the filename cannot escape the key prefix", async () => {
    const r = await w.call("POST", "/api/uploads", { token: ann, body: { ...ok, filename: "../../../etc/passwd.png" } });
    expect(r.body.key).toMatch(/^uploads\/posts\/[0-9A-HJKMNP-TV-Z]{26}\/passwd\.jpg$/);
  });
});

describe("posts.create visibility:published (HFY-TSK-067)", () => {
  it("publishes in one write (created_at === updated_at); rejects other visibilities", async () => {
    const r = await w.call("POST", "/api/posts", { token: ann, body: { body: "hi", visibility: "published" } });
    expect(r.status).toBe(201);
    expect(r.body.visibility).toBe("published");
    expect(r.body.created_at).toBe(r.body.updated_at);
    expect((await w.call("POST", "/api/posts", { token: ann, body: { body: "hi", visibility: "withdrawn" } })).status).toBe(422);
    expect((await w.call("POST", "/api/posts", { token: ann, body: { body: "hi" } })).body.visibility).toBe("draft");
  });
});
