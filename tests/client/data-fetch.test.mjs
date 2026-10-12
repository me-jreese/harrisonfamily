// HFY-TSK-080: the authV2 data-fetch path. Run: node --test tests/client/*.test.mjs
// Loads the real 11ty/js/feature-flags.js into a vm sandbox with a stubbed browser, then checks the consumers' source contract.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../11ty/${p}`, import.meta.url), "utf8");
const FLAGS_SRC = read("js/feature-flags.js");

function load({ flags = {}, search = "?id=I0001" } = {}) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout,
    sessionStorage: store(), localStorage: store(),
    document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } }, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {} } }) },
    fetch: async () => ({ ok: true, json: async () => flags }),
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = {
    hostname: "localhost", pathname: "/person/", search, hash: "", href: `http://localhost/person/${search}`, replaced: null,
    replace(u) { this.replaced = u; },
  };
  vm.runInNewContext(FLAGS_SRC, sandbox);
  return sandbox;
}

test("authV2 off: dataFetchInit is null, so every caller keeps its legacy X-HFY-Session request", async () => {
  const w = load({ flags: { authV2: false } });
  assert.equal(await w.HFYFeatureFlags.dataFetchInit(), null);
});

test("authV2 on: data fetches use same-origin credentials and no X-HFY-Session header", async () => {
  const w = load({ flags: { authV2: true } });
  const init = await w.HFYFeatureFlags.dataFetchInit();
  assert.deepEqual({ ...init }, { credentials: "same-origin" });
  assert.equal(init.headers, undefined);
});

test("the ?hfy_flags=authV2 preview override turns it on for this tab", async () => {
  const w = load({ flags: { authV2: false }, search: "?id=I0001&hfy_flags=authV2" });
  assert.deepEqual({ ...(await w.HFYFeatureFlags.dataFetchInit()) }, { credentials: "same-origin" });
});

test("a gate 401 under authV2 sends the visitor to the edge sign-in and back; otherwise nothing happens", async () => {
  const on = load({ flags: { authV2: true } });
  await on.HFYFeatureFlags.dataFetchInit();
  on.HFYFeatureFlags.dataResponse({ status: 200, ok: true });
  assert.equal(on.window.location.replaced, null);
  on.HFYFeatureFlags.dataResponse({ status: 401, ok: false });
  assert.equal(on.window.location.replaced, "/auth/login?returnTo=" + encodeURIComponent("/person/?id=I0001"));
  const off = load({ flags: { authV2: false } });
  await off.HFYFeatureFlags.dataFetchInit();
  off.HFYFeatureFlags.dataResponse({ status: 401, ok: false });
  assert.equal(off.window.location.replaced, null);
});

test("consumers take the authV2 path before building any X-HFY-Session request", () => {
  const person = read("js/person-page.js");
  const build = person.slice(person.indexOf("async function buildAuthorizedFetchOptions"));
  assert.ok(build.indexOf("edgeSessionInit()") > -1 && build.indexOf("edgeSessionInit()") < build.indexOf("X-HFY-Session"));
  assert.match(person, /async function requireAuthenticated\(\) \{\s*if \(await edgeSessionInit\(\)\)/);
  for (const f of ["js/search-results.js", "js/search-navbar.js"]) {
    const s = read(f);
    assert.match(s, /async function requireAuthenticated\(\) \{\s*if \(await edgeSessionInit\(\)\)/, f);
    assert.match(s, /const headers = edgeInit \? \{\} : await buildAuthHeaders\(\);/, f);
    assert.match(s, /dataResponse\(res\)/, f);
  }
});
