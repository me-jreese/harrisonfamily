# Workspace Samples

This directory mirrors the sanitized contents of `projects/harrisonfamily/workspace/`. Each subdirectory can be copied verbatim when bootstrapping a new environment. For real deployments, store secrets/PII under `workspace-local/` and run:

```bash
python scripts/sync_sanitized_assets.py --sync
./repo/scripts/export_workspace_samples.sh
```

before committing so these samples stay in sync with the sanitized workspace.
