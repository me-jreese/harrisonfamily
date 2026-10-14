// HFY-TSK-178 (hfy-record-change-fanout): the render-outbox consumer, end to end over the in-memory store. The renderer is Python
// (lambda/hfy-sync-render); these tests write the SYNC#RENDERED item it would write, in the shape docs/reference/sync-render.md documents.
// Synthetic ids and labels only.
import { describe, it, expect, vi } from "vitest";
import { InMemoryNotificationStore, DynamoPreferencesStore, DynamoSubscriptionStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds, makeApi, signToken } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { ORIGINS, headKey, logKey, seqKey } from "../src/sync/store.js";
import { createNotifier, queryFollowers } from "../src/notify.js";
import { createSubscriptions } from "../src/subscriptions.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import {
  LEASE_MS, createFanoutNotifier, createRecordFanout, dedupeKey, isReplayEvent, isStreamEvent, markerKeys, peopleReached,
} from "../src/record-change-fanout.js";
import { storeView } from "../src/records/index.js";

const T = "hfy-app";
const h = (n) => n.toString(16).padStart(28, "0");
const gid = (n) => `I${String(n).padStart(4, "0")}`;
const REGION = [10, 10, 40, 40];
const ref = (n) => ({ _class: "MediaRef", ref: h(5000 + n), rect: REGION, citation_list: [], note_list: [], attribute_list: [], private: false });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: gid(n), change: 1700000000, private: false, gender: 1, media_list: [], ...extra });
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, change: 1700000000, private: false, ...extra });
const note = (n) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1700000000, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] } });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const update = (obj, base) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj });
const withdraw = (obj, base) => ({ op: "withdraw", class: obj._class, handle: obj.handle, base_version: base, reason: "private" });
const LABELS = { I0002: "Eve", I0004: "Dee", I0005: "Pat", I0007: "Sam", I0010: "Wynn", I0011: "Kit", I0012: "Lou" };

function world({ members = [], flag = () => true, inbox: inboxStore, noInbox = false, chunkSize } = {}) {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false });
  const clock = { t: Date.parse("2026-10-14T10:00:00Z") };
  const hooks = createHookRegistry();
  registerRecordContributor({ ddb, cmds, table: T }, hooks);
  const ctx = { ddb, cmds, table: T, now: () => clock.t, hooks, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true };
  let k = 0;
  const apply = (ops, o = {}) => applyBatch(ctx, { principal: "svc", origin: "desktop", idempotencyKey: `key-${++k}`, ops, ...o });
  const inbox = inboxStore ?? new InMemoryNotificationStore();
  const followersSpy = vi.fn(queryFollowers(ddb, cmds, T));
  const calls = [];
  const notifier = createFanoutNotifier({
    ...(noInbox ? {} : { inbox }), featureOn: async (name, p) => flag(name, p), listMembers: async () => new Set(members), followersOf: followersSpy,
    preferences: new DynamoPreferencesStore(ddb, cmds, T), subscriptions: new DynamoSubscriptionStore(ddb, cmds, T), log: { error() {} },
  });
  const spied = { ...notifier, onRecordChanged: vi.fn(async (...a) => { calls.push(a); return notifier.onRecordChanged(...a); }) };
  const fanout = createRecordFanout({ ddb, cmds, table: T, notifier: spied, now: ctx.now, chunkSize, log: { error() {}, warn() {} }, labelOf: async (id) => LABELS[id] });
  const follow = async (who, target) => createSubscriptions({ ddb, cmds, table: T, actor: { id: who }, now: ctx.now, personExists: async () => true }).put(target);
  const types = async (p) => (await inbox.list(p)).items.map((i) => i.type);
  const items = async (p) => (await inbox.list(p)).items;
  /** The SYNC#RENDERED item the renderer writes for the log range [from, to]. */
  const rendered = (from, to, o = {}) => {
    const item = {
      PK: "SYNC#RENDERED", SK: seqKey(to), entity: "rendered", seq_from: from, seq_to: to, baseline: false, changed_people: [], changed_count: 0,
      deleted_people: [], deleted_count: 0, principals: [], origins: [], entries: to - from + 1, truncated: false, at: new Date(clock.t).toISOString(), ttl: 1, ...o,
    };
    item.changed_count = item.changed_people.length;
    ddb.rows.set(`${item.PK}\u0000${item.SK}`, item);
    return item;
  };
  const rows = (prefix) => ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { ddb, ctx, apply, inbox, notifier: spied, fanout, follow, types, items, rendered, calls, followersSpy, clock, rows, hooks };
}
/** Creates the people as the desktop (origin desktop, quiet) and returns the next seq. */
const seedPeople = async (w, ns) => { const r = await w.apply(ns.map((n) => create(person(n)))); return r.seq_to; };

