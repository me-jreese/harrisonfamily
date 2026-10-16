# Add the site Content-Security-Policy

Give the HTML pages a Content-Security-Policy that allows no third-party image, connection or script, report-only first and then enforced. This is HFY-TSK-149 (review PS-11, requirements R-18 and R-01). It needs io's go-ahead at each step that touches production (gate G-csp), and nothing here has been run against production by the repository.

Values in angle brackets are placeholders. `<app-stack>` is the live app stack (not the template default `hfy-app`), and `<distribution-id>` is the CloudFront distribution.

## What it is

- **One policy, written once** in [`scripts/cloudfront/site-csp.json`](../../scripts/cloudfront/site-csp.json): `default-src 'self'`; `img-src 'self' data: blob:`; `connect-src 'self'`; `worker-src 'self'` (HFY-TSK-310: MapLibre 6's separate ESM module worker is same-origin, so `blob:` is not allowed; without the directive workers fall back to `script-src`, so this makes the need explicit and keeps a `blob:` worker reported; see "The worker-src stage" below) (the chat island's same-origin WebSocket, `/chat/ws`, matches `'self'` in browsers that follow CSP3; Safari before about 15.4 does not match `wss:` to `'self'`, so chat would fail there once enforced. No explicit `wss://<host>` source is added because the host would be hardcoded here; add one if io wants those clients covered); `frame-ancestors 'none'`. `script-src` and `style-src` also allow `'unsafe-inline'`, because every page carries the inline shell-hint head script and the feature-flag block. **This weakens the policy: it does not mitigate inline-script XSS, and the task's list (default-src, img-src, connect-src, frame-ancestors) did not name it. Surface it to io at the G-csp go-ahead, and track a follow-up to move to hashes or nonces.**
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

- **No report endpoint.** The policies carry no `report-uri` or `report-to`, so live report-only collects nothing. The live check is a person opening the pages with the browser console open (including `/join/` with the real Turnstile widget, which the crawl only stubs) and reading the violation messages. Adding an endpoint needs io's decision.
- **`frame-ancestors` is ignored in report-only** (browsers log a console warning), so neither report-only nor the crawl can show it. Before enforcing, check by hand that nothing frames the site; `X-Frame-Options` is not sent.
- **Chat WebSocket.** The crawl stubs the chat network, so check `/chat/` signed in by hand for a blocked `wss:` connection. Leave it in report-only for as long as io wants real traffic to be watched.

## Stage 2: enforce

Only after the crawl is at zero violations, the manual console check above is clean, and io says to enforce. `--site-url` is the gate probe (the script refuses without it):

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

## When a page needs a new source

Change [`site-csp.json`](../../scripts/cloudfront/site-csp.json), the two policy strings in `app-stack.yaml` and the `JOIN_CSP` string in `join-csp.js` together; `site-csp.test.mjs` and `test_app_stack.py` fail until they agree. Then run the crawl, update the stack, and step through report-only again. The v3 map's `worker-src 'self'` went in this way (`viz-v3-csp-worker`).

## The worker-src stage (HFY-TSK-310, viz-v3-csp-worker)

`worker-src 'self'` is in `site-csp.json`, both policies in `app-stack.yaml` and `join-csp.js`. It reaches production in two steps, both under gate G-csp:

1. **Report-only.** Update the app stack (the report-only policy now carries the directive), attach it with `add-csp-headers.sh --mode report-only`, and probe: `curl -sSI "https://<site>/?csp=1" | grep -i '^content-security-policy-report-only'` shows `worker-src 'self'`. The crawl (`tests/csp-crawl.spec.mjs`) must stay at zero violations, and its worker control shows a same-origin module worker passes while a `blob:` worker is reported. Soak with the console open on the map view once the flag is on.
2. **Enforce.** Only with io's go-ahead, recorded verbatim in the task: `add-csp-headers.sh --mode enforce --site-url https://<site>`, then `curl -sSI "https://<site>/?csp=1" | grep -i '^content-security-policy:'` must show `worker-src 'self'`.

**Rollback** (record it in the PR body): `add-csp-headers.sh --mode detach` removes the policy from the default behavior; to return to the previous header policy instead, revert the commit, update the app stack, and re-run the attach for the stage that was live. The pre-change distribution config backup also restores it.
