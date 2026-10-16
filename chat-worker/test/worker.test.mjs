// The Worker half of the bundle (HFY-TSK-198 ACs 2 and 4): the upgrade checks, what the Durable Object is handed, what passes
// through to CloudFront, and that no header or frame text reaches the console. Runs the committed dist/index.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { testKeys } from "@io-kit/chat/testing";
import { fakeNamespace, installShims, loadBundle, spyConsole } from "./helpers.mjs";

const SITE = "https://harrisonfamily.test";
const JWKS_URL = "https://harrisonfamily.test/auth/.well-known/jwks.json";
let keys;
let bundle;
let restoreShims;
let realFetch;
let outbound;
let pairs;

const closedWith = (server) => server.closed;

before(async () => {
  bundle = await loadBundle();
  keys = await testKeys({ issuer: `${SITE}/auth`, audience: "family-web", kid: "worker-test-1" });
  pairs = [];
  restoreShims = installShims({
    pair: () => {
      const server = { closed: null, accept() {}, close(code, reason) { this.closed = { code, reason }; }, send() {}, serializeAttachment() {}, deserializeAttachment() {} };
      const client = { kind: "client" };
      pairs.push({ client, server });
      return [client, server];
    },
  });
  realFetch = globalThis.fetch;
  outbound = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url === JWKS_URL) return new Response(keys.jwksJson(), { status: 200, headers: { "content-type": "application/json" } });
    outbound.push(req);
    return new Response("from the origin", { status: 200 });
  };
});
after(() => {
  restoreShims();
  globalThis.fetch = realFetch;
});

const baseEnv = (ns, extra = {}) => ({
  CHAT_HUB: ns, SITE_ORIGIN: SITE, SESSION_ISSUER: `${SITE}/auth`, SESSION_AUDIENCE: "family-web", SESSION_JWKS_URL: JWKS_URL,
  SESSION_COOKIE: "io_id", CHAT_ENABLED: "1", CHAT_OPEN_TO: "all", CHAT_WORKER_VERSION: "abc1234", ...extra,
});
const upgrade = (headers = {}) => new Request(`${SITE}/chat/ws`, { method: "GET", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: SITE, ...headers } });

