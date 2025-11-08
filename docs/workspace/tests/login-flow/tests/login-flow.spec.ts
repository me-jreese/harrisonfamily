import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SITE_BASE = process.env.HFY_SITE_BASE ?? "https://harrisonfamily.us";
const EXPECTED_PERSON_ID = process.env.HFY_EXPECT_GRAMPS ?? "I0111";
const LOG_DIR =
  process.env.HFY_LOGIN_LOG_DIR ??
  path.resolve(process.cwd(), "logs");
const MINT_HELPER =
  process.env.HFY_MINT_HELPER ??
  path.resolve(process.cwd(), "../../scripts/auth/mint_test_id_token.py");

function mintToken(): string {
  if (process.env.HFY_TEST_ID_TOKEN) {
    return process.env.HFY_TEST_ID_TOKEN.trim();
  }
  const output = execSync(`python3 ${MINT_HELPER}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
  if (!output) {
    throw new Error("Mint helper returned empty token output");
  }
  return output;
}

test("HFY authenticated navbar + search flow", async ({ page }) => {
  const consoleLogs: string[] = [];
  const requestErrors: string[] = [];

  page.on("console", (msg) => {
    consoleLogs.push(
      `[${msg.type()}] ${msg.text()}`
    );
  });
  page.on("requestfailed", (req) => {
    requestErrors.push(
      `[${req.failure()?.errorText}] ${req.method()} ${req.url()}`
    );
  });

  const token = mintToken();

  await page.goto(`${SITE_BASE}/family-login/`, { waitUntil: "networkidle" });

  await page.evaluate((cred) => {
    window.HFY_AUTH?.handleCredentialResponse?.({ credential: cred });
  }, token);

  await expect(page.locator("[data-auth-signout]")).toBeVisible();

  const myRecordLink = page.locator("[data-my-record-link]");
  await myRecordLink.waitFor({ state: "visible" });
  await expect(myRecordLink).toHaveAttribute(
    "href",
    new RegExp(`/person/\\?id=${EXPECTED_PERSON_ID}`)
  );

  const navbarLogout = page.locator("[data-auth-signout-link]");
  await expect(navbarLogout).toBeVisible();

  const searchInput = page.locator("[data-search-input]");
  await searchInput.fill("Reese");
  await expect(page.locator("[data-search-list] li").first()).toBeVisible();

  await searchInput.press("Enter");
  await expect(page).toHaveURL(new RegExp("/search/?"));
  await expect(page.locator("[data-search-results-list] li").first()).toBeVisible();

  // Navigate back to login to confirm redirect to My Record triggers.
  await page.goto(`${SITE_BASE}/family-login/`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(
    new RegExp(`/person/\\?id=${EXPECTED_PERSON_ID}`)
  );

  await page.goto(`${SITE_BASE}/`, { waitUntil: "domcontentloaded" });
  await navbarLogout.click();
  await expect(page).toHaveURL(new RegExp("/logged-out/?"));

  mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    path.join(LOG_DIR, `console-${timestamp}.log`),
    consoleLogs.join("\n"),
    "utf-8"
  );
  if (requestErrors.length) {
    writeFileSync(
      path.join(LOG_DIR, `requests-${timestamp}.log`),
      requestErrors.join("\n"),
      "utf-8"
    );
  }
});
