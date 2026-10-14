// HFY-TSK-238 (api-feature-gate): the server-side feature gate, its read path, the uat group, the caps rule and the persist-first inbox gate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeApi, signToken } from "./world.js";
import {
  DEFAULT_FLAGS_URL, FLAGS_MAX_STALE_MS, FLAGS_TTL_MS, PREVIEW_HEADER, SERVER_SWITCHES, closedFeatureGate, configureFeatures, createFeatureGate,
  createFlagSource, currentFeatureGate, describeGate, featureOn, gateExempt, parsePreview, previewOf, requireFeature, serverSwitch,
} from "../src/features.js";
import { ROUTES, buildCaps, defineRoutes } from "../src/routes.js";
import { HttpError } from "../src/http.js";
import { createGroupResolver, parseGroupsConfig, UAT_GROUP } from "../src/policy.js";
import { createNotifier } from "../src/notify.js";
import { InMemoryNotificationStore } from "@io-kit/notify/server";

const here = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const quiet = { error() {}, warn() {} };

/** A fetch stand-in: `next` is what the following read returns (an object => 200 JSON, a number => that status, an Error => it throws). */
function fakeFetch(initial) {
  const f = async (url, init) => {
    f.calls.push({ url, init });
    const next = typeof f.next === "function" ? f.next() : f.next;
    if (next instanceof Error) throw next;
    if (typeof next === "number") return { ok: next >= 200 && next < 300, status: next, json: async () => ({}) };
    if (next === "bad-json") return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } };
    return { ok: true, status: 200, json: async () => structuredClone(next) };
  };
  f.calls = [];
  f.next = initial;
  return f;
}
const clock = (t = 1_000_000) => {
  const c = () => c.t;
  c.t = t;
  c.add = (ms) => { c.t += ms; };
  return c;
};

