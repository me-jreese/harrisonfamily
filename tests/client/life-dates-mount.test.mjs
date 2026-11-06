// HFY-TSK-388-0D: lifeDatesV1 mounts the person-page Life dates island (life-dates) and the /me/dates/ queue island (life-dates-queue), each on its own page only.
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
  // The mounts are .then callbacks on resolveFlags(); let them run. The stylesheet link is appended first, so its URL names the island.
  await new Promise((r) => setTimeout(r, 20));
  return requested.map((u) => (u.match(/\/js\/islands\/([a-z-]+)\.(?:js|css)/) || [])[1]).filter(Boolean);
}

const requestedNames = async (opts) => new Set(await islandsRequested(opts));

test("lifeDatesV1 on: the person page loads life-dates, not the queue", async () => {
  const n = await requestedNames({ flags: { lifeDatesV1: true }, pathname: "/person/", search: "?id=I0001" });
  assert.ok(n.has("life-dates"));
  assert.ok(!n.has("life-dates-queue"));
});

test("lifeDatesV1 off: the person page loads neither", async () => {
  const n = await requestedNames({ flags: { lifeDatesV1: false }, pathname: "/person/", search: "?id=I0001" });
  assert.ok(!n.has("life-dates") && !n.has("life-dates-queue"));
});

test("lifeDatesV1 on: the person page without an id loads nothing", async () => {
  const n = await requestedNames({ flags: { lifeDatesV1: true }, pathname: "/person/" });
  assert.ok(!n.has("life-dates"));
});

test("lifeDatesV1 on: /me/dates/ loads the queue, not life-dates", async () => {
  const n = await requestedNames({ flags: { lifeDatesV1: true }, pathname: "/me/dates/" });
  assert.ok(n.has("life-dates-queue"));
  assert.ok(!n.has("life-dates"));
});

test("lifeDatesV1 on: the home page loads neither", async () => {
  const n = await requestedNames({ flags: { lifeDatesV1: true }, pathname: "/" });
  assert.ok(!n.has("life-dates") && !n.has("life-dates-queue"));
});
