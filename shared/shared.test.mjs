// shared/ contract (HFY-PLN-002 D2-10): every shared/*.mjs is pure ESM that runs in the browser and in a Cloudflare Worker as
// well as in Lambda, so it may import only relative shared files: no bare specifier, no node: builtin, no aws module.
// NOTE: shared/package.json must keep "main" pointing at this file: that is what makes the bare `node --test shared/` run it.
// Also runnable explicitly: `node --test shared/shared.test.mjs`. Not CI-gated yet (the ci.manifest.yaml tests do not run it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedText, cleanText, isRecord } from "./validate.mjs";
import "./privacy-guard.test.mjs"; // `node --test shared/` runs only this file (package.json main), so per-module suites hang off it
import "./profile-links.test.mjs";
import "./legacy-form.test.mjs";
import "./canonical.test.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const modules = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

// Every import / export-from / dynamic import / require specifier in the source.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
export const specifiers = (rawSrc) => {
  const src = stripComments(rawSrc);
  const out = [];
  // A dynamic import()/require() whose argument is not a string literal cannot be checked, so it is itself a violation.
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*(?!["'`])/g)) out.push(`<non-literal ${m[0].trim()}>`);
  const re = /(?:\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;
  for (const m of src.matchAll(re)) out.push(m[2]);
  return out;
};

test("the checker sees bare, node: and aws specifiers", () => {
  assert.deepEqual(specifiers('import a from "lodash";\nimport { b } from "node:fs";\nexport * from "./x.mjs";\nawait import("@aws-sdk/client-s3");\nimport "side";'),
    ["lodash", "node:fs", "./x.mjs", "@aws-sdk/client-s3", "side"]);
});

test("comments are ignored and a computed specifier is flagged", () => {
  assert.deepEqual(specifiers('// import("x")\n/* require("y") */\nimport a from "./a.mjs";'), ["./a.mjs"]);
  assert.equal(specifiers("await import(name)").length, 1);
  assert.deepEqual(specifiers('import b from "./laws.mjs";'), ["./laws.mjs"]);
});

test("shared/ holds at least one module", () => assert.ok(modules.length > 0));

for (const f of modules) {
  test(`${f}: relative imports only (no bare, node: or aws specifier), so it runs in the browser and a Worker`, () => {
    for (const s of specifiers(readFileSync(join(dir, f), "utf8"))) {
      assert.match(s, /^\.\.?\//, `${f} imports "${s}": only relative imports are allowed in shared/`);
    }
  });
}

test("api/src/shared and auth/src/shared are committed relative symlinks to ../../shared", () => {
  for (const p of ["api/src/shared", "auth/src/shared"]) {
    const full = join(dir, "..", p);
    assert.ok(lstatSync(full).isSymbolicLink(), `${p} is not a symlink`);
    assert.equal(readlinkSync(full), "../../shared");
  }
});

test("validate.mjs", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(cleanText("  a b "), "a b");
  assert.equal(cleanText(5), "");
  assert.deepEqual(boundedText(" ab ", { min: 2, max: 3 }), { ok: true, value: "ab" });
  assert.deepEqual(boundedText("a", { min: 2 }), { ok: false, reason: "too-short" });
  assert.deepEqual(boundedText("abcd", { max: 3 }), { ok: false, reason: "too-long" });
});
