# How to cut over to authV2 and the private data gate, and roll back

Use this page to turn `authV2` on for every visitor and *then* attach the private data gate, in that order (HFY-R67). It also covers checking the result, purging Cloudflare's copies of the data paths if you choose to, and rolling back in reverse order.

When you start, `authV2` is `false` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) and the gate is not attached. Until the gate is attached, the distribution's default behavior serves the six data paths from `<site-bucket>` with no check: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. The order matters. With `authV2` on and no gate, the data is exactly as public as before, and only the client changes. If the gate went first, every visitor still on the old client would get `401` for person, search and photo data until the site deploy finished. [The release model](../explanation/release-model.md) explains why a flag and an infrastructure change are separate switches. [The privacy model for family data](../explanation/family-data-privacy.md) explains why the data paths are gated at the edge.

This page does not build or deploy the gate function. That is [Deploy the edge functions](deploy-the-edge-functions.md).

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<distribution-id>`, `<app-stack>`, `<aws-account-id>` and `<gramps-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's G-prod approval**, an HFY-PLN-001 gate, for both the global `authV2` flip in step 1 and the gate attachment in step 3. A go-ahead in the session is not enough for either. [`AGENTS.md`](../../AGENTS.md) lists the production operations that need io's go-ahead and the two that need G-prod approval.
- **`hfy-edge-gate` is deployed and its version is validated.** Follow [Deploy the edge functions](deploy-the-edge-functions.md). This command prints the version that step 3 will attach:

  ```sh
  aws cloudformation describe-stacks --region us-east-1 --stack-name hfy-edge-gate \
    --query "Stacks[0].Outputs[?OutputKey=='EdgeGateVersionArn'].OutputValue" --output text
  ```

  It prints `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n>`. `<n>` must be the version you invoked with synthetic viewer-request events on that page: `401` with no cookie, `401` with a forged token, `302` for a navigation, and `Cache-Control: private, no-store` on each.
