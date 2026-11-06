// Tagging conformance suite, HFY side (HFY-TSK-387-0A, plan HFY-PLN-004): BRD conformance rows T-1..T-12, P-1 and V-1, run against the
// shipped tag editor (HFY-TSK-260: islands/src/lib/photo-tag-edit.js, photo-tags.js) and the ops engine it feeds. T-13..T-19 that are
// kit-only or audit-only are listed as skipped with the reason. The Python half (rules.py, transform.py, projection.py) is
// gramps/tests/unit/test_tag_rect_conformance.py, which reads the same fixtures file.
//
// CodeArtifact-free: node:test and node built-ins only; the code under test imports no package. Runs in the io-kit CI `tests` list.
//
// The fixtures (tests/tagging/fixtures/tag-conformance.fixtures.json) follow architect ruling P4-R16: normalizeRect is Gramps-exact for
// read/compare (null only for the full frame and a point; a box with one zero-extent axis is kept) and validateNewRect is the
// authoring guard (rejects zero-area, inverted, smaller than 2x2, non-integer, out of range). The reference implementation of both is
// tests/tagging/reference-rect.mjs, and "FX" tests prove the fixtures agree with it.
//
// KNOWN-FAIL ROWS. The shipped code does not meet every row yet; the baseline is docs/reference/BASELINE.md. A failing row is listed in
// KNOWN below with its cause (file:line) and the test asserts that it STILL fails, so CI stays green and records the gap. A known-fail
// row that starts to pass fails CI until it is removed from KNOWN and the baseline is updated: the list can only shrink on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ref from "./reference-rect.mjs";
import * as editor from "../../islands/src/lib/photo-tag-edit.js";
import * as tags from "../../islands/src/lib/photo-tags.js";
import { applyOps, keySegment } from "../../api/src/records/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(here, "fixtures", "tag-conformance.fixtures.json"), "utf8"));
const { revive } = ref;

const PE = "islands/src/lib/photo-tag-edit.js";
const PT = "islands/src/lib/photo-tags.js";

// ---- known-fail rows: key -> { why, at } ----------------------------------------------------------------------------------------------
const READ_NO_ROUND = { why: "the read-side normalizeRect does not round to integers", at: `${PT}:35-41` };
const READ_FULL = { why: "the full frame is returned as a region, not null (Gramps stores it as no region)", at: `${PT}:35-41` };
const READ_LINE = { why: "a box with one zero-extent axis is nulled; Gramps keeps it as typed (P4-R16)", at: `${PT}:40` };
const NO_GUARD = { why: "no validateNewRect: toGrampsRect and buildTagOps accept it (clamp, order, grow to 1 unit)", at: `${PE}:32-45,191-199` };

const KNOWN = {
  "T-3/read/whole-image": READ_FULL,
  "T-3/read/whole-image-by-clamp": READ_FULL,
  "T-3/read/rounds-to-full": READ_FULL,
  "T-4/read/rounds-to-point": READ_NO_ROUND,
  "T-4/read/line-zero-width": READ_LINE,
  "T-4/read/line-zero-height": READ_LINE,
  "T-4/read/fully-outside": READ_LINE,
  "T-4/read/rounds-to-zero-area": READ_NO_ROUND,
  "T-2/read/tie_half_up": READ_NO_ROUND,
  "T-2/read/below-tie": READ_NO_ROUND,
  "T-4/read-invalid/short-array": { why: "malformed input is read as null (a person tagged without an area) instead of throwing RECT_INVALID", at: `${PT}:36` },
  "T-4/read-invalid/nan": { why: "malformed input is read as null instead of throwing RECT_INVALID", at: `${PT}:36` },
  "T-4/read-invalid/infinity": { why: "malformed input is read as null instead of throwing RECT_INVALID", at: `${PT}:36` },
  "T-4/read-invalid/string-element": { why: "malformed input is read as null instead of throwing RECT_INVALID", at: `${PT}:36` },
  "T-4/read-invalid/not-an-array": { why: "malformed input is read as null instead of throwing RECT_INVALID", at: `${PT}:36` },
  "T-2/write/tie_half_up": { why: "toGrampsRect floors x1,y1: 12.5 gives 12, nearest half-up gives 13 (outward rounding, sync design 9)", at: `${PE}:32-45` },
  "T-2/write/nearest-vs-outward": { why: "toGrampsRect rounds outward (10.6 -> 10, 40.4 -> 41); the fixture rounds to nearest", at: `${PE}:32-45` },
  "T-3/author/full-frame": { why: "a full-frame draw is trimmed to [0,0,99,99] instead of null (whole image)", at: `${PE}:43` },
  "T-5/author/one-unit-box": NO_GUARD,
  "T-5/author/two-by-one-box": NO_GUARD,
  "T-4/author/point": NO_GUARD,
  "T-4/author/line-zero-width": NO_GUARD,
  "T-4/author/line-zero-height": NO_GUARD,
  "T-4/author/reversed-both": NO_GUARD,
  "T-4/author/reversed-x-only": NO_GUARD,
  "T-2/author/fractional": NO_GUARD,
  "T-4/author/negative": NO_GUARD,
  "T-4/author/over-100": NO_GUARD,
  "T-4/author/validateNewRect-exported": { why: "the authoring guard validateNewRect does not exist in the editor module", at: `${PE}` },
  "T-5/ui/resize-floor-is-2-units": { why: "MIN_SIDE is 1, so an edge or corner can be resized to a 1-unit side (D-07 wants 2)", at: `${PE}:50,95-103` },
  "T-9/add-identical-appends": { why: "buildTagOps refuses an identical tag with reason \"exists\"; D-04 says add always appends and rect equality never identifies a MediaRef", at: `${PE}:191-199` },
  "V-1/overlay-ignores-origin": { why: "the overlay branches on tag.source (site vs gramps): different words, and applyToTags marks a fresh tag \"site\"", at: `${PT}:146,167; ${PE}:226-232` }
};

