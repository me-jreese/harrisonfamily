// HFY-TSK-211 (edit-mcp-tools; editing.md 7.6): hfy_records_get, hfy_changes_submit, hfy_proposals_list and hfy_proposals_get through the mounted MCP server.
// In-memory DynamoDB fake, synthetic ids, names and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import priv from "@io-kit/mcp/fixtures/keys/hfy-auth-edge.private.jwk.json" with { type: "json" };
import jwks from "@io-kit/mcp/fixtures/jwks/hfy-auth-edge.jwks.json" with { type: "json" };
import { buildMcpRegistry, createMcpMount } from "../src/mcp.js";
import { createGroupResolver, POLICY_ROWS } from "../src/policy.js";
import { ROUTES } from "../src/routes.js";
import { mcpToolsList } from "../src/mcp-caps.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey } from "../src/sync/store.js";
import { cmds, makeApi, TABLE } from "./world.js";

const RESOURCE = "https://harrisonfamily.us/mcp";
const ISS = "https://harrisonfamily.us/auth";
const ME = "I0001";
const OTHER = "I0002";
const THIRD = "I0004"; // an author with no Person in the tree
const ADMIN = "I0099";
const NOBODY = "I0777"; // in no group
const GROUPS = { version: 1, groups: { "mcp-authors": { emails: [], subjects: [ME, OTHER, THIRD] }, "hfy-admin": { subjects: [ADMIN] } } };
const TOOLS = ["hfy_changes_submit", "hfy_proposals_get", "hfy_proposals_list", "hfy_records_get"];
const key = await importJWK(priv, "RS256");
const token = (sub) =>
  new SignJWT({ client_id: "mcp-harrisonfamily", token_use: "access", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: priv.kid ?? "hfy-auth-edge-key-1" }).setSubject(sub).setIssuer(ISS).setAudience(RESOURCE).setIssuedAt().setExpirationTime("10m").sign(key);

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (dateval = [0, 0, 0, false], text = "", modifier = 0) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier, newyear: 0, quality: 0, sortval: 0, text });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, primary_name: { _class: "Name", first_name: `Given${n}`, nick: "", surname_list: [{ _class: "Surname", surname: "Synth", primary: true }], type: typ("NameType", 2), date: date() }, event_ref_list: [], family_list: [], parent_family_list: [], media_list: [], note_list: [], urls: [], birth_ref_index: -1, death_ref_index: -1, ...extra });
const event = (n, type, dateval, extra = {}) => ({ _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, change: 1, private: false, type: typ("EventType", type), date: date(dateval), place: "", citation_list: [], media_list: [], note_list: [], ...extra });
const eref = (ev) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", 1), private: false });
const note = (n) => ({ _class: "Note", handle: h(4000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] } });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const k = (obj) => `${obj._class}:${obj.handle}`;
const q = { info() {}, warn() {}, error() {} };

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world() {
  const api = makeApi({ log: q, admins: [ADMIN], extraDeps: { idPolicy: { mode: "mint" }, getAdmins: async () => new Set([ADMIN]), txnOpts: { sleep: async () => {} } } });
  api.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  let n = 0;
  const sctx = { ddb: api.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  const seed = (objs) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${++n}`, ops: objs.map(create) });
  const n1 = note(1);
  const otherDeath = event(2, 13, [9, 11, 1980, false]);
  const me = person(1, { note_list: [n1.handle] });
  const other = person(2, { event_ref_list: [eref(otherDeath)], death_ref_index: 0, note_list: [n1.handle] });
  await seed([me, other, n1, otherDeath]);
  const config = { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] };
  const mount = createMcpMount({ config, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => GROUPS, log: q }), fetch: async () => ({ ok: true, status: 200, json: async () => jwks }), log: q });
  let id = 0;
  const rpc = async (sub, method, params) => {
    const r = await mount.handle({ rawPath: "/mcp", headers: { "content-type": "application/json", authorization: `Bearer ${await token(sub)}` }, requestContext: { http: { method: "POST" } }, body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params }) });
    return JSON.parse(r.body);
  };
  const call = (sub, name, args) => rpc(sub, "tools/call", { name, arguments: args }).then((r) => r.result);
  // An agent session: the edge only mints human principals, so drive the mounted server directly.
  const agent = async (name, args, groups = ["mcp-authors"], sub = ME) => {
    const req = new Request("https://harrisonfamily.us/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: args } }) });
    const res = await mount.server.fetch(req, { type: "agent", sub, groups, authTime: 0, amr: [], onBehalfOf: sub });
    return (await res.json()).result;
  };
  const mod = (target, author_id) => api.ddb.rows.set(`MOD#${target}\u0000META`, { PK: `MOD#${target}`, SK: "META", entity: "mod", author_id, state: "hidden", hidden: true, open: true });
  let pn = 0;
  const proposal = (target, proposer, targets, state = "pending") => {
    const pid = `01PROP${String(++pn).padStart(4, "0")}`;
    const p = { id: pid, state, proposer: { id: proposer, label: "x" }, targets, ops: [{ id: "o1", op: "set", obj: target, path: "/primary_name/first_name", value: "SECRETVALUE" }], note: "SECRETNOTE" };
    api.ddb.rows.set(`PROP#${pid}\u0000IDX#REC#${target}`, { PK: `PROP#${pid}`, SK: `IDX#REC#${target}`, GSI1PK: `PROPREC#${target}`, GSI1SK: pid, proposal: p });
    return pid;
  };
  const rows = (prefix) => api.ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { api, mount, rpc, call, agent, seed, mod, proposal, rows, me, other, n1, otherDeath };
}
const names = (r) => r.result.tools.map((t) => t.name).sort();
const writeCount = (w) => w.api.ddb.calls.filter((c) => /^(Put|Update|Delete|TransactWrite)Command$/.test(c)).length;

describe("tools/list and the policy rows (AC1)", () => {
  it("lists the four tools to mcp-authors and to hfy-admin, and hides them from everyone else", async () => {
    const w = await world();
    const four = TOOLS.filter((x) => x !== "none");
    for (const who of [ME, ADMIN]) {
      const listed = names(await w.rpc(who, "tools/list"));
      for (const t of four) expect(listed, who).toContain(t);
    }
    expect(names(await w.rpc(NOBODY, "tools/list"))).toEqual([]);
    expect((await w.rpc(NOBODY, "tools/call", { name: "hfy_records_get", arguments: { cls: "Person", ref: OTHER } })).error.code).toBe(-32602);
  });
  it("has its own POLICY_ROWS row per tool, and hfy_changes_submit's row sets agentMode dry_run", () => {
    const row = (a) => POLICY_ROWS.find((r) => r.action === a);
    for (const a of ["edit.get", "changes.post", "proposals.list", "proposals.get"]) expect(row(a), a).toMatchObject({ show: ["mcp-authors", "hfy-admin"], execute: ["mcp-authors", "hfy-admin"] });
    expect(row("changes.post").agentMode).toBe("dry_run");
  });
});

describe("there is no decide tool (AC3, DEC-E5)", () => {
  it("no route with an mcp member, no registry tool and no policy row decides, amends or withdraws a proposal", async () => {
    const mcpRoutes = ROUTES.filter((r) => r.mcp).map((r) => r.name);
    expect(mcpRoutes.filter((n) => n.startsWith("proposals."))).toEqual(["proposals.list", "proposals.get"]);
    const tools = buildMcpRegistry(async () => ({ body: {} })).map((t) => t.name);
    expect(tools.filter((n) => /proposal/.test(n)).sort()).toEqual(["hfy_proposals_get", "hfy_proposals_list"]);
    expect(tools.filter((n) => /decide|decision|approve|deny|needs_changes|amend|withdraw/.test(n))).toEqual([]);
    expect(POLICY_ROWS.filter((r) => /^proposals\./.test(r.action)).map((r) => r.action).sort()).toEqual(["proposals.get", "proposals.list"]);
    const full = (await mcpToolsList()).tools.map((t) => t.name);
    expect(full.filter((n) => /decide|approve/.test(n))).toEqual([]);
    const w = await world();
    for (const who of [ME, ADMIN]) expect((await w.rpc(who, "tools/call", { name: "hfy_proposals_decide", arguments: { id: "x", verdict: "approve" } })).error.code).toBe(-32602);
  });
});

describe("hfy_changes_submit is a dry run for agents (AC2)", () => {
  const ops = (w) => [{ id: "a", op: "set", obj: k(w.me), path: "/primary_name/nick", base: "", value: "Ally" }];
  const body = (w) => ({ target: k(w.me), base_versions: { [k(w.me)]: 1 }, ops: ops(w) });
  it("an agent call returns the plan and writes nothing, whatever the call carries", async () => {
    const w = await world();
    const before = { writes: writeCount(w), rows: w.api.ddb.all().length };
    const r = await w.agent("hfy_changes_submit", body(w));
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ kind: "resolved_call", mode: "dry_run", wouldExecute: false, plan: { direct: expect.any(Array), review: [] }, warnings: [], errors: [] });
    expect(r.structuredContent.plan.direct.length + r.structuredContent.plan.review.length).toBeGreaterThan(0);
    const withKey = await w.agent("hfy_changes_submit", { ...body(w), idempotency_key: "agent-key-1" });
    expect(withKey.structuredContent.plan).toBeTruthy();
    const exec = await w.agent("hfy_changes_submit", { ...body(w), mode: "execute", idempotency_key: "agent-key-2" });
    expect(exec).toMatchObject({ isError: true, structuredContent: { reason: { code: "agent_dry_run_only" } } });
    expect({ writes: writeCount(w), rows: w.api.ddb.all().length }).toEqual(before);
    expect(w.rows("PROP#")).toEqual([]);
    expect(w.rows("IDEM#")).toEqual([]);
  });
  it("an agent plan that the guard refuses reports the problem, with nothing written", async () => {
    const w = await world();
    const r = await w.agent("hfy_changes_submit", { target: k(w.me), base_versions: { [k(w.me)]: 1 }, ops: [{ id: "p", op: "set", obj: k(w.me), path: "/primary_name/nick", base: "", value: "call 212-555-0143" }] });
    expect(r.structuredContent.planError).toMatchObject({ status: 422, error: "contact_info" });
    expect(JSON.stringify(r.structuredContent.planError)).not.toContain("212-555-0143");
    expect(w.rows("PROP#")).toEqual([]);
  });
  it("a human tool call in dry_run mode previews, and in execute mode saves the author's own field with an idempotency_key", async () => {
    const w = await world();
    const dry = await w.call(ME, "hfy_changes_submit", { ...body(w), mode: "dry_run" });
    expect(dry.structuredContent.plan).toBeTruthy();
    expect(w.rows("IDEM#")).toEqual([]);
    const noKey = await w.call(ME, "hfy_changes_submit", body(w));
    expect(noKey.isError).toBe(true);
    expect(JSON.parse(noKey.content[0].text)).toMatchObject({ status: 400, error: "validation" });
    const done = await w.call(ME, "hfy_changes_submit", { ...body(w), idempotency_key: "human-key-1" });
    expect(done.isError).toBeUndefined();
    expect(done.structuredContent.applied ?? done.structuredContent.proposal).toBeTruthy();
  });
});

