// HFY-TSK-379 pass 4: the D-11 pre-audit of the hourglass tree's four surfaces at 375, 768 and 1280, in both themes, on the invented people of
// fixtures/tree-graph-hourglass.json: the small tree (person page), the big tree, the family page's new "tree" tab and the "centred on" chip. Flags,
// /person/graph.json, the person JSON, the session and media are route-stubbed; nothing here is real data.
//   no sideways scroll; text at least 16 px (the faces-only size excepted, with every accessible name intact); targets at least 44 px; axe with no
//   violation of any impact; the system focus ring on the first control; aria-current; and under prefers-reduced-motion every duration is 0.
//   PW_CHANNEL=chromium-headless-shell HFY_SITE=<dir> PW_PORT=<free port> npx playwright test tests/hourglass-d11.spec.mjs --workers=1
// HFY_SHOTS=1 HFY_SHOTS_DIR=<folder> also saves the final screenshots there, named <surface>-<case>-<width>-<theme>.png (theme dark or daylight).
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

// The site's service worker would answer chunk requests itself, past the route stubs below.
test.use({ serviceWorkers: "block" });

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const TREE = readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8");
const SHOTS = process.env.HFY_SHOTS ? process.env.HFY_SHOTS_DIR || "" : "";
const NAME = Object.fromEntries(GRAPH.people.map((p) => [p.id, p.name]));
const WIDTHS = [375, 768, 1280];
const SEVEN = ["full", "oneParent", "noParents", "large", "siblings", "pedigree", "partners"];
const ALL = ["minor", "moderate", "serious", "critical"];
const word = (t) => (t === "dark" ? "dark" : "daylight");

const FLAGS = (o) => ({ authV2: true, shellV2: true, personV2: true, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, familyViz: true, familyVizPersonMini: false, familyVizHourglass: true, familyVizKinship: false, familyVizTime: true, familyVizBigTree: false, chatV1: false, ...o });

async function stub(page) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS() }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, json: GRAPH }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/person\/I\d+\.json$/, (r) => {
    const id = /(I\d+)\.json$/.exec(r.request().url())[1];
    return r.fulfill({ json: { ...PERSON, grampsId: id, handle: `h${id}`, displayName: NAME[id] || "Missing Person", familyTreeMedia: { path: `tree_${id}.svg` } } });
  });
  await page.route(/\/media\/tree_I\d+\.svg$/, (r) => r.fulfill({ contentType: "image/svg+xml", body: TREE }));
  await page.route(/\/media\/faces\//, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="gray"/></svg>' }));
}

async function go(page, url, { width, height = 1000, reduced = false, theme = "dark" }) {
  await page.setViewportSize({ width, height });
  await stub(page);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((t) => { try { localStorage.setItem("hfy-theme", t); } catch { /* none */ } }, theme);
  await page.clock.setFixedTime(new Date("2026-12-01T12:00:00Z")); // inside the month of the quiet "new"
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}
const setTheme = async (page, t) => {
  await page.evaluate((x) => document.documentElement.setAttribute("data-theme", x), t);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))); // axe reads the settled colours
  await page.waitForTimeout(120);
};

const SURFACE = {
  small: { scope: ".hfy-hg", url: (id) => `/person/?id=${id}`, ready: async (page, id) => { await expect(page.locator("#person-hero h1")).toHaveText(NAME[id]); await expect(page.locator(".hfy-hg .hfy-tree__card.is-focus")).toBeVisible(); }, current: '[aria-current="page"]' },
  big: { scope: ".hfy-bt", url: (id) => `/tree/?view=tree&focus=${id}&from=${id}`, ready: async (page) => { await expect(page.locator('.hfy-bt [aria-current="true"]')).toBeVisible(); await page.waitForTimeout(80); }, current: '[aria-current="true"]' },
  family: { scope: "[data-tree-ctx], [data-tree-views], [data-tree-seetree]", each: ["[data-tree-ctx]", "[data-tree-views]", "[data-tree-seetree]"], url: (id) => `/tree/?focus=${id}`, ready: async (page) => { await expect(page.locator("[data-tree-ctx]")).toBeVisible(); await expect(page.locator("family-navigator [data-person]").first()).toBeVisible(); await page.waitForTimeout(80); }, current: '[aria-current="true"]' }
};