function check(key, fn) {
  const known = KNOWN[key];
  test(`${key}${known ? " [known-fail]" : ""}`, () => {
    if (!known) return fn();
    let failed = false;
    try { fn(); } catch { failed = true; }
    assert.ok(failed, `${key} is listed in KNOWN but now passes: remove it from KNOWN and update docs/reference/BASELINE.md`);
    return undefined;
  });
}

// ---- helpers --------------------------------------------------------------------------------------------------------------------------
const MEDIA = FX.deskTwin.mediaRef.ref;
const person = (n, media = []) => ({ _class: "Person", handle: `hp000${n}`, gramps_id: `I900${n}`, private: false, gender: 2, media_list: media, event_ref_list: [], family_list: [], parent_family_list: [] });
const keyOf = (p) => `Person:${p.handle}`;
const bundleOf = (p) => ({ key: keyOf(p), obj: p });
const mref = (ref0, rect) => editor.newMediaRef(ref0, rect);

// ---- FX: the fixtures agree with the reference implementation (always pass) -------------------------------------------------------------
for (const r of FX.normalizeRect.rows) {
  test(`FX/normalizeRect/${r.id}`, () => {
    assert.deepStrictEqual(ref.normalizeRect(revive(r.in)), r.out);
    if (r.ms2 !== undefined && r.out) assert.equal(ref.meetsMinSize(r.out, FX.minTagUnits), r.ms2);
  });
}
for (const r of FX.normalizeRect.throwsRectInvalid) {
  test(`FX/throws/${r.id}`, () => assert.throws(() => ref.normalizeRect(revive(r.in)), { code: "RECT_INVALID" }));
}
for (const r of FX.emit.rows) {
  test(`FX/emit/${r.id}`, () => {
    assert.deepStrictEqual(ref.normalizeRect(r.drawn), r.emit);
    assert.equal(ref.validateNewRect(r.emit).ok, true);
  });
}
for (const r of FX.authoring.rows) {
  test(`FX/authoring/${r.id}`, () => {
    const got = ref.validateNewRect(r.rect);
    assert.equal(got.ok, r.ok);
    if (r.ok) assert.deepStrictEqual(got.rect, r.rect_out);
    else assert.equal(got.code, r.code);
  });
}
test("FX/no-negative-zero-in-reference", () => assert.ok(Object.is(ref.normalizeRect([-0, 0, 50, 50])[0], 0)));

// ---- T-1 .. T-5: the rect rules, read side ----------------------------------------------------------------------------------------------
for (const r of FX.normalizeRect.rows) {
  check(`${r.t}/read/${r.id}`, () => {
    const got = tags.normalizeRect(revive(r.in));
    assert.deepStrictEqual(got, r.out);
  });
}
for (const r of FX.normalizeRect.throwsRectInvalid) {
  check(`T-4/read-invalid/${r.id}`, () => assert.throws(() => tags.normalizeRect(revive(r.in)), { code: "RECT_INVALID" }));
}

