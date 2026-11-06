// HFY-TSK-388-0B: mediaBrowserV1 mounts the media-browser island on the static /all-media/ page only.
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

test("mediaBrowserV1 on: /all-media/ loads media-browser, with or without an id in the address", async () => {
  assert.ok((await islandsRequested({ flags: { mediaBrowserV1: true }, pathname: "/all-media/" })).has("media-browser"));
  assert.ok((await islandsRequested({ flags: { mediaBrowserV1: true }, pathname: "/all-media/", search: "?id=M0001" })).has("media-browser"));
  assert.ok((await islandsRequested({ flags: { mediaBrowserV1: true }, pathname: "/all-media/index.html" })).has("media-browser"));
});

test("mediaBrowserV1 off or absent: /all-media/ loads nothing", async () => {
  assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: false }, pathname: "/all-media/" })).has("media-browser"));
  assert.ok(!(await islandsRequested({ flags: {}, pathname: "/all-media/" })).has("media-browser"));
});

test("mediaBrowserV1 on: other paths load nothing (a wrong path, the posts page, a deeper path)", async () => {
  for (const pathname of ["/", "/posts/", "/person/", "/me/dates/", "/media/", "/media/index.html", "/all-media/other/", "/medias/"]) {
    assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: true }, pathname, search: "?id=M0001" })).has("media-browser"), pathname);
  }
});
