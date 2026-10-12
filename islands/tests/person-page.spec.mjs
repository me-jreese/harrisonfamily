// HFY design-system pass (legacy area): the person page (11ty/js/person-page.js + the 45-person partial) against the DS
// PersonRecord, FamilyTree and Lightbox specs. Synthetic data only: fixtures/person-legacy.json and fixtures/tree-synthetic.svg
// (Graphviz output with the ETL's attribute shape); /auth, /api, the flags file and media are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-page.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const TREE = readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8");
const URL_PATH = "/person/?id=I9001";
const ROLES = { I9010: "grandparent", I9011: "grandparent", I9012: "parent", I9013: "parent", I9001: "focus", I9014: "sibling", I9002: "spouse", I9015: "child", I9016: "grandchild" };
const photo = (name) => {
  const tall = /2$/.test(name);
  const [w, h] = tall ? [600, 900] : [800, 600];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`;
};

async function stub(page, { shell = true, personV2 = false, hold = null, status = 200 } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: shell, personV2, postsV2: false, searchV2: false, notifyV2: false } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/**", (r) => r.fallback());
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", async (r) => {
    if (hold) await hold;
    return status === 200 ? r.fulfill({ json: PERSON }) : r.fulfill({ status, json: { error: "x" } });
  });
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: TREE }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: photo(r.request().url().match(/MPHOTO\d/)[0]) }));
}

async function openPerson(page, opts = {}) {
  await stub(page, opts);
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
}

const contrast = (a, b) => {
  const lum = (c) => { const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("loading: skeletons in surface.sunken, every section hidden until the person renders", async ({ page }) => {
  let release;
  const hold = new Promise((r) => { release = r; });
  await stub(page, { hold });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  const loading = page.locator("#person-loading");
  await expect(loading).toBeVisible();
  await expect(loading).toContainText("loading…");
  await expect(loading).not.toContainText(/record/i);
  expect(await loading.locator(".person-skeleton__portrait").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(13, 12, 10)");
  await expect(page.locator("#person-content")).toBeHidden();
  for (const id of ["person-hero-section", "person-events-section", "person-family-section", "person-media-section"]) await expect(page.locator(`#${id}`)).toBeHidden();
  release();
  await expect(page.locator("#person-hero h1")).toBeVisible();
  await expect(loading).toBeHidden();
});

