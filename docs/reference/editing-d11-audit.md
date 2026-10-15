# Editing: the D-11 after-state audit

The D-11 audit of the three editing pages before their flags flip: the editor `/edit/` (flag `recordEdit`), the relationship wizard `/edit/family/` (`relationshipWizard`) and the review page `/me/review/` (`proposalReview`). It is the audit that [Turn on editing](../how-to/turn-on-editing.md#4-check-the-page-audits) points to, and it came out of HFY-TSK-282 (the end-to-end editing task, `edit-e2e-d11-audit`; the review called it `edit-e2e-core`). Photo tagging has its own audit under `tag-edit-e2e`, so a tagging defect never holds these three flags.

This page records what was measured and where the screenshots are. It does not record a flip: io's UAT and approval for each flag are separate, and are written down where the flip happens.

## The checklist

Each state of each page is measured at 375 and 1024 px wide, by [`islands/tests/edit-d11-audit.spec.mjs`](../../islands/tests/edit-d11-audit.spec.mjs):

| Check | Passes when |
|---|---|
| 16 px inputs | every visible text field, text area and select computes to a font size of 16 px or more |
| 44 px targets | every visible button, field, summary and link measures 44 by 44 px or more; a checkbox or radio counts as its label; a link inside a sentence is exempt (WCAG 2.5.8) |
| One control height per row | buttons, selects and fields whose vertical centres sit within 3 px of each other differ in height by 1 px or less |
| No horizontal scroll | `scrollWidth` of the document is no wider than its `clientWidth` |
| axe clean | axe-core reports no serious or critical violation |

The pages run for real: the browser talks to the actual API handler over the in-memory DynamoDB fake ([`api/test/edit-e2e-world.js`](../../api/test/edit-e2e-world.js)), seeded with a synthetic tree, so the states on screen are the ones the API produces. Only `/auth`, the flags file and the static people index are stubbed. All names, ids and years are placeholders.

## Result

All states pass at both widths. Every row below was measured on the rebuilt islands (`npm run build`).

| Page | State | 375 px | 1024 px | Checklist at 375 | Checklist at 1024 |
|---|---|---|---|---|---|
| `/edit/` | the person editor, every section open | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-person-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-person-1024.png) | green | green |
| `/edit/` | two fields changed, the change bar showing | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-person-changed-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-person-changed-1024.png) | green | green |
| `/edit/` | the check sheet: one change saves now, one goes to review | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-check-sheet-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-check-sheet-1024.png) | green | green |
| `/edit/` | the toast after saving, with undo | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-saved-toast-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-saved-toast-1024.png) | green | green |
| `/edit/` | a note record | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-note-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/edit-note-1024.png) | green | green |
| `/edit/family/` | the four ways in | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-start-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-start-1024.png) | green | green |
| `/edit/family/` | finding a person | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-search-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-search-1024.png) | green | green |
| `/edit/family/` | how the person is related | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-relation-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-relation-1024.png) | green | green |
| `/edit/family/` | adding a person who is not on the site | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-new-person-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-new-person-1024.png) | green | green |
| `/edit/family/` | the summary sentences before sending | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-summary-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-summary-1024.png) | green | green |
| `/edit/family/` | the sent line | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-sent-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/family-sent-1024.png) | green | green |
| `/me/review/` | the admin queue | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-queue-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-queue-1024.png) | green | green |
| `/me/review/` | a suggestion's card with its four actions | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-card-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-card-1024.png) | green | green |
| `/me/review/` | the decline sheet | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-decline-sheet-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-decline-sheet-1024.png) | green | green |
| `/me/review/` | a member's own suggestion | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-mine-card-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-mine-card-1024.png) | green | green |
| `/me/review/` | editing one's own suggestion | [375](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-mine-edit-375.png) | [1024](s3://jreese-net/agent-documents/assets/HFY-TSK-282/review-mine-edit-1024.png) | green | green |

The screenshots are full-page captures under the task's asset prefix (HFY-R16), `s3://jreese-net/agent-documents/assets/HFY-TSK-282/`.

## What the audit found

One defect, fixed in this task: on `/edit/` for a person, the name line is a link that stands alone, and it measured 28 px high at both widths. It now takes the tap minimum (`.hfy-editor__subject > a.hfy-person-name` in `islands/src/islands/editor.css`). A person's name inside a sentence on the wizard's summary is an inline link and is exempt.

## Not covered here

- **The installed iPhone app.** The D-11 checklist ends with a pass in the installed PWA on a real phone. That is io's UAT inside `edit-flag-flip`; nothing in this task can stand in for it.
- **Tagging.** `photoTagEdit` has its own audit (`tag-edit-e2e`) and its own flip.
- **A live check.** The audit runs on localhost against the committed site. It says nothing about what production serves; check that before a flip ([Turn on editing](../how-to/turn-on-editing.md)).

## Run it again

```sh
(cd islands && npm ci)
(cd islands && PW_PORT=<free port> HFY_AUDIT_SHOTS=<empty dir> npx playwright test tests/edit-d11-audit.spec.mjs)
```

Without `HFY_AUDIT_SHOTS` the spec writes nothing. Upload the screenshots under the task's prefix in the audit bucket for the next flip, and link them here.

## The end-to-end scenarios

The same fake store backs five scenarios, as API requests ([`api/test/edit-e2e.test.js`](../../api/test/edit-e2e.test.js), `cd api && npm test`) and through the real pages ([`islands/tests/edit-e2e.spec.mjs`](../../islands/tests/edit-e2e.spec.mjs)):

1. A member's own nickname saves now, and undo puts it back.
2. A given-name change becomes a suggestion; an admin approves it; the record's bundle shows version +1.
3. A suggestion goes stale when the page moves on; its proposer updates it; an admin approves it.
4. The parents wizard is approved, and the family, both parents and the child each name the link back.
5. A phone number in a note is refused until it is removed, and the refused attempt writes nothing.
