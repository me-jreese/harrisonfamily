// HFY-TSK-426 (lifeStateV1, display only): On this day on the shared life-state rule. A birth line ("turns n this year", "born n years ago") is left out for a person
// whose status is unknown (no death recorded, no activity evidence in 24 months, born more than 85 years ago). Flag off, the answer is exactly today's. Synthetic data only.
import { beforeEach, describe, expect, it } from "vitest";
import { cmds, createUlidFactory, makeApi, signToken, TABLE } from "./world.js";
import { TYPE, buildIndex } from "../src/onthisday/build.js";
import { selectOnThisDay } from "../src/onthisday/select.js";
import { yearOnly, withLifeState } from "../src/onthisday/service.js";
import { buildEvent } from "../src/contrib.js";

const T0 = Date.UTC(2027, 9, 13, 12, 0, 0);
const ADMIN = "I0099";
const ulid = createUlidFactory();
const person = (n, lifeState) => ({ grampsId: `ITEST${n}`, displayName: `Test Person ${String.fromCharCode(64 + n)}`, lifeState, private: false });
const birth = (n, year) => ({ handle: `b${n}`, typeCode: TYPE.BIRTH, date: { year, modifier: 0, quality: 0 }, participants: [{ grampsId: `ITEST${n}`, role: "Primary" }], place: "", description: "", private: false });
// 2027: born 1927 is 100 (over the 85 year threshold, still celebrated today), born 1957 is 70.
const source = (rows) => ({
  async version() { return "etag-1"; },
  async snapshot() { return { version: "etag-1", events: rows.map(([n, y]) => birth(n, y)), persons: rows.map(([n, , s]) => person(n, s)) }; },
});
const DATE = "2027-10-13";

function world({ rows, flags = { onThisDay: true, lifeStateV1: true }, intercept, members = ["ITEST1", "ITEST2", "ITEST3"] }) {
  return makeApi({ admins: [ADMIN], flags, clock: () => T0, intercept, extraDeps: { onThisDaySource: source(rows), listMembers: async () => new Set(members) } });
}
const items = async (w, token) => (await w.call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined })).body.items.map((i) => i.id).sort();
const event = (w, who, at) => w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: buildEvent({ actor: { id: who }, kind: "post", ref: { type: "post", id: "p1" }, at, id: ulid(Date.parse(at)) }) }));

