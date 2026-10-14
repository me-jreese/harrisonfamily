# How to review suggested changes

Use this page as an admin to decide the suggestions that members send from the editor: approve, decline, ask for changes, or fix a detail and approve. For why changes become suggestions and what each outcome means, see [How editing and suggested changes work](../explanation/editing-and-proposals.md).

## Before you start

- **You are an admin.** Your Gramps ID is in `config/admins.json` ([Add or remove a family member's access](manage-family-access.md)). The server decides this, not the page: a member who opens the queue gets `403 not_admin`.
- **Review is on.** The `to review` tab needs the `proposalReview` flag, and every request needs the `HfyEditing` stack parameter set to `on`. While it is off, the page says suggestions aren't available yet. To try it before it is on for everyone, use the preview override in one tab ([Turn a flag on in one browser tab](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab)).
- **A recent sign-in, for a destructive approval.** Approving a suggestion that deletes a record or removes a parent, child or spouse link asks you to sign in again if your sign-in is older than 15 minutes.

## Open the queue

1. Sign in and open `/me/review/`. The `to review` tab lists suggestions oldest first.
2. Use the filter chips: `waiting` (new ones), `needs changes` (you asked a question), `out of date` (the page changed and the suggestion no longer fits) and `done`.
3. Each row names the proposer, the page it is about, its age, a badge (edit, family connection or new person) and the first line of its summary. Open one to see the detail card.

## Read a suggestion

The card shows before and after for each change, a short sentence list for a family connection, any warnings (a possible duplicate, a conflict, a person who already has birth parents), the proposer's note, and a comment thread that only the proposer, the owners of the targeted pages and admins can see. Read the note and the thread before you decide; a member can answer your question there.

## Decide

- **Approve.** The change is applied to the page as it is now and the proposer is told. A different field that changed in the meantime is not a problem. If you are asked to sign in again, do so and return to the card.
- **Ask for changes.** Write what is missing. The message is required. The suggestion moves to `needs changes` and the proposer is told. They can amend it and send it back to the queue.
- **Decline.** Write a reason, which is required. The proposer sees it, so keep it kind and plain.
- **Edit then approve.** Fix a detail yourself (a misspelled place, a date) in the inline form and approve in one step. The edit travels with the approval, so there is no separate save.

A decision cannot be taken twice. If two admins open the same card, the second to decide sees "this suggestion changed; please look again" with the fresh card, and then decides on what they see.

## When a suggestion is out of date

If an approval meets a change to the same field, the answer is a conflict: the suggestion becomes `out of date`, the proposer is told, and the card shows the stored, current and proposed values. Use `edit then approve` to choose the value, or ask the proposer to update it. A stale suggestion stays in the queue.

If a suggestion no longer passes the privacy check (for example, it contains something that looks like a phone number), the approval is refused with a system reason and the suggestion goes to `needs changes`. The server does not show you the matched text; ask the proposer to remove it.

## Check the result

1. Open the page the suggestion was about and confirm the change shows. The data site is rendered from the record store, so allow a moment for it to catch up.
2. Open `GET /api/proposals/<id>` as an admin, or the card, to see the state `approved`, `declined` or `needs_changes`.

## If something goes wrong

- **The tab is missing.** The `proposalReview` flag is off, or you are not in `config/admins.json`.
- **`404` on every request.** `HfyEditing` is `off`.
- **`401 step_up_required`.** Sign in again; the approval is destructive.
- **`412 precondition_failed`.** Someone changed the suggestion first. Reopen the card.
- **A bad approval.** Make the opposite change as an admin, or fix it in Gramps on the desktop. Deleted records cannot be restored from the web.

## Related pages

- [Family API: The proposal decision](../reference/api.md#the-proposal-decision)
- [Field policy](../reference/field-policy.md)
- [Turn on editing](turn-on-editing.md)
