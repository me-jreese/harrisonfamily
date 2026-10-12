# How to turn a feature flag on for one tab or for everyone

Each E5 surface ships behind a flag in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), where it starts as `false`. This page covers these tasks:

- Checking that everything a flag depends on is in production.
- Turning a flag on, or forcing it off, in one browser tab with the preview override, and checking the result.
- Turning a flag on for every visitor by changing that file, and checking the result.
- Rolling back, in one tab or for everyone.
- Keeping the Eleventy source's copy of `flags.json` identical to the repository's.

`authV2` is the one flag whose global flip belongs to a larger change. Turning it on for everyone is step 1 of [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). Once the gate is attached, turning it off takes a CloudFront change first.

The [front-end reference](../reference/front-end.md#feature-flags) lists the flags, what each one loads and the override rules. [The release model](../explanation/release-model.md) explains why a deploy and a flag are separate switches, why the override is limited to one tab, and why the gate ties `authV2` to a fixed order.

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<app-stack>`, `<distribution-id>` and `<gramps-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's G-prod approval, for a global flip.** A global flip is any change to `11ty/_data/flags.json` that reaches `main`. [`AGENTS.md`](../../AGENTS.md) lists it among the operations that need G-prod approval (an HFY-PLN-001 gate), not only a go-ahead in the session, and the plan gates each flip on its after-state audit. The preview override in one tab is not a global flip.
- **For `authV2` for everyone, start from the cutover.** Follow [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). Its step 1 is the global flip on this page. It then confirms the client and only after that attaches the gate (HFY-R67).
- **Everything the surface depends on is in production.** A flag only tells the browser which surface to use. The table lists what each flag needs, and [Check the prerequisites](#check-the-prerequisites) checks it.

| Flag | Needs in production |
| --- | --- |
| `shellV2`, `searchV2`, `personV2`, `postsV2`, `notifyV2` | The island bundles under `/js/islands/`. They are committed in `11ty/js/islands/` and every deploy ships them, so they are present unless a deploy failed. Before a flip that comes with island changes, `(cd islands && npm run check:islands)` must print `11ty/js/islands is up to date`. |
| `personV2`, `postsV2`, `notifyV2` | The app stack `<app-stack>` (the `hfy-api` function and the `hfy-app` table) and the CloudFront `/api/*` behavior from [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh). Every API route requires a session issued by the auth edge, so everything in the `authV2` row is needed too, even while `authV2` is off. |
| `postsV2` | The CORS rule in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) on `<site-bucket>`, so browsers can `PUT` post photos straight to S3, and the `/uploads/*` behavior from [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh), so photos are served with their safety headers. Both are manual steps in [Deploy the app stack](deploy-the-app-stack.md). |
| `notifyV2` | Preferences can be saved without it, but push is sent only when the `<app-stack>` parameter `VapidSecretName` names a VAPID key pair, the secret `harrisonfamily/api/vapid` in production ([Turn on push notifications](turn-on-push-notifications.md)). |
| `authV2` | `hfy-auth-edge` from `<app-stack>`; the `/auth/*` and `/.well-known/oauth-authorization-server*` behaviors from [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh); the session signing key from [`create-session-key.sh`](../../scripts/infra/create-session-key.sh); and the origin-verify secret from [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh), which the `/api/*` behavior also uses. The data gate is not a prerequisite. It is attached after the flip, in step 3 of the cutover. |

`searchV2` turns `shellV2` on as well, because the search launcher lives in the shell. Check the shell's prerequisites for search too.

What a visitor sees when a piece is missing:

- **A missing island bundle.** The page keeps its legacy version, search included, and a tester's preview override is turned off on that page. `/posts/` has no legacy version, so it keeps showing its "Family posts are loading." text, and `/me/notifications/` its "not enabled yet" text.
- **An unreachable auth edge, with `authV2` on.** The page keeps the legacy sign-in, and a preview override is turned off. Once the gate is attached, the family data stops for everyone as well. Nobody can sign in at `/auth/login` or refresh an `io_id`, which lasts one hour, and a gate replica that cannot fetch the auth edge's public keys refuses every request. Person pages, search and photos fail.
- **A missing API.** The bundle loads and the island mounts, so the legacy version does not come back. The failure shows inside the island: an error banner in place of the posts on the home page or `/posts/`, or a comments section on the person page that cannot load or post comments.

### Check the prerequisites

None of these checks needs a signed-in session, and none of them prints a secret.

1. **Island bundles.** Each file returns `200`:

   ```bash
   for n in shell search person my-posts timeline posts notifications notify-sw; do
     printf '%s ' "$n"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/js/islands/$n.js"
   done
   ```

   The first seven are the island entry points. `notify-sw.js` is the push handler that `/sw.js` imports for `notifyV2`.
2. **API.** `curl -s https://<site>/api/posts` returns `"error":"unauthenticated"`. That shows CloudFront reached `hfy-api` with a valid origin-verify header. `{"error":"forbidden"}` means the header does not match. Any other response means the behavior or the stack is missing.
3. **Auth edge.** `curl -s https://<site>/auth/session` returns `{"authenticated":false}`, and `curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'` prints a key ID.
4. **Uploads** (`postsV2`). `aws s3api get-bucket-cors --bucket <site-bucket>` shows a rule that allows `PUT` from `https://<site>`, and this prints a policy ID:

   ```bash
   aws cloudfront get-distribution-config --id <distribution-id> \
     --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/uploads/*'].ResponseHeadersPolicyId" --output text
   ```

5. **Push** (`notifyV2`). This prints the secret name, `harrisonfamily/api/vapid` in production. An empty result means push is off:

   ```bash
   aws cloudformation describe-stacks --region us-west-2 --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text
   ```

6. **Data gate** (`authV2`). This tells you which rollback applies to `authV2`. It prints `200` while the data paths are public, and `401` once the gate is attached:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
   ```

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md) or [Deploy the app stack](deploy-the-app-stack.md).

## Turn a flag on in one browser tab

1. Open the site with the flags you want in `hfy_flags`, separated by commas:

   ```text
   https://<site>/?hfy_flags=shellV2,postsV2
   ```

2. Look for the **Preview flags on — turn off** banner at the bottom left of the page. It shows on every page while the override is active.
3. Name every flag you want in that one value. The value is saved in this tab's `sessionStorage` under `hfy:flags`, and each new value replaces the stored list instead of adding to it. Opening `?hfy_flags=searchV2` afterwards leaves only `searchV2`, and the `shellV2` it implies, in the override. Flags that are already on for everyone stay on as well, because the override is applied over the published values.
4. Browse normally in the same tab. The override applies to every page you open in it and ends when you close the tab. Other tabs, other browsers and other visitors are not affected.
5. For `personV2`, `postsV2` and `notifyV2`, sign in at `https://<site>/auth/login`. These islands call the API with the auth edge's session cookie, and the legacy sign-in does not set it.

Flag names are case-sensitive. An unknown name is stored but does nothing.

If the banner disappears by itself, the override was turned off because something it needs is unavailable: an island bundle failed to load, or `/auth/session` did not answer for `authV2`. The browser console shows `preview flags turned off: <what> unavailable`. Fix the prerequisite and open the `?hfy_flags=` link again.

## Force a flag off in one tab

- Put a minus sign before the name: `?hfy_flags=-searchV2`. The override wins over the published value, so this works even after the flag is on for everyone. Use it to compare the new surface with the legacy page.
- The value replaces the whole stored list, so repeat any other override you want to keep. `?hfy_flags=shellV2,-postsV2` turns `postsV2` off and keeps `shellV2`; `?hfy_flags=-postsV2` alone drops it.
- Combine on and off in one value. `?hfy_flags=searchV2,-shellV2` shows the search island without the shell. An explicit `-shellV2` is the only way to stop `searchV2` from turning the shell on.
- Do not force `authV2` off once the gate is attached. The tab then runs the legacy client, which neither signs in at the edge nor refreshes `io_id`, so the gate can refuse its person, search and photo requests with `401`.
- To clear the override and return to the published values, press **turn off** in the banner, or open `?hfy_flags=` with an empty value.

## Check the result in one tab

1. Reload the page. Flags are resolved once per page load.
2. In the DevTools console, run:

   ```js
   sessionStorage.getItem('hfy:flags')
   HFYFeatureFlags.overrideActive()
   await HFYFeatureFlags.resolveFlags()
   ```

   The first line shows the stored override, for example `"shellV2,postsV2"`, or `null` when none is set. The second is `true` while the override applies. The third shows the values the page acts on: the published file, with the override applied over it.
3. Confirm the surface itself with the check for that flag:

   | Flag | Open | Expect |
   | --- | --- | --- |
   | `shellV2` | Any page | `<html>` has the class `hfy-shell-v2`, `/js/islands/shell.js` loads with `200` in the Network panel, and the page has gained a `<link rel="manifest">`. If the bundle fails to load, the loader removes the class and the legacy navbar stays. |
   | `searchV2` | `/search/` | `<html>` has the class `hfy-search-v2`, and `await HFYFeatureFlags.searchV2Live('page')` returns `true`. The `shellV2` checks pass too. |
   | `personV2` | `/person/?id=<gramps-id>` | `/js/islands/person.js` loads with `200`. |
   | `postsV2` | `/`, `/posts/` and `/person/?id=<gramps-id>` | `timeline.js`, `posts.js` and `my-posts.js` respectively load from `/js/islands/` with `200`. |
   | `notifyV2` | `/me/notifications/` | `/js/islands/notifications.js` loads with `200`, and the island replaces the page's "not enabled yet" text. |
   | `authV2` | `/family-login/`, signed out at the edge | The browser is redirected to `/auth/login?returnTo=%2F`. Signed in at the edge, the page stays and offers the legacy Google sign-in, by design ([Front end](../reference/front-end.md#auth-v2js-behavior)). Then run the `authV2` checks below. |

   To check a class from the console, run `document.documentElement.classList.contains('hfy-shell-v2')`.
4. For `authV2`, also check the data path and the navigation with a sign-in at the edge only:
   1. Use a window where the legacy Google sign-in has not run, such as a private window. Sign in at `https://<site>/auth/login`.
   2. Open `https://<site>/person/?id=<gramps-id>`. In DevTools > Network, select the `/person/<gramps-id>.json` request. Its request headers carry a `Cookie` header that includes `io_id`, and no `X-HFY-Session` header. Do not copy the cookie value anywhere.
   3. The navbar search shows, although the legacy sign-in never ran. In the console, `document.querySelector('[data-feature="navbarSearch"]').dataset.featureVisible` returns `"true"`, and `(await HFYFeatureFlags.edgeSession()).authenticated` returns `true`. With `shellV2` off you can also see the search box in the navbar. With it on, the shell hides the navbar.

   If the data request has no `io_id` cookie, or still sends `X-HFY-Session`, the page is not running the `authV2` client. See [A flag is on but nothing changes](diagnose-sign-in-and-api-failures.md#a-flag-is-on-but-nothing-changes).

## Turn a flag on for everyone

1. Run the [prerequisite checks](#check-the-prerequisites). A global flip with a missing piece fails for every visitor, as described in [Before you start](#before-you-start).
2. Have io's G-prod approval ([Before you start](#before-you-start)). For `authV2`, follow these steps as step 1 of [the cutover](cut-over-to-the-private-data-gate.md#1-flip-authv2-and-deploy-the-site), with the gate still detached.
3. In `11ty/_data/flags.json`, set the flag to `true` and leave the others unchanged:

   ```json
   "postsV2": true,
   ```

4. Copy the file into the Eleventy source ([Keep the source copy of flags.json identical](#keep-the-source-copy-of-flagsjson-identical)).
5. If the flip comes with island changes, rebuild and commit the bundles in the same pull request ([Build and preview the islands](build-and-preview-the-islands.md)).
6. Open a pull request and merge it to `main` ([Deploy a site change](deploy-a-site-change.md)). The deploy publishes the new `flags.json` and the committed bundles in the same sync.

## Check the result for everyone

1. Wait for the deploy run to finish green. Its `invalidate` job waits for CloudFront, so the checks below see the new values as soon as the run is done.
2. Confirm the published value. This command prints `true`:

   ```bash
   curl -s https://<site>/_data/flags.json | jq .postsV2
   ```

3. Open a private window, which has no override, and run the per-flag check from [Check the result in one tab](#check-the-result-in-one-tab). In a tab that has an override, `resolveFlags()` reports the override rather than the published value.
4. Run the island bundle check from [Check the prerequisites](#check-the-prerequisites) again.
5. For `authV2`:
   - The `authV2` checks in step 3 are the cutover's [Confirm the client](cut-over-to-the-private-data-gate.md#2-confirm-the-client). Attach the gate ([step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate)) only after they pass.
   - Run the auth-v2 Playwright suite against production, which also needs io's go-ahead ([Run the tests](run-the-tests.md#authv2-sign-in)). It checks the `/family-login/` redirect, the Google and email-and-password paths on `/auth/login`, the published JWKS, the signed-out session, and a password sign-in whose **My Record** link names the expected record.

## Roll back

- **For everyone:** set the flag back to `false` in `11ty/_data/flags.json`, copy the file into the Eleventy source, then merge and deploy as above. Once the run is green, the `curl … | jq` check prints `false`. The bundles stay in place and do nothing while their flag is off. For `authV2`, check the gate first.
- **`authV2` with the gate attached: remove the gate first.** Check 6 in [Check the prerequisites](#check-the-prerequisites) prints `401` while the gate is attached. Setting `authV2` to `false` then breaks person pages, search and photos for every visitor, because the legacy client does not send `io_id`. Remove the gate, and wait for the distribution, before you change the flag:

  ```bash
  scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id>
  scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id>
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  Do not pass `--stack <app-stack>` to this script. Its `--stack` names the `us-east-1` gate stack, and `--remove` does not read it. Review the dry run as described in the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back): it removes only the six gated behaviors. Once the distribution is deployed, the family data is public again, as it was before the release. Only then, and only if the `authV2` client itself is at fault, set `authV2` to `false` as in the first item.
- **An automatic rollback counts as turning the flag off.** When a deploy fails its smoke check, `rollback_on_smoke_fail` puts back the previous release, `flags.json` included.
  - If it was the flip's own deploy, the flip is undone. Revert the change on `main` so the next push does not publish it again ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)). For `authV2` the gate is not attached yet, so nothing else needs undoing. Do not attach it until a deploy with `authV2` set to `true` has finished green.
  - If the gate is attached, any automatic rollback may set `authV2` back to `false`. After every one, run `curl -s https://<site>/_data/flags.json | jq .authV2`. Unless it prints `true`, remove the gate at once, as in the previous item.
- **In one tab, at once:** open `?hfy_flags=-postsV2` (with the flag's name). The surface turns off in that tab without waiting for a deploy. The value replaces the stored list, so repeat any override you want to keep, for example `?hfy_flags=shellV2,-postsV2`. This is not a rollback for `authV2` once the gate is attached ([Force a flag off in one tab](#force-a-flag-off-in-one-tab)).
- A tab whose override names the flag keeps it on after a global rollback, because the override wins. Clear it with the banner's **turn off**, with `?hfy_flags=`, or by closing the tab.
- Turning `shellV2` off does not unregister a service worker that a browser has already installed ([Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-pwa-rides-on-the-shell-island)).

A flag decides what a page shows and, for `authV2`, which credential the page's data requests carry. It opens and closes no endpoint. `/api/*`, `/mcp` and `/auth/*` keep answering while their behaviors exist, and only the gate decides whether the data paths need a session, whatever `flags.json` says ([The release model](../explanation/release-model.md#what-a-flag-does-not-protect)).

## Keep the source copy of flags.json identical

After every change to `11ty/_data/flags.json`, copy it to `<eleventy-source>/public/_data/flags.json` and confirm the two match. Run from the repository root; `<eleventy-source>` is defined in the [codebase map](../reference/codebase-map.md).

```bash
mkdir -p <eleventy-source>/public/_data
cp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json
cmp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json && echo identical
```

The path is fixed: Eleventy passes `public/` through to the site root, so this is the copy a build publishes at `/_data/flags.json`.

Never refresh `11ty/` with a plain `rsync -a --delete` from the Eleventy source. Wherever the source lacks the E5 files, it deletes or reverts the whole flag mechanism, not only this file: `flags.json`, the resolver and override in `feature-flags.js`, `auth-v2.js` and the E5-only pages. It also reverts `js/person-page.js` to the source's copy, which lacks the `authV2` data path and still waits for the legacy `X-HFY-Session` token. Once the gate is attached, that breaks person pages. Refresh only by following [Refresh the Eleventy output](refresh-the-eleventy-output.md). The refresh command in [`11ty/README.md`](../../11ty/README.md) and the pre-commit check [`check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) exclude all of these paths. [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-consequence-two-sources-of-truth) explains why `11ty/` has two sources of truth.

If `feature-flags.js` is intact but `/_data/flags.json` fails to load, the resolver treats the published values as `{}`. Every flag is then off for every visitor, and only preview overrides still turn surfaces on. With the gate attached, that includes `authV2`, so person data fails as described in [Roll back](#roll-back).

## Related

- [Front-end reference](../reference/front-end.md): the flags, the resolver, the override, the island loader and the `authV2` data fetch.
- [The release model](../explanation/release-model.md): why flags stage a release, why the override wins, why it lasts one tab, and why the gate fixes the order of `authV2` changes.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the `authV2` flip, the gate attachment and their rollback, in order.
- [Deploy a site change](deploy-a-site-change.md): ship the `flags.json` change.
- [Roll back a site deploy](roll-back-a-site-deploy.md): when the deploy itself has to come out.
- [Refresh the Eleventy output](refresh-the-eleventy-output.md): rebuild `11ty/` without losing the E5 files.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md): when the auth or API checks fail.
