// Review fixes on the HFY-E5 release branch: post shape validation, post-thread visibility, post-commit side effects,
// optimistic concurrency (D-15 `before` correctness) and post-delete thread purge.
import { beforeEach, describe, expect, it } from "vitest";
import { makeApi, signToken, createFakeDdb, cmds, TABLE, createUlidFactory, ticker } from "./world.js";
import { purgeThread } from "../src/comments.js";

let ann, olive, admin, third;
beforeEach(async () => {
  [ann, olive, admin, third] = await Promise.all(["I0001", "I0002", "I0099", "I0003"].map((s) => signToken(s)));
});
const auditsOf = (w) => w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#")).sort((x, y) => (x.SK < y.SK ? -1 : 1));
const publish = async (w, token, extra = {}) => (await w.call("POST", "/api/posts", { token, body: { body: "news", visibility: "published", ...extra } })).body;

describe("post shape validation (post-shape-unvalidated)", () => {
  let w;
  beforeEach(() => { w = makeApi(); });
  const create = (body) => w.call("POST", "/api/posts", { token: ann, body: { body: "x", visibility: "published", ...body } });

  it("rejects malformed title, subject and attachments with 422 and stores nothing", async () => {
    const before = w.ddb.all().length;
    const bad = [
      { attachments: "x" },
      { attachments: [null] },
      { attachments: [["nested"]] },
      { attachments: [{ kind: "image" }] },
      { attachments: [{ kind: "video", url: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/a.jpg", mime: "image/jpeg" }] },
      { attachments: [{ kind: "image", url: "https://evil.example/x.jpg", mime: "image/jpeg" }] },
      { attachments: [{ kind: "image", url: "javascript:alert(1)", mime: "image/jpeg" }] },
      { attachments: [{ kind: "image", url: "https://harrisonfamily.us/media/posts/01J00000000000000000000000/a.jpg", mime: "image/jpeg" }] },
      { attachments: [{ kind: "image", url: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/../../admin.html", mime: "image/jpeg" }] },
      { attachments: [{ kind: "image", url: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/a.jpg", mime: "text/html" }] },
      { attachments: [{ kind: "image", url: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/a.jpg", mime: "image/jpeg", alt: {} }] },
      { attachments: [{ kind: "image", url: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/a.jpg", mime: "image/jpeg", width: -1 }] },
      { attachments: Array.from({ length: 11 }, () => ({ kind: "image", url: "/uploads/posts/01J00000000000000000000000/a.jpg", mime: "image/jpeg" })) },
      { title: {} },
      { title: 42 },
      { title: "t".repeat(201) },
      { subject: {} },
      { subject: ["I0001"] },
      { subject: "has spaces" },
      { subject: "x".repeat(129) },
    ];
    for (const b of bad) {
      const r = await create(b);
      expect(r.status, JSON.stringify(b).slice(0, 120)).toBe(422);
      expect(r.body.error).toBe("validation");
    }
    expect(w.ddb.all().length).toBe(before);
  });

  it("accepts a presigned upload as an attachment and stores only the known Attachment fields", async () => {
    const up = (await w.call("POST", "/api/uploads", { token: ann, body: { filename: "Garden.JPG", contentType: "image/jpeg", size: 10 } })).body;
    const r = await create({ subject: "I0001", title: "Garden", attachments: [{ kind: "image", url: up.publicUrl, mime: "image/jpeg", alt: "the garden", width: 640, height: 480, onerror: "x", extra: { a: 1 } }] });
    expect(r.status).toBe(201);
    expect(r.body.attachments).toEqual([{ kind: "image", url: up.publicUrl, mime: "image/jpeg", alt: "the garden", width: 640, height: 480 }]);
    expect(r.body.subject).toBe("I0001"); // bare gramps id, as the own-page composer sends it
    const up2 = (await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 10 } })).body; // an upload attaches once
    const relative = await create({ attachments: [{ kind: "image", url: `/${up2.key}`, mime: "image/jpeg" }], subject: null, title: null });
    expect(relative.status).toBe(201);
    expect(relative.body).not.toHaveProperty("subject");
    expect(relative.body).not.toHaveProperty("title");
  });

  it("PATCH validates the same fields; a valid PATCH still works", async () => {
    const p = (await create({ title: "T" })).body;
    for (const patch of [{ title: {} }, { subject: 7 }, { attachments: [null] }, { attachments: "x" }, { attachments: null }]) {
      expect((await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: patch })).status, JSON.stringify(patch)).toBe(422);
    }
    expect((await w.call("GET", `/api/posts/${p.id}`, { token: ann })).body.title).toBe("T");
    const ok = await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { title: null, subject: "person:I0001" } });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toHaveProperty("title");
    expect(ok.body.subject).toBe("person:I0001");
  });

  it("caps the serialized post so the audit item (before + after) stays under the DynamoDB item limit", async () => {
    const r = await create({ body: "\u0001".repeat(20_000) }); // 20k chars, ~120 KB serialized
    expect(r.status).toBe(422);
    expect(r.body.details).toEqual({ field: "body" });
  });
});

describe("post:<id> threads follow the post's visibility (post-thread-ignores-post-visibility)", () => {
  it("withdrawn: others cannot list, comment, react or edit; author and admin can; a comment author can still delete", async () => {
    const w = makeApi();
    const p = await publish(w, ann);
    const subject = `post:${p.id}`;
    const c1 = (await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "lovely" } })).body;
    const c2 = (await w.call("POST", "/api/comments", { token: third, body: { subject, body: "agreed" } })).body;
    expect((await w.call("POST", `/api/comments/${c1.id}/react`, { token: third, body: { subject, emoji: "❤️" } })).status).toBe(200);

    expect((await w.call("POST", `/api/posts/${p.id}/visibility`, { token: ann, body: { visibility: "withdrawn" } })).status).toBe(200);
    expect((await w.call("GET", "/api/comments", { token: third, query: { subject } })).status).toBe(404);
    expect((await w.call("POST", `/api/comments/${c1.id}/react`, { token: third, body: { subject, emoji: "👍" } })).status).toBe(404);
    expect((await w.call("POST", `/api/comments/${c1.id}/react`, { token: third, query: { subject }, body: { emoji: "👍" } })).status).toBe(404);
    expect((await w.call("PATCH", `/api/comments/${c1.id}`, { token: olive, body: { subject, body: "edited" } })).status).toBe(404);
    expect((await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "again" } })).status).toBe(404);

    const asAuthor = await w.call("GET", "/api/comments", { token: ann, query: { subject } });
    expect(asAuthor.status).toBe(200);
    expect(asAuthor.body.thread.comments.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect((await w.call("GET", "/api/comments", { token: admin, query: { subject } })).status).toBe(200);
    expect((await w.call("DELETE", `/api/comments/${c2.id}`, { token: third, query: { subject } })).status).toBe(204);
  });

  it("a draft post's thread is 404 to others; a missing post's thread is 404 to everyone", async () => {
    const w = makeApi();
    const d = (await w.call("POST", "/api/posts", { token: ann, body: { body: "draft" } })).body;
    expect((await w.call("GET", "/api/comments", { token: olive, query: { subject: `post:${d.id}` } })).status).toBe(404);
    expect((await w.call("GET", "/api/comments", { token: ann, query: { subject: `post:${d.id}` } })).status).toBe(200);
    expect((await w.call("GET", "/api/comments", { token: admin, query: { subject: "post:01J00000000000000000000000" } })).status).toBe(404);
  });

  it("deleting a post purges its thread (comments + reactions), auditing each removed comment", async () => {
    const w = makeApi();
    const p = await publish(w, ann);
    const subject = `post:${p.id}`;
    const c1 = (await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "one" } })).body;
    const c2 = (await w.call("POST", "/api/comments", { token: third, body: { subject, body: "two", parentId: c1.id } })).body;
    await w.call("POST", `/api/comments/${c1.id}/react`, { token: third, body: { subject, emoji: "❤️" } });
    expect(w.ddb.all().filter((r) => r.PK === `THREAD#${subject}`)).toHaveLength(3);

    expect((await w.call("DELETE", `/api/posts/${p.id}`, { token: admin })).status).toBe(204);
    expect(w.ddb.all().filter((r) => r.PK === `THREAD#${subject}`)).toEqual([]);
    const purged = auditsOf(w).filter((a) => a.op === "delete" && a.reason === "post deleted");
    expect(purged.map((a) => a.id).sort()).toEqual([c1.id, c2.id].sort());
    expect(purged.every((a) => a.principal === "I0099" && a.after === null && a.before.body)).toBe(true);
    expect((await w.call("GET", "/api/comments", { token: admin, query: { subject } })).status).toBe(404);
  });

  it("purgeThread splits large threads into transactions of at most 100 items", async () => {
    const ddb = createFakeDdb();
    const sizes = [];
    const spy = { send: (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") sizes.push(cmd.input.TransactItems.length); return ddb.send(cmd); } };
    const t = "post:01J00000000000000000000000";
    const ulid = createUlidFactory();
    const now = ticker();
    for (let i = 0; i < 70; i += 1) {
      const id = ulid(now());
      await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: `THREAD#${t}`, SK: `C#${id}`, entity: "comment", comment: { id, threadId: t, author: { id: "I0002", label: "O" }, body: `c${i}`, created_at: "x" } } }));
      await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: `THREAD#${t}`, SK: `R#comment:${id}#I0003`, entity: "reaction", target: `comment:${id}`, reaction: { emoji: "❤️", by: "I0003", created_at: "x" } } }));
    }
    expect(await purgeThread({ ddb: spy, cmds, table: TABLE, now, uid: () => ulid(now()) }, t, "I0001")).toBe(70);
    expect(ddb.all().filter((r) => r.PK === `THREAD#${t}`)).toEqual([]);
    expect(ddb.all().filter((r) => r.PK.startsWith("AUDIT#"))).toHaveLength(70);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(70 * 3);
  });
});

