// HFY-TSK-279 (sync-admin-status-page): GET /api/sync/admin/status and the gramps-owner's session on POST /api/sync/conflicts/:id/decision.
// In-memory DynamoDB fake, synthetic subjects and values only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, signToken } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { requireConflictDecision } from "../src/sync/auth.js";
import { cloudValueHash, conflictKey, decisionStillApplies } from "../src/sync/pull.js";
import { headKey } from "../src/sync/store.js";

const OWNER = "I9001";
const ADMIN = "I0099";
const MEMBER = "I0042";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const CID = (n) => `01J${String(n).padStart(23, "0")}`;
const h = (n) => n.toString(16).padStart(28, "0");

let envBefore;
beforeEach(() => { envBefore = process.env.SYNC_API_ENABLED; process.env.SYNC_API_ENABLED = "1"; });
afterEach(() => { if (envBefore === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = envBefore; });

const conflictRow = (n, extra = {}) => ({
  ...conflictKey(CID(n)), GSI1PK: "SYNCCONFLICT#open", GSI1SK: `2026-10-13T00:00:0${n}.000Z#${CID(n)}`, entity: "syncconflict",
  class: "Person", handle: h(1), gramps_id: "I0001", kind: "field", source: "desktop_parked", state: "open",
  paths: [{ path: "/primary_name/first_name", base: "Alder", cloud: "Birch", desktop: "Cedar" }], opened_at: `2026-10-13T00:00:0${n}.000Z`, ...extra,
});

function world() {
  const w = makeApi({ clock: () => NOW, admins: [ADMIN], extraDeps: { isOwner: async (sub) => sub === OWNER, txnOpts: { sleep: async () => {} } } });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 12, seeded: true, writes_enabled: true, tree_id: "00000000-0000-4000-8000-000000000001" });
  w.ddb.rows.set("SYNC#RENDER\u0000STATE", { PK: "SYNC#RENDER", SK: "STATE", rendered_seq: 9, mode: "live", last_error: "RenderFailed pass.failed", last_error_at: "2026-10-14T11:00:00.000Z" });
  w.ddb.rows.set("SYNC#CLIENT#instance-0001\u0000META", {
    PK: "SYNC#CLIENT#instance-0001", SK: "META", GSI1PK: "SYNCCLIENT", GSI1SK: "2026-10-14T11:59:30.000Z#instance-0001", entity: "syncclient", client_instance_id: "instance-0001", dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef",
    addon_version: "0.1.0", gramps_version: "6.0.6", schema: 21, updated_at: "2026-10-14T11:59:30.000Z", principal: OWNER,
    last_run: { run_id: "run-0001", action: "sync", result: "ok", exit_code: 0, counts: { pulled: 3, pushed: 1 }, finished_at: "2026-10-14T11:59:00Z" },
  });
  for (let i = 1; i <= 2; i += 1) {
    w.ddb.rows.set(`SYNC#BATCH#B${i}\u0000META`, { PK: `SYNC#BATCH#B${i}`, SK: "META", GSI1PK: "SYNCBATCH", GSI1SK: `2026-10-14T10:0${i}:00.000Z#B${i}`, entity: "syncbatch", batch_id: `B${i}`, principal: OWNER, origin: "desktop", seq_from: i * 3, seq_to: i * 3 + 2, results: [{}, {}, {}], at: `2026-10-14T10:0${i}:00.000Z`, request_hash: "x" });
  }
  w.ddb.rows.set(`SYNC#CONFLICT#${CID(1)}\u0000META`, conflictRow(1));
  w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2, { state: "resolved", GSI1PK: "SYNCCONFLICT#resolved" }));
  const as = async (sub, authTime = nowS - 10) => ({ token: await signToken(sub, { authTime }) });
  return { ...w, as };
}

