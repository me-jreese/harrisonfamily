// HFY-TSK-178 (hfy-record-change-fanout): the one registered contributor that adds the self_edit and tag contribution ops inside applyBatch's
// own transaction. In-memory DynamoDB fake; synthetic ids and objects only.
import { describe, it, expect, vi } from "vitest";
import { createFakeDdb, cmds } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry, defaultHooks } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { createRecordContributor, deriveUlid, registerRecordContributor, tagChanges } from "../src/record-contributor.js";

const T = "hfy-app";
const h = (n) => n.toString(16).padStart(28, "0");
const ME = "I0002";
const REGION = [10, 10, 40, 40];
const ref = (n, rect = REGION) => ({ _class: "MediaRef", ref: h(5000 + n), rect, citation_list: [], note_list: [], attribute_list: [], private: false });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1700000000, private: false, gender: 1, media_list: [], ...extra });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const update = (obj, base) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj });
const del = (obj, base) => ({ op: "delete", class: obj._class, handle: obj.handle, base_version: base });

function world({ hooks = createHookRegistry(), register = true } = {}) {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false });
  const clock = { t: Date.parse("2026-10-14T10:00:00Z") };
  const ctx = { ddb, cmds, table: T, now: () => clock.t, hooks, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true };
  let k = 0;
  const apply = (ops, o = {}) => applyBatch(ctx, { principal: ME, origin: "self", idempotencyKey: `key-${++k}`, ops, ...o });
  if (register) registerRecordContributor({ ddb, cmds, table: T }, hooks);
  const rows = (prefix) => ddb.all().filter((r) => r.PK.startsWith(prefix));
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const events = (who = ME) => rows(`CONTRIB#${who}`).filter((r) => r.entity === "contrib");
  const total = (who) => row(who ? `CSTAT#person:${who}` : "CSTAT#site", "TOTAL");
  return { ddb, ctx, apply, rows, row, events, total, clock, hooks };
}

