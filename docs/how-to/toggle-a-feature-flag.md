# How to turn a feature flag on or off, for one tab or for everyone

Each E5 surface ships behind a flag in [`11ty/_data/flags.json`](../../11ty/_data/flags.json): `aboutCta`, `accessRequests`, `authV2`, `graduateV1`, `inboxV1`, `navMe`, `notifyV2`, `personV2`, `photoTagEdit`, `photoTags`, `postsV2`, `profileLinks`, `recordSubsV1`, `relationshipWizard`, `searchV2` and `shellV2`. A deploy publishes the file at `/_data/flags.json`, and the pages read it there at runtime. PR #8 (HFY-TSK-069) set the six flags it had then to `true`. `navMe` came later, with HFY-TSK-091, and shipped `false`; HFY-TSK-223 set it to `true` on 2026-10-13, with io's approval. `aboutCta` shipped `false` with HFY-TSK-136, `accessRequests` with HFY-TSK-140, `photoTags` with HFY-TSK-169, `photoTagEdit` with HFY-TSK-260, `profileLinks` with HFY-TSK-217, `inboxV1` with HFY-TSK-185, `recordSubsV1` with HFY-TSK-186, and `relationshipWizard` with HFY-TSK-158, and `graduateV1` with HFY-TSK-214 (it gates only `POST /api/comments/:id/attachments/:aid/graduate` until the graduate UI exists). The production cutover ran on 2026-10-12 (HFY-R67): the site deploy went first and the private data gate was attached second. To see the values the site serves now, run:

```bash
curl -s https://<site>/_data/flags.json | jq .
```

This page covers these tasks:

- Checking that everything a flag depends on is in production.
- Turning a flag on, or forcing it off, in one browser tab with the preview override, and checking the result.
- Turning a flag on for everyone by changing that file, and checking the result.
- Turning a flag off again, for everyone or in one tab. That includes `authV2` while the data gate is attached.
- Keeping the Eleventy source's copy of `flags.json` identical to the repository's.

