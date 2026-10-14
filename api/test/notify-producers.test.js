// HFY-TSK-253 (hfy-notify-producers): every PLN-002 notification type in TEMPLATE_REGISTRY and the producers other domains call.
// Synthetic ids and labels only.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DynamoPreferencesStore, DynamoSubscriptionStore, InMemoryNotificationStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { DIGEST_OVER, NOTIFY_TYPES, PUSH_ONLY_TYPES, TEMPLATE_REGISTRY, createMemberSet, createNotifier, notifyContract, queryFollowers, safePath } from "../src/notify.js";

const here = dirname(fileURLToPath(import.meta.url));
const ADMINS = ["A1", "A2"];
const SUB = (n) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: "k", auth: "a" } });

async function setup({ members = [], follows = {}, admins = ADMINS, inbox = new InMemoryNotificationStore(), prefs = {}, subscribed = [] } = {}) {
  const sent = [];
  const ddb = createFakeDdb();
  const subscriptions = new DynamoSubscriptionStore(ddb, cmds, "t");
  const preferences = new DynamoPreferencesStore(ddb, cmds, "t");
  for (const p of subscribed) await subscriptions.put(p, SUB(p));
  for (const [p, v] of Object.entries(prefs)) await preferences.put(p, v);
  const notifier = createNotifier({
    inbox, featureOn: async () => true, getAdmins: async () => new Set(admins), listMembers: async () => new Set(members),
    followersOf: async (subject) => follows[subject] ?? [], preferences, subscriptions, log: { error() {} },
    webpush: { async sendNotification(s, payload) { sent.push({ to: s.endpoint.split("/").pop(), n: JSON.parse(payload).notification }); } },
    vapid: { subject: "mailto:t@example.test", publicKey: "p", privateKey: "x" },
  });
  return { notifier, inbox, sent };
}
const items = async (inbox, p) => (await inbox.list(p)).items;
const types = async (inbox, p) => (await items(inbox, p)).map((i) => i.type);

describe("TEMPLATE_REGISTRY contract", () => {
  const EXPECTED = [
    "comment_on_my_record", "reply_to_me", "new_family_post", "mention",
    "proposal_submitted", "proposal_accepted", "proposal_declined", "proposal_needs_changes", "proposal_stale",
    "record_updated_mine", "record_updated_followed", "records_updated_followed_digest",
    "moderation_hidden", "moderation_request", "moderation_question", "moderation_unhidden", "moderation_resolved",
    "photo_graduated", "chat_message",
  ];
  it("holds exactly the PLN-002 types, and the field whitelist is [actor, subject, item, count]", () => {
    expect(NOTIFY_TYPES).toEqual(EXPECTED);
    expect(TEMPLATE_REGISTRY.whitelist).toEqual(["actor", "subject", "item", "count"]);
    expect(notifyContract().whitelist).toEqual(["actor", "subject", "item", "count"]);
  });
  it("pins the inbox flags: only new_family_post and chat_message are push-only", () => {
    const flags = Object.fromEntries(Object.entries(notifyContract().types).map(([k, v]) => [k, v.inbox]));
    expect(Object.keys(flags).filter((k) => !flags[k])).toEqual(["new_family_post", "chat_message"]);
    expect([...PUSH_ONLY_TYPES]).toEqual(["new_family_post", "chat_message"]);
  });
  it("every template only names whitelisted fields and keeps the voice (lowercase, no 'record')", () => {
    const wl = new Set([...TEMPLATE_REGISTRY.whitelist]);
    for (const [k, t] of Object.entries(TEMPLATE_REGISTRY.features)) {
      expect(t.title, k).toBe("Harrison Family");
      for (const text of [t.level0, t.level1, t.many, t.inboxText].filter(Boolean)) {
        for (const m of text.matchAll(/\{(\w+)\}/g)) expect(wl.has(m[1]), `${k}: ${m[1]}`).toBe(true);
        expect(text, k).not.toMatch(/record/i);
      }
      expect(t.level0, k).not.toMatch(/\{/); // level 0 is content-free
    }
  });
  it("comment types group by thread:<t> and coalesce into one unread item with count", async () => {
    const { notifier, inbox } = await setup();
    const c = (body) => ({ threadId: "person:P1", body, author: { id: "P2", label: "Eve" } });
    await notifier.onComment(c("a"), {}, {});
    await notifier.onComment(c("b"), {}, {});
    const [only, ...rest] = await items(inbox, "P1");
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ type: "comment_on_my_record", group: "thread:person:P1", count: 2 });
  });
});

