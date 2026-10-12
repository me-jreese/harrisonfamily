// HFY-TSK-065: searchV2 (local tier on @io-kit/search) at 375px. Fixture data is synthetic; the corpus fetch is stubbed.
import { test, expect } from "@playwright/test";

const MANIFEST = { people: [
  { grampsId: "I0001", displayName: "Mary Quillfeather", isLiving: false, lifespanSummary: "1901 – 1980", primaryPhoto: null },
  { grampsId: "I0002", displayName: "Tomas Quillfeather", isLiving: true, lifespanSummary: "b. 1975", primaryPhoto: null },
  { grampsId: "I0003", displayName: "Ada Brambleton", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const INDEX = { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };

async function prep(page, { delayMs = 0, manifestStatus = 200 } = {}) {
  await page.addInitScript(() => {
    try { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "test-token", grampsId: null, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); } catch {}
  });
  const hits = [];
  await page.route("**/person/index.json", async (r) => { hits.push("manifest"); if (delayMs) await new Promise((x) => setTimeout(x, delayMs)); r.fulfill(manifestStatus === 200 ? { json: MANIFEST } : { status: manifestStatus, json: {} }); });
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: INDEX }));
  return hits;
}

test("flag on: search page renders, surname query returns local results, 375px clean", async ({ page }) => {
  await prep(page);
  await page.goto("/search/?q=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root).toBeVisible();
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible();
  await expect(root.getByRole("link", { name: /Tomas Quillfeather/ })).toBeVisible();
  await expect(root.getByRole("link", { name: /Brambleton/ })).toHaveCount(0);
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toHaveAttribute("href", "/person/?id=I0001");
  await expect(page.locator("[data-search-page]")).toBeHidden();
  await expect(root.getByRole("heading", { level: 2, name: "people" })).toBeVisible();
  await expect(root.locator(".io-search-header__count")).toHaveText("2 people");
  await expect(root.getByRole("textbox").first()).toHaveAttribute("placeholder", "a first name, a town, or a year");
  const a = await page.evaluate(() => {
    const r = document.querySelector("#hfy-search-v2");
    const small = [];
    r.querySelectorAll("a[href], button, input, select, textarea").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return;
      if (b.height < 43.5) small.push(`${el.tagName} ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    });
    const smallInputs = [...r.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")]
      .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.outerHTML.slice(0, 60));
    return { small, smallInputs, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
  expect(a.small, "targets < 44px").toEqual([]);
  expect(a.smallInputs, "inputs < 16px").toEqual([]);
  expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
});

test("flag on: skeleton while the corpus loads (never blank), no false empty state", async ({ page }) => {
  await prep(page, { delayMs: 1500 });
  await page.goto("/search/?q=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status", { name: "loading the family index" })).toBeVisible();
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("looking…"); // never a false 0
  await expect(root.locator(".io-search-zero")).toHaveCount(0);
  // the skeleton renders after the controls
  expect(await page.evaluate(() => Boolean(document.querySelector("#hfy-search-v2 .io-search__controls").compareDocumentPosition(document.querySelector(".hfy-search__skeleton")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("status", { name: "loading the family index" })).toHaveCount(0);
});

test("flag on: zero results say what to try; an index error is a banner (count hidden, no zero state)", async ({ page }) => {
  await prep(page);
  await page.goto("/search/?q=zzzznomatch&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const zero = page.locator("#hfy-search-v2 .io-search-zero");
  await expect(zero.locator(".io-search-zero__title")).toHaveText('nothing for "zzzznomatch".');
  await expect(zero.locator(".io-search-zero__text")).toHaveText("try a first name, or a town.");
  await zero.getByRole("button", { name: "clear filters" }).click();
  await expect(page.locator("#hfy-search-v2").getByRole("link", { name: /Ada Brambleton/ })).toBeVisible();

  const other = await page.context().newPage();
  await prep(other, { manifestStatus: 500 });
  await other.goto("/search/?q=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = other.locator("#hfy-search-v2");
  await expect(root.getByRole("alert")).toHaveText("that didn't work. try again, or text J.", { timeout: 10_000 });
  await expect(root.locator(".io-search-header__count")).toHaveCount(0);
  await expect(root.locator(".io-search-zero")).toHaveCount(0);
});

test("flag off: old Lunr page, no island", async ({ page }) => {
  await prep(page);
  await page.goto("/search/?q=Quillfeather&hfy_flags=-searchV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-search-page]")).toBeVisible();
  await expect(page.locator("[data-search-results-list] .search-result-card").first()).toBeVisible({ timeout: 10_000 });
  expect(await page.locator("#hfy-search-v2").count()).toBe(0);
});
