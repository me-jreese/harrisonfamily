# Deployment Resource Inventory

This document lists every asset that powers the Harrison Family site, where it lives, and whether it should be committed to Git. Use it as the definitive checklist when promoting changes from the workspace into the repo and onward to production.

## 0. Session logging & promotion workflow

Every session must maintain a structured log in `workspace/session-logs/`. This log drives the promotion script and prevents accidental deletions.

1. At the **start of each session**, copy `docs/session-logs/session-log-template.json`, rename it with a timestamp (e.g., `docs/session-logs/session-2025-11-08T09-00.json`), and record metadata (`date`, `agent`, optional notes).
2. Whenever you modify a workspace asset, append an entry under `changes` describing the workspace path, destination repo path, whether it must be promoted, and the reason.
3. After editing private data under `workspace-local/`, generate or verify sanitized counterparts by running:
   ```bash
   python scripts/sync_sanitized_assets.py --sync
   ```
   This creates placeholder JSON/HTML so the public `workspace/` mirrors `workspace-local/` without leaking secrets.
4. Export the sanitized workspace snapshot into the repo so collaborators get the latest samples:
   ```bash
   ./repo/scripts/export_workspace_samples.sh
   ```
5. After running the necessary build (`npm run build`, Lambda bundle, etc.), promote assets by running:
   ```bash
   ./repo/scripts/promote_workspace_assets.sh --log docs/session-logs/<your-log>.json
   ```
   - Use `--dry-run` first if you want to preview.
   - The script copies only the files/directories you marked with `"promote": true`, preserving repo-only files like `README.md`.
6. Run `repo/scripts/check-deployment-sync.sh` (automatically invoked by the pre-commit hook) to confirm workspace/repo parity. If it reports differences, re-run the promotion script or update the session log accordingly—**never** fix discrepancies with raw `rsync -a --delete`.
7. Reference the session log in your final handoff/PR description so future agents know what was promoted.

### Workspace layout

- `workspace/` – Sanitized Eleventy projects, Playwright tests, and templates used for development. Run `./repo/scripts/export_workspace_samples.sh` before every commit to copy the sanitized directories (`allowlist/`, `cloudfront/`, `etl-output/`, `gcloud/`, `gcloud-config/`, `harrisonfamily-frontend/`, `tests/login-flow`) into the repo root so collaborators get the same structure.
- `workspace-local/` – Environment-specific or sensitive data (real allowlists, CloudFront exports, ETL output, gcloud configs). This directory is ignored and must never be committed.

When onboarding a new environment:
1. Clone the repo (sanitized directories already live at the root).
2. Rename the cloned `repo/` directory to `workspace/` (or copy it) so local scripts resolve correctly.
3. Populate `workspace-local/` with the real data referenced in the sanitized samples.

## 0.2 Manual secret configuration

The repository only contains placeholder values. After each deployment:

1. **Google OAuth client IDs**
   - Real JSON configs live at `workspace-local/docs-dev/oauth_harrisonfamily*.json`.
   - The Eleventy build emits `REPLACE_WITH_GOOGLE_CLIENT_ID`. After GitHub Actions completes, run the AWS CLI patch script to update **both** `js/auth.js` and every HTML page that embeds `HFY_AUTH_CONFIG` (root `/index.html` plus `/about/`, `/contact/`, `/family-login/`, `/logged-out/`, `/privacy/`, `/search/`, `/terms/`, `/person/`, `/private/`).
   - **Important:** Always upload these patched HTML files with the correct metadata or browsers will download them instead of rendering. Use `aws s3 cp --content-type 'text/html; charset=utf-8' --cache-control 'max-age=300, public' --sse AES256`. On 2025-11-08 we skipped this flag and CloudFront served `Content-Type: binary/octet-stream`, breaking the homepage. Repeat the same metadata for every HTML page you patch.
2. **Allowlists**
   - Real allowlist and hash files live at `workspace-local/allowlist/`.
   - Run `scripts/infra/publish_allowlists.sh` (which reads workspace-local files) to push the updated data to S3 + Google Secret Manager.
3. **GCloud OAuth files**
   - Keep the actual OAuth JSON/TXT files under `workspace-local/docs-dev/`. The `docs/dev/` copies in Git are placeholders for documentation only.

Document every manual secret update in the session log so the next agent knows which assets were touched.

