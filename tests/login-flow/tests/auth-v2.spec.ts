import { test, expect } from "@playwright/test";

// HFY-TSK-062 (AC4): the two-path sign-in at /auth/login. Runs against prod once /_data/flags.json has authV2:true:
//   HFY_AUTH_V2=1 HFY_SITE_BASE=https://harrisonfamily.us npx playwright test auth-v2
// The password path needs a real pool user that is on the allowlist: HFY_TEST_EMAIL, HFY_TEST_PASSWORD, HFY_EXPECT_GRAMPS (default I0111).
const ON = process.env.HFY_AUTH_V2 === "1";
const EMAIL = process.env.HFY_TEST_EMAIL;
const PASSWORD = process.env.HFY_TEST_PASSWORD;
const EXPECTED = process.env.HFY_EXPECT_GRAMPS ?? "I0111";

test.describe("auth v2 (flag on)", () => {
  test.skip(!ON, "set HFY_AUTH_V2=1 once authV2 is true");

  test("/family-login/ redirects to /auth/login", async ({ page }) => {
    await page.goto("/family-login/");
    await page.waitForURL(/\/auth\/login/);
  });

  test("login page offers both paths: Google and email + password", async ({ page }) => {
    await page.goto("/auth/login");
    await expect(page.locator("section.path")).toHaveCount(2);
    await expect(page.locator("form#pw input[type=email], form#pw input[name=email]")).toBeVisible();
    await expect(page.locator("form#pw input[type=password]")).toBeVisible();
    await expect(page.locator("#path-google, #g_id_onload, [data-gis], div.g_id_signin, #gis")).not.toHaveCount(0);
  });

  test("JWKS is published and unauthenticated session is reported", async ({ request }) => {
    const jwks = await (await request.get("/auth/.well-known/jwks.json")).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(jwks.keys[0].d).toBeUndefined();
    expect(await (await request.get("/auth/session")).json()).toEqual({ authenticated: false });
  });

  test("password path signs in and My Record resolves to /person/?id=<gramps_id>", async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "HFY_TEST_EMAIL / HFY_TEST_PASSWORD not provided");
    await page.goto("/auth/login");
    await page.fill("form#pw input[type=email], form#pw input[name=email]", EMAIL!);
    await page.fill("form#pw input[type=password]", PASSWORD!);
    await page.click("form#pw button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/login"));
    const s = await (await page.request.get("/auth/session")).json();
    expect(s).toMatchObject({ authenticated: true, sub: EXPECTED });
    const my = page.locator("[data-my-record-link]");
    await expect(my).toHaveAttribute("href", `/person/?id=${EXPECTED}`, { timeout: 15_000 });
  });
});
