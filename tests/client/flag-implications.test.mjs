// HFY-TSK-215: graduateV1 turns commentPhotosV1 and moderationV1 on in the loader, unless a preview override explicitly negates one.
// Run: node --test tests/client/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../11ty/js/feature-flags.js", import.meta.url), "utf8");

function resolve({ flags, search = "?id=I0001" }) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout,
    sessionStorage: store(), localStorage: store(),
    document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } }, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {} } }) },
    fetch: async () => ({ ok: true, json: async () => flags }),
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = { hostname: "localhost", pathname: "/person/", search, hash: "", href: `http://localhost/person/${search}`, replace() {} };
  vm.runInNewContext(SRC, sandbox);
  return sandbox.HFYFeatureFlags.resolveFlags();
}

test("graduateV1 on forces commentPhotosV1 and moderationV1 on", async () => {
  const f = await resolve({ flags: { graduateV1: true, commentPhotosV1: false, moderationV1: false } });
  assert.equal(f.commentPhotosV1, true);
  assert.equal(f.moderationV1, true);
});

test("graduateV1 off leaves both as the build says", async () => {
  const f = await resolve({ flags: { graduateV1: false, commentPhotosV1: false, moderationV1: true } });
  assert.equal(f.commentPhotosV1, false);
  assert.equal(f.moderationV1, true);
});

test("an explicit -commentPhotosV1 or -moderationV1 override is kept", async () => {
  const f = await resolve({ flags: { graduateV1: true }, search: "?id=I0001&hfy_flags=-commentPhotosV1,-moderationV1" });
  assert.equal(f.graduateV1, true);
  assert.equal(f.commentPhotosV1, false);
  assert.equal(f.moderationV1, false);
  const g = await resolve({ flags: {}, search: "?id=I0001&hfy_flags=graduateV1,-moderationV1" });
  assert.equal(g.commentPhotosV1, true);
  assert.equal(g.moderationV1, false);
});
