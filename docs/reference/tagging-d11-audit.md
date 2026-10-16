# Photo tagging: the D-11 audit and the end-to-end scenarios

The audit of the tagging lightbox (flag `photoTagEdit`) before its flag flips, and the three end-to-end scenarios behind it. It came out of HFY-TSK-283 (`tag-edit-e2e`), split from [the editing audit](editing-d11-audit.md) so a tagging defect never holds the other editing flags. The flip itself is `tag-edit-flip`; io's UAT and approval are written down there, not here.

## The checklist

Each state is measured at 375 and 1024 px wide by [`islands/tests/tag-edit-d11-audit.spec.mjs`](../../islands/tests/tag-edit-d11-audit.spec.mjs), with the same measurements as the editing audit ([`islands/tests/d11-measure.mjs`](../../islands/tests/d11-measure.mjs)): 16 px inputs, 44 px targets, one control height per row, no horizontal scroll, axe clean (serious and critical). Two tagging checks are explicit: the four corner handles of a selected box and all twelve nudge buttons measure 44 by 44 px or more, and each has a name.

| State | What is on screen |
|---|---|
| `tag-layer` | tagging switched on, the page's tags as boxes |
| `tag-selected` | an existing tag selected: four handles, the panel, the nudge buttons |
| `tag-picker` | a new box drawn, the person picker open with matches |
| `tag-sheet` | the confirmation sheet for a tag that goes to review |
| `tag-sent` | the toast after sending |

All five states pass at both widths. The screenshots are written by running the spec with `HFY_AUDIT_SHOTS=<dir>` and are named `<state>-<width>.png`. They belong under the task's asset prefix (HFY-R16), `s3://jreese-net/agent-documents/assets/HFY-TSK-283/`; they have not been uploaded yet, so there are no links here. Upload them for the flip and link them in this table.

Open before the flip: (1) upload the screenshots to the asset prefix and link them above (needs io or the pipeline's upload step); (2) the tag editor has no Undo control on its toast, which editing.md describes, so browser scenario 2 removes the tag through the UI and the API test replays the inverse ops as the undo proof; a follow-up against `tag-editor-ui` should add it, then the scenario can click it.

Not covered: the installed iPhone app (io's UAT inside `tag-edit-flip`), and anything a live site serves; the audit runs on localhost against the committed site.

## The end-to-end scenarios

The same three scenarios run as API requests ([`api/test/tag-edit-e2e.test.js`](../../api/test/tag-edit-e2e.test.js), `cd api && npm test`) and through the real lightbox ([`islands/tests/tag-edit-e2e.spec.mjs`](../../islands/tests/tag-edit-e2e.spec.mjs)), over the editing fake store with a photo (`createEditWorld({ photo: true })` in [`api/test/edit-e2e-world.js`](../../api/test/edit-e2e-world.js)). The browser spec's helpers are in [`islands/tests/tag-e2e-bridge.mjs`](../../islands/tests/tag-e2e-bridge.mjs); its person page lists the tags the way the site's build would from the store, so an approved tag shows on the next load. That stand-in proves the helper reads the store, not that the real build output includes an approved tag.

1. A tag drawn on another person becomes a suggestion and changes nothing; an admin approves it in the review queue; the record carries it with a whole-percent box and the overlay shows it.
2. A tag of oneself, on one's own record, saves now with nothing sent to review; removing it takes it off again (at the API, the undo the save returned does the same).
3. (Browser: the editor's own planning catches the stale key before any request, so the server's 409 is asserted only in the API test; together they cover it.) A tag key that went stale, because the tag changed after the page was built, is a conflict: nothing is sent from the page, the API refuses an old key even at a fresh version, and the changed box is never moved.

All ids and names are synthetic. Run the browser specs with `cd islands && PW_PORT=<free port> npx playwright test tests/tag-edit-e2e.spec.mjs tests/tag-edit-d11-audit.spec.mjs`.
