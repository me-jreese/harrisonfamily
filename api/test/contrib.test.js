// HFY-TSK-255: the contributions ledger. Builders (contribOps, revokeOps, hideOps, mergeOps), then the ledger wired into every write
// that earns or loses a credit: comment create/delete, post first publish/withdraw/republish/delete, and purgeThread. Synthetic data only.
import { describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import priv from "@io-kit/mcp/fixtures/keys/hfy-auth-edge.private.jwk.json" with { type: "json" };
import jwks from "@io-kit/mcp/fixtures/jwks/hfy-auth-edge.jwks.json" with { type: "json" };
import { createMcpMount } from "../src/mcp.js";
import { createGroupResolver } from "../src/policy.js";
import { purgeThread } from "../src/comments.js";
import { transact } from "../src/txn.js";
import { contribOps, eventKeys, hideOps, mergeOps, mergedSize, revokeOps, selfEditCapped } from "../src/contrib.js";
import { TABLE, cmds, createFakeDdb, createUlidFactory, makeApi, signToken, ticker } from "./world.js";

const ULID_A = "01J00000000000000000000001";
const ULID_B = "01J00000000000000000000002";
const AT = "2026-03-14T10:00:00.000Z";
const mk = (over = {}) => contribOps({ actor: { id: "I0001", label: "Ann" }, kind: "comment", ref: { type: "comment", id: ULID_A, thread: "person:I0009" }, subject: "person:I0009", at: AT, uid: () => ULID_B, ...over });
const keysOf = (frag) => [...frag.puts.map((p) => p.item), ...frag.deletes.map((d) => d.key ?? d), ...frag.updates.map((u) => u.key)].map((k) => `${k.PK}|${k.SK}`);

// The ledger as a plain object: the counter rows that exist and the events that exist.
const ledger = (w) => {
  const rows = w.ddb.all();
  const counters = Object.fromEntries(rows.filter((r) => r.PK.startsWith("CSTAT#")).map((r) => [`${r.PK}|${r.SK}`, r]));
  const events = rows.filter((r) => r.PK.startsWith("CONTRIB#") && r.SK.startsWith("E#"));
  return { counters, events };
};
const total = (w, who) => ledger(w).counters[who ? `CSTAT#person:${who}|TOTAL` : "CSTAT#site|TOTAL"]?.n ?? 0;
const upload = (n) => ({ kind: "image", url: `/uploads/posts/01J0000000000000000000000${n}/a.jpg`, mime: "image/jpeg" });

describe("contribOps", () => {
  it("builds the event and the five counters with the BRD2 section 4 keys", () => {
    const { event, puts, deletes, updates, checks } = mk();
    expect(event).toMatchObject({
      PK: "CONTRIB#I0001", SK: `E#${ULID_B}`, GSI1PK: "CONTRIBS", GSI1SK: ULID_B, entity: "contrib", id: ULID_B, kind: "comment",
      actor: { id: "I0001", label: "Ann" }, at: AT, weight: 1, photos: 0, via: "ui", ref: { type: "comment", id: ULID_A, thread: "person:I0009" }, subject: "person:I0009",
    });
    expect(puts).toEqual([{ item: event, condition: "attribute_not_exists(PK)" }]);
    expect([deletes, checks]).toEqual([[], []]);
    expect(keysOf({ puts: [], deletes: [], updates })).toEqual([
      "CSTAT#site|TOTAL", "CSTAT#site|D#2026-03-14", "CSTAT#site|M#2026-03", "CSTAT#person:I0001|TOTAL", "CSTAT#person:I0001|M#2026-03",
    ]);
    expect(1 + updates.length).toBe(6);
  });

  it("a post with 3 photos weighs 4: n and n_photo move, and only TOTAL rows keep first_at", () => {
    const { event, updates } = mk({ kind: "post", ref: { type: "post", id: ULID_A }, photos: 3 });
    expect(event.weight).toBe(4);
    const [siteTotal, siteDay, siteMonth, personTotal] = updates;
    expect(siteTotal.counter.adds).toEqual({ n: 4, n_post: 1, n_photo: 3 });
    expect(siteTotal.counter.ifNotExists).toEqual({ first_at: AT });
    expect(personTotal.counter.adds).toEqual({ n: 4, n_post: 1, n_photo: 3 });
    expect(siteDay.counter.adds).toEqual({ n: 4 });
    expect(siteMonth.counter.adds).toEqual({ n: 4 });
    expect(siteDay.counter.ifNotExists).toEqual({});
  });

  it("the day row expires 800 days after its UTC day; the others never expire", () => {
    const { updates } = mk();
    expect(updates[1].counter.ttl).toBe(Math.floor((Date.parse("2026-03-14T00:00:00Z") + 800 * 86_400_000) / 1000));
    expect([updates[0], updates[2], updates[3], updates[4]].map((u) => u.counter.ttl)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("stamps via, defaulting to ui; sync is never credited", () => {
    expect(mk().event.via).toBe("ui");
    expect(mk({ via: "mcp" }).event.via).toBe("mcp");
    expect(() => mk({ via: "sync" })).toThrow(/via/);
  });

  it("copies no body text: the event holds ids, the kind, the label and counts only", () => {
    const { event } = mk();
    expect(Object.keys(event).sort()).toEqual(["GSI1PK", "GSI1SK", "PK", "SK", "actor", "at", "entity", "id", "kind", "photos", "ref", "subject", "via", "weight"]);
  });

  it("refuses a malformed call", () => {
    expect(() => mk({ kind: "reaction" })).toThrow(/kind/);
    expect(() => mk({ at: "yesterday" })).toThrow(/at/);
    expect(() => mk({ photos: -1 })).toThrow(/photos/);
    expect(() => mk({ photos: 11 })).toThrow(/photos/);
    expect(() => mk({ ref: { type: "post", id: ULID_A } })).toThrow(/ref/);
    expect(() => mk({ actor: {} })).toThrow(/actor/);
    expect(() => mk({ uid: undefined })).toThrow(/ULID/);
  });

  it("self_edit also puts the daily CAP marker (ttl +2 days); the caller reads it first with selfEditCapped", async () => {
    const frag = contribOps({ actor: { id: "I0001" }, kind: "self_edit", ref: { type: "record", id: "I0009" }, subject: "I0009", at: AT, uid: () => ULID_B });
    expect(frag.puts).toHaveLength(2);
    expect(frag.puts[1].item).toMatchObject({ PK: "CONTRIB#I0001", SK: "CAP#self_edit#I0009#2026-03-14", ttl: Math.floor(Date.parse(AT) / 1000) + 2 * 86_400 });
    expect(frag.puts[1].condition).toBeUndefined(); // no condition: a race can at worst count twice
    expect(() => contribOps({ actor: { id: "I0001" }, kind: "self_edit", ref: { type: "record", id: "I0009" }, at: AT, uid: () => ULID_B })).toThrow(/subject/);

    const ddb = createFakeDdb();
    const ctx = { ddb, cmds, table: TABLE };
    expect(await selfEditCapped(ctx, { actor: { id: "I0001" }, subject: "I0009", at: AT })).toBe(false);
    await transact(ddb, cmds, TABLE, mergeOps(frag));
    expect(await selfEditCapped(ctx, { actor: { id: "I0001" }, subject: "I0009", at: "2026-03-14T23:59:59.000Z" })).toBe(true);
    expect(await selfEditCapped(ctx, { actor: { id: "I0001" }, subject: "I0009", at: "2026-03-15T00:00:00.000Z" })).toBe(false); // next UTC day
    expect(await selfEditCapped(ctx, { actor: { id: "I0001" }, subject: "I0008", at: AT })).toBe(false); // another record
    expect(ddb.all().filter((r) => r.entity === "contrib")).toHaveLength(1);
  });
});

describe("revokeOps, hideOps, mergeOps", () => {
  it("revokeOps deletes the event (it must exist) and negates the same five counters in the buckets of event.at", () => {
    const { event, updates } = mk({ kind: "post", ref: { type: "post", id: ULID_A }, photos: 2 });
    const r = revokeOps(event);
    expect(r.deletes).toEqual([{ key: eventKeys("I0001", ULID_B), condition: "attribute_exists(PK)" }]);
    expect(r.puts).toEqual([]);
    expect(keysOf({ puts: [], deletes: [], updates: r.updates })).toEqual(keysOf({ puts: [], deletes: [], updates }));
    expect(r.updates[0].counter.adds).toEqual({ n: -3, n_post: -1, n_photo: -2 });
    expect(r.updates[1].counter.adds).toEqual({ n: -3 });
    expect(r.updates[0].counter.ifNotExists).toEqual({}); // first_at is never touched by a revoke
    expect(r.updates[1].counter.ttl).toBe(updates[1].counter.ttl); // a day row past its ttl comes back already expired
  });

  it("revokeOps needs a stored event", () => {
    expect(() => revokeOps({ actor: { id: "I0001" }, id: ULID_B })).toThrow();
    expect(() => revokeOps(undefined)).toThrow();
  });

  it("hideOps flips the flag on the event and changes no count", () => {
    const h = hideOps({ actor: { id: "I0001" }, id: ULID_B }, true);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ key: eventKeys("I0001", ULID_B), update: "SET #hidden = :hidden", condition: "attribute_exists(PK)", values: { ":hidden": true } });
    expect(h.puts.length + h.deletes.length + h.checks.length).toBe(0);
    expect(hideOps({ actor: { id: "I0001" }, id: ULID_B }, false).updates[0].values).toEqual({ ":hidden": false });
    expect(() => hideOps({ actor: { id: "I0001" }, id: ULID_B }, "yes")).toThrow();
  });

  it("mergeOps folds updates that share a key and keeps everything else in order", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `01J000000000000000000000${String(i + 10).padStart(2, "0")}`);
    const events = ids.map((id) => mk({ id, uid: undefined, ref: { type: "comment", id, thread: "person:I0009" } }).event);
    const merged = mergeOps(...events.map((e) => revokeOps(e)));
    expect(merged.deletes).toHaveLength(30);
    expect(merged.updates).toHaveLength(5); // one decrement per counter key, however many comments
    expect(merged.updates[0].counter.adds).toEqual({ n: -30, n_comment: -30 });
    expect(new Set(keysOf(merged)).size).toBe(keysOf(merged).length);
    expect(mergedSize(...events.map((e) => revokeOps(e)))).toBe(35);
  });

  it("mergeOps asserts the 100-action limit", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ puts: [{ item: { PK: "X", SK: String(i) } }] }));
    expect(() => mergeOps(...many)).toThrow(/limit is 100/);
    expect(mergeOps(...many.slice(0, 100)).puts).toHaveLength(100);
  });

  it("an event and its revoke leave every counter at zero in the real store", async () => {
    const ddb = createFakeDdb();
    const credit = mk({ kind: "post", ref: { type: "post", id: ULID_A }, photos: 3 });
    await transact(ddb, cmds, TABLE, mergeOps(credit));
    expect(ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL")).toMatchObject({ n: 4, n_post: 1, n_photo: 3, first_at: AT });
    await transact(ddb, cmds, TABLE, mergeOps(revokeOps(credit.event)));
    expect(ddb.all().filter((r) => r.PK.startsWith("CONTRIB#"))).toEqual([]);
    for (const r of ddb.all()) expect(r.n, `${r.PK} ${r.SK}`).toBe(0);
  });
});