describe("flag source: the deployed flags file, cached 60 s, last good for 10 minutes, then closed (AC1, AC6)", () => {
  it("reads the site's /_data/flags.json over https through the site origin (no S3), at most once per 60 s", async () => {
    expect(DEFAULT_FLAGS_URL).toBe("https://harrisonfamily.us/_data/flags.json");
    const fetch = fakeFetch({ inboxV1: true, navMe: false });
    const now = clock();
    const flags = createFlagSource({ fetch, now, log: quiet });
    expect(await flags()).toEqual({ inboxV1: true, navMe: false });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(DEFAULT_FLAGS_URL);
    expect(fetch.calls[0].init).toMatchObject({ headers: { accept: "application/json" }, redirect: "error" });
    expect(fetch.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    fetch.next = { inboxV1: false };
    now.add(FLAGS_TTL_MS - 1);
    expect((await flags()).inboxV1).toBe(true); // still cached
    expect(fetch.calls).toHaveLength(1);
    now.add(1);
    expect((await flags()).inboxV1).toBe(false); // 60 s later the next read lands
    expect(fetch.calls).toHaveLength(2);
  });

  it("keeps the last good value for up to 10 minutes after the last successful read, then fails closed, then recovers", async () => {
    const fetch = fakeFetch({ inboxV1: true });
    const now = clock();
    const errors = [];
    const flags = createFlagSource({ fetch, now, log: { error: (...a) => errors.push(a) } });
    expect((await flags()).inboxV1).toBe(true);
    const goodAt = now.t;
    fetch.next = new TypeError("fetch failed");
    for (const at of [61_000, 5 * MIN, FLAGS_MAX_STALE_MS - 1, FLAGS_MAX_STALE_MS]) {
      now.t = goodAt + at;
      expect((await flags()).inboxV1, `at +${at} ms`).toBe(true);
    }
    now.t = goodAt + FLAGS_MAX_STALE_MS + 1;
    expect(await flags()).toEqual({}); // closed: every feature off, even before the next retry
    now.add(5_000);
    expect(await flags()).toEqual({});
    expect(errors.at(-1)[0]).toBe("flags read failed (features off)");
    expect(errors[0][0]).toBe("flags read failed (keeping the last good flags)");
    fetch.next = { inboxV1: true };
    now.add(5_000);
    expect((await flags()).inboxV1).toBe(true); // a good read restores it at once
  });

  it("fails closed from a cold start when the first read fails", async () => {
    const flags = createFlagSource({ fetch: fakeFetch(503), now: clock(), log: quiet });
    expect(await flags()).toEqual({});
  });

  it("retries a failed read after 5 s, not on every call, and never throws", async () => {
    const fetch = fakeFetch(new Error("network"));
    const now = clock();
    const flags = createFlagSource({ fetch, now, log: quiet });
    await flags();
    now.add(1_000);
    await flags();
    now.add(3_999);
    await flags();
    expect(fetch.calls).toHaveLength(1);
    now.add(1);
    await expect(flags()).resolves.toEqual({});
    expect(fetch.calls).toHaveLength(2);
  });

  it("a non-2xx status, unparsable JSON or a non-object body is a failed read; non-boolean values are dropped", async () => {
    const now = clock();
    for (const bad of [404, 500, "bad-json", [true], null, "flags"]) {
      const fetch = fakeFetch({ inboxV1: true });
      const flags = createFlagSource({ fetch, now, log: quiet });
      expect((await flags()).inboxV1).toBe(true);
      fetch.next = bad;
      now.add(FLAGS_TTL_MS);
      expect((await flags()).inboxV1, JSON.stringify(bad)).toBe(true); // last good kept
      now.add(FLAGS_MAX_STALE_MS);
      expect(await flags(), JSON.stringify(bad)).toEqual({});
    }
    const flags = createFlagSource({ fetch: fakeFetch({ inboxV1: "true", contribV1: 1, navMe: true, "bad name": true }), now, log: quiet });
    expect(await flags()).toEqual({ navMe: true });
    expect(Object.isFrozen(await flags())).toBe(true);
  });

  it("concurrent callers share one read", async () => {
    let release;
    let reads = 0;
    const fetch = async () => {
      reads += 1;
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, json: async () => ({ inboxV1: true }) };
    };
    const flags = createFlagSource({ fetch, now: clock(), log: quiet });
    const all = Promise.all([flags(), flags(), flags()]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await all).map((f) => f.inboxV1)).toEqual([true, true, true]);
    expect(reads).toBe(1);
  });

  it("refuses a non-https url, and logs only the error's name and code", async () => {
    expect(() => createFlagSource({ url: "http://harrisonfamily.us/_data/flags.json" })).toThrow(/https/);
    expect(() => createFlagSource({ url: "s3://bucket/_data/flags.json" })).toThrow(/https/);
    const lines = [];
    const flags = createFlagSource({ fetch: fakeFetch(new Error("secret-looking detail https://x.example/?token=abc")), now: clock(), log: { error: (...a) => lines.push(a) } });
    await flags();
    expect(JSON.stringify(lines)).not.toContain("secret-looking");
    expect(lines[0][1]).toMatchObject({ name: "Error" });
  });
});

