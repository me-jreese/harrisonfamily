// "Your family": HFYFeatureFlags.familyUrl / goToFamily (11ty/js/feature-flags.js), the rule behind the shell's family tab, /private/ and
// /person/ without an id. Run: node --test tests/client/*.test.mjs. Loads the real feature-flags.js into a vm sandbox with a stubbed browser.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../11ty/${p}`, import.meta.url), "utf8");
const FLAGS_SRC = read("js/feature-flags.js");

// session: object (200 JSON) | null (unreachable). Edge session probes are GET /auth/session; refreshes are POST /auth/refresh.
function load({ flags = { authV2: true }, session = { authenticated: false }, local = {} } = {}) {
  const store = (seed = {}) => { const m = new Map(Object.entries(seed)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const calls = [];
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout,
    sessionStorage: store(), localStorage: store(local),
    document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } }, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {} } }) },
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/auth/session")) return session ? { ok: true, json: async () => session } : { ok: false, status: 503, json: async () => ({}) };
      if (String(url).startsWith("/auth/refresh")) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => flags };
    },
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = {
    hostname: "localhost", pathname: "/private/", search: "", hash: "", href: "http://localhost/private/", replaced: null,
    replace(u) { this.replaced = u; },
  };
  vm.runInNewContext(FLAGS_SRC, sandbox);
  sandbox.calls = calls;
  return sandbox;
}

test("signed in (authV2): the own page, /person/?id=<sub>", async () => {
  const w = load({ session: { authenticated: true, sub: "I0042", label: "Marie" } });
  assert.equal(await w.HFYFeatureFlags.familyUrl(), "/person/?id=I0042");
});

test("the sub is encoded into the URL", async () => {
  const w = load({ session: { authenticated: true, sub: "I 4&2" } });
  assert.equal(await w.HFYFeatureFlags.familyUrl(), "/person/?id=I%204%262");
});

test("signed out (authV2): the edge sign-in, returning to /private/ (the family route, not the gated /family/)", async () => {
  const w = load({ session: { authenticated: false } });
  assert.equal(w.HFYFeatureFlags.familyRoute, "/private/");
  assert.equal(await w.HFYFeatureFlags.familyUrl(), "/auth/login?returnTo=%2Fprivate%2F");
});

test("an authenticated session without a gramps id decides nothing (no redirect, so no loop)", async () => {
  const w = load({ session: { authenticated: true, label: "Marie" } });
  assert.equal(await w.HFYFeatureFlags.familyUrl(), null);
  assert.equal(await w.HFYFeatureFlags.goToFamily(), null);
  assert.equal(w.location.replaced, null);
});

test("authV2 off: the edge sign-in with a return to /private/; an id the retired Google sign-in left is never used", async () => {
  const off = { flags: { authV2: false }, session: null };
  assert.equal(await load(off).HFYFeatureFlags.familyUrl(), "/auth/login?returnTo=%2Fprivate%2F");
  assert.equal(await load({ ...off, local: { HFY_AUTH_USER_GRAMPS_ID: "I0007" } }).HFYFeatureFlags.familyUrl(), "/auth/login?returnTo=%2Fprivate%2F");
});

test("/auth/session unreachable under authV2: the edge sign-in, as the shell's own sign-in link goes", async () => {
  const w = load({ session: null });
  assert.equal(await w.HFYFeatureFlags.familyUrl(), "/auth/login?returnTo=%2Fprivate%2F");
});

test("goToFamily replaces the history entry with the resolved URL and resolves it", async () => {
  const w = load({ session: { authenticated: true, sub: "I0042" } });
  assert.equal(await w.HFYFeatureFlags.goToFamily(), "/person/?id=I0042");
  assert.equal(w.location.replaced, "/person/?id=I0042");
  const out = load({ session: { authenticated: false } });
  await out.HFYFeatureFlags.goToFamily();
  assert.equal(out.location.replaced, "/auth/login?returnTo=%2Fprivate%2F");
});

test("the pages use it: /private/ and /person/ without an id both call goToFamily", () => {
  assert.match(read("private/index.html"), /flags\.goToFamily\(\)/);
  const person = read("js/person-page.js");
  assert.match(person, /if \(!personId\) \{[\s\S]*?featureFlags\.goToFamily\(\)/);
});