## 1. Eleventy templates & assets (workspace → repo/11ty)

All source templates and front-end scripts live under `projects/harrisonfamily/workspace/11ty-dev/`. When you run `npm run build`, Eleventy emits `_site/` which we copy to `repo/11ty/`.

| Category | Workspace path | Contains PII? | Notes |
|----------|----------------|--------------|-------|
| Layouts | `src/layouts/base.njk`, `src/layouts/page.njk`, etc. | FALSE | Provide shared HTML structure (head, navbar, footer). |
| Pages | `src/index.njk`, `src/about/index.njk`, `src/contact/index.njk`, `src/privacy/index.njk`, `src/terms/index.njk`, `src/private/index.njk`, `src/person.njk`, `src/search.njk`, `src/family-login.njk`, `src/logged-out.njk` | FALSE | Each page references the components below. |
| Data files | `src/_data/site.js`, `src/_data/featureFlags.js`, `src/_data/auth.js`, `src/_data/navigation.js`, `src/_data/mediaData.js`, `src/_data/personData.js` | FALSE | Inject global config, feature flags, etc. |
| Static assets | `public/css/main.scss`, `public/js/person-page.js`, `public/js/search-results.js`, `public/js/search-navbar.js`, `public/js/auth.js`, `public/js/feature-flags.js`, `public/images/*`, `public/fonts/*` | FALSE | SCSS, JS, and images (logos, backgrounds) copied into `_site/`. |
| Bootstrap overrides | `src/_includes/css/main.scss`, `src/_includes/css/custom-variables.scss` | FALSE | SCSS entry point, imported by `public/css/main.scss`. |

**Promotion steps:**
1. Record every Eleventy-related file you touched in the session log (`workspace/session-logs/...json`).
2. Run `HFY_ENV=prod HFY_DATA_BASE=https://harrisonfamily.us/person/ HFY_MEDIA_BASE=https://harrisonfamily.us/media/ npm run build` inside `workspace/11ty-dev`.
3. Promote the generated assets using the helper script:
   ```bash
   ./repo/scripts/promote_workspace_assets.sh --log docs/session-logs/<your-log>.json
   ```
   The script copies only the entries flagged with `"promote": true` (JS bundles, CSS, HTML, etc.) into `repo/11ty/` without touching repo-only files.
4. Verify parity (pre-commit runs automatically) and commit/push. The repo now contains `repo/11ty/index.html`, `repo/11ty/search/index.html`, `repo/11ty/js/*.js`, `repo/11ty/css/*.css`, etc.—all safe to commit.

> [!WARNING]
> Never run `rsync -a --delete workspace/11ty-dev/_site/ repo/11ty/` directly. That command will remove repo-only files (e.g., docs, README) if they are not present in `_site/`. Always use `scripts/promote_workspace_assets.sh` so only the files recorded in your session log are copied.

## 2. Front-end scripts (workspace → repo/11ty/js)

| Script | Purpose | Workspace source | Contains PII? |
|--------|---------|------------------|---------------|
| `person-page.js` | Fetches person JSON, renders SPA, gates access | `public/js/person-page.js` | FALSE |
| `search-results.js` | Enforces auth, loads search manifests, renders results | `public/js/search-results.js` | FALSE |
| `search-navbar.js` | Autocomplete dropdown in navbar | `public/js/search-navbar.js` | FALSE |
| `auth.js` | Google Sign-In helpers, logout redirect | `public/js/auth.js` | FALSE |
| `feature-flags.js` | Controls visibility of gated elements, manages session tokens | `public/js/feature-flags.js` | FALSE |
| `bootstrap.bundle.min.js` | Vendor bundle copied from `node_modules/bootstrap/dist/js/` | generated during build | FALSE |

These scripts compile/copied into `repo/11ty/js/`. Do not modify them directly in the repo—edit the workspace source instead and rebuild.

## 3. CSS/SCSS (workspace → repo/11ty/css)

| File | Description | Contains PII? |
|------|-------------|---------------|
| `src/_includes/css/custom-variables.scss` | Custom color palette and Bootstrap overrides. | FALSE |
| `src/_includes/css/main.scss` | Entry point importing Bootstrap + custom styles. | FALSE |
| `public/css/main.scss` | Build script wrapper that outputs `public/css/main.css`. | FALSE |
| `repo/11ty/css/main.css` | Compiled/minified CSS after build (safe to commit). | FALSE |

