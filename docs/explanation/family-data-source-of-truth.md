# Where the family data lives

The family's records exist in two places that stay in step: the Gramps tree on io's Mac and the cloud record store behind the website. This page explains why there are two, which one wins for what, and what the website does with the pictures of the tree. For the steps, see [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md). For the codes, see [Sync errors and exit codes](../reference/sync-errors.md).

## The tree is where the research happens

Gramps is the research tool. Everything io knows, including what the site must never show, is in the tree. The tree holds fields that never leave the Mac (the full date of birth, addresses, contact details, objects marked private) next to the fields that go to the site. So the tree stays the source of truth for the research, and the cloud copy is a projection of it.

The projection is redaction policy v1 ([Redaction policy v1](../reference/redaction-policy.md)). It runs on the Mac, before anything is sent, and the server and the renderer check the same rules again. See [The privacy model for family data](family-data-privacy.md#what-the-cloud-never-receives-redaction-v1) for what it removes and why.

## The cloud store is where the website changes

Members can now correct their own page, add a photo, or suggest a change, and an admin approves it. Those changes are written to the cloud record store, an append-only log with a current head for each record. The website never edits the tree. A change made on the website reaches the tree only when io pulls it: the addon shows a preview, io reviews it, and Apply writes it into Gramps in one transaction, after a verified backup.

So the store is the source of truth for what the website has changed or approved, and the tree is the source of truth for what io has researched. Neither side wins by default:

- A field changed on one side only moves to the other.
- A field changed on both sides is a conflict. The command line never decides it. The Gramps window asks io, field by field, and an open conflict holds its path until it is decided.
- A field that never leaves the Mac (the local-only fields) is not in the store, so the website cannot change it, and a pull never overwrites it.

## What the website serves

The site's data files (`person/*.json` and the others) are rendered from the store by one writer, the render Lambda. The old publish from the tree is retired at the cutover, and the bucket policy refuses it, so no second writer can overwrite the render. A change on either side reaches the site only through the store, and the site shows the change after the next render. If the renderer fails, the site stays on the last good render; it is stale, never wrong.

## Identity is permanent

A synced person's Gramps ID is the key to their page, their comments and their sign-in. So it does not change: the addon blocks a renumber, the ID of a deleted or merged person is retired and never reused, and a merge leaves an alias that points the old ID at the survivor. Renumbering in Gramps is the one thing io must not do (see "Never" in the runbook).

## Removing something

Because the store is an append-only log, removing a record from the site (a withdraw) is not the same as removing it from history. A withdraw hides the record at once. The history, the snapshots and the shadow copies are removed by a separate expunge, after a 72-hour grace so that a mistaken mass withdraw can be undone. Point-in-time backups of the table keep older copies for 35 days and cannot be shortened; the privacy text says so. The steps are in [Remove something from the cloud](../how-to/sync-gramps-with-the-website.md#remove-something-from-the-cloud).

## Tree pictures

The family-tree pictures on the old person pages are SVG files that a Graphviz script drew from the tree. They are a legacy feature, and they are not owned by the renderer (the sync design, section 11.5, and decision D2-25).

- **The SVGs are frozen.** They stop changing at the cutover, because the script that makes them belongs to the retired publish.
- **A person created in the cloud has none.** Nothing draws a picture for them, so their page shows the **see in the family tree** link, which opens the `/tree/` page. That page draws the tree from `person/graph.json`, which covers every person, however they were created.
- **They will go.** The task `viz-v2-retire-graphviz` retires the SVGs and the link becomes the only tree entry point.

This is an interim state. Until the SVGs are retired, a page may show an old picture for a person who has changed since the cutover; the link is always current.