describe("silent passes: seeds, imports and baselines", () => {
  it("the store has no import origin: an import IS the seed session (the first session, origin seed), so the seed rule covers it", () => {
    expect(ORIGINS).not.toContain("import");
    expect(ORIGINS).toContain("seed");
  });

  it("an import of N records (the seed session, named explicitly: origin seed) writes nothing to any inbox and reads no followers", async () => {
    const w = world({ members: ["I0005", "I0012"] });
    await w.follow("F1", "I0005");
    const N = 60;
    const r = await w.apply(Array.from({ length: 24 }, (_, i) => create(person(100 + i))), { origin: "seed" });
    await w.apply(Array.from({ length: 24 }, (_, i) => create(person(200 + i))), { origin: "seed" });
    await w.apply(Array.from({ length: 12 }, (_, i) => create(person(300 + i))), { origin: "seed" });
    const people = [...Array.from({ length: 24 }, (_, i) => gid(100 + i)), ...Array.from({ length: 24 }, (_, i) => gid(200 + i)), ...Array.from({ length: 12 }, (_, i) => gid(300 + i)), "I0005", "I0012"];
    const item = w.rendered(1, r.seq_to + 2, { changed_people: people, origins: ["seed"], principals: ["svc"] });
    expect(people.length).toBe(N + 2);
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "silent", reason: "seed" });
    expect(await w.items("I0005")).toEqual([]);
    expect(await w.items("F1")).toEqual([]);
    expect(w.followersSpy).not.toHaveBeenCalled();
    expect(w.notifier.onRecordChanged).not.toHaveBeenCalled();
    expect(w.rows("RECFAN#")).toEqual([]); // nothing claimed
  });

  it("a seed entry anywhere in the range silences the whole pass, even when the outbox origins omit it", async () => {
    const w = world({ members: ["I0005"] });
    const r = await w.apply([create(person(5))], { origin: "seed" });
    const item = w.rendered(1, r.seq_to, { changed_people: ["I0005"], origins: [] });
    expect((await w.fanout.processRendered(item)).status).toBe("silent");
    expect(await w.items("I0005")).toEqual([]);
  });

  it("an import marker (item.import, an import origin or entry.import) is silent too, should one ever exist: D2-16's import:true", async () => {
    const w = world({ members: ["I0005"] });
    const seq = await seedPeople(w, [5]);
    for (const extra of [{ import: true, origins: ["desktop"] }, { origins: ["import"] }]) {
      expect(await w.fanout.processRendered(w.rendered(1, seq, { changed_people: ["I0005"], ...extra }))).toMatchObject({ status: "silent", reason: "import" });
    }
    // an entry-level marker, read back from the log range
    const entry = w.ddb.rows.get(`${logKey(1).PK}\u0000${seqKey(seq)}`);
    expect(entry).toBeDefined();
    w.ddb.rows.set(`${logKey(1).PK}\u0000${seqKey(seq)}`, { ...entry, import: true });
    expect(await w.fanout.processRendered(w.rendered(1, seq, { changed_people: ["I0005"], origins: ["desktop"] }))).toMatchObject({ status: "silent", reason: "import" });
    expect(await w.items("I0005")).toEqual([]);
    expect(w.notifier.onRecordChanged).not.toHaveBeenCalled();
  });

  it("a baseline pass (the first live pass of a mode) is silent: the site only came online", async () => {
    const w = world({ members: ["I0005"] });
    const seq = await seedPeople(w, [5]);
    const item = w.rendered(1, seq, { baseline: true, changed_people: ["I0005"], origins: ["desktop"], principals: ["svc"] });
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "silent", reason: "baseline" });
    expect(await w.items("I0005")).toEqual([]);
    expect(w.followersSpy).not.toHaveBeenCalled();
  });

  it("a malformed or empty outbox item does nothing", async () => {
    const w = world({ members: ["I0005"] });
    expect(await w.fanout.processRendered(undefined)).toEqual({ status: "invalid" });
    expect(await w.fanout.processRendered({ entity: "rendered", seq_to: "7" })).toEqual({ status: "invalid" });
    const seq = await seedPeople(w, [5]);
    expect((await w.fanout.processRendered(w.rendered(1, seq, { changed_people: [], origins: ["desktop"] }))).status).toBe("empty");
    expect((await w.fanout.processRendered(w.rendered(1, seq + 1, { changed_people: ["../x", 7, "bad id"], origins: ["desktop"] }))).status).toBe("empty");
  });
});