// ---- T-1, T-2: the rect the editor emits for a drawn box -------------------------------------------------------------------------------
for (const r of FX.emit.rows) {
  check(`${r.t}/write/${r.id}`, () => assert.deepStrictEqual(editor.toGrampsRect(r.drawn), r.emit));
}
test("T-2/write/integers-only-on-the-grid", () => {
  for (const r of FX.emit.rows) assert.ok(editor.toGrampsRect(r.drawn).every(Number.isInteger), r.id);
});

// ---- T-1/T-3/T-4/T-5: the ops layer as the authoring guard ------------------------------------------------------------------------------
for (const r of FX.authoring.rows) {
  check(`${r.t}/author/${r.id}`, () => {
    const built = editor.buildTagOps(bundleOf(person(1)), { kind: "add", mediaHandle: MEDIA, rect: r.rect });
    assert.equal(built.ok, r.ok, `ok for ${JSON.stringify(r.rect)}`);
    if (r.ok) assert.deepStrictEqual(built.ops[0].value.rect, r.rect_out);
  });
}
check("T-4/author/validateNewRect-exported", () => assert.equal(typeof editor.validateNewRect, "function"));

test("T-1/web-equals-desk-twin", () => {
  const built = editor.buildTagOps(bundleOf(person(1)), { kind: "add", mediaHandle: MEDIA, rect: FX.deskTwin.mediaRef.rect });
  assert.equal(built.ok, true);
  assert.deepStrictEqual(built.ops[0].value, FX.deskTwin.mediaRef);
  assert.equal(JSON.stringify(built.ops[0].value), JSON.stringify(FX.deskTwin.mediaRef));
});

test("T-5/ui/isDrawn-rejects-a-1-unit-drag", () => {
  assert.equal(editor.isDrawn({ x: 10, y: 10 }, { x: 11, y: 11 }), false);
  assert.equal(editor.isDrawn({ x: 10, y: 10 }, { x: 12, y: 12 }), true);
  assert.equal(editor.DRAW_MIN, FX.minTagUnits);
});
check("T-5/ui/resize-floor-is-2-units", () => {
  const out = editor.moveEdge([10, 10, 40, 40], "right", -29);
  assert.ok(out[2] - out[0] >= FX.minTagUnits, `width ${out[2] - out[0]}`);
});

// ---- T-6: two regions of one person, delete the second -----------------------------------------------------------------------------------
test("T-6/delete-second-region-keeps-the-first", () => {
  const rect = [20, 15, 70, 85];
  const list = [mref(MEDIA, rect), mref(MEDIA, rect), mref("m0000000002", null)];
  const p = person(1, list);
  const built = editor.buildTagOps(bundleOf(p), { kind: "remove", mediaHandle: MEDIA, from: rect, nth: 1 });
  assert.equal(built.ok, true);
  assert.equal(built.ops[0].path, `/media_list/${keySegment("media_list", list, 1)}`);
  assert.notEqual(keySegment("media_list", list, 0), keySegment("media_list", list, 1));
  const applied = applyOps({ [keyOf(p)]: p }, built.ops);
  assert.equal(applied.ok, true);
  const after = applied.objects[keyOf(p)].media_list;
  assert.equal(after.length, 2);
  assert.deepStrictEqual(after[0], list[0]);
  assert.equal(after[1].ref, "m0000000002");
});

// ---- T-7: skipped ------------------------------------------------------------------------------------------------------------------------
test("T-7/orientation-6-original-vs-normalized-copy", { skip: "browser-only: photo.js bakes EXIF orientation with createImageBitmap(imageOrientation: from-image) (islands/src/lib/photo.js:3,57); needs a real browser and Playwright is off the table in this lane. Percent rects do not depend on pixels once the copy is upright" }, () => {});

// ---- T-8: a 4000 px original and a 2560 px cloud copy agree -----------------------------------------------------------------------------
test("T-8/original-and-cloud-copy-give-one-rect", () => {
  const g = FX.geometry;
  const results = g.originals.map((o) => {
    const c = tags.containedRect(g.box.w, g.box.h, o.w, o.h);
    const layer = { left: 0, top: 0 };
    const p = editor.pointToPercent(g.pointer.from[0], g.pointer.from[1], layer, c);
    const q = editor.pointToPercent(g.pointer.to[0], g.pointer.to[1], layer, c);
    return editor.toGrampsRect(editor.rectBetween(p, q));
  });
  assert.deepStrictEqual(results[0], results[1]);
  assert.deepStrictEqual(results[0], g.expectDrawn);
});