describe("a guard refusal reaches the MCP leg as a 422 with zero PROP#, IDX# and THREAD# writes (AC7)", () => {
  const cases = {
    "a TEXTONLY birth date": { type: 12, value: date([0, 0, 0, false], "born 3 May 1950", 6) },
    "a span's second date on a birth": { type: 12, value: date([0, 0, 1950, false, 14, 3, 1952, false], "", 5) },
    "a baptism day for a deceased person": { type: 15, value: date([14, 3, 1950, false]) },
  };
  for (const [name, { type, value }] of Object.entries(cases)) {
    it(`${name} is 422 dob_not_allowed`, async () => {
      const w = await world();
      const ev = event(5, type, [0, 0, 1950, false]);
      const death = event(6, 13, [0, 0, 1990, false]);
      const dead = person(5, { event_ref_list: [eref(ev), eref(death)], death_ref_index: 1 });
      await w.seed([dead, ev, death]);
      const before = w.api.ddb.all().length;
      const r = await w.call(OTHER, "hfy_changes_submit", { target: k(dead), base_versions: { [k(ev)]: 1 }, idempotency_key: `g-${type}`, ops: [{ id: "d", op: "set", obj: k(ev), path: "/date", base: ev.date, value }] });
      expect(r.isError).toBe(true);
      const problem = JSON.parse(r.content[0].text);
      expect(problem).toMatchObject({ status: 422, error: "dob_not_allowed" });
      expect(problem.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r)).not.toContain("born 3 May");
      for (const p of ["PROP#", "IDX#", "THREAD#", "IDEM#"]) expect(w.rows(p), p).toEqual([]);
      expect(w.api.ddb.all().length).toBe(before);
    });
  }
});