/** What a person reads and touches inside `scope`, measured in the page. */
const measure = (page, scope) => page.evaluate((sel) => {
  const roots = [...document.querySelectorAll(sel)];
  const out = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, small: [], targets: [], noName: [], slow: [] };
  for (const el of roots.flatMap((r) => [r, ...r.querySelectorAll("*")])) {
    const cs = getComputedStyle(el);
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && parseFloat(cs.fontSize) < 16) out.small.push(`${el.className} ${cs.fontSize}: ${el.textContent.trim().slice(0, 20)}`);
    }
    for (const d of [cs.animationDuration, cs.transitionDuration, cs.scrollBehavior === "smooth" ? "1s" : "0s"]) if (d.split(",").some((x) => parseFloat(x) > 0)) { out.slow.push(`${el.className} ${d}`); break; }
  }
  for (const el of roots.flatMap((r) => [r, ...r.querySelectorAll("a[href], button")]).filter((e) => e.matches("a[href], button"))) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.width < 43.5 || r.height < 43.5) out.targets.push(`${el.className} ${Math.round(r.width)}x${Math.round(r.height)}: ${el.textContent.trim().slice(0, 20)}`);
    if (!(el.getAttribute("aria-label") || el.textContent.trim())) out.noName.push(el.className);
  }
  return out;
}, scope);

