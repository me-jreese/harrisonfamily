// HFY-TSK-252 (hfy-inbox-delivery-api): the @io-kit/notify 0.5.0 inbox store behind inboxV1, the three inbox routes, the TTL policy and the pin.
// Synthetic ids only (I0001 owner, I0002 commenter, I0007 uat).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoNotificationStore, InMemoryNotificationStore } from "@io-kit/notify/server";
import { createFakeDynamoDocClient } from "@io-kit/notify/testing";
import { makeApi, signToken } from "./world.js";
import { ROUTES, buildCaps } from "./../src/routes.js";
import { NOTIFY_TYPES, PUSH_ONLY_TYPES, TEMPLATE_REGISTRY } from "../src/notify.js";
import { POLICY_ROWS } from "../src/policy.js";
import { INBOX_TTL, createInboxStore } from "../src/index.js";

const OWNER = "I0001";
const OLIVE = "I0002";
const UAT = "I0007";
const sub = { endpoint: "https://push.example.test/s1", keys: { p256dh: "p", auth: "a" } };
const here = dirname(fileURLToPath(import.meta.url));

const comment = async (w, subject, body = "hello") =>
  w.call("POST", "/api/comments", { token: await signToken(OLIVE), body: { subject, body } });
const get = async (w, path, who = OWNER, opts = {}) => w.call("GET", path, { token: await signToken(who), ...opts });

describe("persist-first without VAPID_SECRET (AC2)", () => {
  it("flag on: a comment on person:<id> stores an inbox item for the owner, with no push configured", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ withPush: false, flags: { inboxV1: true }, inbox });
    expect((await comment(w, `person:${OWNER}`)).status).toBe(201);
    const page = await inbox.list(OWNER);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: "comment_on_my_record", navigate: `/person/?id=${OWNER}`, fields: { actor: OLIVE } });
    expect(w.sent).toEqual([]);
    expect((await inbox.list(OLIVE)).items).toEqual([]); // the actor is never notified
  });

  it("flag off: no inbox item is stored and no app_badge is sent (push still goes)", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ flags: { inboxV1: false }, inbox });
    await w.subscriptions.put(OWNER, sub);
    await comment(w, `person:${OWNER}`);
    expect((await inbox.list(OWNER)).items).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload.notification).not.toHaveProperty("app_badge");
  });

  it("flag on with push: stored first, and the push carries the unread count as app_badge", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ flags: { inboxV1: true }, inbox });
    await w.subscriptions.put(OWNER, sub);
    await comment(w, `person:${OWNER}`, "one");
    await comment(w, `person:${OWNER}`, "two");
    expect(w.sent.map((s) => s.payload.notification.app_badge)).toEqual([1, 2]);
    expect(await inbox.unreadCount(OWNER)).toBe(2);
  });

  it("an inbox store failure never fails the comment write, and the push still goes without app_badge", async () => {
    const inbox = new InMemoryNotificationStore();
    inbox.add = async () => { throw new Error("store down"); };
    const w = makeApi({ flags: { inboxV1: true }, inbox });
    await w.subscriptions.put(OWNER, sub);
    expect((await comment(w, `person:${OWNER}`)).status).toBe(201);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload.notification).not.toHaveProperty("app_badge");
  });

  it("new_family_post is push-only (inbox:false), and the registry whitelist is widened", () => {
    expect([...PUSH_ONLY_TYPES]).toEqual(["new_family_post"]);
    expect(TEMPLATE_REGISTRY.features.new_family_post.inbox).toBe(false);
    expect(TEMPLATE_REGISTRY.whitelist).toEqual(["actor", "subject", "item", "count"]);
  });

  it("publishing a post stores no inbox item for anyone", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ flags: { inboxV1: true }, inbox });
    await w.subscriptions.put(OWNER, sub);
    const r = await w.call("POST", "/api/posts", { token: await signToken(OLIVE), body: { type: "post", visibility: "published", title: "t", body: "b" } });
    expect(r.status).toBe(201);
    expect((await inbox.list(OWNER)).items).toEqual([]);
    expect(w.sent).toHaveLength(1); // the push still goes
  });
});

