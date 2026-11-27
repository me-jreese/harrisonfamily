// HFY-TSK-426 (HFY-ISS-031, rulings P5-R4 and P5-R5): the life-state evidence read, the admin's confirmed-living mark and their gate. Synthetic people only.
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeDdb, cmds, createUlidFactory, makeApi, signToken, TABLE } from "./world.js";
import { buildEvent } from "../src/contrib.js";
import { buildCaps } from "../src/routes.js";
import { confirmKeys, latestInWindow } from "../src/life-state.js";
import { lifeState } from "../src/shared/life-state.mjs";

const T0 = Date.UTC(2027, 9, 13, 12, 0, 0); // 2027-10-13T12:00:00Z; the 24 month edge is 2025-10-13T12:00:00Z
const ADMIN = "I0099";
const MEMBER = "ITEST1";
const day = (n) => n * 86_400_000;
const ulid = createUlidFactory();
const put = (w, Item) => w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item }));
const event = (w, who, kind, at, extra = {}) => {
  const ref = { post: { type: "post", id: "p1" }, comment: { type: "comment", id: "c1", thread: "person:ITEST9" }, tag: { type: "tag", id: "t1" }, self_edit: { type: "record", id: "r1" } }[kind];
  return put(w, buildEvent({ actor: { id: who }, kind, ref, at, id: ulid(Date.parse(at)), ...extra }));
};
const passkey = (w, sub, rec) => put(w, { PK: `PASSKEY#cred-${sub}-${Math.random()}`, SK: "META", GSI1PK: `PASSKEYSUB#${sub}`, GSI1SK: `PASSKEY#x${sub}`, entity: "passkey", rec: { sub, email: `${sub.toLowerCase()}@example.test`, ...rec } });

function world(extra = {}) {
  const w = makeApi({ admins: [ADMIN], flags: { lifeStateV1: true }, clock: () => T0, extraDeps: { listMembers: async () => new Set(["ITEST1", "ITEST2", "ITEST3", "ITEST4", "ITEST5"]), ...extra } });
  return w;
}
const get = (w, token) => w.call("GET", "/api/life-state", { token, ct: undefined });
const ids = (rows) => rows.map((r) => r.person);

