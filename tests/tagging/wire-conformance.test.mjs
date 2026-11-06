// Tagging conformance, the HFY adapter's wire half (HFY-TSK-388-0G, plan HFY-PLN-004 pass 1). The same fixtures as tag-conformance.test.mjs, run against
// islands/src/lib/hfy-tag-wire.js: the pure rules the new tag adapter writes with. The shipped editor (photo-tag-edit.js, photo-tags.js) is unchanged until pass 2, so its
// known-fail rows stay in tag-conformance.test.mjs; here every row must PASS. CodeArtifact-free like its sibling: node:test and repository code only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { revive } from "./reference-rect.mjs";
import * as wire from "../../islands/src/lib/hfy-tag-wire.js";
import { applyOps } from "../../api/src/records/ops.js";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tag-conformance.fixtures.json"), "utf8"));
const MEDIA = FX.deskTwin.mediaRef.ref;
const person = (n, media = []) => ({ _class: "Person", handle: `hp000${n}`, gramps_id: `I900${n}`, private: false, gender: 2, media_list: media, event_ref_list: [], family_list: [], parent_family_list: [] });
const bundleOf = (p) => ({ key: `Person:${p.handle}`, version: 1, obj: p });
const addOp = (rect) => ({ op: "add", personId: "I9001", mediaId: "O9001", rect, baseVersion: "v" });

for (const r of FX.normalizeRect.rows) test(`W/${r.t}/read/${r.id}`, () => assert.deepStrictEqual(wire.normalizeRect(revive(r.in)), r.out));
for (const r of FX.normalizeRect.throwsRectInvalid) test(`W/T-4/read-invalid/${r.id}`, () => assert.throws(() => wire.normalizeRect(revive(r.in)), { code: "RECT_INVALID" }));
for (const r of FX.emit.rows) test(`W/${r.t}/write/${r.id}`, () => assert.deepStrictEqual(wire.emitRect(r.drawn), r.emit));

for (const r of FX.authoring.rows) {
  test(`W/${r.t}/author/${r.id}`, () => {
    const planned = wire.planTagOp(bundleOf(person(1)), MEDIA, addOp(r.rect));
    assert.equal(planned.ok, r.ok, `ok for ${JSON.stringify(r.rect)}`);
    if (r.ok) assert.deepStrictEqual(planned.ops[0].value.rect, r.rect_out);
    assert.equal(wire.validateNewRect(r.rect).ok, r.ok);
  });
}

test("W/T-1/web-equals-desk-twin", () => {
  const planned = wire.planTagOp(bundleOf(person(1)), MEDIA, addOp(FX.deskTwin.mediaRef.rect));
  assert.equal(JSON.stringify(planned.ops[0].value), JSON.stringify(FX.deskTwin.mediaRef));
});

test("W/T-5/a-tag-smaller-than-2x2-is-refused", () => {
  assert.equal(wire.MIN_TAG_UNITS, FX.minTagUnits);
  assert.equal(wire.planTagOp(bundleOf(person(1)), MEDIA, addOp([10, 10, 11, 11])).reason, "invalid");
  assert.equal(wire.planTagOp(bundleOf(person(1)), MEDIA, addOp([10, 10, 12, 12])).ok, true);
});

test("W/T-6/removing-the-second-of-two-identical-regions-keeps-the-first", () => {
  const p = person(1, [wire.newMediaRef(MEDIA, [10, 10, 20, 20]), wire.newMediaRef("OTHER", [1, 1, 9, 9]), wire.newMediaRef(MEDIA, [10, 10, 20, 20])]);
  const planned = wire.planTagOp(bundleOf(p), MEDIA, { op: "remove", personId: "I9001", mediaId: "O9001", index: 2, rect: [10, 10, 20, 20], baseVersion: "v" });
  assert.equal(planned.ok, true);
  const out = applyOps({ [`Person:${p.handle}`]: p }, planned.ops);
  assert.equal(out.ok, true);
  assert.deepStrictEqual(out.objects[`Person:${p.handle}`].media_list.map((m) => m.ref), [MEDIA, "OTHER"]);
});

test("W/T-9/add-appends-at-the-end-and-a-new-tag-lands-at-index-2", () => {
  const p = person(1, [wire.newMediaRef(MEDIA, [10, 10, 20, 20]), wire.newMediaRef("OTHER", [1, 1, 9, 9])]);
  const planned = wire.planTagOp(bundleOf(p), MEDIA, addOp([10, 10, 21, 20]));
  assert.equal(planned.ok, true);
  assert.equal(planned.index, 2);
  const out = applyOps({ [`Person:${p.handle}`]: p }, planned.ops);
  assert.deepStrictEqual(out.objects[`Person:${p.handle}`].media_list.map((m) => m.rect), [[10, 10, 20, 20], [1, 1, 9, 9], [10, 10, 21, 20]]);
});

// KNOWN FAIL (BASELINE row T-9, add-identical-appends): the plan refuses to pretend. A byte-identical MediaRef cannot be appended because the ops engine's `add` is idempotent
// (api/src/records/ops.js, "an identical element is present"). This test asserts that is still so; when the API can append it, change both and the baseline.
test("W/T-9/add-identical-appends [known-fail]", () => {
  const p = person(1, [wire.newMediaRef(MEDIA, [10, 10, 20, 20])]);
  const planned = wire.planTagOp(bundleOf(p), MEDIA, addOp([10, 10, 20, 20]));
  assert.deepStrictEqual([planned.ok, planned.reason, planned.index], [false, "identical", 0]);
  const forced = applyOps({ [`Person:${p.handle}`]: p }, [{ id: "tag.add", op: "add", obj: `Person:${p.handle}`, path: "/media_list", value: wire.newMediaRef(MEDIA, [10, 10, 20, 20]) }]);
  assert.equal(forced.objects[`Person:${p.handle}`].media_list.length, 1, "the engine wrote nothing");
});

test("W/T-11/a-stale-address-is-stale-and-an-existing-private-value-is-kept", () => {
  const ref = { ...wire.newMediaRef(MEDIA, [10, 10, 20, 20]), private: true };
  const p = person(1, [ref]);
  assert.equal(wire.planTagOp(bundleOf(p), MEDIA, { op: "move", personId: "I9001", mediaId: "O9001", index: 0, from: [11, 10, 20, 20], to: [12, 12, 22, 22], baseVersion: "v" }).reason, "stale");
  assert.equal(wire.planTagOp(bundleOf(p), MEDIA, { op: "move", personId: "I9001", mediaId: "O9001", index: 3, from: [10, 10, 20, 20], to: [12, 12, 22, 22], baseVersion: "v" }).reason, "stale");
  const moved = wire.planTagOp(bundleOf(p), MEDIA, { op: "move", personId: "I9001", mediaId: "O9001", index: 0, from: [10, 10, 20, 20], to: [12, 12, 22, 22], baseVersion: "v" });
  const out = applyOps({ [`Person:${p.handle}`]: p }, moved.ops);
  assert.deepStrictEqual(out.objects[`Person:${p.handle}`].media_list[0], { ...ref, rect: [12, 12, 22, 22] }, "D-06: private is preserved on edit");
});