describe("exactly one notification per subject, across a replay and a crash", () => {
  async function selfEdit(w) {
    const seq = await seedPeople(w, [5, 2]);
    const r = await w.apply([update(person(5, { change: 1700000001 }), 1)], { origin: "self", principal: "I0002" });
    return w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["self"], principals: ["I0002"] });
  }

  it("a redelivered outbox item (the crash after commit, then the replay) notifies the owner and each follower once", async () => {
    const w = world({ members: ["I0005"] });
    await w.follow("F1", "I0005");
    const item = await selfEdit(w);
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 1 });
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "duplicate", delivered: 0 });
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "duplicate" });
    expect(await w.items("I0005")).toHaveLength(1);
    expect((await w.items("I0005"))[0]).toMatchObject({ type: "record_updated_mine", count: 1 });
    expect(await w.items("F1")).toHaveLength(1);
    expect(w.notifier.onRecordChanged).toHaveBeenCalledTimes(1);
    const marker = w.ddb.rows.get(`${markerKeys(item.seq_to, "person:I0005").PK}\u0000person:I0005`);
    expect(marker).toMatchObject({ dedupe: dedupeKey(item.seq_to, "person:I0005"), state: "done" });
    expect(marker.ttl).toBeGreaterThan(Math.floor(w.clock.t / 1000));
  });

  it("two consumers racing on one item deliver once", async () => {
    const w = world({ members: ["I0005"] });
    const item = await selfEdit(w);
    const out = await Promise.all([w.fanout.processRendered(item), w.fanout.processRendered(item)]);
    expect(out.map((o) => o.status).sort()).toEqual(["duplicate", "notified"]);
    expect(await w.items("I0005")).toHaveLength(1);
  });

  it("a delivery that throws gives its claims back, so the retry delivers (once)", async () => {
    const w = world({ members: ["I0005"] });
    const item = await selfEdit(w);
    w.notifier.onRecordChanged.mockImplementationOnce(async () => { throw new Error("process died"); });
    await expect(w.fanout.processRendered(item)).rejects.toThrow("process died");
    expect(w.rows("RECFAN#")).toEqual([]);
    expect(await w.items("I0005")).toEqual([]);
    expect((await w.fanout.processRendered(item)).status).toBe("notified");
    expect((await w.fanout.processRendered(item)).status).toBe("duplicate");
    expect(await w.items("I0005")).toHaveLength(1);
  });

  it("a consumer killed between the claim and the done mark: the retry waits out the lease, then delivers once", async () => {
    const w = world({ members: ["I0005"] });
    const item = await selfEdit(w);
    // The dead consumer's claim: written, never marked done.
    w.ddb.rows.set(`${markerKeys(item.seq_to, "person:I0005").PK}\u0000person:I0005`, {
      ...markerKeys(item.seq_to, "person:I0005"), entity: "recfan", state: "claimed", lease_until: w.clock.t + LEASE_MS, ttl: 9_999_999_999,
    });
    expect((await w.fanout.processRendered(item)).status).toBe("duplicate"); // the lease still holds
    w.clock.t += LEASE_MS + 1;
    expect((await w.fanout.processRendered(item)).status).toBe("notified");
    expect((await w.fanout.processRendered(item)).status).toBe("duplicate");
    expect(await w.items("I0005")).toHaveLength(1);
  });

  it("running out of time gives the claims back and fails the pass for a retry", async () => {
    const w = world({ members: ["I0005"] });
    const item = await selfEdit(w);
    await expect(w.fanout.processRendered(item, { remainingMs: () => 100 })).rejects.toThrow("fanout_out_of_time");
    expect(w.rows("RECFAN#")).toEqual([]);
    expect((await w.fanout.processRendered(item, { remainingMs: () => 10_000 })).status).toBe("notified");
  });

  it("a second outbox item for a later change notifies again (the key is rec:<seq>:<subject>)", async () => {
    const w = world({ members: ["I0005"] });
    const first = await selfEdit(w);
    await w.fanout.processRendered(first);
    const r = await w.apply([update(person(5, { change: 1700000002 }), 2)], { origin: "self", principal: "I0002" });
    const second = w.rendered(r.seq_from, r.seq_to, { changed_people: ["I0005"], origins: ["self"], principals: ["I0002"] });
    expect((await w.fanout.processRendered(second)).status).toBe("notified");
    const [only, ...rest] = await w.items("I0005");
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ type: "record_updated_mine", count: 2 }); // coalesced by group rec:person:I0005
  });
});

