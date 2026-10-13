import { describe, it, expect, beforeEach } from "vitest";
import { makeApi, signToken } from "./world.js";
import { ROUTES } from "../src/routes.js";

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
    expect((await w.call("GET", "/api/me")).status).toBe(401);
  });
  it("member: id, label, admin false, can all false, no badges key", async () => {
    pend(2);
    const r = await w.call("GET", "/api/me", { token: member });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({ id: "I0001", label: "I0001", admin: false, can: { moderate: false, graduate: false, approve: false } });
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
  it("shape is additive-only: the pinned core fields are present, and any extra key is an addition", async () => {
    const r = await w.call("GET", "/api/me", { token: admin });
    const core = ["id", "label", "admin", "can", "badges"];
    expect(Object.keys(r.body).filter((k) => core.includes(k)).sort()).toEqual([...core].sort());
    expect(Object.keys(r.body.can).sort()).toEqual(["approve", "graduate", "moderate"]);
  });
  it("is registered with auth session, read-only, and no mcp member", () => {
    const r = ROUTES.find((x) => x.name === "me.get");
    expect(r).toMatchObject({ method: "GET", path: "/me", auth: "session", write: false });
    expect(r.mcp).toBeUndefined();
  });
});
