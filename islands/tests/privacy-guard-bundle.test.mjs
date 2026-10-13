// privacy-guard-core AC4: shared/privacy-guard.mjs bundles with esbuild for the islands' browser target (build.mjs TARGET:
// es2020 / safari15, so no lookbehind) and runs from the bundle, as an island that imports it will. The offset-exact vector
// suite is shared/privacy-guard.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const TARGET = ["es2020", "safari15"];
const vectors = JSON.parse(readFileSync(join(repo, "shared", "privacy-guard.vectors.json"), "utf8"));
const plain = (marked) => marked.replace(/⟦[^|]*\|/g, "").replace(/⟧/g, "");
const markedKinds = (marked) => [...marked.matchAll(/⟦([a-z_]+)\//g)].map((m) => m[1]).sort();

test("the islands build targets what this test bundles for", () => {
  assert.match(readFileSync(join(islandsDir, "build.mjs"), "utf8"), /const TARGET = \["es2020", "safari15"\];/);
});

test("shared/privacy-guard.mjs bundles for the browser target and runs from the bundle", async () => {
  const out = await build({
    stdin: { contents: 'export * from "../shared/privacy-guard.mjs";', resolveDir: islandsDir, loader: "js" },
    bundle: true, format: "esm", platform: "browser", target: TARGET, minify: true, write: false, logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /\(\?<[=!]/, "a lookbehind would not run in safari15");
  assert.doesNotMatch(code, /\brequire\(|from ?"node:/);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  for (const c of vectors.cases) assert.deepEqual(mod.scanText(plain(c.text)).map((h) => h.kind).sort(), markedKinds(c.text), c.id);
  assert.equal(mod.rejectContactInfo("her birthday is May 5th").code, "dob_not_allowed");
  assert.ok(mod.BIRTHDAY_KEYWORDS.has("bday"));
});
