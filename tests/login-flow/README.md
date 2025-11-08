# Family Site Login Flow Integration Tests

## Overview

Playwright-based end-to-end test suite that validates the complete authentication workflow for the genealogy site. These tests confirm that Google Sign-In, allowlist verification, and personalized navigation work correctly in production.

## What These Tests Cover

1. **Pre-login State**
   - Family Login link visible in navbar
   - Protected routes redirect to `/family-login/?next=...`
   - Search, "My Record", and logout links remain hidden

2. **Google Sign-In Flow**
   - OAuth popup triggers correctly
   - ID token obtained from Google Identity Services
   - Token sent to `/api/check-allowed` Lambda

3. **Post-login State**
   - Navbar shows "My Record" link with correct Gramps ID
   - Logout link replaces login link
   - Protected routes (`/person`, `/search`) become accessible
   - Personalized navigation routes to user's profile

4. **Data Fetching**
   - Person JSON loads via authenticated fetch
   - Media galleries render with images
   - Family tree SVGs display correctly

## Prerequisites

### 1. Install Dependencies
```bash
cd workspace/tests/login-flow
npm install
npx playwright install chromium webkit firefox
```

**Browsers tested:**
- Chromium (primary)
- WebKit (Safari rendering engine)
- Firefox (optional)

### 2. Set Up Test Credentials

These tests require valid Google OAuth credentials to mint test ID tokens. Store credentials in `workspace-local/tests/login-flow/.env`:

```bash
# workspace-local/tests/login-flow/.env
HFY_GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
HFY_GOOGLE_CLIENT_SECRET=GOCSPX-example_secret
HFY_GOOGLE_REFRESH_TOKEN=1//0example_refresh_token
HFY_TEST_EMAIL=test.user@example.com
HFY_EXPECT_GRAMPS_ID=I0042
```

**How to obtain refresh token:**
1. Follow Google OAuth playground guide: https://developers.google.com/oauthplayground
2. Select "Google OAuth2 API v2" → email scope
3. Authorize with test account email
4. Exchange authorization code for tokens
5. Copy `refresh_token` value

**Alternatively:** Pre-mint a test ID token and skip the refresh flow:
```bash
export HFY_TEST_ID_TOKEN="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3QudXNlckBleGFtcGxlLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJzdWIiOiIxMjM0NTY3ODkwIn0.example_signature"
```

### 3. Configure Test Environment

Optional environment variables to customize test runs:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HFY_SITE_BASE` | `https://yourfamily.us` | Target site URL (use `http://localhost:8081` for local testing) |
| `HFY_EXPECT_GRAMPS_ID` | `I0001` | Expected Gramps ID for test user's "My Record" link |
| `HFY_MINT_HELPER` | `../../scripts/auth/mint_test_id_token.py` | Python script to generate test tokens |
| `HFY_LOGIN_LOG_DIR` | `logs/` | Directory for console/network logs |
| `HFY_TEST_EMAIL` | (none) | Email address for test user (must be in allowlist) |

## Running the Tests

### Full Suite
```bash
cd workspace/tests/login-flow
npm test
```

### Headed Mode (with browser UI)
Useful for debugging test failures interactively:
```bash
npm run test:headed
```

### Single Browser
```bash
npx playwright test --project=chromium
```

### Debug Mode
Step through tests with Playwright Inspector:
```bash
npx playwright test --debug
```

### Watch Mode (re-run on file changes)
```bash
npx playwright test --ui
```

## Test Artifacts

After each run, Playwright generates:

1. **HTML Report:** `playwright-report/index.html`
   - Visual timeline of test steps
   - Screenshots on failures
   - Network activity logs

2. **Console Logs:** `logs/console-TIMESTAMP.log`
   - Browser console output (errors, warnings)
   - Useful for debugging JS failures

3. **HAR Files:** `logs/network-TIMESTAMP.har`
   - Complete network traffic capture
   - Inspect API responses, headers, timing

Open the HTML report:
```bash
npx playwright show-report
```

## Adding New Test Scenarios

