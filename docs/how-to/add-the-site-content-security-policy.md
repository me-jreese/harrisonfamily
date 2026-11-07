# Add the site Content-Security-Policy

Give the HTML pages a Content-Security-Policy that allows no third-party image, connection or script, report-only first and then enforced. This is HFY-TSK-149 (review PS-11, requirements R-18 and R-01). It needs io's go-ahead at each step that touches production (gate G-csp), and nothing here has been run against production by the repository.

Values in angle brackets are placeholders. `<app-stack>` is the live app stack (not the template default `hfy-app`), and `<distribution-id>` is the CloudFront distribution.

## What it is

- **One policy, written once** in [`scripts/cloudfront/site-csp.json`](../../scripts/cloudfront/site-csp.json): `default-src 'self'`; `img-src 'self' data: blob:`; `connect-src 'self' https://<upload-bucket>.s3.<region>.amazonaws.com` (the second source is the presigned-upload host, see [The upload host in `connect-src`](#the-upload-host-in-connect-src); the chat island's same-origin WebSocket, `/chat/ws`, matches `'self'` in browsers that follow CSP3; Safari before about 15.4 does not match `wss:` to `'self'`, so chat would fail there once enforced. No explicit `wss://<host>` source is added because the host would be hardcoded here; add one if io wants those clients covered); `frame-ancestors 'none'`. `script-src` and `style-src` also allow `'unsafe-inline'`, because every page carries the inline shell-hint head script and the feature-flag block. **This weakens the policy: it does not mitigate inline-script XSS, and the task's list (default-src, img-src, connect-src, frame-ancestors) did not name it. Surface it to io at the G-csp go-ahead, and track a follow-up to move to hashes or nonces.**
- **Two response headers policies** in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml): `SiteCspReportOnlyPolicy` sends `Content-Security-Policy-Report-Only`, and `SiteCspPolicy` sends `Content-Security-Policy`. Exactly one is attached, to the **default** cache behavior, which serves the HTML pages. No cache behavior and no path prefix is added.
- **`/join/` is the one exception: Turnstile loads there and nowhere else.** A response headers policy cannot differ by path without a new behavior, so the stack also holds `JoinCspFunction` ([`join-csp.js`](../../scripts/cloudfront/join-csp.js), a viewer-response CloudFront Function). Under `/join` and `/join/*` it swaps the policy's header for the variant that adds `https://challenges.cloudflare.com` to `script-src`, `connect-src` and `frame-src`. With no policy attached it does nothing.
- **Unverified assumption, hard-gated.** The swap works only if CloudFront runs the viewer-response function after the response headers policy has added its header. The repository cannot prove that order. If it is the other way round, `/join/` keeps the base policy: harmless in report-only, but enforcing it blocks Turnstile and breaks sign-up. So `add-csp-headers.sh --mode enforce` refuses to run without `--site-url` and a live probe of `/join/` that shows the Turnstile variant in `Content-Security-Policy-Report-Only`. If the probe fails, stop and ask io; the fallback is a real `/join/*` cache behavior with its own policy, which is io's decision.
- **Unchanged:** the `/uploads/*` sandbox policy (`UploadsResponseHeadersPolicy`, `hfy-uploads-private`), the six gated data behaviors, and `HFYAppendIndex` (still the viewer-request function of the default behavior).

## Before you start

1. The repository checks pass: `bash scripts/infra/test/run.sh`, which includes `node --test scripts/cloudfront/test/*.test.mjs` and the template checks.
2. The report-only crawl passes against the committed site, with a free port between 18100 and 18999:

   ```sh
   cd islands
   PW_CHANNEL=chromium-headless-shell PW_PORT=<port> npx playwright test tests/csp-crawl.spec.mjs --workers=1
   ```

   It opens every page at 375 and 1280, signed in and signed out, with every flag on through `?hfy_flags`, and fails on any violation. Two control tests prove it would notice a third-party image, connection or script. Afterwards `pgrep -fl playwright_chromiumdev_profile` prints nothing.
3. The app stack carries the new resources. Deploy it as in [Deploy the app stack](deploy-the-app-stack.md); the change set adds `SiteCspReportOnlyPolicy`, `SiteCspPolicy` and `JoinCspFunction` and the outputs `SiteCspReportOnlyPolicyId`, `SiteCspPolicyId` and `JoinCspFunctionArn`, and replaces nothing.

## Stage 1: report-only

```sh
scripts/infra/add-csp-headers.sh --mode report-only --stack <app-stack> --distribution <distribution-id> --dry-run
scripts/infra/add-csp-headers.sh --mode report-only --stack <app-stack> --distribution <distribution-id>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The diff must touch only the default behavior: a `ResponseHeadersPolicyId` and one `viewer-response` function association, with `HFYAppendIndex` still listed as `viewer-request`. The script stops, and changes nothing, if the default behavior already has a response headers policy that is not one of ours, or another `viewer-response` function (CloudFront allows one per event). A rerun prints `no change`. The pre-change config is saved under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` and the command prints the rollback.

Probe, with a fetch of a versioned URL or a query string so Cloudflare's copy is not what you read:

```sh
for p in / /person/ /join/ /chat/; do echo "== $p"; curl -sSI "https://<site>$p?csp=1" | grep -i '^content-security-policy'; done
```

Each page shows `content-security-policy-report-only`, and `/join/` shows the variant with `challenges.cloudflare.com`. If `/join/` shows the base policy, the response headers policy was applied after the function; stop and tell io (the base policy would block Turnstile once enforced). This probe is the hard gate for stage 2, and the enforce script repeats it.

What report-only can and cannot tell you:

- **No report endpoint.** The policies carry no `report-uri` or `report-to`, so live report-only collects nothing. The live check is a real browser loading the pages signed out: [Live check](#live-check) runs it. A person with the console open still covers what it cannot: signed-in pages and a hand-completed Turnstile widget on `/join/`. Adding an endpoint needs io's decision.
- **`frame-ancestors` is ignored in report-only** (browsers log a console warning), so neither report-only nor the crawl can show it. Before enforcing, check by hand that nothing frames the site; `X-Frame-Options` is not sent.
- **Chat WebSocket.** The crawl stubs the chat network, so check `/chat/` signed in by hand for a blocked `wss:` connection. Leave it in report-only for as long as io wants real traffic to be watched.

## Live check

Ruling P2-R81 allows enforcing only after at least 24 hours with zero blocking reports on `/join/` and the sign-in paths. [`check-csp-live.mjs`](../../scripts/infra/check-csp-live.mjs) makes that check repeatable (HFY-TSK-366). From the repository root, with `npm ci` done in `islands/` and the bundled shell installed (`cd islands && npx playwright install chromium-headless-shell`):

```sh
node scripts/infra/check-csp-live.mjs                                  # the default pages on the default site
node scripts/infra/check-csp-live.mjs --site https://<site> --pages /join/,/auth/login --json
```

It opens each page signed out at 375 and 1280 wide, in a fresh browser context each time, in Playwright's bundled headless shell (never system Chrome). It waits for `load`, then about 3 seconds of idle. It prints one table (page, width, HTTP status, which CSP header the final document carried, violation counts, where a redirect landed) and, as its last line, a machine-readable JSON line with the same per-page counts and the violations grouped by page, directive and blocked host. `--json` prints only that line. It only loads pages: it never signs in, types, clicks or submits (it aborts any non-GET document navigation), and it leaves the Turnstile widget on `/join/` alone.

- **Exit `0`** only when every page loaded (HTTP 200, at the page itself or at the sign-in pages, `/family-login/` or `/logged-out/` after a redirect), under a CSP header, with zero violations. Exit `1` means a page failed that test, and the table and the JSON line say which. Exit `2` is a usage or setup error (Playwright or the shell is missing).
- **A violation** is a `securitypolicyviolation` event on a page of the site, with its effective directive, the blocked host (or `inline`, `eval`, `data:`, `blob:`) and its disposition. `report` is what the report-only policy would block once enforced: it blocks nothing today. `enforce` was blocked by an enforced policy already, such as the sign-in pages' own header. The console column counts Chrome's violation lines; other CSP console notes, such as `frame-ancestors` being ignored in report-only, are counted apart and do not fail the run. Events from another origin's frame (Turnstile's own iframe) follow that frame's policy, not ours, so they are counted apart too.
- **`--ignore-host <host>`** (repeatable, default none) leaves out violations whose blocked host is exactly `<host>`, and the console lines naming it. The scheduled enforce gate passes `--ignore-host static.cloudflareinsights.com`, the one known benign violation (ruling P2-R88): the Cloudflare Web Analytics beacon that Cloudflare injects at its edge. Pass nothing else without a ruling.
- **Read each violation before enforcing.** For every row, decide whether enforcing would break something a visitor sees (an image, a map tile, the Turnstile widget on `/join/`, a font) or only silences a beacon, and record that on the task. Either add the source to [`site-csp.json`](../../scripts/cloudfront/site-csp.json) as in [When a page needs a new source](#when-a-page-needs-a-new-source), or remove what injects it.
- **Run it more than once.** One run is a snapshot. Run it repeatedly across the 24 hours and keep each result in the task's worklog.
- **What it cannot see:** signed-in pages, `frame-ancestors` (ignored in report-only), a violation in a worker or a service worker's own context, and anything that happens only after a click. A zero from this script is the signed-out half of the check, not all of it.

## Stage 2: enforce

Only after the crawl is at zero violations, the [live check](#live-check) exits `0` across the P2-R81 window, the manual console check above is clean, and io says to enforce. `--site-url` is the gate probe (the script refuses without it):

```sh
scripts/infra/add-csp-headers.sh --mode enforce --stack <app-stack> --distribution <distribution-id> --site-url https://<site> --dry-run
scripts/infra/add-csp-headers.sh --mode enforce --stack <app-stack> --distribution <distribution-id> --site-url https://<site>
```

Repeat the probe: `content-security-policy` now appears on `/`, `/person/`, `/join/` and `/chat/`, and `/uploads/*` still shows its own sandbox policy.

## Roll back

```sh
scripts/infra/add-csp-headers.sh --mode detach --stack <app-stack> --distribution <distribution-id> --dry-run
scripts/infra/add-csp-headers.sh --mode detach --stack <app-stack> --distribution <distribution-id>
```

This takes the policy and the `/join/` function off the default behavior, and the distribution is back to its earlier config. The saved pre-change file works too: `aws cloudfront update-distribution --id <distribution-id> --if-match <current ETag> --distribution-config file://<backup>`. Record which stage was live, and when, in the task's worklog.

## The upload host in `connect-src`

The browser sends every member photo (portrait, suggested photo, added photo, post and comment photos) with a `PUT` straight to a presigned S3 URL that `POST /api/uploads` returns ([`islands/src/lib/upload.js`](../../islands/src/lib/upload.js)). The URL's host is the virtual-hosted form `https://<upload-bucket>.s3.<region>.amazonaws.com`: `<upload-bucket>` is the site bucket the stack's `MediaBucket` parameter names, and `<region>` is the region of `hfy-api` and of that bucket. With `connect-src 'self'` alone the browser blocks that `PUT` (a `connect-src` violation), the presign succeeds, and every upload fails. So `connect-src` names that one origin: https only, one host, no wildcard. Nothing else is allowed (the bucket's CORS rule, `scripts/infra/check-site-bucket-cors.sh`, is a separate check that stays in force).

`site-csp.json` holds the origin in `base` as the literal CloudFormation expression `https://${MediaBucket}.s3.${AWS::Region}.amazonaws.com`, so no bucket name is written in the repository. `app-stack.yaml` carries `base` as a `!Sub` string in `SiteCspPolicy` and `SiteCspReportOnlyPolicy`, which composes the host from the parameter and the stack region; the tests and the crawl resolve the two names themselves. The `/join/` variant has no such origin, because nothing on `/join/` uploads. Images shown after an upload are read from the site's own `/uploads/*`, so `img-src` needs no change. The chat WebSocket is unaffected (the same-origin `/chat/ws`, covered by `'self'`).

If the bucket or the Lambda region ever changes, the Lambda signs a different host: the policy follows the `MediaBucket` parameter and the stack region, so confirm the presign's host after such a change with a real upload.

## When a page needs a new source

Change [`site-csp.json`](../../scripts/cloudfront/site-csp.json), the two policy strings in `app-stack.yaml` (each a `!Sub` of `base`) and the `JOIN_CSP` string in `join-csp.js` together; `site-csp.test.mjs` and `test_app_stack.py` fail until they agree. Keep each policy's `Comment` at 128 characters or fewer: CloudFront refuses a longer one only when the change set creates the policy, so template validation and `cfn-lint` pass it and the update fails and rolls back; `test_app_stack.py` (`CreateTimeLimits`) catches it offline. Then run the crawl, update the stack, and step through report-only again. The v3 map's `worker-src 'self'` went in this way (`viz-v3-csp-worker`).

## The worker-src stage (HFY-TSK-310, viz-v3-csp-worker)

`worker-src 'self'` is in `site-csp.json`, both policies in `app-stack.yaml` and `join-csp.js`. It reaches production in two steps, both under gate G-csp:

1. **Report-only.** Update the app stack (the report-only policy now carries the directive), attach it with `add-csp-headers.sh --mode report-only`, and probe: `curl -sSI "https://<site>/?csp=1" | grep -i '^content-security-policy-report-only'` shows `worker-src 'self'`. The crawl (`tests/csp-crawl.spec.mjs`) must stay at zero violations, and its worker control shows a same-origin module worker passes while a `blob:` worker is reported. Soak with the console open on the map view once the flag is on.
2. **Enforce.** Only with io's go-ahead, recorded verbatim in the task: `add-csp-headers.sh --mode enforce --site-url https://<site>`, then `curl -sSI "https://<site>/?csp=1" | grep -i '^content-security-policy:'` must show `worker-src 'self'`.

**Rollback** (record it in the PR body): `add-csp-headers.sh --mode detach` removes the policy from the default behavior; to return to the previous header policy instead, revert the commit, update the app stack, and re-run the attach for the stage that was live. The pre-change distribution config backup also restores it.
