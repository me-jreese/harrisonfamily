# Allowlist Template

This directory contains sample artifacts for onboarding a new Harrison Family deployment.

- `harrisonfamily-allowlist.template.json` – Example plain-text email array.
- `allowed_hashes.template.json` – Example HMAC outputs (non-functional).

When creating a real environment, copy these templates into `workspace-local/allowlist/`, replace with actual emails, and run `scripts/infra/publish_allowlists.sh`.