describe("hfy_records_get (AC5)", () => {
  it("returns the edit bundle through publishView: another person's non-birth day is year-only", async () => {
    const w = await world();
    const r = await w.call(ME, "hfy_records_get", { cls: "Person", ref: OTHER });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ key: k(w.other), version: 1, relation: "other", viewer: { admin: false } });
    expect(r.structuredContent.related[k(w.otherDeath)].obj.date.dateval.slice(0, 3)).toEqual([0, 0, 1980]);
    const admin = await w.call(ADMIN, "hfy_records_get", { cls: "Person", ref: OTHER });
    expect(admin.structuredContent.related[k(w.otherDeath)].obj.date.dateval.slice(0, 3)).toEqual([9, 11, 1980]);
  });
  it("applies the moderation overlay: a non-owner agent session gets no hidden item", async () => {
    const w = await world();
    w.mod(`note:${w.n1.handle}`, ADMIN);
    const third = await w.agent("hfy_records_get", { cls: "Person", ref: OTHER }, ["mcp-authors"], THIRD);
    expect(third.structuredContent.obj.note_list).toEqual([]);
    expect(third.structuredContent.related).not.toHaveProperty(`Note:${w.n1.handle}`);
    expect(JSON.stringify(third)).not.toContain("Synthetic note 1");
    expect((await w.agent("hfy_records_get", { cls: "Note", ref: w.n1.gramps_id }, ["mcp-authors"], THIRD)).isError).toBe(true);
    const admin = await w.call(ADMIN, "hfy_records_get", { cls: "Person", ref: OTHER });
    expect(admin.structuredContent.obj.note_list).toEqual([w.n1.handle]);
  });
  it("pending lists only what the viewer may see: no other member's proposal for a non-owner agent session", async () => {
    const w = await world();
    const target = k(w.other);
    const mine = w.proposal(target, THIRD, [target]);
    const theirs = w.proposal(target, ME, [target]);
    const ids = (r) => r.structuredContent.pending.map((p) => p.proposalId).sort();
    expect(ids(await w.agent("hfy_records_get", { cls: "Person", ref: OTHER }, ["mcp-authors"], THIRD))).toEqual([mine]);
    expect(ids(await w.call(ADMIN, "hfy_records_get", { cls: "Person", ref: OTHER }))).toEqual([mine, theirs].sort());
    const fourth = await w.agent("hfy_records_get", { cls: "Person", ref: OTHER }, ["mcp-authors"], "I0005");
    expect(fourth.structuredContent.pending).toEqual([]);
    expect(JSON.stringify(fourth)).not.toMatch(/SECRET/);
  });
  it("is not found while HFY_EDITING is off", async () => {
    const w = await world();
    process.env.HFY_EDITING = "off";
    const r = await w.call(ADMIN, "hfy_records_get", { cls: "Person", ref: OTHER });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ status: 404, error: "not_found" });
  });
});

describe("hfy_proposals_list and hfy_proposals_get", () => {
  it("list shows a member their own suggestions and refuses the admin queue; get is 404 outside the visibility set", async () => {
    const w = await world();
    const target = k(w.other);
    const mine = w.proposal(target, ME, [target]);
    const theirs = w.proposal(target, THIRD, [target]);
    const list = await w.call(ME, "hfy_proposals_list", { view: "mine" });
    expect(list.isError).toBeUndefined();
    expect(Array.isArray(list.structuredContent.items)).toBe(true);
    const queue = await w.call(ME, "hfy_proposals_list", { view: "queue" });
    expect(queue.isError).toBe(true);
    expect(JSON.parse(queue.content[0].text)).toMatchObject({ status: 403 });
    const hidden = await w.call(THIRD, "hfy_proposals_get", { id: mine });
    expect(hidden.isError).toBe(true);
    expect(JSON.parse(hidden.content[0].text)).toMatchObject({ status: 404 });
    expect(theirs).not.toBe(mine);
  });
});