describe("declarations", () => {
  it("requireFeature, serverSwitch and gateExempt validate their input and return frozen descriptors", () => {
    expect(requireFeature("inboxV1")).toEqual({ type: "feature", name: "inboxV1" });
    expect(Object.isFrozen(requireFeature("inboxV1"))).toBe(true);
    for (const bad of ["", "-inboxV1", "inbox V1", 7, undefined, "x".repeat(65)]) expect(() => requireFeature(bad)).toThrow(TypeError);
    expect(SERVER_SWITCHES).toEqual(["HFY_EDITING", "ACCESS_REQUESTS", "CHAT_SERVICE_AUTH", "SYNC_API_ENABLED"]);
    expect(serverSwitch("HFY_EDITING", () => true)).toMatchObject({ type: "switch", name: "HFY_EDITING" });
    expect(() => serverSwitch("HFY_EDITING")).toThrow(/check function/); // a declared switch is always enforced
    expect(() => serverSwitch("RENDER_MODE", () => true)).toThrow(/unknown switch/);
    // a switch whose check is the route's own rule says so, and caps.json publishes the rule beside the name
    expect(describeGate(serverSwitch("ACCESS_REQUESTS", () => false, { rule: "the held member only" }))).toEqual({ switch: "ACCESS_REQUESTS", rule: "the held member only" });
    expect(describeGate(serverSwitch("HFY_EDITING", () => true))).toEqual({ switch: "HFY_EDITING" });
    for (const bad of ["", "  ", 7]) expect(() => serverSwitch("ACCESS_REQUESTS", () => false, { rule: bad })).toThrow(/rule/);
    expect(() => gateExempt("")).toThrow(TypeError);
  });

  it("parsePreview follows the ?hfy_flags syntax; previewOf reads the header in any case", () => {
    expect([...parsePreview("inboxV1, -contribV1,,bad name,-")]).toEqual([["inboxV1", true], ["contribV1", false]]);
    expect(parsePreview(undefined).size).toBe(0);
    expect(parsePreview(Array.from({ length: 40 }, (_, i) => `f${i}`).join(",")).size).toBe(32);
    expect(previewOf({ headers: { "X-HFY-Preview": "inboxV1" } })).toBe("inboxV1");
    expect(previewOf({ headers: { [PREVIEW_HEADER]: "  " } })).toBeUndefined();
    expect(previewOf({})).toBeUndefined();
  });
});

// Test routes mounted through the real registry shape: inboxV1 is dark, contribV1 is live, plus a switch-gated route.
let editing = false;
const echo = (name) => async (c) => ({ status: 200, body: { route: name, inboxV1: await c.featureOn("inboxV1") } });
const TEST_ROUTES = defineRoutes([
  { name: "test.dark", method: "GET", path: "/test/dark", gate: requireFeature("inboxV1"), handler: echo("test.dark") },
  { name: "test.live", method: "GET", path: "/test/live", gate: requireFeature("contribV1"), handler: echo("test.live") },
  { name: "test.switch", method: "GET", path: "/test/switch", gate: serverSwitch("HFY_EDITING", () => editing), handler: echo("test.switch") },
  { name: "test.switch503", method: "GET", path: "/test/svc", gate: serverSwitch("CHAT_SERVICE_AUTH", () => { throw new HttpError(503, "unavailable", "chat service keys are not configured"); }), handler: echo("x") },
]);
const MEMBER = "I0001";
const ADMIN = "I0099"; // in the admin list, not in uat
const UAT = "I0007";