describe("self_edit: origin self, once per record per UTC day", () => {
  it("credits one self_edit event for the member's own record, with the counters, in the batch's own transaction", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    const sent = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => { sent.push(c.constructor.name); return send(c); } };
    const r = await w.apply([update(person(2, { change: 1700000001 }), 1)]);
    expect(sent.filter((n) => n === "TransactWriteCommand")).toHaveLength(1);
    const [e] = w.events();
    expect(e).toMatchObject({ kind: "self_edit", subject: `person:${ME}`, ref: { type: "record", id: ME }, weight: 1, via: "ui", at: "2026-10-14T10:00:00.000Z", actor: { id: ME } });
    expect(w.total()).toMatchObject({ n: 1, n_self_edit: 1 });
    expect(w.total(ME)).toMatchObject({ n: 1, n_self_edit: 1 });
    expect(w.row("CSTAT#site", "D#2026-10-14").n).toBe(1);
    expect(w.row(`CONTRIB#${ME}`, `CAP#self_edit#person:${ME}#2026-10-14`)).toMatchObject({ entity: "contrib_cap" });
    expect(r.seq_from).toBe(2);
  });

  it("two saves on the same UTC day count once; a save the next day counts again", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(2, { change: 1 }), 1)]);
    w.clock.t = Date.parse("2026-10-14T23:59:59Z");
    await w.apply([update(person(2, { change: 2 }), 2)]);
    expect(w.events()).toHaveLength(1);
    expect(w.total(ME).n_self_edit).toBe(1);
    w.clock.t = Date.parse("2026-10-15T00:00:00Z");
    await w.apply([update(person(2, { change: 3 }), 3)]);
    expect(w.events()).toHaveLength(2);
    expect(w.total(ME).n_self_edit).toBe(2);
    expect(w.total().n_self_edit).toBe(2);
  });

  it("the credit and the cap are keyed on the Person the batch changed (a different Person than the principal's own is its own record), and an own-only Event batch counts for the member's own", async () => {
    const w = world();
    const event = { _class: "Event", handle: h(3000), gramps_id: "E0001", change: 1, private: false };
    await w.apply([create(person(2)), create(person(9)), create(event)], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(9, { change: 1 }), 1)]); // principal I0002 edits Person I0009
    await w.apply([update(person(9, { change: 2 }), 2)]); // same record, same day: capped
    await w.apply([update(person(2, { change: 1 }), 1)]); // their own Person: a different record, counts
    await w.apply([update({ ...event, change: 2 }, 1)]); // an own-only Event: credited to the member's own Person, capped by the line above
    expect(w.events().filter((e) => e.kind === "self_edit").map((e) => e.subject).sort()).toEqual(["person:I0002", "person:I0009"]);
    expect(w.rows("CONTRIB#I0002").filter((r) => r.entity === "contrib_cap").map((r) => r.SK).sort()).toEqual([
      "CAP#self_edit#person:I0002#2026-10-14", "CAP#self_edit#person:I0009#2026-10-14",
    ]);
  });

  it("another member's save is a separate record: the cap is per member and record", async () => {
    const w = world();
    await w.apply([create(person(2)), create(person(3))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(2, { change: 1 }), 1)]);
    await w.apply([update(person(3, { change: 1 }), 1)], { principal: "I0003" });
    expect(w.events("I0002")).toHaveLength(1);
    expect(w.events("I0003")).toHaveLength(1);
  });

  it("desktop pushes and the seed never credit, and admin, proposal, graduation and moderation batches earn no self_edit", async () => {
    const w = world({ register: false });
    const spy = vi.fn(createRecordContributor({ ddb: w.ddb, cmds, table: T }));
    w.hooks.registerContributor(spy);
    await w.apply([create(person(2))], { origin: "seed", principal: "svc" });
    await w.apply([update(person(2, { change: 1 }), 1)], { origin: "desktop", principal: ME });
    for (const origin of ["admin", "proposal", "graduation", "moderation"]) {
      const cur = w.row("REC#Person#" + h(2), "HEAD").version;
      await w.apply([update(person(2, { change: cur + 10 }), cur)], { origin });
    }
    expect(spy).toHaveBeenCalledTimes(6);
    expect(w.rows("CONTRIB#")).toHaveLength(0);
    expect(w.rows("CSTAT#")).toHaveLength(0);
  });

  it("the contributor runs once per committed batch (spy), and not at all for a replay of the stored receipt", async () => {
    const w = world({ register: false });
    const spy = vi.fn(createRecordContributor({ ddb: w.ddb, cmds, table: T }));
    w.hooks.registerContributor(spy);
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    spy.mockClear();
    const ops = [update(person(2, { change: 1 }), 1)];
    const first = await applyBatch(w.ctx, { principal: ME, origin: "self", idempotencyKey: "same", ops });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("self");
    const again = await applyBatch(w.ctx, { principal: ME, origin: "self", idempotencyKey: "same", ops });
    expect(again.replayed).toBe(true);
    expect(again.batch_id).toBe(first.batch_id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.events()).toHaveLength(1);
  });

  it("a lost seq race rebuilds the item set with the same event: one event, one count", async () => {
    const w = world();
    await w.apply([create(person(2)), create(person(3))], { origin: "desktop", principal: "svc" });
    const send = w.ddb.send.bind(w.ddb);
    let raced = false;
    w.ctx.ddb = { ...w.ddb, send: async (c) => {
      if (!raced && c.constructor.name === "TransactWriteCommand") { raced = true; await applyBatch({ ...w.ctx, ddb: w.ddb }, { principal: "svc", origin: "desktop", idempotencyKey: "race", ops: [update(person(3, { change: 9 }), 1)] }); }
      return send(c);
    } };
    await w.apply([update(person(2, { change: 1 }), 1)]);
    expect(raced).toBe(true);
    expect(w.events()).toHaveLength(1);
    expect(w.total().n_self_edit).toBe(1);
  });

  it("a batch that loses (stale base_version) credits nothing: the counters are transactional", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await expect(w.apply([update(person(2, { change: 1 }), 7)])).rejects.toMatchObject({ code: "version_conflict" });
    expect(w.rows("CONTRIB#")).toHaveLength(0);
    expect(w.rows("CSTAT#")).toHaveLength(0);
  });

  it("a principal the ledger cannot hold is skipped, never a failed write", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await expect(w.apply([update(person(2, { change: 1 }), 1)], { principal: "a#b" })).resolves.toMatchObject({ replayed: false });
    expect(w.rows("CONTRIB#")).toHaveLength(0);
  });

  it("a failed cap read counts the save (the marker Put has no condition, so the worst case is a benign double count)", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    const send = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => { if (c.constructor.name === "GetCommand" && c.input.Key.SK.startsWith("CAP#")) throw new Error("store down"); return send(c); } };
    await w.apply([update(person(2, { change: 1 }), 1)]);
    expect(w.events()).toHaveLength(1);
  });
});

