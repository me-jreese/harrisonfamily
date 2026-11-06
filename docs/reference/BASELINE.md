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
    python: {note: "the five Python known-fail rows passed after HFY-TSK-401; gramps/tests/unit/test_tag_rect_conformance.py and test_rect_readers.py carry no known-fail rows"}
  results:
    T-1:  {status: pass, why: "grid-basic (30,47,34,54) and the integer corner rows match; the web MediaRef equals the desk twin field for field", checks: "toGrampsRect, buildTagOps add"}
    T-2:  
      status: fail
      why: "the editor emits integers only, but rounds outward (floor x1,y1; ceil x2,y2) where the fixtures round to nearest, half up"
      failing: [write/tie_half_up, write/nearest-vs-outward, read/tie_half_up, read/below-tie, author/fractional]
      cause: ["islands/src/lib/photo-tag-edit.js:32-45", "islands/src/lib/photo-tags.js:35-41"]
    T-3:
      status: fail
      why: "the full frame is not null in the shipped editor module: the read side returns it as a region and a full-frame draw is trimmed to (0,0,99,99). The render reader reads it as no region since HFY-TSK-401"
      failing: [read/whole-image, read/whole-image-by-clamp, read/rounds-to-full, author/full-frame]
      passing: ["rules.rect_problem names the full frame (rules.py)", "projection nulls it", "render reader nulls it (transform.mediaref_rect via hfygramps/rect.py, HFY-TSK-401)"]
      cause: ["islands/src/lib/photo-tags.js:35-41", "islands/src/lib/photo-tag-edit.js:43"]
    T-4:
      status: fail
      why: "no authoring guard in the shipped editor module (validateNewRect does not exist); its read side nulls lines and conflates malformed input with no region. The Python readers (rules, projection, render) are Gramps-exact since HFY-TSK-401"
      failing: [read/line-zero-width, read/line-zero-height, read/fully-outside, read/rounds-to-zero-area, read/rounds-to-point, "read-invalid x5 (no RECT_INVALID)", "author x8 (point, 2 lines, 2 reversed, negative, over-100, validateNewRect-exported)"]
      passing: ["all-zero, point, point-nonzero read as null", "reversed and out-of-range inputs normalize", "importing every fixture rect does not crash rules or the render reader", "the Python readers null a point, keep a one-axis-zero box and reversed corners as stored, and hold only a fraction, an out-of-range value or a wrong shape (rules.rect_problem, projection, render transform; HFY-TSK-401, test_rect_readers.py)"]
      cause: ["islands/src/lib/photo-tags.js:36,40", "islands/src/lib/photo-tag-edit.js:32-45,191-199"]
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
      status: pass
      why: "the overlay shows one line for every tag and no longer branches on tag.source (HFY-TSK-388-0G pass 2: photo-tags.js SOURCE_LINE is one string, applyToTags adds no source); the render DTO was already origin-blind"
      passing: [overlay-ignores-origin]
      skipped: ["Gramps Individual Complete and Narrated Web report diff; section membership (needs D-34 Tags, not shipped)"]
    T-15: {status: skip, why: "kit-only: consent module K-1"}
    T-16: {status: skip, why: "kit-only: selfUntag K-2"}
    T-17: {status: skip, why: "kit-only: reAddLock K-3"}
    T-18: {status: skip, why: "kit-only: hideAll K-4"}
    T-19: {status: skip, why: "audit-only: runs against production tags, not fixtures"}
  repo_disagreements_fixed_since:
    - {where: "gramps/hfygramps/rules.py, projection.py, render/transform.py", what: "HFY-TSK-401 (HFY-ISS-028, P4-R16): all three read rectangles through hfygramps/rect.py, null only for the full frame and a point, keep a one-axis-zero box and reversed corners as stored; the redaction vectors, the JS port (shared/redaction-rules.mjs) and the sync validator follow. Code lands in production only with the render Lambda redeploy and the API redeploy, which need io's go-ahead"}
```

## Adapter status (HFY-TSK-388-0G, pass 1)

The new HFY tag adapter ([Tag ports of the media adapter](front-end.md#tag-ports-of-the-media-adapter)) is the writer pass 2 puts behind the editor. The shipped editor's helper module (`photo-tag-edit.js`) is unchanged and its rows above still fail for it; pass 2 (HFY-TSK-388-0G) swapped the editor UI for the kit's, so no UI uses it any more, and the overlay no longer branches on the origin (V-1 passes): their entries stay known-fails here. The Python rows passed with HFY-TSK-401. This section records what the adapter does on the same fixtures. It is a dated record, not a live status: run `node --test tests/tagging/wire-conformance.test.mjs` and, in `islands/`, `node --test tests/hfy-tag-ports.test.mjs tests/hfy-tag-parity.test.mjs`.

```yaml
adapter:
  date: 2026-11-06
  subject: ["islands/src/lib/hfy-tag-wire.js", "islands/src/lib/hfy-tag-ports.js", "islands/src/lib/hfy-media-source.js normalizeRect"]
  suites: ["tests/tagging/wire-conformance.test.mjs", "islands/tests/hfy-tag-ports.test.mjs", "islands/tests/hfy-tag-parity.test.mjs"]
  rows:
    T-1: {editor: pass, adapter: pass}
    T-2: {editor: fail, adapter: pass, why: "nearest, half up (emitRect, normalizeRect)"}
    T-3: {editor: fail, adapter: pass, why: "the full frame reads and writes as null"}
    T-4: {editor: fail, adapter: pass, why: "RECT_INVALID on malformed input; points null, lines kept; validateNewRect guards writes"}
    T-5: {editor: fail, adapter: pass, why: "smaller than 2x2 is refused before any request; the resize floor in the editor UI is a pass-2 item"}
    T-6: {editor: pass, adapter: pass}
    T-8: {editor: pass, adapter: pass, why: "kit geometry fixture, kit side"}
    T-9:
      editor: fail
      adapter: fail
      why: "a new tag lands at the end (index 2) and a tag with a different rect appends; a byte-identical MediaRef cannot be appended because the ops engine's add is idempotent for an identical element (api/src/records/ops.js, 'an identical element is present'). The adapter returns the existing tag and lists the op in result.identical. D-04 wants an append: raised on the record, it needs an API change."
      cause: ["api/src/records/ops.js:511"]
    T-11: {editor: pass, adapter: pass, why: "the same ops for a direct and a proposal route; the server decides"}
    T-12: {adapter: pass, why: "the tag DTO carries no origin"}
    T-15: {adapter: "HFY policy", why: "isTaggable is true for every visible person (D-13); the kit's enforcing fixture does not apply"}
    T-16: {adapter: pass, why: "selfUntag removes the member's own MediaRef through the normal path, with a note, and keeps a reversible audit record"}
    T-17: {adapter: "HFY policy", why: "the re-add lock is audit-only: a re-add by another member is allowed (as a proposal) and recorded"}
    T-18: {adapter: "HFY policy", why: "hideAll is a no-op"}
    V-1: {editor: pass, adapter: pass, why: "the adapter's tag carries no source, and since pass 2 neither the overlay nor the lightbox view layer branches on one"}
  still_known_fail_outside_the_adapter:
    - {where: "islands/src/lib/photo-tag-edit.js, photo-tags.js", rows: [T-2, T-3, T-4, T-5, T-9], note: "since the editor swap (pass 2, HFY-TSK-388-0G) no UI uses this helper module; the kit editor over the adapter passes T-2 to T-5, and T-9 stays the documented limitation (ruling P4-R34)"}
```
