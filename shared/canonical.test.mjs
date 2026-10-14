// Canonical JSON (shared/canonical.mjs) against the vectors it shares with gramps/hfygramps/canonical.py.
// Run with the rest of shared/ (`node --test shared/`, through shared.test.mjs) or alone: `node --test shared/canonical.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CanonicalError, canonicalBytes, canonicalJson, canonicalSha256, compareCodePoints, objectHash, objectJson, storedForm,
} from "./canonical.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(dir, "canonical.vectors.json"), "utf8"));

test("the vector file names its format and holds enough vectors", () => {
  assert.equal(doc.format, "canonical-json-v1");
  assert.ok(doc.vectors.length >= 30);
  assert.equal(new Set(doc.vectors.map((v) => v.id)).size, doc.vectors.length);
});

for (const v of doc.vectors) {
  test(`vector ${v.id}: canonical text, UTF-8 bytes and sha256`, async () => {
    const text = v.stored ? objectJson(v.value) : canonicalJson(v.value);
    assert.equal(text, v.canonical);
    assert.deepEqual(Array.from(new TextEncoder().encode(text)), Array.from(canonicalBytes(v.stored ? storedForm(v.value) : v.value)));
    const hash = v.stored ? await objectHash(v.value) : await canonicalSha256(v.value);
    assert.equal(hash, v.sha256);
  });
}

test("keys sort by code point, not by UTF-16 code unit", () => {
  assert.ok(compareCodePoints("\u{1F600}", "￿") > 0);
  assert.ok("\u{1F600}" < "￿", "the default string order would put it first");
  assert.equal(compareCodePoints("a", "a"), 0);
  assert.ok(compareCodePoints("a", "ab") < 0);
  assert.ok(compareCodePoints("ab", "a") > 0);
});

test("a float, NaN, infinity, an unsafe integer, undefined and a lone surrogate are refused", () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), undefined, () => 1, Symbol("x"), 10n, new Date(0), new Map(),
    "\ud800", "a\udc00b", { "\ud800": 1 }, [1, 1.5], { a: { b: [undefined] } }]) {
    assert.throws(() => canonicalJson(bad), CanonicalError, String(typeof bad));
  }
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson("😀"), '"\u{1F600}"');
});

test("an object without a prototype is accepted, a class instance is not", () => {
  const plain = Object.create(null);
  plain.b = 1;
  plain.a = 2;
  assert.equal(canonicalJson(plain), '{"a":2,"b":1}');
  assert.throws(() => canonicalJson(new (class X {})()), CanonicalError);
});

test("nesting deeper than the limit is refused rather than overflowing the stack", () => {
  let v = [];
  for (let i = 0; i < 300; i++) v = [v];
  assert.throws(() => canonicalJson(v), CanonicalError);
});