describe("route gate: 404 unless the flag is on or the caller is uat; x-hfy-preview only for uat (AC2)", () => {
  let w, flags, member, admin, uat, calls;
  beforeEach(async () => {
    flags = { inboxV1: false, contribV1: true };
    calls = 0;
    editing = false;
    w = makeApi({ flags: async () => { calls += 1; return flags; }, uat: [UAT], routes: [...ROUTES, ...TEST_ROUTES] });
    [member, admin, uat] = await Promise.all([MEMBER, ADMIN, UAT].map((s) => signToken(s)));
  });
  const get = (path, token, preview) => w.call("GET", `/api${path}`, { token, ...(preview !== undefined ? { headers: { [PREVIEW_HEADER]: preview } } : {}) });

  it("signed out: a dark route is 404 not_found (indistinguishable from no route); a live route is 401", async () => {
    const dark = await get("/test/dark");
    const none = await get("/nope");
    expect(dark.status).toBe(404);
    expect(dark).toEqual(none); // same status, body and headers as a route that does not exist
    expect((await get("/test/dark", undefined, "inboxV1")).status).toBe(404);
    expect((await get("/test/live")).status).toBe(401);
  });

  it("member: dark is 404 with or without a preview header naming the flag; live is 200", async () => {
    for (const p of [undefined, "inboxV1", "inboxV1,contribV1"]) expect((await get("/test/dark", member, p)).status, String(p)).toBe(404);
    const live = await get("/test/live", member, "-contribV1"); // a member's preview cannot turn a live route off either
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ route: "test.live", inboxV1: false });
  });

  it("admin (not in uat): the same as a member", async () => {
    expect((await get("/test/dark", admin)).status).toBe(404);
    expect((await get("/test/dark", admin, "inboxV1")).status).toBe(404);
    expect((await get("/test/live", admin)).status).toBe(200);
  });

  it("uat principal: dark routes answer; their own preview header takes effect (\"-name\" turns a route off for them)", async () => {
    const r = await get("/test/dark", uat);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ route: "test.dark", inboxV1: true });
    expect((await get("/test/dark", uat, "inboxV1")).status).toBe(200);
    expect((await get("/test/dark", uat, "-inboxV1")).status).toBe(404);
    expect((await get("/test/live", uat, "-contribV1")).status).toBe(404);
    expect((await get("/test/live", uat, "-inboxV1")).body).toEqual({ route: "test.live", inboxV1: false }); // c.featureOn honours it too
  });

  it("the flip opens the route to everyone with no deploy of the API", async () => {
    expect((await get("/test/dark", member)).status).toBe(404);
    flags = { ...flags, inboxV1: true };
    expect((await get("/test/dark", member)).status).toBe(200);
    expect((await get("/test/dark")).status).toBe(401);
  });

  it("routes without a feature (the PLN-001 routes and the exempt me.get) never read the flags file", async () => {
    const before = calls;
    expect((await w.call("GET", "/api/posts", { token: member })).status).toBe(200);
    expect((await w.call("GET", "/api/me", { token: member })).status).toBe(200);
    expect(calls).toBe(before);
  });

  it("another method on a dark path is 404, not 405, unless the caller can see the path", async () => {
    expect((await w.call("POST", "/api/test/dark", { token: member, body: {} })).status).toBe(404);
    expect((await w.call("POST", "/api/test/dark", { body: {} })).status).toBe(404);
    expect((await w.call("POST", "/api/test/dark", { token: uat, body: {} })).status).toBe(405);
    expect((await w.call("POST", "/api/test/live", { token: member, body: {} })).status).toBe(405);
    expect((await w.call("PUT", "/api/posts", { token: member })).status).toBe(405); // ungated paths keep 405 without a session check
    expect((await w.call("PUT", "/api/posts")).status).toBe(405);
  });

  it("a server switch is enforced where it is declared: off is 404 (or the switch's own error), on admits", async () => {
    expect((await get("/test/switch", member)).status).toBe(404);
    expect((await get("/test/switch", uat)).status).toBe(404); // uat does not open a server switch
    expect((await get("/test/switch")).status).toBe(404);
    editing = true;
    expect((await get("/test/switch", member)).status).toBe(200);
    expect((await get("/test/switch")).status).toBe(401);
    const svc = await get("/test/svc", member);
    expect(svc.status).toBe(503);
    expect(svc.body.error).toBe("unavailable");
  });

  it("the MCP path (handler.invoke) applies the same gate, with no preview header", async () => {
    const actor = (id) => ({ id, label: id, admin: false });
    await expect(w.handler.invoke(actor(MEMBER), "test.dark")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await w.handler.invoke(actor(UAT), "test.dark")).status).toBe(200);
    expect((await w.handler.invoke(actor(MEMBER), "test.live")).status).toBe(200);
  });

  it("fails closed when the flags file has been unreadable for 10 minutes: live routes go dark for members, uat still sees them", async () => {
    const fetch = fakeFetch({ inboxV1: false, contribV1: true });
    const now = clock();
    const source = createFlagSource({ fetch, now, log: quiet });
    const w2 = makeApi({ flags: source, uat: [UAT], routes: [...ROUTES, ...TEST_ROUTES] });
    expect((await w2.call("GET", "/api/test/live", { token: member })).status).toBe(200);
    fetch.next = 503;
    now.add(9 * MIN);
    expect((await w2.call("GET", "/api/test/live", { token: member })).status).toBe(200);
    now.add(MIN + 1);
    expect((await w2.call("GET", "/api/test/live", { token: member })).status).toBe(404);
    expect((await w2.call("GET", "/api/test/live", { token: uat })).status).toBe(200);
  });

  it("without a configured gate the handler is closed: every feature off, nobody uat", async () => {
    expect(currentFeatureGate()).toBeDefined();
    const w3 = makeApi({ routes: [...ROUTES, ...TEST_ROUTES] });
    expect((await w3.call("GET", "/api/test/live", { token: member })).status).toBe(404);
    expect((await w3.call("GET", "/api/test/dark", { token: uat })).status).toBe(404);
  });
});

