// HFY-TSK-388-0C: mediaBrowserV1 mounts the media-carousel island on the static /posts/ list page only.
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


test("mediaBrowserV1 on: /posts/ loads media-carousel (and the all-media page does not)", async () => {
  for (const pathname of ["/posts/", "/posts", "/posts/index.html"]) assert.ok((await islandsRequested({ flags: { mediaBrowserV1: true }, pathname })).has("media-carousel"), pathname);
  assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: true }, pathname: "/all-media/" })).has("media-carousel"));
});

test("mediaBrowserV1 off or absent: /posts/ loads nothing", async () => {
  assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: false }, pathname: "/posts/" })).has("media-carousel"));
  assert.ok(!(await islandsRequested({ flags: {}, pathname: "/posts/" })).has("media-carousel"));
});

test("mediaBrowserV1 on: one post, other pages and deeper paths load nothing", async () => {
  assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: true }, pathname: "/posts/", search: "?id=01JZZZ" })).has("media-carousel"));
  for (const pathname of ["/", "/person/", "/me/posts/", "/posts/other/", "/media/"]) {
    assert.ok(!(await islandsRequested({ flags: { mediaBrowserV1: true }, pathname })).has("media-carousel"), pathname);
  }
});
