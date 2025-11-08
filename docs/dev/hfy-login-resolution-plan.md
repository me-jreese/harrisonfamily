# HFY Login Resolution Plan

**Last Updated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Objectives
1. Restore a reliable post-login experience (fix HFY-ISS-015) by ensuring protected assets are accessible immediately after Google auth.
2. Harden the authentication flow so future regressions are caught pre-deploy.
3. Document and automate the build/deploy safeguards required for asset gating.

## Guiding Tasks
- **HFY-TASK-028** – Runtime guardrail for production feature flags (force `enforceAssets` on live site).
- **HFY-TASK-029** – Build validation + deployment automation (scripted checks for `enforceAssets`, client ID, and build artifacts before release).
- **HFY-TASK-030** – Event-driven auth/state handling & UX improvements (spinner gate, unified token lifecycle, improved logout).
- **HFY-TASK-031** – Automated E2E test coverage for login/search/person flow.

## Phase 1 – Immediate Unblock (In Progress)
1. **Hard-code production defaults** (HFY-TASK-028)
   - Default all builds to `enforceAssets=true`.
   - Add runtime guard that logs and overrides if a production page still finds `enforceAssets=false`.
2. **Build Validation Script** (HFY-TASK-029)
   - Verify `_site/**/*.html` includes `enforceAssets":true`.
   - Verify no placeholders like `REPLACE_WITH_GOOGLE_CLIENT_ID` remain.
   - Provide single command to run before promoting assets.
3. **Documentation & SOP updates**
   - Reference this plan from `harrisonfamily-reference.md`.
4. **Redeploy + manual GIS patch** using the validated build.

## Phase 2 – Auth Flow Hardening (Scheduled)
- **Event-driven auth state (HFY-TASK-030)**
  - Emit `authenticated` events from `HFY_AUTH`.
  - Gate `/person`, `/search`, navbar search with spinner + timeout logic.
  - Centralize token storage + expiration checks.
- **Improved logout + session cleanup (HFY-TASK-030)**
  - Revoke Google session, clear storage, redirect.

## Phase 3 – Testing & Monitoring (Planned)
- **E2E Tests (HFY-TASK-031)**
  - Playwright suite: login → search → person page → logout.
  - Run in CI before deploy.
- **Monitoring Hooks**
  - Log when runtime guard auto-corrects feature flags.
  - Alert on CloudFront 403 spikes for `/person/*.json`.

## Deployment Checklist (Updated)
1. Run `npm --prefix workspace/11ty-dev run build` with production env vars.
2. Run `./repo/scripts/validate_build.sh` (HFY-TASK-029 output).
3. Promote artifacts via session log + `promote_workspace_assets.sh`.
4. Commit + push.
5. Wait for GitHub Actions deploy.
6. Apply manual GIS patch + CloudFront invalidation.
7. QA login/search/person flows using allowed account.

## Tracking & Reporting
- Progress for each task recorded in `agents-reference-issues.yaml` + `agents-reference-tasks.yaml`.
- Session logs capture every workspace/repo change for auditability.
- This plan is referenced from `agent-reference/harrisonfamily-reference.md` so new agents load it at session start.