test("hero, section order, voice: lifespan line, lowercase headings, no IDs and no 'record'", async ({ page }) => {
  await openPerson(page);
  await expect(page.locator(".person-lifespan")).toHaveText("1900 – 1975 · Example Parish, Louisiana");
  const lifespan = await page.locator(".person-lifespan").evaluate((el) => getComputedStyle(el).color);
  expect(lifespan).toBe("rgb(205, 191, 166)");
  const h1 = await page.locator("#person-hero h1").evaluate((el) => ({ font: getComputedStyle(el).fontFamily, weight: getComputedStyle(el).fontWeight, size: getComputedStyle(el).fontSize }));
  expect(h1).toMatchObject({ weight: "400", size: "36px" });
  expect(h1.font).toMatch(/^"?Libre Caslon Text"?,/);
  expect(await page.locator("#person-hero .person-photo").getAttribute("style")).toBeNull();
  // sections in DS order; the personV2 comments host (when on) comes after them
  const order = await page.evaluate(() => [...document.querySelectorAll("#person-content > section")].map((s) => s.querySelector("h2")?.textContent.trim() ?? s.id));
  expect(order).toEqual(["person-hero-section", "life", "family", "photos", "stories"]);
  await expect(page.locator("#person-stories-section .notes-panel")).toContainText("LEGACY NOTE");
  const text = await page.locator("#person-app").innerText();
  expect(text).not.toMatch(/\b[IO]\d{4}\b/);
  expect(text).not.toMatch(/record/i);
  expect(text).not.toMatch(/\bGender\b|\bDeceased\b|\bLiving\b/);
  await expect(page.locator(".timeline-row").nth(1)).toContainText("date unknown");
  await expect(page.locator(".timeline-row").nth(1)).toContainText("event");
  await expect(page.locator("#person-family-data")).toContainText("living");
  for (const link of await page.locator("#person-family-data a").all()) expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("personV2: the comments host is the last child of #person-content, after the four sections", async ({ page }) => {
  await openPerson(page, { personV2: true });
  await expect(page.locator("#hfy-person-comments")).toBeAttached();
  const last = await page.evaluate(() => document.getElementById("person-content").lastElementChild.id);
  expect(last).toBe("hfy-person-comments");
  await expect(page.locator("#person-stories-section .notes-panel h2")).toHaveText("stories");
});

test("timeline: rows at least 56px, date in the mono face, text.dim", async ({ page }) => {
  await openPerson(page);
  const rows = await page.locator(".timeline-row").evaluateAll((els) => els.map((el) => {
    const d = el.querySelector(".timeline-date");
    return { h: el.getBoundingClientRect().height, font: getComputedStyle(d).fontFamily, size: getComputedStyle(d).fontSize, color: getComputedStyle(d).color };
  }));
  expect(rows.length).toBe(3);
  for (const r of rows) {
    expect(r.h).toBeGreaterThanOrEqual(56);
    expect(r.font).toMatch(/^"?Source Code Pro"?,/);
    expect(r).toMatchObject({ size: "16px", color: "rgb(205, 191, 166)" });
  }
});

// The toolbar has its own band: at no width (and no pan) does it sit on a family member's name; the first view is the whole tree when
// fitting keeps the labels at the 16px floor, else the natural size centred on the focus person.
for (const width of [375, 688, 1024]) {
  test(`family tree at ${width}px: the toolbar never covers a node label, first view keeps labels >= 16px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openPerson(page);
    await expect(page.locator(".family-tree-embed.tree g.node.focus")).toHaveCount(1);
    await page.waitForTimeout(100);
    const probe = () => page.evaluate(() => {
      const bar = document.querySelector(".tree-toolbar").getBoundingClientRect();
      const view = document.querySelector(".family-tree-embed").getBoundingClientRect();
      const labels = [...document.querySelectorAll(".family-tree-embed g.node text")].map((t) => t.getBoundingClientRect());
      // only what is painted: the part of each label inside the scroll viewport
      const shown = labels.map((r) => ({ left: Math.max(r.left, view.left), right: Math.min(r.right, view.right), top: Math.max(r.top, view.top), bottom: Math.min(r.bottom, view.bottom) })).filter((r) => r.right > r.left && r.bottom > r.top);
      const overlap = shown.filter((r) => r.right > bar.left && r.left < bar.right && r.bottom > bar.top && r.top < bar.bottom).length;
      const inside = labels.filter((r) => r.left >= view.left - 0.5 && r.right <= view.right + 0.5 && r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5).length;
      return { overlap, inside, n: labels.length, barBottom: bar.bottom, viewTop: view.top, minPx: Math.min(...[...document.querySelectorAll(".family-tree-embed g.node text")].map((t) => parseFloat(t.getAttribute("font-size")) * t.getScreenCTM().a)), fit: document.querySelector('[data-tree-action="fit"]').getAttribute("aria-pressed"), focus: (() => { const f = document.querySelector(".family-tree-embed g.node.focus").getBoundingClientRect(); return f.left >= view.left && f.right <= view.right && f.top >= view.top && f.bottom <= view.bottom; })() };
    });
    let p = await probe();
    expect(p.viewTop, "the drawing starts below the toolbar band").toBeGreaterThanOrEqual(p.barBottom - 0.5);
    expect(p.overlap, "labels under the toolbar").toBe(0);
    expect(p.focus, "the focus person is in view").toBe(true);
    if (p.fit === "true") {
      expect(p.inside, "fit shows every node").toBe(p.n);
      expect(p.minPx, "fit keeps the labels at the 16px floor").toBeGreaterThanOrEqual(15.9);
    }
    // pan to the far corner and zoom: still nothing under the toolbar
    await page.locator(".family-tree-embed").evaluate((el) => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
    await page.locator("#person-family-visualization").getByRole("button", { name: "zoom in" }).click();
    p = await probe();
    expect(p.overlap, "labels under the toolbar after pan and zoom").toBe(0);
  });
}

for (const [width, cols] of [[375, 1], [688, 2], [1024, 3]]) {
  test(`gallery at ${width}px: ${cols} column(s), 4:5 contain on surface.sunken`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openPerson(page);
    const items = await page.locator("#person-media-grid .gallery-item").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(items.filter((top) => top === items[0]).length).toBe(cols);
    const img = await page.locator(".gallery-photo").first().evaluate((el) => ({ fit: getComputedStyle(el).objectFit, ratio: el.getBoundingClientRect().width / el.getBoundingClientRect().height, bg: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderTopLeftRadius }));
    expect(img).toMatchObject({ fit: "contain", bg: "rgb(13, 12, 10)", radius: "8px" });
    expect(img.ratio).toBeCloseTo(0.8, 1);
    expect(await page.evaluate(() => [...document.querySelectorAll("[data-io-scroller]")].every((s) => s.scrollWidth <= s.clientWidth + 1) && document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test("family tree: roles tagged from the fills, label ink contrast, toolbar, legend", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await openPerson(page);
  await expect(page.locator(".family-tree-embed.tree g.node.focus")).toHaveCount(1);
  const nodes = await page.locator(".family-tree-embed g.node[data-role]").evaluateAll((els) => els.map((g) => {
    const a = g.querySelector("a");
    const href = a.getAttribute("href") || a.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const shape = g.querySelector("path, polygon, ellipse");
    const text = g.querySelector("text");
    return { id: new URL(href, location.origin).searchParams.get("id"), role: g.getAttribute("data-role"), cls: g.classList.contains(g.getAttribute("data-role")), fill: getComputedStyle(shape).fill, ink: getComputedStyle(text).fill, font: getComputedStyle(text).fontFamily, stroke: getComputedStyle(text).stroke };
  }));
  expect(nodes.length).toBe(9);
  for (const n of nodes) {
    expect(n.role, n.id).toBe(ROLES[n.id]);
    expect(n.cls).toBe(true);
    expect(n.font).toMatch(/^"?Source Sans 3"?,/);
    expect(n.stroke).toBe("none");
    // every role at the 4.5:1 text floor; parent and spouse through the interim HFY override (45-person.css: archive-600 /
    // columbia-700, the HFY-R72 amendment for @io-kit/tokens 0.4.1), 4.08 / 4.31:1 on the 0.4.0 fills
    expect(contrast(n.fill, n.ink), `${n.role} ${n.id} label ${n.ink} on ${n.fill}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(nodes.find((n) => n.role === "focus").fill).toBe("rgb(88, 182, 231)");
  expect(nodes.find((n) => n.role === "sibling").fill).toBe("rgb(255, 193, 7)");

  const frame = page.locator("#person-family-visualization");
  const box = await frame.evaluate((el) => ({ h: el.getBoundingClientRect().height, bg: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderTopLeftRadius, pad: getComputedStyle(el).paddingTop }));
  expect(box).toMatchObject({ bg: "rgb(13, 12, 10)", radius: "8px", pad: "0px" });
  expect(Math.round(box.h)).toBe(560);
  const buttons = frame.locator(".tree-toolbar button");
  await expect(buttons).toHaveCount(4);
  for (const b of await buttons.all()) {
    const bb = await b.boundingBox();
    expect(bb.width).toBeGreaterThanOrEqual(44);
    expect(bb.height).toBeGreaterThanOrEqual(44);
    expect(await b.getAttribute("aria-label")).toBeTruthy();
  }
  const width = () => page.locator(".family-tree-embed svg").evaluate((el) => el.getBoundingClientRect().width);
  const fit = frame.getByRole("button", { name: "fit the tree to the frame" });
  // first view at 1024: the 572px drawing is wider than the frame and fitting keeps its labels >= 16px, so it opens in "fit"
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  const viewport = await page.locator(".family-tree-embed").evaluate((el) => el.clientWidth);
  expect(Math.round(await width())).toBe(viewport);
  await fit.click(); // natural size
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  const natural = await width();
  expect(Math.round(natural)).toBe(572); // 429pt
  await frame.getByRole("button", { name: "zoom in" }).click();
  expect(await width()).toBeGreaterThan(natural + 100);
  await fit.click();
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  expect(Math.round(await width())).toBe(viewport);

  const legend = page.locator("#person-family-legend li");
  await expect(legend).toHaveCount(7);
  await expect(legend).toHaveText(["this person", "parents", "grandparents", "siblings", "spouse", "children", "grandchildren"]);
  const sw = await page.locator("#person-family-legend i").evaluateAll((els) => els.map((i) => ({ w: i.getBoundingClientRect().width, bg: getComputedStyle(i).backgroundColor })));
  expect(sw.map((s) => s.w)).toEqual(Array(7).fill(20));
  expect(sw[0].bg).toBe(nodes.find((n) => n.role === "focus").fill);
  expect(await page.locator("#person-family-legend").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
});

test("family tree at 375: a 320px frame", async ({ page }) => {
  await openPerson(page);
  await expect(page.locator(".family-tree-embed g.node.focus")).toHaveCount(1);
  expect(Math.round(await page.locator("#person-family-visualization").evaluate((el) => el.getBoundingClientRect().height))).toBe(320);
});

test("lightbox under the shell (1024): close and next are on top, the counter advances, 44px chrome", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await openPerson(page, { shell: true });
  await page.waitForSelector(".io-shell");
  await page.locator(".media-lightbox-trigger").first().click();
  const modal = page.locator("#mediaLightbox");
  await expect(modal).toHaveClass(/show/);
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
  expect(await modal.evaluate((el) => el.parentElement === document.body)).toBe(true);
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("1 of 4");
  const hit = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onTop: !!top && (top === el || el.contains(top)), w: r.width, h: r.height };
  }, sel);
  for (const sel of ["#mediaLightbox .lightbox-close", "#mediaLightbox .lightbox-next", "#mediaLightboxDownload"]) {
    const h = await hit(sel);
    expect(h.onTop, `${sel} is not covered (backdrop)`).toBe(true);
    expect(h.w).toBeGreaterThanOrEqual(44);
    expect(h.h).toBeGreaterThanOrEqual(44);
  }
  // top row: counter, download and close share one row
  const row = await page.evaluate(() => ["#mediaLightboxCounter", "#mediaLightboxDownload", "#mediaLightbox .lightbox-close"].map((s) => document.querySelector(s).closest(".modal-header") !== null));
  expect(row).toEqual([true, true, true]);
  await expect(page.locator("#mediaLightboxDownload")).toHaveText("download");
  const counter = await page.locator("#mediaLightboxCounter").evaluate((el) => ({ size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }));
  expect(counter).toEqual({ size: "16px", color: "rgb(205, 191, 166)" });
  await page.locator("#mediaLightbox .lightbox-next").click();
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 4");
  await expect(page.locator("#mediaLightboxCaption")).toHaveText("Family, 1901");
  await expect(page.locator("#mediaLightboxMeta")).toBeHidden();
  const img = await page.locator("#mediaLightboxImage").evaluate((el) => ({ radius: getComputedStyle(el).borderTopLeftRadius, h: el.getBoundingClientRect().height }));
  expect(img.radius).toBe("8px");
  expect(img.h).toBeLessThanOrEqual(900 * 0.8 + 1);
  const backdrop = await page.locator(".modal-backdrop").evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity }));
  expect(backdrop).toEqual({ bg: "rgba(13, 12, 10, 0.82)", opacity: "1" });
  await page.locator("#mediaLightbox .lightbox-close").click();
  await expect(modal).toBeHidden();
});