describe("GET /api/sync/admin/status", () => {
  it("shows a conflict that was reopened by a changed cloud value as open, with the old decision in history (HFY-TSK-338)", async () => {
    const w = world();
    const history = [{ decision: "keep_cloud", cloud_version: 3, cloud_value_hash: "a".repeat(64), resolved_at: "2026-10-14T09:00:00.000Z", by: OWNER, reopened_at: "2026-10-14T10:00:00.000Z", reason: "value_changed" }];
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(3)}\u0000META`, conflictRow(3, { reopened_at: "2026-10-14T10:00:00.000Z", history }));
    const r = await w.call("GET", "/api/sync/admin/status", await w.as(ADMIN));
    const c = r.body.conflicts.find((x) => x.id === CID(3));
    expect(c).toMatchObject({ state: "open", decision: null, reopened_at: "2026-10-14T10:00:00.000Z", history });
    expect(r.body.conflicts.find((x) => x.id === CID(1))).toMatchObject({ reopened_at: null, history: [] });
  });
  it("shows desktop, website, open conflicts and recent batches to hfy-admin and gramps-owner", async () => {
    const w = world();
    for (const sub of [ADMIN, OWNER]) {
      const r = await w.call("GET", "/api/sync/admin/status", await w.as(sub));
      expect(r.status, sub).toBe(200);
      expect(r.body.owner).toBe(sub === OWNER);
      expect(r.body.desktop).toEqual([{ id: "instance-0001", addon_version: "0.1.0", gramps_version: "6.0.6", schema: 21, updated_at: "2026-10-14T11:59:30.000Z", last_run: { action: "sync", result: "ok", exit_code: 0, counts: { pulled: 3, pushed: 1 }, finished_at: "2026-10-14T11:59:00Z" } }]);
      expect(r.body.website).toMatchObject({ head_seq: 12, rendered_seq: 9, render_lag: 3, render_mode: "live", last_render_error: "RenderFailed pass.failed", writes_enabled: true, seeded: true, bound: true });
      expect(r.body.conflicts.map((c) => c.id)).toEqual([CID(1)]); // the resolved one is not in the open queue
      expect(r.body.conflicts[0].paths[0]).toMatchObject({ cloud: "Birch", desktop: "Cedar" });
      expect(r.body.batches.map((b) => [b.id, b.ops, b.by])).toEqual([["B2", 3, OWNER], ["B1", 3, OWNER]]); // newest first
    }
    expect(JSON.stringify((await w.call("GET", "/api/sync/admin/status", await w.as(ADMIN))).body)).not.toMatch(/fp-0123|db-synthetic/); // no fingerprint, no dbid
  });
  it("anyone else gets 403 not_allowed; signed out is 401; the switch off is 404", async () => {
    const w = world();
    const r = await w.call("GET", "/api/sync/admin/status", await w.as(MEMBER));
    expect([r.status, r.body.error]).toEqual([403, "not_allowed"]);
    expect((await w.call("GET", "/api/sync/admin/status")).status).toBe(401);
    process.env.SYNC_API_ENABLED = "0";
    expect((await w.call("GET", "/api/sync/admin/status", await w.as(ADMIN))).status).toBe(404);
  });
  it("is listed in caps.json as a session route behind SYNC_API_ENABLED; the decision lists the owner's session too", () => {
    const a = buildCaps().actions;
    expect(a.find((x) => x.name === "sync.admin.status")).toMatchObject({ method: "GET", path: "/api/sync/admin/status", gate: { switch: "SYNC_API_ENABLED" } });
    expect(a.find((x) => x.name === "sync.conflicts.decision")).toMatchObject({ auth: "sync-bearer", cookie: "gramps-owner" });
  });
});

describe("POST /api/sync/conflicts/:id/decision with the gramps-owner's session", () => {
  const decide = (w, o, id = CID(1), body = { decision: "keep_cloud" }) => w.call("POST", `/api/sync/conflicts/${id}/decision`, { body, ...o });
  it("a fresh sign-in (auth_time within 300 s) records the decision with {cloud_version, cloud_value_hash}", async () => {
    const w = world();
    const r = await decide(w, await w.as(OWNER));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: CID(1), state: "resolved", decision: "keep_cloud", cloud_version: null, cloud_value_hash: cloudValueHash(conflictRow(1).paths), by: OWNER });
    expect(w.ddb.rows.get(`SYNC#CONFLICT#${CID(1)}\u0000META`)).toMatchObject({ state: "resolved", decision: "keep_cloud", cloud_value_hash: cloudValueHash(conflictRow(1).paths) });
    expect((await w.call("GET", "/api/sync/admin/status", await w.as(OWNER))).body.conflicts).toEqual([]);
  });
  it("a sign-in older than 300 s, or without auth_time, is 401 step_up_required and nothing is recorded", async () => {
    const w = world();
    for (const authTime of [nowS - 301, nowS + 3600, undefined]) {
      const r = await w.call("POST", `/api/sync/conflicts/${CID(1)}/decision`, { body: { decision: "keep_cloud" }, token: await signToken(OWNER, authTime === undefined ? {} : { authTime }) });
      expect([r.status, r.body.error], String(authTime)).toEqual([401, "step_up_required"]);
    }
    expect((await decide(w, await w.as(OWNER, nowS - 299))).status).toBe(200); // just inside the window
  });
  it("an hfy-admin session alone is 403 not_owner, a member too, and no credentials at all is the bearer 401", async () => {
    const w = world();
    for (const sub of [ADMIN, MEMBER]) {
      const r = await decide(w, await w.as(sub));
      expect([r.status, r.body.error], sub).toEqual([403, "not_owner"]);
    }
    const none = await decide(w, {});
    expect([none.status, none.body.error]).toEqual([401, "unauthenticated"]);
    expect(w.ddb.rows.get(`SYNC#CONFLICT#${CID(1)}\u0000META`).state).toBe("open");
  });
  it("a second decision is 409 already_resolved, and the switch off is 404", async () => {
    const w = world();
    expect((await decide(w, await w.as(OWNER))).status).toBe(200);
    expect((await decide(w, await w.as(OWNER))).body.error).toBe("already_resolved");
    process.env.SYNC_API_ENABLED = "0";
    expect((await decide(w, await w.as(OWNER), CID(1))).status).toBe(404);
  });
  it("requireConflictDecision refuses a session actor the handler did not mark as the owner", () => {
    expect(() => requireConflictDecision({ id: ADMIN, admin: true, authTime: nowS }, NOW)).toThrow(expect.objectContaining({ status: 403, code: "not_owner" }));
    expect(() => requireConflictDecision({ id: OWNER, authTime: nowS - 10, web: { owner: true } }, NOW)).not.toThrow();
  });
});

describe("a decision applies only while the cloud still matches (SI-30, e2e)", () => {
  it("the stored {cloud_version, cloud_value_hash} match the unchanged cloud and fail once a cloud value or the version moves", async () => {
    const w = world();
    const r = await w.call("POST", `/api/sync/conflicts/${CID(1)}/decision`, { body: { decision: "keep_desktop" }, token: (await w.as(OWNER)).token });
    const stored = w.ddb.rows.get(`SYNC#CONFLICT#${CID(1)}\u0000META`);
    expect(r.status).toBe(200);
    expect(decisionStillApplies(stored, { version: null, paths: stored.paths })).toBe(true);
    expect(decisionStillApplies(stored, { version: null, paths: [{ ...stored.paths[0], cloud: "Birch-2" }] })).toBe(false); // the website value changed: reopen
    expect(decisionStillApplies(stored, { version: 2, paths: stored.paths })).toBe(false); // the record moved: reopen
    expect(decisionStillApplies({ ...stored, state: "open" }, { version: null, paths: stored.paths })).toBe(false);
  });
});