// ---- T-9: append order -------------------------------------------------------------------------------------------------------------------
test("T-9/new-tag-lands-at-index-2", () => {
  const before = [mref("m0000000002", null), mref("m0000000003", [1, 1, 5, 5])];
  const p = person(1, before);
  const built = editor.buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [30, 47, 34, 54] });
  assert.equal(built.ok, true);
  const applied = applyOps({ [keyOf(p)]: p }, built.ops);
  assert.equal(applied.ok, true);
  const after = applied.objects[keyOf(p)].media_list;
  assert.equal(after.length, 3);
  assert.deepStrictEqual(after.slice(0, 2), before);
  assert.deepStrictEqual(after[2], FX.deskTwin.mediaRef);
});
check("T-9/add-identical-appends", () => {
  const p = person(1, [mref(MEDIA, [30, 47, 34, 54])]);
  const built = editor.buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [30, 47, 34, 54] });
  assert.equal(built.ok, true, `reason ${built.reason}`);
});

// ---- T-10: skipped -----------------------------------------------------------------------------------------------------------------------
test("T-10/web-draw-sync-move-in-gramps-sync-back", { skip: "needs Gramps.app 6.0.6, the sync dev server and api/node_modules (CodeArtifact): gramps/tests/e2e/scenario_tag_roundtrip.py (HFY-TSK-261) is the lane and is not run in this suite; it uses only in-range, ordered, non-degenerate rects" }, () => {});

// ---- T-11: an applied proposal equals a direct tag ---------------------------------------------------------------------------------------
test("T-11/proposal-ops-are-the-direct-ops", () => {
  const p = person(1, [mref("m0000000002", null)]);
  const change = { kind: "add", mediaHandle: MEDIA, rect: [30, 47, 34, 54] };
  const direct = editor.buildTagOps(bundleOf(p), change);
  const asProposal = JSON.parse(JSON.stringify(editor.buildTagOps(bundleOf(p), change).ops));
  assert.equal(editor.expectedRoute({ id: "I9100", admin: true }, "I9001"), "direct");
  assert.equal(editor.expectedRoute({ id: "I9100", admin: false }, "I9001"), "review");
  assert.equal(JSON.stringify(asProposal), JSON.stringify(direct.ops));
  const a = applyOps({ [keyOf(p)]: p }, direct.ops);
  const b = applyOps({ [keyOf(p)]: p }, asProposal);
  assert.equal(JSON.stringify(a.objects), JSON.stringify(b.objects));
});

// ---- T-12: Python (gramps/tests/unit/test_tag_rect_conformance.py, class T12) ------------------------------------------------------------

// ---- P-1 (BRD T-13): portrait ---------------------------------------------------------------------------------------------------------
test("P-1/portrait-index-0-prior-at-1-full-frame-crop-null", { skip: "not applicable: portraitV1 is not shipped (no portrait operation in api/src or islands/src; only CSS hits)" }, () => {});

// ---- V-1 (BRD T-14): web upload, post graduation and desk import look alike --------------------------------------------------------------
check("V-1/overlay-ignores-origin", () => assert.equal(tags.SOURCE_LINE.site, tags.SOURCE_LINE.gramps));
test("V-1/gramps-reports-identical-and-section-membership", { skip: "needs the Gramps Individual Complete and Narrated Web reports and the hfy-web-upload / hfy-post Tags (D-34), which are not shipped" }, () => {});

// ---- T-15 .. T-19: kit-only or audit-only ----------------------------------------------------------------------------------------------
for (const [id, why] of [
  ["T-15", "kit-only: K-1 consent module (resolvePeople, putTags 403 NOT_TAGGABLE); no consent module in HFY yet"],
  ["T-16", "kit-only: K-2 selfUntag through the normal op path"],
  ["T-17", "kit-only: K-3 reAddLock (409 UNTAGGED_BY_SUBJECT)"],
  ["T-18", "kit-only: K-4 hideAll"],
  ["T-19", "audit-only: every web tag created before the suite passes or is corrected (runs against production data, not fixtures)"]
]) {
  test(`${id}/skipped`, { skip: why }, () => {});
}