describe("tag: a person-region MediaRef added, moved or removed, from a web origin", () => {
  it("tagChanges reads the region elements the other side lacks", () => {
    const a = ref(1);
    const moved = ref(1, [11, 11, 41, 41]);
    const plain = ref(2, null);
    expect(tagChanges({ op: "update", class: "Person", before: person(2), after: person(2, { media_list: [a] }) })).toEqual([a]); // add
    expect(tagChanges({ op: "update", class: "Person", before: person(2, { media_list: [a] }), after: person(2, { media_list: [moved] }) })).toEqual([a, moved]); // change
    expect(tagChanges({ op: "update", class: "Person", before: person(2, { media_list: [a] }), after: person(2) })).toEqual([a]); // remove
    expect(tagChanges({ op: "update", class: "Person", before: person(2), after: person(2, { media_list: [plain] }) })).toEqual([]); // a photo on the page, no region
    expect(tagChanges({ op: "update", class: "Person", before: person(2, { media_list: [a] }), after: person(2, { media_list: [a], change: 5 }) })).toEqual([]); // unchanged
    expect(tagChanges({ op: "delete", class: "Person", before: person(2, { media_list: [a] }), after: null })).toEqual([]);
    expect(tagChanges(undefined)).toEqual([]);
    // only the Person class carries a person tag: a crop on an Event's media list is not one
    expect(tagChanges({ op: "update", class: "Event", before: { media_list: [] }, after: { media_list: [a] } })).toEqual([]);
  });

  it("a region on a non-Person object credits nothing and a batch's tag subject is always a Person", async () => {
    const w = world();
    const event = { _class: "Event", handle: h(3000), gramps_id: "E0001", change: 1, private: false, media_list: [] };
    await w.apply([create(event), create(person(4))], { origin: "desktop", principal: "svc" });
    await w.apply([update({ ...event, media_list: [ref(1)], change: 2 }, 1)], { origin: "tag", principal: "I0007" });
    expect(w.events("I0007")).toHaveLength(0);
    await w.apply([update({ ...event, media_list: [ref(1)], change: 3 }, 2), update(person(4, { media_list: [ref(1)], change: 1 }), 1)], { origin: "tag", principal: "I0007" });
    expect(w.events("I0007")).toEqual([expect.objectContaining({ kind: "tag", subject: "person:I0004" })]);
  });

  it("origin tag: one tag event for the commit (weight 1, subject the tagged person), whether the tag is added, changed or removed", async () => {
    const w = world();
    await w.apply([create(person(4))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(4, { media_list: [ref(1)], change: 1 }), 1)], { origin: "tag", principal: "I0007" });
    await w.apply([update(person(4, { media_list: [ref(1, [12, 12, 42, 42])], change: 2 }), 2)], { origin: "tag", principal: "I0007" });
    await w.apply([update(person(4, { media_list: [], change: 3 }), 3)], { origin: "tag", principal: "I0007" });
    const ev = w.events("I0007");
    expect(ev).toHaveLength(3); // no daily cap on tags
    for (const e of ev) expect(e).toMatchObject({ kind: "tag", weight: 1, subject: "person:I0004", ref: { type: "tag" }, actor: { id: "I0007" } });
    expect(w.total("I0007")).toMatchObject({ n: 3, n_tag: 3 });
    expect(w.total().n_tag).toBe(3);
    expect(w.events("I0007").some((e) => e.kind === "self_edit")).toBe(false); // origin tag is not a self-edit
  });

  it("origin tag with no region change credits nothing; a self batch with a tag credits the self_edit and the tag", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(2, { change: 1 }), 1)], { origin: "tag", principal: "I0007" });
    expect(w.events("I0007")).toHaveLength(0);
    await w.apply([update(person(2, { media_list: [ref(1)], change: 2 }), 2)]);
    expect(w.events().map((e) => e.kind).sort()).toEqual(["self_edit", "tag"]);
    expect(w.total(ME)).toMatchObject({ n: 2, n_self_edit: 1, n_tag: 1 });
    expect(w.total()).toMatchObject({ n: 2 });
  });

  it("from any web origin: an admin's tag credits the admin, an approved proposal's tag credits the proposer (never the approver); graduation and moderation credit nothing here", async () => {
    const w = world();
    await w.apply([create(person(4))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(4, { media_list: [ref(1)], change: 1 }), 1)], { origin: "admin", principal: "I0099" });
    await w.apply([update(person(4, { media_list: [ref(1), ref(2)], change: 2 }), 2)], { origin: "proposal", principal: "I0099", onBehalfOf: "I0008" });
    await w.apply([update(person(4, { media_list: [ref(1), ref(2), ref(3)], change: 3 }), 3)], { origin: "graduation", principal: "I0099" });
    await w.apply([update(person(4, { media_list: [ref(1), ref(2), ref(3), ref(4)], change: 4 }), 4)], { origin: "moderation", principal: "I0099" });
    expect(w.events("I0099").map((e) => e.kind)).toEqual(["tag"]); // the admin's own tag only; no self_edit, no credit for approving
    expect(w.events("I0008").map((e) => e.kind)).toEqual(["tag"]); // the proposer
    expect(w.total().n_tag).toBe(2);
  });

  it("a desktop push that adds a region credits nothing", async () => {
    const w = world();
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(2, { media_list: [ref(1)], change: 1 }), 1)], { origin: "desktop", principal: "I0007" });
    expect(w.rows("CONTRIB#")).toHaveLength(0);
  });

  it("deleting a person who carried tags is not a tag commit", async () => {
    const w = world();
    await w.apply([create(person(2, { media_list: [ref(1)] }))], { origin: "desktop", principal: "svc" });
    await w.apply([del(person(2), 1)], { origin: "tag", principal: "I0007" });
    expect(w.events("I0007")).toHaveLength(0);
  });
});

