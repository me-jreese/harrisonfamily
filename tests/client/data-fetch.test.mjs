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

test("authV2 off: dataFetchInit is null, so every caller sends a plain same-origin request", async () => {
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

test("consumers send the cookie only (no X-HFY-Session) and fetch data through dataFetch", () => {
  const person = read("js/person-page.js");
  assert.match(person, /const response = await dataFetch\(dataUrl, \{ credentials: "same-origin" \}\);/);
  assert.match(person, /dataFetch\(svgUrl, \{ credentials: "same-origin" \}, \{ interactive: false \}\)/);
  assert.doesNotMatch(person, /X-HFY-Session|requireSessionToken|HFY_AUTH\b/);
  assert.doesNotMatch(read("js/feature-flags.js"), /requireSessionToken|verifySession|acceptSession|\/api\/check-allowed/);
  for (const f of ["../islands/src/islands/person.jsx", "../islands/src/islands/photo-tags.js", "../islands/src/lib/people-corpus.js"]) {
    const s = read(f);
    assert.match(s, /dataFetch\(url, init|getJson|flags\.dataFetch/, f);
    assert.doesNotMatch(s, /dataResponse|X-HFY-Session|requireSessionToken/, f);
  }
});
