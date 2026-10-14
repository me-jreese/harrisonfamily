// edit-guard-wiring AC4: islands/src/lib/edit-guard.js bundles the same detector as the API adapter for the islands' browser target
// (es2020 / safari15, no lookbehind) and, run from the bundle, gives the same findings as the server on the shared corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expected, leaksText, runCase } from "../../shared/edit-guard-corpus.mjs";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(islandsDir, "..", "shared", "edit-guard.cases.json"), "utf8"));
const out = await build({
  entryPoints: [join(islandsDir, "src", "lib", "edit-guard.js")],
  bundle: true, format: "esm", platform: "browser", target: ["es2020", "safari15"], minify: true, write: false, logLevel: "silent",
});
const code = out.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("the bundle has no lookbehind, no node: import and no require", () => {
  assert.doesNotMatch(code, /\(\?<[=!]/);
  assert.doesNotMatch(code, /\brequire\(|from ?"node:/);
});

for (const c of corpus.cases) {
  test(`bundled edit guard on the shared corpus: ${c.id}`, () => {
    const found = runCase(({ dob }) => mod.createEditGuard({ dob }), c);
    assert.deepEqual(found, expected(c));
    assert.equal(leaksText(found, corpus), false);
  });
}

test("the default guard refuses contact info and the copy is the DS voice", () => {
  assert.equal(mod.editGuard.checkValue(corpus.phone, "n").length, 1);
  assert.match(mod.EDIT_GUARD_COPY.contact_info, /phone number or street address/);
  assert.equal(mod.CODES.never, "never_in_cloud");
});
