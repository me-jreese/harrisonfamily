# Tagging conformance baseline

This page records what the tagging conformance suite found when it first ran against the shipped tag editor (HFY-TSK-387-0A, plan HFY-PLN-004, BRD rows T-1 to T-14, P-1 and V-1). It is a dated baseline, not a live status: run the suite to see the current state.

- Run on 2026-11-06 against `main` at `bdbfddb7`, Node 22, Python 3.10.
- Gramps: the source read is **6.0.5** (the installed copy) and **6.0.6** (the Gramps.app copy); the region logic is identical in both. It is not 5.2, which the BRD wording names and nobody read.
- Rect rules follow architect ruling P4-R16. Read and compare are Gramps-exact: `null` only for the full frame `(0,0,100,100)` and for a point (`x1==x2` and `y1==y2`); a box with one zero-extent axis is kept as typed. The authoring guard `validateNewRect` rejects zero-area, inverted and smaller than 2x2 (D-07); the editor emits only integers on the 1% grid (D-02). This overrides the spec's step 6 and the BRD wording "zero-area to null".
- Suites: `node --test 'tests/tagging/*.test.mjs'` (fixtures in `tests/tagging/fixtures/tag-conformance.fixtures.json`, reference implementation in `tests/tagging/reference-rect.mjs`) and `gramps/tests/unit/test_tag_rect_conformance.py`. Both are CodeArtifact-free and run in the `tests` list of `ci.manifest.yaml`.
- A failing row is a documented known-fail: the test asserts that it still fails, so CI stays green, and CI fails when a known-fail row starts to pass until its entry and this baseline are updated.