describe("proposal producers", () => {
  const proposal = { id: "prop1", subject: "person:P9", subjectLabel: "Pat", proposer: { id: "P2", label: "Eve" } };
  it("onProposalSubmitted: every admin except the proposer, grouped 'proposals', same-origin navigate", async () => {
    const { notifier, inbox } = await setup({ admins: ["A1", "A2", "P2"] });
    await notifier.onProposalSubmitted({ proposal, navigate: "/admin/proposals/?id=prop1" });
    expect(await types(inbox, "A1")).toEqual(["proposal_submitted"]);
    expect((await items(inbox, "A2"))[0]).toMatchObject({ group: "proposals", navigate: "/admin/proposals/?id=prop1", fields: { actor: "Eve", subject: "Pat" } });
    expect(await items(inbox, "P2")).toEqual([]);
  });
  it("onProposalSubmitted rejects an off-origin navigate and falls back to the review path", async () => {
    const { notifier, inbox } = await setup();
    await notifier.onProposalSubmitted({ proposal, navigate: "//evil.example.test/x" });
    expect((await items(inbox, "A1"))[0].navigate).toBe("/admin/proposals/");
    expect(safePath("https://evil.example.test")).toBe("/me/inbox/");
  });
  it("onProposalSubmitted without an admin source notifies nobody", async () => {
    const n = createNotifier({ inbox: new InMemoryNotificationStore(), featureOn: async () => true, log: { error() {} } });
    await expect(n.onProposalSubmitted({ proposal })).resolves.toBeUndefined();
  });
  it.each([
    ["accepted", "proposal_accepted", undefined],
    ["declined", "proposal_declined", "not a fit"],
    ["needs_changes", "proposal_needs_changes", "which Pat?"],
    ["stale", "proposal_stale", undefined],
  ])("onProposalDecided %s: the proposer only, not the deciding admin", async (decision, type, note) => {
    const { notifier, inbox } = await setup();
    await notifier.onProposalDecided({ proposal, decision, note: note ?? "ignored?", by: { id: "A1", label: "Ann" } });
    const [it0] = await items(inbox, "P2");
    expect(it0).toMatchObject({ type, navigate: "/person/?id=P9" });
    expect(it0.detail).toBe(decision === "declined" || decision === "needs_changes" ? note : undefined);
    expect(await items(inbox, "A1")).toEqual([]);
  });
  it("onProposalDecided skips an admin deciding their own proposal and an unknown decision", async () => {
    const { notifier, inbox } = await setup();
    await notifier.onProposalDecided({ proposal, decision: "accepted", by: { id: "P2", label: "Eve" } });
    await notifier.onProposalDecided({ proposal, decision: "bogus", by: { id: "A1" } });
    expect(await items(inbox, "P2")).toEqual([]);
  });
  it("the note never rides a push", async () => {
    const { notifier, sent } = await setup({ subscribed: ["P2"] });
    await notifier.onProposalDecided({ proposal, decision: "declined", note: "PRIVATE-NOTE", by: { id: "A1", label: "Ann" } });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("PRIVATE-NOTE");
  });
});