describe("On this day with lifeStateV1", () => {
  let token;
  beforeEach(async () => { token = await signToken("ITEST9"); });
  // ITEST1 is 100 and published as living, ITEST2 is 70 and published as living, ITEST3 is 100 and deceased.
  const ROWS = [[1, 1927, "living"], [2, 1957, "living"]];

  it("flag off: both birth lines, exactly as before (golden)", async () => {
    const w = world({ rows: ROWS, flags: { onThisDay: true } });
    const r = await w.call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined });
    const sorted = [...r.body.items].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sorted).toEqual([
      { id: "birth:ITEST1", kind: "birth", tone: "celebrate", when: "year", n: 100, year: 1927, people: [{ grampsId: "ITEST1", name: "Test Person A", lifeState: "living" }] },
      { id: "birth:ITEST2", kind: "birth", tone: "celebrate", when: "year", n: 70, year: 1957, people: [{ grampsId: "ITEST2", name: "Test Person B", lifeState: "living" }] },
    ]);
    expect(r.body).toMatchObject({ date: DATE, tier: "year", posts: [], prompt: null, stale: false });
  });

  it("flag off is the same answer as the selector on the stored index; the flag key present but false changes nothing", async () => {
    const a = await world({ rows: ROWS, flags: { onThisDay: true } }).call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined });
    const b = await world({ rows: ROWS, flags: { onThisDay: true, lifeStateV1: false } }).call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined });
    const snap = await source(ROWS).snapshot();
    const { report, ...index } = buildIndex(snap, { policyVersion: null, generatedAt: null }); // eslint-disable-line no-unused-vars
    expect(a.body).toEqual(b.body);
    expect(a.body.items).toEqual(selectOnThisDay(yearOnly(index), { date: DATE }).items);
  });

  it("flag on: a person of unknown status loses the birthday line, a younger person keeps it", async () => {
    expect(await items(world({ rows: ROWS }), token)).toEqual(["birth:ITEST2"]);
  });

  it("flag on: activity within 24 months keeps the line, activity at 25 months does not", async () => {
    const w1 = world({ rows: ROWS });
    await event(w1, "ITEST1", "2026-03-01T00:00:00Z");
    expect(await items(w1, token)).toEqual(["birth:ITEST1", "birth:ITEST2"]);
    const w2 = world({ rows: ROWS });
    await event(w2, "ITEST1", "2025-09-13T12:00:00Z");
    expect(await items(w2, token)).toEqual(["birth:ITEST2"]);
  });

  it("flag on: a passkey sign-in and an admin's confirmed-living mark keep the line", async () => {
    const w = world({ rows: ROWS });
    await w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: "PASSKEY#c1", SK: "META", GSI1PK: "PASSKEYSUB#ITEST1", GSI1SK: "PASSKEY#c1", rec: { lastUsedAt: T0 - 86_400_000 } } }));
    expect(await items(w, token)).toEqual(["birth:ITEST1", "birth:ITEST2"]);
    const w2 = world({ rows: ROWS });
    expect((await w2.call("POST", "/api/life-state/confirm", { token: await signToken(ADMIN), body: { person: "ITEST1" } })).status).toBe(200);
    expect(await items(w2, token)).toEqual(["birth:ITEST1", "birth:ITEST2"]);
    expect((await w2.call("DELETE", "/api/life-state/confirm/ITEST1", { token: await signToken(ADMIN), ct: undefined })).status).toBe(204);
    expect(await items(w2, token)).toEqual(["birth:ITEST2"]);
  });

  it("flag on: a deceased person's line is exactly as today", async () => {
    const rows = [[1, 1927, "living"], [3, 1927, "deceased"]];
    const off = await world({ rows, flags: { onThisDay: true } }).call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined });
    const on = await world({ rows }).call("GET", "/api/onthisday", { token, query: { date: DATE }, ct: undefined });
    const memorial = (r) => r.body.items.find((i) => i.id === "birth:ITEST3");
    expect(memorial(on)).toBeTruthy();
    expect(memorial(on)).toEqual(memorial(off));
    expect(on.body.items.some((i) => i.id === "birth:ITEST1")).toBe(false);
    expect(off.body.items.some((i) => i.id === "birth:ITEST1")).toBe(true);
  });

  it("flag on: an unreadable evidence source means no evidence (a line less, never one more)", async () => {
    const w = world({ rows: ROWS, intercept: (c) => { if (c.input?.ExpressionAttributeValues?.[":pk"] === "CONTRIBS") throw new Error("down"); } });
    expect(await items(w, token)).toEqual(["birth:ITEST2"]);
  });

  it("withLifeState asks for evidence only for a birth line old enough to depend on it, and never edits the index", () => {
    const idx = { year: [{ id: "birth:IA", kind: "birth", year: 1957, people: [{ grampsId: "IA", lifeState: "living" }] }, { id: "evt:m", kind: "marriage", year: 1900, people: [{ grampsId: "IB" }, { grampsId: "IC" }] }] };
    const asked = [];
    expect(withLifeState(idx, { nowMs: T0, evidence: (id) => { asked.push(id); } })).toBe(idx);
    expect(asked).toEqual([]);
    const old = { year: [...idx.year, { id: "birth:ID", kind: "birth", year: 1920, people: [{ grampsId: "ID", lifeState: "living" }] }] };
    const out = withLifeState(old, { nowMs: T0, evidence: () => undefined });
    expect(out.year.map((i) => i.id)).toEqual(["birth:IA", "evt:m"]);
    expect(old.year).toHaveLength(3);
  });
});