describe("GET /api/life-state: the evidence", () => {
  let w, member, admin;
  beforeEach(async () => { w = world(); [member, admin] = await Promise.all([signToken(MEMBER), signToken(ADMIN)]); });

  it("reads each kind of contribution, the newest event per person, as a day", async () => {
    await event(w, "ITEST1", "post", "2027-08-01T10:00:00Z");
    await event(w, "ITEST1", "comment", "2027-09-20T10:00:00Z"); // the newest of ITEST1
    await event(w, "ITEST2", "tag", "2026-11-02T08:30:00Z");
    await event(w, "ITEST3", "self_edit", "2026-01-15T00:00:00Z");
    const r = await get(w, member);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      asOf: "2027-10-13T12:00:00.000Z",
      evidence: [{ person: "ITEST1", at: "2027-09-20" }, { person: "ITEST2", at: "2026-11-02" }, { person: "ITEST3", at: "2026-01-15" }],
      confirmed: [],
    });
  });

  it("window edge: exactly 24 months counts, 25 months and a second past the edge do not", async () => {
    await event(w, "ITEST1", "post", "2025-10-13T12:00:00Z"); // exactly 24 months
    await event(w, "ITEST2", "post", "2025-10-13T11:59:59Z"); // one second past
    await event(w, "ITEST3", "post", "2025-09-13T12:00:00Z"); // 25 months
    expect(ids((await get(w, member)).body.evidence)).toEqual(["ITEST1"]);
  });

  it("ignores a date in the future", async () => {
    await event(w, "ITEST1", "post", new Date(T0 + day(30)).toISOString().replace(/\.\d+Z$/, "Z"));
    await event(w, "ITEST2", "post", "2027-10-01T00:00:00Z");
    expect(ids((await get(w, member)).body.evidence)).toEqual(["ITEST2"]);
  });

  it("reads a passkey sign-in (lastUsedAt, else createdAt) for a member, and not an old one, nor a non-member's", async () => {
    await passkey(w, "ITEST1", { createdAt: T0 - day(400), lastUsedAt: T0 - day(10) });
    await passkey(w, "ITEST2", { createdAt: T0 - day(40) }); // never used since: the add counts
    await passkey(w, "ITEST3", { createdAt: T0 - day(900), lastUsedAt: T0 - day(800) });
    await passkey(w, "ISTRAY", { createdAt: T0 - day(1), lastUsedAt: T0 - day(1) }); // not in the member list: never read
    const r = await get(w, member);
    expect(r.body.evidence).toEqual([{ person: "ITEST1", at: "2027-10-03" }, { person: "ITEST2", at: "2027-09-03" }]);
  });

  it("a passkey read that fails costs only that source", async () => {
    const wf = makeApi({ admins: [ADMIN], flags: { lifeStateV1: true }, clock: () => T0, intercept: (c) => { if (c.input?.ExpressionAttributeValues?.[":pk"]?.startsWith?.("PASSKEYSUB#")) throw new Error("down"); }, extraDeps: { listMembers: async () => new Set(["ITEST1"]) } });
    await event(wf, "ITEST1", "post", "2027-09-01T00:00:00Z");
    expect((await get(wf, member)).body.evidence).toEqual([{ person: "ITEST1", at: "2027-09-01" }]);
  });

  it("without the member list there is no passkey source and contributions still count", async () => {
    const wn = makeApi({ admins: [ADMIN], flags: { lifeStateV1: true }, clock: () => T0 });
    await event(wn, "ITEST1", "post", "2027-09-01T00:00:00Z");
    await passkey(wn, "ITEST2", { lastUsedAt: T0 - day(1) });
    expect(ids((await get(wn, member)).body.evidence)).toEqual(["ITEST1"]);
  });

  it("an account linked to a person over the threshold becomes living through the evidence, and unknown without it", async () => {
    const base = { birthYear: 1930, now: new Date(T0) }; // 97 years
    expect(lifeState(base)).toBe("unknown");
    await event(w, "ITEST1", "comment", "2027-06-01T00:00:00Z");
    const r = (await get(w, member)).body;
    expect(lifeState({ ...base, evidenceAt: r.evidence.find((e) => e.person === "ITEST1").at })).toBe("living");
    expect(lifeState({ ...base, hasDeath: true, evidenceAt: r.evidence[0].at })).toBe("deceased"); // a death still wins
  });

  it("never carries an email, an account id or any field beyond person and at", async () => {
    await put(w, { PK: "ALLOW#itest1@example.test", SK: "META", entity: "allow", sub: "ITEST1", state: "active" });
    await put(w, { PK: "LINK#itest1@example.test", SK: "META", entity: "link", sub: "ITEST1" });
    await passkey(w, "ITEST1", { createdAt: T0 - day(2), lastUsedAt: T0 - day(1) });
    await event(w, "ITEST1", "post", "2027-09-01T00:00:00Z", { actor: { id: "ITEST1", label: "Test Person A" } });
    await w.call("POST", "/api/life-state/confirm", { token: admin, body: { person: "ITEST4" } });
    const r = await get(w, member);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/@|example|Test Person|PASSKEY|ALLOW|LINK|cred-/);
    expect(Object.keys(r.body).sort()).toEqual(["asOf", "confirmed", "evidence"]);
    for (const row of [...r.body.evidence, ...r.body.confirmed]) expect(Object.keys(row).sort()).toEqual(["at", "person"]);
  });

  it("latestInWindow is pure: the newest in-window date per person, junk ignored", () => {
    const m = latestInWindow([{ person: "ITEST1", at: "2027-01-01T00:00:00Z" }, { person: "ITEST1", at: T0 - day(3) }, { person: "bad id#", at: "2027-01-01T00:00:00Z" }, { person: "ITEST2", at: "nope" }, { person: "ITEST3", at: undefined }], T0);
    expect([...m.keys()]).toEqual(["ITEST1"]);
    expect(m.get("ITEST1")).toBe(T0 - day(3));
  });
});

