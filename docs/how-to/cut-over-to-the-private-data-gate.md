# How to cut over to authV2 and the private data gate, and roll back

Use this page to turn `authV2` on for every visitor and *then* attach the private data gate, in that order (HFY-R67). It also covers:

- Finding out which of those states a site is in.
- Gating member photos on a distribution whose data paths are already gated.
- Purging Cloudflare's copies of the gated paths.
- Closing the variant spellings of those paths with `HFYAppendIndex`.
- Rolling back in reverse order.

The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67). The site deploy that turned `authV2` and the other five flags on went first, and the gate was attached after it. Two changes merged later the same day (HFY-TSK-082): the gate script now also gates `/uploads/*`, and `HFYAppendIndex` now answers `404` for variant spellings of the private paths. The repository does not record whether either has reached production. Start from [Find your starting point](#find-your-starting-point), not from this history.

The gate is the Lambda@Edge function `hfy-edge-gate`, and it covers seven path patterns. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) creates six behaviors for the family data: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. It gates the seventh, `/uploads/*`, where member post photos live, in place. Without the gate, the six data paths fall through to the distribution's default behavior, which serves them from `<site-bucket>` with no check. The exception is the default-deny code of `HFYAppendIndex`, the default behavior's CloudFront Function, which refuses those paths to everyone ([step 5](#5-close-the-variant-paths-with-hfyappendindex)). An ungated `/uploads/*` serves a photo to anyone who holds its URL. [The privacy model for family data](../explanation/family-data-privacy.md) explains why these paths are gated at the edge. [The release model](../explanation/release-model.md) explains why a flag and an infrastructure change are separate switches.

The order matters. Turning `authV2` on with no gate changes nothing about who can read the data. Only the client changes. If the gate went first, every visitor still on the old client would get `401` for person, search and photo data until the site deploy finished. Once the gate is attached, the same reasoning runs backwards: never turn `authV2` off while it is attached ([Roll back](#roll-back)).

This page does not build or deploy the gate function. That is [Deploy the edge functions](deploy-the-edge-functions.md). Publishing `HFYAppendIndex` is [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md).

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<distribution-id>`, `<app-stack>`, `<aws-account-id>`, `<gramps-id>` and `<ulid>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Find your starting point

These checks need no session and no AWS credentials. Run them before anything else on this page, and again after any rollback.

```sh
curl -s https://<site>/_data/flags.json | jq .authV2
for p in person/index.json uploads/x; do
  printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"
done
curl -sS -o /dev/null -D - https://<site>/Person/index.json | grep -iE '^(HTTP|cache-control)'
```

| Check | Answer | Meaning |
| --- | --- | --- |
| `jq .authV2` | `true` | Visitors without a preview override run the `authV2` client. |
| | `false`, or anything else | They send plain requests and never refresh `io_id`. |
| `/person/index.json` | `401` | The gate is attached to the data paths. |
| | `200` | The gate is not attached. The data is served to anyone. |
| | `404` | The gate is not attached, and `HFYAppendIndex` runs its default-deny code. That code refuses the data paths to every visitor, members included. |
| `/uploads/x` | `401` | `/uploads/*` is gated. |
| | Anything else | `/uploads/*` is not gated. |
| `/Person/index.json` | `404` with `cache-control: private, no-store` | `HFYAppendIndex` runs the default-deny code. |
| | Anything else | It runs older code, and variant spellings of the private paths reach S3. |

Then start where the table below says:

| `authV2` | `/person/index.json` | `/uploads/x` | Start at |
| --- | --- | --- | --- |
| `false` | `200` or `404` | Any | [Step 1](#1-flip-authv2-and-deploy-the-site). |
| `true` | `200` or `404` | Any | [Step 2](#2-confirm-the-client), then step 3. A `404` means members cannot read the data either, so attach the gate without delay. |
| `true` | `401` | Not `401` | [Step 3](#3-attach-the-gate). The run gates `/uploads/*` in place. Then purge `/uploads/` as in [step 4](#4-optional-purge-cloudflare). |
| `true` | `401` | `401` | There is nothing to attach. Run [Verify](#verify). If `/Person/index.json` is not refused, go on to [step 5](#5-close-the-variant-paths-with-hfyappendindex). |
| `false` | `401` | Any | Every visitor is locked out of the family data. Go to [Roll back](#roll-back) now. |

## Before you start

- **Approvals.** You need io's G-prod approval, an HFY-PLN-001 gate, for two things. One is the global `authV2` flip in step 1. The other is every real run of `add-data-gate-behaviors.sh` without `--remove` in step 3, including a rerun that only gates `/uploads/*`. A go-ahead in the session is not enough for either. A real `--remove`, a Cloudflare purge or Cache Rule change in step 4, and the `HFYAppendIndex` publish in step 5 each need io's go-ahead. [`AGENTS.md`](../../AGENTS.md) lists the production operations that need io's go-ahead and the two that need G-prod approval.
- **`hfy-edge-gate` is deployed and its version is validated.** Follow [Deploy the edge functions](deploy-the-edge-functions.md). This command prints the version that step 3 will attach:

  ```sh
  aws cloudformation describe-stacks --region us-east-1 --stack-name hfy-edge-gate \
    --query "Stacks[0].Outputs[?OutputKey=='EdgeGateVersionArn'].OutputValue" --output text
  ```

  It prints `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n>`. `<n>` must be the version you invoked with synthetic viewer-request events on that page. It must have answered `401` with no cookie, `401` with a forged token, and `302` for a navigation, with `Cache-Control: private, no-store` on each.
- **The app stack `<app-stack>` and the `/auth/*` behaviors are live.** The gate checks every `io_id` against the auth edge's public keys, which it fetches through CloudFront. Without them it denies every request. Two checks:

  ```sh
  curl -s https://<site>/auth/session
  curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'
  ```

  The first prints `{"authenticated":false}`. The second prints a key ID. Run the other `authV2` checks in [Toggle a feature flag](toggle-a-feature-flag.md#check-the-prerequisites) too.
- **Operator AWS credentials** that can:
  - read and update the distribution.
  - read the `hfy-edge-gate` stack in `us-east-1`, and, for `--remove`, the outputs of `<app-stack>` in `us-west-2`.
  - list and create CloudFront response headers policies, and update `hfy-private-no-store` or `hfy-uploads-private` if one has drifted.
  - associate a Lambda@Edge version with a distribution. AWS requires `lambda:GetFunction` and `lambda:EnableReplication*` on `hfy-edge-gate`, and `iam:CreateServiceLinkedRole` the first time.

  The GitHub deploy role cannot do any of this. Step 5 also needs `cloudfront:DescribeFunction`, `GetFunction`, `UpdateFunction`, `TestFunction`, `PublishFunction` and `GetDistributionConfig`.
- **The shell's AWS Region is `us-west-2`,** the app stack's Region. `--remove` reads `<app-stack>` in the CLI's default Region. The attach run asks `us-east-1` for the gate stack itself, and CloudFront has no Region:

  ```sh
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
  ```

- **A private backup directory.** Before each real update, the script saves the distribution configuration to `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` with mode 600. That configuration includes the origin-verify header value. Leave `HFY_CF_BACKUP_DIR` unset, or point it at a private directory outside the repository.
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

  It changes nothing. On an account that has neither policy yet, it reports `(dry-run) would create response headers policy hfy-private-no-store (Cache-Control: private, no-store, override)` and `(dry-run) would create response headers policy hfy-uploads-private (Cache-Control: private, no-store, override and the nosniff + sandbox CSP security headers)`. Review the rest of the output as described in [step 3](#3-attach-the-gate).

Run every command on this page from the repository root.

## Steps

### 1. Flip authV2 and deploy the site

Skip this step if `authV2` already prints `true` in [Find your starting point](#find-your-starting-point).

Follow [Turn a flag on for everyone](toggle-a-feature-flag.md#turn-a-flag-on-for-everyone) for `authV2`: set it to `true`, copy `flags.json` into the Eleventy source, and merge the pull request to `main`. Then let `io-kit-deploy` finish its build, deploy, invalidate and smoke jobs ([Deploy a site change](deploy-a-site-change.md)).

This step does not change who can read the data. It only moves the client to the `io_id` session.

If the smoke job fails and `rollback_on_smoke_fail` restores the previous artifact, stop. The gate is not attached, so nothing else needs undoing. Before you try again, make the rollback last as described in [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). Do not go on to step 3 until a deploy run with `authV2` set to `true` has finished green.

### 2. Confirm the client

1. Confirm the published value. This prints `true`:

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   ```

2. Open a private window, which has no preview override. Sign in at `https://<site>/auth/login`, then open a person page, `https://<site>/person/?id=<gramps-id>`.
3. In DevTools > Network, select the `/person/<gramps-id>.json` request. Its request headers carry a `Cookie` header that includes `io_id`. Do not copy the cookie value anywhere.
4. Search from the navbar, which loads `/person/index.json` and `/person/search-index.json`. Results appear, and the person page's photos load.

If `/person/index.json` answered `404` in [Find your starting point](#find-your-starting-point), the data requests answer `404` here too, so results and photos cannot load. Check only their request headers in substeps 3 and 4.

If the data request has no `io_id` cookie, the page is not running the `authV2` client. Do not attach the gate. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

### 3. Attach the gate

1. Run the dry run again, against the live configuration:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --dry-run --distribution <distribution-id>
   ```

   Do not pass `--stack <app-stack>` to this script. Unlike the app behavior scripts, its `--stack` names the `us-east-1` edge-gate stack, and its default, `hfy-edge-gate`, is the deployed name. The script names the app stack with `--app-stack` instead, and only `--remove` reads it.

2. Review the output. [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts) explains the lines that every behavior script prints.
   - **The policies.** Each policy gets one line. Either it reports `(dry-run) would create response headers policy ...`, or it confirms the existing policy:
     - `response headers policy hfy-private-no-store (<policy-id>) already forces Cache-Control: private, no-store`
     - `response headers policy hfy-uploads-private (<uploads-policy-id>) already forces Cache-Control: private, no-store and the nosniff + sandbox CSP security headers`

     If a line says `would put response headers policy <name> (<id>) back`, someone changed that policy. The real run will restore it.
   - **The version.** The plan line is `gating /person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/* on origin <origin-id> with arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n> (CachingDisabled, response headers policy <policy-id>: Cache-Control: private, no-store; /uploads/* keeps its origin and gets policy <uploads-policy-id>)`. It names the S3 origin of the default behavior and the version `<n>`, which must be the one you validated. If the stack has a newer version than that, stop and validate that version first. A dry run that has not created a policy yet shows a placeholder for its ID, such as `<new hfy-uploads-private policy id>`.
   - **The position.** In the `cache behaviors after (in evaluation order)` line, the six data patterns follow the existing behaviors, each pointing at `<origin-id>`. The exception is an existing broader behavior that would also match a gated path, such as a legacy `/person/*`. The gated pattern then sits immediately before it. `/uploads/*` keeps its position and its origin. No other behavior moves.
   - **The diff, on a first attach.** It adds six behaviors and raises `CacheBehaviors.Quantity` by 6. Each new behavior allows `GET` and `HEAD` only. Its `CachePolicyId` is `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` (CachingDisabled), and its `ResponseHeadersPolicyId` is the `hfy-private-no-store` policy. Each has one `LambdaFunctionAssociations` item: `EventType` `viewer-request`, `IncludeBody` `false`, and the versioned ARN. `FunctionAssociations` is empty.

     The diff also modifies `/uploads/*` in place, and changes three of its fields:
     - `LambdaFunctionAssociations` gains the same item.
     - `CachePolicyId` changes from `658327ea-f89d-4fab-a63d-7e88639e58f6` (CachingOptimized) to CachingDisabled.
     - `ResponseHeadersPolicyId` changes from the app stack's `UploadsResponseHeadersPolicyId` to `hfy-uploads-private`.

     If the distribution has no `/uploads/*` behavior, the diff adds one instead, already gated, and `CacheBehaviors.Quantity` rises by 7. Nothing else changes.
   - **The diff, with the six data behaviors already attached.** It modifies only `/uploads/*`, as above. If it also changes the version number at the end of the six data behaviors' `LambdaFunctionARN`, the stack holds a newer version than the one attached. Validate it first, as in [Ship a change to the gate](deploy-the-edge-functions.md#ship-a-change-to-the-gate).
   - **Stop if the diff changes an existing behavior with one of the six data patterns** instead of adding one. The script would take that behavior over, and `--remove` would later delete it rather than restore it.
   - **Stop if the diff changes any other field of `/uploads/*`,** such as its origin, methods or viewer protocol. That behavior was not made by [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh), and `--remove` puts back only the association, the cache policy and the response headers policy.

3. Apply it:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id>
   ```

   The real run does not ask for confirmation, so the dry run is your review. It reads the live configuration again, and its diff should match the dry run's.

   It creates each policy that is missing, and prints a line for each. One is `created response headers policy hfy-private-no-store (<policy-id>): Cache-Control: private, no-store, override`. The other is `created response headers policy hfy-uploads-private (<uploads-policy-id>): Cache-Control: private, no-store, override and the nosniff + sandbox CSP security headers`.

   It then saves the pre-change configuration and prints `saved the pre-change DistributionConfig to <backup>` and a `roll back with: aws cloudfront update-distribution ...` command. Last, it prints the distribution status, `InProgress`. Note the backup path.

4. Wait for the distribution:

   ```sh
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   A Lambda@Edge association takes several minutes to replicate. The command returns with no output once the distribution is deployed. If it times out, run it again.

From then on, a request for any of the seven gated patterns without a valid `io_id` gets a `401` or a sign-in redirect.

### 4. Optional: purge Cloudflare

Cloudflare proxies `<site>` in front of CloudFront, and it caches by file extension whatever CloudFront's cache policy says. That covers the images, SVG and PDF files under `/media/`, and the photos under `/uploads/`, which the ungated `/uploads/*` served with CachingOptimized. JSON is not cached by default. Any response Cloudflare cached before step 3 keeps being served from Cloudflare until its TTL ends, and those requests never reach the gate. A purge removes those copies now. New responses carry `Cache-Control: private, no-store`, which Cloudflare does not store. A purge needs io's go-ahead.

- **In the dashboard:** use Caching > Configuration > Custom Purge > Prefix and enter the seven prefixes below.
- **With the API:**

  ```sh
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    --data '{"prefixes":["<site>/person/","<site>/family/","<site>/event/","<site>/note/","<site>/place/","<site>/media/","<site>/uploads/"]}'
  ```

  In the JSON response, `success` is `true`.

If you are only gating `/uploads/*` on a distribution whose data paths were already gated, the `<site>/uploads/` prefix is enough. If `www.<site>` serves the site, add the same prefixes for it. If your plan has no prefix purge, use Purge Everything. The static site refills from CloudFront.

Never add a Cloudflare Cache Rule that overrides the edge TTL on these paths. The `private, no-store` header works only while Cloudflare honors the origin's `Cache-Control`. A Cache Rule that sets "Bypass cache" for the seven prefixes, `/uploads/` included, is optional extra protection. It is configured in the Cloudflare dashboard, outside this repository, and changing it needs io's go-ahead.

### 5. Close the variant paths with HFYAppendIndex

The gate sees only requests that match its patterns. CloudFront path patterns are case-sensitive, and `/person/*.json` is anchored on its suffix. So a variant spelling of a private path matches no gated behavior and falls through to the default behavior, which reaches S3. Examples are `/Person/index.json`, `/person/<gramps-id>.JSON` and `/Media/<file>`. The default-deny code of `HFYAppendIndex`, the default behavior's CloudFront Function, answers those with `404` and `Cache-Control: private, no-store`. [Why the CloudFront Function also denies](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains the design.

Publish it only after step 3 is done and verified. The function also refuses the exact data paths. Only the gated behaviors keep requests for them from reaching it. Published while the gate is not attached, it answers `404` to every request for person, search and media data, members included.

If `/Person/index.json` already answered `404` with `cache-control: private, no-store` in [Find your starting point](#find-your-starting-point), the function is in place. Otherwise follow [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md).

## Verify

Signed out, from a shell with no cookies:

1. The search manifest is refused, and the answer is not stored:

   ```sh
   curl -sS -o /dev/null -D - https://<site>/person/index.json
   ```

   The status is `401`, with `cache-control: private, no-store`.
2. Every gated prefix is refused. The gate answers before the request reaches the bucket, so a path that does not exist also gets `401`:

   ```sh
   for p in person/index.json family/x event/x note/x place/x media/x uploads/x; do
     printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"
   done
   ```

   Each line ends in `401`. The person page shell stays public, so `curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/` prints `200`.
3. Cloudflare does not serve a stored copy. While signed in, use DevTools to take two URLs. One is a `/media/` URL from a person page. The other is a photo URL, `/uploads/posts/<ulid>/<name>`, from a post on the home page or `/posts/`. Then request each twice without a cookie:

   ```sh
   for u in "https://<site>/media/<file>" "https://<site>/uploads/posts/<ulid>/<name>"; do
     for i in 1 2; do
       curl -sS -o /dev/null -D - "$u" | grep -iE '^(HTTP|cache-control|cf-cache-status)'
     done
   done
   ```

   Every answer is `401`, and `cf-cache-status` is never `HIT`. The URLs name private files, so do not record them in a worklog.
4. A navigation is sent to sign-in:

   ```sh
   curl -sS -o /dev/null -D - -H 'Sec-Fetch-Mode: navigate' https://<site>/person/index.json \
     | grep -iE '^(HTTP|location|cache-control)'
   ```

   The status is `302`, with `location: /auth/login?returnTo=%2Fperson%2Findex.json` and `cache-control: private, no-store`.
5. After step 5, variant spellings are refused too, and public pages are not:

   ```sh
   for p in Person/index.json PERSON/index.json person/index.json/ Media/x Uploads/x; do
     printf '/%s: ' "$p"
     curl -sS -o /dev/null -D - "https://<site>/$p" | grep -iE '^(HTTP|cache-control)' | tr -d '\r' | paste -sd ' ' -
   done
   for p in about/ person/; do printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"; done
   ```

   Each variant answers `404` with `cache-control: private, no-store`. `/about/` and `/person/` print `200`.

Signed in, in the private window from step 2:

1. Reload the person page. The data, search and photos load. On the home page or `/posts/`, post photos load.
2. In DevTools > Network, check the response headers of three requests: `/person/<gramps-id>.json`, a `/media/` file and an `/uploads/` photo. Each shows `cache-control: private, no-store`, and `cf-cache-status` is `DYNAMIC` or `BYPASS`. The `/uploads/` photo also shows `content-security-policy: sandbox; default-src 'none'; img-src 'self'` and `x-content-type-options: nosniff`.
3. `io_id` lives one hour. More than an hour after you signed in, reload a person page in the same window. The Network panel shows `POST /auth/refresh` answering `200`, the data requests succeed, and the page does not go to `/auth/login`. The client sends a visitor to `/auth/login?returnTo=...` only when that refresh fails.

## Roll back

The 2026-10-12 cutover attached the gate in production. So these rules apply to any production rollback, not only to one during a cutover. Run [Find your starting point](#find-your-starting-point) first to see the current state.

Roll back in reverse order: the gate first, then the flag, and the flag only if it is at fault. Two cases call for something other than a plain gate removal:

- **A bad gate version.** If a new version of the gate refuses members, point the behaviors back at a retained earlier version, as in [Deploy the edge functions](deploy-the-edge-functions.md#roll-back). The data stays gated throughout.
- **`HFYAppendIndex` runs the default-deny code.** That is the case when `/Person/index.json` answers `404` with `cache-control: private, no-store`. Removing the gate then does not make the family data readable. The six data paths fall through to the default behavior, and the function answers `404` to every request for them, from every client. The exception is a path that a legacy CloudFront behavior, such as `/person/*`, matches first: that behavior serves it to anyone. Member photos keep their own `/uploads/*` behavior and become public. To make the data readable without the gate, also roll the function back to its earlier code, as in [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md). The `roll back with:` commands that `publish-append-index.sh` printed when it published name the saved copy of that code. A function rollback needs io's go-ahead too.

1. **Remove the gate.** Do a dry run first:

   ```sh
   export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id> --app-stack <app-stack>
   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id> --app-stack <app-stack>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   `--app-stack <app-stack>` names the stack whose output `UploadsResponseHeadersPolicyId` `/uploads/*` gets back. The script reads it in the CLI's default Region, so the Region must be `us-west-2`. Its default, `hfy-app`, is not the live stack's name. While `/uploads/*` is gated, a run without `--app-stack <app-stack>` or `--restore-uploads-policy-id <id>` exits `1`, the dry run included. It prints `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing. Pass the flag on every production `--remove`. It costs nothing when `/uploads/*` is not gated. Do not pass `--stack <app-stack>`: `--stack` names the `us-east-1` gate stack, and `--remove` does not read it.

   Review the dry run's diff:
   - It removes the six data behaviors, and only ones that carry an `hfy-edge-gate` association. `CacheBehaviors.Quantity` falls by 6.
   - If `/uploads/*` is gated, the diff modifies it in place. `LambdaFunctionAssociations` goes to a `Quantity` of 0. `CachePolicyId` goes back to `658327ea-f89d-4fab-a63d-7e88639e58f6` (CachingOptimized). `ResponseHeadersPolicyId` goes back to the app stack's `UploadsResponseHeadersPolicyId`. The script never deletes `/uploads/*`.
   - No other behavior changes.

   If nothing is gated, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/*) and /uploads/* back to its ungated state: no change`.

   Like any real update, the real run saves a backup first. Once the distribution is deployed, `/uploads/*` serves photos to anyone who holds a URL, and Cloudflare caches them again. The six data paths are served from the bucket to anyone again, as before the release, unless `HFYAppendIndex` runs the default-deny code (above). The `hfy-private-no-store` and `hfy-uploads-private` policies are kept, unused. The `hfy-edge-gate` stack can stay too. CloudFront deletes the version's replicas some hours after its last association is removed.

   The alternative to `--remove` is to restore the backup that the last real attach run saved, with the distribution's current ETag:

   ```sh
   ETAG="$(aws cloudfront get-distribution-config --id <distribution-id> --query ETag --output text)"
   aws cloudfront update-distribution --id <distribution-id> --if-match "$ETAG" \
     --distribution-config file://<backup>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   That restores the whole configuration as it was before that run, so any distribution change made since then is lost as well. Prefer `--remove`. The backup holds the origin-verify value, so delete it once you no longer need it.
2. **Only after that, and only if the `authV2` client itself is at fault,** set `authV2` back to `false` and deploy ([Toggle a feature flag](toggle-a-feature-flag.md#roll-back)). Never turn `authV2` off while the gate is attached. A page with `authV2` off never refreshes `io_id`, and the legacy Google sign-in that used to be the way back no longer exists (HFY-TSK-317), so the gate refuses its data requests once the hour is up, and person pages, search and photos fail. Under the default-deny `HFYAppendIndex`, no client can read the data until the function is rolled back as well.

> **Warning: an automatic site rollback counts as turning `authV2` off.** While the gate is attached, any deploy that fails its smoke check can do this. `rollback_on_smoke_fail` restores the artifact of the last successful deploy run, with the `flags.json` of the commit that run deployed. After any automatic rollback, run `curl -s https://<site>/_data/flags.json | jq .authV2`. If it does not print `true`:
>
> - **If `HFYAppendIndex` runs older code,** remove the gate at once (rollback step 1). The data is then readable.
> - **If it runs the default-deny code,** removing the gate does not give that client its data back. Instead, get a release with `"authV2": true` deployed again by fixing forward or reverting, as in [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). The other way out is to remove the gate and roll the function back as well.

## If something fails

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| `stack hfy-edge-gate has no output EdgeGateVersionArn` | The gate stack is not deployed in `us-east-1`, or your credentials cannot read it there. | Deploy it as in [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |
| `version ARN must be a qualified us-east-1 ARN of hfy-edge-gate ...` or `version ARN must end in a numeric version ...` | `--version-arn` names `$LATEST`, an unqualified ARN or another function. CloudFront accepts only a published version. | Drop `--version-arn` so the script reads the stack output, or pass the full versioned ARN. |
| `origin '<origin-id>' is not in distribution <distribution-id> (pass --origin-id)` | The origin the script picked is not one of the distribution's origins. | Pass the S3 origin's ID with `--origin-id`. |
| `refusing to update from --config-file ...` | An exported configuration can drive a dry run only. | Drop `--config-file`. |
| `create-response-headers-policy hfy-private-no-store returned no id`, the same for `hfy-uploads-private`, or an `AccessDenied` error from a CloudFront call | The credentials lack a permission listed in [Before you start](#before-you-start). | Fix the credentials and run the script again. |
| `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back`, often after `stack hfy-app has no output UploadsResponseHeadersPolicyId` or an AWS error that the stack does not exist | `--remove` found `/uploads/*` gated, but could not read `UploadsResponseHeadersPolicyId` from the stack that `--app-stack` names (default `hfy-app`) in the CLI's default Region. Nothing changed. | Pass `--app-stack <app-stack>` with the Region set to `us-west-2`, or name the policy with `--restore-uploads-policy-id <id>`. |
| `PreconditionFailed` from `update-distribution` | The distribution changed after the script read it. | Run the dry run again, review it, then apply. |
| Person, search and media data answer `404` with `cache-control: private, no-store` for everyone, signed in or not | The gated data behaviors are missing, and `HFYAppendIndex` runs the default-deny code. | With `authV2` set to `true`, attach the gate ([step 3](#3-attach-the-gate)). Otherwise see [Roll back](#roll-back). |
| Members get `401` or keep being sent to sign-in after step 3 | A session or key problem. When the gate rejects a cookie, it logs `edge-gate: deny <reason>` in CloudWatch Logs, under `/aws/lambda/us-east-1.hfy-edge-gate` in the region of the edge location that served the request. A request with no cookie is denied without a log line. | If a new gate version is at fault, point the behaviors back at the previous one ([Deploy the edge functions](deploy-the-edge-functions.md#roll-back)). Otherwise follow [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#person-search-or-photo-data-is-refused-data-gate). Remove the gate only as described in [Roll back](#roll-back). |

Every run of the script is safe to repeat. Against a distribution that already matches, an attach run prints `distribution <distribution-id> already has the data-gate behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/*) on <version ARN> with response headers policies <policy-id> and <uploads-policy-id>: no change`. It makes no update.

## Related pages

- [Toggle a feature flag](toggle-a-feature-flag.md): the `authV2` flip and its rollback.
- [Roll back a site deploy](roll-back-a-site-deploy.md): what the automatic rollback restores, and how to make a rollback last.
- [Deploy the edge functions](deploy-the-edge-functions.md): build, deploy and validate `hfy-edge-gate`, and move the behaviors to another version.
- [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md): publish `HFYAppendIndex`, and roll it back.
- [System architecture](../reference/architecture.md#request-routing): the distribution's behaviors, their order and the custom response headers policies.
- [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts): the behavior scripts' options, output and exit statuses.
- [Identity services](../reference/identity-services.md): the `io_id` session, `/auth/refresh` and the data gate.
- [Front end](../reference/front-end.md): how the `authV2` client fetches data with the cookie and refreshes the session.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the data and the photos are gated, and what a rollback exposes.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md): symptom-first fixes, including the data gate.