describe("onModeration and onGraduated", () => {
  const base = { item: "photo", target: "photo:X1", authorId: "P2", by: { id: "A1", label: "Ann" }, navigate: "/person/?id=P9#photos" };
  it.each([
    ["hidden", "moderation_hidden", "PRIVATE", undefined],
    ["request", "moderation_request", "please crop", "please crop"],
    ["question", "moderation_question", "who is this?", "who is this?"],
    ["unhidden", "moderation_unhidden", "x", undefined],
  ])("%s goes to the author with the right detail rule", async (kind, type, note, detail) => {
    const { notifier, inbox } = await setup();
    await notifier.onModeration({ ...base, kind, note });
    const [it0] = await items(inbox, "P2");
    expect(it0).toMatchObject({ type, fields: { actor: "Ann", item: "photo" }, navigate: "/person/?id=P9#photos" });
    expect(it0.detail).toBe(detail);
  });
  it("never notifies the acting admin, even on their own item", async () => {
    const { notifier, inbox } = await setup();
    await notifier.onModeration({ ...base, kind: "hidden", authorId: "A1" });
    expect(await items(inbox, "A1")).toEqual([]);
  });
  it("resolved goes to the admin who asked, grouped mod:<target>, and coalesces", async () => {
    const { notifier, inbox } = await setup();
    const r = { ...base, kind: "resolved", askedBy: "A1", by: { id: "P2", label: "Eve" } };
    await notifier.onModeration(r);
    await notifier.onModeration(r);
    const list = await items(inbox, "A1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "moderation_resolved", group: "mod:photo:X1", count: 2 });
    expect(await items(inbox, "P2")).toEqual([]);
  });
  it("an unknown kind or item name notifies nobody or drops the item field", async () => {
    const { notifier, inbox } = await setup();
    await notifier.onModeration({ ...base, kind: "weird" });
    expect(await items(inbox, "P2")).toEqual([]);
    await notifier.onModeration({ ...base, kind: "hidden", item: "<script>" });
    expect((await items(inbox, "P2"))[0].fields.item).toBeUndefined();
  });
  it("onGraduated: the photo's author, deep-link to #photos, not the actor", async () => {
    const { notifier, inbox } = await setup();
    await notifier.onGraduated({ photo: { authorId: "P2" }, subject: "person:P9", subjectLabel: "Pat", by: { id: "A1", label: "Ann" } });
    expect((await items(inbox, "P2"))[0]).toMatchObject({ type: "photo_graduated", navigate: "/person/?id=P9#photos", fields: { actor: "Ann", subject: "Pat" } });
    await notifier.onGraduated({ photo: { authorId: "A1" }, subject: "person:P9", by: { id: "A1" } });
    expect(await items(inbox, "A1")).toEqual([]);
    await notifier.onGraduated({ photo: { authorId: "P2" }, subject: "family:bad", by: { id: "A1" } }); // bad subject: no-op
  });
});

describe("onRecordChanged", () => {
  const ch = (id, over = {}) => ({ subject: `person:${id}`, actor: { id: "P2", label: "Eve" }, source: "self_edit", ...over });
  it("owner (a member) gets record_updated_mine unless they are the actor; a non-member owner gets nothing", async () => {
    const { notifier, inbox } = await setup({ members: ["P5"] });
    await notifier.onRecordChanged([ch("P5"), ch("P6")]);
    expect((await items(inbox, "P5"))[0]).toMatchObject({ type: "record_updated_mine", group: "rec:person:P5", navigate: "/person/?id=P5", fields: { actor: "Eve" } });
    expect(await items(inbox, "P6")).toEqual([]);
    await notifier.onRecordChanged([ch("P5", { actor: { id: "P5", label: "Me" } })]);
    expect((await items(inbox, "P5"))[0].count).toBe(1); // no second item, no coalesce bump
  });
  it("followers get record_updated_followed, never the actor, and the owner is not notified twice", async () => {
    const { notifier, inbox } = await setup({ members: ["P5"], follows: { "person:P5": ["F1", "P2", "P5"], "person:P6": ["F1", "F2"] } });
    await notifier.onRecordChanged([ch("P5"), ch("P6")]);
    expect(await types(inbox, "F1")).toEqual(expect.arrayContaining(["record_updated_followed"]));
    expect((await items(inbox, "F1"))).toHaveLength(2);
    expect(await types(inbox, "F2")).toEqual(["record_updated_followed"]);
    expect(await items(inbox, "P2")).toEqual([]);
    expect(await types(inbox, "P5")).toEqual(["record_updated_mine"]);
  });
  it(`a follower with more than ${DIGEST_OVER} pages in one batch gets one digest instead`, async () => {
    const ids = ["P11", "P12", "P13", "P14"];
    const follows = Object.fromEntries(ids.map((i) => [`person:${i}`, ["F1"]]));
    follows["person:P11"].push("F2");
    const { notifier, inbox, sent } = await setup({ follows, subscribed: ["F1"], prefs: { F1: { features: { records_updated_followed_digest: { enabled: true, detail: 1 } } } } });
    await notifier.onRecordChanged(ids.map((i) => ch(i)));
    expect(await types(inbox, "F1")).toEqual(["records_updated_followed_digest"]);
    expect(sent[0].n.body).toBe("4 pages you follow were updated.");
    expect((await items(inbox, "F1"))[0]).toMatchObject({ navigate: "/me/inbox/", group: "recdigest" });
    expect(await types(inbox, "F2")).toEqual(["record_updated_followed"]); // under the threshold
  });
  it("silent:true (imports, seeding, backfills) notifies nobody and does not even read followers", async () => {
    let reads = 0;
    const inbox = new InMemoryNotificationStore();
    const n = createNotifier({ inbox, featureOn: async () => true, listMembers: async () => new Set(["P5"]), followersOf: async () => { reads += 1; return ["F1"]; }, log: { error() {} } });
    await n.onRecordChanged([ch("P5")], { silent: true, batchId: "b1" });
    expect(reads).toBe(0);
    expect(await items(inbox, "P5")).toEqual([]);
  });
  it("a null actor names nobody (level 0 text); mixed actors in one batch name nobody", async () => {
    const { notifier, inbox } = await setup({ members: ["P5"], subscribed: [], follows: {} });
    await notifier.onRecordChanged([ch("P5", { actor: null }), ch("P5", { actor: { id: "P3", label: "Zed" } })]);
    expect((await items(inbox, "P5"))[0].body ?? "").not.toContain("Zed");
    expect((await items(inbox, "P5"))[0].fields.actor).toBeUndefined();
  });
  it("invalid subjects are skipped and a lookup failure for followers does not stop the owner notice", async () => {
    const inbox = new InMemoryNotificationStore();
    const n = createNotifier({ inbox, featureOn: async () => true, listMembers: async () => new Set(["P5"]), followersOf: async () => { throw new Error("boom"); }, log: { error() {} } });
    await n.onRecordChanged([{ subject: "family:F1" }, { subject: "person:../x" }, ch("P5")]);
    expect(await types(inbox, "P5")).toEqual(["record_updated_mine"]);
  });
  it("is called only by the render-outbox consumer: no other module in api/src calls it", () => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(d, e.name)) : [resolve(d, e.name)]));
    const src = resolve(here, "../src");
    const callers = walk(src).filter((f) => f.endsWith(".js") && /\bonRecordChanged\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length + 1));
    // notify.js defines it; the consumer (hfy-record-change-fanout) is the only permitted caller.
    expect(callers.filter((f) => f !== "notify.js" && f !== "record-change-fanout.js")).toEqual([]);
    expect(readFileSync(resolve(src, "handler.js"), "utf8")).not.toContain("onRecordChanged");
  });
});

