# How to add or remove a family member's access

Use this page to give a family member access to the site, make them an admin, give them MCP access, remove a lost passkey, sign a member out on every device, or take their access away. Site access comes from one private allowlist file, which the auth edge reads. A second file, the email list, sits beside it as a plain list of members. You edit both files, publish the allowlist, then confirm the change on the auth edge. Admin rights and MCP access come from two more files in the config bucket, which you edit by hand. A third source, DynamoDB grants written by the API, sits beside the file for the auth edge: read [Allowlist grants in DynamoDB](#allowlist-grants-in-dynamodb) before you remove anyone.

For why one allowlist decides membership and why admins and MCP groups are separate lists, see [The identity model](../explanation/identity-model.md). For the file formats, what reads each object and how long each reader caches it, see [Private data and secrets](../reference/private-data-and-secrets.md#access-configuration-in-config-bucketconfig).

Values in angle brackets are placeholders. `<email>` is a member's email address and `<gramps-id>` is their Gramps ID. `<site>` is the site's host name, `<config-bucket>` is the bucket that holds `config/`, and `<app-stack>` is the name of the deployed app stack. `<credential-id>` is a passkey's credential id. The forms are listed in [Private data and secrets: Placeholders](../reference/private-data-and-secrets.md#placeholders). Never put real addresses or Gramps IDs in this repository.

## What you edit

- `userGrampsID.json` maps each email to a Gramps ID. It is the auth edge's allowlist.
- `harrisonfamily-allowlist.json` lists the emails. Nothing reads its contents and nothing publishes it. The publisher only checks that the file exists.
- `config/admins.json` lists the Gramps IDs of site admins. It has no source file. You edit the S3 object.
- `config/groups.json` names the members who get MCP tools, and the `uat` members who may use API routes still behind a flag. No script writes it. You upload it by hand.
- Passkey records in the app stack's table, only to remove a lost passkey for a member who cannot do it themselves.
- Revocation records in the app stack's table, only to sign a member out on every device, for example when a device that is still signed in is lost.
- You never edit `ALLOW#` grant items in the app stack's table by hand. The API writes them; the file publisher never touches them. See [Allowlist grants in DynamoDB](#allowlist-grants-in-dynamodb).

Until 2026-10-14 the publisher also turned the email list into a digest list, `config/allowed_hashes.json`, and a Google copy. The digests' only reader was the legacy Lambda `hfy-check-allowed`, deleted that day (HFY-TSK-326, ruling P2-R48); a request to `/api/check-allowed` now gets `404` from `hfy-api` ([Identity services: Retired legacy sign-in](../reference/identity-services.md#retired-legacy-sign-in)). Under ruling P2-R51 the same day, both steps left the script and the digest list was deleted. The steps below still keep the email list in step with the map, so that it stays a true list of members, but no member's access depends on it.

## Before you start

- **The sign-in the deployed site uses.** Members sign in through the auth edge at `/auth/login`; `/family-login/` redirects there, and the legacy Google sign-in is gone. Run `curl -s https://<site>/_data/flags.json | jq .authV2`: `true` means pages also keep the edge session alive. The production cutover set `authV2` to `true` on 2026-10-12 (HFY-TSK-069, HFY-R67). Never turn `authV2` off to test: while the data gate is attached, that locks every visitor out of the family data once `io_id` lapses (HFY-R67). A signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` prints `401` while the gate is attached and `200` when it is not.
- **io's go-ahead.** Publishing the allowlist or the admin list needs it ([`AGENTS.md`](../../AGENTS.md)). So does a change to `config/groups.json`, and so does any item you write or delete in the app table by hand: an operator's deletion of a member's passkey (`PASSKEY#<credential-id>`), the deletion of a member's link record (`LINK#<email>`), and the revocation records that sign a member out on every device.
- **The private source files.** `userGrampsID.json` and `harrisonfamily-allowlist.json` are in `<project>/docs/dev`. `<project>` is the directory that contains the repository checkout, as defined in [Placeholders](../reference/private-data-and-secrets.md#placeholders). The repo's [`allowlist/`](../../allowlist/) holds sanitized samples of the email array and of the retired digest list (see [`allowlist/README.md`](../../allowlist/README.md)). There is no sample of `userGrampsID.json`. Do not edit the samples, and do not copy the real files into the repo. Edit only the copies in `<project>/docs/dev`. A copy kept only in `workspace-local/` is never published.
- **The publisher.** The script is `<project>/scripts/infra/publish_allowlists.sh`. It is not in this repository. It reads its source files from `docs/dev` two levels above its own location, so run the copy in `<project>`.
- **AWS credentials** with `s3:GetObject`, `s3:PutObject` and `s3:PutObjectAcl` on `<config-bucket>/config/*`. The script uploads with `--acl private`, which needs `s3:PutObjectAcl`, and the checks on this page read with `s3:GetObject`. It uses `AWS_PROFILE` (default `default`) and `AWS_REGION` (default `us-west-2`). The same S3 permissions cover `admins.json` and `groups.json`.
- **No secret and no gcloud login.** Since 2026-10-14 (ruling P2-R51) the script reads nothing from Secrets Manager and calls nothing in Google Cloud.
- **Optional, for the Cognito step:** `cloudformation:DescribeStacks` on `<app-stack>`, and `cognito-idp:AdminGetUser` and `cognito-idp:AdminDisableUser` on its user pool.
- **For a change of Gramps ID or email, or an operator's passkey removal:** `cloudformation:DescribeStacks` on `<app-stack>`, `dynamodb:GetItem` and `dynamodb:DeleteItem` on its table, and `dynamodb:Query` on the table's `GSI1` index.
- **For signing a member out on every device:** `cloudformation:DescribeStacks` on `<app-stack>`, and `dynamodb:Scan`, `dynamodb:GetItem` and `dynamodb:PutItem` on its table.
- **`jq`** on your path.

**Every member needs a Gramps ID.** The auth edge denies an email whose mapping is missing or empty. Edit the two JSON files directly. No generator produces them ([Private data and secrets](../reference/private-data-and-secrets.md#where-the-private-source-copies-live)).

Check the Gramps ID against the member's person record before you publish, because nothing checks that the record exists. A wrong ID signs the member in as someone else, and correcting it after they have signed in through the edge takes the extra steps in [Change a member's record or email](#change-a-members-record-or-email). [The identity model](../explanation/identity-model.md#the-allowlist-is-the-authority) explains why the Gramps ID is the member's identity.

## Add a member

If the email once had an access-request grant that was later revoked, adding it to the files below does not admit it: the revoked `ALLOW#` item wins ([Allowlist grants in DynamoDB](#allowlist-grants-in-dynamodb)). Check for one first when a sign-in is refused after a correct publish.

### 1. Edit the source files

In `<project>/docs/dev`:

- Add `"<email>": "<gramps-id>"` to the object in `userGrampsID.json`.
- Add `"<email>"` to the array in `harrisonfamily-allowlist.json`.

Write the email in lower case in both files, and give it the plain string form in `userGrampsID.json`. The edge needs neither: it ignores case when it matches keys, and it also accepts an object form, `{"gramps_id": ..., "label": ..., "roles": [...]}`. The rule is there for the checks on this page, which compare emails exactly and expect a string value.

Check both files before you publish. The script uploads `userGrampsID.json` without validating it. If that file is malformed, edge instances that already hold a copy keep using the previous list, so the change silently does not apply. Edge instances that start afterwards deny every sign-in.

```sh
cd <project>/docs/dev
jq -e --arg e '<email>' 'has($e) and (.[$e] | type == "string" and length > 0)' userGrampsID.json
jq -e --arg e '<email>' 'any(.[]; . == $e)' harrisonfamily-allowlist.json
jq -r 'keys[] | select(. != ascii_downcase)' userGrampsID.json
```

The first two commands print `true`. The third prints nothing. If `jq` reports a parse error, fix the file before you go on.

### 2. Publish

```sh
cd <project>
bash scripts/infra/publish_allowlists.sh
```

The script does one thing. It stops if either source file is missing, then uploads `userGrampsID.json` to `s3://<config-bucket>/config/userGrampsID.json`, replacing the object, and prints `[DONE] Allowlist published (config/userGrampsID.json, read by the auth edge).` It reads nothing from `harrisonfamily-allowlist.json`. The local file is the source of truth: each run overwrites the S3 object with it.

If the upload fails, the S3 object is unchanged and the edge keeps the previous mapping. Fix the cause and run the script again. A re-run is safe.

The script reads four environment overrides: `AWS_PROFILE`, `AWS_REGION`, and the bucket and object key, `HFY_CONFIG_BUCKET` and `HFY_USER_GRAMPS_KEY`. Their defaults are listed under [`publish_allowlists.sh`](../reference/private-data-and-secrets.md#publish_allowlistssh). Set the bucket or the key only if the resolver in [`auth/edge.manifest.json`](../../auth/edge.manifest.json) was configured differently.

There is no step for the digest list, the Google copy or `hfy-check-allowed` any more. All three were retired on 2026-10-14: the digest and Google steps left the script under ruling P2-R51, and the function was deleted (HFY-TSK-326).

### 3. Optional: make the member an admin

Admins can delete any comment or post on the site. The admin list holds Gramps IDs, not emails, and the publisher does not touch it. The object may be absent, which means there are no moderators. The list does not grant moderation through MCP: a delete from an MCP client needs `hfy-admin` in `groups.json` instead ([Give a member MCP access](#give-a-member-mcp-access)). Edit a copy outside the repository, check it, and upload it:

```sh
aws s3 cp s3://<config-bucket>/config/admins.json admins.json   # if the object does not exist yet: echo '[]' > admins.json
jq --arg g '<gramps-id>' \
  'if type == "array" then (. + [$g] | unique) else .admins = ((.admins // []) + [$g] | unique) end' \
  admins.json > admins.new.json
jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) != null' admins.new.json \
  && aws s3 cp admins.new.json s3://<config-bucket>/config/admins.json --content-type application/json
rm admins.json admins.new.json
```

The check prints `true` before the upload runs. If it prints `false` or a parse error, nothing is uploaded. Fix the copy and try again. The file may be an array or `{"admins": [...]}`, and the filter keeps whichever form it finds. If the object cannot be read or parsed, nobody is an admin. An admin entry does nothing without an allowlist entry.

## Verify an addition

1. **The S3 copy holds the member.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' '.[$e]'
   ```

   It prints `"<gramps-id>"`.

2. **The auth edge admits them.** Wait up to 300 s for edge instances to drop their cached copy. Have the member sign in with Google at `https://<site>/auth/login`, and then open `https://<site>/auth/session` in the same browser. It returns:

   ```json
   {"authenticated": true, "sub": "<gramps-id>", "grampsId": "<gramps-id>", "label": "<email>", "exp": <epoch-seconds>}
   ```

   `exp` is when the session token expires, in epoch seconds, an hour after it was issued. For a plain string entry, `label` is the member's email. The label stays in the session: posts, comments and push notifications never show it. They name the member by the `displayName` in their person record, or by the Gramps ID when there is none (HFY-R68).

   Use Google for this check. A new member has no password yet: the user pool takes no self-service sign-up, and the edge creates the member's Cognito account only when they set a password at `https://<site>/auth/link` after a Google sign-in ([Identity services](../reference/identity-services.md#cognito-user-pool)). To check the password path too, have the member set one there, sign out, and sign in again at `/auth/login` with the email and password.

3. **The site links the member to their own record.** In that browser, open `https://<site>/`. The account button at the top of the page opens a menu whose link to the member's own page points to `/person/?id=<gramps-id>`. On a site with `shellV2` off, the navigation's my-record link points there instead. If `authV2` is off on the deployed site, open `https://<site>/?hfy_flags=authV2` for this check, and `https://<site>/?hfy_flags=` afterwards to clear the override.

4. **Admin only: the member has admin rights.** The S3 object lists the ID at once:

   ```sh
   aws s3 cp s3://<config-bucket>/config/admins.json - \
     | jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) != null'
   ```

   It prints `true`. The API caches the list for 60 s, so wait a minute before you check the API. Then, in the member's browser, signed in through the edge, open the network panel. A `GET /api/comments?subject=...` response carries `can.delete: true` on another member's comment, and a `GET /api/posts` or `GET /api/posts/<id>` response carries `can.delete: true` on another member's post. `GET /api/posts` also lists other members' drafts.

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

## Give a member MCP access

An MCP client, such as Claude, acts on the site as the member who connects it. The allowlist decides whether the member can connect at all. `config/groups.json` decides which tools the server lists for them. It has two groups ([MCP server: Groups](../reference/mcp-server.md#groups)):

- **`mcp-authors`** gets the three read tools and the two create tools. Name the member by Gramps ID in `subjects`, or by email in `emails`. An `emails` entry matches only the verified `email` claim in the member's access token, which is the address they signed in with. A `subjects` entry works whichever address they use.
- **`hfy-admin`** gets the same five tools and the two delete tools. It takes `subjects` only, and an email there does nothing. A delete also needs a recent sign-in with a passkey that verified the member ([Connect an MCP client](connect-an-mcp-client.md#before-you-start)).

`config/admins.json` plays no part here, and a member in neither group can connect but sees no tools.

1. **Start from a copy that matches the live object.** Edit your private source copy of `groups.json`, kept outside the repository. The upload replaces the live object, so first check that your copy matches it. This prints nothing when they match:

   ```sh
   diff <(aws s3 cp s3://<config-bucket>/config/groups.json - | jq -S .) <(jq -S . groups.json)
   ```

   If you have no copy, download the live object as one: `aws s3 cp s3://<config-bucket>/config/groups.json groups.json`. If the object does not exist yet, start from this shape:

   ```json
   {
     "version": 1,
     "groups": {
       "mcp-authors": { "emails": [], "subjects": [] },
       "hfy-admin": { "subjects": [] }
     }
   }
   ```

2. **Add the member.** Put `"<gramps-id>"` in the `subjects` of `mcp-authors`, or `"<email>"` in its `emails`. For deletes, put `"<gramps-id>"` in the `subjects` of `hfy-admin` too. To take MCP access away, remove the same entries.

3. **Validate the file.** A file that is not valid JSON takes every member's tools away within a minute, because the server then grants no groups to anyone.

   ```sh
   jq -e '(.groups | type == "object") and ([.groups["mcp-authors"].subjects, .groups["mcp-authors"].emails, .groups["hfy-admin"].subjects]
     | all(. == null or (type == "array" and all(type == "string"))))' groups.json
   jq -c --arg g '<gramps-id>' --arg e '<email>' '.groups as $G | {
     author: ((($G["mcp-authors"].subjects // []) | index($g) != null)
              or (($G["mcp-authors"].emails // []) | map(ascii_downcase) | index($e | ascii_downcase) != null)),
     admin: (($G["hfy-admin"].subjects // []) | index($g) != null)}' groups.json
   ```

   The first command prints `true`. If it prints `false` or an error, fix the file. The second prints the member's groups, for example `{"author":true,"admin":false}`.

4. **Upload it.** There is no publisher script:

   ```sh
   aws s3 cp groups.json s3://<config-bucket>/config/groups.json
   ```

   Each API container keeps the file for 60 s, so the change takes effect within a minute. Removing a member from the groups takes their tools away within that minute, even while their access token is still valid.

**Verify.** Have the member list the server's tools in their client, as in [Connect an MCP client: Check what you can do](connect-an-mcp-client.md#2-check-what-you-can-do). In `mcp-authors` they see five tools. In `hfy-admin` they also see `hfy_posts_delete` and `hfy_comments_delete`, disabled with `step_up_required` until a fresh passkey sign-in. If the member is in neither group, the list is empty. If the client still shows an old list, have the member reconnect it.

## Give a member UAT access to flagged API routes

The `uat` group of `config/groups.json` names the members who test new features on the live site before their flag is turned on for everyone. A route behind a flag answers `404` to everyone else ([API: Feature gate](../reference/api.md#feature-gate)). The group takes `subjects` (Gramps IDs) only, grants no MCP tool, and needs io's go-ahead like any other change to the file.

1. **Start from a copy that matches the live object**, as in [step 1 of Give a member MCP access](#give-a-member-mcp-access). Keep a backup of the live object outside the repository before you change it. If the file has no `uat` group, add `"uat": { "subjects": [] }` under `groups`.
2. **Add the member.** Put `"<gramps-id>"` in the `subjects` of `uat`. To end their access, remove it.
3. **Validate the file.** A file that is not valid JSON makes nobody `uat`, and also takes every member's MCP tools away.

   ```sh
   jq -e '(.groups | type == "object") and ((.groups.uat.subjects // []) | type == "array" and all(type == "string"))' groups.json
   jq --arg g '<gramps-id>' '(.groups.uat.subjects // []) | index($g) != null' groups.json
   ```

   Both print `true`.

4. **Upload it**, as in [step 4 of Give a member MCP access](#give-a-member-mcp-access). Each API container keeps the file for 60 s.

**Verify.** Once an API route sits behind a flag that is off, that member gets an answer from it within a minute, while a member outside the group still gets `404`.

## Allowlist grants in DynamoDB

Since HFY-TSK-134, the auth edge reads approved access from two places: io's S3 file, `userGrampsID.json`, and `ALLOW#<email>` items in the app stack's table. The items are written only by `hfy-api`, through the audited grant and revoke transactions in [`api/src/allowlist-store.js`](../../api/src/allowlist-store.js), which the access-request admin routes use. The access-request admin routes write them ([Approve a request](#approve-a-request)); a table with no `ALLOW#` item behaves exactly like the file alone.

**The file publisher never touches them.** `publish_allowlists.sh` overwrites one S3 object, `config/userGrampsID.json`, and nothing else. Republishing the file therefore cannot create, change or delete a grant, and a grant survives every republish. The reverse also holds: editing the file does not change an email that has an `ALLOW#` item.

**Precedence: the DynamoDB item wins, active or revoked.**

| `ALLOW#<email>` item | Email in `userGrampsID.json` | The edge decides |
| --- | --- | --- |
| `active` | yes or no | Admit, as the item's `sub`. The item's Gramps ID beats the file's. |
| `revoked` | yes | **Deny.** A revoked item beats the file. |
| `revoked` | no | Deny. |
| none | yes | Admit, as the file says. |
| none | no | Deny. |
| The table cannot be read | yes | Admit, as the file says. |
| The table cannot be read | no | Deny. |

The same rule decides the MCP groups, per Gramps ID: a member is one with an active item, or one the file lists under an email that has no item. A `revoked` item removes only its own email.

What follows from it:

- **Removing an email from the file does not remove a grant.** If the member has an active `ALLOW#` item, they still sign in after you publish the file without them. Revoke the grant too: for a grant that came from an access request, use [Remove access granted through a request](#remove-access-granted-through-a-request).
- **A second email is held, not refused.** An item with an `effectiveAt` in the future is not active yet: the edge denies the address, as it denies a revoked one, and admits it from `effectiveAt` on ([Approve a request](#approve-a-request)). The member's confirmation removes `effectiveAt`. A held item also needs `noticedAt`, stamped when the member's notice was delivered; without it the address stays denied however late it is.
- **A revoked item outlives the file.** Adding the email back to the file does not restore access while a `revoked` item exists. Grant the email again through the API (a grant over a revoked item is allowed), or have io delete the revoked item.
- **Revocation by DynamoDB works on an email that is still in the file.** That is how an approved request is withdrawn without touching io's files.
- **Timing.** The edge reads the item on every lookup with a strongly consistent `GetItem` and does not cache it, so the next sign-in, passkey sign-in, password set or refresh sees a grant or a revoke at once. The S3 file keeps its 300 s cache. The MCP groups find items through the `GSI1` index, which cannot be read consistently, and cache each Gramps ID's items for 60 s. A grant or revoke therefore reaches the groups up to about a minute (plus index lag) after it reaches sign-in. That gap is accepted. A session already issued keeps working until its `io_id` expires, up to 1 h, and its next refresh is refused.
- **A DynamoDB outage does not lock members out, and does not honor a revoke.** While the table cannot be read, the file decides, so an email that is revoked in DynamoDB and still listed in the file signs in, and joins its MCP groups, until the table is readable again. To close the gap for a revoked member, also remove their email from the file ([Remove a member](#remove-a-member)). The edge logs `allowlist table unavailable (the S3 file decides)` for each fallback, with the error name and no address, so an outage is visible in the logs.
- **An active item replaces the file's entry for its email.** The principal is built from the item alone: the member role, no extra roles and no label from the file. If the file lists the same email with another Gramps ID or extra roles (`editors`, for example), they are not merged, and the item's Gramps ID is the one used for sign-in and for the MCP groups. Before you grant an email that the file already lists, check that the Gramps IDs match and that no extra role is needed. The roles the groups take from the file are lost for that email.
- **Assumption: an item carries the same Gramps ID as the file.** The MCP groups look items up by the caller's Gramps ID, so a `revoked` item whose Gramps ID differs from the one the file lists for that email denies sign-in for the email but does not remove the file's Gramps ID from the MCP groups. The grant and revoke transactions write the member's own Gramps ID, so the two agree unless someone edits the file's mapping afterwards. If you change the mapping for an email that has an item, revoke and grant the email again, so that item and file agree.

**Check one email.** This reads the item and prints nothing when there is none. It needs `dynamodb:GetItem` on the table and `cloudformation:DescribeStacks` on `<app-stack>`, and it changes nothing:

```sh
TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
aws dynamodb get-item --table-name "$TABLE" --region us-west-2 --consistent-read \
  --key '{"PK":{"S":"ALLOW#<email>"},"SK":{"S":"META"}}' \
  --query 'Item.{state:state.S,sub:sub.S,source:source.S,at:at.S}'
```

`state` is `active` or `revoked`, `source` is `access-request`, `admin` or `import`. Do not write or delete an `ALLOW#` item by hand without io's go-ahead: a hand write skips the condition and the audit item that the API's transaction adds (`AUDIT#allow:<hash>`, which holds the Gramps ID and a hash of the address, never the address).

**Check the first deploy against the real table.** The unit tests run against a fake table, which does not model the real `GSI1` key schema or the grant condition `attribute_not_exists(PK) OR #state = :revoked`. When the release that carries the allowlist (RG-3) executes, io checks both on the deployed table and records the result in the task's worklog:

1. An existing member still signs in with no `ALLOW#` item in the table (the zero-item case above).
2. Querying `GSI1` with `GSI1PK = ALLOWSUB#<id>` returns an item written through the grant transaction. This needs a test grant, which only io writes, and is removed afterwards with a revoke.
3. A second grant of an active email is refused, and a grant over a revoked one is accepted.

## Approve a request

Access requests arrive from the public `/join/` page, and an admin decides them in the admin API (`/api/access-requests`, behind the `accessRequests` flag, which is off until io turns it on). The list and the detail show the requester's answers and the Gramps preview of the person, but the requester's email only as its first character plus the domain, and there is no way to copy it. Every message to the requester is a fixed template; the one thing you write is the optional decline note.

Before you approve, **confirm with the person outside the site** (a phone call, in person) that this request is theirs. The API asks you to say so: `confirmedOutside: true` is required for `link`, `new` and `revoke`, and it is written to the audit. `link`, `new` and `revoke` also need a sign-in at most 15 minutes old (`401 step_up_required` otherwise), so sign in again first.

Choose one decision for a pending request:

| Decision | Use it when | What happens |
| --- | --- | --- |
| `link` | The person already has a page, and is living. | One transaction writes their `ALLOW#` grant, moves the request to `active` and adds two audit items. The requester is emailed "you're in". `422 not_living` if the page says the person is not living or the record store holds a death event; `422 unknown_person` if the site has no such person. |
| `new` | The person is not in the tree yet. | The request becomes `awaiting_record` and a `person.create` proposal is filed as the site. When an admin approves that proposal, the approval mints the Gramps ID (Q2-03) and links the request in the same transaction. Under the other ID policy, the desktop assigns the ID later and the link follows it; until either happens you can `link` the awaiting request by hand. |
| `decline` | You will not add them. | The request becomes `declined`, kept 30 days. The requester is emailed; the note goes in the mail only if you set `sendNote`. The note is scanned for contact details first. |

If the mail cannot be sent, the decision still stands and the answer says `emailSent: false`: tell the person yourself.

A `link` for a person who **already signs in with another address** is refused with `409 second_email`. Only the owner of the family tree (the `gramps-owner` group) may retry it with `allowSecondEmail: true` (`403 owner_only` for any other admin). The new address is then held for 72 hours: the member gets an inbox item and an email at every address they already use, and the requester is told the date they can sign in. The address counts after the 72 hours, at once if the member confirms, and never if the member objects. The member answers through the API, which works even if the `accessRequests` flag is turned off: `GET /api/second-email` lists their open holds with the request id (the inbox item carries the same id), and `POST /api/second-email/<id>` confirms or objects. No site screen calls these routes yet, so call the member as well, and if they did not ask for the address, revoke the request yourself ([Remove access granted through a request](#remove-access-granted-through-a-request)). The 72 hours start when the notice is delivered. If neither the inbox item nor any mail got through, the answer says `memberNotified: false`, the address stays closed, and the owner re-sends the notice with `POST /api/access-requests/<id>/resend-notice`; tell the member yourself as well. No timer runs: the sign-in and the MCP groups compare the clock with the grant's `effectiveAt`.

**Verify.** Open the request again: its `state` is the one you chose and `decision` holds who decided and when. A `link` shows in [Verify an addition](#verify-an-addition) like any grant.

## Remove access granted through a request

Revoke the request, not the file: `POST /api/access-requests/<id>/revoke` with the request's current `version`, `confirmedOutside: true` and an optional `reason`. It needs a sign-in at most 15 minutes old. One transaction sets the `ALLOW#` item and the request to `revoked`, adds the audits and lets the address ask again. Nobody is emailed. The request must still exist: it is deleted 30 days after the decision, and then this route answers `404` (an open issue for io; for older access ask io to revoke the `ALLOW#` item). Access ends at the next sign-in or refresh: an `io_id` already issued lives out its hour. If io's file also lists the address, the revoked item still wins.

## Remove a member

First check whether the email has an `ALLOW#` grant, as in [Allowlist grants in DynamoDB](#allowlist-grants-in-dynamodb). A file edit removes only what the file granted. If the check prints `"state": "active"`, the member keeps access until that grant is revoked.

1. In `<project>/docs/dev`, delete the member's key from `userGrampsID.json` and the email from `harrisonfamily-allowlist.json`. Check both:

   ```sh
   jq --arg e '<email>' 'has($e)' userGrampsID.json
   jq --arg e '<email>' 'any(.[]; . == $e)' harrisonfamily-allowlist.json
   ```

   Both print `false`.

2. Run the publisher from `<project>`, as in [step 2](#2-publish).
3. If the member is an admin, remove their Gramps ID from the admin list. The check prints `true` before the upload runs:

   ```sh
   aws s3 cp s3://<config-bucket>/config/admins.json admins.json
   jq --arg g '<gramps-id>' \
     'if type == "array" then map(select(. != $g)) else .admins |= map(select(. != $g)) end' \
     admins.json > admins.new.json
   jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) == null' admins.new.json \
     && aws s3 cp admins.new.json s3://<config-bucket>/config/admins.json --content-type application/json
   rm admins.json admins.new.json
   ```

4. If the member is in `groups.json`, remove their Gramps ID and email from it, `uat` included, and upload it, as in [Give a member MCP access](#give-a-member-mcp-access). Their MCP client loses its tools within 60 s.
5. Optional: disable the member's Cognito user, if one exists. A pool user exists only if the member set a password at `/auth/link`, or signed up before the pool was locked down. Disabling it blocks only the email-and-password method, and a removed member cannot set a new password, because `/auth/link` checks the allowlist first. Google sign-in never touches Cognito, so the allowlist removal is what denies access. The user pool's region is the part of `<user-pool-id>` before the `_`.

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
   aws cognito-idp admin-get-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   aws cognito-idp admin-disable-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   ```

   If `admin-get-user` reports `UserNotFoundException`, there is nothing to disable.

New sign-ins, passkeys included, are refused with `403` within 300 s, once the edge's cached allowlist expires. Wait that long before you test the edge. The member's current `io_id` and any MCP access token keep working until they expire, up to 1 h after issue, and their next refresh is refused. If an hour is too long, [rotate the session signing key](rotate-the-session-signing-key.md), with io's go-ahead. [The identity model](../explanation/identity-model.md#what-removal-does-and-does-not-do) explains the timing for each kind of access.

The member's comments and posts stay. They remain attributed to the Gramps ID. The edge also keeps the member's link record and passkeys. If you add them back with the same Gramps ID, their passkeys work again. If you later add the same email back under a different Gramps ID, remove the link record first, as in [Change a member's record or email](#change-a-members-record-or-email).

### Verify a removal

1. **The S3 copy no longer holds the member.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' 'has($e)'
   ```

   It prints `false`.

2. **No active grant remains.** The check in [Allowlist grants in DynamoDB](#allowlist-grants-in-dynamodb) prints nothing, or `"state": "revoked"`. An `active` state means the edge still admits the email whatever the file says.

3. **A fresh edge sign-in is denied.** After 300 s, sign in with Google at `https://<site>/auth/login` in a private window with the removed account. In the network panel, `POST /auth/google` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`, and no session starts. The page shows the `denied_body` text from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json) as a neutral notice, not as an error: the message carries `data-detail="not_allowlisted"`, set by `allowlistNotice` in [`auth/src/edge.js`](../../auth/src/edge.js).

4. **A passkey sign-in is refused.** If the member added a passkey and can try it, have them use the passkey button (the manifest's `passkey_button` text) at `https://<site>/auth/login` after 300 s. The page shows the same notice, `POST /auth/passkey/login/verify` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`, and no session starts.

5. **Admin only: the ID left the admin list.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/admins.json - \
     | jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) == null'
   ```

   It prints `true`. While the member's existing edge session lasts, the API stops returning `can.delete: true` on other members' comments and posts within 60 s.

6. **MCP only: the member left the groups.** Run the second check from [Give a member MCP access](#give-a-member-mcp-access) step 3 against the live object:

   ```sh
   aws s3 cp s3://<config-bucket>/config/groups.json - | jq -c --arg g '<gramps-id>' --arg e '<email>' '.groups as $G | {
     author: ((($G["mcp-authors"].subjects // []) | index($g) != null)
              or (($G["mcp-authors"].emails // []) | map(ascii_downcase) | index($e | ascii_downcase) != null)),
     admin: (($G["hfy-admin"].subjects // []) | index($g) != null)}'
   ```

   It prints `{"author":false,"admin":false}`.

## Remove a lost passkey

Remove a passkey when the device that holds it is lost, sold or replaced.

Removing the passkey does not sign out a browser that is still signed in on that device. That browser's refresh cookie, `io_rt`, keeps its session alive: under `authV2` the site renews it silently, and each renewal restarts its 30 days. The same cookie also lets that browser add a passkey of its own, because the passkey routes accept it as the session. So if the device may be in someone else's hands, first [sign the member out on every device](#sign-a-member-out-on-every-device), then remove the lost passkey as below, and remove any passkey that was added after the device was lost.

### The member removes it

1. Sign in at `https://<site>/auth/login` another way: with Google, with email and password, or with a passkey on another device.
2. Open `https://<site>/auth/passkeys`. It redirects to the account page, `/auth/link`.
3. In the passkey section, headed with the manifest's `passkey_manage` text, choose the `passkey_remove` button next to the lost passkey. The section's text comes from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json). Each passkey is named after the platform the browser reported when it was added, or `This device`, so two passkeys can share a name. If the member cannot tell which one is lost, they can remove all of them and add one again with the `passkey_add` button on the device they still have.

### An operator removes it

Do this only when the member cannot sign in another way, and only with io's go-ahead.

1. Find the table from the app stack's `TableName` output:

   ```sh
   TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
   ```

2. List the member's passkeys through `GSI1`:

   ```sh
   aws dynamodb query --table-name "$TABLE" --region us-west-2 --index-name GSI1 \
     --key-condition-expression 'GSI1PK = :p' \
     --expression-attribute-values '{":p":{"S":"PASSKEYSUB#<gramps-id>"}}' \
     --query 'Items[].[rec.M.credentialId.S, rec.M.label.S, rec.M.createdAt.N, rec.M.lastUsedAt.N]' --output text
   ```

   Each line is one passkey: its credential id, its name (`None` if it has none), and when it was added and last used, in epoch milliseconds. Ask the member which device and when, and match the line.

3. Delete that passkey's item:

   ```sh
   aws dynamodb delete-item --table-name "$TABLE" --region us-west-2 \
     --key '{"PK":{"S":"PASSKEY#<credential-id>"},"SK":{"S":"META"}}'
   ```

   Run the query again. The line is gone.

Either way, the passkey can no longer start a session: a sign-in with it is refused with `401`. Removing it does not end a session already open, including one on the lost device. To end that one, [sign the member out on every device](#sign-a-member-out-on-every-device). [Identity services: Passkeys](../reference/identity-services.md#passkeys) lists the passkey routes and records.

## Sign a member out on every device

Use this when a member stays a member but a device that is signed in as them must stop working, for example a lost or stolen phone. The member has no "sign out everywhere" button, and `/auth/logout` ends only the session of the browser that calls it. Removing the member from the allowlist would work, but locks them out too.

The procedure revokes every live refresh family of the member, the chain of refresh tokens that each sign-in starts, by writing the same `FAMILY#<family>` record that the auth edge writes when it revokes one ([Identity services: Stored records](../reference/identity-services.md#stored-records)). Every device then fails its next refresh with `401 AUTH_REFRESH_FAILED`, which clears both cookies, and must sign in again. That includes the member's own devices: a refresh record does not say which browser holds it, so you revoke them all. The record stops the refresh cookie, not the `io_id` that a device already holds, which keeps working at the API and the data gate until it expires, up to 1 h after it was issued. Step 4 ends it sooner.

This writes to the app table by hand, so it needs io's go-ahead. Run it from one shell.

1. Find the table and set the member:

   ```sh
   TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
   GID='<gramps-id>'
   ```

2. List the member's live site sessions. A live family has exactly one refresh record that is neither rotated nor expired. The function prints one line per family: its random ID, the sign-in method that started it, and the sign-in time in epoch seconds (`0` or empty when the session began before the edge recorded sign-in times). The scan reads the whole table, and prints no token, email or member data.

   ```sh
   live_families() {
     aws dynamodb scan --table-name "$TABLE" --region us-west-2 \
       --filter-expression 'begins_with(PK, :p) AND #r.#hs = :s AND attribute_not_exists(#r.#rot) AND #r.#exp > :now' \
       --expression-attribute-names '{"#r":"rec","#hs":"hostSub","#rot":"rotated","#exp":"expiresAt"}' \
       --expression-attribute-values "$(jq -nc --arg s "$GID" --arg now "$(( $(date +%s) * 1000 ))" \
         '{":p":{S:"REFRESH#"},":s":{S:$s},":now":{N:$now}}')" \
       --query 'Items[].[rec.M.family.S, rec.M.provider.M.kind.S, rec.M.authTime.N]' --output json \
       | jq -r '.[] | @tsv'
   }
   live_families
   ```

   No output means the member has no live session to revoke. A browser with no edge session is not listed, and it reads nothing: the data gate, on every behavior where it is attached, accepts only `io_id`, and no code checks any other token ([Identity services: Retired legacy sign-in](../reference/identity-services.md#retired-legacy-sign-in)).

3. Revoke each family. The record expires through the table's `ttl` 32 days from now, after the longest refresh token it could stop:

   ```sh
   TTL=$(( $(date +%s) + 32 * 86400 ))
   live_families | cut -f1 | while read -r FAM; do
     aws dynamodb put-item --table-name "$TABLE" --region us-west-2 \
       --item "$(jq -nc --arg f "$FAM" --arg t "$TTL" '{PK:{S:("FAMILY#" + $f)},SK:{S:"META"},revoked:{BOOL:true},ttl:{N:$t}}')" \
       && echo "revoked $FAM"
   done
   ```

   It prints one `revoked <family>` line per family that step 2 listed. Writing a record again only moves its expiry later, so the step is safe to repeat.

4. If the device may be in someone else's hands, also [rotate the session signing key](rotate-the-session-signing-key.md), with io's go-ahead. Until the `io_id` the device holds expires, up to an hour, it still reads the family data and opens the account page at `/auth/link`, where it could set a password for a member who has none. Rotation ends that `io_id` within minutes. Under `authV2` the other members' pages refresh silently under the new key, and this member's devices cannot, because their families are revoked. Afterwards, have the member open `https://<site>/auth/passkeys` and check the sign-in methods and passkeys listed there. Remove any passkey they did not add, as in [Remove a lost passkey](#remove-a-lost-passkey). If a password is linked that they did not set, disable their Cognito user as in step 5 of [Remove a member](#remove-a-member), which blocks only the password method.

5. Optional: an MCP connection's refresh token is held by the MCP client, which for the default callbacks in `McpRedirectUris` is Claude's service, not the device. To end the member's MCP connections too, revoke the member's MCP refresh families the same way. The member then connects each client again ([Connect an MCP client](connect-an-mcp-client.md)).

   ```sh
   TTL=$(( $(date +%s) + 30 * 86400 + 3600 ))
   aws dynamodb scan --table-name "$TABLE" --region us-west-2 \
     --filter-expression 'begins_with(PK, :p) AND #s = :s AND #exp > :now' \
     --expression-attribute-names '{"#s":"sub","#exp":"expiresAt"}' \
     --expression-attribute-values "$(jq -nc --arg s "$GID" --arg now "$(( $(date +%s) * 1000 ))" \
       '{":p":{S:"MCPRT#"},":s":{S:$s},":now":{N:$now}}')" \
     --query 'Items[].family.S' --output json | jq -r '.[]' \
     | while read -r FAM; do
         aws dynamodb put-item --table-name "$TABLE" --region us-west-2 \
           --item "$(jq -nc --arg f "$FAM" --arg t "$TTL" '{PK:{S:("MCPFAM#" + $f)},SK:{S:"META"},revoked:{BOOL:true},ttl:{N:$t}}')" \
           && echo "revoked MCP $FAM"
       done
   ```

   The client's next token refresh fails with `invalid_grant`, "refresh token revoked or expired". Its current access token works at `/mcp` until it expires, up to 1 h after issue, unless step 4 rotated the key.

**Verify.**

1. Every family that step 2 listed has its record. Run this straight after step 3, before the member signs in again, because a new sign-in starts a family that step 3 did not revoke:

   ```sh
   live_families | cut -f1 | while read -r FAM; do
     aws dynamodb get-item --table-name "$TABLE" --region us-west-2 \
       --key "$(jq -nc --arg f "$FAM" '{PK:{S:("FAMILY#" + $f)},SK:{S:"META"}}')" \
       --query 'Item.revoked.BOOL' --output text
   done | sort -u
   ```

   It prints `True`, the AWS CLI's text form of the boolean. `None` for any family means its record is missing: run step 3 again. The refresh records themselves do not change, so `live_families` still lists the same families until they expire.
2. A device that was signed in before step 3 can no longer refresh. On a device the member still holds, open the DevTools console on any page of `https://<site>` and run:

   ```js
   fetch("/auth/refresh", { method: "POST", headers: { "X-Requested-With": "io-kit" } }).then((r) => r.status)
   ```

   It prints `401`, and the edge clears that browser's cookies. The member signs in again at `https://<site>/auth/login`, which starts a new family that is not revoked. Under `authV2` the member does not need the console: once the current `io_id` expires, or straight away if you rotated the key, the next page that needs the session shows `POST /auth/refresh` answering `401` in DevTools > Network and goes to `/auth/login`.

## Change a member's record or email

### A different Gramps ID for the same email

The edge records each email's Gramps ID the first time the member signs in, in a link record (`LINK#<email>`) in the app stack's table. It never re-points that record. After you change the mapping, every Google or password sign-in by that member is refused with `403 link_conflict` until you delete the record. Passkeys fail differently: see **Passkeys stay under the old ID** below.

1. Change the value in `userGrampsID.json`, and check the file as in [step 1](#1-edit-the-source-files).
2. Publish, as in [step 2](#2-publish).
3. If the member is an admin, replace the old ID in `admins.json`: run the removal filter from [Remove a member](#remove-a-member) step 3 with the old ID, then the filter from [step 3](#3-optional-make-the-member-an-admin) with the new ID.
4. If the member is in `groups.json` by Gramps ID, replace the old ID with the new one in every `subjects` list, as in [Give a member MCP access](#give-a-member-mcp-access).
5. Wait 300 s, so that no edge instance still maps the email to the old ID. A sign-in in that window would write the old link again.
6. Look up the link record. Write `<email>` in lower case, as the edge stores it:

   ```sh
   TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
   aws dynamodb get-item --table-name "$TABLE" --region us-west-2 \
     --key '{"PK":{"S":"LINK#<email>"},"SK":{"S":"META"}}' --query 'Item.sub.S' --output text
   ```

   It prints the old Gramps ID. If it prints `None`, the member has never signed in through the edge, so there is nothing to delete. Skip the next step.

7. Delete the record, with io's go-ahead:

   ```sh
   aws dynamodb delete-item --table-name "$TABLE" --region us-west-2 \
     --key '{"PK":{"S":"LINK#<email>"},"SK":{"S":"META"}}'
   ```

The member's current edge session keeps the old ID until it next refreshes or expires. Under `authV2`, the site refreshes it when `io_id` nears expiry. That refresh is refused with `principal_changed`, which revokes the session's refresh family, and the member signs in again under the new ID. Where `authV2` is off, the session keeps the old ID until its `io_id` cookie expires, up to 1 h after issue. A new sign-in replaces it sooner. An MCP client's next refresh is refused, because the old ID is no longer on the allowlist, so the member connects the client again. Content they wrote stays under the old ID.

**Passkeys stay under the old ID.** Each passkey belongs to the Gramps ID it was added under. After the change, a sign-in with one is refused with `403 principal_changed`. The account page lists passkeys by the new ID, so it does not show the old ones, and the member cannot remove them there. The member can remove them at `https://<site>/auth/passkeys` before you change the mapping. Otherwise, delete them as in [An operator removes it](#an-operator-removes-it), with the old Gramps ID in the query. Afterwards the member adds a new passkey at `https://<site>/auth/passkeys`, and can delete the old one from the device's own passkey list.

**Verify.**

1. Have the member sign in with Google at `https://<site>/auth/login`, then open `https://<site>/auth/session`. It shows `"sub": "<new-gramps-id>"`. The `get-item` command above now prints `<new-gramps-id>`.
2. The S3 copy, which the edge reads, holds the new ID:

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' '.[$e]'
   ```

   It prints `"<new-gramps-id>"`.

### A new email for the same member

Remove the old address and add the new one with the same Gramps ID, in both files, then publish. Their content, their admin rights and any `subjects` entry in `groups.json` carry over, because all of them follow the Gramps ID. Some things do not:

- **An `emails` entry in `groups.json`.** Replace the old address with the new one.
- **A Cognito user, if one exists.** It is keyed by email, so it keeps the old address, and a password sign-in with it is refused with `403 not_allowlisted`. Disable it as in step 5 of [Remove a member](#remove-a-member), with the old address. The member can set a password for the new address at `https://<site>/auth/link` after a Google sign-in with that address, but only once the old address's link record is gone. While it remains, the page offers no password if one is linked under the old address, and otherwise the edge may pick the old address for the password and refuse it with `403 not_allowlisted`. So first delete the old address's link record, with io's go-ahead, as in steps 5 to 7 of [A different Gramps ID for the same email](#a-different-gramps-id-for-the-same-email), with the old address as `<email>`. The lookup prints the member's Gramps ID, which is unchanged.
- **Passkeys.** Each one carries the address it was added under, so once the old address is gone, a sign-in with one is refused with `403 not_allowlisted`. The passkeys still belong to the same Gramps ID, so the member can sign in with the new address, remove the old passkeys at `https://<site>/auth/passkeys`, and add new ones.

## Related pages

- [The identity model](../explanation/identity-model.md): why the allowlist is the authority, why an email is never re-pointed, why admins and MCP groups are separate lists, and why removal is not instant.
- [Identity services](../reference/identity-services.md): the resolver, the link records, passkeys, the refresh check, the membership groups and the retired legacy sign-in.
- [MCP server](../reference/mcp-server.md): the tools, the policy table and how `groups.json` is read.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the admin list and the MCP groups live, and the publisher's environment overrides.
- [Family data privacy](../explanation/family-data-privacy.md): why these files never enter the repository.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the checks for the deployed `authV2` flag and the gate, and the rollback order.
- [Connect an MCP client](connect-an-mcp-client.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Rotate the session signing key](rotate-the-session-signing-key.md).