`authV2` is the one flag tied to infrastructure. The private data gate accepts only the `io_id` session that the `authV2` client uses. So while the gate is attached, turning `authV2` off for everyone takes a CloudFront change first ([Roll back](#roll-back)), and forcing it off in one tab breaks that tab's family data. To turn `authV2` on for everyone where it is off, in a new environment or after a rollback, follow [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). Its step 1 is the global flip on this page.

The [front-end reference](../reference/front-end.md#feature-flags) lists the flags, what each one loads and the override rules. [The release model](../explanation/release-model.md) explains why a deploy and a flag are separate switches, why the override is limited to one tab, and why the gate ties `authV2` changes to a fixed order.

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<app-stack>`, `<distribution-id>`, `<repo>` and `<gramps-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's G-prod approval, for a global flip.** A global flip is any change to `11ty/_data/flags.json` that reaches `main`, whether it turns a flag on or off. [`AGENTS.md`](../../AGENTS.md) lists it among the operations that need G-prod approval (an HFY-PLN-001 gate), not only a go-ahead in the session. The preview override in one tab is not a global flip.
- **For `authV2`, find out whether the gate is attached.** [Check 6](#check-the-prerequisites) tells you.
  - To turn `authV2` off while the gate is attached, you remove the gate first, and if `HFYAppendIndex` runs its default-deny code you roll that function back as well ([Roll back](#roll-back)). Each takes a real run that needs io's go-ahead. It also takes operator AWS credentials that can read and update the distribution and read the outputs of `<app-stack>` in `us-west-2`, and, for the function rollback, update and publish `HFYAppendIndex`. The GitHub deploy role can do neither.
  - To turn `authV2` on, start from the cutover. It flips the flag first and attaches the gate only after the client is confirmed (HFY-R67).
- **Everything the surface depends on is in production.** A flag only tells the browser which surface to use. The table lists what each flag needs, and [Check the prerequisites](#check-the-prerequisites) checks it.

| Flag | Needs in production |
| --- | --- |
| `shellV2`, `searchV2`, `personV2`, `postsV2`, `notifyV2`, `navMe` | The island bundles under `/js/islands/`. They are committed in `11ty/js/islands/` and every deploy ships them, so they are present unless a deploy failed. Before a flip that comes with island changes, `(cd islands && npm run check:islands)` must print `<repo>/11ty is up to date (<n> generated files)`. |
| `personV2`, `postsV2`, `notifyV2` | The app stack `<app-stack>` (the `hfy-api` function and the `hfy-app` table) and the CloudFront `/api/*` behavior from [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh). Every API route requires a session issued by the auth edge, so everything in the `authV2` row is needed too. |
| `postsV2` | The CORS rule in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) on `<site-bucket>`, so browsers can `PUT` post photos straight to S3. Also the `/uploads/*` behavior that serves the photos. [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) creates it with the app stack's safety headers, readable by anyone who holds a URL. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) then makes it members-only, with the gate and the `hfy-uploads-private` response headers policy. The CORS rule is a manual step in [Stand up the static site](stand-up-the-static-site.md#1-create-the-site-bucket), and the uploads behavior one in [Deploy the app stack](deploy-the-app-stack.md); the gate is attached in the cutover. `scripts/infra/check-site-bucket-cors.sh` checks the CORS rule without credentials. |
| `accessRequests` | The `join` and `join-entry` bundles (committed in `11ty/js/islands/`), and the app stack with `ACCESS_REQUESTS=on` (stack parameter `AccessRequests`) together with `TurnstileSiteKey` and the three `Join*` SES parameters, as [Deploy the app stack](deploy-the-app-stack.md) lists them. Until then `/auth/access-request/*` answers `503 closed` and the `/join/` page says asking to join is not open. Nothing else: no other page loads Turnstile. |
| `navMe` | Only the shell and the `settings` island. It needs `shellV2` on, because the gear, the account sheet and the nav it changes are the shell's. Its hub links to `/me/notifications/`, which works fully only with `notifyV2`, and to `/auth/link`, which needs everything in the `authV2` row. |
| `proposalReview` | The `review` bundle (committed in `11ty/js/islands/`), and the app stack with the `HFY_EDITING` switch on: `/api/proposals*` answers `404` until then. The queue is for admins: the server answers `403` to anyone else whatever the flag says, so `config/admins.json` must name the approvers first. Everything in the `authV2` row. `recordEdit` opens the page's other two tabs. |
| `recordEdit` | The `edit-entry` and `editor` bundles (committed in `11ty/js/islands/`), and the app stack with the `HFY_EDITING` switch on: `/api/edit/*` answers `404`, and `/api/me` reports `editing: false`, until then. Everything in the `authV2` row. |
| `relationshipWizard` | The `family-entry` and `family` bundles (committed in `11ty/js/islands/`), and the app stack with the `HFY_EDITING` switch on: `/api/relationships*`, `/api/records/*` and `/api/edit/*` answer `404`, and `/api/me` reports `editing: false` (so the button stays away), until then. Everything in the `authV2` row, and `recordEdit` live: the wizard has its own page and button, but after a send it links to `my suggestions` on `/me/review/`, where the member changes or withdraws what they sent, and that tab shows only with `recordEdit`. |
| `photoTagEdit` | The `photo-tag-edit` bundle (committed in `11ty/js/islands/`), and the app stack with the `HFY_EDITING` switch on: `/api/edit/*` and `POST /api/changes` answer `404`, and `/api/me` reports `editing: false` (so the toggle stays away), until then. Everything in the `authV2` row, and `recordEdit` live in the same release, because the sheet and the review path are the editor's. It does not need `photoTags`, but without it the lightbox shows no tags to move or remove. The separate flip is `tag-edit-flip`, after `tag-edit-e2e` (BRD2 review DL-35). |
| `inboxV1` | The `inbox` and `inbox-page` bundles (committed in `11ty/js/islands/`), the app stack with `@io-kit/notify` 0.6.0 and the three `/api/notifications/inbox*` routes, which answer 404 until `inboxV1` is on at the API (a `uat` principal sees them early). Everything in the `authV2` row. The bell also needs `shellV2` on, because it fills the shell's bell slot: with `inboxV1` on and `shellV2` off no bell appears, and only the `/me/inbox/` page works. |
| `notifyV2` | Preferences can be saved without it, but push is sent only when the `<app-stack>` parameter `VapidSecretName` names a VAPID key pair, the secret `harrisonfamily/api/vapid` in production ([Turn on push notifications](turn-on-push-notifications.md)). |
| `authV2` | `hfy-auth-edge` from `<app-stack>`; the `/auth/*` and `/.well-known/oauth-authorization-server*` behaviors from [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh); the session signing key from [`create-session-key.sh`](../../scripts/infra/create-session-key.sh); and the origin-verify secret from [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh), which the `/api/*` behavior also uses. The data gate is not a prerequisite. It depends on the flag instead: the gate is attached only after the flip, and it must be removed before the flag goes off (HFY-R67). |

`searchV2` turns `shellV2` on as well, because the search launcher lives in the shell (HFY-R48). Check the shell's prerequisites for search too.

`familyViz` is the viz domain's flag. It is not in `flags.json` yet, and an absent key is off. With it on, the `tree` island loads on `/tree/` (HFY-TSK-201) and shows the family tree from the gated `/person/graph.json`, the person page gains a "see in the family tree" link, and the shell points "family" at `/tree/`, with or without `navMe` (HFY-TSK-091). With it off, `/tree/` says the tree is not turned on yet and requests nothing. Preview it with `?hfy_flags=familyViz`, which is also how the flag is audited before its flip (Audit(flag) in the [viz ADR](../design/hfy-pln-002/viz-adr.md)). The tree needs the graph published by [Sync Gramps with the website](sync-gramps-with-the-website.md); until it is, `/tree/` says the family tree is being prepared.

> **Warning:** do not flip a flag whose prerequisites fail. A missing island bundle leaves the page without it: `/search/` stays empty (there is no legacy search page any more), and `/posts/` and `/me/notifications/` keep their placeholder text. A missing API shows an error inside the island. An unreachable auth edge stops sign-in and, while the gate is attached, the family data for everyone. [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#find-your-symptom) lists the symptoms and their fixes.

### Check the prerequisites

None of these checks needs a signed-in session, and none of them prints a secret.

1. **Island bundles.** Cloudflare keeps each static file for up to 4 hours under the URL it was first fetched at, and the CloudFront invalidation never reaches that copy. So check the versioned URLs that the pages load, not the bare paths. The `hfy-asset-versions` block in `feature-flags.js` holds the island versions, and the one in `/sw.js` holds the version of `notify-sw.js`:

   ```bash
   asset_v() { awk '/const ASSET_V = /{sub(/.*= /, ""); on=1} on{print} on && /^ *};/{exit}' | sed 's/;$//'; }
   ff=$(curl -s https://<site>/ | grep -o '/js/feature-flags.js?v=[0-9a-f]*' | head -n 1)
   av=$(curl -s "https://<site>$ff" | asset_v)
   jq -r '.islands | to_entries[] | "\(.key) \(.value.js) \(.value.css)"' <<<"$av" | while read -r n js css; do
     printf '%s ' "$n"
     curl -s -o /dev/null -w '%{http_code} ' "https://<site>/js/islands/$n.js?v=$js"
     curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/js/islands/$n.css?v=$css"
   done
   nv=$(curl -s "https://<site>/sw.js?v=$(jq -r .sw <<<"$av")" | asset_v | jq -r .notify)
   printf 'notify-sw '; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/js/islands/notify-sw.js?v=$nv"
   ```

   Each of the eight island entry points (`my-posts`, `notifications`, `person`, `posts`, `search`, `settings`, `shell` and `timeline`) prints `200 200`, for its script and its stylesheet. The last line prints `notify-sw 200`. `notify-sw.js` is the push handler that `/sw.js` imports for `notifyV2`.
   - If no island lines print, the home page has no versioned `feature-flags.js` link. The page was committed without the islands build ([Refresh the Eleventy output](refresh-the-eleventy-output.md)).
   - Run this check only after a deploy run has finished green. CloudFront ignores the query string. Before the invalidation finishes, it can answer a new `?v` with the old file, and Cloudflare would then keep that answer for up to 4 hours.
2. **API.** `curl -s https://<site>/api/posts` returns `"error":"unauthenticated"`. That shows CloudFront reached `hfy-api` with a valid origin-verify header. `{"error":"forbidden"}` means the header does not match. Any other response means the behavior or the stack is missing.
3. **Auth edge.** `curl -s https://<site>/auth/session` returns `{"authenticated":false}`, and `curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'` prints a key ID.
4. **Uploads** (`postsV2`). `aws s3api get-bucket-cors --bucket <site-bucket>` shows a rule that allows `PUT` from `https://<site>`. This command prints the `/uploads/*` behavior's response headers policy ID and its number of Lambda@Edge associations:

   ```bash
   aws cloudfront get-distribution-config --id <distribution-id> \
     --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/uploads/*'].[ResponseHeadersPolicyId,LambdaFunctionAssociations.Quantity]" --output text
   ```

   `1` means the behavior is members-only: it carries the gate, and the policy is `hfy-uploads-private`. `0` means photos are public to anyone who holds a URL, under the app stack's `UploadsResponseHeadersPolicyId`. An empty result means the behavior is missing.
5. **Push** (`notifyV2`). This prints the secret name, `harrisonfamily/api/vapid` in production. An empty result means push is off:

   ```bash
   aws cloudformation describe-stacks --region us-west-2 --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text
   ```

6. **Data gate** (`authV2`). This tells you which rollback applies to `authV2`. Run it signed out, from a shell with no cookies:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
   ```

   - `401`: the gate is attached.
   - `200`: the gate is not attached, and the data is public.
   - `404`: the gate is not attached, and `HFYAppendIndex` runs its default-deny code, which refuses the data to everyone, members included. See [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) for what the site needs.

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md) or [Deploy the app stack](deploy-the-app-stack.md).

## Turn a flag on in one browser tab

1. Open the site with the flags you want in `hfy_flags`, separated by commas:

   ```text
   https://<site>/?hfy_flags=shellV2,postsV2
   ```

2. Look for the **preview flags on — turn off** banner at the bottom left of the page. It shows on every page while the override is active. When the shell shows its bottom bar, the banner sits just above it.
3. Name every flag you want in that one value. The value is saved in this tab's `sessionStorage` under `hfy:flags`, and each new value replaces the stored list instead of adding to it. For example, opening `?hfy_flags=searchV2` afterwards leaves only `searchV2` in the override. The resolver still turns `shellV2` on, because `searchV2` implies it. Flags that are already on for everyone stay on as well, because the override is applied over the published values.
4. Browse normally in the same tab. The override applies to every page you open in it and ends when you close the tab. Other tabs, other browsers and other visitors are not affected.
5. For `personV2`, `postsV2` and `notifyV2`, sign in at `https://<site>/auth/login`. These islands call the API with the auth edge's session cookie, which only the edge sign-in sets.

Flag names are case-sensitive. An unknown name is stored but does nothing.

If the banner disappears by itself, the override was turned off because something it needs is unavailable: an island bundle failed to load, or `/auth/session` did not answer for `authV2`. The browser console shows `[HFYFeatureFlags] preview flags turned off: <what> unavailable`. Fix the prerequisite and open the `?hfy_flags=` link again.

## Force a flag off in one tab

- **Put a minus sign before the name**, as in `?hfy_flags=-searchV2`. The override wins over the published value, so this works for a flag that is on for everyone. Use it to compare the new surface with the page without it (for `searchV2` that is an empty `/search/` page).
- **Repeat any other override you want to keep.** The value replaces the whole stored list. `?hfy_flags=shellV2,-postsV2` turns `postsV2` off and keeps `shellV2`; `?hfy_flags=-postsV2` alone drops it.
- **Combine on and off in one value.** `?hfy_flags=searchV2,-shellV2` shows the search island without the shell. Only an explicit `-shellV2` stops `searchV2` from turning the shell on.
- **Do not force `authV2` off while the gate is attached** (check 6 prints `401`). The tab then never refreshes `io_id`, so the gate refuses its person, search and photo requests with `401` once the hour is up.
- **To clear the override** and return to the published values, press **turn off** in the banner, or open `?hfy_flags=` with an empty value.

## Check the result in one tab

1. Reload the page. Flags are resolved once per page load.
2. In the DevTools console, run:

   ```js
   sessionStorage.getItem('hfy:flags')
   HFYFeatureFlags.overrideActive()
   await HFYFeatureFlags.resolveFlags()
   ```

   - The first line shows the stored override, for example `"shellV2,postsV2"`, or `null` when none is set.
   - The second is `true` while the override applies.
   - The third shows the values the page acts on: the published file, with the override applied over it.
3. Confirm the surface itself with the check for that flag. The pages load every island script and stylesheet with `?v=<sha8>`, a content hash, so the Network panel shows that query on each:

   | Flag | Open | Expect |
   | --- | --- | --- |
   | `shellV2` | Any page | `<html>` has the class `hfy-shell-v2`, and `/js/islands/shell.js?v=<sha8>` loads with `200`. The page gains `<link rel="manifest" href="/manifest.webmanifest?v=<sha8>">`, and the shell registers `/sw.js?v=<sha8>`. Below 688 px the shell shows a five-item bottom bar (home, family, search, posts, me), or four items (home, search, posts, me) with `navMe`. From 688 px it shows a top bar. If the bundle fails to load, the loader removes the class and the Bootstrap navbar stays (without a search field). |
   | `searchV2` | `/search/` | `/js/islands/search.js?v=<sha8>` loads with `200`, and `#hfy-search-v2` is the first child of the page's `<main>`. The `shellV2` checks pass too. |
   | `personV2` | `/person/?id=<gramps-id>` | `/js/islands/person.js?v=<sha8>` loads with `200`. |
   | `postsV2` | `/`, `/posts/` and `/person/?id=<gramps-id>` | `timeline.js`, `posts.js` and `my-posts.js` respectively load from `/js/islands/` with `200`. Post photos load. While `/uploads/*` is gated, each `/uploads/` response shows `cache-control: private, no-store`. |
   | `notifyV2` | `/me/notifications/` | `/js/islands/notifications.js?v=<sha8>` loads with `200`, and the island replaces the page's "notifications aren't turned on yet." text. |
   | `navMe` | Any page, signed in at the edge, then `/me/` | The bottom bar has four items, and "me" links to `/person/?id=<your gramps id>`. A gear sits before your avatar and opens `/me/`, where `/js/islands/settings.js?v=<sha8>` loads with `200` and the island replaces the page's "settings aren't turned on yet." text with the rows. The account sheet reads "your page", "settings" and "sign out". |
   | `proposalReview` | `/me/review/`, signed in as an admin at the edge | `/js/islands/review.js?v=<sha8>` loads with `200`, the "suggestions aren't available yet." note goes, and a `to review` tab opens the queue, oldest first. A member sees no such tab and the page makes no `view=queue` request. With both `proposalReview` and `recordEdit` off the file is not requested. |
   | `recordEdit` | `/person/?id=<gramps-id>`, signed in at the edge, then `/edit/?cls=person&id=<gramps-id>` | `/js/islands/edit-entry.js?v=<sha8>` loads with `200`, and the hero action slot shows `edit my info` on your own page, `suggest a change` on another page and `edit` for an admin. On `/edit/`, `/js/islands/editor.js?v=<sha8>` loads and the "editing isn't available yet." note goes. With the flag off neither file is requested. |
   | `relationshipWizard` | `/person/?id=<your gramps id>`, signed in at the edge, then `/edit/family/` | `/js/islands/family-entry.js?v=<sha8>` loads with `200`, and the family section shows `add or fix family connections` on your own page and not on anyone else's. On `/edit/family/`, `/js/islands/family.js?v=<sha8>` loads, the "family connections aren't available yet." note goes, and the first screen asks `what would you like to do?`. With the flag off neither file is requested. |
   | `accessRequests` | `/join/`, signed out | `/js/islands/join.js?v=<sha8>` loads with `200`, the static "asking to join isn't open yet." note goes, and `GET /auth/access-request/config` answers `200` (a `503` shows the same note again from the island). On `/`, `/about/` and `/contact/`, `/js/islands/join-entry.js?v=<sha8>` loads and the line "new here? ask to join." links to `/join/`. The sign-in page's "not on the list" notice and the denied page carry an "ask to join" link only while `ACCESS_REQUESTS` is on. With the flag off none of these files is requested. |
   | `accessRequests` (admin queue) | `/me/requests/`, signed in as an admin | `/js/islands/access-requests.js?v=<sha8>` loads with `200`, the "family requests aren't available yet." line goes, and the three tabs list the requests. A non-admin sees "this page is for the people who look after the site." With the flag off no bundle is requested. |
   | `inboxV1` | Any page with `shellV2` on, signed in at the edge, then `/me/inbox/` | A bell sits in the top bar before the gear, and `/js/islands/inbox.js?v=<sha8>` loads with `200`. On `/me/inbox/`, `/js/islands/inbox-page.js?v=<sha8>` loads and the "your inbox isn't available yet." note goes. With `shellV2` off no bell loads, whatever `inboxV1` says. |
   | `authV2` | Any page, signed out at the edge | The sign-in links (`[data-feature="familyLoginLink"]`) point at `/auth/login?returnTo=<this page>`. `/family-login/` is a static redirect page, whatever the flag says: it goes to `/auth/login?returnTo=%2F`, and `/family-login/?next=%2Fsearch%2F` goes to `/auth/login?returnTo=%2Fsearch%2F`. `next` must be a same-origin path outside `/auth` and `/family-login`; anything else becomes `/` ([Front end](../reference/front-end.md#family-login)). Then run the `authV2` checks below. |

   To check a class from the console, run `document.documentElement.classList.contains('hfy-shell-v2')`.
4. For `authV2`, also check the data path and the navigation with a sign-in at the edge only:
   1. Use a private window, which has no override. Sign in at `https://<site>/auth/login`.
   2. Open `https://<site>/person/?id=<gramps-id>`. In DevTools > Network, select the `/person/<gramps-id>.json` request. Its request headers carry a `Cookie` header that includes `io_id`. Do not copy the cookie value anywhere.
   3. Check that the signed-in navigation shows. While `shellV2` is on, the shell hides the navbar, so check from the console. `document.querySelector('[data-feature="myRecordLink"]').dataset.featureVisible` returns `"true"`, and `(await HFYFeatureFlags.edgeSession()).authenticated` returns `true`.

   If the data request has no `io_id` cookie, the page is not running the `authV2` client. See [A flag is on but nothing changes](diagnose-sign-in-and-api-failures.md#a-flag-is-on-but-nothing-changes).

## Turn a flag on for everyone

1. Run the [prerequisite checks](#check-the-prerequisites). A global flip with a missing piece fails for every visitor, as described in [Before you start](#before-you-start).
2. Have io's G-prod approval ([Before you start](#before-you-start)). For `authV2`, follow these steps as step 1 of [the cutover](cut-over-to-the-private-data-gate.md). Check 6 must not print `401`: it prints `200` or `404`, because the gate stays detached until the client is confirmed.
3. In `11ty/_data/flags.json`, set the flag to `true` and leave the others unchanged:

   ```json
   "postsV2": true,
   ```

4. Copy the file into the Eleventy source ([Keep the source copy of flags.json identical](#keep-the-source-copy-of-flagsjson-identical)).
5. If the flip comes with island changes, rebuild and commit the build outputs in the same pull request ([Build and preview the islands](build-and-preview-the-islands.md)). `(cd islands && npm run check:islands)` must pass.
6. Open a pull request and merge it to `main` ([Deploy a site change](deploy-a-site-change.md)). The deploy publishes the new `flags.json` and the committed bundles in the same sync.

## Check the result for everyone

1. Wait for the deploy run to finish green. Its `invalidate` job waits for the CloudFront invalidation.
   - `/_data/flags.json` is JSON, which Cloudflare does not cache, so the next step sees the new value as soon as the run is done.
   - Static files are different. Cloudflare keeps the scripts, stylesheets, fonts and `/sw.js` for up to 4 hours under the URL first fetched, and the invalidation does not reach them. The pages load these files under `?v=<sha8>` URLs, so a request for a bare path such as `/js/islands/shell.js` can still get Cloudflare's old copy. Check the versioned URLs instead, as check 1 does.
2. Confirm the published value. This command prints `true`:

   ```bash
   curl -s https://<site>/_data/flags.json | jq .postsV2
   ```

3. Open a private window, which has no override, and run the per-flag check from [Check the result in one tab](#check-the-result-in-one-tab). In a tab that has an override, `resolveFlags()` reports the override rather than the published value.
4. Run the island bundle check, check 1 in [Check the prerequisites](#check-the-prerequisites), again.
5. If you turned `authV2` on:
   - The `authV2` checks in step 3 are the cutover's [Confirm the client](cut-over-to-the-private-data-gate.md#2-confirm-the-client). Attach the gate ([step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate)) only after they pass.
   - Run the auth-v2 Playwright suite against production ([Run the tests](run-the-tests.md#authv2-sign-in)). It also needs io's go-ahead. It checks:
     - the `/family-login/` redirect page.
     - the Google and email-and-password paths on `/auth/login`.
     - the published JWKS and the signed-out session.
     - a password sign-in whose **My Record** link names the expected record.

     Against the production edge, whose manifest lists the passkey provider, the test that expects exactly two `section.path` elements fails by design: the page renders four. The other tests show whether sign-in works ([Run the tests](run-the-tests.md#authv2-sign-in)).

## Roll back

Turning a flag off for everyone is a global flip, so it needs io's G-prod approval ([Before you start](#before-you-start)).

- **For everyone:** set the flag back to `false` in `11ty/_data/flags.json`, copy the file into the Eleventy source, then merge and deploy as above. Once the run is green, the `curl … | jq` check prints `false`. The bundles stay in place and do nothing while their flag is off. Two flags need more:
  - `shellV2` stays on while `searchV2` is `true`, because `searchV2` turns it on. To take the shell away from everyone, set both to `false`.
  - For `authV2`, run check 6 in [Check the prerequisites](#check-the-prerequisites) first. If it prints `401`, follow [Turn authV2 off while the gate is attached](#turn-authv2-off-while-the-gate-is-attached) before you change the flag.
- **A revert of the flip turns `authV2` off.** Reverting the commit that set `authV2` to `true` publishes `false`. A revert of PR #8 turns the other five flags off as well. While the gate is attached, follow [Turn authV2 off while the gate is attached](#turn-authv2-off-while-the-gate-is-attached) before you merge the revert.
- **An automatic rollback can turn a flag off.** When a deploy fails its smoke check, `rollback_on_smoke_fail` puts back the previous release, `flags.json` included. It never changes the distribution's behaviors or `HFYAppendIndex`, so an attached gate stays attached.
  - After every automatic rollback, follow [Check authV2 after a failed deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy). If check 6 prints `401` and `flags.json` has anything but `"authV2": true`, every visitor is locked out of the family data. Its step 2 decides what to do by the code `HFYAppendIndex` runs. Under the older code, remove the gate at once. Under the default-deny code, leave the gate attached and get a release with `"authV2": true` live again, or remove the gate and roll the function back as well.
  - If it was a flip's own deploy that failed, the rollback undid the flip, but `main` still holds it, so the next push publishes it again. Fix forward or revert the change on `main` ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)).
- **In one tab, at once:** open `?hfy_flags=-postsV2` (with the flag's name). The surface turns off in that tab without waiting for a deploy. The value replaces the stored list, so repeat any override you want to keep, for example `?hfy_flags=shellV2,-postsV2`. This is not a rollback for `authV2` while the gate is attached ([Force a flag off in one tab](#force-a-flag-off-in-one-tab)).
- **A tab override outlasts a global rollback.** A tab whose override names the flag keeps it on, because the override wins. Clear it with the banner's **turn off**, with `?hfy_flags=`, or by closing the tab.
- **The service worker stays.** Turning `shellV2` off does not unregister a service worker that a browser has already installed ([Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-pwa-rides-on-the-shell-island)).

> **Note:** turning a flag off closes no endpoint. `/api/*`, `/mcp` and `/auth/*` keep answering, and only the data gate decides whether the gated paths need a session ([What a flag does not protect](../explanation/release-model.md#what-a-flag-does-not-protect)).

### Turn authV2 off while the gate is attached

Check 6 prints `401` while the gate is attached. Never set `authV2` to `false` then. A page with `authV2` off never refreshes `io_id`, so the gate refuses its person, search and photo requests once the hour is up, for every visitor. Follow these steps in order. Step 1 is the same decision as step 2 of [Check authV2 after a failed deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy), and the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back) gives the full order.

1. **Find out which code `HFYAppendIndex` runs.** Signed out, from a shell with no cookies:

   ```bash
   curl -sS -o /dev/null -D - https://<site>/Person/index.json | grep -iE '^(HTTP|cache-control)'
   ```

   - **Anything but `404` with `cache-control: private, no-store`.** The function runs its older code. Removing the gate makes the data readable again. Go on to step 2.
   - **`404` with `cache-control: private, no-store`.** The function runs its default-deny code, and removing the gate alone does not make the data readable. The six data paths then fall through to the default behavior, where the function answers `404` to every request for them, from every client. Only a path that a broader legacy CloudFront behavior, such as `/person/*`, matches first is served, to anyone. Member photos become public. Choose one:
     - Keep the gate attached and `authV2` on, and get a release that works with `"authV2": true` live: fix forward, or revert the change that broke it, as in [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). Stop here.
     - Remove the gate in steps 2 and 3, and roll the function back in step 4. The function rollback needs io's go-ahead too.
2. **Remove the gate.** The real `--remove` run needs io's go-ahead. Do the dry run first:

   ```bash
   export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id> --app-stack <app-stack>
   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id> --app-stack <app-stack>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   - `--app-stack <app-stack>` names the stack whose `UploadsResponseHeadersPolicyId` output is the policy that `/uploads/*` gets back. The script reads that output in the CLI's region, which is why the block sets `us-west-2` first. The option's default, `hfy-app`, is not the live stack. While `/uploads/*` is gated, a run without it, the dry run included, exits `1` with `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing. `--restore-uploads-policy-id <id>` names the policy directly instead.
   - Do not pass `--stack <app-stack>`. This script's `--stack` names the `us-east-1` gate stack, and `--remove` does not read it.
   - Review the dry run as described in the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back). The diff removes the six gated data behaviors, only ones that carry an `hfy-edge-gate` association, so `CacheBehaviors.Quantity` falls by 6. It also changes `/uploads/*` in place, if that behavior is gated. The changed `/uploads/*` has no Lambda association, uses `CachingOptimized` and gets the app stack's uploads policy back. Stop if the diff changes anything else.
   - If the gate is already off, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (...) and /uploads/* back to its ungated state: no change`.

   The alternative to `--remove` is restoring the backup that the attaching run saved, with `aws cloudfront update-distribution`. The cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back) shows how.
3. **Check that the gate is off.**
   - Run check 6 again. It must not print `401`. Under the older `HFYAppendIndex` code it prints `200`: the family data is public again, as it was before the cutover. Under the default-deny code it prints `404` until step 4 is done, unless a legacy behavior serves the path (step 1).
   - Run the distribution command of check 4 again. It prints the app stack's uploads policy ID and `0` associations. Member photos are now public to anyone who holds a URL. This command prints the policy ID to compare with:

     ```bash
     aws cloudformation describe-stacks --region us-west-2 --stack-name <app-stack> \
       --query "Stacks[0].Outputs[?OutputKey=='UploadsResponseHeadersPolicyId'].OutputValue" --output text
     ```

   The response headers policies `hfy-private-no-store` and `hfy-uploads-private` stay in the account, unused.
4. **Under the default-deny code only, roll `HFYAppendIndex` back.** Run the `roll back with:` commands that `publish-append-index.sh` printed when it published, as in [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md#roll-back). Then run check 6 again. It prints `200`.
5. **Only then, and only if the `authV2` client itself is at fault, set `authV2` to `false`**, as in the first item of [Roll back](#roll-back).

## Keep the source copy of flags.json identical

After every change to `11ty/_data/flags.json`, copy it to `<eleventy-source>/public/_data/flags.json`, the copy an Eleventy build publishes at `/_data/flags.json`, and confirm the two match. Run from the repository root; `<eleventy-source>` is defined in the [codebase map](../reference/codebase-map.md).

```bash
mkdir -p <eleventy-source>/public/_data
cp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json
cmp 11ty/_data/flags.json <eleventy-source>/public/_data/flags.json && echo identical
```

> **Warning:** never refresh `11ty/` with a plain `rsync -a --delete` from the Eleventy source. It deletes or reverts the repo-owned files, `flags.json`, `feature-flags.js`, `auth-v2.js` and `js/person-page.js` among them, and while the gate is attached that breaks person pages. Refresh only by following [Refresh the Eleventy output](refresh-the-eleventy-output.md). [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-consequence-two-sources-of-truth) explains why.

If `feature-flags.js` is intact but `/_data/flags.json` fails to load, the resolver treats the published values as `{}`. Every flag is then off for every visitor, and only preview overrides still turn surfaces on. While the gate is attached, that includes `authV2`, so person data fails as described in [Turn authV2 off while the gate is attached](#turn-authv2-off-while-the-gate-is-attached).

## Related

- [Front-end reference](../reference/front-end.md): the flags, the resolver, the override, the island loader and the `authV2` data fetch.
- [Theme and asset build](../reference/theme-and-asset-build.md): the `?v=<sha8>` asset versions and the stamped `hfy-asset-versions` blocks.
- [The release model](../explanation/release-model.md): why flags stage a release, why the override wins, why it lasts one tab, and why the gate fixes the order of `authV2` changes.
- [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md#caching-posture): why Cloudflare's copy of a static file outlives a CloudFront invalidation.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the `authV2` flip, the gate attachment and their rollback, in order.
- [Deploy a site change](deploy-a-site-change.md): ship the `flags.json` change.
- [Roll back a site deploy](roll-back-a-site-deploy.md): when the deploy itself has to come out.
- [Refresh the Eleventy output](refresh-the-eleventy-output.md): rebuild `11ty/` without losing the E5 files.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md): when the auth or API checks fail.
