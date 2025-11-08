# HFY Login Flow Regression Tests

Playwright suite that validates the post-login experience on `harrisonfamily.us`.

## Setup

1. Install dependencies (outside Git repo root):
   ```bash
   cd /Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/tests/login-flow
   npm install
   npx playwright install chromium webkit
   ```
2. Provide Google auth secrets (never commit):
   ```bash
   export HFY_GOOGLE_CLIENT_ID="7702...apps.googleusercontent.com"
   export HFY_GOOGLE_CLIENT_SECRET="XXXXX"
   export HFY_GOOGLE_REFRESH_TOKEN="1//0example"
   ```
   These values feed `scripts/auth/mint_test_id_token.py`, which the Playwright test calls automatically. Alternatively, set `HFY_TEST_ID_TOKEN` to a pre-minted JWT for manual runs.

3. Optional overrides:
   - `HFY_SITE_BASE` – defaults to `https://harrisonfamily.us`
   - `HFY_EXPECT_GRAMPS` – defaults to `I0111`
   - `HFY_MINT_HELPER` – path to the Python mint script (default `../../scripts/auth/mint_test_id_token.py`)
   - `HFY_LOGIN_LOG_DIR` – where console/request logs are written (default `logs/`)

## Running the suite

```bash
cd /Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/tests/login-flow
npm test
```

Artifacts:
- Playwright HTML report → `workspace/tests/login-flow/playwright-report`
- Console + network error logs → `workspace/tests/login-flow/logs/console-*.log`

Use `npm run test:headed` for interactive debugging.
