// HFY-TSK-389-0A: BRD DOC-B2485262A8C7 conformance fixture M-7 (section 12), run against the HFY adapter. The kit's own M-7 is a todo skeleton by design
// (the comment store lives in HFY and @io-kit/comments), so this is the green case: a media comment on subject media:<id> is stored, moderated via MOD#
// and notifies per preferences; nothing reaches the Gramps add-on payload. Synthetic ids only.
import { describe, expect, it } from "vitest";
import { createEditWorld, ADMIN, ME, OTHER } from "./edit-e2e-world.js";
import { signToken } from "./world.js";
import { InMemoryNotificationStore, DynamoPreferencesStore, DynamoSubscriptionStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { createNotifier } from "../src/notify.js";

const MEDIA = "media:O0001";
const FLAGS = { mediaCommentsV1: true, moderationV1: true, contribV1: true, inboxV1: true };

async function world(extraDeps = {}) {
  const w = await createEditWorld({ photo: true, flags: FLAGS, extraDeps });
  const tok = { author: await signToken(ME), other: await signToken(OTHER), admin: await signToken(ADMIN) };
  const call = (who, method, path, extra = {}) => w.rawCall(method, path, { token: tok[who], ...extra });
  return { w, call };
}
const snapshot = (w) => new Map(w.ddb.all().map((r) => [`${r.PK}\u0000${r.SK}`, JSON.stringify(r)]));

describe("M-7: media comment conformance (BRD section 12)", () => {
  it("M-7a stored", async () => {
    const { w, call } = await world();
    try {
      const made = await call("author", "POST", "/api/comments", { body: { subject: MEDIA, body: "a remark on the photo" } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const stored = w.ddb.all().filter((r) => r.SK.startsWith("C#") && JSON.stringify(r).includes("a remark on the photo"));
      expect(stored).toHaveLength(1);
      const listed = await call("other", "GET", "/api/comments", { query: { subject: MEDIA } });
      expect(listed.body.thread.comments.map((c) => c.body)).toEqual(["a remark on the photo"]);
      // the person: thread of the same page is a separate store: nothing leaks across
      const person = await call("other", "GET", "/api/comments", { query: { subject: "person:I0003" } });
      expect(person.body.thread.comments).toEqual([]);
    } finally { w.dispose(); }
  });

  it("M-7b moderated via MOD#", async () => {
    const { w, call } = await world();
    try {
      const c = (await call("author", "POST", "/api/comments", { body: { subject: MEDIA, body: "to be hidden" } })).body;
      const target = { kind: "comment", id: c.id, thread: MEDIA };
      expect((await call("admin", "POST", "/api/moderation", { body: { target, action: "hide" } })).status).toBe(200);
      expect(w.rows("MOD#").find((x) => x.PK === `MOD#comment:${MEDIA}/${c.id}`)).toMatchObject({ hidden: true, state: "hidden", GSI1PK: "MODQ#open", target });
      const seen = async (who) => (await call(who, "GET", "/api/comments", { query: { subject: MEDIA } })).body.thread.comments.map((x) => x.body);
      expect(await seen("other")).toEqual([]);
      expect(await seen("author")).toEqual(["to be hidden"]);
      expect((await call("other", "POST", "/api/moderation", { body: { target, action: "unhide" } })).status).toBe(403);
      expect((await call("admin", "POST", "/api/moderation", { body: { target, action: "unhide" } })).status).toBe(200);
      expect(await seen("other")).toEqual(["to be hidden"]);
    } finally { w.dispose(); }
  });

  it("M-7c notifies per preferences", async () => {
    const ddb = createFakeDdb();
    const inbox = new InMemoryNotificationStore();
    const preferences = new DynamoPreferencesStore(ddb, cmds, "t");
    const subscriptions = new DynamoSubscriptionStore(ddb, cmds, "t");
    const sub = (n) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: "k", auth: "a" } });
    for (const p of ["I0004", "I0005"]) await subscriptions.put(p, sub(p));
    await preferences.put("I0004", { features: { reply_to_me: { enabled: false, detail: 0 } } }); // opted out
    await preferences.put("I0005", { features: { reply_to_me: { enabled: true, detail: 0 } } }); // opted in
    const sent = [];
    const notifier = createNotifier({
      inbox, featureOn: async () => true, getAdmins: async () => new Set(), listMembers: async () => new Set(), followersOf: async () => [],
      preferences, subscriptions, log: { error() {} },
      webpush: { async sendNotification(s) { sent.push(s.endpoint.split("/").pop()); } },
      vapid: { subject: "mailto:t@example.test", publicKey: "p", privateKey: "x" },
    });
    await notifier.onComment({ threadId: MEDIA, body: "a remark", author: { id: "I0002", label: "Eve" } }, {}, { earlierCommenters: ["I0004", "I0005"] });
    expect(sent).toEqual(["I0005"]); // push honours the preference: the opted-out member gets none
    const got = (await inbox.list("I0005")).items;
    expect(got.map((i) => i.type)).toEqual(["reply_to_me"]);
    expect(got[0].navigate).toBe("/all-media/?id=O0001");
  });

  it("M-7d nothing reaches the Gramps add-on payload", async () => {
    // The add-on payload is the sync snapshot (every REC# head, in order of seq) plus the SYNC# log/proposals/conflicts it reads; src/sync/pull.js builds it from
    // the record store view only. A media comment create, edit and moderation must therefore write no REC#, SYNC# or proposal row and leave the seq alone.
    const { w, call } = await world();
    try {
      const before = snapshot(w);
      const made = await call("author", "POST", "/api/comments", { body: { subject: MEDIA, body: "first" } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const edit = await call("author", "PATCH", `/api/comments/${made.body.id}`, { body: { subject: MEDIA, body: "edited" } });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      const target = { kind: "comment", id: made.body.id, thread: MEDIA };
      expect((await call("admin", "POST", "/api/moderation", { body: { target, action: "hide" } })).status).toBe(200);
      expect((await call("admin", "POST", "/api/moderation", { body: { target, action: "unhide" } })).status).toBe(200);
      const after = snapshot(w);
      const touched = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
      expect(touched.length).toBeGreaterThan(0); // the comment and MOD# rows really were written
      const forbidden = /^(REC#|SYNC#|PROP|CHG)/;
      expect(touched.filter((k) => forbidden.test(k))).toEqual([]);
      for (const k of before.keys()) if (forbidden.test(k)) expect(after.get(k)).toBe(before.get(k)); // no add-on-visible row changed or vanished
      expect(touched.every((k) => /^(THREAD#|MOD#|AUDIT#|CONTRIB#|CSTAT#)/.test(k))).toBe(true); // only the comment store, MOD#, audit, contribution feed and stats
    } finally { w.dispose(); }
  });
});
