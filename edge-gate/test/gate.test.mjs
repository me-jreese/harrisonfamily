import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGate, NO_STORE } from "../src/gate.mjs";

const ISS = "https://harrisonfamily.us/auth";
const AUD = "harrisonfamily-web";
const NOW = 1_800_000_000_000; // fixed clock (ms)
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
}
function mint(key, claims = {}, hdr = {}) {
  const c = { iss: ISS, aud: AUD, sub: "I9999", exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, ...claims };
  const h = b64u({ alg: "RS256", typ: "JWT", kid: key.kid, ...hdr });
  const p = b64u(c);
  const sig = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}
function harness(initialKeys, over = {}) {
  let jwks = initialKeys.map((k) => k.jwk);
  const calls = { n: 0 };
  const fetchStub = async () => { calls.n++; return { ok: true, json: async () => ({ keys: jwks }) }; };
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/jwks.json", minRefetchSeconds: 0, failureBackoffSeconds: 0, ...over },
    { fetch: fetchStub, now: () => NOW, log: () => {} });
  return { gate, calls, setKeys: (ks) => { jwks = ks.map((k) => k.jwk); } };
}
function event({ cookie, accept = "*/*", mode, uri = "/person/I0001.json", qs = "" } = {}) {
  const headers = { accept: [{ key: "Accept", value: accept }] };
  if (cookie !== undefined) headers.cookie = [{ key: "Cookie", value: cookie }];
  if (mode) headers["sec-fetch-mode"] = [{ key: "Sec-Fetch-Mode", value: mode }];
  return { Records: [{ cf: { request: { uri, querystring: qs, method: "GET", headers } } }] };
}
const ck = (t) => `theme=dark; io_id=${t}; other=1`;
const isPass = (r) => r.uri !== undefined && r.status === undefined;
const is401 = (r) => {
  assert.equal(r.status, "401");
  assert.equal(r.headers["cache-control"][0].value, "private, no-store");
  assert.equal(r.headers["content-type"][0].value, "application/json");
  assert.deepEqual(JSON.parse(r.body), { error: "unauthenticated" });
};

const K = makeKey("hfy-session-1");

test("valid session passes and the request is returned unchanged", async () => {
  const { gate } = harness([K]);
  const ev = event({ cookie: ck(mint(K)), mode: "cors" });
  const req = ev.Records[0].cf.request;
  const r = await gate.handler(ev);
  assert.ok(isPass(r));
  assert.equal(r, req);
});

test("deny shapes: fetch/XHR get 401 JSON, navigations get a login redirect", async () => {
  const { gate } = harness([K]);
  is401(await gate.handler(event({ accept: "application/json" })));
  is401(await gate.handler(event({ mode: "cors" })));
  is401(await gate.handler(event({ mode: "no-cors", accept: "image/avif,image/webp,*/*" })));
  is401(await gate.handler(event({ mode: "navigate", accept: "text/html,application/json" }))); // json accept wins
  const nav = await gate.handler(event({ mode: "navigate", accept: "text/html", uri: "/media/a b.svg", qs: "x=1&y=2" }));
  assert.equal(nav.status, "302");
  assert.equal(nav.headers.location[0].value, "/auth/login?returnTo=" + encodeURIComponent("/media/a b.svg?x=1&y=2"));
  assert.equal(nav.headers["cache-control"][0].value, "private, no-store");
  const navNoFetchMeta = await gate.handler(event({ accept: "text/html" })); // old browser without Sec-Fetch-*
  assert.equal(navNoFetchMeta.status, "302");
});

test("returnTo cannot become protocol-relative", async () => {
  const { gate } = harness([K]);
  const r = await gate.handler(event({ mode: "navigate", accept: "text/html", uri: "//evil.example/x" }));
  assert.equal(r.headers.location[0].value, "/auth/login?returnTo=" + encodeURIComponent("/evil.example/x"));
});

test("missing cookie, other cookies only, and garbage are denied", async () => {
  const { gate } = harness([K]);
  is401(await gate.handler(event({ mode: "cors" })));
  is401(await gate.handler(event({ mode: "cors", cookie: "theme=dark; sid=abc" })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck("not-a-jwt") })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck("a.b.c") })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck("x".repeat(9000)) })));
});

