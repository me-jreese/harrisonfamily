// HFY-TSK-388-0B: the All media page and the media detail page on /all-media/ (island media-browser), flag mediaBrowserV1, at 375 and 1280. Synthetic people and
// photos only; /auth, /api/me, /api/media, /api/media/:id and the flags file are stubbed with the real reply shapes (docs/reference/api.md, Media Browser).
// At most four screenshots in all (list and detail at each width), attached to the report. Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/media-browser.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { DEFAULT_LABELS as L } from "@io-kit/media/browser";
import { axeViolations } from "./axe.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]];
const card = (id, over = {}) => ({ mediaId: id, thumbUrl: `/t/${id}-320.png`, width: 320, height: 240, section: "media", tagCount: 1, needsTags: false, title: `Photo ${id}`, year: 1952, grampsId: id, addedAt: 100, thumb: { s320: `/t/${id}-320.png`, s800: `/t/${id}-800.png`, w: 320, h: 240 }, ...over });
// a tag rect is [left, top, right, bottom] in percent, so Ada's [10, 10, 40, 50] is a box 30% wide and 40% high
const tag = (personId, name, rect, index) => ({ personId, mediaId: "M0002", rect, index, state: "applied", person: { displayName: name } });
const detail = (id, over = {}) => ({
  card: card(id, { title: "Picnic by the lake" }), imageUrl: `/t/${id}-full.png`, description: "Everyone at the lake.", origin: "post", originRef: "POST1", originBy: { displayName: "Ruth Example" },
  tags: [tag("I0001", "Ada Example", [10, 10, 40, 50], 0), tag("I0002", "Bo Example", null, 1)], version: "v1", commentsSubject: `media:${id}`,
  handle: `h${id}`, previousId: "M0001", nextId: "M0003", position: 2, total: 3, ...over,
});

