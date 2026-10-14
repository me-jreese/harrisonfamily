// shared/edit-guard.mjs against the shared corpus (task edit-guard-wiring). The same corpus runs in api/test/records/guard.node-test.js
// (through the adapter) and islands/tests/edit-guard.test.mjs (through the bundle), so the three sides cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEditGuard } from "./edit-guard.mjs";
import { expected, leaksText, runCase } from "./edit-guard-corpus.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(dir, "edit-guard.cases.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(dir, "..", "gramps", "redaction", "redaction-v1.json"), "utf8"));
const make = ({ dob }) => createEditGuard({ policy, dob });

for (const c of corpus.cases) {
  test(`edit-guard corpus: ${c.id}`, () => {
    const found = runCase(make, c);
    assert.deepEqual(found, expected(c));
    assert.equal(leaksText(found, corpus), false);
  });
}

test("every finding is {opId, obj, path, pointer, code, kind, span} with a pointer of /obj+path", () => {
  const c = corpus.cases.find((x) => x.id === "text-note");
  const [f] = make({ dob: false }).checkObjects(c.objects);
  assert.deepEqual(Object.keys(f).sort(), ["code", "kind", "obj", "opId", "path", "pointer", "span"]);
  assert.equal(f.pointer, "/Note:n1/text/string");
});