describe("owners and followers receive the right types (end to end over the fake store)", () => {
  it("a self-edit by one member: the owner gets record_updated_mine naming the actor, followers get record_updated_followed, the actor nothing", async () => {
    const w = world({ members: ["I0005", "I0002"] });
    await w.follow("F1", "I0005");
    await w.follow("I0002", "I0005"); // the actor follows the page they edit
    const seq = await seedPeople(w, [5, 2]);
    const r = await w.apply([update(person(5, { change: 1700000001 }), 1)], { origin: "self", principal: "I0002" });
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["self"], principals: ["I0002"] });
    await w.fanout.processRendered(item);
    expect(await w.items("I0005")).toEqual([expect.objectContaining({ type: "record_updated_mine", group: "rec:person:I0005", navigate: "/person/?id=I0005", fields: { actor: "Eve" } })]);
    expect(await w.items("F1")).toEqual([expect.objectContaining({ type: "record_updated_followed", navigate: "/person/?id=I0005", fields: { subject: "Pat" } })]);
    expect(await w.items("I0002")).toEqual([]);
    const [changes, opts] = w.calls[0];
    expect(changes).toEqual([{ subject: "person:I0005", subjectLabel: "Pat", actor: { id: "I0002", label: "Eve" }, source: "self_edit" }]);
    expect(opts).toEqual({ silent: false, import: false, seed: false });
  });

  it("the owner editing their own page is not told; a non-member owner gets nothing; two actors in one pass name nobody", async () => {
    const w = world({ members: ["I0005"] });
    await w.follow("F1", "I0004");
    const seq = await seedPeople(w, [5, 4]);
    const a = await w.apply([update(person(5, { change: 1 }), 1)], { origin: "self", principal: "I0005" });
    await w.fanout.processRendered(w.rendered(seq + 1, a.seq_to, { changed_people: ["I0005"], origins: ["self"], principals: ["I0005"] }));
    expect(await w.items("I0005")).toEqual([]);
    const b = await w.apply([update(person(4, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    const c = await w.apply([update(person(5, { change: 2 }), 2)], { origin: "self", principal: "I0002" });
    await w.fanout.processRendered(w.rendered(b.seq_from, c.seq_to, { changed_people: ["I0004", "I0005"], origins: ["admin", "self"], principals: ["I0002", "I0099"] }));
    expect(await w.types("I0004")).toEqual([]); // I0004 is not a member
    expect(await w.types("F1")).toEqual(["record_updated_followed"]);
    expect((await w.items("I0005"))[0].fields.actor).toBeUndefined();
    expect(w.calls.at(-1)[0].every((x) => x.actor === null && x.source === "mixed")).toBe(true);
  });

  it("a follower with more than 3 followed pages gets one digest; more than 50 subjects degrade to digests instead of a refusal", async () => {
    const w = world({ members: [] });
    const ids = [10, 11, 12, 13];
    for (const n of ids) await w.follow("F1", gid(n));
    const seq = await seedPeople(w, ids);
    const r = await w.apply(ids.map((n) => update(person(n, { change: 1 }), 1)), { origin: "admin", principal: "I0099" });
    await w.fanout.processRendered(w.rendered(seq + 1, r.seq_to, { changed_people: ids.map(gid), origins: ["admin"], principals: ["I0099"] }));
    expect(await w.types("F1")).toEqual(["records_updated_followed_digest"]);

    const big = world({ members: ["I0500"] });
    await big.follow("F9", "I0500");
    await big.follow("F9", "I0501");
    const many = Array.from({ length: 60 }, (_, i) => gid(500 + i));
    await big.apply(many.slice(0, 24).map((id, i) => create(person(500 + i))));
    await big.apply(many.slice(24, 48).map((id, i) => create(person(524 + i))));
    const s2 = await big.apply(many.slice(48).map((id, i) => create(person(548 + i))));
    const r2 = await big.apply(many.slice(0, 24).map((id, i) => update(person(500 + i, { change: 1 }), 1)), { origin: "admin", principal: "I0099" });
    await big.fanout.processRendered(big.rendered(s2.seq_to, r2.seq_to, { changed_people: many, origins: ["admin"], principals: ["I0099"] }));
    expect(await big.types("F9")).toEqual(["records_updated_followed_digest"]);
    expect(await big.types("I0500")).toEqual(["record_updated_mine"]);
  });

  it("a tag commit (origin tag): the tagger is credited, and the tagged person's owner and followers are notified from the outbox", async () => {
    const w = world({ members: ["I0004"] });
    await w.follow("F1", "I0004");
    const seq = await seedPeople(w, [4]);
    const r = await w.apply([update(person(4, { media_list: [ref(1)], change: 1 }), 1)], { origin: "tag", principal: "I0007" });
    expect(w.rows("CONTRIB#I0007").filter((x) => x.kind === "tag")).toHaveLength(1);
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0004"], origins: ["tag"], principals: ["I0007"] });
    await w.fanout.processRendered(item);
    expect(await w.items("I0004")).toEqual([expect.objectContaining({ type: "record_updated_mine", fields: { actor: "Sam" } })]);
    expect(await w.types("F1")).toEqual(["record_updated_followed"]);
    expect(w.calls[0][0][0].source).toBe("tag");
  });

  it("recipients are gated by recordSubsV1: only flagged recipients (the uat group) are told until the flip", async () => {
    const w = world({ members: ["I0005", "I0012"], flag: (name, p) => name === "recordSubsV1" ? p === "I0005" || p === "F2" : true });
    await w.follow("F1", "I0005");
    await w.follow("F2", "I0005");
    const seq = await seedPeople(w, [5, 12]);
    const r = await w.apply([update(person(5, { change: 1 }), 1), update(person(12, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    await w.fanout.processRendered(w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005", "I0012"], origins: ["admin"], principals: ["I0099"] }));
    expect(await w.types("I0005")).toEqual(["record_updated_mine"]);
    expect(await w.types("I0012")).toEqual([]);
    expect(await w.types("F1")).toEqual([]);
    expect(await w.types("F2")).toEqual(["record_updated_followed"]);
  });

  it("a flag read that fails is a retryable failure, not 'off': nothing is marked done, and the retry delivers once", async () => {
    let down = true;
    const w = world({ members: ["I0005"], flag: () => { if (down) throw new Error("flags down"); return true; } });
    const seq = await seedPeople(w, [5]);
    const r = await w.apply([update(person(5, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["admin"], principals: ["I0099"] });
    await expect(w.fanout.processRendered(item)).rejects.toThrow("fanout_delivery_failed");
    expect(w.rows("RECFAN#")).toEqual([]);
    expect(await w.items("I0005")).toEqual([]);
    down = false;
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 1 });
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "duplicate" });
    expect(await w.items("I0005")).toHaveLength(1);
  });

  it("the flag answer is read once per recipient per window, not once per pass per member", async () => {
    const reads = vi.fn(() => true);
    const w = world({ members: ["I0005"], flag: (name, p) => (name === "recordSubsV1" ? reads(p) : true) });
    await w.follow("F1", "I0005");
    const seq = await seedPeople(w, [5]);
    for (const n of [1, 2]) {
      const r = await w.apply([update(person(5, { change: n }), n)], { origin: "admin", principal: "I0099" });
      await w.fanout.processRendered(w.rendered(r.seq_from, r.seq_to, { changed_people: ["I0005"], origins: ["admin"], principals: ["I0099"] }));
    }
    expect(seq).toBeGreaterThan(0);
    expect(reads.mock.calls.filter(([p]) => p === "I0005")).toHaveLength(1);
    expect(reads.mock.calls.filter(([p]) => p === "F1")).toHaveLength(1);
    expect(await w.items("I0005")).toHaveLength(1);
  });
});

describe("a delivery the real notifier could not make is not marked done", () => {
  const failingInbox = () => {
    const store = new InMemoryNotificationStore();
    const state = { fail: true };
    const add = store.add.bind(store);
    store.add = async (...a) => { if (state.fail) throw new Error("inbox down"); return add(...a); };
    return { store, state };
  };
  async function ownerEdit(w) {
    const seq = await seedPeople(w, [5]);
    const r = await w.apply([update(person(5, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    return w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["admin"], principals: ["I0099"] });
  }

  it("a failing inbox store releases the claims and fails the pass; the retry delivers once", async () => {
    const { store, state } = failingInbox();
    const w = world({ members: ["I0005"], inbox: store });
    const item = await ownerEdit(w);
    await expect(w.fanout.processRendered(item)).rejects.toThrow("fanout_delivery_failed");
    expect(w.rows("RECFAN#")).toEqual([]); // released, not done
    state.fail = false;
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 1 });
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "duplicate" });
    expect(await w.items("I0005")).toHaveLength(1);
  });

  it("a failing follower lookup is a failure too (a lost follower notification is not 'sent')", async () => {
    const w = world({ members: ["I0005"] });
    const item = await ownerEdit(w);
    w.followersSpy.mockRejectedValueOnce(new Error("gsi down"));
    await expect(w.fanout.processRendered(item)).rejects.toThrow("fanout_delivery_failed");
    expect(w.rows("RECFAN#")).toEqual([]);
    expect((await w.fanout.processRendered(item)).status).toBe("notified");
  });

  it("with no push and no inbox configured nothing is sent and nothing is marked done: the pass ends 'inactive', without a retry loop, and a replay delivers once configured", async () => {
    const w = world({ members: ["I0005"], noInbox: true });
    const item = await ownerEdit(w);
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "inactive", delivered: 0 });
    expect(w.rows("RECFAN#")).toEqual([]);
    const live = world({ members: ["I0005"] }); // the same pass once an inbox exists
    const again = await ownerEdit(live);
    expect((await live.fanout.processRendered(again)).status).toBe("notified");
  });
});

describe("claims: every in-flight Put settles before any claim is given back", () => {
  async function twoOwners(w) {
    const seq = await seedPeople(w, [5, 12]);
    const r = await w.apply([update(person(5, { change: 1 }), 1), update(person(12, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    return w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005", "I0012"], origins: ["admin"], principals: ["I0099"] });
  }

  it("one claim rejecting while another is still pending: the late claim is released too, and the retry delivers both", async () => {
    const w = world({ members: ["I0005", "I0012"] });
    const item = await twoOwners(w);
    const send = w.ddb.send.bind(w.ddb);
    let broken = true;
    w.ddb.send = async (cmd) => {
      const it = cmd?.input?.Item;
      if (broken && it?.entity === "recfan") {
        if (it.SK === "person:I0005") throw new Error("throttled");
        await new Promise((r) => setTimeout(r, 25)); // lands after the sibling failed
      }
      return send(cmd);
    };
    await expect(w.fanout.processRendered(item)).rejects.toThrow("throttled");
    expect(w.rows("RECFAN#")).toEqual([]); // the late Put landed, then was given back: no live claim blocks the retry
    broken = false;
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 2 });
    expect(await w.items("I0005")).toHaveLength(1);
    expect(await w.items("I0012")).toHaveLength(1);
  });

  it("a release only deletes the claim its own call made", async () => {
    const w = world({ members: ["I0005", "I0012"] });
    const item = await twoOwners(w);
    // another consumer's live claim on one subject
    w.ddb.rows.set(`${markerKeys(item.seq_to, "person:I0012").PK}\u0000person:I0012`, {
      ...markerKeys(item.seq_to, "person:I0012"), entity: "recfan", state: "claimed", lease_until: w.clock.t + LEASE_MS, owner: "other", ttl: 9_999_999_999,
    });
    w.notifier.onRecordChanged.mockImplementationOnce(async () => { throw new Error("boom"); });
    await expect(w.fanout.processRendered(item)).rejects.toThrow("boom");
    expect(w.rows("RECFAN#")).toEqual([expect.objectContaining({ SK: "person:I0012", owner: "other" })]);
  });
});

describe("large passes are chunked, never truncated", () => {
  const ids = [5, 12, 20, 21, 22, 23, 24];
  async function bigPass(w) {
    const seq = await seedPeople(w, ids);
    const r = await w.apply(ids.map((n) => update(person(n, { change: 1 }), 1)), { origin: "admin", principal: "I0099" });
    return w.rendered(seq + 1, r.seq_to, { changed_people: ids.map(gid), origins: ["admin"], principals: ["I0099"] });
  }

  it("every subject gets its notification: one claim-deliver-done round per chunk", async () => {
    const w = world({ members: ids.map(gid), chunkSize: 3 });
    const item = await bigPass(w);
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 7, subjects: 7, chunks: 3 });
    expect(w.notifier.onRecordChanged).toHaveBeenCalledTimes(3);
    for (const n of ids) expect(await w.types(gid(n))).toEqual(["record_updated_mine"]);
    expect(w.rows("RECFAN#").every((r) => r.state === "done")).toBe(true);
  });

  it("a failure in chunk 2 keeps chunk 1 done: the retry delivers chunks 2 and 3 only, each owner once", async () => {
    const w = world({ members: ids.map(gid), chunkSize: 3 });
    const item = await bigPass(w);
    const real = w.notifier.onRecordChanged.getMockImplementation();
    let n = 0;
    w.notifier.onRecordChanged.mockImplementation(async (...a) => { n += 1; if (n === 2) throw new Error("chunk 2 failed"); return real(...a); });
    await expect(w.fanout.processRendered(item)).rejects.toThrow("chunk 2 failed");
    expect(w.rows("RECFAN#").filter((r) => r.state === "done")).toHaveLength(3);
    expect(w.rows("RECFAN#").filter((r) => r.state !== "done")).toEqual([]);
    expect(await w.fanout.processRendered(item)).toMatchObject({ status: "notified", delivered: 4 });
    for (const x of ids) expect(await w.items(gid(x))).toHaveLength(1);
  });
});

describe("withdraws are silent and delete the subject's follows", () => {
  const spousesWorld = async (members = ["I0010", "I0011", "I0012"]) => {
    const w = world({ members });
    const fam = family(1, { father_handle: h(10), mother_handle: h(11) });
    const seq = (await w.apply([
      create(person(10, { family_list: [fam.handle] })), create(person(11, { family_list: [fam.handle] })), create(person(12, { note_list: [note(1).handle] })), create(fam), create(note(1)),
    ])).seq_to;
    return { w, seq };
  };

  it("withdrawing a person notifies neither them, their spouse (whose page changed only because of it) nor any follower, and deletes the person's RSUB# items", async () => {
    const { w, seq } = await spousesWorld();
    await w.follow("F1", "I0010");
    await w.follow("F2", "I0010");
    await w.follow("F3", "I0011");
    const r = await w.apply([withdraw(person(10), 1)]);
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0011"], deleted_people: ["I0010"], origins: ["desktop"], principals: ["svc"] });
    expect(w.rows("RSUB#").filter((x) => x.subject === "person:I0010")).toHaveLength(2);
    const out = await w.fanout.processRendered(item);
    expect(out).toMatchObject({ status: "empty", swept: 2 });
    expect(w.rows("RSUB#").filter((x) => x.subject === "person:I0010")).toEqual([]);
    expect(w.rows("RSUB#").filter((x) => x.subject === "person:I0011")).toHaveLength(1); // other follows stay
    for (const p of ["I0010", "I0011", "F1", "F2", "F3"]) expect(await w.items(p), p).toEqual([]);
    expect(w.notifier.onRecordChanged).not.toHaveBeenCalled();
    expect(w.rows("RECFAN#")).toEqual([]);
  });

  it("withdrawing a note a page was built from is silent for that page's owner and followers", async () => {
    const { w, seq } = await spousesWorld();
    await w.follow("F1", "I0012");
    const r = await w.apply([withdraw(note(1), 1)]);
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0012"], origins: ["desktop"], principals: ["svc"] });
    expect((await w.fanout.processRendered(item)).status).toBe("empty");
    expect(await w.items("I0012")).toEqual([]);
    expect(await w.items("F1")).toEqual([]);
  });

  it("a withdraw does not silence a real change to the same page in the same range", async () => {
    const { w, seq } = await spousesWorld();
    await w.follow("F1", "I0012");
    const a = await w.apply([withdraw(note(1), 1)]);
    const b = await w.apply([update(person(12, { note_list: [note(1).handle], change: 5 }), 1)], { origin: "admin", principal: "I0099" });
    const item = w.rendered(seq + 1, b.seq_to, { changed_people: ["I0012"], origins: ["desktop", "admin"], principals: ["I0099", "svc"] });
    expect(a.seq_to).toBeLessThan(b.seq_to);
    expect((await w.fanout.processRendered(item)).status).toBe("notified");
    expect(await w.types("I0012")).toEqual(["record_updated_mine"]);
    expect(await w.types("F1")).toEqual(["record_updated_followed"]);
  });

  it("follows are deleted even when notifications are off for everyone, and again on a replay (idempotent)", async () => {
    const { w, seq } = await spousesWorld([]);
    await w.follow("F1", "I0010");
    const r = await w.apply([withdraw(person(10), 1)]);
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: [], deleted_people: ["I0010"], origins: ["desktop"], principals: ["svc"] });
    await w.fanout.processRendered(item);
    expect(w.rows("RSUB#")).toEqual([]);
    expect(await w.fanout.processRendered(item)).toMatchObject({ swept: 0 });
  });

  it("a withdraw in a seed range is still swept", async () => {
    const { w, seq } = await spousesWorld();
    await w.follow("F1", "I0010");
    const r = await w.apply([withdraw(person(10), 1)], { origin: "seed" });
    const out = await w.fanout.processRendered(w.rendered(seq + 1, r.seq_to, { changed_people: ["I0011"], origins: ["seed"] }));
    expect(out).toMatchObject({ status: "silent", swept: 1 });
    expect(w.rows("RSUB#")).toEqual([]);
  });

  it("peopleReached maps like the renderer: a withdrawn person reaches the people of its families, and a person reached from elsewhere is terminal", async () => {
    const { w } = await spousesWorld();
    const r = await w.apply([withdraw(person(10), 1)]);
    expect(r.seq_to).toBeGreaterThan(0);
    const v = await storeView({ ddb: w.ddb, cmds, table: T, now: w.ctx.now });
    expect([...peopleReached(v, [`Person:${h(10)}`])]).toEqual(["I0011"]);
    expect([...peopleReached(v, [`Person:${h(11)}`])].sort()).toEqual(["I0011"]);
    expect([...peopleReached(v, [`Note:${note(1).handle}`])]).toEqual(["I0012"]);
    expect([...peopleReached(v, [`Family:${family(1).handle}`])]).toEqual(["I0011"]);
  });
});