describe("comments earn and lose credit in the write's own transaction", () => {
  it("create: the event, five counters and the comment link commit together; delete returns to 0", async () => {
    const w = makeApi();
    const t = await signToken("I0001");
    const c = (await w.call("POST", "/api/comments", { token: t, body: { subject: "person:I0009", body: "hello" } })).body;
    const { counters, events } = ledger(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "comment", via: "ui", actor: { id: "I0001" }, weight: 1, ref: { type: "comment", id: c.id, thread: "person:I0009" }, subject: "person:I0009" });
    expect(c.contrib).toEqual({ id: events[0].id });
    expect(w.ddb.all().find((r) => r.SK === `C#${c.id}`).comment.contrib).toEqual({ id: events[0].id });
    expect(Object.keys(counters)).toHaveLength(5);
    expect(total(w)).toBe(1);
    expect(total(w, "I0001")).toBe(1);

    expect((await w.call("DELETE", `/api/comments/${c.id}`, { token: t, query: { subject: "person:I0009" } })).status).toBe(204);
    expect(ledger(w).events).toEqual([]);
    expect(total(w)).toBe(0);
    expect(total(w, "I0001")).toBe(0);
  });

  it("a moderator's delete takes the credit from the comment's author", async () => {
    const w = makeApi();
    const c = (await w.call("POST", "/api/comments", { token: await signToken("I0002"), body: { subject: "person:I0009", body: "x" } })).body;
    expect((await w.call("DELETE", `/api/comments/${c.id}`, { token: await signToken("I0099"), query: { subject: "person:I0009", reason: "spam" } })).status).toBe(204);
    expect(total(w, "I0002")).toBe(0);
    expect(ledger(w).events).toEqual([]);
  });

  it("edits and reactions change nothing in the ledger", async () => {
    const w = makeApi();
    const [ann, olive] = await Promise.all([signToken("I0001"), signToken("I0002")]);
    const c = (await w.call("POST", "/api/comments", { token: ann, body: { subject: "person:I0009", body: "x" } })).body;
    const before = JSON.stringify(ledger(w));
    expect((await w.call("PATCH", `/api/comments/${c.id}`, { token: ann, body: { subject: "person:I0009", body: "y" } })).status).toBe(200);
    expect((await w.call("POST", `/api/comments/${c.id}/react`, { token: olive, body: { subject: "person:I0009", emoji: "❤️" } })).status).toBe(200);
    expect(JSON.stringify(ledger(w))).toBe(before);
  });

  it("a comment from before the ledger (no contrib link) deletes without touching a counter", async () => {
    const w = makeApi();
    const id = "01J00000000000000000000009";
    await w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: "THREAD#person:I0009", SK: `C#${id}`, GSI1PK: "COMMENTS", GSI1SK: id, entity: "comment", comment: { id, threadId: "person:I0009", author: { id: "I0001", label: "Ann" }, body: "old", created_at: AT } } }));
    expect((await w.call("DELETE", `/api/comments/${id}`, { token: await signToken("I0001"), query: { subject: "person:I0009" } })).status).toBe(204);
    expect(ledger(w).counters).toEqual({});
  });

  it("a cancelled transaction leaves no event and no counter", async () => {
    const w = makeApi();
    w.ddb.failNext("ThrottlingError", 1);
    const r = await w.call("POST", "/api/comments", { token: await signToken("I0001"), body: { subject: "person:I0009", body: "hello" } });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(w.ddb.all()).toEqual([]);
  });
});

