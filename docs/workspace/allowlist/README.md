# Allowlist Samples

This directory contains sanitized artifacts for onboarding a new Harrison Family deployment.

- `harrisonfamily-allowlist.json` – Example plain-text email array.
- `allowed_hashes.json` – Example HMAC outputs (non-functional).

When creating a real environment, copy these samples into `workspace-local/allowlist/`, replace with actual emails, and run `scripts/infra/publish_allowlists.sh`.
