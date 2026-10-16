// HFY design-system pass (legacy area): the person page (11ty/js/person-page.js + the 45-person partial) against the DS
// PersonRecord, FamilyTree and Lightbox specs. Synthetic data only: fixtures/person-legacy.json and fixtures/tree-synthetic.svg
// (Graphviz output with the ETL's attribute shape); /auth, /api, the flags file and media are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-page.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { chatHub } from "./fixtures/chat-hub.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const TREE = readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8");
const URL_PATH = "/person/?id=I9001";
const ROLES = { I9010: "grandparent", I9011: "grandparent", I9012: "parent", I9013: "parent", I9001: "focus", I9014: "sibling", I9002: "spouse", I9015: "child", I9016: "grandchild" };
const photo = (name) => {
  const tall = /2$/.test(name);
  const [w, h] = tall ? [600, 900] : [800, 600];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`;
};

async function stub(page, { shell = true, personV2 = false, familyViz = false, chat = false, hold = null, status = 200, body = PERSON } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: shell, personV2, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, familyViz, chatV1: chat } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/**", (r) => r.fallback());
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", async (r) => {
    if (hold) await hold;
    return status === 200 ? r.fulfill({ json: body }) : r.fulfill({ status, json: { error: "x" } });
  });
  await page.route("**/person/I9003.json", (r) => r.fulfill({ json: { ...PERSON, displayName: "Merged Target (synthetic)" } }));
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

test("personV2: the comments host follows the four sections, and #hfy-person-social stays the last child", async ({ page }) => {
  await openPerson(page, { personV2: true });
  await expect(page.locator("#hfy-person-comments")).toBeAttached();
  const ids = await page.evaluate(() => [...document.getElementById("person-content").children].map((el) => el.id));
  expect(ids.slice(-2)).toEqual(["hfy-person-comments", "hfy-person-social"]);
  await expect(page.locator("#person-stories-section .notes-panel h2")).toHaveText("stories");
});

// Mount points (HFY-TSK-137): the only person-page extension surface. With no island loaded the page is as before.
test("mount points: hero and heading slots in order, tree-link after the tree, social last and hidden; all empty and invisible", async ({ page }) => {
  await openPerson(page);
  const slots = (sel) => page.locator(sel).evaluate((el) => [...el.children].map((c) => c.getAttribute("data-slot")));
  expect(await slots('[data-slot="hero-actions"]')).toEqual(["edit", "follow", "presence"]);
  expect(await slots('[data-slot="heading-chips"]')).toEqual(["contributions", "links"]);
  expect((await page.locator("#person-hero .person-heading > *").evaluateAll((els) => els.map((e) => e.getAttribute("data-slot") || e.tagName))).slice(-2)).toEqual(["heading-chips", "hero-actions"]);
  // tree-link: one host, directly after the tree container, inside the family section
  expect(await page.locator('[data-slot="tree-link"]').count()).toBe(1);
  expect(await page.locator('[data-slot="tree-link"]').evaluate((el) => el.previousElementSibling.id + "|" + el.closest("section").id)).toBe("person-family-visualization|person-family-section");
  // social: last child of #person-content, hidden until filled
  const social = page.locator("#hfy-person-social");
  expect(await page.evaluate(() => document.getElementById("person-content").lastElementChild.id)).toBe("hfy-person-social");
  await expect(social).toBeHidden();
  expect(await social.evaluate((el) => el.hidden && el.childElementCount === 0)).toBe(true);
  // every host is empty and takes no space (the default page is unchanged)
  const boxes = await page.evaluate(() => [...document.querySelectorAll('[data-slot], .person-chips, .person-actions')].filter((el) => !el.closest(".hfy-bar")).map((el) => el.getBoundingClientRect().height + "|" + el.textContent + "|" + getComputedStyle(el).display));
  for (const b of boxes) expect(b.startsWith("0||")).toBe(true);
  // an island that fills a slot makes it visible; the next render rebuilds the hero slots and the event lets it refill
  await page.evaluate(() => { document.querySelector('[data-slot="follow"]').textContent = "x"; });
  await expect(page.locator('[data-slot="hero-actions"]')).toBeVisible();
  // the social host survives and stays last when filled
  await page.evaluate(() => { const s = document.getElementById("hfy-person-social"); s.textContent = "y"; s.hidden = false; });
  await expect(social).toBeVisible();
});

test("events: hfy:person-rendered carries the person id and sections; hfy:lightbox-media the media and image box", async ({ page }) => {
  await page.addInitScript(() => {
    window.__ev = [];
    document.addEventListener("hfy:person-rendered", (e) => window.__ev.push({ t: "r", id: e.detail.personId, name: e.detail.person.displayName, sections: e.detail.sections, hosts: !!document.querySelector('[data-slot="follow"]') && !!document.getElementById("hfy-person-social") }));
    document.addEventListener("hfy:lightbox-media", (e) => window.__ev.push({ t: "l", index: e.detail.index, title: e.detail.media.title, same: e.detail.img === document.getElementById("mediaLightboxImage"), box: e.detail.box === e.detail.img.parentElement }));
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await openPerson(page);
  const rendered = await page.evaluate(() => window.__ev.filter((e) => e.t === "r"));
  expect(rendered).toHaveLength(1);
  expect(rendered[0]).toMatchObject({ id: "I9001", name: "Test Person (synthetic)", hosts: true });
  expect(rendered[0].sections).toEqual(["person-hero-section", "person-events-section", "person-family-section", "person-media-section", "person-stories-section"]);
  await page.locator(".media-lightbox-trigger").first().click();
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
  await page.locator("#mediaLightbox .lightbox-next").click();
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 4");
  await expect.poll(() => page.evaluate(() => window.__ev.filter((e) => e.t === "l").length)).toBe(2);
  const lb = await page.evaluate(() => window.__ev.filter((e) => e.t === "l"));
  expect(lb.map((e) => e.index)).toEqual([0, 1]);
  expect(lb.every((e) => e.same && e.box)).toBe(true);
  expect(lb[1].title).toBe("Family, 1901");
});

test("mergedInto: a stub person JSON redirects to the new id and renders nothing", async ({ page }) => {
  await stub(page, { body: { mergedInto: "I9003" } });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/id=I9003/);
  await expect(page.locator("#person-hero h1")).toHaveText("Merged Target (synthetic)");
  expect(page.url()).not.toContain("I9001");
});

test("mergedInto: the personV2 island follows the stub too (merge-alias-redirect)", async ({ page }) => {
  await stub(page, { personV2: true, body: { mergedInto: "I9003" } });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/id=I9003/);
  expect(new URL(page.url()).searchParams.get("merged")).toBe("1");
  await expect(page.locator("#person-hero h1")).toHaveText("Merged Target (synthetic)");
});

test("mergedInto: a self-pointing stub is not followed (no redirect loop)", async ({ page }) => {
  await stub(page, { body: { mergedInto: "I9001" } });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("name unknown");
  expect(page.url()).toContain("id=I9001");
});

test("mergedInto: other query parameters and the hash survive the redirect", async ({ page }) => {
  await stub(page, { body: { mergedInto: "I9003" } });
  await page.goto("/person/?id=I9001&x=1#h", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/id=I9003/);
  expect(page.url()).toContain("x=1");
  expect(page.url()).toContain("#h");
});

test("mergedInto: a malformed id is not followed", async ({ page }) => {
  await stub(page, { body: { mergedInto: "../x" } });
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("name unknown");
  expect(page.url()).toContain("id=I9001");
});

test("mergedInto: the hop limit stops a redirect cycle and shows the error line", async ({ page }) => {
  await stub(page, { body: { mergedInto: "I9003" } });
  await page.goto("/person/?id=I9001&merged=2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-error")).toBeVisible();
  expect(page.url()).toContain("id=I9001");
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

// HFY-TSK-186: the follow slot (person-page-mount-points) is the island's; recordSubsV1 absent or off requests no follow bundle and leaves it empty.
test("follow slot: empty, and no follow bundle requested, with recordSubsV1 off", async ({ page }) => {
  const requested = [];
  await page.route(/\/js\/islands\/follow\./, (r) => { requested.push(r.request().url()); return r.continue(); });
  await openPerson(page, { personV2: true });
  await page.waitForTimeout(300);
  await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
  expect(requested).toEqual([]);
});

// HFY-TSK-201: the tree-link slot (person-page-mount-points). The link is the island's, so personV2 is on; familyViz decides.
test("tree-link slot: 'see in the family tree' links to /tree/?focus=<id> with familyViz on", async ({ page }) => {
  await openPerson(page, { personV2: true, familyViz: true });
  const link = page.locator('[data-slot="tree-link"] a[data-tree-link]');
  await expect(link).toHaveText("see in the family tree");
  await expect(link).toHaveAttribute("href", "/tree/?focus=I9001");
  await expect(page.locator('[data-slot="tree-link"] a')).toHaveCount(1);
  const box = await link.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
});

test("tree-link slot: empty with familyViz off", async ({ page }) => {
  await openPerson(page, { personV2: true, familyViz: false });
  await expect(page.locator('[data-slot="tree-link"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="tree-link"] a')).toHaveCount(0);
  await expect(page.locator('[data-slot="tree-link"]')).toBeEmpty();
});

// Profile presence (HFY-TSK-143, chatV1): the chat island fills only [data-slot="presence"] in the hero actions and nothing else on the page.
// The hub's people are the eligible members (I9001 and I9002 here; I9003 has no account), the signed-in member is I9002.
test.describe("profile presence (chatV1)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  const eligible = [{ id: "I9001", label: "Sam Example" }, { id: "I9002", label: "Pat Example" }];
  async function withChat(page, { chat = true, id = "I9001" } = {}) {
    const hub = chatHub({ people: eligible });
    await stub(page, { chat });
    await hub.attach(page, { uid: "I9002" });
    await page.goto(`/person/?id=${id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-hero h1")).toBeVisible();
    return hub;
  }

  test("an eligible member's page shows the dot, the state in words and a chat button, in the presence slot; the state follows the hub", async ({ page }) => {
    const hub = await withChat(page);
    const p = page.locator('[data-slot="presence"] [data-hfy-presence="I9001"]');
    await expect(p).toBeVisible();
    await expect(p).toContainText("offline");
    await expect(p.getByRole("img", { name: "offline" })).toBeVisible();
    expect(await page.locator('[data-slot="hero-actions"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-slot")))).toEqual(["edit", "follow", "presence"]);
    const sam = hub.virtual("I9001");
    await expect(p).toContainText("online");
    const btn = p.getByRole("button", { name: "chat" });
    expect((await btn.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    await btn.click();
    await expect(page.getByTestId("io-chat-mole")).toHaveCount(1);
    sam.close();
    hub.dispose();
  });

  test("a member without an account gets no presence, and nor does a page with the flag off", async ({ page }) => {
    const hub = await withChat(page, { id: "I9003" });
    await page.waitForTimeout(800); // the island has had time to connect and receive its people
    await expect(page.locator("[data-hfy-presence]")).toHaveCount(0);
    expect(await page.locator('[data-slot="presence"]').evaluate((el) => el.childElementCount)).toBe(0);
    hub.dispose();
    const off = await withChat(page, { chat: false });
    await page.waitForTimeout(800);
    await expect(page.locator("[data-hfy-presence]")).toHaveCount(0);
    off.dispose();
  });

  test("your own page shows your state and no chat button; a page that is not a person page gets nothing", async ({ page }) => {
    await page.route("**/person/I9002.json", (r) => r.fulfill({ json: PERSON }));
    const hub = await withChat(page, { id: "I9002" });
    const p = page.locator('[data-hfy-presence="I9002"]');
    await expect(p).toBeVisible();
    await expect(p.getByRole("button")).toHaveCount(0);
    await page.goto("/about/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await expect(page.locator("[data-hfy-presence]")).toHaveCount(0);
    hub.dispose();
  });
});