describe("registration and event ids", () => {
  it("registers once per registry: a second call returns the first remover, so one event is never written twice into a transaction", async () => {
    const w = world();
    const second = registerRecordContributor({ ddb: w.ddb, cmds, table: T }, w.hooks);
    expect(w.hooks.contributors()).toHaveLength(1);
    await w.apply([create(person(2))], { origin: "desktop", principal: "svc" });
    await w.apply([update(person(2, { change: 1 }), 1)]);
    expect(w.events()).toHaveLength(1);
    second();
    expect(w.hooks.contributors()).toHaveLength(0);
    const again = registerRecordContributor({ ddb: w.ddb, cmds, table: T }, w.hooks);
    expect(w.hooks.contributors()).toHaveLength(1);
    again();
  });

  it("the process-wide registry stays empty until something registers on it", () => {
    expect(defaultHooks.contributors()).toEqual([]);
  });

  it("deriveUlid is a valid ULID, stable for one seed and different for another", () => {
    const at = Date.parse("2026-10-14T10:00:00Z");
    const a = deriveUlid(at, "batch:self_edit");
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(deriveUlid(at, "batch:self_edit")).toBe(a);
    expect(deriveUlid(at, "batch:tag")).not.toBe(a);
    expect(deriveUlid(at + 1, "batch:self_edit").slice(0, 10)).not.toBe(a.slice(0, 10));
  });
});
