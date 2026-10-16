# How editing and suggested changes work

The site lets signed-in family members correct their family tree on the web. A change either saves at once or goes to an admin as a suggestion, depending on what it touches and whose record it is. This page explains why the rules are shaped that way. It is background reading; for the exact table see [Field policy](../reference/field-policy.md), for the routes see [Family API](../reference/api.md#editing-api-core), and to switch the feature on see [Turn on editing](../how-to/turn-on-editing.md).

## The problem the design solves

The tree is kept in Gramps on io's desktop, and it syncs to a cloud record store that the website renders from ([Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md)). Members know things io does not: a corrected birth year, a nickname, a missing photo, a new cousin. Before editing, every correction went through io by text. Two risks stand against simply opening the tree to everyone:

- **Accuracy.** A family tree is shared. One member's idea of a grandparent's name must not silently replace another's.
- **Privacy.** The site publishes years of birth only, and never addresses, phone numbers, e-mail addresses or the day and month of a birth ([The privacy model for family data](family-data-privacy.md)). An editor is a new door through which such details could arrive.

The answer is one pipeline with three outcomes, decided by a table and not by each screen.

## Three outcomes: save now, suggest, refuse

Every change is a list of small operations (the EditOps of [The EditOp engine](../reference/api.md#the-editop-engine)): set this field, add this list entry, remove that one. The server classifies each operation by looking its field up in the [field-policy table](../reference/field-policy.md) and by asking whose record it is:

- **A member's own record.** The member's own person, the facts embedded in it, and the events and notes that only that person uses. Many of these fields save now, because the member is the best authority on them: nickname, gender, a fact or a note, the type of a name, the member's own photos. A given name, a surname and the birth year are the exceptions that go to review, because they are what other people search for.
- **Anyone else's record, and anything shared.** Families, places, sources, citations, repositories and photos are shared even when you reach them from your own page, so a member's change to them is a suggestion. So is a change to a spouse, a child or a parent link, because it changes someone else's page too.
- **Admins** save directly almost everywhere. They are named in `config/admins.json`.
- **Some fields are never changed on the web.** Some are for the desktop only (private flags, the Gramps ID itself), some the server computes (handles, change times, the derived birth and death references), and some must never be in the cloud at all (street addresses, e-mail links), which the table refuses for everyone, admins included.

An unknown field is treated as a suggestion for a member, never as a direct save. That is the safe way to fail: a new Gramps field cannot become directly editable by accident.

A single save can mix outcomes. The server splits it into groups that make sense on their own (a group is closed over its dependencies, so a new child and the family link that holds it never split apart), saves the direct groups and files the rest as one suggestion, in one database transaction. The member sees one summary: for example "2 save now, 1 goes to review".

## Why the privacy guard runs in the edit path

The same guard that checks the sync runs over every submission, before the table decides anything, and again when an admin approves. It looks for contact details and birth days in anything a member typed, including notes and the names of people they add. It answers with the kind of problem and where it is, and never repeats the text it found, so a phone number typed by mistake does not reach a log, a proposal or an error message. Running it again at approval matters because the rules can tighten while a suggestion waits.

## What a suggestion is

A suggestion stores the operations, the version of each record they were written against, a plain-language summary and an optional note. Nothing in the tree changes until an admin approves. Members see their own suggestions, suggestions about their own page and family, and the admins see all; for anyone else a suggestion does not exist (`404`, the same answer as for a made-up id).

Because records keep changing while a suggestion waits, approval does not compare version numbers. It applies the suggestion's operations to the record as it is now (a three-way rebase). If a different field changed in the meantime, the suggestion still applies. If the same field changed, the suggestion becomes `stale`, the proposer is told, and the admin sees the stored, current and proposed values side by side, with the choice to edit and then approve. A stale suggestion stays in the queue, so it can be decided again.

An admin has three decisions: approve, decline with a reason, or ask for changes with a message. Approving one that deletes a record or removes a family link is destructive, and asks for a fresh sign-in within 15 minutes, so a stolen session cannot remove people from the tree. The proposer can amend a suggestion that is waiting, asked about, or out of date, and can withdraw it.

An admin can also delete a person, family, event, place, source, source citation or photo straight from the editor, once the `adminDelete` flag is on (Q2-15). It is not a suggestion and has no second reviewer: the admin sees the whole plan first (what goes, which pages lose a link, the ids retired for ever), signs in again if the sign-in is older than 15 minutes, and is held to a daily limit on deletes. A member cannot do it (`403 not_allowed`); a member's way to ask for a removal is still a suggestion. Merging two people stays in Gramps on the desktop, and the `possible duplicates` tab only lists who to look at. See [Delete a page and review possible duplicates](../how-to/delete-a-page-and-review-duplicates.md).

Approval writes the records, the audit entry and the proposer's credit in one transaction. The proposer is credited when a suggestion is accepted, not when it is sent, so the contributions list rewards correct information and not volume.

## Relationships get their own wizard

Adding a parent, a child or a spouse is the hardest edit in Gramps: it takes a family record with two-sided links, child order and sometimes a new person. So members do not edit families field by field. The relationship wizard, the page `/edit/family/` behind its own flag `relationshipWizard`, asks one question per screen in four flows (my parents, my children, my spouse or partner, and something's wrong), and members open it from `add or fix family connections` on their own page. The member describes an intent ("add this person as my child") and the server compiles the operations ([Relationship compiler](../reference/api.md#relationship-compiler)). The compile reports likely duplicates and asks the member to confirm that a new name is a different person, and it refuses a change that would make someone their own ancestor. Because a relationship touches other people's pages, a member's relationship is always a suggestion.

## Mistakes can be undone

A direct save returns the inverse operations against the new versions, and the editor offers `undo` for ten minutes (the client timer `UNDO_WINDOW_MS` in `islands/src/lib/editor-save.js`). Everything is audited with counts and field names, never values. A deletion cannot be undone from the web, because Gramps IDs are never reused; that is also why a delete is destructive for the step-up rule. A bad approval is corrected with a new change or by io in Gramps.

## Why it ships dark

Editing is behind two layers so it can be installed without being visible. The stack parameter `HfyEditing` switches every editing route on or off on the server. Then the site flags `recordEdit`, `proposalReview` and `relationshipWizard` decide whether the pages offer the editor, the review tab and the relationship wizard. Turning it off again is the reverse, and stored suggestions stay stored. The order, and who must approve each step, is in [Turn on editing](../how-to/turn-on-editing.md); the general reasoning for separate switches is in [Why releases ship through a pipeline and feature flags](release-model.md).

## Related pages

- [Field policy](../reference/field-policy.md)
- [Review suggested changes](../how-to/review-suggested-changes.md)
- [How member content stays accountable](member-content-design.md), for posts and comments, which use the same audit habits.