### Example: Test Search Functionality
```javascript
test('authenticated user can search for family members', async ({ page }) => {
  // Login (reuse auth helper)
  await loginAsTestUser(page);

  // Navigate to search
  await page.goto('/search/');
  await page.waitForLoadState('networkidle');

  // Type query
  await page.fill('input[type="search"]', 'Smith');
  await page.waitForSelector('.search-result-card');

  // Verify results
  const results = await page.locator('.search-result-card').count();
  expect(results).toBeGreaterThan(0);
});
```

### Example: Test Family Tree Rendering
```javascript
test('person page renders family tree SVG', async ({ page }) => {
  await loginAsTestUser(page);

  await page.goto('/person/?id=I0001');
  await page.waitForSelector('#family-tree-container');

  // Check SVG loaded
  const svg = await page.locator('#family-tree-container svg');
  await expect(svg).toBeVisible();

  // Verify clickable nodes
  const nodes = await page.locator('#family-tree-container svg a').count();
  expect(nodes).toBeGreaterThan(0);
});
```

## Troubleshooting

### Tests Timeout During Login
- **Cause:** `/api/check-allowed` Lambda slow or failing
- **Fix:** Check Lambda CloudWatch logs for errors
- **Workaround:** Increase test timeout in `playwright.config.js`

### "Email not in allowlist" Error
- **Symptom:** Test user receives 403 from `/api/check-allowed`
- **Cause:** `HFY_TEST_EMAIL` missing from `userGrampsID.json` in S3
- **Fix:** Add test email to `workspace-local/allowlist/initial_allowlist.csv` and run `scripts/infra/publish_allowlists.sh`

### Stale ID Token Errors
- **Symptom:** "Invalid token" or "Expired token" responses
- **Cause:** Minted token TTL expired (usually 1 hour)
- **Fix:** Refresh token generation in test setup hook

### Tests Pass Locally but Fail in CI
- **Cause:** GitHub Actions runners have different network/timing
- **Solutions:**
  - Increase `timeout` and `expect.timeout` in config
  - Add explicit `waitForLoadState('networkidle')` calls
  - Use `waitForSelector` instead of fixed delays

### Screenshots Show Blank Page
- **Cause:** JavaScript errors preventing render
- **Fix:** Check `logs/console-*.log` for exceptions
- **Common culprit:** Feature flags not initializing correctly

## CI/CD Integration

### GitHub Actions Example
```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18

      - name: Install dependencies
        run: |
          cd workspace/tests/login-flow
          npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run tests
        env:
          HFY_GOOGLE_CLIENT_ID: ${{ secrets.HFY_GOOGLE_CLIENT_ID }}
          HFY_GOOGLE_CLIENT_SECRET: ${{ secrets.HFY_GOOGLE_CLIENT_SECRET }}
          HFY_GOOGLE_REFRESH_TOKEN: ${{ secrets.HFY_GOOGLE_REFRESH_TOKEN }}
          HFY_TEST_EMAIL: ${{ secrets.HFY_TEST_EMAIL }}
          HFY_SITE_BASE: https://yourfamily.us
        run: |
          cd workspace/tests/login-flow
          npm test

      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: workspace/tests/login-flow/playwright-report/
```

## Security Considerations

1. **Never commit credentials** – Store OAuth secrets in GitHub Secrets or local `.env`
2. **Use test-only accounts** – Create dedicated Google account for E2E tests
3. **Rotate test tokens** – Refresh tokens periodically (every 90 days)
4. **Limit test account permissions** – Test user should have minimal family data access
5. **Clean up test data** – Remove test artifacts from production allowlists before deploying

## Cost Implications

These tests invoke production Lambda and CloudFront:
- Each test run = ~5–10 Lambda invocations (~$0.0001)
- CloudFront requests = ~20–50 per run (~$0.001)
- **Total cost per run:** <$0.01

For CI/CD pipelines running 100 times/month: **~$1/month**

## Extending Coverage

Future test scenarios to consider:
- Multi-browser compatibility (Safari, Edge)
- Mobile viewport testing
- Network throttling (slow 3G simulation)
- Accessibility audits (axe-core integration)
- Visual regression testing (Percy, Chromatic)
- Load testing (K6 or Artillery)

---

**For local development testing without Playwright, see the Eleventy dev server docs in `workspace/11ty-dev/README.md`.**
