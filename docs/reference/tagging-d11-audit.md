# Photo tagging: the D-11 audit and the end-to-end scenarios

The audit of the tagging lightbox (flag `photoTagEdit`) before its flag flips, and the three end-to-end scenarios behind it. It came out of HFY-TSK-283 (`tag-edit-e2e`), split from [the editing audit](editing-d11-audit.md) so a tagging defect never holds the other editing flags. The flip itself is `tag-edit-flip`; io's UAT and approval are written down there, not here.

## The checklist

Each state is measured at 375 and 1024 px wide by [`islands/tests/tag-edit-d11-audit.spec.mjs`](../../islands/tests/tag-edit-d11-audit.spec.mjs), with the same measurements as the editing audit ([`islands/tests/d11-measure.mjs`](../../islands/tests/d11-measure.mjs)): 16 px inputs, 44 px targets, one control height per row, no horizontal scroll, axe clean (serious and critical). Two tagging checks are explicit: the four corner handles of a selected box and all twelve nudge buttons measure 44 by 44 px or more, and each has a name.

| State | What the state is | 375 px | 1024 px | Checklist at 375 | Checklist at 1024 |
|---|---|---|---|---|---|
| `tag-layer` | tagging switched on, the page's tags as boxes | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-layer-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-layer-1024.png) | green | green |
| `tag-selected` | an existing tag selected: four handles, the panel, the nudge buttons | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-selected-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-selected-1024.png) | green | green |
| `tag-picker` | a new box drawn, the person picker open with matches | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-picker-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-picker-1024.png) | green | green |
| `tag-sheet` | the confirmation sheet for a tag that goes to review | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-sheet-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-sheet-1024.png) | green | green |
| `tag-sent` | the toast after sending | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-sent-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-283/tag-sent-1024.png) | green | green |

All five states pass at both widths. The checks read the page's DOM (sizes, names, axe), not what is inside the viewport, so a green 1024 px column does not mean the 1024 px image shows the state. The screenshots are full-page captures written by running the spec with `HFY_AUDIT_SHOTS=<dir>`, named `<state>-<width>.png`, under the task's asset prefix (HFY-R16), `s3://jreese-net/agent-documents/assets/HFY-TSK-283/`. Every image was checked by eye before the upload for one thing: it shows only the synthetic fixture world (placeholder names and ids, the "Test Person (synthetic)" page and a gray stand-in photo). The links are bucket paths, not web addresses: opening them needs AWS access to that bucket. All 10 files were listed in the bucket on 2026-10-16 and match the links in the table.

What the 1024 px images show. The 375 px images show each state as the table describes it, panel and toast included. The 1024 px ones do not, because the lightbox is a layer fixed to the 768 px viewport and the panel (and so the nudge buttons and the toast) sits at or below that layer's bottom edge, outside the frame:

- `tag-layer-1024`: the lightbox with the page's existing tag box, as described.
- `tag-selected-1024`: the box with its four handles. The panel and the nudge buttons are not in the image.
- `tag-picker-1024`: the new box and the start of the picker; the list of matches is cut off at the bottom edge.
- `tag-sheet-1024`: the confirmation sheet, as described.
- `tag-sent-1024`: the lightbox with the existing tag box and no toast and no selection. It is byte-identical to `tag-layer-1024` (same ETag, `74e68e03ce96e9e49c385629e375cd6d`), so it is not evidence of the toast. At 1024 px the toast is covered by the spec's text assertion only; the 375 px image is the one that shows it.

Open before the flip, the 1024 px images: recapture `tag-selected`, `tag-picker` and `tag-sent` at 1024 px as viewport captures (not full-page) with the panel scrolled into view, then upload them over the three links (a separate step from this change, since it writes to the bucket). Whether a person can scroll the panel and the picker list into view in the lightbox at 1024 by 768 px has not been checked by hand; the DOM checks pass wherever the elements sit, so they do not answer it.

The toast's Undo (HFY-TSK-345): a tag that saves now shows an "undo" button on the toast (a 44 px target, a real button so the keyboard reaches it, its label visible and read with the toast text). The audit spec saves a tag of oneself, checks the button is 44 px at 375 and 1024 and runs axe on it (`tag-saved-undo`). The button sends the inverse ops the save returned and nothing else, so an undo writes no text the save did not write (the tag ops carry only ids and whole-percent boxes). It goes away after 10 minutes or at the next edit. Browser scenario 2 now clicks it.

Not covered: the installed iPhone app (io's UAT inside `tag-edit-flip`), and anything a live site serves; the audit runs on localhost against the committed site.

## The end-to-end scenarios

The same three scenarios run as API requests ([`api/test/tag-edit-e2e.test.js`](../../api/test/tag-edit-e2e.test.js), `cd api && npm test`) and through the real lightbox ([`islands/tests/tag-edit-e2e.spec.mjs`](../../islands/tests/tag-edit-e2e.spec.mjs)), over the editing fake store with a photo (`createEditWorld({ photo: true })` in [`api/test/edit-e2e-world.js`](../../api/test/edit-e2e-world.js)). The browser spec's helpers are in [`islands/tests/tag-e2e-bridge.mjs`](../../islands/tests/tag-e2e-bridge.mjs); its person page lists the tags the way the site's build would from the store, so an approved tag shows on the next load. That stand-in proves the helper reads the store, not that the real build output includes an approved tag.

1. A tag drawn on another person becomes a suggestion and changes nothing; an admin approves it in the review queue; the record carries it with a whole-percent box and the overlay shows it.
2. A tag of oneself, on one's own record, saves now with nothing sent to review; the toast's undo button takes it off again (at the API, the undo the save returned does the same).
3. (Browser: the editor's own planning catches the stale key before any request, so the server's 409 is asserted only in the API test; together they cover it.) A tag key that went stale, because the tag changed after the page was built, is a conflict: nothing is sent from the page, the API refuses an old key even at a fresh version, and the changed box is never moved.

All ids and names are synthetic. Run the browser specs with `cd islands && PW_PORT=<free port> npx playwright test tests/tag-edit-e2e.spec.mjs tests/tag-edit-d11-audit.spec.mjs`.
