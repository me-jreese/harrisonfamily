import { describe, it, expect, beforeEach } from "vitest";
import { makeApi, signToken, cmds, TABLE } from "./world.js";
import { ROUTES } from "../src/routes.js";
import { buildMe, countPendingAccessRequests } from "../src/me.js";

let w, member, admin;
beforeEach(async () => {
  w = makeApi();
  [member, admin] = await Promise.all(["I0001", "I0099"].map((s) => signToken(s)));
});
const pend = (n, state = "pending") => {
  for (let i = 0; i < n; i += 1) {
    const id = `${state}${i}`;
    w.ddb.rows.set(`ACCESSREQ#${id}|META`, { PK: `ACCESSREQ#${id}`, SK: "META", GSI1PK: `ACCESSREQS#${state}`, GSI1SK: id });
  }
};

describe("GET /api/me (HFY-TSK-237)", () => {
  it("signed out is 401", async () => {
    const r = await w.call("GET", "/api/me");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthenticated");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(w.ddb.calls).not.toContain("QueryCommand");
  });
  it("member: id, label, admin false, can all false, no badges key", async () => {
    pend(2);
    const r = await w.call("GET", "/api/me", { token: member });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatchObject({ id: "I0001", label: "I0001", admin: false, can: { moderate: false, graduate: false, approve: false } });
    expect(r.body).not.toHaveProperty("badges");
  });
  it("admin: can.* true and badges.accessRequests counts only the pending partition", async () => {
    pend(3);
    pend(2, "approved");
    const r = await w.call("GET", "/api/me", { token: admin });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "I0099", admin: true, can: { moderate: true, graduate: true, approve: true }, badges: { accessRequests: 3 } });
  });
  it("admin with an empty partition gets 0", async () => {
    expect((await w.call("GET", "/api/me", { token: admin })).body.badges).toEqual({ accessRequests: 0 });
  });
  it("pinned core types: id and label strings, admin boolean, can has exactly moderate/graduate/approve booleans", async () => {
    const r = await w.call("GET", "/api/me", { token: admin });
    expect(typeof r.body.id).toBe("string");
    expect(typeof r.body.label).toBe("string");
    expect(typeof r.body.admin).toBe("boolean");
    expect(Object.keys(r.body.can).sort()).toEqual(["approve", "graduate", "moderate"]);
    expect(Object.values(r.body.can).every((v) => typeof v === "boolean")).toBe(true);
  });
  it("additive: an extra top-level field is carried, and the core fields and can.* still hold (core cannot be overridden)", async () => {
    const me = await buildMe({ id: "I0099", label: "L", admin: true }, {
      accessRequestCount: async () => 1,
      extras: async () => ({ ownRecord: { id: "x" }, editing: true, admin: false, can: {} }),
    });
    expect(me).toMatchObject({ id: "I0099", label: "L", admin: true, can: { moderate: true, graduate: true, approve: true }, badges: { accessRequests: 1 }, ownRecord: { id: "x" }, editing: true });
  });
  it("a failing badge count still returns identity and can.*, omits badges, and logs", async () => {
    const errors = [];
    const me = await buildMe({ id: "I0099", label: "L", admin: true }, { accessRequestCount: async () => { throw new Error("throttled"); }, log: { error: (...a) => errors.push(a) } });
    expect(me).toEqual({ id: "I0099", label: "L", admin: true, can: { moderate: true, graduate: true, approve: true } });
    expect(errors).toHaveLength(1);
    const w2 = makeApi({ intercept: (cmd) => { if (cmd.constructor.name === "QueryCommand") throw new Error("throttled"); } });
    const r = await w2.call("GET", "/api/me", { token: await signToken("I0099") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "I0099", admin: true, can: { approve: true } });
    expect(r.body).not.toHaveProperty("badges");
  });
  it("counts across multiple COUNT pages", async () => {
    pend(7);
    const base = { ddb: w.ddb, cmds, table: TABLE };
    w.ddb.calls.length = 0;
    expect(await countPendingAccessRequests({ ...base, pageSize: 3 })).toBe(7);
    expect(w.ddb.calls.filter((c) => c === "QueryCommand").length).toBeGreaterThan(1);
  });
  it("is registered with auth session, read-only, and no mcp member", () => {
    const r = ROUTES.find((x) => x.name === "me.get");
    expect(r).toMatchObject({ method: "GET", path: "/me", auth: "session", write: false });
    expect(r.mcp).toBeUndefined();
  });
});