describe("posts earn credit once, hide with withdraw, and lose it on delete", () => {
  const publish = (w, token, extra = {}) => w.call("POST", "/api/posts", { token, body: { body: "news", visibility: "published", ...extra } });

  it("a post with 3 photos adds 4; deleting it returns every counter to 0", async () => {
    const w = makeApi();
    const t = await signToken("I0001");
    const r = await publish(w, t, { subject: "I0009", attachments: [upload(1), upload(2), upload(3)] });
    expect(r.status).toBe(201);
    const { counters, events } = ledger(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "post", weight: 4, photos: 3, via: "ui", ref: { type: "post", id: r.body.id }, subject: "I0009" });
    expect(counters["CSTAT#site|TOTAL"]).toMatchObject({ n: 4, n_post: 1, n_photo: 3 });
    expect(counters["CSTAT#person:I0001|TOTAL"]).toMatchObject({ n: 4, n_post: 1, n_photo: 3 });
    // all three copies of the post carry the link
    const copies = w.ddb.all().filter((x) => x.PK === `POST#${r.body.id}`);
    expect(copies).toHaveLength(3);
    expect(copies.map((x) => x.post.contrib)).toEqual([{ id: events[0].id }, { id: events[0].id }, { id: events[0].id }]);

    expect((await w.call("DELETE", `/api/posts/${r.body.id}`, { token: t })).status).toBe(204);
    expect(ledger(w).events).toEqual([]);
    expect(total(w)).toBe(0);
    expect(total(w, "I0001")).toBe(0);
    for (const row of Object.values(ledger(w).counters)) expect(row.n).toBe(0);
  });

  it("a draft earns nothing; its first publish earns once; withdraw and republish only hide and show", async () => {
    const w = makeApi();
    const t = await signToken("I0001");
    const d = (await w.call("POST", "/api/posts", { token: t, body: { body: "draft", attachments: [upload(1)] } })).body;
    expect(ledger(w).counters).toEqual({});

    const vis = (visibility) => w.call("POST", `/api/posts/${d.id}/visibility`, { token: t, body: { visibility } });
    expect((await vis("published")).status).toBe(200);
    expect(total(w)).toBe(2); // the post and its photo
    const [event] = ledger(w).events;
    expect(event.hidden).toBeUndefined();

    expect((await vis("withdrawn")).status).toBe(200);
    expect(total(w)).toBe(2); // withdraw keeps the count
    expect(ledger(w).events[0].hidden).toBe(true);

    expect((await vis("published")).status).toBe(200);
    expect(total(w)).toBe(2); // republish does not count twice
    expect(ledger(w).events).toHaveLength(1);
    expect(ledger(w).events[0].hidden).toBe(false);
    expect(ledger(w).events[0].id).toBe(event.id);

    expect((await vis("draft")).status).toBe(200);
    expect(ledger(w).events[0].hidden).toBe(true);
    expect((await vis("published")).status).toBe(200);
    expect(total(w, "I0001")).toBe(2);
    expect(ledger(w).counters["CSTAT#site|TOTAL"]).toMatchObject({ n: 2, n_post: 1, n_photo: 1 });
  });

  it("a withdrawn post can be deleted: the credit goes with it", async () => {
    const w = makeApi();
    const t = await signToken("I0001");
    const p = (await publish(w, t)).body;
    await w.call("POST", `/api/posts/${p.id}/visibility`, { token: t, body: { visibility: "withdrawn" } });
    expect((await w.call("DELETE", `/api/posts/${p.id}`, { token: t })).status).toBe(204);
    expect(total(w)).toBe(0);
    expect(ledger(w).events).toEqual([]);
  });

  it("an admin's delete of a member's post takes the credit from the member, not the admin", async () => {
    const w = makeApi();
    const p = (await publish(w, await signToken("I0002"))).body;
    expect(total(w, "I0002")).toBe(1);
    expect((await w.call("DELETE", `/api/posts/${p.id}`, { token: await signToken("I0099") })).status).toBe(204);
    expect(total(w, "I0002")).toBe(0);
    expect(total(w, "I0099")).toBe(0);
    expect(ledger(w).events).toEqual([]);
  });

  it("edits of a post change nothing in the ledger", async () => {
    const w = makeApi();
    const t = await signToken("I0001");
    const p = (await publish(w, t)).body;
    const before = JSON.stringify(ledger(w));
    expect((await w.call("PATCH", `/api/posts/${p.id}`, { token: t, body: { body: "edited", attachments: [upload(1), upload(2)] } })).status).toBe(200);
    expect(JSON.stringify(ledger(w))).toBe(before);
  });

  it("the post write and its credit are one transaction: a failure leaves neither", async () => {
    const w = makeApi();
    w.ddb.failNext("ThrottlingError", 1);
    const r = await publish(w, await signToken("I0001"));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(w.ddb.all()).toEqual([]);
  });
});