- **The app stack `<app-stack>` and the `/auth/*` behaviors are live.** The gate checks every `io_id` against the auth edge's public keys, which it fetches through CloudFront. Without them it denies every request. Two checks:

  ```sh
  curl -s https://<site>/auth/session
  curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'
  ```

  The first prints `{"authenticated":false}`. The second prints a key ID. Run the other `authV2` checks in [Toggle a feature flag](toggle-a-feature-flag.md#check-the-prerequisites) too.
- **Operator AWS credentials** that can:
  - read and update the distribution.
  - read the `hfy-edge-gate` stack in `us-east-1`.
  - list and create CloudFront response headers policies, and update one if `hfy-private-no-store` has drifted.
  - associate a Lambda@Edge version with a distribution. AWS requires `lambda:GetFunction` and `lambda:EnableReplication*` on `hfy-edge-gate`, and `iam:CreateServiceLinkedRole` the first time.

  The GitHub deploy role cannot do any of this.
- **A private backup directory.** Before each real update, the script saves the distribution configuration, including the origin-verify header value, to `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` with mode 600. Leave `HFY_CF_BACKUP_DIR` unset, or point it at a private directory outside the repository.
- **Tools.** The AWS CLI, `jq` and `curl`. You also need a browser with DevTools and a member account that can sign in at `/auth/login`.
- **Optional, for step 4: a Cloudflare API token** with the Zone > Cache Purge permission, held in `$CF_API_TOKEN`, and the zone ID in `$CF_ZONE_ID`. Never paste the token into a command. Read it into the shell instead, so it stays out of the command line and the history:

  ```sh
  read -rs CF_API_TOKEN && export CF_API_TOKEN
  read -r CF_ZONE_ID && export CF_ZONE_ID
  ```

  You can also purge in the Cloudflare dashboard, without a token.
- **A dry run you have already reviewed.** Run it well before the cutover, so you can settle any refusal without time pressure:

  ```sh
  scripts/infra/add-data-gate-behaviors.sh --dry-run --distribution <distribution-id>
  ```

  It changes nothing. The first time, it reports `(dry-run) would create response headers policy hfy-private-no-store (Cache-Control: private, no-store, override)`. Review the rest of the output as described in [step 3](#3-attach-the-gate).

Run every command on this page from the repository root.

## Steps

### 1. Flip authV2 and deploy the site

Follow [Turn a flag on for everyone](toggle-a-feature-flag.md#turn-a-flag-on-for-everyone) for `authV2`: set it to `true`, copy `flags.json` into the Eleventy source, and merge the pull request to `main`. Then let `io-kit-deploy` finish its build, deploy, invalidate and smoke jobs ([Deploy a site change](deploy-a-site-change.md)).

This step does not change who can read the data. It only moves the client to the `io_id` session.

If the smoke job fails and `rollback_on_smoke_fail` restores the previous artifact, stop. The gate is not attached, so nothing else needs undoing. Before you try again, make the rollback last as described in [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). Do not go on to step 3 until a deploy run with `authV2` set to `true` has finished green.

### 2. Confirm the client

1. Confirm the published value. This prints `true`:

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   ```

2. Open a private window, which has no preview override. Sign in at `https://<site>/auth/login`, then open a person page, `https://<site>/person/?id=<gramps-id>`.
3. In DevTools > Network, select the `/person/<gramps-id>.json` request. Its request headers carry a `Cookie` header that includes `io_id`, and no `X-HFY-Session` header. Do not copy the cookie value anywhere.
4. Search from the navbar, which loads `/person/index.json` and `/person/search-index.json`. Results appear, and the person page's photos load.

If the data request has no `io_id` cookie, or still sends `X-HFY-Session`, the page is not running the `authV2` client. Do not attach the gate. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

### 3. Attach the gate

1. Run the dry run again, against the live configuration:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --dry-run --distribution <distribution-id>
   ```

   Do not pass `--stack <app-stack>` to this script. Unlike the app behavior scripts, its `--stack` names the `us-east-1` edge-gate stack, and its default, `hfy-edge-gate`, is the deployed name.

2. Review the output. [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts) explains the lines that every behavior script prints.
   - **The policy.** The output shows either `(dry-run) would create response headers policy hfy-private-no-store ...`, or `response headers policy hfy-private-no-store (<policy-id>) already forces Cache-Control: private, no-store`. If it says `would put response headers policy hfy-private-no-store (<policy-id>) back`, someone changed the policy. The real run will restore it.
   - **The version.** The line `gating /person/*.json /family/* /event/* /note/* /place/* /media/* on origin <origin-id> with arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n> ...` names the S3 origin of the default behavior and the version `<n>` that you validated. If the stack has a newer version than the one you validated, stop and validate that version first.
   - **The position.** In the `cache behaviors after (in evaluation order)` line, the six patterns follow the existing behaviors, each pointing at `<origin-id>`. The exception is an existing broader behavior that would also match a gated path, such as a legacy `/person/*`. The gated pattern then sits immediately before it. No other behavior moves.
   - **The diff.** It adds six behaviors and raises `CacheBehaviors.Quantity` by 6. Each new behavior allows `GET` and `HEAD` only. Its `CachePolicyId` is `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` (CachingDisabled), and its `ResponseHeadersPolicyId` is the `hfy-private-no-store` policy. A dry run that has not created the policy yet shows a placeholder for that ID. Each has one `LambdaFunctionAssociations` item: `EventType` `viewer-request`, `IncludeBody` `false`, and the versioned ARN. `FunctionAssociations` is empty. Nothing else changes.
   - **Stop if the diff changes an existing behavior** with one of the six patterns instead of adding one. The script would take that behavior over, and `--remove` would later delete it rather than restore it.

3. Apply it:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id>
   ```

   The real run does not ask for confirmation, so the dry run is your review. It reads the live configuration again, and its diff should match the dry run's. It creates the policy if it is missing, with `created response headers policy hfy-private-no-store (<policy-id>)`. It also saves the pre-change configuration and prints `saved the pre-change DistributionConfig to <backup>` and a `roll back with: aws cloudfront update-distribution ...` command. Then it prints the distribution status, `InProgress`. Note the backup path.

4. Wait for the distribution:

   ```sh
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   A Lambda@Edge association takes several minutes to replicate. The command returns with no output once the distribution is deployed. If it times out, run it again.

From then on, a request for the six paths without a valid `io_id` gets a `401` or a sign-in redirect.

### 4. Optional: purge Cloudflare

Cloudflare proxies `<site>` in front of CloudFront, and it caches by file extension whatever CloudFront's cache policy says. That covers the images, SVG and PDF files under `/media/`; JSON is not cached by default. Any response Cloudflare cached before step 3 keeps being served from Cloudflare until its TTL ends, and those requests never reach the gate. A purge removes those copies now. New responses carry `Cache-Control: private, no-store`, which Cloudflare does not store.

- **In the dashboard:** use Caching > Configuration > Custom Purge > Prefix and enter the six prefixes below.
- **With the API:**

  ```sh
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    --data '{"prefixes":["<site>/person/","<site>/family/","<site>/event/","<site>/note/","<site>/place/","<site>/media/"]}'
  ```

  In the JSON response, `success` is `true`.

If `www.<site>` serves the site, add the same six prefixes for it. If your plan has no prefix purge, use Purge Everything. The static site refills from CloudFront.

Never add a Cloudflare Cache Rule that overrides the edge TTL on these paths. The `private, no-store` header works only while Cloudflare honors the origin's `Cache-Control`. A Cache Rule that sets "Bypass cache" for the six prefixes is optional extra protection. It is configured in the Cloudflare dashboard, outside this repository.

## Verify

Signed out, from a shell with no cookies:

1. The search manifest is refused, and the answer is not stored:

   ```sh
   curl -sS -o /dev/null -D - https://<site>/person/index.json
   ```

   The status is `401`, with `cache-control: private, no-store`.
2. Every gated prefix is refused. The gate answers before the request reaches the bucket, so a path that does not exist also gets `401`:

   ```sh
   for p in person/index.json family/x event/x note/x place/x media/x; do
     printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"
   done
   ```

   Each line ends in `401`. The person page shell stays public, so `curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/` prints `200`.
3. Cloudflare does not serve a stored copy. While signed in, take a `/media/` URL from a person page in DevTools. Then request it twice without a cookie:

   ```sh
   for i in 1 2; do
     curl -sS -o /dev/null -D - "https://<site>/media/<file>" | grep -iE '^(HTTP|cache-control|cf-cache-status)'
   done
   ```

   Both answers are `401`, and `cf-cache-status` is never `HIT`. The URL names a private file, so do not record it in a worklog.
4. A navigation is sent to sign-in:

   ```sh
   curl -sS -o /dev/null -D - -H 'Sec-Fetch-Mode: navigate' https://<site>/person/index.json \
     | grep -iE '^(HTTP|location|cache-control)'
   ```

   The status is `302`, with `location: /auth/login?returnTo=%2Fperson%2Findex.json` and `cache-control: private, no-store`.

Signed in, in the private window from step 2:

1. Reload the person page. The data, search and photos load.
2. In DevTools > Network, check the response headers of `/person/<gramps-id>.json` and of a `/media/` file. Each shows `cache-control: private, no-store`, and `cf-cache-status` is `DYNAMIC` or `BYPASS`.
3. `io_id` lives one hour. More than an hour after you signed in, reload a person page in the same window. The Network panel shows `POST /auth/refresh` answering `200`, the data requests succeed, and the page does not go to `/auth/login`. The client sends a visitor to `/auth/login?returnTo=...` only when that refresh fails.

## Roll back

Roll back in reverse order: the gate first, then the flag, and the flag only if it is at fault.

1. **Remove the gate.** Do a dry run first:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id>
   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   The dry run's diff removes only the six gated behaviors, and only ones that carry an `hfy-edge-gate` association. `CacheBehaviors.Quantity` falls by 6, and nothing else changes. Like any real update, the real run saves a backup first. Once the distribution is deployed, the default behavior serves the data paths again, and the data is public again, as it was before the release. The `hfy-private-no-store` policy is kept, unused. The `hfy-edge-gate` stack can stay too. CloudFront deletes the version's replicas some hours after its last association is removed.

   The alternative is to restore the backup that step 3 saved, with the distribution's current ETag:

   ```sh
   ETAG="$(aws cloudfront get-distribution-config --id <distribution-id> --query ETag --output text)"
   aws cloudfront update-distribution --id <distribution-id> --if-match "$ETAG" \
     --distribution-config file://<backup>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   That restores the whole configuration as it was before step 3, so any distribution change made since then is lost as well. Prefer `--remove`. The backup holds the origin-verify value, so delete it once you no longer need it.
2. **Only after that, and only if the `authV2` client itself is at fault,** set `authV2` back to `false` and deploy ([Toggle a feature flag](toggle-a-feature-flag.md#roll-back)). Never turn `authV2` off while the gate is attached. The legacy client does not sign in with an `io_id` session, so the gate refuses its data requests, and person pages, search and photos fail.

> **Warning: an automatic site rollback counts as turning `authV2` off.** If a later site deploy fails its smoke check while the gate is attached, `rollback_on_smoke_fail` restores the previous release artifact. For the first deploys after the flip, that artifact may still have `"authV2": false`. After any automatic rollback, run `curl -s https://<site>/_data/flags.json | jq .authV2`. Unless it prints `true`, remove the gate at once (rollback step 1).

## If something fails

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| `stack hfy-edge-gate has no output EdgeGateVersionArn` | The gate stack is not deployed in `us-east-1`, or your credentials cannot read it there. | Deploy it as in [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |
| `version ARN must be a qualified us-east-1 ARN of hfy-edge-gate ...` or `version ARN must end in a numeric version ...` | `--version-arn` names `$LATEST`, an unqualified ARN or another function. CloudFront accepts only a published version. | Drop `--version-arn` so the script reads the stack output, or pass the full versioned ARN. |
| `origin '<origin-id>' is not in distribution <distribution-id> (pass --origin-id)` | The origin the script picked is not one of the distribution's origins. | Pass the S3 origin's ID with `--origin-id`. |
| `refusing to update from --config-file ...` | An exported configuration can drive a dry run only. | Drop `--config-file`. |
| `create-response-headers-policy hfy-private-no-store returned no id`, or an `AccessDenied` error from a CloudFront call | The credentials lack a permission listed in [Before you start](#before-you-start). | Fix the credentials and run the script again. |
| `PreconditionFailed` from `update-distribution` | The distribution changed after the script read it. | Run the dry run again, review it, then apply. |
| Members get `401` or keep being sent to sign-in after step 3 | A session or key problem. When the gate rejects a cookie, it logs `edge-gate: deny <reason>` in CloudWatch Logs, under `/aws/lambda/us-east-1.hfy-edge-gate` in the region of the edge location that served the request. A request with no cookie is denied without a log line. | If the cause is not obvious, remove the gate first (rollback step 1), then follow [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), which has a section on the data gate. |

Every run of the script is safe to repeat. Against a distribution that already matches, it prints `distribution <distribution-id> already has ...: no change` and makes no update.

## Related pages

- [Toggle a feature flag](toggle-a-feature-flag.md): the `authV2` flip and its rollback.
- [Roll back a site deploy](roll-back-a-site-deploy.md): what the automatic rollback restores, and how to make a rollback last.
- [Deploy the edge functions](deploy-the-edge-functions.md): build, deploy and validate `hfy-edge-gate`.
- [System architecture](../reference/architecture.md#request-routing): the distribution's behaviors and their order.
- [Identity services](../reference/identity-services.md): the `io_id` session, `/auth/refresh` and the data gate.
- [Front end](../reference/front-end.md): how the `authV2` client fetches data with the cookie and refreshes the session.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md): symptom-first fixes, including the data gate.