describe("comments.list on a withdrawn person's thread", () => {
  it("is 404 for members and 200 for an admin; create, react and edit answer 404 too; other threads are untouched", async () => {
    const api = makeApi({ admins: ["I0099"] });
    const ctx = { ddb: api.ddb, cmds, table: "hfy-app", now: () => Date.parse("2026-10-14T10:00:00Z"), log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true };
    api.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
    await applyBatch(ctx, { principal: "svc", origin: "desktop", idempotencyKey: "k1", ops: [create(person(10)), create(person(11))] });
    const member = await signToken("I0002");
    const admin = await signToken("I0099");
    const post = (subject, token) => api.call("POST", "/api/comments", { token, body: { subject, body: "hello there" } });
    const before = await post("person:I0010", member);
    expect(before.status).toBe(201);
    expect((await api.call("GET", "/api/comments", { token: member, query: { subject: "person:I0010" } })).status).toBe(200);

    await applyBatch(ctx, { principal: "svc", origin: "desktop", idempotencyKey: "k2", ops: [withdraw(person(10), 1)] });
    const hidden = await api.call("GET", "/api/comments", { token: member, query: { subject: "person:I0010" } });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain("hello there");
    expect((await api.call("GET", "/api/comments", { token: admin, query: { subject: "person:I0010" } })).status).toBe(200);
    expect((await post("person:I0010", member)).status).toBe(404);
    expect((await api.call("POST", `/api/comments/${before.body.id}/react`, { token: member, body: { subject: "person:I0010", emoji: "👍" } })).status).toBe(404);
    expect((await api.call("PATCH", `/api/comments/${before.body.id}`, { token: member, body: { subject: "person:I0010", body: "edited text" } })).status).toBe(404);
    expect((await post("person:I0011", member)).status).toBe(201);
    expect((await api.call("GET", "/api/comments", { token: member, query: { subject: "person:I0011" } })).status).toBe(200);
    expect((await api.call("GET", "/api/comments", { token: member, query: { subject: "person:I0777" } })).status).toBe(200); // an id the store never held

    // The MCP tools are the same CommentSource (handler.invoke): hidden for a member, readable for an admin.
    const asMember = { id: "I0002", label: "Eve", admin: false };
    await expect(api.handler.invoke(asMember, "comments.list", { query: { subject: "person:I0010" } })).rejects.toMatchObject({ status: 404 });
    await expect(api.handler.invoke(asMember, "comments.create", { body: { subject: "person:I0010", body: "via mcp" } })).rejects.toMatchObject({ status: 404 });
    expect((await api.handler.invoke({ id: "I0099", label: "Ada", admin: true }, "comments.list", { query: { subject: "person:I0010" } })).status).toBe(200);
    // Delete is the one deliberate exception: it returns no content and only reduces what is stored, so an author can still take their own comment down.
    expect((await api.call("DELETE", `/api/comments/${before.body.id}`, { token: member, query: { subject: "person:I0010" } })).status).toBeLessThan(300);
    expect((await api.call("GET", "/api/comments", { token: admin, query: { subject: "person:I0010" } })).body.items ?? []).toEqual([]);
  });
});

