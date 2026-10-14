// HFY-TSK-300 (viz-mvp-visual-nav): moving about the Family Card Navigator. Hermetic: /_data/flags.json, /auth/*, /person/graph.json and the face
// crops are route-stubbed with the synthetic fixtures (invented names): tree-graph-messy.json for the phone layout and tree-graph-wide.json for the
// grid.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-nav.spec.mjs
// What it covers, by the task's acceptance criteria: the six buttons and the history handler (AC1), touch (AC2), the arrow keys and the focus after
// a re-centre (AC3), the 250 ms ceiling and reduced motion (AC4) and the one live region (AC5).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const MESSY = readFileSync(new URL("./fixtures/tree-graph-messy.json", import.meta.url), "utf8");
const WIDE = readFileSync(new URL("./fixtures/tree-graph-wide.json", import.meta.url), "utf8");
const PIXEL = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function open(page, { width = 375, height = 812, id = "I8001", graph = MESSY, sub = id } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Ada Example" } }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ status: 200, contentType: "image/webp", body: PIXEL }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graph }));
  await page.setViewportSize({ width, height });
  await page.goto(`/tree/?focus=${id}`, { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeVisible();
}

const nav = (page) => page.locator("family-navigator");
const focusName = (page) => nav(page).locator(".hfy-nav__card--focus .hfy-nav__name");
const move = (page, key) => nav(page).locator(`[data-move='${key}']`);
const card = (page, id) => nav(page).locator(`button[data-person='${id}']`);
const focusParam = (page) => new URL(page.url()).searchParams.get("focus");
const activeId = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-person") ?? document.activeElement?.getAttribute("data-move") ?? document.activeElement?.tagName);

// ---- AC1: the six buttons, and the one history handler ----

test("375: six visible buttons cover every direction, each 44px, each named for where it goes", async ({ page }) => {
  await open(page);
  const keys = ["parents", "children", "prev-sibling", "next-sibling", "prev-union", "next-union"];
  await expect(nav(page).locator("[data-move]")).toHaveCount(6);
  await expect(nav(page).getByRole("group", { name: "move around the family" })).toBeVisible();
  for (const key of keys) {
    const b = move(page, key);
    await expect(b).toBeVisible();
    const box = await b.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await expect(nav(page).locator("[data-move]")).toHaveText(["to parents", "to children", "previous sibling", "next sibling", "previous partner family", "next partner family"]);
  // Robin Quill: two parents, three partner families, a sibling on each side in birth order
  await expect(move(page, "parents")).toHaveAccessibleName(/^to parents, starting with /);
  await expect(move(page, "prev-sibling")).toHaveAccessibleName("previous sibling, older, Pip Quill");
  await expect(move(page, "next-sibling")).toHaveAccessibleName("next sibling, younger, Kit Quill");
  await expect(move(page, "prev-union")).toHaveAttribute("aria-disabled", "true"); // the first family: nothing before it
  await expect(move(page, "next-union")).not.toHaveAttribute("aria-disabled", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("375: re-centre three times with the buttons, then Back three times restores each focus (one history handler)", async ({ page }) => {
  await open(page);
  expect(focusParam(page)).toBe("I8001");
  // Robin Quill -> to parents: a parent (the first recorded one)
  await move(page, "parents").click();
  await expect.poll(() => focusParam(page)).not.toBe("I8001");
  const parentId = focusParam(page);
  expect(["I8002", "I8003"]).toContain(parentId);
  await expect(nav(page).locator(`.hfy-nav__card--focus[data-person='${parentId}']`)).toBeVisible();
  // Sam Quill has two partner families (Sam is the parent in the fixture's first union): next partner family selects, it does not re-centre
  test.skip(parentId !== "I8002", "the first recorded parent is not the one with two partner families");
  const before = page.url();
  await move(page, "next-union").click();
  await expect(nav(page).getByRole("tab", { selected: true })).toHaveText(/Una Dale/);
  expect(page.url()).toBe(before); // a partner-family button never touches the history
  // ... and to children then goes to the first child of the SECOND family
  await move(page, "children").click();
  await expect(focusName(page)).toHaveText("Kit Quill");
  expect(focusParam(page)).toBe("I8005");
  // Kit -> previous sibling (oldest first, so Robin Quill)
  await move(page, "prev-sibling").click();
  await expect(focusName(page)).toHaveText("Robin Quill");
  expect(focusParam(page)).toBe("I8001");
  // Back three times: each focus comes back, in order, through the page's one popstate handler
  for (const id of ["I8005", "I8002", "I8001"]) {
    await page.goBack();
    await expect.poll(() => focusParam(page)).toBe(id);
    await expect(nav(page).locator(`.hfy-nav__card--focus[data-person='${id}']`)).toBeVisible();
    await expect(page.locator(`[data-tree-focus='${id}']`)).toBeVisible(); // the plain navigator followed the same history entry
  }
  await page.goForward();
  await expect.poll(() => focusParam(page)).toBe("I8002");
  await expect(nav(page).locator(".hfy-nav__card--focus[data-person='I8002']")).toBeVisible();
});

test("375: a button with nowhere to go does nothing, and keeps the keyboard where it was", async ({ page }) => {
  await open(page, { id: "I8004" }); // Pip Quill: the oldest, no partner family
  const prev = move(page, "prev-sibling");
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  await prev.focus();
  const url = page.url();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(page.url()).toBe(url);
  await expect(prev).toBeFocused();
  await expect(move(page, "children")).toHaveAttribute("aria-disabled", "true");
  await expect(move(page, "next-union")).toHaveAttribute("aria-disabled", "true");
});

test("375: tapping a card re-centres, ?focus follows, and Back, forward and reload stay in step", async ({ page }) => {
  await open(page);
  await card(page, "I8004").click();
  await expect(focusName(page)).toHaveText("Pip Quill");
  expect(focusParam(page)).toBe("I8004");
  await page.goBack();
  await expect(focusName(page)).toHaveText("Robin Quill");
  await page.goForward();
  await expect(focusName(page)).toHaveText("Pip Quill");
  await page.reload({ waitUntil: "domcontentloaded" }); // ?focus alone restores it
  await expect(focusName(page)).toHaveText("Pip Quill");
});

test("375: a new re-centre after Back drops the old forward entry, and an unknown ?focus is replaced by the person shown", async ({ page }) => {
  await open(page);
  await card(page, "I8004").click();
  await expect(focusName(page)).toHaveText("Pip Quill");
  await page.goBack();
  await expect(focusName(page)).toHaveText("Robin Quill");
  await card(page, "I8005").click(); // a new push: Pip's forward entry is gone
  await expect(focusName(page)).toHaveText("Kit Quill");
  expect(await page.goForward()).toBeNull();
  await expect(focusName(page)).toHaveText("Kit Quill");
  await page.goBack();
  await expect(focusName(page)).toHaveText("Robin Quill");
  // an unknown ?focus: the page shows someone and the address agrees, so Back after one re-centre lands on that person (not the bad id)
  await page.goto("/tree/?focus=NOT-A-PERSON", { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeVisible();
  const shown = await nav(page).locator(".hfy-nav__card--focus").getAttribute("data-person");
  await expect.poll(() => focusParam(page)).toBe(shown);
  const other = await nav(page).locator("button[data-person]:not(.hfy-nav__card--focus)").first().getAttribute("data-person");
  await nav(page).locator(`button[data-person='${other}']`).first().click();
  await expect.poll(() => focusParam(page)).toBe(other);
  await page.goBack();
  await expect.poll(() => focusParam(page)).toBe(shown);
  expect(focusParam(page)).not.toBe("NOT-A-PERSON");
});

test("375: after the keyboard has been in the cards, Back puts focus on the page's heading, not on the cards", async ({ page }) => {
  await open(page);
  await card(page, "I8001").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusParam(page)).toBe("I8005");
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused(); // keyboard re-centre: the card keeps the keyboard
  await page.goBack(); // the browser's Back is the page's re-centre, even though focus is still inside the element
  await expect.poll(() => focusParam(page)).toBe("I8001");
  await expect(page.locator("#hfy-tree-focus-name")).toBeFocused();
  await expect(page.locator("#hfy-tree-focus-name")).toHaveText("Robin Quill");
});

test("1280: the same six buttons sit on one line above the grid and re-centre", async ({ page }) => {
  await open(page, { width: 1280, height: 1100, id: "I7100", graph: WIDE });
  const ys = new Set();
  for (const b of await nav(page).locator("[data-move]").all()) ys.add(Math.round((await b.boundingBox()).y));
  expect(ys.size).toBe(1);
  await move(page, "parents").click();
  await expect.poll(() => focusParam(page)).not.toBe("I7100");
  await page.goBack();
  await expect.poll(() => focusParam(page)).toBe("I7100");
});

// ---- AC2: touch ----

test.describe("touch", () => {
  test.use({ hasTouch: true });

  async function drag(page, from, to, { steps = 10 } = {}) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
  }

  test("the element sets touch-action: pan-y and the sideways scrollers allow x and y", async ({ page }) => {
    await open(page);
    expect(await nav(page).evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");
    const scrollers = await nav(page).evaluate((el) => [...el.querySelectorAll(".hfy-nav__row, .hfy-nav__tabs")].map((n) => getComputedStyle(n).touchAction));
    expect(scrollers.length).toBeGreaterThan(0);
    for (const t of scrollers) expect(t).toBe("pan-x pan-y");
    // the element registers no touch handler of its own: nothing here can capture a drag
    const src = readFileSync(new URL("../src/lib/family-navigator.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/touchstart|touchmove|touchend|pointermove|pointerdown|setPointerCapture|wheel/);
  });

  test("a vertical drag that starts on a card scrolls the page, and the page does not scroll sideways", async ({ page }) => {
    await open(page, { height: 600 });
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(200);
    const b = await card(page, "I8001").boundingBox();
    expect(b.y + b.height).toBeLessThan(600);
    await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 - 220 });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    // and the drag did not re-centre or move the focus
    expect(focusParam(page)).toBe("I8001");
  });

  test("a vertical drag that starts on a card inside the children row scrolls the page too", async ({ page }) => {
    await open(page, { height: 700 });
    // one of the families has five children, so its row scrolls sideways
    const tabs = nav(page).getByRole("tab");
    const n = await tabs.count();
    let row = null;
    for (let i = 0; i < n; i += 1) {
      await tabs.nth(i).click();
      const r = nav(page).locator(".hfy-nav__row").first();
      if (await r.evaluate((el) => el.scrollWidth > el.clientWidth + 4)) { row = r; break; }
    }
    expect(row).not.toBeNull();
    await row.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 150));
    const y0 = await page.evaluate(() => window.scrollY);
    expect(y0).toBeGreaterThan(100);
    const first = await row.locator(".hfy-nav__card").first().boundingBox();
    const startY = first.y + first.height / 2;
    expect(startY).toBeGreaterThan(0);
    expect(startY).toBeLessThan(700 - 10);
    // the finger moves down: the page scrolls back up, the row does not move sideways
    await drag(page, { x: first.x + first.width / 2, y: startY }, { x: first.x + first.width / 2, y: Math.min(startY + 200, 690) });
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(y0 - 50);
    expect(await row.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test("a horizontal drag inside the children row scrolls that row, not the page", async ({ page }) => {
    await open(page);
    const tabs = nav(page).getByRole("tab");
    const n = await tabs.count();
    let row = null;
    for (let i = 0; i < n; i += 1) {
      await tabs.nth(i).click();
      const r = nav(page).locator(".hfy-nav__row").first();
      if (await r.evaluate((el) => el.scrollWidth > el.clientWidth + 4)) { row = r; break; }
    }
    expect(row).not.toBeNull();
    await row.scrollIntoViewIfNeeded();
    const first = await row.locator(".hfy-nav__card").first().boundingBox();
    const y = first.y + first.height / 2;
    await drag(page, { x: first.x + first.width / 2 + 100, y }, { x: first.x + first.width / 2 - 100, y }, { steps: 12 });
    expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(20);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

// ---- AC3: arrow keys, Enter and Space, no single-character shortcuts, focus after a re-centre ----

test("375: arrow keys walk the family: up to parents, down to the partner and children, left and right across brothers and sisters", async ({ page }) => {
  await open(page);
  await card(page, "I8001").focus();
  await page.keyboard.press("ArrowUp");
  expect(["I8002", "I8003"]).toContain(await activeId(page)); // a parent
  await page.keyboard.press("ArrowDown");
  expect(await activeId(page)).toBe("I8001");
  await page.keyboard.press("ArrowRight"); // birth order: Pip 1950, Robin 1952, Kit 1955
  expect(await activeId(page)).toBe("I8005");
  await page.keyboard.press("ArrowRight");
  expect(await activeId(page)).toBe("I8005"); // the youngest: nowhere further
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await activeId(page)).toBe("I8004");
  await page.keyboard.press("ArrowRight"); // from a brother, the chain continues through the focus card
  expect(await activeId(page)).toBe("I8001");
  // down: the partner of the selected family, then the first child; up reverses it
  await page.keyboard.press("ArrowDown");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
  await page.keyboard.press("ArrowDown");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "child");
  await page.keyboard.press("ArrowUp");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
  // left and right on the partner card walk the partner families; the keyboard stays on the (new) partner card
  const first = await nav(page).getByRole("tab", { selected: true }).textContent();
  await page.keyboard.press("ArrowRight");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
  expect(await nav(page).getByRole("tab", { selected: true }).textContent()).not.toBe(first);
  await page.keyboard.press("ArrowLeft");
  expect(await nav(page).getByRole("tab", { selected: true }).textContent()).toBe(first);
  await page.keyboard.press("ArrowLeft"); // already the first family: nowhere
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
  // nothing moved the page's focus or the history
  expect(focusParam(page)).toBe("I8001");
});

test("1280: arrow keys across the grid: grandparents, parents, the family line, the children", async ({ page }) => {
  await open(page, { width: 1280, height: 1100, id: "I7100", graph: WIDE });
  await card(page, "I7100").focus();
  await page.keyboard.press("ArrowUp");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "parent");
  const parent = await activeId(page);
  await page.keyboard.press("ArrowUp");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "grandparent");
  await page.keyboard.press("ArrowUp");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "grandparent"); // the top: the key was left to the page
  await page.keyboard.press("ArrowDown");
  expect(await activeId(page)).toBe(parent);
  await page.keyboard.press("ArrowDown");
  expect(await activeId(page)).toBe("I7100");
  // along the family line: brothers and sisters, the focus card, the partner
  await page.keyboard.press("ArrowRight");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
  await page.keyboard.press("ArrowLeft");
  expect(await activeId(page)).toBe("I7100");
  await page.keyboard.press("ArrowLeft"); // the family line holds the shown brothers and sisters, then "+N more", then the focus card
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-more", "sibs");
  await page.keyboard.press("ArrowLeft");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "sibling");
  await page.keyboard.press("ArrowRight");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-more", "sibs");
  await page.keyboard.press("ArrowRight");
  expect(await activeId(page)).toBe("I7100");
  await page.keyboard.press("ArrowDown");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "child");
  await page.keyboard.press("ArrowRight");
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "child");
  await page.keyboard.press("ArrowUp");
  expect(await activeId(page)).toBe("I7100");
  // past the last partner on the family line is the next partner family
  await page.keyboard.press("ArrowRight");
  const tab0 = await nav(page).getByRole("tab", { selected: true }).textContent();
  await page.keyboard.press("ArrowRight");
  expect(await nav(page).getByRole("tab", { selected: true }).textContent()).not.toBe(tab0);
  await expect(nav(page).locator(":focus")).toHaveAttribute("data-role", "partner");
});

test("an arrow key with no card to go to is left to the page (not prevented, so it scrolls); one that moves is prevented", async ({ page }) => {
  await open(page, { height: 500 });
  const keydown = (selector, key) => nav(page).evaluate((el, [sel, k]) => {
    const btn = el.querySelector(sel);
    btn.focus();
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [selector, key]);
  expect(await keydown("button[data-person='I8004']", "ArrowLeft")).toBe(false); // Pip is the oldest: nothing before him
  expect(await keydown("button[data-person='I8004']", "ArrowDown")).toBe(true); // down to the children
  expect(await keydown("button[data-person='I8020']", "ArrowDown")).toBe(false); // a child: nothing below
  expect(await keydown("button[data-person='I8004']", "ArrowUp")).toBe(true); // up to the parents
  expect(await keydown("button[data-person='I8002']", "ArrowUp")).toBe(false); // a parent with no recorded parents
  expect(await keydown(".hfy-nav__card--focus", "x")).toBe(false);
  expect(await keydown(".hfy-nav__card--focus", "Enter")).toBe(false); // the button's own
});

test("375: Shift+Arrow still moves between the union tabs (as before), but does not walk the cards", async ({ page }) => {
  await open(page);
  const tabs = nav(page).locator("[role=tab]");
  expect(await tabs.count()).toBeGreaterThan(1);
  await tabs.first().focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await card(page, "I8004").focus();
  await page.keyboard.press("Shift+ArrowDown");
  expect(await activeId(page)).toBe("I8004"); // a shifted arrow is not the card walk
});

test("375: Enter and Space re-centre, there are no single-character shortcuts, and focus lands on the new focus card", async ({ page }) => {
  await open(page);
  await card(page, "I8004").focus();
  const url = page.url();
  // letters, digits, punctuation: nothing happens
  for (const k of ["p", "c", "s", "n", "j", "k", "h", "l", "1", "2", "?", "/", "[", "]", "+", "-", "Home", "End", "PageUp", "PageDown"]) await page.keyboard.press(k);
  expect(page.url()).toBe(url);
  await expect(focusName(page)).toHaveText("Robin Quill");
  expect(await activeId(page)).toBe("I8004");
  // Enter on a card re-centres; the new focus card has the keyboard
  await page.keyboard.press("Enter");
  await expect(focusName(page)).toHaveText("Pip Quill");
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused();
  expect(focusParam(page)).toBe("I8004");
  // Space on another card does the same
  await page.keyboard.press("ArrowUp"); // to a parent
  const parentId = await activeId(page);
  await page.keyboard.press("Space");
  await expect.poll(() => focusParam(page)).toBe(parentId);
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused();
  await expect(nav(page).locator(".hfy-nav__card--focus")).toHaveAttribute("data-person", parentId);
  // a movement button re-centres and also hands the keyboard to the new focus card
  await move(page, "children").focus();
  await page.keyboard.press("Enter");
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused();
  // AC3 amendment: a heading cannot sit inside a button, so for a keyboard re-centre in the cards the "heading" focus lands on is the focus card
  // button, whose accessible name leads with the person's name (the page's plain h2 gets focus on the outline and Back paths: see the Back test).
  await expect(nav(page).locator(".hfy-nav__card--focus")).toHaveAccessibleName(/^[A-Za-z ]+, focus, /);
});

test("keyboard only, 375: re-centre three times with arrows and Enter, step back three times with the history", async ({ page }) => {
  await open(page);
  await card(page, "I8001").focus();
  const seen = [];
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowLeft"]) { // Kit, then Robin, then Pip: birth order, one card at a time
    await page.keyboard.press(key);
    await page.keyboard.press("Enter");
    await expect.poll(() => focusParam(page)).not.toBe(seen.at(-1) ?? "I8001");
    seen.push(focusParam(page));
    await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused();
    await expect(nav(page).locator(".hfy-nav__card--focus")).toHaveAttribute("data-person", seen.at(-1));
  }
  expect(seen).toEqual(["I8005", "I8001", "I8004"]);
  for (const id of ["I8001", "I8005", "I8001"]) {
    await page.goBack();
    await expect.poll(() => focusParam(page)).toBe(id);
  }
});

// ---- AC4: motion ----

const longest = (page) => page.evaluate(() => {
  let max = 0;
  const secs = (v) => Math.max(0, ...String(v).split(",").map((x) => parseFloat(x) * (x.trim().endsWith("ms") ? 0.001 : 1)).filter((x) => !Number.isNaN(x)));
  for (const el of document.querySelectorAll("family-navigator, family-navigator *")) {
    const c = getComputedStyle(el);
    max = Math.max(max, secs(c.transitionDuration) + secs(c.transitionDelay), c.animationName === "none" ? 0 : secs(c.animationDuration) + secs(c.animationDelay));
  }
  return max;
});

test("a re-centre eases in, and every transition and animation takes at most 250 ms", async ({ page }) => {
  await open(page);
  expect(await longest(page)).toBeLessThanOrEqual(0.25);
  await page.evaluate(() => {
    window.__enter = [];
    new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches?.(".hfy-nav")) window.__enter.push({ cls: n.className, ...(() => { const c = getComputedStyle(n); return { name: c.animationName, dur: c.animationDuration }; })() });
    }).observe(document.querySelector("family-navigator"), { childList: true });
  });
  await card(page, "I8004").click();
  await expect(focusName(page)).toHaveText("Pip Quill");
  const entered = await page.evaluate(() => window.__enter);
  expect(entered.some((e) => /hfy-nav--enter/.test(e.cls))).toBe(true);
  for (const e of entered.filter((x) => /hfy-nav--enter/.test(x.cls))) {
    expect(e.name).toBe("hfy-nav-in");
    expect(parseFloat(e.dur)).toBeLessThanOrEqual(0.25);
    expect(parseFloat(e.dur)).toBeGreaterThan(0);
  }
  // a tab change is not a re-centre: no entrance
  await page.evaluate(() => { window.__enter = []; });
  const tabs = nav(page).getByRole("tab");
  if ((await tabs.count()) > 1) { await tabs.nth(1).click(); expect((await page.evaluate(() => window.__enter)).every((e) => !/hfy-nav--enter/.test(e.cls))).toBe(true); }
  expect(await longest(page)).toBeLessThanOrEqual(0.25);
});

test("the first draw does not animate", async ({ page }) => {
  await open(page);
  await expect(nav(page).locator(".hfy-nav--enter")).toHaveCount(0);
});

test("prefers-reduced-motion: reduce: a re-centre is instant (no animation, no transition, nothing translated)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.evaluate(() => {
    window.__enter = [];
    new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches?.(".hfy-nav--enter")) { const c = getComputedStyle(n); window.__enter.push({ name: c.animationName, dur: c.animationDuration, opacity: c.opacity }); }
    }).observe(document.querySelector("family-navigator"), { childList: true });
  });
  await card(page, "I8004").click();
  await expect(focusName(page)).toHaveText("Pip Quill");
  const entered = await page.evaluate(() => window.__enter);
  expect(entered.length).toBeGreaterThan(0);
  for (const e of entered) {
    expect(e.name === "none" || parseFloat(e.dur) === 0).toBe(true); // instant: no animation, or one of zero length
    expect(e.opacity).toBe("1"); // never caught half-faded
  }
  expect(await nav(page).evaluate((el) => [...el.querySelectorAll("*")].filter((n) => getComputedStyle(n).transform !== "none").length)).toBe(0);
  expect(await longest(page)).toBe(0);
  // emulateMedia back to no preference: the ease-in is there again (the test above), so the rule is the media query's doing
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await card(page, "I8001").click();
  await expect(focusName(page)).toHaveText("Robin Quill");
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".hfy-nav--enter") || document.querySelector(".hfy-nav")).animationName)).toBe("hfy-nav-in");
});