test("an accepted upgrade reaches the hub as a NEW Request that carries only x-chat-uid and x-chat-exp (never the Cookie)", async () => {
  const ns = fakeNamespace();
  const cookie = await keys.cookie("I9001");
  const secret = cookie.split("=")[1];
  const req = upgrade({ cookie: `${cookie}; other=1`, authorization: "Bearer should-not-travel", "x-forwarded-for": "203.0.113.9", "user-agent": "smoke/1", referer: `${SITE}/chat/` });
  const res = await bundle.default.fetch(req, baseEnv(ns), {});
  assert.equal(await res.text(), "hub", "the hub's own response is returned as it is");
  assert.equal(ns.calls.requests.length, 1);
  const forwarded = ns.calls.requests[0];
  assert.notEqual(forwarded, req, "a new Request, not the incoming one");
  const names = [...forwarded.headers.keys()].sort();
  const allowed = new Set(["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "x-chat-uid", "x-chat-exp"]);
  for (const n of names) assert.ok(allowed.has(n), `header ${n} reached the Durable Object`);
  assert.equal(forwarded.headers.get("x-chat-uid"), "I9001");
  assert.match(forwarded.headers.get("x-chat-exp"), /^\d{1,12}$/);
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.ok(![...forwarded.headers.values()].some((v) => v.includes(secret)), "the session token is not in any forwarded header");
  assert.equal(forwarded.headers.get("authorization"), null);
  assert.equal(forwarded.method, "GET");
});

test("the hub is created with locationHint wnam on its first get(), by the one name 'family'", async () => {
  const ns = fakeNamespace();
  await bundle.default.fetch(upgrade({ cookie: await keys.cookie("I9002") }), baseEnv(ns), {});
  assert.deepEqual(ns.calls.idFromName, ["family"]);
  assert.equal(ns.calls.get.length, 1);
  assert.deepEqual(ns.calls.get[0].options, { locationHint: "wnam" });
});

test("the upgrade checks the exact Origin: close 4403, and the hub is never reached", async () => {
  for (const origin of ["https://harrisonfamily.test.evil.test", `${SITE}/`, "http://harrisonfamily.test", "HTTPS://HARRISONFAMILY.TEST", ""]) {
    const ns = fakeNamespace();
    const before = pairs.length;
    const res = await bundle.default.fetch(upgrade({ origin, cookie: await keys.cookie("I9001") }), baseEnv(ns), {});
    assert.equal(res.status, 101, "a browser can only read a close code");
    assert.equal(closedWith(pairs[before].server)?.code, 4403, `origin ${JSON.stringify(origin)}`);
    assert.equal(ns.calls.get.length, 0);
  }
  const ns = fakeNamespace();
  const noOrigin = new Request(`${SITE}/chat/ws`, { headers: { upgrade: "websocket", cookie: await keys.cookie("I9001") } });
  const before = pairs.length;
  await bundle.default.fetch(noOrigin, baseEnv(ns), {});
  assert.equal(closedWith(pairs[before].server)?.code, 4403);
});

test("no cookie closes 4401, the kill switch 4503, a non-UAT member 4403", async () => {
  const ns = fakeNamespace();
  let before = pairs.length;
  await bundle.default.fetch(upgrade(), baseEnv(ns), {});
  assert.equal(closedWith(pairs[before].server)?.code, 4401);
  before = pairs.length;
  await bundle.default.fetch(upgrade({ cookie: await keys.cookie("I9001") }), baseEnv(ns, { CHAT_ENABLED: "0" }), {});
  assert.equal(closedWith(pairs[before].server)?.code, 4503);
  before = pairs.length;
  await bundle.default.fetch(upgrade({ cookie: await keys.cookie("I9003") }), baseEnv(ns, { CHAT_OPEN_TO: "uat", CHAT_UAT_SUBJECTS: "I9001,I9002" }), {});
  assert.equal(closedWith(pairs[before].server)?.code, 4403);
  before = pairs.length;
  await bundle.default.fetch(upgrade({ cookie: await keys.cookie("I9002") }), baseEnv(ns, { CHAT_OPEN_TO: "uat", CHAT_UAT_SUBJECTS: "I9001,I9002" }), {});
  assert.equal(pairs.length, before, "a UAT member is let through without a refusal pair");
  assert.equal(ns.calls.requests.length, 1);
});

test("non-upgrade requests on the routes pass through with fetch(request), unchanged", async () => {
  const ns = fakeNamespace();
  const cases = [
    new Request(`${SITE}/chat/ws`, { method: "GET" }),
    new Request(`${SITE}/chat/ws`, { method: "POST", body: "x" }),
    new Request(`${SITE}/chat/wsfoo`, { method: "GET" }),
    new Request(`${SITE}/chat/v1/other`, { method: "GET" }),
    new Request(`${SITE}/chat/v1/health`, { method: "POST", body: "x" }),
    new Request(`${SITE}/chat/v1/health`, { method: "HEAD" }),
  ];
  for (const req of cases) {
    outbound.length = 0;
    const res = await bundle.default.fetch(req, baseEnv(ns), {});
    assert.equal(outbound.length, 1, `${req.method} ${new URL(req.url).pathname} was not passed on`);
    assert.equal(outbound[0], req, "the very same request object");
    assert.equal(await res.text(), "from the origin");
  }
  assert.equal(ns.calls.get.length, 0, "the hub saw none of them");
});

test("GET /chat/v1/health answers itself: ok, the commit sha CI injected, protocol 1, no-store", async () => {
  outbound.length = 0;
  const res = await bundle.default.fetch(new Request(`${SITE}/chat/v1/health`), baseEnv(fakeNamespace()), {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: "abc1234", protocol: 1 });
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(outbound.length, 0);
});

test("nothing reaches the console: no header, no cookie, no frame text (PS-16)", async () => {
  const spy = spyConsole();
  const ns = fakeNamespace();
  const cookie = await keys.cookie("I9001");
  const secret = cookie.split("=")[1];
  try {
    await bundle.default.fetch(upgrade({ cookie, authorization: "Bearer HEADER-SECRET-1", "x-api-key": "HEADER-SECRET-2", "x-forwarded-for": "203.0.113.77" }), baseEnv(ns), {});
    await bundle.default.fetch(upgrade({ cookie: "io_id=BAD-TOKEN-VALUE", authorization: "Bearer HEADER-SECRET-3" }), baseEnv(ns), {});
    await bundle.default.fetch(upgrade({ origin: "https://evil.test", cookie }), baseEnv(ns), {});
    await bundle.default.fetch(new Request(`${SITE}/chat/ws`, { headers: { cookie, authorization: "Bearer HEADER-SECRET-4" } }), baseEnv(ns), {});
    await bundle.default.fetch(new Request(`${SITE}/chat/v1/health`, { headers: { cookie } }), baseEnv(ns), {});
  } finally {
    spy.restore();
  }
  const out = spy.text();
  for (const needle of [secret, "HEADER-SECRET", "BAD-TOKEN-VALUE", "203.0.113", "Bearer", "sec-websocket", "dGhlIHNhbXBsZSBub25jZQ"]) {
    assert.ok(!out.includes(needle), `console output holds ${needle}`);
  }
});
