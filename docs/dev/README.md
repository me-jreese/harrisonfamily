This directory contains sanitized templates for developer docs (copied from the non-repo `docs/dev` tree). Do **not** store real secrets here.

Place the real files under `workspace-local/docs-dev/`:
- `harrisonfamily-allowlist.json`
- `oauth_harrisonfamily*.json`
- `oauth_harrisonfamily*.txt`

Scripts such as `scripts/infra/publish_allowlists.sh` and manual AWS/GCP updates should reference the workspace-local copies.