describe("the confirmed-living mark", () => {
  let w, member, admin;
  beforeEach(async () => { w = world({ personExists: async (id) => id !== "ITESTX" }); [member, admin] = await Promise.all([signToken(MEMBER), signToken(ADMIN)]); });
  const confirm = (token, body) => w.call("POST", "/api/life-state/confirm", { token, body });
  const unconfirm = (token, person) => w.call("DELETE", `/api/life-state/confirm/${person}`, { token, ct: undefined });
  const audits = async (person) => (await w.ddb.send(new cmds.QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `AUDIT#lifestate:${person}` } }))).Items;

  it("an admin marks, the mark shows for members, and an old or future date is handled", async () => {
    const r = await confirm(admin, { person: "ITEST4" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ person: "ITEST4", at: "2027-10-13" });
    expect((await confirm(admin, { person: "ITEST5", at: "2027-03-02" })).body).toEqual({ person: "ITEST5", at: "2027-03-02" });
    expect((await confirm(admin, { person: "ITEST6", at: "2020-01-01T00:00:00Z" })).status).toBe(200); // accepted, but outside the window it is no evidence
    const g = (await get(w, member)).body;
    expect(g.confirmed).toEqual([{ person: "ITEST4", at: "2027-10-13" }, { person: "ITEST5", at: "2027-03-02" }]);
    expect(g.evidence).toEqual([]);
    expect(lifeState({ birthYear: 1920, confirmedLivingAt: g.confirmed[0].at, now: new Date(T0) })).toBe("living");
    const item = (await w.ddb.send(new cmds.GetCommand({ TableName: TABLE, Key: confirmKeys("ITEST4") }))).Item;
    expect(item).toMatchObject({ entity: "life-confirmed", person: "ITEST4", by: ADMIN });
  });

  it("a mark renews, a mark is removed, and removing nothing writes nothing", async () => {
    await confirm(admin, { person: "ITEST4", at: "2026-12-01" });
    await confirm(admin, { person: "ITEST4", at: "2027-02-01" });
    expect((await get(w, member)).body.confirmed).toEqual([{ person: "ITEST4", at: "2027-02-01" }]);
    expect((await unconfirm(admin, "ITEST4")).status).toBe(204);
    expect((await get(w, member)).body.confirmed).toEqual([]);
    expect((await unconfirm(admin, "ITEST4")).status).toBe(204); // idempotent
    const a = await audits("ITEST4");
    expect(a.map((x) => x.op).sort()).toEqual(["lifestate.confirm", "lifestate.confirm", "lifestate.unconfirm"]);
    expect(a.every((x) => x.principal === ADMIN && !JSON.stringify(x).includes("@"))).toBe(true);
    expect(a.find((x) => x.op === "lifestate.unconfirm")).toMatchObject({ before: { confirmedAt: "2027-02-01T00:00:00.000Z" }, after: { confirmedAt: null } });
  });

  it("only an admin writes: a member gets 403 on both, and nothing is stored", async () => {
    expect((await confirm(member, { person: "ITEST4" })).status).toBe(403);
    await confirm(admin, { person: "ITEST4" });
    expect((await unconfirm(member, "ITEST4")).status).toBe(403);
    expect((await get(w, member)).body.confirmed).toHaveLength(1);
    expect((await confirm(undefined, { person: "ITEST4" })).status).toBe(401);
  });

  it("refuses a bad person, a bad or future date, and an unknown person", async () => {
    for (const body of [{}, { person: "" }, { person: "I#1" }, { person: 5 }, { person: "ITEST4", at: "yesterday" }, { person: "ITEST4", at: "2027-02-30" }, { person: "ITEST4", at: "2027-10-14" }, { person: "ITEST4", at: 5 }]) {
      const r = await confirm(admin, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe("validation");
    }
    expect((await confirm(admin, { person: "ITESTX" })).status).toBe(404);
    expect((await unconfirm(admin, "I%23x")).status).toBe(400);
  });
});

describe("the flag lifeStateV1 gates every route", () => {
  it("is 404 for a member, an admin and a signed-out caller while the flag is off or missing", async () => {
    for (const flags of [{ lifeStateV1: false }, {}]) {
      const w = makeApi({ admins: [ADMIN], flags, clock: () => T0 });
      const [member, admin] = await Promise.all([signToken(MEMBER), signToken(ADMIN)]);
      for (const token of [member, admin, undefined]) {
        expect((await w.call("GET", "/api/life-state", { token, ct: undefined })).status).toBe(404);
        expect((await w.call("POST", "/api/life-state/confirm", { token, body: { person: "ITEST4" } })).status).toBe(404);
        expect((await w.call("DELETE", "/api/life-state/confirm/ITEST4", { token, ct: undefined })).status).toBe(404);
      }
      expect((await w.call("GET", "/api/life-state", { token: admin, ct: undefined })).body.error).toBe("not_found");
    }
  });

  it("is 401 signed out once the flag is on", async () => {
    expect((await world().call("GET", "/api/life-state", { ct: undefined })).status).toBe(401);
  });

  it("caps.json lists the three routes behind lifeStateV1", () => {
    const acts = buildCaps().actions.filter((a) => a.name.startsWith("lifeState."));
    expect(acts.map((a) => `${a.name} ${a.method} ${a.path}`).sort()).toEqual([
      "lifeState.confirm POST /api/life-state/confirm", "lifeState.get GET /api/life-state", "lifeState.unconfirm DELETE /api/life-state/confirm/:person",
    ]);
    for (const a of acts) expect(a.gate).toEqual({ feature: "lifeStateV1" });
    expect(buildCaps().mcp.tools.some((t) => t.action.startsWith("lifeState."))).toBe(false);
  });
});

describe("P5-R5: display only, the protections do not move", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  it("scripts/ci/test/life-state-pins.test.mjs still passes", () => {
    expect(() => execFileSync(process.execPath, ["--test", "scripts/ci/test/life-state-pins.test.mjs"], { cwd: ROOT, stdio: "pipe" })).not.toThrow();
  });
  it("the on-this-day builder and selector (the 110 and 100 year cutoffs, the residence skip) do not read the new rule or the flag", () => {
    for (const f of ["api/src/onthisday/build.js", "api/src/onthisday/select.js", "api/src/onthisday/source.js", "api/src/onthisday/store-source.js", "api/src/access-requests.js", "api/src/records/edit-bundle.js"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/life-state|lifeStateV1|evidenceActive|LIFE_STATE\b/);
    }
    expect(readFileSync(join(ROOT, "api/src/onthisday/select.js"), "utf8")).toMatch(/n <= 100/);
  });
  it("life-state.js never writes or reads the published isLiving flag or a death", () => {
    expect(readFileSync(join(ROOT, "api/src/life-state.js"), "utf8").replace(/^\/\/.*$/gm, "")).not.toMatch(/isLiving|death_ref|hasDeath/);
  });
});
