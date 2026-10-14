// HFY-R66: authV2 session continuity (11ty/js/feature-flags.js edgeSession / dataFetch). Run: node --test tests/client/*.test.mjs
// Loads the real feature-flags.js into a vm sandbox with a routed fetch stub and records every request it makes.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../11ty/${p}`, import.meta.url), "utf8");
const FLAGS_SRC = read("js/feature-flags.js");
const AUTH_V2_SRC = read("js/auth-v2.js");
const NOW_S = () => Math.floor(Date.now() / 1000);
const LOGIN = (path) => "/auth/login?returnTo=" + encodeURIComponent(path);

const res = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const store = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => Object.fromEntries(m) };
};
const blocked = () => ({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });

/**
 * routes: { session: () => res, refresh: () => res, data: (url, init, n) => res } (each may be a function of call count).
 * Returns the sandbox window plus `calls` (every fetch: {url, init}).
 */
function load({ flags = { authV2: true }, routes = {}, local = {}, session = {}, sessionStorageBlocked = false, pathname = "/person/", search = "?id=I0001", nodes = [] } = {}) {
  const calls = [];
  const counts = { session: 0, refresh: 0, data: 0 };
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout, Date, Number, Object, JSON,
    sessionStorage: sessionStorageBlocked ? blocked() : store(session), localStorage: store(local),
    HFY_FEATURE_FLAGS: {
      components: {
        navbarSearch: { showWhen: { loggedIn: [true, "true"] } },
        familyLoginLink: { showWhen: { loggedIn: [false, "false", "unknown", null] } },
        myRecordLink: { showWhen: { loggedIn: [true, "true"], hasRecord: [true, "true"] } },
      },
    },
    document: {
      readyState: "complete", addEventListener() {}, querySelectorAll: (sel) => (sel === "[data-feature]" ? nodes : []), querySelector: () => null,
      head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } },
      createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {} } }),
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === "/_data/flags.json") return res(200, flags);
      if (url === "/auth/session") return (routes.session || (() => res(200, { authenticated: true, sub: "I0001", exp: NOW_S() + 3000 })))(++counts.session);
      if (url === "/auth/refresh") {
        const r = routes.refresh || (() => res(200, { exp: NOW_S() + 3600 }));
        return r(++counts.refresh);
      }
      return (routes.data || (() => res(200, { ok: true })))(url, init, ++counts.data);
    },
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = {
    hostname: "localhost", pathname, search, hash: "", href: `http://localhost${pathname}${search}`, replaced: [],
    replace(u) { this.replaced.push(u); },
  };
  vm.runInNewContext(FLAGS_SRC, sandbox);
  return { w: sandbox, calls, counts, urls: () => calls.map((c) => c.url) };
}

const node = (feature) => {
  const attrs = { "data-feature": feature };
  const classes = new Set(["d-none"]);
  return {
    dataset: {}, hidden: true,
    getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs || (k === "hidden" && true), toggleAttribute() {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    get visible() { return this.dataset.featureVisible === "true"; },
  };
};

test("authV2 off: dataFetch is exactly fetch(url, init) and edgeSession makes no request (flag-off parity)", async () => {
  const { w, calls, urls } = load({ flags: { authV2: false } });
  const init = { credentials: "include", headers: { "X-HFY-Session": "legacy" } };
  const r = await w.HFYFeatureFlags.dataFetch("/person/I0001.json", init);
  assert.equal(r.status, 200);
  assert.equal(await w.HFYFeatureFlags.edgeSession(), null);
  assert.deepEqual(urls(), ["/_data/flags.json", "/person/I0001.json"]);
  assert.equal(calls[1].init, init, "the caller's own init object is passed through untouched");
  // a legacy 401 is just returned: no refresh, no redirect
  const off = load({ flags: { authV2: false }, routes: { data: () => res(401) } });
  assert.equal((await off.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {})).status, 401);
  assert.deepEqual(off.urls(), ["/_data/flags.json", "/person/I0001.json"]);
  assert.deepEqual(off.w.location.replaced, []);
});