describe("a failing producer never fails a committed write", () => {
  const boom = () => { throw new Error("boom"); };
  const failing = createNotifier({
    inbox: { add: boom, list: boom, unreadCount: boom, markRead: boom, markAllRead: boom },
    featureOn: boom, getAdmins: boom, listMembers: boom, followersOf: boom, log: { error() {} },
  });
  it.each([
    ["onProposalSubmitted", [{ proposal: { id: "p", subject: "person:P9", proposer: { id: "P2" } } }]],
    ["onProposalDecided", [{ proposal: { id: "p", subject: "person:P9", proposer: { id: "P2" } }, decision: "accepted", by: { id: "A1" } }]],
    ["onModeration", [{ kind: "hidden", item: "post", authorId: "P2", by: { id: "A1" }, navigate: "/posts/" }]],
    ["onGraduated", [{ photo: { authorId: "P2" }, subject: "person:P9", by: { id: "A1" } }]],
    ["onRecordChanged", [[{ subject: "person:P9", actor: null }]]],
  ])("%s resolves when every dependency throws", async (name, args) => {
    await expect(failing[name](...args)).resolves.toBeUndefined();
  });
  it("a hostile input shape does not throw either", async () => {
    await expect(failing.onRecordChanged(null)).resolves.toBeUndefined();
    await expect(failing.onModeration()).resolves.toBeUndefined();
  });
});

describe("sources", () => {
  it("createMemberSet reads the values of the allowlist map, caches, and fails closed", async () => {
    let n = 0;
    let t = 0;
    const m = createMemberSet({ load: async () => { n += 1; return { "a@example.test": "P1", "b@example.test": "P2", junk: 7 }; }, now: () => t });
    expect([...(await m())].sort()).toEqual(["P1", "P2"]);
    await m();
    expect(n).toBe(1);
    t = 6 * 60_000;
    await m();
    expect(n).toBe(2);
    const dead = createMemberSet({ load: async () => { throw new Error("x"); }, log: { error() {} } });
    expect((await dead()).size).toBe(0);
  });
  it("queryFollowers reads RECSUB# on GSI1 (data model from social.md section 6)", async () => {
    const ddb = createFakeDdb();
    await ddb.send(new cmds.PutCommand({ TableName: "t", Item: { PK: "RSUB#F1", SK: "REC#person:P9", GSI1PK: "RECSUB#person:P9", GSI1SK: "F1" } }));
    await ddb.send(new cmds.PutCommand({ TableName: "t", Item: { PK: "RSUB#F2", SK: "REC#person:P9", GSI1PK: "RECSUB#person:P9", GSI1SK: "F2" } }));
    await ddb.send(new cmds.PutCommand({ TableName: "t", Item: { PK: "RSUB#F3", SK: "REC#person:P8", GSI1PK: "RECSUB#person:P8", GSI1SK: "F3" } }));
    expect((await queryFollowers(ddb, cmds, "t")("person:P9")).sort()).toEqual(["F1", "F2"]);
  });
  it("chat_message is push-only and content-free", async () => {
    const { notifier, inbox, sent } = await setup({ subscribed: ["P2"] });
    await notifier.notify("chat_message", ["P2"], { navigate: "/chat/?c=abc", actorLabel: "Eve" });
    expect(await items(inbox, "P2")).toEqual([]);
    expect(sent[0].n.body).toBe("you have a new chat message.");
  });
});
