# How to turn a feature flag on for one tab or for everyone

Each E5 surface ships behind a flag, and every flag is `false` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json). This page covers these tasks:

- Checking that everything a flag depends on is in production.
- Turning a flag on, or forcing it off, in one browser tab with the preview override, and checking the result.
- Turning a flag on for every visitor by changing that file, and checking the result.
- Rolling back, in one tab or for everyone.
- Keeping the Eleventy source's copy of `flags.json` identical to the repository's.

The [front-end reference](../reference/front-end.md#feature-flags) lists the flags, what each one loads and the override rules. [The release model](../explanation/release-model.md) explains why a deploy and a flag are separate switches, and why the override is limited to one tab.

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<distribution-id>` and `<gramps-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

A flag only tells the browser to use the new surface. Whatever the surface depends on must already be in production:

| Flag | Needs in production |
| --- | --- |
| `shellV2`, `searchV2`, `personV2`, `postsV2`, `notifyV2` | The island bundles under `/js/islands/`. They are committed in `11ty/js/islands/` and every deploy ships them, so they are present unless a deploy failed. Before a flip that comes with island changes, `(cd islands && npm run check:islands)` must print `11ty/js/islands is up to date`. |
| `personV2`, `postsV2`, `notifyV2` | The `hfy-app` stack (`hfy-api` and the `hfy-app` table) and the CloudFront `/api/*` behavior from [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh). Every API route requires a session issued by the auth edge, so everything in the `authV2` row is needed too, even while `authV2` is off. |
| `postsV2` | The CORS rule in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) on `<site-bucket>`, so browsers can `PUT` post photos straight to S3, and the `/uploads/*` behavior from [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh), so photos are served with their safety headers. Both are manual steps in [Deploy the app stack](deploy-the-app-stack.md). |
| `notifyV2` | Preferences can be saved without it, but push is sent only when the `hfy-app` stack parameter `VapidSecretName` names a VAPID key pair ([Turn on push notifications](turn-on-push-notifications.md)). |
| `authV2` | `hfy-auth-edge` from the `hfy-app` stack; the `/auth/*` and `/.well-known/oauth-authorization-server*` behaviors from [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh); the session signing key from [`create-session-key.sh`](../../scripts/infra/create-session-key.sh); and the origin-verify secret from [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh), which the `/api/*` behavior also uses. |

`searchV2` turns `shellV2` on as well, because the search launcher lives in the shell. Check the shell's prerequisites for search too.

What a visitor sees when a piece is missing:

- **A missing island bundle.** The page keeps its legacy version, search included, and a tester's preview override is turned off on that page. `/posts/` has no legacy version, so it keeps showing its "Family posts are loading." text, and `/me/notifications/` its "not enabled yet" text.
- **An unreachable auth edge, with `authV2` on.** The legacy sign-in runs unchanged, and a preview override is turned off.
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

5. **Push** (`notifyV2`). An empty result from this command means push is off:

   ```bash
   aws cloudformation describe-stacks --region us-west-2 --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text
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
   | `authV2` | `/family-login/`, signed out at the edge | The browser is redirected to `/auth/login?returnTo=%2F`. Signed in at the edge, the page stays and offers the legacy Google sign-in, by design ([Front end](../reference/front-end.md#auth-v2js-behavior)). |

   To check a class from the console, run `document.documentElement.classList.contains('hfy-shell-v2')`.

## Turn a flag on for everyone

1. Run the [prerequisite checks](#check-the-prerequisites). A global flip with a missing piece fails for every visitor, as described in [Before you start](#before-you-start).
2. Get io's go-ahead. A global flip is one of the operations [`AGENTS.md`](../../AGENTS.md) reserves for it, and the plan gates each flip on its after-state audit.
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
5. For `authV2`, run the auth-v2 Playwright suite against production, which also needs io's go-ahead ([Run the tests](run-the-tests.md#authv2-sign-in)). It checks the `/family-login/` redirect, the two sign-in paths on `/auth/login`, the published JWKS and the signed-out session.

## Roll back

- **For everyone:** set the flag back to `false` in `11ty/_data/flags.json`, copy the file into the Eleventy source, then merge and deploy as above. Once the run is green, the `curl … | jq` check prints `false`. The bundles stay in place and do nothing while their flag is off.
- **If the flip's deploy failed its smoke check**, the pipeline has already put back the previous release, `flags.json` included. Revert the change on `main` so the next push does not publish it again ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)).
- **In one tab, at once:** open `?hfy_flags=-postsV2` (with the flag's name). The surface turns off in that tab without waiting for a deploy. The value replaces the stored list, so repeat any override you want to keep, for example `?hfy_flags=shellV2,-postsV2`.
- A tab whose override names the flag keeps it on after a global rollback, because the override wins. Clear it with the banner's **turn off**, with `?hfy_flags=`, or by closing the tab.
- Turning `shellV2` off does not unregister a service worker that a browser has already installed ([Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-pwa-rides-on-the-shell-island)).

A flag only hides UI. Turning it off does not close `/api/*` or `/auth/*`, which keep answering while their behaviors exist ([The release model](../explanation/release-model.md#what-a-flag-does-not-protect)).

## Keep the source copy of flags.json identical

After every change to `11ty/_data/flags.json`, copy it to `<eleventy-source>/public/_data/flags.json` and confirm the two match. Run from the repository root; `<eleventy-source>` is defined in the [codebase map](../reference/codebase-map.md).

```bash
mkdir -p <eleventy-source>/public/_data
cp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json
cmp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json && echo identical
```

The path is fixed: Eleventy passes `public/` through to the site root, so this is the copy a build publishes at `/_data/flags.json`.

Never refresh `11ty/` with a plain `rsync -a --delete` from the Eleventy source. Wherever the source lacks the E5 files, it removes the whole flag mechanism, not only this file: `flags.json`, the resolver and override in `feature-flags.js`, `auth-v2.js` and the E5-only pages. Refresh only by following [Refresh the Eleventy output](refresh-the-eleventy-output.md). [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-consequence-two-sources-of-truth) explains why `11ty/` has two sources of truth.

If `feature-flags.js` is intact but `/_data/flags.json` fails to load, the resolver treats the published values as `{}`. Every flag is then off for every visitor, and only preview overrides still turn surfaces on.

## Related

- [Front-end reference](../reference/front-end.md): the flags, the resolver, the override and the island loader.
- [The release model](../explanation/release-model.md): why flags stage a release, why the override wins, and why it lasts one tab.
- [Deploy a site change](deploy-a-site-change.md): ship the `flags.json` change.
- [Roll back a site deploy](roll-back-a-site-deploy.md): when the deploy itself has to come out.
- [Refresh the Eleventy output](refresh-the-eleventy-output.md): rebuild `11ty/` without losing the E5 files.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md): when the auth or API checks fail.