describe("uat comes from config/groups.json, subjects only (AC2)", () => {
  const GROUPS = { version: 1, groups: { "mcp-authors": { emails: ["cousin@example.org"], subjects: ["I0044"] }, "hfy-admin": { subjects: [ADMIN] }, uat: { subjects: [UAT], emails: ["tester@example.org"] } } };
  it("parses the uat group and the resolver reports it; emails never make anyone uat", async () => {
    expect([...parseGroupsConfig(GROUPS).uat]).toEqual([UAT]);
    expect(parseGroupsConfig({ groups: {} }).uat.size).toBe(0);
    const groups = createGroupResolver({ load: async () => GROUPS });
    expect(await groups({ sub: UAT })).toEqual([UAT_GROUP]);
    expect(await groups({ sub: "I0500", email: "tester@example.org" })).toEqual([]);
    expect(await groups({ sub: ADMIN })).toEqual(["hfy-admin"]);
  });

  it("wired as index.js wires it: a uat subject sees a dark route; an unreadable groups file makes nobody uat", async () => {
    const make = (load) => {
      const groups = createGroupResolver({ load, log: quiet });
      return makeApi({ features: createFeatureGate({ flags: async () => ({}), isUat: async (sub) => (await groups({ sub })).includes(UAT_GROUP) }), routes: [...ROUTES, ...TEST_ROUTES] });
    };
    const token = await signToken(UAT);
    expect((await make(async () => GROUPS).call("GET", "/api/test/dark", { token })).status).toBe(200);
    expect((await make(async () => { throw new Error("s3 down"); }).call("GET", "/api/test/dark", { token })).status).toBe(404);
  });

  it("a failing uat lookup counts as not uat, and a failing flags source as every feature off, logged without detail", async () => {
    const lines = [];
    const log = { error: (...a) => lines.push(a) };
    const gate = createFeatureGate({ flags: async () => ({}), isUat: async () => { throw new Error("boom detail"); }, log });
    expect(await gate.featureOn("inboxV1", UAT)).toBe(false);
    const broken = createFeatureGate({ flags: async () => { throw new Error("flags detail"); }, isUat: async () => false, log });
    expect(await broken.featureOn("inboxV1", MEMBER, null)).toBe(false);
    expect(await broken.allows(requireFeature("inboxV1"), { id: MEMBER })).toBe(false);
    expect(JSON.stringify(lines)).not.toMatch(/boom detail|flags detail/);
  });
});

describe("featureOn(name, principal) for producers (AC1, AC4)", () => {
  afterEach(() => { configureFeatures(null); });
  it("is closed until index.js configures the gate, then follows the gate's rule for a gramps_id or an actor", async () => {
    expect(await featureOn("inboxV1", UAT)).toBe(false);
    configureFeatures(createFeatureGate({ flags: async () => ({ contribV1: true }), isUat: async (s) => s === UAT }));
    expect(await featureOn("inboxV1", MEMBER)).toBe(false);
    expect(await featureOn("inboxV1", UAT)).toBe(true);
    expect(await featureOn("inboxV1", { id: UAT })).toBe(true);
    expect(await featureOn("contribV1", MEMBER)).toBe(true);
    expect(await featureOn("contribV1", undefined)).toBe(true);
    expect(await featureOn("inboxV1", undefined)).toBe(false);
    expect(await featureOn("inboxV1", MEMBER, { preview: "inboxV1" })).toBe(false); // a member's preview is ignored
    expect(await featureOn("contribV1", UAT, { preview: "-contribV1" })).toBe(false); // a uat principal's preview counts
    expect(await featureOn("not a flag", UAT)).toBe(false);
    configureFeatures(null);
    expect(await featureOn("contribV1", MEMBER)).toBe(false);
    expect(await closedFeatureGate().featureOn("contribV1", UAT)).toBe(false);
  });
});