test("authV2, fresh session: one /auth/session per page, no refresh, cookie-only data requests", async () => {
  const { w, calls, urls } = load();
  await Promise.all([w.HFYFeatureFlags.dataFetch("/person/index.json", { credentials: "same-origin" }), w.HFYFeatureFlags.dataFetch("/person/search-index.json", { credentials: "same-origin" })]);
  await w.HFYFeatureFlags.edgeSession();
  assert.deepEqual(urls().filter((u) => u.startsWith("/auth/")), ["/auth/session"]);
  for (const c of calls.filter((c) => c.url.startsWith("/person/"))) {
    assert.equal(c.init.credentials, "same-origin");
    assert.equal(c.init.headers, undefined);
  }
  assert.deepEqual(w.location.replaced, []);
});

test("(a) preflight: a signed-out or near-expiry session is refreshed once before the first data fetch", async () => {
  for (const s of [{ authenticated: false }, { authenticated: true, sub: "I0001", exp: NOW_S() + 30 }]) {
    const { w, calls, urls } = load({ routes: { session: () => res(200, s) } });
    await w.HFYFeatureFlags.dataFetch("/person/I0001.json", { credentials: "same-origin" });
    await w.HFYFeatureFlags.dataFetch("/person/I0002.json", { credentials: "same-origin" });
    const order = urls().filter((u) => u !== "/_data/flags.json");
    assert.equal(order.filter((u) => u === "/auth/refresh").length, 1, JSON.stringify(s));
    assert.ok(order.indexOf("/auth/refresh") < order.indexOf("/person/I0001.json"), "refresh happens before the first data fetch");
    const refresh = calls.find((c) => c.url === "/auth/refresh").init;
    assert.equal(refresh.method, "POST");
    assert.equal(refresh.credentials, "same-origin");
    assert.equal(refresh.headers["x-requested-with"], "io-kit");
  }
});

test("(a) after a preflight refresh the page's session view is asked again (navigation follows the new io_id)", async () => {
  const nodes = [node("navbarSearch")];
  const { w, counts } = load({ nodes, routes: { session: (n) => res(200, n === 1 ? { authenticated: false } : { authenticated: true, sub: "I0001", exp: NOW_S() + 3600 }) } });
  await w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  const s = await w.HFYFeatureFlags.edgeSession();
  assert.equal(s.authenticated, true);
  assert.equal(counts.refresh, 1);
  assert.equal(counts.session, 2);
  assert.equal(nodes[0].visible, true);
});

