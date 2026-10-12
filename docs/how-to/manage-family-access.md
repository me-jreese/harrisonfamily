# How to add or remove a family member's access

Use this page to give a family member access to the site, to make them an admin, or to take either away. You edit two private allowlist files, publish them, and then confirm the change on the auth edge and on the legacy sign-in path. While `authV2` is off, the legacy path is the default sign-in for everyone, so check both.

For why one allowlist decides membership and why admins are a separate list, see [The identity model](../explanation/identity-model.md). For the file formats, what reads each object and how long each reader caches it, see [Private data and secrets](../reference/private-data-and-secrets.md#access-configuration-in-config-bucketconfig).

Email addresses and Gramps IDs on this page are placeholders. Never put real ones in this repository.

## What you edit

- `userGrampsID.json` maps each email to a Gramps ID. It is the auth edge's allowlist.
- `harrisonfamily-allowlist.json` lists the emails. The publisher turns it into the digest list that the legacy Lambda checks.
- `config/admins.json` lists the Gramps IDs of admins. It has no source file. You edit the S3 object.

The legacy Lambda admits an email only when its digest is listed **and** it has a mapping ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)), so keep the two source files in step.

## Before you start

- **The private source files.** `userGrampsID.json` and `harrisonfamily-allowlist.json` are in `<project>/docs/dev`. `<project>` is the directory that contains the repository checkout, as defined in [Placeholders](../reference/private-data-and-secrets.md#placeholders). The copies under [`allowlist/`](../../allowlist/) in the repo are sanitized samples. Do not edit them, and do not copy the real files into the repo. Edit only the copies in `<project>/docs/dev`. A copy kept only in `workspace-local/` is never published.
- **The publisher.** The script is `<project>/scripts/infra/publish_allowlists.sh`. It is not in this repository. It reads its source files from `docs/dev` two levels above its own location, so run the copy in `<project>`.
- **AWS credentials** with `s3:GetObject`, `s3:PutObject` and `s3:PutObjectAcl` on `<config-bucket>/config/*`, and `secretsmanager:GetSecretValue` on `HFY_ALLOWLIST_HMAC_SECRET`. The script uploads with `--acl private`, which needs `s3:PutObjectAcl`. It uses `AWS_PROFILE` (default `default`) and `AWS_REGION` (default `us-west-2`).
- **gcloud authenticated, in the legacy project.** The script's last step adds a version to the legacy Google secret in the active gcloud project, and it fails without gcloud. `<gcp-project>` is the `GCP_PROJECT_ID` value in [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) (see [Repository operations: Placeholders](../reference/repository-operations.md#placeholders)).

  ```sh
  gcloud auth login
  gcloud config set project <gcp-project>
  ```

- **Optional, for the Cognito step:** `cloudformation:DescribeStacks` on the `hfy-app` stack, and `cognito-idp:AdminGetUser` and `cognito-idp:AdminDisableUser` on its user pool.
- **For a change of Gramps ID:** `dynamodb:GetItem` and `dynamodb:DeleteItem` on the `hfy-app` table.
- **For the legacy instance refresh and log checks:** `lambda:UpdateFunctionConfiguration` and `lambda:GetFunctionConfiguration` on `hfy-check-allowed`, and read access to its log group.
- **`jq`** on your path.

**Every member needs a Gramps ID.** Both paths deny an email whose mapping is missing or empty. Edit the two JSON files directly. No generator produces them, and neither sign-in path admits an email without a Gramps ID ([Private data and secrets](../reference/private-data-and-secrets.md#where-the-private-source-copies-live)).

The Gramps ID becomes the member's identity: the session `sub`, the author of their comments and posts, and their entry in the admin list. Check it against the member's person record before you publish. Nothing checks that the record exists. A wrong ID signs the member in as someone else, and once they have signed in through the edge, correcting it locks them out until you also remove their link record. See [Change a member's record or email](#change-a-members-record-or-email).

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

Admins can delete any comment or post. The admin list holds Gramps IDs, not emails, and the publisher does not touch it. Edit a copy outside the repository, check it, and upload it:

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
   {"authenticated": true, "sub": "<gramps-id>", "grampsId": "<gramps-id>", "label": "<email>"}
   ```

   For a plain string entry, `label` is the member's email.

   Use Google for this check. A new member has no password yet: the user pool takes no self-service sign-up, and the edge creates the member's Cognito account only when they set a password at `https://<site>/auth/link` after a Google sign-in ([Identity services](../reference/identity-services.md#cognito-user-pool)). To check the password path too, have the member set one there, sign out, and sign in again at `/auth/login` with the email and password.

3. **"My Record" points at the member.** On the edge path, open `https://<site>/?hfy_flags=authV2` in that browser. The **MY RECORD** link points to `/person/?id=<gramps-id>`. Open `https://<site>/?hfy_flags=` afterwards to clear the override.

4. **The legacy path admits them.** In a private window with no flag override, have the member sign in at `https://<site>/family-login/`. The browser moves to `/person/?id=<gramps-id>`, and **MY RECORD** points there. **LOG OUT** proves nothing: the navigation shows it after any Google sign-in, admitted or not. The Lambda logs show the match:

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

5. Optional: disable the member's Cognito user, if one exists. A pool user exists only if the member set a password at `/auth/link`, or signed up before the pool was locked down. Disabling it blocks only the email-and-password method, and a removed member cannot set a new password, because `/auth/link` checks the allowlist first. Google sign-in never touches Cognito, so the allowlist removal is what denies access. The user pool's region is the part of `<user-pool-id>` before the `_`.

   ```sh
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
   aws cognito-idp admin-get-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   aws cognito-idp admin-disable-user --user-pool-id <user-pool-id> --username '<email>' --region <region>
   ```

   If `admin-get-user` reports `UserNotFoundException`, there is nothing to disable.

Removal blocks new sign-ins. It does not end access already granted. Wait 300 s before you test the edge, and make sure step 3 ran before you test the legacy path. A site session or MCP access token the member already holds lasts until it expires, up to 1 h after issue. If that is too long, [rotate the session signing key](rotate-the-session-signing-key.md), which signs out every edge session, everyone else's included. [The identity model](../explanation/identity-model.md#what-removal-does-and-does-not-do) gives the full timing.

The member's comments and posts stay. They remain attributed to the Gramps ID. The edge also keeps the member's link record. If you later add the same email back under a different Gramps ID, remove that record first, as in [Change a member's record or email](#change-a-members-record-or-email).

### Verify a removal

1. **The S3 copy no longer holds the member.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - | jq --arg e '<email>' 'has($e)'
   ```

   It prints `false`.

2. **A fresh edge sign-in is denied.** After 300 s, sign in at `https://<site>/auth/login` in a private window with the removed account. The page shows the denial from [`auth/edge.manifest.json`](../../auth/edge.manifest.json): "This email address is not on the family access list. Ask a family administrator to add it." The route returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`.

3. **A fresh legacy sign-in is denied.** Sign in at `https://<site>/family-login/` with the removed account. The page still names the Google account, and the navigation shows **LOG OUT**, because the page marks the visitor signed in before it asks the Lambda. The removal shows in what is missing: the browser stays on `/family-login/`, **MY RECORD** does not appear, and in the network panel the `POST /api/check-allowed` request returns `403`, so no gateway session is created. The Lambda log is the deciding test:

   ```sh
   aws logs tail /aws/lambda/hfy-check-allowed --region us-west-2 --since 15m \
     --filter-pattern '"Email not on allowlist or missing Gramps ID"'
   ```

   The log shows only a redacted form of the email: its first three characters, `***@` and the domain.

4. **Admin only: the ID left the admin list.**

   ```sh
   aws s3 cp s3://<config-bucket>/config/admins.json - \
     | jq -e --arg g '<gramps-id>' '(if type == "array" then . else .admins end) | index($g) == null'
   ```

   It prints `true`. While the member's existing edge session lasts, the API stops returning `can.delete: true` on other members' comments and posts within 60 s.

## Change a member's record or email

### A different Gramps ID for the same email

The edge records each email's Gramps ID the first time the member signs in, in a link record (`LINK#<email>`) in the `hfy-app` table. It never re-points that record. After you change the mapping, every edge sign-in by that member is refused with `403 link_conflict` until you delete the record.

1. Change the value in `userGrampsID.json`, and check the file as in [step 1](#1-edit-the-source-files).
2. Publish, as in [step 2](#2-publish), and start new legacy instances, as in [step 3](#3-start-new-legacy-lambda-instances).
3. If the member is an admin, replace the old ID in `admins.json`: run the removal filter from [Remove a member](#remove-a-member) step 4 with the old ID, then the filter from [step 4](#4-optional-make-the-member-an-admin) with the new ID.
4. Wait 300 s, so that no edge instance still maps the email to the old ID. A sign-in in that window would write the old link again.
5. Look up the link record. Write `<email>` in lower case, as the edge stores it. The table is the `TableName` stack parameter, `hfy-app` by default. Use the `hfy-app` stack's region if it is not `us-west-2`.

   ```sh
   aws dynamodb get-item --table-name hfy-app --region us-west-2 \
     --key '{"PK":{"S":"LINK#<email>"},"SK":{"S":"META"}}' --query 'Item.sub.S' --output text
   ```

   It prints the old Gramps ID. If it prints `None`, the member has never signed in through the edge, so there is nothing to delete. Skip the next step.

6. Delete the record:

   ```sh
   aws dynamodb delete-item --table-name hfy-app --region us-west-2 \
     --key '{"PK":{"S":"LINK#<email>"},"SK":{"S":"META"}}'
   ```

The member's current edge session keeps the old ID until its `io_id` cookie expires, up to 1 h after issue, or until you [rotate the session signing key](rotate-the-session-signing-key.md). A new sign-in replaces it sooner. Content they wrote stays under the old ID.

**Verify.**

1. Have the member sign in with Google at `https://<site>/auth/login`, then open `https://<site>/auth/session`. It shows `"sub": "<new-gramps-id>"`. The `get-item` command above now prints `<new-gramps-id>`.
2. Have the member sign in at `https://<site>/family-login/`. The legacy log shows the new ID:

   ```sh
   aws logs tail /aws/lambda/hfy-check-allowed --region us-west-2 --since 15m --filter-pattern '"Allowlist match"'
   ```

   The line for the member's redacted email carries `<new-gramps-id>` in its `grampsId` field.

### A new email for the same member

Remove the old address and add the new one with the same Gramps ID, in both files, then publish and start new legacy instances. Their content and admin rights carry over, because both follow the Gramps ID. A Cognito user, if one exists, is keyed by email and does not carry over.

## Related pages

- [The identity model](../explanation/identity-model.md): why the allowlist is the authority, why an email is never re-pointed, and why removal is not instant.
- [Identity services](../reference/identity-services.md): the resolver, the link records, the refresh check, the membership groups and the legacy Lambda.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the admin list and the HMAC key live, and the publisher's environment overrides.
- [Family data privacy](../explanation/family-data-privacy.md): why these files never enter the repository.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Rotate the session signing key](rotate-the-session-signing-key.md).