/**
 * The PLN-001 routes, which predate the gate (HFY-TSK-063..077). Never add to this list: a PLN-002 route declares requireFeature(flag) or
 * serverSwitch(name, check), and GET /api/me is the only exemption (BRD2 10.1).
 */
const PLN001_ROUTES = Object.freeze([
  "comments.list", "comments.create", "comments.update", "comments.delete", "comments.react",
  "posts.list", "posts.get", "posts.create", "posts.update", "posts.visibility", "posts.delete",
  "uploads.presign",
  "notifications.vapid-public-key", "notifications.subscribe", "notifications.unsubscribe", "notifications.preferences.get", "notifications.preferences.put",
]);
const EXEMPT = Object.freeze(["me.get"]);
/** The caps rule: the names of caps.json actions that break it. Only me.get may be exempt; a pre-gate route may stay ungated. */
function gateViolations(actions) {
  return actions.filter((a) => {
    if (a.gate?.exempt !== undefined) return !EXEMPT.includes(a.name);
    if (typeof a.gate?.feature === "string" || SERVER_SWITCHES.includes(a.gate?.switch)) return false;
    return !PLN001_ROUTES.includes(a.name);
  }).map((a) => a.name);
}

describe("caps: every PLN-002 route declares a feature or a server switch; only GET /api/me is exempt (AC3)", () => {
  it("caps.json carries each route's gate and no action breaks the rule", () => {
    const caps = buildCaps();
    expect(gateViolations(caps.actions)).toEqual([]);
    expect(caps.actions.filter((a) => a.gate?.exempt).map((a) => `${a.method} ${a.path}`)).toEqual(["GET /api/me"]);
    for (const r of ROUTES) if (r.gate) expect(["feature", "switch", "exempt"]).toContain(r.gate.type);
  });

  it("fails for a new route without a gate, or with an exemption, and passes for a feature or a switch", () => {
    const base = buildCaps().actions;
    const extra = defineRoutes([
      { name: "subscriptions.put", method: "PUT", path: "/subscriptions/:id", handler: echo("x") },
      { name: "contributions.list", method: "GET", path: "/contributions", gate: gateExempt("convenient"), handler: echo("x") },
      { name: "inbox.list", method: "GET", path: "/inbox", gate: requireFeature("inboxV1"), handler: echo("x") },
      { name: "proposals.list", method: "GET", path: "/proposals", gate: serverSwitch("HFY_EDITING", () => false), handler: echo("x") },
    ]).map((r) => ({ name: r.name, ...(r.gate ? { gate: r.gate.type === "feature" ? { feature: r.gate.name } : r.gate.type === "switch" ? { switch: r.gate.name } : { exempt: r.gate.reason } } : {}) }));
    expect(gateViolations([...base, ...extra])).toEqual(["subscriptions.put", "contributions.list"]);
    expect(gateViolations(base.map((a) => (a.name === "posts.list" ? { ...a, gate: { exempt: "x" } } : a)))).toEqual(["posts.list"]);
  });

  it("me.get stays ungated at runtime: a member reaches it with every flag off", async () => {
    const w = makeApi({ flags: {}, uat: [] });
    expect((await w.call("GET", "/api/me", { token: await signToken(MEMBER) })).status).toBe(200);
  });
});

