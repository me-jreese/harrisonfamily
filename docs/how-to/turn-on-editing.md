# How to turn on editing

Use this page to switch on web editing and suggested-change review for the family, or to switch it off again. Editing has two layers: the server switch `HfyEditing` on the app stack, which turns the editing routes on, and the site flags `recordEdit`, `proposalReview`, `relationshipWizard` and `photoTagEdit`, which turn the pages on. Each layer is a separate switch with its own approval. For why, see [How editing and suggested changes work](../explanation/editing-and-proposals.md) and [Why releases ship through a pipeline and feature flags](../explanation/release-model.md).

Values in angle brackets are placeholders: `<site>`, `<app-stack>`, `<config-bucket>`, `<gramps-id>`. The forms are listed in [Private data and secrets: Placeholders](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's approval for each production step.** Setting `HfyEditing=on` is a production stack change. Flipping a flag in `11ty/_data/flags.json` is a global flip, which [`AGENTS.md`](../../AGENTS.md) lists as needing io's approval. Ask before each step below that says so.
- **The sync prerequisites are live.** The cloud record store is the source of truth and the site renders from it ([Sync Gramps with the website](sync-gramps-with-the-website.md)). If a desktop export can still overwrite the record prefixes, an approved edit would be lost.
- **The `hfy-api` and site code you need is deployed.** Editing routes ship with the `hfy-api` code zip ([Deploy the app stack](deploy-the-app-stack.md)); the editor, review and relationship wizard islands ship with the site ([Deploy a change to the static site](deploy-a-site-change.md)). Neither workflow does the other's job.
- **At least one approver is named.** The review queue is for admins only. See [Name the approvers](#1-name-the-approvers).
- **The privacy and terms pages are published**, if io has made that a condition of the flip. That is a separate task and is not repeated here.

## Steps

### 1. Name the approvers

Admins are the Gramps IDs in `config/admins.json`. Add io's first, then anyone else io names, following [Make the member an admin](manage-family-access.md#3-optional-make-the-member-an-admin). Check the list:

```sh
aws s3 cp s3://<config-bucket>/config/admins.json - | jq .
```

Without an approver the queue would fill and nobody could decide it.

### 2. Turn the server switch on, with the flags off

Set `HfyEditing=on` as a parameter-only change to `<app-stack>`: create a change set with `--use-previous-template`, `HfyEditing=on` and `UsePreviousValue=true` for every other parameter, review that only the `HFY_EDITING` environment value of the API function changes, and execute it ([Deploy the app stack: Deploy the stack](deploy-the-app-stack.md#4-deploy-the-stack)). The flags stay `false`, so no member sees a change.

Check the routes now answer:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<site>/api/edit/schema/Person    # signed out: 401, not 404
```

`404` means the switch is still off. A signed-in call to `GET /api/me` now reports `editing: true`.

### 3. Try it in one tab

With io, open a signed-in tab on the site and turn the flags on for that tab only ([Turn a flag on in one browser tab](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab)): `?hfy_flags=recordEdit,proposalReview,relationshipWizard`. Then:

1. On your own person page the hero shows `edit my info`; on another page `suggest a change`; for an admin `edit`.
2. Change a nickname on your own page. It saves now (`saved.` with `undo`).
3. Change a surname. The sheet says it goes to review; send it.
4. On your own page, the family section shows `add or fix family connections`, and no other page does. It opens `/edit/family/`. Add a made-up child through `my children` and `send for review`; a member's relationship is always a suggestion. The wizard works only on the signed-in member's own record (any other id gets "this is for your own page"), so this suggestion is against your real page, not a test one. It must never be approved.
5. As an admin, open `/me/review/`, find the suggestions and decide them ([Review suggested changes](review-suggested-changes.md)). `decline` the made-up child, with a reason. Approving it would add a made-up person and a family link to the live tree, and a deletion cannot be undone from the web. Instead of declining, the member who sent it can `withdraw` it from `my suggestions` on the same page.
6. Type a made-up phone number into a note. The editor refuses it and does not repeat it.

Use a test person or a synthetic page for the editor steps, and undo what you change. The wizard step cannot use one: decline or withdraw its suggestion.

### 4. Check the page audits

Before the flip, confirm the editor (`/edit/`), the relationship wizard (`/edit/family/`) and the review page (`/me/review/`) meet the interface checks (16 px inputs, 44 px targets, no horizontal scroll at 375 px wide, and the installed phone app) as recorded in [Editing: the D-11 audit](../reference/editing-d11-audit.md) (the end-to-end editing task, `edit-e2e-core` in the review). That page covers the pages at 375 and 1024 px; the installed phone app stays io's check before the flip. This page does not repeat the checks.

### 5. Flip the flags for everyone, in this order

With io's approval for each, change `11ty/_data/flags.json` and deploy ([Turn a flag on for everyone](toggle-a-feature-flag.md#turn-a-flag-on-for-everyone)):

1. `proposalReview` first: only admins get the tab.
2. `recordEdit` next: everyone gets the editor.
3. `relationshipWizard` third, only while `recordEdit` is on: members get `add or fix family connections` on their own page and the wizard at `/edit/family/`. The wizard has its own page and button, but it needs `recordEdit` too. After a send it links `see what you sent` to `my suggestions` on `/me/review/`, where the member can change or withdraw the suggestion, and that tab shows only with `recordEdit`; without it the member gets "suggestions aren't available yet". Its offer to add a spouse's death year opens the editor at `/edit/`, which also needs `recordEdit`. Its suggestions land in the same queue.
4. `photoTagEdit` separately, with its own approval and its own audit. The design requires `recordEdit` to be live first (BRD2 flag table, `photoTagEdit` row).

### 6. Check it for everyone

Use [Check the result for everyone](toggle-a-feature-flag.md#check-the-result-for-everyone). The `proposalReview`, `recordEdit` and `relationshipWizard` rows name the files and the entry text to expect.

## Turn it off again

Reverse the order:

1. Set the flags back to `false` and deploy (or let the preview override stand for one tab). The pages stop offering editing at once.
2. Set `HfyEditing=off` as a parameter-only change. Every editing route answers `404` again.

Nothing is deleted. Suggestions stay stored and show again when it is switched back on. Changes already saved stay saved; to reverse one, make the opposite change as an admin, or fix it in Gramps. While `authV2` is `true` and the gate is attached, never turn `authV2` off to switch editing off ([Toggle a feature flag](toggle-a-feature-flag.md)).

## If something goes wrong

- **The edit link or the family button is missing.** `GET /api/me` says `editing: false` (the switch is off), or the flag (`recordEdit` or `relationshipWizard`) is off for this tab. The family button shows on the member's own page only.
- **`/edit/family/` says family connections aren't turned on yet.** The flag is on but the API reports `editing: false`: the switch is off.
- **Every editing call is `404`.** `HfyEditing` is `off`, or the deployed `hfy-api` code predates the editing routes.
- **A member's save is `403 not_allowed`.** The field is admin-only, desktop-only or never on the web; look it up in [Field policy](../reference/field-policy.md).
- **An admin cannot see the queue.** They are missing from `config/admins.json`, or the file is unreadable (then nobody is an admin).

## Related pages

- [Family API: Editing API core](../reference/api.md#editing-api-core)
- [Front end: feature flags](../reference/front-end.md#feature-flags)