test("expired is denied; within the 60s skew is still accepted; nbf in the future is denied", async () => {
  const { gate } = harness([K]);
  const t = NOW / 1000;
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { exp: t - 61 })) })));
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { exp: t - 59 })) }))));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { nbf: t + 61 })) })));
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { nbf: t + 59 })) }))));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { exp: undefined })) })));
});

test("wrong audience, wrong issuer, missing sub are denied; an audience array containing ours passes", async () => {
  const { gate } = harness([K]);
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { aud: "https://harrisonfamily.us/mcp" })) })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { iss: "https://evil.example/auth" })) })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { sub: "" })) })));
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { aud: [AUD, "other"] })) }))));
});

test("bad signature, wrong key under a known kid, alg none/HS256 are denied", async () => {
  const { gate } = harness([K]);
  const other = makeKey("hfy-session-1"); // same kid, different key
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(other)) })));
  const good = mint(K);
  const [h, p, s] = good.split(".");
  is401(await gate.handler(event({ mode: "cors", cookie: ck(`${h}.${b64u({ iss: ISS, aud: AUD, sub: "I1", exp: NOW / 1000 + 99 })}.${s}`) })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(`${b64u({ alg: "none", kid: K.kid })}.${p}.`) })));
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, {}, { alg: "HS256" })) })));
});

test("unknown kid: JWKS is refetched, then denied; a rotated-in key is accepted after the refetch", async () => {
  const { gate, calls, setKeys } = harness([K]);
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))));
  assert.equal(calls.n, 1);
  const K2 = makeKey("hfy-session-2");
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K2)) })));
  assert.equal(calls.n, 2, "unknown kid forces one refetch");
  setKeys([K, K2]); // key rotation published
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K2)) }))));
  assert.equal(calls.n, 3);
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))));
  assert.equal(calls.n, 3, "known kids are served from the module cache");
});

test("refetch for unknown kids is rate limited (minRefetchSeconds)", async () => {
  const { gate, calls } = harness([K], { minRefetchSeconds: 30 });
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))));
  for (let i = 0; i < 5; i++) is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(makeKey(`forged-${i}`))) })));
  assert.equal(calls.n, 1);
});

test("JWKS outage fails closed on a cold cache and keeps serving known keys from a warm one", async () => {
  let down = true;
  const jwk = K.jwk;
  const fetchStub = async () => { if (down) throw new Error("boom"); return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  let t = NOW;
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j", minRefetchSeconds: 0, failureBackoffSeconds: 0, jwksTtlSeconds: 10 }, { fetch: fetchStub, now: () => t, log: () => {} });
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) })));
  down = false;
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))));
  down = true; t += 60_000; // stale cache, JWKS unreachable: the last good keys are still used
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K, { exp: t / 1000 + 100 })) }))));
});

test("HFY-R65: every gate-generated response is private, no-store (Cloudflare must not keep it)", async () => {
  assert.equal(NO_STORE, "private, no-store");
  const { gate } = harness([K]);
  for (const ev of [event({ mode: "cors" }), event({ mode: "navigate", accept: "text/html" }), event({ accept: "image/*", mode: "no-cors", uri: "/media/tree_I0001.svg" })]) {
    const r = await gate.handler(ev);
    assert.ok(r.status === "401" || r.status === "302");
    assert.deepEqual(r.headers["cache-control"], [{ key: "Cache-Control", value: "private, no-store" }]);
  }
});

function flaky(jwks, script) { // script: array of "fail" | "empty" | "ok" consumed per fetch; afterwards "ok"
  const calls = { n: 0 };
  const fetchStub = async () => {
    const step = script[calls.n++] ?? "ok";
    if (step === "fail") throw new Error("TimeoutError: cold auth edge");
    if (step === "http500") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ keys: step === "empty" ? [] : jwks.map((k) => k.jwk) }) };
  };
  return { fetchStub, calls };
}

test("edge-gate-jwks-cold-lockout: a failed first JWKS fetch is retried after the short backoff, not after minRefetchSeconds", async () => {
  let t = NOW;
  const { fetchStub, calls } = flaky([K], ["fail"]);
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j", minRefetchSeconds: 30, failureBackoffSeconds: 2 },
    { fetch: fetchStub, now: () => t, log: () => {} });
  const ok = () => gate.handler(event({ mode: "cors", cookie: ck(mint(K, { exp: t / 1000 + 600 })) }));
  is401(await ok()); // cold container, JWKS fetch failed: fail closed
  assert.equal(calls.n, 1);
  t += 1_000;
  is401(await ok()); // inside the 2 s backoff: still denied, and no second fetch
  assert.equal(calls.n, 1, "the failure backoff rate-limits retries");
  t += 1_500; // 2.5 s after the failure, well inside the 30 s success cooldown
  assert.ok(isPass(await ok()), "the next request after the backoff retries and the member gets in");
  assert.equal(calls.n, 2);
});

