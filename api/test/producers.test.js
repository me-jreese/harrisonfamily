// HFY-R49: notification producers with an injected sender (no network). Level 0 is content-free.
import { describe, expect, it } from "vitest";
import { DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { createNotifier } from "../src/notify.js";

const sub = (n) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: "k", auth: "a" } });
async function setup(subscribed, prefs = {}) {
  const ddb = createFakeDdb();
  const subscriptions = new DynamoSubscriptionStore(ddb, cmds, "t");
  const preferences = new DynamoPreferencesStore(ddb, cmds, "t");
  for (const p of subscribed) await subscriptions.put(p, sub(p));
  for (const [p, v] of Object.entries(prefs)) await preferences.put(p, v);
  const sent = [];
  const webpush = { async sendNotification(s, payload) { sent.push({ to: s.endpoint.split("/").pop(), n: JSON.parse(payload).notification }); } };
  const notifier = createNotifier({ subscriptions, preferences, webpush, vapid: { subject: "mailto:t@example.test", publicKey: "p", privateKey: "x" }, listPrincipals: async () => subscribed, log: { error() {} } });
  return { notifier, sent };
}
const comment = (over = {}) => ({ threadId: "person:I0001", body: "hello", author: { id: "I0005", label: "Eve" }, ...over });

describe("producers", () => {
  it("comment: record owner, earlier commenters (not the author), mentions; one push each; level 0 has no body text", async () => {
    const { notifier, sent } = await setup(["I0001", "I0002", "I0003", "I0005"]);
    await notifier.onComment(comment({ body: "secret text @I0003" }), { parent: null }, { earlierCommenters: ["I0002", "I0005"] });
    const by = Object.fromEntries(sent.map((s) => [s.to, s.n]));
    expect(Object.keys(by).sort()).toEqual(["I0001", "I0002", "I0003"]);
    expect(by.I0001).toMatchObject({ body: "Someone commented on your record.", navigate: "/person/?id=I0001" });
    expect(by.I0002.body).toBe("Someone replied to you.");
    expect(by.I0003.body).toBe("You were mentioned.");
    expect(JSON.stringify(sent)).not.toContain("secret text");
    expect(JSON.stringify(sent)).not.toContain("Eve");
  });
  it("post comments deep-link to /posts/?id= and notify the post author", async () => {
    const id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    const { notifier, sent } = await setup(["I0001"]);
    await notifier.onComment(comment({ threadId: `post:${id}` }), { parent: null }, { postAuthorId: "I0001" });
    expect(sent[0].n.navigate).toBe(`/posts/?id=${id}`);
  });
  it("respects preferences: a disabled type is skipped; level 1 names the actor", async () => {
    const { notifier, sent } = await setup(["I0001", "I0002"], {
      I0001: { features: { comment_on_my_record: { enabled: false, detail: 0 } } },
      I0002: { features: { reply_to_me: { enabled: true, detail: 1 } } },
    });
    await notifier.onComment(comment({ threadId: "person:I0001" }), { parent: null }, { earlierCommenters: ["I0002"] });
    expect(sent.map((s) => [s.to, s.n.body])).toEqual([["I0002", "Eve replied to you."]]);
  });
  it("publish: everyone subscribed except the author; level 0, deep link /posts/?id=", async () => {
    const { notifier, sent } = await setup(["I0001", "I0002", "I0005"]);
    await notifier.onPublished({ id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", author: { id: "I0005", label: "Eve" } });
    expect(sent.map((s) => s.to).sort()).toEqual(["I0001", "I0002"]);
    expect(sent[0].n).toMatchObject({ body: "There is a new family post.", navigate: "/posts/?id=01HZZZZZZZZZZZZZZZZZZZZZZZ" });
  });
});