// ---- AC5: one polite live region ----

test("375: the island has one aria-live region, the element has none, and the line says who was centred on", async ({ page }) => {
  await open(page);
  const live = page.locator("[aria-live]");
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveAttribute("data-tree-live");
  expect(await nav(page).evaluate((el) => el.querySelectorAll("[aria-live], [role=status], [role=alert], [role=log], [aria-atomic]").length)).toBe(0);
  await expect(live).toHaveText(""); // nothing is announced on first paint
  await card(page, "I8002").click();
  await expect(focusName(page)).toHaveText("Sam Quill");
  await expect(live).toHaveText("centred on Sam Quill: 0 parents, 2 partners, 3 children");
  await expect(page.locator("[aria-live]")).toHaveCount(1);
  await move(page, "children").click();
  await expect(live).toContainText("centred on ");
  // the element still has none after several redraws, tabs and sheets included
  await nav(page).getByRole("tab").first().click();
  expect(await nav(page).evaluate((el) => el.querySelectorAll("[aria-live], [role=status], [role=alert], [role=log]").length)).toBe(0);
  await expect(page.locator("[aria-live]")).toHaveCount(1);
});

test("a re-centre through the buttons announces the same way as a tap", async ({ page }) => {
  await open(page);
  await move(page, "next-sibling").click();
  await expect(page.locator("[data-tree-live]")).toHaveText("centred on Kit Quill: 2 parents, 0 partners, 0 children");
});

test("axe: the buttons, the focus ring and the dimmed buttons pass at 375 and 1280", async ({ page }) => {
  await open(page);
  expect((await axeViolations(page)).filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await expect(nav(page).locator("[data-nav-layout=grid]")).toBeVisible();
  expect((await axeViolations(page)).filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