async function open(page, url, { flag = true, session = "I9001", photoTagEdit = false, comments = false, list = null, item = null, details = {}, counts = { media: 3, posts: 1 } } = {}) {
  const state = { lists: [], details: [], islandRequests: [] };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, mediaBrowserV1: flag, photoTagEdit, mediaCommentsV1: comments } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  await page.route(/\/js\/islands\/media-browser\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route(/\/t\/.*\.png/, (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route(/\/api\/media(\?[^/]*)?$/, async (r) => {
    const u = new URL(r.request().url());
    state.lists.push(Object.fromEntries(u.searchParams));
    const body = typeof list === "function" ? list(u.searchParams, state.lists.length) : list ?? { cards: [card("M0001"), card("M0002", { needsTags: true, tagCount: 0 }), card("M0003")], nextCursor: null, counts };
    return r.fulfill(body.__status ? { status: body.__status, json: { error: "x" } } : { json: body });
  });
  await page.route(/\/api\/media\/[^/?]+(\?.*)?$/, async (r) => {
    const u = new URL(r.request().url());
    const id = decodeURIComponent(u.pathname.split("/").pop());
    state.details.push({ id, ...Object.fromEntries(u.searchParams) });
    const body = details[id] ?? item ?? detail(id);
    return r.fulfill(body.__status ? { status: body.__status, json: { error: "x" } } : { json: body });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return state;
}
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const shot = async (page, testInfo, name) => testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag off: the bundle is not requested and the page keeps its note", async ({ page }) => {
      const state = await open(page, "/all-media/", { flag: false });
      await page.waitForTimeout(400);
      expect(state.islandRequests).toEqual([]);
      await expect(page.locator("[data-media-off]")).toBeVisible();
      expect(state.lists).toEqual([]);
    });

    test("signed out: a sign-in line and no request for photos", async ({ page }) => {
      const state = await open(page, "/all-media/", { session: null });
      await expect(page.locator("[data-media-signin]")).toContainText("to see the family photos.");
      await expect(page.locator("[data-media-signin] a")).toHaveAttribute("href", /\/auth\/login\?returnTo=/);
      expect(state.lists).toEqual([]);
    });

    test("the list: counts, cells linking to the detail with the section and filter, the badge, the end line, axe, no sideways scroll", async ({ page }, testInfo) => {
      const state = await open(page, "/all-media/?section=media");
      await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
      expect(state.lists[0]).toMatchObject({ section: "media", filter: "all" });
      await expect(page.getByText(L.end(3))).toBeVisible();
      await expect(page.getByText(L.needsTags).first()).toBeVisible();
      const href = await page.getByRole("link", { name: /Photo M0001/ }).getAttribute("href");
      expect(href).toContain("id=M0001");
      expect(href).toContain("section=media");
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `list-${name}`);
    });

    test("HFY-TSK-405: no section opens on media; ?section=posts opens post images; one h1 on the list; the detail keeps its h1; back returns to media", async ({ page }) => {
      const state = await open(page, "/all-media/");
      await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
      expect(state.lists[0]).toMatchObject({ section: "media" });
      expect(page.url()).toContain("section=media");
      await expect(page.getByRole("button", { name: new RegExp(`^${L.sectionMedia}`, "i") })).toHaveAttribute("aria-pressed", "true");
      const visibleH1 = await page.locator("h1").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; }).map((e) => e.textContent.trim()));
      expect(visibleH1).toEqual(["all media"]);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: "all media" })).toBeVisible();
      await page.getByRole("link", { name: /Photo M0002/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^${L.sectionMedia}`, "i") })).toHaveAttribute("aria-pressed", "true");
      expect(page.url()).toContain("section=media");
    });

    test("HFY-TSK-405: ?section=posts opens on post images and the address is left alone", async ({ page }) => {
      const state = await open(page, "/all-media/?section=posts");
      await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
      expect(state.lists[0]).toMatchObject({ section: "posts" });
      expect(page.url()).toContain("section=posts");
      await expect(page.getByRole("button", { name: new RegExp(`^${L.sectionPosts}`, "i") })).toHaveAttribute("aria-pressed", "true");
    });

    test("more pages load on scroll and the end line follows; a filter chip changes the request and the address", async ({ page }) => {
      const state = await open(page, "/all-media/?section=media", {
        list: (q, n) => (q.get("filter") === "needs_tags" ? { cards: [], nextCursor: null, counts: { media: 0, posts: 0 } }
          : n === 1 ? { cards: [card("M0001"), card("M0002")], nextCursor: "c2", counts: { media: 3, posts: 0 } } : { cards: [card("M0003")], nextCursor: null, counts: { media: 3, posts: 0 } }),
      });
      await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
      await page.getByRole("link", { name: /Photo M0002/ }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("link", { name: /Photo M0003/ })).toBeVisible();
      expect(state.lists.some((q) => q.cursor === "c2")).toBe(true);
      await expect(page.getByText(L.end(3))).toBeVisible();
      await page.getByRole("button", { name: new RegExp(L.filterNeedsTags, "i") }).click();
      await expect(page.getByText(L.emptyNeedsTags)).toBeVisible();
      expect(state.lists.some((q) => q.filter === "needs_tags")).toBe(true);
      expect(page.url()).toContain("filter=needs_tags");
    });

    test("an empty list and a failed list say so, with a retry", async ({ page }) => {
      await open(page, "/all-media/?filter=of_me", { list: { cards: [], nextCursor: null, counts: { media: 0, posts: 0 } } });
      await expect(page.getByText(L.emptyOfMe)).toBeVisible();
    });

    test("a failed first page shows the error line and retry", async ({ page }) => {
      await open(page, "/all-media/", { list: { __status: 503 } });
      await expect(page.getByText(L.error)).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(L.retry, "i") })).toBeVisible();
    });

    test("the detail: title, year, description, origin line, tagged people (every one is linked, P4-R37), comments host, previous and next, axe", async ({ page }, testInfo) => {
      const state = await open(page, "/all-media/?id=M0002&section=media&filter=all");
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      expect(state.details[0]).toMatchObject({ id: "M0002", section: "media", filter: "all" });
      await expect(page.getByText("Everyone at the lake.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Ruth Example" })).toHaveAttribute("href", "/posts/?id=POST1");
      await expect(page.getByRole("link", { name: "Ada Example" })).toHaveAttribute("href", "/person/?id=I0001");
      await expect(page.locator("[data-media-people]").getByRole("link", { name: "Bo Example" })).toHaveAttribute("href", "/person/?id=I0002");
      await expect(page.locator("[data-media-people] a")).toHaveCount(2);
      await expect(page.locator('[data-slot="media-comments"]')).toHaveAttribute("data-subject", "media:M0002");
      await expect(page.getByText(DEFAULT_POSITION)).toBeVisible();
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, testInfo, `detail-${name}`);
    });

    test("previous and next stay in the section and filter and move the address; focus lands on the new heading", async ({ page }) => {
      const state = await open(page, "/all-media/?id=M0002&section=media&filter=needs_tags", { details: { M0003: detail("M0003", { card: card("M0003", { title: "Second picnic" }), previousId: "M0002", nextId: null, position: 3 }) } });
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      await page.getByRole("link", { name: new RegExp(L.next, "i") }).first().click();
      await expect(page.getByRole("heading", { level: 1, name: "Second picnic" })).toBeVisible();
      expect(page.url()).toContain("id=M0003");
      expect(state.details.at(-1)).toMatchObject({ id: "M0003", section: "media", filter: "needs_tags" });
      await expect(page.getByRole("heading", { level: 1, name: "Second picnic" })).toBeFocused();
    });

    test("origin line variants: an upload says 'added by', a gramps import says nothing", async ({ page }) => {
      await open(page, "/all-media/?id=M0002", { item: detail("M0002", { origin: "upload", originRef: "I0005", originBy: { displayName: "Lena Example" } }) });
      await expect(page.getByText(/added by/i)).toBeVisible();
      await expect(page.getByRole("link", { name: "Lena Example" })).toHaveAttribute("href", "/person/?id=I0005");
      await page.unroute(/\/api\/media\/[^/?]+(\?.*)?$/);
      await page.route(/\/api\/media\/[^/?]+(\?.*)?$/, (r) => r.fulfill({ json: detail("M0002", { origin: "gramps", originRef: undefined, originBy: undefined, tags: [] }) }));
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      await expect(page.getByText(/added by|from a post/i)).toHaveCount(0);
      await expect(page.getByText(L.noTags)).toBeVisible();
    });

    test("not found and a failed read", async ({ page }) => {
      await open(page, "/all-media/?id=M0404", { item: { __status: 404 } });
      await expect(page.getByText(L.notAvailable)).toBeVisible();
      await open(page, "/all-media/?id=M0500", { item: { __status: 500 } });
      await expect(page.getByText(L.errorDetail)).toBeVisible();
    });

    test("the kit tag editor: 'tag people' appears for a member with photoTagEdit on and opens the editor (tests/tag-kit.spec.mjs has the flows); absent with the flag off", async ({ page }) => {
      await open(page, "/all-media/?id=M0002", { photoTagEdit: true });
      const toggle = page.getByRole("button", { name: "tag people" });
      await expect(toggle).toBeVisible();
      expect((await toggle.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("section.io-media-tags")).toBeVisible();
      await noSideways(page);
    });

    test("no tag editor with photoTagEdit off", async ({ page }) => {
      await open(page, "/all-media/?id=M0002", { photoTagEdit: false });
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      await expect(page.getByRole("button", { name: "tag people" })).toHaveCount(0);
    });
  });
}

// HFY-TSK-404: geometry, not just presence. The kit bundles tags.css and browser.css with the same class names, and jsdom and the earlier specs never measured a box:
// the list sat absolute over the heading with pointer-events none, the photo was hidden under an opaque overlay, the tag boxes were 6 px bars and "view full size" left the app.
const alphaOf = (c) => (/^rgba\(.*,\s*0\)$/.test(c) || c === "transparent" ? 0 : 1);
for (const [name, viewport] of [["390x844", { width: 390, height: 844 }], ["1280x800", { width: 1280, height: 800 }]]) {
  test.describe(`geometry ${name}`, () => {
    test.use({ viewport, colorScheme: "dark" });

    test("the list: in the flow under the chips, not absolute, a cell is hit-testable, 2 to 3 columns on a phone", async ({ page }) => {
      await open(page, "/all-media/?section=media");
      const link = page.getByRole("link", { name: /Photo M0001/ });
      await expect(link).toBeVisible();
      const m = await page.evaluate(() => {
        const g = document.querySelector("ul.io-media-grid"), chips = document.querySelector(".io-media-chips"), cells = [...g.querySelectorAll(".io-media-cell")];
        const c = cells[0].getBoundingClientRect(), hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
        return { position: getComputedStyle(g).position, pe: getComputedStyle(g).pointerEvents, top: g.getBoundingClientRect().top, chipsBottom: chips.getBoundingClientRect().bottom, hitInCell: !!hit?.closest("a.io-media-cell-link"), hitHref: hit?.closest("a")?.getAttribute("href"), cols: new Set(cells.map((n) => Math.round(n.getBoundingClientRect().left))).size };
      });
      expect(m.position).not.toBe("absolute");
      expect(m.pe).not.toBe("none");
      expect(m.top).toBeGreaterThanOrEqual(m.chipsBottom);
      expect(m.hitInCell).toBe(true);
      expect(m.hitHref).toContain("id=M0001");
      expect(m.cols).toBeGreaterThanOrEqual(2);
      if (viewport.width < 600) expect(m.cols).toBeLessThanOrEqual(3);
    });

    test("the detail: the photo shows in its stage, the tag boxes sit on the right place with real height, the switch is a small control off the middle, one heading each", async ({ page }) => {
      await open(page, "/all-media/?id=M0002&section=media&filter=all", { comments: true });
      await expect(page.getByRole("heading", { level: 1, name: "Picnic by the lake" })).toBeVisible();
      await expect(page.locator(".io-media-box").first()).toBeVisible();
      const m = await page.evaluate(() => {
        const stage = document.querySelector(".io-media-detail-main > .io-media-stage"), img = stage.querySelector(".io-media-stage-img"), s = stage.getBoundingClientRect(), i = img.getBoundingClientRect();
        const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        const sw = stage.querySelector(".io-media-switch")?.getBoundingClientRect();
        const box = stage.querySelector(".io-media-box").getBoundingClientRect();
        const overlays = [...stage.querySelectorAll(".io-media-overlay")].filter((n) => getComputedStyle(n).display !== "contents").map((n) => getComputedStyle(n).backgroundColor);
        return { s: { w: s.width, h: s.height }, img: { l: i.left - s.left, t: i.top - s.top, w: i.width, h: i.height }, hitIsImg: hit === img, hitBg: hit ? getComputedStyle(hit).backgroundColor : "", overlays,
          box: { l: (box.left - s.left) / s.width * 100, t: (box.top - s.top) / s.height * 100, w: box.width / s.width * 100, h: box.height / s.height * 100, hpx: box.height },
          sw: sw && { w: sw.width, h: sw.height, top: sw.top - s.top, bottom: sw.bottom - s.top, left: sw.left - s.left }, headings: [...document.querySelectorAll("h2")].map((h) => h.textContent.trim()) };
      });
      expect(m.img.w).toBeGreaterThan(viewport.width < 600 ? 200 : 400);
      expect(m.img.l).toBeGreaterThanOrEqual(-1);
      expect(m.img.l + m.img.w).toBeLessThanOrEqual(m.s.w + 1);
      expect(Math.abs(m.img.w / m.img.h - 320 / 240)).toBeLessThan(0.05);
      expect(m.hitIsImg || alphaOf(m.hitBg) === 0).toBe(true);
      expect(m.overlays.every((c) => alphaOf(c) === 0)).toBe(true);
      expect(m.box.hpx).toBeGreaterThan(10);
      for (const [got, want] of [[m.box.l, 10], [m.box.t, 10], [m.box.w, 30], [m.box.h, 40]]) expect(Math.abs(got - want)).toBeLessThan(2.5);
      expect(m.sw.h).toBeGreaterThanOrEqual(43.5);
      expect(m.sw.w).toBeLessThan(m.s.w * 0.7);
      expect(m.sw.top).toBeGreaterThan(m.s.h / 2);
      expect(m.headings.filter((h) => h === L.people)).toHaveLength(1);
      expect(m.headings.filter((h) => h === L.comments)).toHaveLength(1);
      await expect(page.getByRole("region", { name: L.people })).toHaveCount(1);
      await expect(page.getByRole("region", { name: L.comments })).toHaveCount(1);
      await noSideways(page);
    });

    test("view full size opens an in-page viewer: a dialog with a 44 px close, Esc and back close it, focus returns, the address never becomes the image", async ({ page }) => {
      await open(page, "/all-media/?id=M0002&section=media&filter=all");
      const url0 = page.url();
      const link = page.getByRole("link", { name: L.viewFullSize });
      await expect(link).toHaveAttribute("href", "/t/M0002-full.png");
      for (const how of ["button", "escape", "back"]) {
        await link.click();
        const dlg = page.getByRole("dialog");
        await expect(dlg).toBeVisible();
        await expect(dlg).toHaveAttribute("aria-modal", "true");
        const close = dlg.getByRole("button", { name: "close" });
        await expect(close).toBeVisible();
        await expect(close).toBeFocused();
        const b = await close.boundingBox();
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
        const img = await dlg.locator("img").evaluate((n) => ({ src: n.getAttribute("src"), fit: getComputedStyle(n).objectFit, w: n.getBoundingClientRect().width }));
        expect(img.src).toBe("/t/M0002-full.png");
        expect(img.fit).toBe("contain");
        expect(img.w).toBeLessThanOrEqual(viewport.width);
        expect(page.url()).toBe(url0);
        if (how === "button") await close.click(); else if (how === "escape") await page.keyboard.press("Escape"); else await page.goBack();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(link).toBeFocused();
        expect(page.url()).toBe(url0);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
      }
    });
  });
}

const DEFAULT_POSITION = L.position(2, 3);