test("a JWKS answer without usable keys and an HTTP error both count as failures (short backoff, still fail closed)", async () => {
  for (const bad of ["empty", "http500"]) {
    let t = NOW;
    const { fetchStub, calls } = flaky([K], [bad]);
    const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j", minRefetchSeconds: 30, failureBackoffSeconds: 2 },
      { fetch: fetchStub, now: () => t, log: () => {} });
    is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) })));
    t += 2_001;
    assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))), bad);
    assert.equal(calls.n, 2, bad);
  }
});

test("while the JWKS keeps failing, retries stay rate limited and the last good keys stay in use", async () => {
  let t = NOW;
  const { fetchStub, calls } = flaky([K], ["ok", "fail", "fail", "fail", "fail", "fail"]);
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j", minRefetchSeconds: 30, failureBackoffSeconds: 2, jwksTtlSeconds: 10 },
    { fetch: fetchStub, now: () => t, log: () => {} });
  const tok = () => ck(mint(K, { exp: t / 1000 + 600 }));
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: tok() }))));
  assert.equal(calls.n, 1);
  t += 60_000; // cache stale; JWKS now failing
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: tok() }))), "stale but known key still verifies");
  assert.equal(calls.n, 2);
  for (let i = 0; i < 10; i++) assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: tok() })))); // same instant
  assert.equal(calls.n, 2, "no retry inside the backoff");
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(makeKey("forged"))) }))); // unknown kid is still a deny
  assert.equal(calls.n, 2);
  t += 2_000;
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: tok() }))));
  assert.equal(calls.n, 3, "one retry per backoff window");
});

test("after a successful fetch, unknown kids still wait minRefetchSeconds (the short backoff only follows failures)", async () => {
  let t = NOW;
  const { fetchStub, calls } = flaky([K], []);
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j", minRefetchSeconds: 30, failureBackoffSeconds: 2 },
    { fetch: fetchStub, now: () => t, log: () => {} });
  assert.ok(isPass(await gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }))));
  t += 5_000;
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(makeKey("forged-a"))) })));
  assert.equal(calls.n, 1);
  t += 26_000;
  is401(await gate.handler(event({ mode: "cors", cookie: ck(mint(makeKey("forged-b"))) })));
  assert.equal(calls.n, 2);
});

test("concurrent requests on a cold container share one in-flight JWKS fetch instead of being denied", async () => {
  let release;
  const gateOpen = new Promise((r) => { release = r; });
  let n = 0;
  const fetchStub = async () => { n++; await gateOpen; return { ok: true, json: async () => ({ keys: [K.jwk] }) }; };
  const gate = createGate({ issuer: ISS, audience: AUD, jwksUrl: "https://example.test/j" }, { fetch: fetchStub, now: () => NOW, log: () => {} });
  const a = gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }));
  const b = gate.handler(event({ mode: "cors", cookie: ck(mint(K)) }));
  release();
  assert.ok(isPass(await a));
  assert.ok(isPass(await b));
  assert.equal(n, 1);
});

test("gate.config.json matches the auth edge session settings", () => {
  const gateCfg = JSON.parse(readFileSync(new URL("../gate.config.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../../auth/edge.manifest.json", import.meta.url), "utf8"));
  assert.equal(gateCfg.issuer, manifest.session.issuer);
  assert.equal(gateCfg.audience, manifest.session.audience);
  assert.equal(gateCfg.jwksUrl, `${manifest.session.issuer}/.well-known/jwks.json`);
  assert.equal(gateCfg.cookie, "io_id");
  assert.ok(gateCfg.failureBackoffSeconds > 0 && gateCfg.failureBackoffSeconds <= 5, "a failed JWKS fetch is retried within seconds");
  assert.ok(gateCfg.failureBackoffSeconds < gateCfg.minRefetchSeconds);
  assert.ok(gateCfg.fetchTimeoutMs >= 2000 && gateCfg.fetchTimeoutMs <= 4000, "inside the 5 s viewer-request budget");
});