describe("purgeThread revokes the thread's credits with merged counter updates", () => {
  it("30+ comments by one author commit with one decrement per counter key and no duplicate-item error", async () => {
    const w = makeApi();
    const [ann, olive, admin] = await Promise.all(["I0001", "I0002", "I0099"].map((s) => signToken(s)));
    const p = (await w.call("POST", "/api/posts", { token: ann, body: { body: "news", visibility: "published" } })).body;
    const subject = `post:${p.id}`;
    for (let i = 0; i < 34; i += 1) {
      expect((await w.call("POST", "/api/comments", { token: olive, body: { subject, body: `c${i}` } })).status).toBe(201);
    }
    expect((await w.call("POST", "/api/comments", { token: ann, body: { subject, body: "mine" } })).status).toBe(201);
    expect(total(w, "I0002")).toBe(34);
    expect(total(w)).toBe(1 + 34 + 1);

    const sizes = [];
    const spy = { send: (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") sizes.push(cmd.input.TransactItems.length); return w.ddb.send(cmd); } };
    let n = 0;
    const ulid = createUlidFactory();
    const now = ticker();
    n = await purgeThread({ ddb: spy, cmds, table: TABLE, now, uid: () => ulid(now()) }, subject, "I0099");
    expect(n).toBe(35);
    expect(w.ddb.all().filter((r) => r.PK === `THREAD#${subject}`)).toEqual([]);
    expect(ledger(w).events.map((e) => e.kind)).toEqual(["post"]); // only the post's own credit is left
    expect(total(w, "I0002")).toBe(0);
    expect(total(w, "I0001")).toBe(1);
    expect(total(w)).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    // 35 comments: 35 deletes + 35 audits + 35 event deletes + 10 counter keys (two authors) if one batch, and more batches add 10 each
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(35 * 3 + 10);
    expect(sizes.length).toBeLessThanOrEqual(2);
    expect(admin).toBeTruthy();
  });

  it("deleting the post through the API purges the discussion and its credits", async () => {
    const w = makeApi();
    const [ann, olive, admin] = await Promise.all(["I0001", "I0002", "I0099"].map((s) => signToken(s)));
    const p = (await w.call("POST", "/api/posts", { token: ann, body: { body: "news", visibility: "published", attachments: [upload(1)] } })).body;
    for (let i = 0; i < 31; i += 1) await w.call("POST", "/api/comments", { token: olive, body: { subject: `post:${p.id}`, body: `c${i}` } });
    expect(total(w)).toBe(2 + 31);
    expect((await w.call("DELETE", `/api/posts/${p.id}`, { token: admin })).status).toBe(204);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("THREAD#"))).toEqual([]);
    expect(ledger(w).events).toEqual([]);
    for (const row of Object.values(ledger(w).counters)) expect(row.n, `${row.PK} ${row.SK}`).toBe(0);
  });

  it("splits a big purge into transactions of at most 100 actions whatever the authors and months", async () => {
    const ddb = createFakeDdb();
    const t = "post:01J00000000000000000000000";
    const ulid = createUlidFactory();
    const credits = [];
    for (let i = 0; i < 60; i += 1) {
      const id = ulid(Date.parse(i % 2 ? "2026-02-27T12:00:00Z" : "2026-03-02T12:00:00Z") + i);
      const who = `I000${(i % 3) + 1}`;
      const at = i % 2 ? "2026-02-27T12:00:00.000Z" : "2026-03-02T12:00:00.000Z";
      const credit = contribOps({ actor: { id: who }, kind: "comment", ref: { type: "comment", id, thread: t }, subject: t, at, uid: () => ulid(Date.parse(at)) });
      credits.push(credit);
      await transact(ddb, cmds, TABLE, mergeOps(credit, { puts: [{ item: { PK: `THREAD#${t}`, SK: `C#${id}`, entity: "comment", comment: { id, threadId: t, author: { id: who }, body: "x", created_at: at, contrib: { id: credit.event.id } } } }] }));
    }
    const sizes = [];
    const spy = { send: (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") sizes.push(cmd.input.TransactItems.length); return ddb.send(cmd); } };
    expect(await purgeThread({ ddb: spy, cmds, table: TABLE, uid: () => ulid(Date.now()) }, t, "I0099")).toBe(60);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(ddb.all().filter((r) => r.PK.startsWith("CONTRIB#") || r.PK === `THREAD#${t}`)).toEqual([]);
    for (const r of ddb.all().filter((x) => x.PK.startsWith("CSTAT#"))) expect(r.n, `${r.PK} ${r.SK}`).toBe(0);
  });
});

describe("MCP origin", () => {
  const RESOURCE = "https://harrisonfamily.us/mcp";
  const ISS = "https://harrisonfamily.us/auth";
  const key = importJWK(priv, "RS256");
  const token = async (sub) =>
    new SignJWT({ client_id: "mcp-harrisonfamily", token_use: "access", scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: priv.kid ?? "hfy-auth-edge-key-1" }).setSubject(sub).setIssuer(ISS).setAudience(RESOURCE).setIssuedAt().setExpirationTime("10m").sign(await key);
  const setup = () => {
    const api = makeApi();
    const config = { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] };
    const groups = { version: 1, groups: { "mcp-authors": { emails: [], subjects: ["I0044"] }, "hfy-admin": { subjects: [] } } };
    const mount = createMcpMount({ config, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => groups, log: { error() {} } }), fetch: async () => ({ ok: true, status: 200, json: async () => jwks }), log: { info() {}, error() {} } });
    let id = 0;
    const call = async (name, args) => {
      const r = await mount.handle({ rawPath: "/mcp", headers: { "content-type": "application/json", authorization: `Bearer ${await token("I0044")}` }, requestContext: { http: { method: "POST" } }, body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: args } }) });
      return JSON.parse(r.body).result;
    };
    return { api, call };
  };

  it("a comment created through MCP invoke has via:mcp on its event, and counts for the member", async () => {
    const { api, call } = setup();
    const r = await call("hfy_comments_create", { subject: "person:I0113", body: "hi from claude" });
    expect(r.isError).not.toBe(true);
    const events = ledger(api).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "comment", via: "mcp", actor: { id: "I0044" }, ref: { type: "comment", id: r.structuredContent.id } });
    expect(total(api, "I0044")).toBe(1);
  });

  it("the same handler over HTTP stamps via:ui, and invoke() itself stamps mcp", async () => {
    const api = makeApi();
    await api.call("POST", "/api/comments", { token: await signToken("I0044"), body: { subject: "person:I0113", body: "hi" } });
    await api.handler.invoke({ id: "I0044", label: "Ann", admin: false }, "comments.create", { body: { subject: "person:I0113", body: "again" } });
    expect(ledger(api).events.map((e) => e.via).sort()).toEqual(["mcp", "ui"]);
  });

  it("an MCP post is a draft, so it earns nothing until a human publishes it", async () => {
    const { api, call } = setup();
    const r = await call("hfy_posts_create", { body: "From Claude" });
    expect(r.isError).not.toBe(true);
    expect(ledger(api).counters).toEqual({});
    expect(ledger(api).events).toEqual([]);
  });
});