describe("the triggers: stream records and a direct invoke", () => {
  const rec = (pk, sk, n) => ({ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { Keys: { PK: { S: pk }, SK: { S: sk } }, SequenceNumber: String(n) } });

  it("isStreamEvent and isReplayEvent never match a Function URL event", () => {
    expect(isStreamEvent({ Records: [rec("SYNC#RENDERED", "000000000001", 1)] })).toBe(true);
    expect(isStreamEvent({ Records: [rec("SYNC#RENDERED", "000000000001", 1)], requestContext: { http: {} } })).toBe(false);
    expect(isStreamEvent({ Records: [{ eventSource: "aws:sqs" }] })).toBe(false);
    expect(isStreamEvent({ Records: [] })).toBe(false);
    expect(isStreamEvent({ rawPath: "/api/x" })).toBe(false);
    expect(isStreamEvent(null)).toBe(false);
    expect(isReplayEvent({ source: "record-fanout", seq: 4 })).toBe(true);
    expect(isReplayEvent({ source: "record-fanout", seq: 4, requestContext: {} })).toBe(false);
    expect(isReplayEvent({ source: "aws.events" })).toBe(false);
  });

  it("handleStream processes SYNC#RENDERED inserts, ignores other keys and a TTL-expired item, and reports a failed record by its sequence number", async () => {
    const w = world({ members: ["I0005"] });
    const seq = await seedPeople(w, [5]);
    const r = await w.apply([update(person(5, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    const item = w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["admin"], principals: ["I0099"] });
    const out = await w.fanout.handleStream({ Records: [rec("SYNC#LOG", seqKey(1), 1), rec("SYNC#RENDERED", seqKey(999), 2), rec("SYNC#RENDERED", item.SK, 3), rec("SYNC#RENDERED", "bad", 4)] });
    expect(out).toEqual({ batchItemFailures: [] });
    expect(await w.types("I0005")).toEqual(["record_updated_mine"]);
    // the same record again: nothing more is sent
    await w.fanout.handleStream({ Records: [rec("SYNC#RENDERED", item.SK, 5)] });
    expect(await w.items("I0005")).toHaveLength(1);

    const w2 = world({ members: ["I0005"] });
    const s2 = await seedPeople(w2, [5]);
    const r2 = await w2.apply([update(person(5, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    const item2 = w2.rendered(s2 + 1, r2.seq_to, { changed_people: ["I0005"], origins: ["admin"] });
    w2.notifier.onRecordChanged.mockImplementationOnce(async () => { throw new Error("boom"); });
    const failed = await w2.fanout.handleStream({ Records: [rec("SYNC#RENDERED", item2.SK, 7)] });
    expect(failed).toEqual({ batchItemFailures: [{ itemIdentifier: "7" }] });
    expect(await w2.fanout.handleStream({ Records: [rec("SYNC#RENDERED", item2.SK, 7)] })).toEqual({ batchItemFailures: [] }); // the retry delivers
    expect(await w2.items("I0005")).toHaveLength(1);
  });

  it("handleInvoke replays one outbox item by seq, safely", async () => {
    const w = world({ members: ["I0005"] });
    const seq = await seedPeople(w, [5]);
    const r = await w.apply([update(person(5, { change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    w.rendered(seq + 1, r.seq_to, { changed_people: ["I0005"], origins: ["admin"] });
    expect(await w.fanout.handleInvoke({ source: "record-fanout", seq: r.seq_to })).toMatchObject({ status: "notified" });
    expect(await w.fanout.handleInvoke({ source: "record-fanout", seq: r.seq_to })).toMatchObject({ status: "duplicate" });
    expect(await w.fanout.handleInvoke({ source: "record-fanout", seq: 4040 })).toEqual({ status: "missing" });
    await expect(w.fanout.handleInvoke({ source: "record-fanout", seq: "1" })).rejects.toMatchObject({ code: "validation" });
    expect(await w.items("I0005")).toHaveLength(1);
  });
});

describe("createFanoutNotifier keeps the producer contract", () => {
  it("is a notifier whose onRecordChanged is the render-outbox entry point and which still swallows its own failures", async () => {
    const n = createFanoutNotifier({ inbox: new InMemoryNotificationStore(), featureOn: async () => true, listMembers: async () => { throw new Error("down"); }, log: { error() {} } });
    await expect(n.onRecordChanged([{ subject: "person:I0005", actor: null }])).resolves.toEqual({ error: true, lost: 1 }); // never throws; it reports
    expect(typeof createNotifier).toBe("function");
  });
});

describe("wiring (index.js)", () => {
  it("hands stream and replay events to the consumer before the origin check, and registers the contributor once at load", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    expect(src.indexOf("isStreamEvent(event)")).toBeGreaterThan(-1);
    expect(src.indexOf("isStreamEvent(event)")).toBeLessThan(src.indexOf("originVerified(event"));
    expect(src.indexOf("isReplayEvent(event)")).toBeLessThan(src.indexOf("originVerified(event"));
    expect(src).toMatch(/registerRecordContributor\(\{ ddb, cmds, table \}\);/);
    expect(src).toMatch(/createFanoutNotifier\(/);
    // handler.js never builds a record-change notification, and the contributor is registered nowhere else
    expect(readFileSync(new URL("../src/handler.js", import.meta.url), "utf8")).not.toMatch(/registerRecordContributor|createRecordFanout/);
  });

  it("the handler answers a stream event without the origin secret and a Function URL event without it with 403", async () => {
    process.env.ORIGIN_VERIFY = "wiring-secret";
    const { handler } = await import("../src/index.js");
    const url = await handler({ requestContext: { http: { method: "GET" } }, rawPath: "/api/comments", headers: {} });
    expect(url.statusCode).toBe(403);
    // A well-formed stream record for a missing outbox item is skipped (no table in this process: the read fails and the record is reported).
    const out = await handler({ Records: [{ eventSource: "aws:dynamodb", dynamodb: { Keys: { PK: { S: "SYNC#LOG" }, SK: { S: "000000000001" } }, SequenceNumber: "1" } }] }, { getRemainingTimeInMillis: () => 5000 });
    expect(out).toEqual({ batchItemFailures: [] }); // another key: ignored without any store call
  });
});
