// HFY-TSK-388-0A pass 3: portraitV1 mounts the person-portrait island and mediaAddV1 the person-add-photo island, each on /person/?id=… only.
// Run: node --test tests/client/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../11ty/js/feature-flags.js", import.meta.url), "utf8");

async function islandsRequested({ flags, pathname, search = "" }) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const requested = [];
  const el = () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {} } });
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout,
    sessionStorage: store(), localStorage: store(),
    document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } },
      head: { appendChild(node) { const u = node && (node.href || node.src); if (u) requested.push(u); } }, createElement: el },
    fetch: async () => ({ ok: true, json: async () => flags }),
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = { hostname: "localhost", pathname, search, hash: "", href: `http://localhost${pathname}${search}`, replace() {} };
  vm.runInNewContext(SRC, sandbox);
  await sandbox.HFYFeatureFlags.resolveFlags();
  await new Promise((r) => setTimeout(r, 20));
  return new Set(requested.map((u) => (u.match(/\/js\/islands\/([a-z-]+)\.(?:js|css)/) || [])[1]).filter(Boolean));
}

test("portraitV1 on: the person page loads person-portrait and not person-add-photo", async () => {
  const n = await islandsRequested({ flags: { portraitV1: true }, pathname: "/person/", search: "?id=I0001" });
  assert.ok(n.has("person-portrait"));
  assert.ok(!n.has("person-add-photo"));
});

test("mediaAddV1 on: the person page loads person-add-photo and not person-portrait", async () => {
  const n = await islandsRequested({ flags: { mediaAddV1: true }, pathname: "/person/", search: "?id=I0001" });
  assert.ok(n.has("person-add-photo"));
  assert.ok(!n.has("person-portrait"));
});

test("both flags off: neither bundle is requested", async () => {
  const n = await islandsRequested({ flags: { portraitV1: false, mediaAddV1: false }, pathname: "/person/", search: "?id=I0001" });
  assert.ok(!n.has("person-portrait") && !n.has("person-add-photo"));
});

test("both flags on: not on the person page without an id, nor on the home page", async () => {
  for (const [pathname, search] of [["/person/", ""], ["/", ""], ["/me/dates/", ""]]) {
    const n = await islandsRequested({ flags: { portraitV1: true, mediaAddV1: true }, pathname, search });
    assert.ok(!n.has("person-portrait") && !n.has("person-add-photo"), `${pathname}${search}`);
  }
});