describe("inbox routes (AC3)", () => {
  const names = ["notifications.inbox.list", "notifications.inbox.count", "notifications.inbox.read"];

  it("ROUTES and caps list the three routes; each is gated on inboxV1", () => {
    for (const n of names) {
      expect(ROUTES.find((r) => r.name === n)?.gate, n).toEqual({ type: "feature", name: "inboxV1" });
      expect(buildCaps().actions.map((a) => a.name)).toContain(n);
    }
    const caps = Object.fromEntries(buildCaps().actions.map((a) => [a.name, a]));
    expect(caps["notifications.inbox.list"]).toMatchObject({ method: "GET", path: "/api/notifications/inbox" });
    expect(caps["notifications.inbox.count"]).toMatchObject({ method: "GET", path: "/api/notifications/inbox/unread-count" });
    expect(caps["notifications.inbox.read"]).toMatchObject({ method: "POST", path: "/api/notifications/inbox/read", write: true });
  });

  it("no POLICY_ROWS row and no MCP tool is added for them", () => {
    expect(POLICY_ROWS.filter((r) => String(r.route ?? r.name ?? JSON.stringify(r)).includes("inbox"))).toEqual([]);
    expect(ROUTES.filter((r) => names.includes(r.name) && r.mcp)).toEqual([]);
    expect(buildCaps().mcp.tools.map((t) => t.action).filter((a) => a.includes("inbox"))).toEqual([]);
  });

  it("dark while inboxV1 is off: 404 for a member, open to a uat caller", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ flags: { inboxV1: false }, uat: [UAT], inbox });
    for (const p of ["/api/notifications/inbox", "/api/notifications/inbox/unread-count"]) {
      expect((await get(w, p)).status, p).toBe(404);
      expect((await get(w, p, UAT)).status, p).toBe(200);
    }
    expect((await w.call("POST", "/api/notifications/inbox/read", { token: await signToken(OWNER), body: { all: true } })).status).toBe(404);
  });

  it("list, count and read round trip for the caller's own inbox only", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = makeApi({ withPush: false, flags: { inboxV1: true }, inbox });
    await comment(w, `person:${OWNER}`, "a");
    await comment(w, `person:${OWNER}`, "b");
    await comment(w, `person:${UAT}`, "c");

    expect((await get(w, "/api/notifications/inbox/unread-count")).body).toEqual({ unread: 2 });
    const list = await get(w, "/api/notifications/inbox");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({ type: "comment_on_my_record", read: false, title: "Harrison Family", body: `${OLIVE} commented on your page.`, navigate: `/person/?id=${OWNER}` });

    const read = await w.call("POST", "/api/notifications/inbox/read", { token: await signToken(OWNER), body: { ids: [list.body.items[0].id] } });
    expect(read.status).toBe(200);
    expect((await get(w, "/api/notifications/inbox/unread-count")).body).toEqual({ unread: 1 });
    expect((await get(w, "/api/notifications/inbox/unread-count", UAT)).body).toEqual({ unread: 1 }); // untouched by the owner's read

    const all = await w.call("POST", "/api/notifications/inbox/read", { token: await signToken(OWNER), body: { all: true } });
    expect(all.status).toBe(200);
    expect((await get(w, "/api/notifications/inbox/unread-count")).body).toEqual({ unread: 0 });
  });

  it("the list filter is validated: bogus is 400, unread and all are 200", async () => {
    const w = makeApi({ withPush: false, flags: { inboxV1: true }, inbox: new InMemoryNotificationStore() });
    expect((await get(w, "/api/notifications/inbox", OWNER, { query: { filter: "bogus" } })).status).toBe(400);
    expect((await get(w, "/api/notifications/inbox", OWNER, { query: { filter: "unread" } })).status).toBe(200);
    expect((await get(w, "/api/notifications/inbox", OWNER, { query: { filter: "all" } })).status).toBe(200);
  });

  it("a signed-out caller gets 401, and an empty read body 400", async () => {
    const w = makeApi({ flags: { inboxV1: true }, inbox: new InMemoryNotificationStore() });
    expect((await w.call("GET", "/api/notifications/inbox")).status).toBe(401);
    expect((await w.call("POST", "/api/notifications/inbox/read", { token: await signToken(OWNER), body: {} })).status).toBe(400);
  });

  it("with no inbox store wired the routes do not exist", async () => {
    const w = makeApi({ flags: { inboxV1: true } });
    expect((await get(w, "/api/notifications/inbox")).status).toBe(404);
  });

  it("the existing push routes keep working and are not gated", async () => {
    const w = makeApi({ flags: {}, inbox: new InMemoryNotificationStore() });
    expect((await get(w, "/api/notifications/preferences")).status).toBe(200);
    expect(NOTIFY_TYPES).toContain("new_family_post");
  });
});

describe("TTL policy (AC4)", () => {
  it("HFY configures no TTL while unread and 90 days from read", () => {
    expect(INBOX_TTL).toEqual({ unreadTtlDays: null, readTtlDays: 90 });
  });

  it("DynamoDB rows: an unread item and its unread copy carry no ttl; reading starts a 90-day ttl", async () => {
    const fake = createFakeDynamoDocClient();
    const store = createInboxStore(fake.client, fake.commands, "hfy-app");
    // The production store takes no clock, so the ttl arithmetic is checked against wall time with a tolerance.
    const { id } = await store.add(OWNER, { type: "comment_on_my_record", navigate: "/posts/?id=x", fields: { actor: "I0002" } });
    const rows = () => fake.items().filter((i) => String(i.PK).startsWith("INBOX#"));
    expect(rows().length).toBeGreaterThan(0);
    for (const r of rows().filter((x) => /^(N|U)#/.test(String(x.SK)))) expect(r, String(r.SK)).not.toHaveProperty("ttl");

    await store.markRead(OWNER, [id]);
    const after = rows().filter((x) => /^N#/.test(String(x.SK)));
    expect(after).toHaveLength(1);
    const ttl = Number(after[0].ttl);
    const expected = Date.now() / 1000 + 90 * 86400;
    expect(Math.abs(ttl - expected)).toBeLessThan(120);
    expect(rows().filter((x) => /^U#/.test(String(x.SK)))).toEqual([]); // the unread copy is gone
  });

  it("index.js builds a DynamoNotificationStore with that policy", () => {
    const fake = createFakeDynamoDocClient();
    expect(createInboxStore(fake.client, fake.commands, "hfy-app")).toBeInstanceOf(DynamoNotificationStore);
  });
});

describe("the exact kit pin (AC1)", () => {
  it("api/package.json pins @io-kit/notify 0.5.0 and the lockfile resolves it", () => {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(resolve(here, "../package-lock.json"), "utf8"));
    expect(pkg.dependencies["@io-kit/notify"]).toBe("0.5.0");
    expect(lock.packages[""].dependencies["@io-kit/notify"]).toBe("0.5.0");
    expect(lock.packages["node_modules/@io-kit/notify"].version).toBe("0.5.0");
  });
});