describe("post-commit side effects never fail a committed write (post-commit-side-effects-fail-write)", () => {
  const failing = (name) => async (cmd) => { if (cmd.constructor.name === name) throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); };

  it("a failing subscriber Scan after publish still returns 201 and the post is stored once", async () => {
    const w = makeApi({ intercept: failing("ScanCommand") });
    const r = await w.call("POST", "/api/posts", { token: ann, body: { body: "hello", visibility: "published" } });
    expect(r.status).toBe(201);
    expect(w.ddb.all().filter((x) => x.PK === `POST#${r.body.id}` && x.SK === "META")).toHaveLength(1);
    const d = (await w.call("POST", "/api/posts", { token: ann, body: { body: "later" } })).body;
    expect((await w.call("POST", `/api/posts/${d.id}/visibility`, { token: ann, body: { visibility: "published" } })).status).toBe(200);
  });

  it("a failing fan-out read after a comment still returns 201", async () => {
    const w = makeApi({ intercept: failing("QueryCommand") });
    const r = await w.call("POST", "/api/comments", { token: olive, body: { subject: "person:I0001", body: "hi" } });
    expect(r.status).toBe(201);
    expect(w.ddb.all().filter((x) => x.SK === `C#${r.body.id}`)).toHaveLength(1);
  });

  it("a post withdrawn between the comment write and the fan-out does not turn the 201 into a 404", async () => {
    let w;
    let stage = "off"; // off -> await-commit -> await-fanout-read -> off
    w = makeApi({
      intercept: async (cmd) => {
        const name = cmd.constructor.name;
        if (stage === "await-commit" && name === "TransactWriteCommand") stage = "await-fanout-read";
        else if (stage === "await-fanout-read" && name === "GetCommand") {
          stage = "off"; // the fan-out re-reads the post as the commenter: withdraw it first
          await w.call("POST", `/api/posts/${p.id}/visibility`, { token: ann, body: { visibility: "withdrawn" } });
        }
      },
    });
    const p = await publish(w, ann);
    stage = "await-commit";
    const r = await w.call("POST", "/api/comments", { token: olive, body: { subject: `post:${p.id}`, body: "hi" } });
    expect(r.status).toBe(201);
  });

  it("without push configured, publishing and commenting run no Scan and no fan-out Query", async () => {
    const w = makeApi({ withPush: false });
    w.ddb.calls.length = 0;
    expect((await w.call("POST", "/api/posts", { token: ann, body: { body: "hello", visibility: "published" } })).status).toBe(201);
    expect((await w.call("POST", "/api/comments", { token: olive, body: { subject: "person:I0001", body: "hi" } })).status).toBe(201);
    expect(w.ddb.calls).not.toContain("ScanCommand");
    expect(w.ddb.calls).not.toContain("QueryCommand");
  });
});