/** The first control Tab reaches inside `scope`: its outline, as the system focus ring draws it. */
async function ring(page, scope) {
  await page.evaluate((sel) => { (document.querySelector(sel).matches("a[href], button") ? document.querySelector(sel) : document.querySelector(sel).querySelector("a[href], button") || document.body).focus({ focusVisible: true }); }, scope);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  return page.evaluate((sel) => {
    const e = document.activeElement;
    const cs = getComputedStyle(e);
    return { inside: [...document.querySelectorAll(sel)].some((r) => r.contains(e)), visible: e.matches(":focus-visible"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow };
  }, scope);
}

for (const surface of ["small", "big", "family"]) {
  const S = SURFACE[surface];
  for (const width of WIDTHS) {
    const cases = surface === "family" ? ["full"] : ["full", "large", "pedigree"];
    for (const c of cases) {
      test(`${surface} / ${c} at ${width}: no sideways scroll, text 16px, targets 44px, axe clean, focus ring, aria-current, both themes`, async ({ page }) => {
        const id = CASES[c];
        await go(page, S.url(id), { width });
        await S.ready(page, id);
        for (const t of ["dark", "light"]) {
          await setTheme(page, t);
          const m = await measure(page, S.scope);
          expect(m.overflow, `${t}: sideways scroll`).toBe(false);
          expect(m.small, `${t}: text under 16px`).toEqual([]);
          expect(m.targets, `${t}: targets under 44px`).toEqual([]);
          expect(m.noName, `${t}: a control with no name`).toEqual([]);
          for (const one of S.each || [S.scope]) expect(await axeViolations(page, { include: one, impacts: ALL }), `${t}: axe ${one}`).toEqual([]);
          const r = await ring(page, S.each ? S.each[1] : S.scope);
          expect(r.inside && r.visible, `${t}: the keyboard is on a control of the surface`).toBe(true);
          expect(r.style !== "none" && r.width > 0, `${t}: the system focus ring is drawn (${JSON.stringify(r)})`).toBe(true);
        }
        const current = page.locator(`${S.each ? "[data-island=tree]" : S.scope} ${S.current}`);
        await expect(current.first()).toBeAttached();
        if (surface !== "family") await expect(current).toHaveCount(1);
        if (surface === "family") {
          // the new tab and the chip, and what they are called
          await expect(page.locator("a[data-tree-view=tree]")).toBeVisible();
          await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${NAME[id]}`);
          await expect(page.locator("[data-tree-seetree] a")).toHaveText(`see ${NAME[id].split(" ")[0]} in the tree`);
        }
      });
    }
  }
}

test("the big tree at faces only: names are not shown but every card still has its accessible name; the rest is 16px and 44px", async ({ page }) => {
  const id = CASES.full;
  await go(page, SURFACE.big.url(id), { width: 375 });
  await SURFACE.big.ready(page);
  await page.locator(".hfy-bt__tool.is-all").click();
  await expect(page.locator(".hfy-bt")).toHaveAttribute("data-level", "0");
  const cards = await page.locator(".hfy-bt__canvas button.hfy-tree__card").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
  expect(cards.length).toBeGreaterThan(5);
  for (const [label] of cards) expect(label, "a faces-only card keeps its name").toMatch(/\S, \S|\. (show|put)/);
  for (const [, w, h] of cards) { expect(w).toBeGreaterThanOrEqual(48); expect(h).toBeGreaterThanOrEqual(48); }
  const m = await measure(page, ".hfy-bt");
  expect(m.small).toEqual([]);
  expect(m.overflow).toBe(false);
  for (const t of ["dark", "light"]) {
    await setTheme(page, t);
    expect(await axeViolations(page, { include: ".hfy-bt", impacts: ALL }), t).toEqual([]);
  }
});

for (const surface of ["small", "big", "family"]) {
  test(`${surface}: under prefers-reduced-motion every duration is 0 and a re-centre jumps`, async ({ page }) => {
    const id = CASES.full;
    await go(page, SURFACE[surface].url(id), { width: 375, reduced: true });
    await SURFACE[surface].ready(page, id);
    const m = await measure(page, SURFACE[surface].scope);
    expect(m.slow, "an animation, a transition or smooth scrolling is left").toEqual([]);
    if (surface === "big") {
      const dad = page.locator('.hfy-bt__canvas button[aria-label$=", father"]');
      await dad.click();
      const behaviour = await page.locator(".hfy-bt__stage").evaluate((e) => getComputedStyle(e).scrollBehavior);
      expect(behaviour).toBe("auto");
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().duration > 0).length)).toBe(0);
    }
  });
}

// ---- the final screenshots for the visual check ----
test("screenshots: the small tree's seven cases, the big tree's key cases, and the family page tab and chip", async ({ page }) => {
  test.skip(!SHOTS, "HFY_SHOTS=1 with HFY_SHOTS_DIR=<folder> saves the screenshots");
  test.setTimeout(420_000);
  mkdirSync(SHOTS, { recursive: true });
  const shot = async (locator, name) => {
    for (const t of ["dark", "light"]) {
      await setTheme(page, t);
      await locator.screenshot({ path: `${SHOTS}/${name}-${word(t)}.png` });
    }
  };
  for (const width of WIDTHS) {
    for (const c of SEVEN) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await go(page, SURFACE.small.url(CASES[c]), { width, height: 2600 });
      await SURFACE.small.ready(page, CASES[c]);
      if (c === "siblings") await page.locator(".hfy-hg").getByRole("button", { name: /show them$/ }).click();
      await shot(page.locator(".hfy-hg"), `small-${c}-${width}`);
    }
    const big = { full: {}, large: { tall: true }, siblings: { open: true }, pedigree: { ggp: true }, partners: {} };
    for (const [c, o] of Object.entries(big)) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const id = CASES[c];
      await go(page, `${SURFACE.big.url(id)}${o.ggp ? "&ggp=1" : ""}`, { width, height: o.tall ? 1500 : width >= 1100 ? 900 : 812 });
      await SURFACE.big.ready(page);
      if (o.open) await page.locator('.hfy-bt [data-k^="sibs"]').click();
      await shot(page, `big-${c}-${width}`);
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await go(page, SURFACE.family.url(CASES.full), { width, height: 900 });
    await SURFACE.family.ready(page);
    await shot(page, `family-tab-chip-${width}`);
  }
});
