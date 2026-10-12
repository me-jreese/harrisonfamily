# How to add or remove a family member's access

Use this page to give a family member access to the site, make them an admin, give them MCP access, remove a lost passkey, sign a member out on every device, or take their access away. Site access comes from two private allowlist files: the auth edge reads one, and the legacy sign-in path, which is still deployed, reads both. You edit and publish them, then confirm the change on the auth edge, and on the legacy path too when the deployed site has `authV2` off. Admin rights and MCP access come from two more files in the config bucket, which you edit by hand.

For why one allowlist decides membership and why admins and MCP groups are separate lists, see [The identity model](../explanation/identity-model.md). For the file formats, what reads each object and how long each reader caches it, see [Private data and secrets](../reference/private-data-and-secrets.md#access-configuration-in-config-bucketconfig).

Values in angle brackets are placeholders. `<email>` is a member's email address and `<gramps-id>` is their Gramps ID. `<site>` is the site's host name, `<config-bucket>` is the bucket that holds `config/`, and `<app-stack>` is the name of the deployed app stack. `<credential-id>` is a passkey's credential id. The forms are listed in [Private data and secrets: Placeholders](../reference/private-data-and-secrets.md#placeholders). Never put real addresses or Gramps IDs in this repository.

## What you edit

- `userGrampsID.json` maps each email to a Gramps ID. It is the auth edge's allowlist.
- `harrisonfamily-allowlist.json` lists the emails. The publisher turns it into the digest list that the legacy Lambda checks.
- `config/admins.json` lists the Gramps IDs of site admins. It has no source file. You edit the S3 object.
- `config/groups.json` names the members who get MCP tools. No script writes it. You upload it by hand.
- Passkey records in the app stack's table, only to remove a lost passkey for a member who cannot do it themselves.
- Revocation records in the app stack's table, only to sign a member out on every device, for example when a device that is still signed in is lost.

The legacy Lambda admits an email only when its digest is listed **and** it has a mapping ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)), so keep the two source files in step. Do this whatever the `authV2` flag shows. The legacy path stays deployed for one release after the cutover (HFY-R4), and it still serves a page where `authV2` resolves off or `/auth/session` does not answer ([The identity model](../explanation/identity-model.md#the-legacy-path-after-the-cutover)).

## Before you start

- **Which sign-in path the deployed site uses.** Run `curl -s https://<site>/_data/flags.json | jq .authV2`. `true` means members sign in through the auth edge: `/family-login/` sends a signed-out visitor to `/auth/login`, so the checks on this page use the edge. The production cutover set `authV2` to `true` on 2026-10-12 (HFY-TSK-069, HFY-R67). `false` means the legacy Google sign-in on `/family-login/` is the default, and the checks marked "Where `authV2` is off" apply as well. Never turn `authV2` off to run a legacy check: while the data gate is attached, that locks every visitor out of the family data (HFY-R67). A signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` prints `401` while the gate is attached and `200` when it is not.
- **io's go-ahead.** Publishing the allowlist or the admin list needs it ([`AGENTS.md`](../../AGENTS.md)). So does a change to `config/groups.json`, and so does any item you write or delete in the app table by hand: an operator's deletion of a member's passkey (`PASSKEY#<credential-id>`), the deletion of a member's link record (`LINK#<email>`), and the revocation records that sign a member out on every device.
- **The private source files.** `userGrampsID.json` and `harrisonfamily-allowlist.json` are in `<project>/docs/dev`. `<project>` is the directory that contains the repository checkout, as defined in [Placeholders](../reference/private-data-and-secrets.md#placeholders). The repo's [`allowlist/`](../../allowlist/) holds sanitized samples of the email array and of the digest list (see [`allowlist/README.md`](../../allowlist/README.md)). There is no sample of `userGrampsID.json`. Do not edit the samples, and do not copy the real files into the repo. Edit only the copies in `<project>/docs/dev`. A copy kept only in `workspace-local/` is never published.
- **The publisher.** The script is `<project>/scripts/infra/publish_allowlists.sh`. It is not in this repository. It reads its source files from `docs/dev` two levels above its own location, so run the copy in `<project>`.
- **AWS credentials** with `s3:GetObject`, `s3:PutObject` and `s3:PutObjectAcl` on `<config-bucket>/config/*`, and `secretsmanager:GetSecretValue` on `HFY_ALLOWLIST_HMAC_SECRET`. The script uploads with `--acl private`, which needs `s3:PutObjectAcl`. It uses `AWS_PROFILE` (default `default`) and `AWS_REGION` (default `us-west-2`). The same S3 permissions cover `admins.json` and `groups.json`.
- **gcloud authenticated, in the legacy project.** The script's last step adds a version to the legacy Google secret in the active gcloud project, and it fails without gcloud. `<gcp-project>` is the `GCP_PROJECT_ID` value in [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) (see [Repository operations: Placeholders](../reference/repository-operations.md#placeholders)).

  ```sh
  gcloud auth login
  gcloud config set project <gcp-project>
  ```

- **Optional, for the Cognito step:** `cloudformation:DescribeStacks` on `<app-stack>`, and `cognito-idp:AdminGetUser` and `cognito-idp:AdminDisableUser` on its user pool.
- **For a change of Gramps ID or email, or an operator's passkey removal:** `cloudformation:DescribeStacks` on `<app-stack>`, `dynamodb:GetItem` and `dynamodb:DeleteItem` on its table, and `dynamodb:Query` on the table's `GSI1` index.
- **For signing a member out on every device:** `cloudformation:DescribeStacks` on `<app-stack>`, and `dynamodb:Scan`, `dynamodb:GetItem` and `dynamodb:PutItem` on its table.
- **For the legacy instance refresh and log checks:** `lambda:UpdateFunctionConfiguration` and `lambda:GetFunctionConfiguration` on `hfy-check-allowed`, and read access to its log group.
- **`jq`** on your path.

**Every member needs a Gramps ID.** Both paths deny an email whose mapping is missing or empty. Edit the two JSON files directly. No generator produces them, and neither sign-in path admits an email without a Gramps ID ([Private data and secrets](../reference/private-data-and-secrets.md#where-the-private-source-copies-live)).

Check the Gramps ID against the member's person record before you publish, because nothing checks that the record exists. A wrong ID signs the member in as someone else, and correcting it after they have signed in through the edge takes the extra steps in [Change a member's record or email](#change-a-members-record-or-email). [The identity model](../explanation/identity-model.md#the-allowlist-is-the-authority) explains why the Gramps ID is the member's identity.

## Add a member

### 1. Edit the source files

In `<project>/docs/dev`:

- Add `"<email>": "<gramps-id>"` to the object in `userGrampsID.json`.
- Add `"<email>"` to the array in `harrisonfamily-allowlist.json`.

Write the email in lower case in both files. The edge and the hash step lower-case it, but the legacy Lambda looks up the mapping with the key exactly as stored, so a key with capitals never matches. Use the plain string form. The edge also accepts an object form, `{"gramps_id": ..., "label": ..., "roles": [...]}`, but the legacy Lambda would return that whole object to the browser as the Gramps ID.

Check both files before you publish. The script uploads `userGrampsID.json` without validating it. If that file is malformed, edge instances that already hold a copy keep using the previous list, so the change silently does not apply. Edge instances that start afterwards deny every sign-in, and new legacy instances answer every sign-in with a 500.

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

The script runs these steps in order and stops at the first failure:

1. Uploads `userGrampsID.json` to `s3://<config-bucket>/config/userGrampsID.json`, replacing the object.
2. Reads the HMAC key from Secrets Manager, computes the digest of each email in `harrisonfamily-allowlist.json` (trimmed and lower-cased, blanks skipped), and uploads the digests to `config/allowed_hashes.json`, replacing the object. It fails if the file is not a JSON array.
3. Runs `gcloud secrets versions add harrisonfamily-allowlist` with the email array, in the active gcloud project.

It prints `[DONE] Allowlist artifacts published.` when all three succeed. The local files are the source of truth: each run overwrites the S3 objects with them.

If step 2 fails, the edge already has the new mapping, but the legacy path still denies the new member. If step 3 fails, both S3 objects are current and only the unused Google copy is stale. In either case, fix the cause and run the script again. A re-run is safe.

The script also reads environment overrides for the bucket, the object keys and the secret names. They are listed under [`publish_allowlists.sh`](../reference/private-data-and-secrets.md#publish_allowlistssh). Set one only if the matching reader was configured differently: the resolver in [`auth/edge.manifest.json`](../../auth/edge.manifest.json), or the legacy Lambda's environment.

### 3. Start new legacy Lambda instances

`hfy-check-allowed` loads the mapping and the digests once per instance and never reloads them. Until a new instance starts, the legacy path does not see the change. Any configuration update makes Lambda start new instances. Changing only the description is the least intrusive:

```sh
aws lambda update-function-configuration --function-name hfy-check-allowed --region us-west-2 \
  --description "allowlist published <yyyy-mm-dd>"
aws lambda wait function-updated --function-name hfy-check-allowed --region us-west-2
```

A push to `main` has the same effect, because [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) uploads the Lambda's code on every run.

### 4. Optional: make the member an admin

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

1. **The S3 copies hold the member.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' '.[$e]'
   aws s3 cp s3://<config-bucket>/config/allowed_hashes.json - | jq length
   jq length <project>/docs/dev/harrisonfamily-allowlist.json
   ```

   The first command prints `"<gramps-id>"`. The two counts match, unless the source array has blank entries.

2. **The auth edge admits them.** Wait up to 300 s for edge instances to drop their cached copy. Have the member sign in with Google at `https://<site>/auth/login`, and then open `https://<site>/auth/session` in the same browser. It returns:

   ```json
   {"authenticated": true, "sub": "<gramps-id>", "grampsId": "<gramps-id>", "label": "<email>", "exp": <epoch-seconds>}
   ```

   `exp` is when the session token expires, in epoch seconds, an hour after it was issued. For a plain string entry, `label` is the member's email. The label stays in the session: posts, comments and push notifications never show it. They name the member by the `displayName` in their person record, or by the Gramps ID when there is none (HFY-R68).

   Use Google for this check. A new member has no password yet: the user pool takes no self-service sign-up, and the edge creates the member's Cognito account only when they set a password at `https://<site>/auth/link` after a Google sign-in ([Identity services](../reference/identity-services.md#cognito-user-pool)). To check the password path too, have the member set one there, sign out, and sign in again at `/auth/login` with the email and password.

3. **The site links the member to their own record.** In that browser, open `https://<site>/`. The account button at the top of the page opens a menu whose link to the member's own page points to `/person/?id=<gramps-id>`. On a site with `shellV2` off, the navigation's my-record link points there instead. If `authV2` is off on the deployed site, open `https://<site>/?hfy_flags=authV2` for this check, and `https://<site>/?hfy_flags=` afterwards to clear the override.

4. **Where `authV2` is off: the legacy path admits them.** Skip this check when the deployed flag is `true`: `/family-login/` then sends the member to `/auth/login`, so checks 2 and 3 cover the sign-in. Otherwise, in a private window with no flag override, have the member sign in at `https://<site>/family-login/`. The browser moves to `/person/?id=<gramps-id>` only after the Lambda admits them. A page that looks signed in proves nothing: it marks the visitor signed in after any Google sign-in, admitted or not. The Lambda logs show the match:

   ```sh
   aws logs tail /aws/lambda/hfy-check-allowed --region us-west-2 --since 15m --filter-pattern '"Allowlist match"'
   ```

   If the line shows `Email not on allowlist or missing Gramps ID` instead, check that a new instance started: the `REPORT` line of its first request includes `Init Duration`.

5. **Admin only: the member has admin rights.** The S3 object lists the ID at once:

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

## Remove a member

1. In `<project>/docs/dev`, delete the member's key from `userGrampsID.json` and the email from `harrisonfamily-allowlist.json`. Check both:

   ```sh
   jq --arg e '<email>' 'has($e)' userGrampsID.json
   jq --arg e '<email>' 'any(.[]; . == $e)' harrisonfamily-allowlist.json
   ```

   Both print `false`.

2. Run the publisher from `<project>`, as in [step 2](#2-publish).
3. Start new legacy Lambda instances, as in [step 3](#3-start-new-legacy-lambda-instances).
4. If the member is an admin, remove their Gramps ID from the admin list. The check prints `true` before the upload runs:

   ```sh
   aws s3 cp s3://<config-bucket>/config/admins.json admins.json
   jq --arg g '<gramps-id>' \
     'if type == "array" then map(select(. != $g)) else .admins |= map(select(. != $g)) end' \
     admins.json > admins.new.json
   jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) == null' admins.new.json \
     && aws s3 cp admins.new.json s3://<config-bucket>/config/admins.json --content-type application/json
   rm admins.json admins.new.json
   ```

5. If the member is in `groups.json`, remove their Gramps ID and email from it and upload it, as in [Give a member MCP access](#give-a-member-mcp-access). Their MCP client loses its tools within 60 s.
6. Optional: disable the member's Cognito user, if one exists. A pool user exists only if the member set a password at `/auth/link`, or signed up before the pool was locked down. Disabling it blocks only the email-and-password method, and a removed member cannot set a new password, because `/auth/link` checks the allowlist first. Google sign-in never touches Cognito, so the allowlist removal is what denies access. The user pool's region is the part of `<user-pool-id>` before the `_`.

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
   aws cognito-idp admin-get-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   aws cognito-idp admin-disable-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   ```

   If `admin-get-user` reports `UserNotFoundException`, there is nothing to disable.

New sign-ins, passkeys included, are refused with `403` within 300 s, once the edge's cached allowlist expires. Wait that long before you test the edge, and make sure step 3 ran before you test the legacy path. The member's current `io_id` and any MCP access token keep working until they expire, up to 1 h after issue, and their next refresh is refused. If an hour is too long, [rotate the session signing key](rotate-the-session-signing-key.md), with io's go-ahead. [The identity model](../explanation/identity-model.md#what-removal-does-and-does-not-do) explains the timing for each kind of access.

The member's comments and posts stay. They remain attributed to the Gramps ID. The edge also keeps the member's link record and passkeys. If you add them back with the same Gramps ID, their passkeys work again. If you later add the same email back under a different Gramps ID, remove the link record first, as in [Change a member's record or email](#change-a-members-record-or-email).

### Verify a removal

1. **The S3 copy no longer holds the member.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' 'has($e)'
   ```

   It prints `false`.

2. **A fresh edge sign-in is denied.** After 300 s, sign in with Google at `https://<site>/auth/login` in a private window with the removed account. In the network panel, `POST /auth/google` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`, and no session starts. The page shows the `denied_body` text from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json) as a neutral notice, not as an error: the message carries `data-detail="not_allowlisted"`, set by `allowlistNotice` in [`auth/src/edge.js`](../../auth/src/edge.js).

3. **A passkey sign-in is refused.** If the member added a passkey and can try it, have them use the passkey button (the manifest's `passkey_button` text) at `https://<site>/auth/login` after 300 s. The page shows the same notice, `POST /auth/passkey/login/verify` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`, and no session starts.

4. **Where `authV2` is off: a fresh legacy sign-in is denied.** Skip this check when the deployed flag is `true`, because `/family-login/` then sends the visitor to `/auth/login`, which checks 2 and 3 cover. Otherwise, sign in at `https://<site>/family-login/` with the removed account. The page can still look signed in, because it marks the visitor signed in before it asks the Lambda. The removal shows in what is missing: the browser stays on `/family-login/`, and in the network panel the `POST /api/check-allowed` request returns `403`, so no gateway session is created. The Lambda log is the deciding test:

   ```sh
   aws logs tail /aws/lambda/hfy-check-allowed --region us-west-2 --since 15m \
     --filter-pattern '"Email not on allowlist or missing Gramps ID"'
   ```

   The log shows only a redacted form of the email: its first three characters, `***@` and the domain.

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

   No output means the member has no live session to revoke. A browser signed in only through the legacy sign-in, `/family-login/`, holds no edge session and is not listed. That sign-in grants nothing on the server: the data gate, on every behavior where it is attached, accepts only `io_id`, and no data path checks the legacy token ([Identity services: Legacy client contract](../reference/identity-services.md#legacy-client-contract)).

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

4. If the device may be in someone else's hands, also [rotate the session signing key](rotate-the-session-signing-key.md), with io's go-ahead. Until the `io_id` the device holds expires, up to an hour, it still reads the family data and opens the account page at `/auth/link`, where it could set a password for a member who has none. Rotation ends that `io_id` within minutes. Under `authV2` the other members' pages refresh silently under the new key, and this member's devices cannot, because their families are revoked. Afterwards, have the member open `https://<site>/auth/passkeys` and check the sign-in methods and passkeys listed there. Remove any passkey they did not add, as in [Remove a lost passkey](#remove-a-lost-passkey). If a password is linked that they did not set, disable their Cognito user as in step 6 of [Remove a member](#remove-a-member), which blocks only the password method.

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
2. Publish, as in [step 2](#2-publish), and start new legacy instances, as in [step 3](#3-start-new-legacy-lambda-instances).
3. If the member is an admin, replace the old ID in `admins.json`: run the removal filter from [Remove a member](#remove-a-member) step 4 with the old ID, then the filter from [step 4](#4-optional-make-the-member-an-admin) with the new ID.
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
2. The S3 copy, which the edge and the legacy Lambda both read, holds the new ID:

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' '.[$e]'
   ```

   It prints `"<new-gramps-id>"`.
3. Where `authV2` is off, also have the member sign in at `https://<site>/family-login/`. Skip this when the deployed flag is `true`, because that page then sends the member to `/auth/login`. The legacy log shows the new ID:

   ```sh
   aws logs tail /aws/lambda/hfy-check-allowed --region us-west-2 --since 15m --filter-pattern '"Allowlist match"'
   ```

   The line for the member's redacted email carries `<new-gramps-id>` in its `grampsId` field.

### A new email for the same member

Remove the old address and add the new one with the same Gramps ID, in both files, then publish and start new legacy instances. Their content, their admin rights and any `subjects` entry in `groups.json` carry over, because all of them follow the Gramps ID. Some things do not:

- **An `emails` entry in `groups.json`.** Replace the old address with the new one.
- **A Cognito user, if one exists.** It is keyed by email, so it keeps the old address, and a password sign-in with it is refused with `403 not_allowlisted`. Disable it as in step 6 of [Remove a member](#remove-a-member), with the old address. The member can set a password for the new address at `https://<site>/auth/link` after a Google sign-in with that address, but only once the old address's link record is gone. While it remains, the page offers no password if one is linked under the old address, and otherwise the edge may pick the old address for the password and refuse it with `403 not_allowlisted`. So first delete the old address's link record, with io's go-ahead, as in steps 5 to 7 of [A different Gramps ID for the same email](#a-different-gramps-id-for-the-same-email), with the old address as `<email>`. The lookup prints the member's Gramps ID, which is unchanged.
- **Passkeys.** Each one carries the address it was added under, so once the old address is gone, a sign-in with one is refused with `403 not_allowlisted`. The passkeys still belong to the same Gramps ID, so the member can sign in with the new address, remove the old passkeys at `https://<site>/auth/passkeys`, and add new ones.

## Related pages

- [The identity model](../explanation/identity-model.md): why the allowlist is the authority, why an email is never re-pointed, why admins and MCP groups are separate lists, and why removal is not instant.
- [Identity services](../reference/identity-services.md): the resolver, the link records, passkeys, the refresh check, the membership groups and the legacy Lambda.
- [MCP server](../reference/mcp-server.md): the tools, the policy table and how `groups.json` is read.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the admin list, the MCP groups and the HMAC key live, and the publisher's environment overrides.
- [Family data privacy](../explanation/family-data-privacy.md): why these files never enter the repository.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the checks for the deployed `authV2` flag and the gate, and the rollback order.
- [Connect an MCP client](connect-an-mcp-client.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Rotate the session signing key](rotate-the-session-signing-key.md).
