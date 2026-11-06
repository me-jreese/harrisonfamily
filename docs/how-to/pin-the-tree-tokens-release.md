# How to pin the `@io-kit/tokens` release that carries the tree tokens

Use this page when a release of `@io-kit/tokens` that defines the hourglass tree's own tokens (the `tree.*` colours and sizes) has been published, and the site should read them. It checks that the release exists, moves the pin, rebuilds, and confirms that nothing in the tree changes except where the values come from.

The tree draws with `--hfy-tree-*` names that [`46-hourglass.css`](../../islands/src/theme/46-hourglass.css) defines in an alias block. Each name prefers the new token and falls back to the existing token that the new one is defined as, so the pin bump needs no CSS change. [The hourglass tree](../reference/hourglass-tree.md#tokens-the-alias-block-and-the-names-emitted) lists the names.

Placeholders used on this page: `<version>` is the `@io-kit/tokens` version that carries the tokens. `<operator-profile>` is the AWS CLI profile that can read the `io` CodeArtifact domain. `<repo>` is the absolute path of your checkout.

## Before you start

- **The release is published.** The tokens change ships from the io-kit repository as its own pull request and release. This page starts after that release. A merged pull request alone is not a release: check in step 1.
- **The island dependencies install with dev dependencies,** which needs a `CODEARTIFACT_AUTH_TOKEN` in this shell. Follow steps 1 and 2 of [Build and preview the islands](build-and-preview-the-islands.md#1-get-a-codeartifact-token).
- **A branch tied to an HFY record,** as in [Deploy a site change](deploy-a-site-change.md#before-you-start).

## Steps

### 1. Check that the version exists

```sh
aws codeartifact list-package-versions --domain io --repository io-kit --format npm --namespace io-kit --package tokens --profile <operator-profile> --region us-west-2
```

Find `<version>` in the list, with status `Published`. Compare it with the pin in [`islands/package.json`](../../islands/package.json): `grep tokens islands/package.json`. The package was pinned at `0.4.1` when the tree was built, and the release with the tree tokens is a later minor. A minor can carry other changes besides the tree tokens, so step 4 reads the whole delta.

### 2. Move the pin

```sh
cd <repo>/islands
npm install --save-exact @io-kit/tokens@<version>
```

Check that `package.json` names the exact version with no `^`, and that `package-lock.json` changed with it.

### 3. Rebuild and check

```sh
npm run build
npm run build
npm run check:islands
npm run lint:css
npm run test:contract
```

Run the build again until it reports `0 written`. `npm run test:contract` includes `tests/hourglass-contrast.test.mjs`: for every `tree.*` role that the pinned package now defines, the test requires it to resolve to the same colour as the alias the tree uses today, in both themes. A failure there means the release defines a value other than the one the tree was designed and checked with. Stop and raise it with the design owner; do not edit the alias to match.

### 4. Read the whole delta of the bump

```sh
cd <repo>
git diff --stat
git diff 11ty/css/hfy-theme.css
```

The release can change tokens besides the tree ones, and every such change is now in the theme. For each changed value, decide whether it was meant. A token change can also change `11ty/css/auth-edge.css`, and so `theme.cssUrl` in `auth/edge.manifest.json`, which ships through an `hfy-auth-edge` redeploy that needs io's go-ahead; see [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md). Tests pin approved values as literals in some specs; [that page](change-the-theme-or-brand-fonts.md#move-to-a-new-io-kittokens-release) says which and what to do.

### 5. Confirm the tree's CSS needs no change

Open `islands/src/theme/46-hourglass.css`. The alias block must be unchanged, and you remove nothing from it: the fallbacks stay, so a tab on an older cached stylesheet and a later pin both read a value. The `tree.*` names now resolve to the new tokens first, and `.hfy-tree` and `.hfy-bt` need no other rule changed. Check in the built theme that the new names are defined:

```sh
grep -c -- "--io-color-semantic-tree-edge" 11ty/css/hfy-theme.css
```

A count above `0` means the release carries them.

### 6. Check the tree itself

Run the specs that look at the tree, one file at a time, in the headless shell and with one worker ([Run the tests](run-the-tests.md#4-run-the-island-browser-tests-local) has the rules for the shared machine):

```sh
cd islands
PW_CHANNEL=chromium-headless-shell PW_PORT=<free port> npx playwright test tests/hourglass-d11.spec.mjs --workers=1
PW_CHANNEL=chromium-headless-shell PW_PORT=<free port> npx playwright test tests/hourglass-big.spec.mjs --workers=1
```

Then `pgrep -fl playwright_chromiumdev_profile` must print nothing. Also run `node --test tests/tree-budget.test.mjs`: the CSS partial and the scripts must stay inside their limits.

### 7. Commit every touched output

Commit `package.json`, `package-lock.json`, and every file the build rewrote in `11ty/` (HFY-R58), in one commit with the source. [Build and preview the islands, step 5](build-and-preview-the-islands.md#5-commit-the-output-with-the-source) lists what to expect.

## Verify

- `npm run check:islands` exits `0`.
- `node --test tests/hourglass-contrast.test.mjs` passes.
- `git diff` of the commit shows no change in `islands/src/theme/46-hourglass.css`.

## Related pages

- [The hourglass tree](../reference/hourglass-tree.md) for the alias block and the token names.
- [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md) for a token move in general.
- [Build and preview the islands](build-and-preview-the-islands.md) for the build and its output.