test("lightbox at 375: no side arrows, swipe left steps, swipe down closes", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await openPerson(page, { shell: true });
  await page.locator(".media-lightbox-trigger").first().click();
  await expect(page.locator("#mediaLightbox")).toHaveClass(/show/);
  await expect(page.locator("#mediaLightbox .lightbox-next")).toBeHidden();
  const close = await page.evaluate(() => {
    const el = document.querySelector("#mediaLightbox .lightbox-close");
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === top || el.contains(top);
  });
  expect(close).toBe(true);
  const swipe = (from, to) => page.evaluate(([a, b]) => {
    const el = document.querySelector("#mediaLightbox .modal-body");
    const t = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [t(...a)], changedTouches: [t(...a)], bubbles: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(...b)], bubbles: true }));
  }, [from, to]);
  await swipe([300, 400], [150, 410]);
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 4");
  await swipe([200, 300], [205, 330]); // under the 80px threshold: nothing
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 4");
  await swipe([200, 300], [205, 420]);
  await expect(page.locator("#mediaLightbox")).toBeHidden();
  await ctx.close();
});

test("error: one banner line in the voice, no technical detail", async ({ page }) => {
  await stub(page, { status: 404 });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  const err = page.locator("#person-error");
  await expect(err).toHaveText("that didn't work. try again, or text J.");
  await expect(err).toHaveClass(/alert-danger/);
  expect(await err.evaluate((el) => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }))).toEqual({ color: "rgb(255, 138, 128)", bg: "rgb(33, 30, 27)" });
  await expect(page.locator("#person-loading")).toBeHidden();
});
