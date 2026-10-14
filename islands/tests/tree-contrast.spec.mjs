// HFY-TSK-302 (viz-mvp-visual-perf) AC4: the Family Card Navigator needs no new tokens. This is the viz ADR 4.9 measurement, repeated against the
// tokens the BUILT theme pins now (@io-kit/tokens as installed in 11ty/css/hfy-theme.css): at least 3:1 (WCAG 2.2 1.4.11 non-text contrast) in dark
// and in light for
//   - the dashed `border-strong` border of the "not recorded" card, against `surface-raised` (the card's own fill) and `surface` (the page);
//   - the `focus` ring, against `surface-raised` and `surface`.
// If a pair ever falls below 3:1 this test fails, and the fix is not to loosen it: the task records that iokit-tokens-viz is needed for the MVP and the
// dependency (viz-mvp-visual-perf on iokit-tokens-viz) is restored.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-contrast.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { NON_TEXT_MIN, contrast, parseColor } from "./contrast.mjs";

const GRAPH = readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8");
const TOKENS = { surface: "--io-color-semantic-surface", raised: "--io-color-semantic-surface-raised", borderStrong: "--io-color-semantic-border-strong", focus: "--io-color-semantic-focus" };

async function open(page, scheme) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9010", label: "Ada Example" } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ contentType: "application/json", body: GRAPH }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tree/?focus=I9010", { waitUntil: "domcontentloaded" });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  // dark is the default theme; light is [data-theme=light] (the same switch the theme layer and the shell use)
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

/** The colour a token resolves to right now, as "rgb(r, g, b)", read back through a canvas so any CSS colour syntax lands in sRGB. */
const resolveToken = (page, name) => page.evaluate((n) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${n})`;
  document.body.append(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { css, rgb: `rgb(${r}, ${g}, ${b})`, a };
}, name);

for (const scheme of ["dark", "light"]) {
  test(`${scheme}: dashed border-strong and the focus ring are at least 3:1 against surface-raised and surface`, async ({ page }) => {
    await open(page, scheme);
    const c = {};
    for (const [k, v] of Object.entries(TOKENS)) {
      const r = await resolveToken(page, v);
      expect(r.a, `${v} is opaque`).toBe(255);
      c[k] = parseColor(r.rgb);
    }
    const pairs = {
      "border-strong / surface-raised": contrast(c.borderStrong, c.raised),
      "border-strong / surface": contrast(c.borderStrong, c.surface),
      "focus / surface-raised": contrast(c.focus, c.raised),
      "focus / surface": contrast(c.focus, c.surface)
    };
    test.info().annotations.push({ type: "contrast", description: Object.entries(pairs).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("; ") });
    for (const [pair, ratio] of Object.entries(pairs)) expect(ratio, `${scheme} ${pair}`).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });

  test(`${scheme}: the rendered "not recorded" card really uses the dashed border-strong token, and a keyboard-focused card really uses the focus token`, async ({ page }) => {
    await open(page, scheme);
    const border = await resolveToken(page, TOKENS.borderStrong);
    const focus = await resolveToken(page, TOKENS.focus);
    const missing = page.locator("family-navigator .hfy-nav__missing").first();
    await expect(missing).toBeVisible();
    const style = await missing.evaluate((el) => { const s = getComputedStyle(el); return { style: s.borderTopStyle, color: s.borderTopColor, width: s.borderTopWidth }; });
    expect(style.style).toBe("dashed");
    expect(parseColor(style.color)).toEqual(parseColor(border.rgb));
    await page.keyboard.press("Tab"); // keyboard modality, so :focus-visible matches the card focused next
    await page.locator("family-navigator button.hfy-nav__card").first().focus();
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, color: s.outlineColor, width: s.outlineWidth }; });
    expect(ring.style).not.toBe("none");
    expect(parseColor(ring.color)).toEqual(parseColor(focus.rgb));
  });
}