describe("optimistic concurrency (no-optimistic-concurrency-audit-before)", () => {
  /** Runs `other()` just before the next TransactWrite of the request under test reaches the store. */
  function racyApi() {
    let other = null;
    const w = makeApi({
      intercept: async (cmd) => {
        if (other && cmd.constructor.name === "TransactWriteCommand") { const run = other; other = null; await run(); }
      },
    });
    return { w, race: (fn) => { other = fn; } };
  }

  it("an edit racing a withdraw is rejected (409) instead of silently re-publishing; the audit trail stays exact", async () => {
    const { w, race } = racyApi();
    const p = await publish(w, ann);
    race(() => w.call("POST", `/api/posts/${p.id}/visibility`, { token: ann, body: { visibility: "withdrawn" } }));
    const r = await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { body: "new text" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("conflict");
    const now = (await w.call("GET", `/api/posts/${p.id}`, { token: ann })).body;
    expect(now).toMatchObject({ visibility: "withdrawn", body: "news" });
    const a = auditsOf(w);
    expect(a.map((x) => x.op)).toEqual(["create", "visibility"]);
    expect(a[1].before.visibility).toBe("published");
    // A retry from the fresh state succeeds and records the real `before`.
    expect((await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { body: "new text" } })).status).toBe(200);
    expect(auditsOf(w).at(-1)).toMatchObject({ op: "update", before: { visibility: "withdrawn", body: "news" } });
  });

  it("a delete racing an edit is rejected (409) so the audit `before` is never stale", async () => {
    const { w, race } = racyApi();
    const p = await publish(w, ann);
    race(() => w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { body: "edited" } }));
    expect((await w.call("DELETE", `/api/posts/${p.id}`, { token: admin })).status).toBe(409);
    expect((await w.call("GET", `/api/posts/${p.id}`, { token: ann })).body.body).toBe("edited");
  });

  it("two concurrent comment edits: the second is a 409, not a lost update", async () => {
    const { w, race } = racyApi();
    const subject = "person:I0001";
    const c = (await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "v1" } })).body;
    race(() => w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject, body: "from phone" } }));
    const r = await w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject, body: "from laptop" } });
    expect(r.status).toBe(409);
    const list = await w.call("GET", "/api/comments", { token: third, query: { subject } });
    expect(list.body.thread.comments[0].body).toBe("from phone");
    // Once edited, further edits are guarded on edited_at.
    race(() => w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject, body: "v3" } }));
    expect((await w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject, body: "v4" } })).status).toBe(409);
    expect((await w.call("DELETE", `/api/comments/${c.id}`, { token: olive, query: { subject } })).status).toBe(204);
  });
});