test("(b) a gate 401 is refreshed once (single-flight across concurrent fetches) and each request retried once", async () => {
  const seen = new Map();
  const { w, counts } = load({
    routes: {
      data: (url) => { const n = (seen.get(url) || 0) + 1; seen.set(url, n); return res(n === 1 ? 401 : 200, { url }); },
    },
  });
  const [a, b] = await Promise.all([
    w.HFYFeatureFlags.dataFetch("/person/index.json", { credentials: "same-origin" }),
    w.HFYFeatureFlags.dataFetch("/person/search-index.json", { credentials: "same-origin" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(counts.refresh, 1, "one refresh shared by both fetches");
  assert.deepEqual([...seen.values()], [2, 2], "each request retried exactly once");
  assert.deepEqual(w.location.replaced, []);
});

test("(c) refresh fails: an interactive load goes to /auth/login once; a background load never redirects", async () => {
  const fail = { data: () => res(401), refresh: () => res(401, { code: "AUTH_REFRESH_FAILED" }) };
  const bg = load({ routes: fail, local: { "hfy:edge-session": "1" } });
  const r = await bg.w.HFYFeatureFlags.dataFetch("/person/index.json", {}, { interactive: false });
  assert.equal(r.status, 401);
  assert.deepEqual(bg.w.location.replaced, []);
  assert.equal(bg.w.localStorage.getItem("hfy:edge-session"), null, "a dead refresh token clears the marker");

  const fg = load({ routes: fail });
  const r2 = await fg.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  assert.equal(r2.status, 401);
  assert.deepEqual(fg.w.location.replaced, [LOGIN("/person/?id=I0001")]);
  assert.equal(fg.counts.refresh, 1);
  // no loops: further 401s on the page neither refresh again nor redirect again
  await fg.w.HFYFeatureFlags.dataFetch("/person/I0002.json", {});
  assert.equal(fg.counts.refresh, 1);
  assert.equal(fg.w.location.replaced.length, 1);
});

test("no cross-page loop: a tab just sent to sign-in is not sent again; a successful data load clears the guard", async () => {
  const fail = { data: () => res(401), refresh: () => res(401) };
  const back = load({ routes: fail, session: { "hfy:auth-bounce": String(Date.now() - 30_000) } });
  assert.equal((await back.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {})).status, 401);
  assert.deepEqual(back.w.location.replaced, [], "returned from /auth/login and still denied: the caller shows its error");
  assert.equal(back.w.HFYFeatureFlags.signInUrl(), LOGIN("/person/?id=I0001"));

  const stale = load({ routes: fail, session: { "hfy:auth-bounce": String(Date.now() - 11 * 60_000) } });
  await stale.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  assert.deepEqual(stale.w.location.replaced, [LOGIN("/person/?id=I0001")]);

  const ok = load({ session: { "hfy:auth-bounce": String(Date.now()) } });
  await ok.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  assert.equal(ok.w.sessionStorage.getItem("hfy:auth-bounce"), null);

  const noStorage = load({ routes: fail, sessionStorageBlocked: true });
  await noStorage.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  assert.deepEqual(noStorage.w.location.replaced, [], "without storage the guard cannot work, so no automatic redirect");
});

test("a refresh that does not cure the 401 is not repeated, and the interactive load goes to sign-in once", async () => {
  const { w, counts } = load({ routes: { data: () => res(401) } });
  await w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  await w.HFYFeatureFlags.dataFetch("/person/I0002.json", {});
  assert.equal(counts.refresh, 1);
  assert.equal(w.location.replaced.length, 1);
});

test("a 401 from a request sent before a refresh finished is retried without a second refresh", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const { w, counts } = load({
    routes: {
      data: async (url) => {
        n += 1;
        if (url === "/slow.json" && n <= 2) { await gate; return res(401); }
        return res(n <= 2 ? 401 : 200);
      },
    },
  });
  const slow = w.HFYFeatureFlags.dataFetch("/slow.json", {});
  const fast = await w.HFYFeatureFlags.dataFetch("/fast.json", {});
  assert.equal(fast.status, 200);
  release();
  assert.equal((await slow).status, 200);
  assert.equal(counts.refresh, 1);
});

test("edgeSession: anonymous visitors are not refreshed; a lapsed member (marker) is refreshed once and asked again", async () => {
  const anon = load({ routes: { session: () => res(200, { authenticated: false }) } });
  assert.equal((await anon.w.HFYFeatureFlags.edgeSession()).authenticated, false);
  assert.equal(anon.counts.refresh, 0);

  const lapsed = load({
    local: { "hfy:edge-session": "1" },
    routes: { session: (n) => res(200, n === 1 ? { authenticated: false } : { authenticated: true, sub: "I0007", exp: NOW_S() + 3600 }) },
  });
  const s = await lapsed.w.HFYFeatureFlags.edgeSession();
  assert.equal(s.authenticated, true);
  assert.equal(s.sub, "I0007");
  assert.equal(lapsed.counts.refresh, 1);
  assert.equal(lapsed.counts.session, 2);
  // the data preflight reuses that result: no further session or refresh request
  await lapsed.w.HFYFeatureFlags.dataFetch("/person/I0001.json", {});
  assert.equal(lapsed.counts.refresh, 1);
  assert.equal(lapsed.counts.session, 2);

  const unreachable = load({ routes: { session: () => res(404) } });
  assert.equal(await unreachable.w.HFYFeatureFlags.edgeSession(), null);
  assert.equal(unreachable.counts.refresh, 0);
});

test("an authenticated edge session shows My Record (and any feature keyed on loggedIn), and the default state cannot re-hide them", async () => {
  const nodes = [node("navbarSearch"), node("myRecordLink"), node("familyLoginLink")];
  const { w } = load({ nodes });
  w.HFYFeatureFlags.refresh();
  assert.deepEqual(nodes.map((n) => n.visible), [false, false, true], "legacy signed-out before the edge session resolves");
  await w.HFYFeatureFlags.edgeSession();
  assert.deepEqual(nodes.map((n) => n.visible), [true, true, false]);
  assert.equal(w.localStorage.getItem("hfy:edge-session"), "1");
  // a state update that says "not signed in" (the page default) must not hide the edge-session navigation again
  w.HFYFeatureFlags.updateState({ loggedIn: false, userGrampsID: null, hasRecord: false });
  assert.deepEqual(nodes.map((n) => n.visible), [true, true, false]);
  assert.equal(w.HFYFeatureFlags.shouldShow("navbarSearch"), true);
  w.HFYFeatureFlags.forgetEdgeSession();
  assert.deepEqual(nodes.map((n) => n.visible), [false, false, true]);
  assert.equal(w.localStorage.getItem("hfy:edge-session"), null);
});

test("authV2 off: the edge overlay never applies, so visibility is the page default state alone", async () => {
  const nodes = [node("navbarSearch")];
  const { w, urls } = load({ flags: { authV2: false }, nodes });
  await w.HFYFeatureFlags.edgeSession();
  w.HFYFeatureFlags.refresh();
  assert.equal(nodes[0].visible, false);
  assert.ok(!urls().some((u) => u.startsWith("/auth/")));
});

test("auth-v2.js probes the session through the shared HFYFeatureFlags.edgeSession (one GET /auth/session per page)", async () => {
  const { w, counts } = load({ pathname: "/about/", search: "" });
  w.addEventListener = () => {};
  vm.runInNewContext(AUTH_V2_SRC, w);
  await w.HFYFeatureFlags.dataFetch("/person/index.json", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(counts.session, 1);
  assert.match(AUTH_V2_SRC, /f\.edgeSession\(\)/);
  assert.match(AUTH_V2_SRC, /forgetEdgeSession\(\)/);
});

// HFY-TSK-069 (D-11 item 6) + HFY-TSK-317: /family-login/ is a static redirect page. Its inline script sends /family-login/?next=<path>
// to /auth/login as returnTo (it used to be a hard-coded "/"), and a bare or unsafe next to returnTo=/.
const FAMILY_LOGIN_HTML = read("family-login/index.html");
const FAMILY_LOGIN_SCRIPT = FAMILY_LOGIN_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
function familyLogin(search) {
  const w = { URLSearchParams, encodeURIComponent, location: { search, replaced: [], replace(u) { this.replaced.push(u); } } };
  vm.runInNewContext(FAMILY_LOGIN_SCRIPT, w);
  return w.location.replaced;
}
const q = (next) => "?next=" + encodeURIComponent(next);

test("HFY-TSK-317: /family-login/ is a static page with a no-script refresh to /auth/login and no Google sign-in", () => {
  assert.match(FAMILY_LOGIN_HTML, /<noscript><meta http-equiv="refresh" content="0; url=\/auth\/login"><\/noscript>/);
  assert.match(FAMILY_LOGIN_HTML, /<a href="\/auth\/login">sign in<\/a>/);
  assert.doesNotMatch(FAMILY_LOGIN_HTML, /gsi\/client|auth\.js|check-allowed|feature-flags/);
});

test("D-11 item 6: /family-login/?next= carries a same-origin path (with query and hash) into returnTo", () => {
  for (const next of ["/person/?id=I0113", "/search/?query=Harrison&focus=1", "/person/?id=I0113#timeline", "/posts/?id=01JABC", "/me/notifications/"]) {
    assert.deepEqual(familyLogin(q(next)), [LOGIN(next)], next);
  }
});

test("D-11 item 6: the redirect carries URLSearchParams-encoded path+search+hash", () => {
  const path = "/person/?id=I0113&tab=a b#x";
  const target = new URL("/family-login/", "https://harrisonfamily.us");
  target.searchParams.set("next", path);
  assert.deepEqual(familyLogin(target.search), [LOGIN(path)]);
});

test("D-11 item 6: a missing, empty or unsafe next falls back to /", () => {
  const bad = [
    "", "person/", "//evil.example/x", "///evil.example", "https://evil.example/", "http://harrisonfamily.us/person/", "javascript:alert(1)",
    "/\\evil.example", "/ok\\path", "/a\tb", "/a\nb", "/a\rb", "/a\u0000b", "/a\u007fb", "\t/x", " /x", "/" + "a".repeat(2100),
    "/auth/login?returnTo=%2F", "/auth/link", "/family-login/", "/family-login/?next=%2Fperson%2F",
  ];
  for (const next of bad) assert.deepEqual(familyLogin(q(next)), [LOGIN("/")], JSON.stringify(next));
  assert.deepEqual(familyLogin(""), [LOGIN("/")], "no next at all");
  assert.deepEqual(familyLogin("?next=%E0%A4%A"), [LOGIN("/")], "malformed percent-encoding");
});