describe("persist-first inbox writes wait for featureOn('inboxV1', recipient) (AC4)", () => {
  const sub = { endpoint: "https://push.example.test/s1", keys: { p256dh: "p", auth: "a" } };
  // The kit's in-memory NotificationStore, recording every add so a test can assert who got what.
  const fakeInbox = () => {
    const store = new InMemoryNotificationStore();
    store.items = [];
    const add = store.add.bind(store);
    store.add = async (principal, input) => { store.items.push({ principal, type: input.type, navigate: input.navigate, fields: input.fields }); return add(principal, input); };
    return store;
  };

  it("flag off: no inbox item is stored and the push carries no app_badge; flag on: stored first, badge in the push", async () => {
    const inbox = fakeInbox();
    const flags = { inboxV1: false };
    const w = makeApi({ flags, uat: [UAT], inbox });
    await w.subscriptions.put(MEMBER, sub);
    const olive = await signToken("I0002");
    expect((await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${MEMBER}`, body: "hello" } })).status).toBe(201);
    expect(inbox.items).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload.notification).not.toHaveProperty("app_badge");

    flags.inboxV1 = true;
    await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${MEMBER}`, body: "again" } });
    expect(inbox.items).toEqual([{ principal: MEMBER, type: "comment_on_my_record", navigate: `/person/?id=${MEMBER}`, fields: { actor: "I0002" } }]);
    expect(w.sent.at(-1).payload.notification.app_badge).toBe(1);
  });

  it("flag off: a uat recipient still gets the item (UAT on production); nobody else does", async () => {
    const inbox = fakeInbox();
    const w = makeApi({ flags: { inboxV1: false }, uat: [UAT], inbox });
    const olive = await signToken("I0002");
    await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${UAT}`, body: "hi" } });
    await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${MEMBER}`, body: "hi" } });
    expect(inbox.items.map((i) => i.principal)).toEqual([UAT]);
  });

  it("the actor's preview header never decides a recipient's inbox", async () => {
    const inbox = fakeInbox();
    const w = makeApi({ flags: { inboxV1: false }, uat: [UAT], inbox });
    await w.call("POST", "/api/comments", { token: await signToken(UAT), headers: { [PREVIEW_HEADER]: "inboxV1" }, body: { subject: `person:${MEMBER}`, body: "hi" } });
    expect(inbox.items).toEqual([]);
  });

  it("persist first: with no push configured the item is still stored while the flag is on, and not while it is off", async () => {
    const inbox = fakeInbox();
    const flags = { inboxV1: false };
    const w = makeApi({ withPush: false, flags, inbox });
    const olive = await signToken("I0002");
    await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${MEMBER}`, body: "one" } });
    expect(inbox.items).toEqual([]);
    flags.inboxV1 = true;
    await w.call("POST", "/api/comments", { token: olive, body: { subject: `person:${MEMBER}`, body: "two" } });
    expect(inbox.items.map((i) => i.principal)).toEqual([MEMBER]);
    expect(w.sent).toEqual([]);
  });

  it("new_family_post is push-only, and a notifier without featureOn never writes the inbox (fail closed)", async () => {
    const inbox = fakeInbox();
    const w = makeApi({ flags: { inboxV1: true }, inbox });
    await w.subscriptions.put("I0002", sub);
    await w.call("POST", "/api/posts", { token: await signToken(MEMBER), body: { body: "news", visibility: "published" } });
    expect(w.sent).toHaveLength(1);
    expect(inbox.items).toEqual([]);

    const n = createNotifier({ inbox, log: quiet });
    await n.notify("mention", [MEMBER], { navigate: "/", actorLabel: "x" });
    expect(inbox.items).toEqual([]);
  });
});

describe("read path is named: HTTPS through CloudFront, no new S3 grant (AC6)", () => {
  it("index.js builds the gate from createFlagSource over the site url and the groups resolver; features.js imports no AWS SDK", () => {
    const index = readFileSync(resolve(here, "../src/index.js"), "utf8");
    expect(index).toMatch(/createFlagSource\(\{ url: env\.FLAGS_URL \?\? DEFAULT_FLAGS_URL \}\)/);
    expect(index).toMatch(/isUat: async \(sub\) => \(await getGroups\(\{ sub \}\)\)\.includes\(UAT_GROUP\)/);
    expect(index).toMatch(/\bfeatures,/);
    const features = readFileSync(resolve(here, "../src/features.js"), "utf8");
    expect(features).not.toMatch(/@aws-sdk/);
  });
  it("the app stack grants nothing on _data/ (the flags file is read through the site, not S3)", () => {
    const stack = readFileSync(resolve(here, "../../infrastructure/cloudformation/app-stack.yaml"), "utf8");
    expect(stack).not.toMatch(/_data/);
    expect(stack).not.toMatch(/FLAGS_URL/);
  });
});
