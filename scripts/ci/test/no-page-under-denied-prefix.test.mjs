// P4-R33 regression: no page the repository ships may live under a first path segment that HFYAppendIndex answers 404 to
// (DENY_FIRST_SEGMENTS in scripts/cloudfront/append-index.js), and none may be gated by a data-gate pattern. The media browser lives at /all-media/ because /media/ is private data.
// Run: node --test scripts/ci/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../../../", import.meta.url).pathname;
const fn = readFileSync(`${ROOT}scripts/cloudfront/append-index.js`, "utf8");
const m = fn.match(/var DENY_FIRST_SEGMENTS\s*=\s*\[([^\]]*)\]/);
const denied = m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1].toLowerCase()) : [];

test("DENY_FIRST_SEGMENTS is parsed from append-index.js and holds the private data prefixes", () => {
  for (const seg of ["family", "event", "note", "place", "media", "uploads"]) assert.ok(denied.includes(seg), seg);
  assert.ok(!denied.includes("all-media"), "all-media is the public media browser page (P4-R33) and must stay out of the deny list");
});

test("no tracked HTML page sits under a denied first segment", () => {
  const files = execFileSync("git", ["ls-files", "11ty"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const pages = files.map((f) => f.slice("11ty/".length)).filter((f) => /\.html?$/.test(f));
  assert.ok(pages.length > 5, "found the shipped pages");
  assert.ok(pages.includes("all-media/index.html"), "the media browser page ships at /all-media/");
  const bad = pages.filter((f) => denied.includes(f.split("/")[0].toLowerCase()));
  assert.deepEqual(bad, [], "pages under a private data prefix would be answered 404 by HFYAppendIndex and gated at the edge");
});

test("the page list of the islands build stays out of the denied segments", () => {
  const heads = readFileSync(`${ROOT}islands/heads.mjs`, "utf8");
  for (const f of heads.matchAll(/"([a-z0-9-]+(?:\/[^"]*)?\.html)"/g)) assert.ok(!denied.includes(f[1].split("/")[0].toLowerCase()), f[1]);
});
