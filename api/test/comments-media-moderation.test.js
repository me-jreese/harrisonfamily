// HFY-TSK-400: media:<gramps_id> comment threads under moderation and notification, table-driven against the person: thread they must match.
// Synthetic ids only. Handler-level cases use the edit world (one public photo, O0001, on the page of I0003); media O0002 does not exist.
import { describe, expect, it } from "vitest";
import { createEditWorld, ADMIN, ME, OTHER } from "./edit-e2e-world.js";
import { signToken } from "./world.js";
import { hrefOf as modHref } from "../src/moderation.js";
import { hrefOf as feedHref } from "../src/contrib-read.js";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { DynamoPreferencesStore, DynamoSubscriptionStore } from "@io-kit/notify/server";
import { createNotifier, mediaPath } from "../src/notify.js";

const MEDIA = "media:O0001";
const PERSON = "person:I0001";
const FLAGS = { mediaCommentsV1: true, moderationV1: true, contribV1: true, inboxV1: true };
const ULID = "01J00000000000000000000000";

async function world() {
  const w = await createEditWorld({ photo: true, flags: FLAGS });
  const as = async (who) => signToken(who);
  const tok = { author: await as(ME), other: await as(OTHER), admin: await as(ADMIN) };
  const call = (who, method, path, extra = {}) => w.rawCall(method, path, { token: tok[who], ...extra });
  const comment = async (subject, body, who = "author", extra = {}) => {
    const r = await call(who, "POST", "/api/comments", { body: { subject, body, ...extra } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const hide = (target) => call("admin", "POST", "/api/moderation", { body: { target, action: "hide" } });
  const unhide = (target) => call("admin", "POST", "/api/moderation", { body: { target, action: "unhide" } });
  const bodies = async (who, subject) => (await call(who, "GET", "/api/comments", { query: { subject } })).body.thread.comments.map((c) => c.body);
  return { w, call, comment, hide, unhide, bodies };
}

describe.each([[MEDIA], [PERSON]])("an open MOD# overlay on a comment in %s", (subject) => {
  it("hides it from other members, not from its author or an admin; unhide restores it; the open item is queued with the page link", async () => {
    const { w, call, comment, hide, unhide, bodies } = await world();
    try {
      await comment(subject, "first");
      const second = await comment(subject, "second");
      await comment(subject, "third");
      const target = { kind: "comment", id: second.id, thread: subject };
      const r = await hide(target);
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      expect(await bodies("other", subject)).toEqual(["first", "third"]);
      expect(await bodies("author", subject)).toEqual(["first", "second", "third"]);
      expect(await bodies("admin", subject)).toEqual(["first", "second", "third"]);
      const seenByOther = (await call("other", "GET", "/api/comments", { query: { subject, limit: "2" } })).body.thread;
      expect(seenByOther.comments.map((c) => c.body)).toEqual(["first", "third"]); // the page fills past the hidden one
      expect(JSON.stringify(seenByOther)).not.toContain("moderation");

      const key = `MOD#comment:${subject}/${second.id}`;
      expect(w.rows("MOD#").map((x) => x.PK)).toContain(key);
      expect(w.rows("MOD#").find((x) => x.PK === key)).toMatchObject({ GSI1PK: "MODQ#open", hidden: true, state: "hidden", author_id: ME, target });
      const queue = await call("admin", "GET", "/api/moderation");
      expect(queue.status).toBe(200);
      const page = subject === MEDIA ? "/all-media/?id=O0001" : "/person/?id=I0001";
      expect(queue.body.items.map((i) => i.href)).toEqual([`${page}#comment-${second.id}`]);

      expect((await unhide(target)).status).toBe(200);
      expect(await bodies("other", subject)).toEqual(["first", "second", "third"]);
    } finally { w.dispose(); }
  });

  it("a non-admin cannot moderate it, and an admin cannot moderate their own comment", async () => {
    const { w, call, comment } = await world();
    try {
      const mine = await comment(subject, "by the author");
      const own = await comment(subject, "by the admin", "admin");
      const hideAs = (who, id) => call(who, "POST", "/api/moderation", { body: { target: { kind: "comment", id, thread: subject }, action: "hide" } });
      expect((await hideAs("other", mine.id)).status).toBe(403);
      expect((await hideAs("author", mine.id)).status).toBe(403);
      const self = await hideAs("admin", own.id);
      expect(self.status).toBe(400);
      expect(self.body.error).toBe("self_moderation");
    } finally { w.dispose(); }
  });
});

describe("moderation of a media thread follows the Media's own visibility", () => {
  it.each([
    ["a Media that does not exist", "media:O0002", 404],
    ["a thread name that is not valid", "media:O 1", 400],
  ])("%s: the comment target is refused", async (_n, thread, status) => {
    const { w, hide } = await world();
    try {
      expect((await hide({ kind: "comment", id: ULID, thread })).status).toBe(status);
    } finally { w.dispose(); }
  });

  it("with mediaCommentsV1 off the media thread is dark (404) and there is nothing to moderate", async () => {
    const w = await createEditWorld({ photo: true, flags: { ...FLAGS, mediaCommentsV1: false } });
    try {
      const admin = await signToken(ADMIN);
      const r = await w.rawCall("POST", "/api/moderation", { token: admin, body: { target: { kind: "comment", id: ULID, thread: MEDIA }, action: "hide" } });
      expect(r.status).toBe(404);
      expect((await w.rawCall("GET", "/api/comments", { token: await signToken(ME), query: { subject: MEDIA } })).status).toBe(404);
    } finally { w.dispose(); }
  });
});

describe("the links that name a media thread's comment", () => {
  const comment = { kind: "comment", id: ULID, thread: MEDIA };
  it.each([
    ["moderation queue, a comment", comment, `/all-media/?id=O0001#comment-${ULID}`],
    ["moderation queue, a photo of a comment", { kind: "photo", parent: comment, attachment: "A1" }, `/all-media/?id=O0001#comment-${ULID}`],
    ["moderation queue, a person thread (control)", { ...comment, thread: PERSON }, `/person/?id=I0001#comment-${ULID}`],
    ["moderation queue, a media record target falls back to the review page", { kind: "media", handle: "h1" }, "/me/review/"],
    ["moderation queue, an id with characters to encode", { ...comment, thread: "media:a_b.c-9" }, `/all-media/?id=a_b.c-9#comment-${ULID}`],
  ])("%s", (_n, target, want) => expect(modHref(target)).toBe(want));

  it.each([
    ["contribution feed, a comment event with the thread on the ref", { ref: { type: "comment", id: ULID, thread: MEDIA } }, `/all-media/?id=O0001#comment-${ULID}`],
    ["contribution feed, a comment event with the thread as subject", { ref: { type: "comment", id: ULID }, subject: MEDIA }, `/all-media/?id=O0001#comment-${ULID}`],
    ["contribution feed, a person thread (control)", { ref: { type: "comment", id: ULID, thread: PERSON } }, `/person/?id=I0001#comment-${ULID}`],
    ["contribution feed, a photo-to-record event goes to the person's photos", { ref: { type: "media", id: "x" }, subject: PERSON }, "/person/?id=I0001#photos"],
  ])("%s", (_n, event, want) => expect(feedHref(event)).toBe(want));
});

describe("notifications for a media thread", () => {
  const setup = () => {
    const ddb = createFakeDdb();
    const inbox = new InMemoryNotificationStore();
    const notifier = createNotifier({
      inbox, featureOn: async () => true, getAdmins: async () => new Set(), listMembers: async () => new Set(), followersOf: async () => [],
      preferences: new DynamoPreferencesStore(ddb, cmds, "t"), subscriptions: new DynamoSubscriptionStore(ddb, cmds, "t"), log: { error() {} },
    });
    return { notifier, inbox };
  };
  const inboxOf = async (inbox, p) => (await inbox.list(p)).items;
  const author = { id: "I0002", label: "Eve" };

  it("mediaPath is the all-media page with the id", () => {
    expect(mediaPath("O0001")).toBe("/all-media/?id=O0001");
    expect(mediaPath("a b")).toBe("/all-media/?id=a%20b");
  });

  it.each([
    // [label, thread, comment body, context, who, types]
    ["reply to the parent's author", MEDIA, "a remark", { parent: { author: { id: "I0003" } } }, {}, "I0003", ["reply_to_me"]],
    ["reply to an earlier commenter", MEDIA, "a remark", {}, { earlierCommenters: ["I0004"] }, "I0004", ["reply_to_me"]],
    ["a mention", MEDIA, "hello @I0005 look", {}, {}, "I0005", ["mention"]],
    ["a mentioned earlier commenter gets the reply, once", MEDIA, "hello @I0004", {}, { earlierCommenters: ["I0004"] }, "I0004", ["reply_to_me"]],
    ["no comment_on_my_record for a post author id that is given", MEDIA, "a remark", {}, { postAuthorId: "I0001" }, "I0001", []],
    ["no comment_on_my_record for anyone with no earlier comment", MEDIA, "a remark", {}, {}, "I0001", []],
    ["the author is never told about their own comment", MEDIA, "a remark @I0002", {}, { earlierCommenters: ["I0002"] }, "I0002", []],
    ["control: a person thread's owner does get comment_on_my_record", "person:I0001", "a remark", {}, {}, "I0001", ["comment_on_my_record"]],
  ])("%s", async (_n, threadId, body, parent, ctx, who, want) => {
    const { notifier, inbox } = setup();
    await notifier.onComment({ threadId, body, author }, parent, ctx);
    const got = await inboxOf(inbox, who);
    expect(got.map((i) => i.type)).toEqual(want);
    if (threadId === MEDIA) for (const i of got) expect(i.navigate).toBe("/all-media/?id=O0001");
  });

  it("through the API: a reply and a mention in a media thread reach the inbox with the all-media link, and the media owner notice is never sent", async () => {
    const inbox = new InMemoryNotificationStore();
    const w = await createEditWorld({ photo: true, flags: FLAGS, extraDeps: { inbox } });
    try {
      const tokens = { me: await signToken(ME), other: await signToken(OTHER) };
      const post = async (who, body) => (await w.rawCall("POST", "/api/comments", { token: tokens[who], body: { subject: MEDIA, ...body } }));
      const first = await post("me", { body: "what a photo" });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const reply = await post("other", { body: `thanks @${ME}`, parentId: first.body.id });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      await new Promise((r) => setTimeout(r, 20));
      const mine = await inbox.list(ME);
      expect(mine.items.map((i) => i.type).sort()).toEqual(["reply_to_me"]); // reply wins over mention: one notification per recipient
      expect(mine.items[0].navigate).toBe("/all-media/?id=O0001");
      expect((await inbox.list(OTHER)).items).toEqual([]);
      expect((await inbox.list("I0003")).items).toEqual([]); // the person tagged in the photo is not its owner
    } finally { w.dispose(); }
  });
});