```yaml
baseline:
  date: 2026-11-06
  base_commit: bdbfddb7
  gramps_source: ["6.0.5", "6.0.6"]
  ruling: P4-R16
  rows: {total: 19, pass: 5, fail: 6, skip: 8}
  checks:
    node: {tests: 125, pass: 116, fail_unexpected: 0, skipped: 9, known_fail: 32, fixture_vs_reference: 52, conformance_pass: 32}
    python: {tests: 14, ok: 9, known_fail: 5}
  results:
    T-1:  {status: pass, why: "grid-basic (30,47,34,54) and the integer corner rows match; the web MediaRef equals the desk twin field for field", checks: "toGrampsRect, buildTagOps add"}
    T-2:  
      status: fail
      why: "the editor emits integers only, but rounds outward (floor x1,y1; ceil x2,y2) where the fixtures round to nearest, half up"
      failing: [write/tie_half_up, write/nearest-vs-outward, read/tie_half_up, read/below-tie, author/fractional]
      cause: ["islands/src/lib/photo-tag-edit.js:32-45", "islands/src/lib/photo-tags.js:35-41"]
    T-3:
      status: fail
      why: "the full frame is not null: the read side returns it as a region, a full-frame draw is trimmed to (0,0,99,99), and the render reader copies it"
      failing: [read/whole-image, read/whole-image-by-clamp, read/rounds-to-full, author/full-frame, render_reader_nulls_the_full_frame]
      passing: ["rules.rect_problem names the full frame (rules.py)", "projection nulls it"]
      cause: ["islands/src/lib/photo-tags.js:35-41", "islands/src/lib/photo-tag-edit.js:43", "gramps/hfygramps/render/transform.py:431-445"]
    T-4:
      status: fail
      why: "no authoring guard (validateNewRect does not exist); the read side nulls lines and conflates malformed input with no region; rules and projection hold points and lines"
      failing: [read/line-zero-width, read/line-zero-height, read/fully-outside, read/rounds-to-zero-area, read/rounds-to-point, "read-invalid x5 (no RECT_INVALID)", "author x8 (point, 2 lines, 2 reversed, negative, over-100, validateNewRect-exported)", render_reader_nulls_a_point, rules_do_not_hold_a_line, rules_do_not_hold_a_point, projection_does_not_restore_base]
      passing: ["all-zero, point, point-nonzero read as null", "reversed and out-of-range inputs normalize", "importing every fixture rect does not crash rules or the render reader"]
      cause: ["islands/src/lib/photo-tags.js:36,40", "islands/src/lib/photo-tag-edit.js:32-45,191-199", "gramps/hfygramps/rules.py:353-359", "gramps/hfygramps/projection.py:755-763", "gramps/hfygramps/render/transform.py:431-445"]
    T-5:
      status: fail
      why: "a 1-unit box is accepted and a resize can shrink a side to 1 unit; D-07 and P4-R16 want smaller than 2x2 rejected (the BRD word \"expands to 2x2\" is superseded)"
      failing: [author/one-unit-box, author/two-by-one-box, ui/resize-floor-is-2-units]
      passing: ["isDrawn rejects a 1-unit drag and DRAW_MIN is 2", "2x2 and edge 2-unit boxes read and write unchanged"]
      cause: ["islands/src/lib/photo-tag-edit.js:50,95-103,191-199"]
    T-6:  {status: pass, why: "removing the second of two identical regions of one person keeps the first and the other media (key #1 differs from #0)", checks: "buildTagOps remove nth=1, applyOps"}
    T-7:  {status: skip, why: "browser-only: islands/src/lib/photo.js:3,57 bakes EXIF orientation via createImageBitmap; no Playwright in this lane"}
    T-8:  {status: pass, why: "a 4000x3000 original and a 2560x1920 copy give one rect for the same pointer", checks: "containedRect, pointToPercent, toGrampsRect"}
    T-9:
      status: fail
      why: "a new tag lands at index 2 (pass), but an identical second tag is refused with reason exists; D-04 says add always appends and rect equality never identifies a MediaRef"
      failing: [add-identical-appends]
      passing: [new-tag-lands-at-index-2]
      cause: ["islands/src/lib/photo-tag-edit.js:191-199"]
    T-10: {status: skip, why: "needs Gramps.app 6.0.6, the sync dev server and api/node_modules; gramps/tests/e2e/scenario_tag_roundtrip.py (HFY-TSK-261) is the lane, not run here; it compares lists of four ints and uses only in-range ordered non-degenerate rects"}
    T-11: {status: pass, why: "direct and proposal routes differ, the ops are byte-identical and apply to the same object", checks: "ops layer only; the server proposal-apply path was not run"}
    T-12: {status: pass, why: "structural: no origin input on the render, rules, projection or redaction path; the tag DTO carries one constant source", checks: "source scan; a behavioural twin needs the hfy-web-upload Tag (D-34), not shipped"}
    P-1:  {status: skip, why: "not applicable: portraitV1 is not shipped (no portrait operation in api/src or islands/src)"}
    V-1:
      status: fail
      why: "the overlay branches on tag.source: different words for site and gramps, and a just-added tag is marked site client-side; the render DTO itself is origin-blind"
      failing: [overlay-ignores-origin]
      skipped: ["Gramps Individual Complete and Narrated Web report diff; section membership (needs D-34 Tags, not shipped)"]
      cause: ["islands/src/lib/photo-tags.js:146,167", "islands/src/lib/photo-tag-edit.js:226-232"]
    T-15: {status: skip, why: "kit-only: consent module K-1"}
    T-16: {status: skip, why: "kit-only: selfUntag K-2"}
    T-17: {status: skip, why: "kit-only: reAddLock K-3"}
    T-18: {status: skip, why: "kit-only: hideAll K-4"}
    T-19: {status: skip, why: "audit-only: runs against production tags, not fixtures"}
  repo_disagreements_not_fixed_here:
    - {where: "gramps/hfygramps/rules.py:353-359", what: "rect_problem holds degenerate rects (x1>=x2 or y1>=y2: points, lines, reversed)"}
    - {where: "gramps/hfygramps/projection.py:755-763", what: "restores the base rect for those held rects, and nulls only the full frame"}
    - {where: "gramps/hfygramps/render/transform.py:431-445", what: "mediaref_rect nulls [0,0,0,0] only: not the full frame, not a point"}
```
