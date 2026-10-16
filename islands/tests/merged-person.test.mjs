// merge-alias-redirect: lib/merged-person.js (the islands' mergedInto rule), the personV2 island and the /tree/ page use it. Synthetic ids only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_MERGE_HOPS, mergedRedirect, mergedTarget, resolveMerged } from "../src/lib/merged-person.js";

const stubs = (map) => async (url) => {
  const id = decodeURIComponent(url.split("/").pop().replace(/\.json$/, ""));
  return id in map ? new Response(JSON.stringify(map[id]), { status: 200 }) : new Response("", { status: 404 });
};

test("mergedTarget: only a well-formed id that is not the page's own", () => {
  assert.equal(mergedTarget({ mergedInto: "I9003" }, "I9001"), "I9003");
  assert.equal(mergedTarget({ mergedInto: "I9001" }, "I9001"), null);
  for (const bad of ["../x", "", "a b", "x".repeat(33), 7, null, undefined]) assert.equal(mergedTarget({ mergedInto: bad }, "I9001"), null);
  assert.equal(mergedTarget(null, "I9001"), null);
  assert.equal(mergedTarget({ name: "Ada" }, "I9001"), null);
});

test("mergedRedirect: keeps other parameters and the hash, counts hops, stops at the limit", () => {
  const r = mergedRedirect("https://example.test/person/?id=I9001&x=1#notes", { mergedInto: "I9003" }, "I9001");
  assert.equal(r.url, "https://example.test/person/?id=I9003&x=1&merged=1#notes");
  assert.equal(mergedRedirect("https://example.test/person/?id=I9001", { name: "Ada" }, "I9001"), null);
  assert.deepEqual(mergedRedirect(`https://example.test/person/?id=I9001&merged=${MAX_MERGE_HOPS}`, { mergedInto: "I9003" }, "I9001"), { limit: true });
});

test("resolveMerged: follows a stub, a chain up to the hop limit, and answers null for a live page, a 404 or a failure", async () => {
  assert.equal(await resolveMerged(stubs({ I9100: { mergedInto: "I9003" } }), "I9100"), "I9003");
  assert.equal(await resolveMerged(stubs({ I9100: { mergedInto: "I9101" }, I9101: { mergedInto: "I9003" }, I9003: { name: "Ada" } }), "I9100"), "I9003");
  assert.equal(await resolveMerged(stubs({ I9100: { mergedInto: "I9101" }, I9101: { mergedInto: "I9102" }, I9102: { mergedInto: "I9103" } }), "I9100"), "I9102", "at most MAX_MERGE_HOPS stubs");
  assert.equal(await resolveMerged(stubs({ I9100: { mergedInto: "I9100" } }), "I9100"), null);
  assert.equal(await resolveMerged(stubs({ I9003: { name: "Ada" } }), "I9003"), null);
  assert.equal(await resolveMerged(stubs({}), "I9999"), null);
  assert.equal(await resolveMerged(async () => { throw new TypeError("offline"); }, "I9100"), null);
  assert.equal(await resolveMerged(async () => new Response("<html>", { status: 200 }), "I9100"), null);
});

test("resolveMerged: asks for the encoded id on the gated same-origin person JSON", async () => {
  let seen;
  await resolveMerged(async (url, init) => { seen = { url, init }; return new Response("{}", { status: 200 }); }, "I9 1");
  assert.equal(seen.url, "/person/I9%201.json");
  assert.equal(seen.init.credentials, "same-origin");
});

test("the person-page.js hook is untouched and the island rule matches its hop limit and id pattern", () => {
  const legacy = readFileSync(new URL("../../11ty/js/person-page.js", import.meta.url), "utf8");
  assert.match(legacy, /MAX_MERGE_HOPS = 2/);
  assert.ok(legacy.includes("/^[A-Za-z0-9_-]{1,32}$/"));
  assert.equal(MAX_MERGE_HOPS, 2);
});

test("the personV2 island and the tree page follow an alias through lib/merged-person.js", () => {
  const person = readFileSync(new URL("../src/islands/person.jsx", import.meta.url), "utf8");
  const tree = readFileSync(new URL("../src/islands/tree.jsx", import.meta.url), "utf8");
  assert.match(person, /mergedRedirect/);
  assert.match(tree, /resolveMerged/);
});