## 4. Serverless functions

| Component | Location | Contains PII? | Notes |
|-----------|----------|---------------|-------|
| AWS Lambda `hfy-check-allowed` | `scripts/auth/check-allowed-lambda/` (workspace) → `repo/lambda/hfy-check-allowed/` | FALSE | Contains `index.mjs`, `package.json`, `package-lock.json`. Run `npm ci` during deployment. **Do not commit `node_modules/`.** |
| Google Cloud Function `getAllowlist` | `workspace/gcloud/allowlist-fn/` → `repo/functions/get-allowlist/` | FALSE | `main.py` + `requirements.txt`. Deployed with `gcloud functions deploy`. |

The GitHub Action bundles both functions using these directories.

## 5. Data & media (never in repo)

| Asset | Workspace path | Destination | Contains PII? | Notes |
|-------|----------------|-------------|---------------|-------|
| Person JSON | `workspace/etl-output/person/*.json` → `workspace/harrisonfamily-frontend/person/` | `s3://harrisonfamily-frontend/person/` | TRUE | Generated by ETL. **Never commit.** |
| Media binaries | `workspace/etl-output/media/*` | `s3://harrisonfamily-frontend/media/` | TRUE | Includes images, videos, SVG trees. **Never commit.** |
| Search manifests | `workspace/harrisonfamily-frontend/person/index.json`, `search-index.json` | S3 `person/index.json`, `person/search-index.json` | TRUE | Built by `npm run build:search`. Upload directly. |
| `userGrampsID.json` | `docs/dev/userGrampsID.json` | `s3://harrisonfamily/config/userGrampsID.json` | TRUE | Produced via `scripts/infra/publish_allowlists.sh`. **Never commit.** |

## 6. Private infrastructure updates

After GitHub Actions deploys the static site (S3 + CloudFront), apply any required private updates manually. Examples:

- **Allowlist / whitelist**: run `scripts/infra/publish_allowlists.sh` (uses workspace-local data) and verify via AWS + Google Secret Manager.
- **CloudFront behavior changes**: update the distribution using the workspace-local config file, then invalidate caches as needed.
- **ETL outputs / person JSON**: sync the real `workspace-local/harrisonfamily-frontend/` to `s3://harrisonfamily-frontend/` using `scripts/etl/sync_to_s3.py`.
- **Lambda / GCF secrets**: deploy from workspace-local bundles (never from sanitized copies).

Document these manual steps in the session log so future agents know which private assets were touched.
| `harrisonfamily-allowlist.json` | `docs/dev/harrisonfamily-allowlist.json` | Google Secret Manager (`harrisonfamily-allowlist`) | TRUE | Contains email addresses. **Never commit.** |
| Gramps DB | `~/.local/share/gramps/...` | Local only | TRUE | Read-only source for ETL. |

## 6. Automation & scripts

| Script | Purpose |
|--------|---------|
| `scripts/etl/export_person_data.py` | Primary ETL from Gramps SQLite → normalized JSON. |
| `scripts/etl/build_family_tree_media.py` | Generates Graphviz SVGs for `/person`. |
| `scripts/etl/sync_to_s3.py` | Wrapper around `aws s3 sync`. |
| `scripts/search/build_search_index.js` | Generates search manifest + index. |
| `scripts/infra/publish_allowlists.sh` | Uploads `userGrampsID.json` to S3 and adds a new Secret Manager version. |
| `.github/workflows/deploy.yml` | CI/CD pipeline (S3 sync, CloudFront invalidation, Lambda & GCF deploy). |

## 7. Verification checklist before deployment

1. `npm run build` in `workspace/11ty-dev` with production env vars (ensures templates reference CDN endpoints).
2. `rsync` sanitized `_site/` into `repo/11ty/` (exclude sensitive folders).
3. Run ETL + search build + family tree scripts and upload outputs directly to S3/Secret Manager.
4. Package Lambda & Cloud Function locally (optional) or let GitHub Actions do it on push.
5. Review Git status in `repo/` to ensure only code assets changed.
6. Commit to `main` → CI/CD runs `deploy.yml` (requires AWS + GCP secrets in GitHub).

Keep this file updated whenever new components or scripts are introduced so future deployments remain predictable and PII never leaks into Git.
