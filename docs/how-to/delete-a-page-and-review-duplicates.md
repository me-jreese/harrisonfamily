# How to delete a page and review possible duplicates

Use this page as an admin to delete a person, family, event, place, source, source citation or photo on the website, and to read the list of people who may be in the tree twice. Both exist because io answered yes to "should admins delete objects on the web" (Q2-15). Merging stays in Gramps on the desktop. For how a delete is checked and stored, see [API: Admin deletes and the possible-duplicate queue](../reference/api.md#admin-deletes-and-the-possible-duplicate-queue).

## Before you start

- **You are an admin.** Your Gramps ID is in the `hfy-admin` group of `config/groups.json`. The server decides this, not the page: a member who calls the route gets `403 not_allowed`.
- **The flag and the switch are on.** The `delete` card and the `possible duplicates` tab need the `adminDelete` flag, and every request needs the `HfyEditing` stack parameter set to `on` ([Turn on editing](turn-on-editing.md)). While the flag is off the routes answer `404` and the page shows nothing. To try it in one tab before it is on for everyone, use the preview override ([Turn a flag on in one browser tab](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab)); the server honours that override only for members of the `uat` group.
- **A recent sign-in.** Deleting needs a sign-in from the last 15 minutes. If yours is older, the sheet says `sign in again` and gives a link; after signing in, open the card again.
- **The budget.** At most 10 records, or 5 % of the live records, can be deleted in any 24 hours. The sheet shows the day's count. Past the limit the delete button is off; delete the rest in Gramps on the desktop, or wait.

## Delete a page

1. Open the page in the editor: `/edit/?cls=person&id=<gramps id>` (or the Family, Event, Place, Source, Citation and Media pages the editor links to). The last card, `delete`, is there for admins only.
2. Choose `delete this person…` (the word follows the kind of page). Nothing is sent to delete yet: the sheet first asks the server what the delete would do.
3. Read the sheet.
   - `will be deleted` lists the page and anything that goes with it. A source takes its source citations. A person or a family takes an event that nothing else uses, and a person takes a family that is left with nobody in it.
   - `will lose a link to it` lists pages that stay but have a link to the deleted page taken out in the same step: the family a person belonged to, an event's place, a photo tag.
   - For a person, `the id … can never be used again` names the Gramps ID that is retired for ever.
4. Choose `delete for good`, or `keep it` to stop. The delete is one step: it all happens or none of it does. It cannot be undone from the website.

**A delete is not a privacy removal.** It tombstones the record, so the page and its links disappear from the site, but the record's earlier versions stay in the change log and the snapshots, and a deleted photo's file stays in storage. To remove something from every cloud copy, that is a separate, audited step (`privacy-expunge`, BRD2 D2-33), not the delete card.

If you press `delete for good` twice, or the answer is lost and you press it again, the second press repeats the first rather than deleting again.

## Read the possible duplicates

1. Open `/me/review/` and choose the `possible duplicates` tab. It lists pairs of people whose names are close (the same surname and given name, a one-letter slip, a nickname that starts the other name) and whose genders and birth years do not rule them out.
2. Open each person's page from the links, and compare.
3. For a pair that is the same person, merge them in Gramps on the desktop and sync. The tab shows pairs and changes nothing: there is no flag to set, no list of dismissed pairs, and the list is worked out again on every visit, so a pair that is not the same person stays on it.

## When it does not work

| What the sheet says | What it means | What to do |
| --- | --- | --- |
| `sign in again to confirm` | Your sign-in is older than 15 minutes. | Follow `sign in`, then open the card again. |
| `too many things were deleted in the last 24 hours…` | The budget is used up. | Use Gramps on the desktop, or wait for the count to fall. |
| `this page changed after you opened it` | Someone saved a change after you opened the editor. | Reload the page, look again, and delete if it is still right. |
| `this would touch too many pages at once` | The delete reaches more than 24 records. | Delete in smaller steps, or use Gramps on the desktop. |
| `some pages still point at this…` | A link exists that the website cannot remove by itself. | Use Gramps on the desktop. |

## Check the result

1. Open `GET /api/records/<Class>/<handle>` as an admin: a deleted record answers `404`.
2. The data site is rendered from the record store, so allow a moment for the page to drop out of the tree.
3. A deleted person's ID stays retired. `GET /api/sync/meta` lists the retired IDs for the desktop, which refuses to reuse them.

## Turn it off

Set `adminDelete` back to `false` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) and deploy ([Turn a feature flag on or off](toggle-a-feature-flag.md)). The card and the tab go away and the routes answer `404` again. Records already deleted stay deleted.
