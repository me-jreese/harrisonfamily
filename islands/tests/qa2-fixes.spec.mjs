// HFY design-system pass, QA round 2 fixes (HFY-TSK-084): each test pins one fixed defect at the widths QA measured it.
// Synthetic data only (fixtures/islands-look.json); /auth/session, /api/* and the data JSON are stubbed; everything off-host is aborted.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/qa2-fixes.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const FX = JSON.parse(readFileSync(new URL("./fixtures/islands-look.json", import.meta.url), "utf8"));
const FLAGS = "hfy_flags=shellV2,postsV2,personV2,searchV2,notifyV2";
const WIDTHS = [375, 688, 1024];
const at = (min) => new Date(Date.now() - min * 60e3).toISOString();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// A real w x h PNG (grey), so a 4:5 photo can be told from a square one.
function pngOf(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function stub(page, { signedIn = true, ownComment = false, manifestDelay = 0 } = {}) {
  const s = { uploads: 0, deletes: [] };
  const posts = FX.posts.map(({ agoMin, ...p }) => ({ ...p, created_at: at(agoMin), updated_at: at(agoMin) }));
  const comments = FX.comments.map(({ agoMin, ...c }) => ({ ...c, threadId: "x", created_at: at(agoMin) }));
  if (ownComment) comments.push({ id: "01HZZZZZZZZZZZZZZZZZZZZZ09", threadId: "x", author: FX.me, body: "Mine to delete.", created_at: at(5), can: { edit: true, delete: true, react: true } });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: FX.me.id, grampsId: FX.me.id, label: FX.me.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route(/\/person\/I\d+\.json/, (r) => r.fulfill({ json: FX.person }));
  await page.route("**/person/index.json", async (r) => { if (manifestDelay) await new Promise((x) => setTimeout(x, manifestDelay)); await r.fulfill({ json: FX.manifest }); });
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: FX.manifest.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  const TALL_PNG = pngOf(400, 500);
  await page.route("**/media/**", (r) => r.fulfill({ body: TALL_PNG, contentType: "image/png" }));
  await page.route("**/api/uploads", (r) => { s.uploads += 1; const b = r.request().postDataJSON(); return r.fulfill({ status: 201, json: { uploadUrl: `http://127.0.0.1/put/photo`, publicUrl: `/media/p.png?u=${s.uploads}`, headers: { "Content-Type": b.contentType } } }); });
  await page.route("http://127.0.0.1/put/**", (r) => r.fulfill({ status: 200, body: "" }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "DELETE") { s.deletes.push(u.pathname); return r.fulfill({ status: 204, body: "" }); }
    const id = u.pathname.split("/")[3];
    if (id) return r.fulfill({ json: posts.find((p) => p.id === id) ?? posts[0] });
    const subject = u.searchParams.get("subject");
    return r.fulfill({ json: { items: posts.filter((p) => !subject || p.subject === subject), cursor: null } });
  });
  await page.route("**/api/comments**", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { thread: { id: "x", topic: "comments", comments, reactions: {} } } }) : r.fulfill({ status: 204, body: "" })));
  await page.route("**/api/notifications/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    if (path.endsWith("/preferences")) return r.fulfill({ json: FX.preferences });
    return r.fulfill({ json: {} });
  });
  return s;
}

// ------------------------------------------------------------------------------------------- major 1: nothing escapes the frame
for (const width of [375, 1024]) {
  test(`own page at ${width}: the composer's visually-hidden parts stay inside the scroller, so scrolling to the comments never moves the shell frame`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 768 });
    await page.goto(`/person/?id=${FX.me.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
    const mine = page.locator("#hfy-my-posts");
    await expect(mine.getByRole("textbox", { name: /post a photo or a line/ })).toBeVisible();
    await expect(page.locator("#hfy-person-comments")).toBeAttached();
    await page.waitForTimeout(400); // islands settle (comments, life, family)
    const m = await page.evaluate(() => {
      const shell = document.querySelector(".io-shell");
      const scroller = document.querySelector("[data-io-scroller]");
      // every position:absolute box in the scroller must resolve its containing block inside the scroller (QA: it was .io-shell)
      // (rendered HTML boxes only: display:none boxes and SVG parts have no offsetParent)
      const escaping = [...scroller.querySelectorAll("*")].filter((el) => el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).position === "absolute" && !scroller.contains(el.offsetParent)).map((el) => `${el.tagName}.${el.className}`);
      const frame = { scrollH: shell.scrollHeight, clientH: shell.clientHeight };
      // start-aligned scrolls to the lower page: the comments and the my-posts heading (the QA repro) must move the scroller, not the frame
      document.querySelector("#hfy-person-comments").scrollIntoView({ block: "start" });
      const afterComments = shell.scrollTop;
      document.querySelector("#hfy-my-posts h2").scrollIntoView({ block: "start" });
      return { escaping, ...frame, afterComments, afterMine: shell.scrollTop, shellLeft: shell.scrollLeft, barTop: Math.round(document.querySelector(".hfy-bar").getBoundingClientRect().top), scroller: scroller.scrollTop };
    });
    expect(m.escaping, "absolute boxes whose containing block is the frame").toEqual([]);
    expect(m.scrollH, "the frame has nothing to scroll").toBeLessThanOrEqual(m.clientH);
    expect(m.afterComments).toBe(0);
    expect(m.afterMine).toBe(0);
    expect(m.shellLeft).toBe(0);
    expect(m.barTop, "the top bar stays on screen").toBe(0);
    expect(m.scroller, "the scroller took the scroll").toBeGreaterThan(0);
  });
}

test("own page at 375: the hidden 'add a photo' label is contained too (under 688 it is the button's name)", async ({ page }) => {
  await stub(page);
  await page.goto(`/person/?id=${FX.me.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const photo = page.locator("#hfy-my-posts .hfy-posts__photo");
  await expect(photo).toBeVisible();
  const r = await photo.evaluate((el) => {
    const label = el.querySelector(".hfy-posts__photo-label");
    return { photoPos: getComputedStyle(el).position, labelPos: label && getComputedStyle(label).position, op: label && label.offsetParent === el };
  });
  expect(r.photoPos).toBe("relative");
  expect(r.labelPos).toBe("absolute");
  expect(r.op, "the label's containing block is its own button").toBe(true);
});

// ------------------------------------------------------------------------------------------------------------ major 2: focus ring
for (const width of WIDTHS) {
  test(`search at ${width}: every control's focus ring fits inside the island's clip box (nothing cut at the edges)`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/search/?q=a&${FLAGS}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#hfy-search-v2 .hfy-search__row").first()).toBeVisible();
    const clip = page.locator("#hfy-search-v2 .hfy-search");
    const seen = [];
    await page.keyboard.press("Tab"); // into the page (skip link / first stop); then walk the island
    for (let i = 0; i < 40; i += 1) {
      const r = await page.evaluate(() => {
        const el = document.activeElement;
        const root = document.querySelector("#hfy-search-v2 .hfy-search");
        if (!el || !root.contains(el)) return { outside: true };
        const c = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        const room = c.outlineStyle === "none" ? 0 : parseFloat(c.outlineWidth) + Math.max(0, parseFloat(c.outlineOffset));
        // the overflow-x:clip edge is the island's padding box
        const box = root.getBoundingClientRect();
        const cs = getComputedStyle(root);
        return { name: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.tagName).trim().slice(0, 24), room, left: b.left - room - box.left, right: box.right - (b.right + room), clipX: cs.overflowX, outline: c.outlineStyle };
      });
      if (!r.outside) seen.push(r);
      await page.keyboard.press("Tab");
    }
    expect(seen.length, "walked the island's controls").toBeGreaterThanOrEqual(4);
    expect(seen.every((x) => x.clipX === "clip")).toBe(true); // still clipped (long names must not widen the page)
    for (const x of seen) {
      expect(x.outline, `${x.name} shows a ring`).toBe("solid");
      expect(x.left, `${x.name}: left of the ring inside the clip box`).toBeGreaterThanOrEqual(-0.5);
      expect(x.right, `${x.name}: right of the ring inside the clip box`).toBeGreaterThanOrEqual(-0.5);
    }
    // the island's content stays on the page gutter, and nothing scrolls sideways
    const g = await page.evaluate(() => {
      const main = document.querySelector("main:not([data-io-scroller])");
      const row = document.querySelector("#hfy-search-v2 .hfy-search__row").getBoundingClientRect();
      const m = main.getBoundingClientRect();
      const cs = getComputedStyle(main);
      return { contentLeft: row.left - (m.left + parseFloat(cs.paddingLeft)), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
    });
    expect(Math.abs(g.contentLeft), "rows still start at the page gutter (plus their own 4px inset)").toBeLessThanOrEqual(8);
    expect(g.scrollW).toBeLessThanOrEqual(g.innerW);
    await expect(clip).toBeVisible();
  });
}

// ------------------------------------------------------------------------------------------ major 3: suggestion footer palette
test("search at 688: the suggestion dropdown's footer and the form text are text.dim from the palette, not Cloudscape's cool grey", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 688, height: 900 });
  await page.goto(`/search/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const input = page.locator("#hfy-search-v2 .io-search__row1 input").first();
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.type("mar");
  const footer = page.locator('[class*="awsui_options-list_"], [class*="awsui_dropdown_"]').getByText(/end of suggestions/i).first();
  await expect(footer).toBeVisible();
  const dim = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--io-search-text-dim)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const color = await footer.evaluate((e) => getComputedStyle(e).color);
  expect(color, "the footer is text.dim").toBe(dim);
  expect(color).not.toBe("rgb(164, 164, 173)"); // Cloudscape's #a4a4ad
});

// ======================================================================================================== minors (safe, local)
const TOKEN = { md: "8px", lg: "16px", surfaceRaised: "rgb(33, 30, 27)", borderStrong: "rgb(133, 118, 102)", gold: "rgb(255, 193, 7)" };

// ------------------------------------------------------------------------------------------------------------ home and about
for (const width of WIDTHS) {
  test(`home at ${width}: hero is a radius.md card, the photo box hugs the portrait, the lede is a paragraph, the CTA row turns at 688`, async ({ page }) => {
    await stub(page, { signedIn: false });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?${FLAGS}`, { waitUntil: "domcontentloaded" });
    const img = page.locator(".home-hero__image");
    await expect(img).toBeVisible();
    await page.waitForFunction(() => document.querySelector(".home-hero__image")?.complete);
    const h = await page.evaluate(() => {
      const hero = document.querySelector(".home-hero");
      const im = hero.querySelector(".home-hero__image");
      const r = im.getBoundingClientRect();
      const col = im.closest("figure").getBoundingClientRect();
      const lede = hero.querySelector(".home-hero__copy .home-hero__lede");
      return {
        radius: getComputedStyle(hero).borderTopLeftRadius,
        imgRadius: getComputedStyle(im).borderTopLeftRadius,
        boxRatio: r.width / r.height,
        naturalRatio: im.naturalWidth / im.naturalHeight,
        inColumn: r.width <= col.width + 0.5,
        centred: Math.abs((r.left - col.left) - (col.right - r.right)) <= 1,
        attrs: [im.getAttribute("width"), im.getAttribute("height")],
        ledeTag: lede && lede.tagName,
        h3s: hero.querySelectorAll("h3").length,
        dir: getComputedStyle(hero.querySelector(".flex-md-row")).flexDirection,
      };
    });
    expect(h.radius).toBe(TOKEN.md);
    expect(h.imgRadius).toBe(TOKEN.lg);
    expect(h.boxRatio / h.naturalRatio, "the img box is the photograph (no letterbox)").toBeGreaterThan(0.98);
    expect(h.boxRatio / h.naturalRatio).toBeLessThan(1.02);
    expect(h.inColumn && h.centred).toBe(true);
    expect(h.attrs).toEqual(["3038", "3931"]); // reserved before the file arrives
    expect(h.ledeTag).toBe("P");
    expect(h.h3s, "no heading level skipped under the h1").toBe(0);
    expect(h.dir).toBe(width >= 688 ? "row" : "column");
  });
}

test("home at 375: the outline 'sign in' button shows a visible hover change on the raised hero", async ({ page }) => {
  await stub(page, { signedIn: false });
  await page.goto(`/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const btn = page.locator(".home-hero .btn-outline-light");
  await expect(btn).toBeVisible();
  const look = () => btn.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, border: c.borderTopColor, card: getComputedStyle(e.closest(".home-hero")).backgroundColor }; });
  const before = await look();
  await btn.hover();
  // visible against the card it sits on: the fill leaves the card's own colour (it was the same raised colour) and the edge changes
  await expect.poll(async () => { const a = await look(); return a.border !== before.border && a.bg !== a.card; }).toBe(true);
});

for (const [width, size, lh] of [[375, "36px", "39.6px"], [688, "48px", "52.8px"], [1024, "48px", "52.8px"]]) {
  test(`about at ${width}: the page title is on the DS display scale (${size}, tight leading)`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
    const t = await page.locator(".about-hero h1").evaluate((e) => { const c = getComputedStyle(e); return { size: c.fontSize, lh: c.lineHeight }; });
    expect(t).toEqual({ size, lh });
  });
}

test("pre-mount (375): the page sits where it will sit after the shell mounts (no jump)", async ({ page }) => {
  await stub(page, { signedIn: false });
  await page.addInitScript(() => { try { localStorage.setItem("hfy:shell-hint", "1"); } catch { /* storage blocked */ } });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/js/islands/shell.js*", async (r) => { await held; await r.continue(); });
  await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(true);
  const top = () => page.evaluate(() => { const r = document.querySelector(".home-hero").getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) }; });
  const pre = await top();
  expect(pre.top, "below the 56px top strip, not under it").toBeGreaterThanOrEqual(56);
  release();
  await expect(page.locator(".io-shell")).toBeVisible();
  await expect.poll(async () => (await top()).top).toBeLessThanOrEqual(pre.top + 2);
  const post = await top();
  expect(Math.abs(post.top - pre.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(post.left - pre.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(post.width - pre.width)).toBeLessThanOrEqual(1);
});

// -------------------------------------------------------------------------------------------------------------------- person
test("someone else's page: stories are a 68ch reading column, their headings sit under the 24px section heading, sections are one gap apart", async ({ page }) => {
  await stub(page);
  for (const width of [375, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/person/?id=I0001&${FLAGS}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".hfy-note").first()).toBeVisible();
    await expect(page.locator("[data-hfy-comments]")).toBeVisible();
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const note = document.querySelector(".hfy-note");
      const h = note.querySelector("h1, h2, h3");
      const sectionH2 = document.querySelector("#person-stories-section h2, .notes-panel > h2");
      const lastCard = [...document.querySelectorAll(".notes-panel .card")].pop();
      const comments = document.querySelector("[data-hfy-comments]");
      const gap = parseFloat(getComputedStyle(document.querySelector("#person-content")).rowGap);
      return {
        noteW: note.getBoundingClientRect().width,
        commentsW: comments.getBoundingClientRect().width,
        headingSize: h && parseFloat(getComputedStyle(h).fontSize),
        sectionSize: parseFloat(getComputedStyle(sectionH2).fontSize),
        cardMargin: getComputedStyle(lastCard).marginBottom,
        commentsMargin: getComputedStyle(comments).marginTop,
        between: comments.getBoundingClientRect().top - document.querySelector(".notes-panel").closest("section").getBoundingClientRect().bottom,
        gap,
      };
    });
    expect(m.noteW, `${width}: the note is no wider than the comments column (68ch)`).toBeLessThanOrEqual(m.commentsW + 1);
    expect(m.headingSize).toBe(24);
    expect(m.headingSize).toBeLessThanOrEqual(m.sectionSize);
    expect(m.cardMargin).toBe("0px");
    expect(m.commentsMargin).toBe("0px");
    expect(Math.abs(m.between - m.gap), `${width}: stories -> comments spacing is the section gap`).toBeLessThanOrEqual(1);
  }
});

test("an own comment's delete button is the DS danger colour; edit stays a link", async ({ page }) => {
  await stub(page, { ownComment: true });
  await page.goto(`/person/?id=I0001&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const del = page.locator("[data-hfy-comments] .io-comments-actions button", { hasText: /^delete$/ }).first();
  await expect(del).toBeVisible();
  const danger = await page.evaluate(() => { const p = document.createElement("i"); p.style.color = "var(--io-comments-danger)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  await expect.poll(() => del.evaluate((e) => getComputedStyle(e).color)).toBe(danger);
  const edit = page.locator("[data-hfy-comments] .io-comments-actions button", { hasText: /^edit$/ }).first();
  expect(await edit.evaluate((e) => getComputedStyle(e).color)).not.toBe(danger);
});

test("lightbox: a 56px top row with the 44px buttons centred, and the caption bar pins to the bottom under 688", async ({ page }) => {
  await stub(page);
  for (const [width, captionTop] of [[375, "auto"], [688, "0px"]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/person/?id=I0001&${FLAGS}`, { waitUntil: "domcontentloaded" });
    const m = await page.evaluate(() => {
      const head = getComputedStyle(document.querySelector("#mediaLightbox .modal-header"));
      return { top: head.paddingTop, bottom: head.paddingBottom, minH: head.minHeight, caption: getComputedStyle(document.querySelector("#mediaLightbox .modal-body > .mt-3")).marginTop };
    });
    expect(m).toEqual({ top: "6px", bottom: "6px", minH: "56px", caption: captionTop });
  }
});

// ------------------------------------------------------------------------------------------------------------------- posts
test("own page: an attached photo's thumbnail is the 44px square (one control height per row)", async ({ page }) => {
  const s = await stub(page);
  await page.goto(`/person/?id=${FX.me.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const mine = page.locator("#hfy-my-posts");
  await mine.locator('input[type="file"]').setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: pngOf(400, 500) }); // a 4:5 photo
  await expect.poll(() => s.uploads).toBe(1);
  const thumb = mine.locator("img.hfy-posts__thumb");
  await expect(thumb).toHaveCount(1);
  const b = await thumb.boundingBox();
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([44, 44]);
});

test("single post view: the feed row (avatar, 32px meta), an h1 for assistive tech, and the author can delete from here", async ({ page }) => {
  const s = await stub(page);
  const mine = FX.posts.find((p) => p.can?.delete) ?? FX.posts[0];
  await page.goto(`/posts/?id=${mine.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const one = page.locator("[data-hfy-post]");
  await expect(one.locator(".hfy-posts__avatar")).toBeVisible();
  const h1 = page.getByRole("heading", { level: 1, name: "post" });
  await expect(h1).toHaveCount(1);
  const hb = await h1.evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  expect(hb, "visually hidden").toEqual([1, 1]);
  const meta = await one.locator(".iok-content-meta").evaluate((e) => e.getBoundingClientRect().height);
  expect(Math.round(meta)).toBe(32);
  await one.locator(".hfy-posts__footer").getByRole("button", { name: "delete" }).click();
  const ask = one.getByRole("group", { name: "delete this post?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "delete" }).click();
  await expect(page).toHaveURL(/\/posts\/(\?.*)?$/);
  expect(s.deletes).toEqual([`/api/posts/${mine.id}`]);
});

// ------------------------------------------------------------------------------------------------------------------- search
test("search: results read 'b. 1975 · living' (living after the lifespan), and the zero state is a raised card", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 688, height: 900 });
  await page.goto(`/search/?q=Tomas&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const living = FX.manifest.people.find((p) => p.isLiving);
  const row = page.locator("#hfy-search-v2 .hfy-search__row", { hasText: living.displayName });
  await expect(row.locator(".hfy-search__meta")).toHaveText(`${living.lifespanSummary} · living`);
  await page.goto(`/search/?q=zzzznomatch&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const zero = page.locator("#hfy-search-v2 .io-search-zero");
  await expect(zero).toBeVisible();
  const z = await zero.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, border: `${c.borderTopWidth} ${c.borderTopStyle}`, radius: c.borderTopLeftRadius, pad: c.paddingTop }; });
  expect(z).toEqual({ bg: TOKEN.surfaceRaised, border: "1px solid", radius: TOKEN.md, pad: "32px" });
});

for (const [width, cols] of [[375, 1], [1024, 2]]) {
  test(`search at ${width}: the loading skeleton has the settled layout's ${cols} column${cols > 1 ? "s" : ""}`, async ({ page }) => {
    await stub(page, { manifestDelay: 1500 });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/search/?q=a&${FLAGS}`, { waitUntil: "domcontentloaded" });
    const sk = page.locator(".hfy-search__skeleton");
    await expect(sk).toBeVisible();
    const n = await sk.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
    expect(n).toBe(cols);
  });
}

test("search at 375: the filter sheet's footer takes the panel colour, its editor has the house placeholder, kit labels read lowercase", async ({ page }) => {
  await stub(page);
  await page.goto(`/search/?q=Quillfeather&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const rowBtn = page.locator("#hfy-search-v2 .io-search__rowbtn").first();
  await expect(rowBtn).toBeVisible();
  expect(await rowBtn.evaluate((e) => getComputedStyle(e).textTransform)).toBe("lowercase");
  await rowBtn.click();
  const sheet = page.locator(".io-sheet.io-search-scope");
  await expect(sheet).toBeVisible();
  const m = await sheet.evaluate((s) => {
    const q = (sel) => s.querySelector(sel);
    const ph = [...s.querySelectorAll("input")].map((i) => i.placeholder).filter(Boolean);
    return {
      footerBg: getComputedStyle(q(".io-search__sheetfooter")).backgroundColor,
      panelBg: getComputedStyle(q(".io-sheet__panel")).backgroundColor,
      placeholders: ph,
      title: getComputedStyle(q(".io-sheet__title")).fontSize,
      titleCase: getComputedStyle(q(".io-sheet__title")).textTransform,
      doneCase: getComputedStyle(q(".io-search__sheetdone")).textTransform,
    };
  });
  expect(m.footerBg).toBe(m.panelBg);
  expect(m.placeholders).toEqual(["a first name, a town, or a year"]);
  expect(m.title).toBe("24px");
  expect(m.titleCase).toBe("lowercase");
  expect(m.doneCase).toBe("lowercase");
});

// -------------------------------------------------------------------------------------------------------------------- shell
for (const [width, gutter] of [[375, 16], [688, 24], [1024, 64]]) {
  test(`shell at ${width}: the top bar's wordmark sits on the page gutter (${gutter}px)`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".hfy-bar__brand")).toBeVisible();
    const x = await page.evaluate(() => ({ brand: Math.round(document.querySelector(".hfy-bar__brand").getBoundingClientRect().left), card: Math.round(document.querySelector(".home-hero").getBoundingClientRect().left) }));
    expect(x.brand).toBe(gutter);
    expect(x.card, "the wordmark lines up with the page's cards").toBe(gutter);
  });
}

test("shell at 375: the bottom bar's focus ring is drawn inside its cell (no edge cut off)", async ({ page }) => {
  await stub(page);
  await page.goto(`/about/?${FLAGS},navMe`, { waitUntil: "domcontentloaded" }); // the shipped four-cell bar since the navMe flip (HFY-TSK-223)
  const items = page.locator(".io-nav__item--bar");
  await expect(items).toHaveCount(4);
  for (const i of [0, 3]) { // the first and the last cell
    await page.keyboard.press("Tab"); // enters the page; then walk until the item has focus
    await items.nth(i).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(items.nth(i)).toBeFocused();
    const r = await items.nth(i).evaluate((e) => { const c = getComputedStyle(e); return { style: c.outlineStyle, width: c.outlineWidth, offset: c.outlineOffset, color: c.outlineColor }; });
    expect(r).toEqual({ style: "solid", width: "2px", offset: "-4px", color: TOKEN.gold });
  }
});

test("shell at 688: the sheets' close button has a strong border, and the palette's last row reads lowercase", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 688, height: 900 });
  await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  await page.locator(".hfy-bar .io-search-launcher").click();
  const close = page.locator(".io-sheet .io-sheet__close");
  await expect(close).toBeVisible();
  expect(await close.evaluate((e) => getComputedStyle(e).borderTopColor)).toBe(TOKEN.borderStrong);
  await page.locator(".io-sheet .io-search__input").fill("mar");
  const all = page.locator(".io-search__option--all .io-search__title");
  await expect(all).toBeVisible();
  await expect(all).toHaveText(/^See all results for/); // the kit's words, only the first letter restated
  expect(await all.evaluate((e) => getComputedStyle(e, "::first-letter").textTransform)).toBe("lowercase");
});

test("shell: going offline shows 'you're offline. the pages you already opened still work.' under the bar, and it goes when the connection returns", async ({ page, context }) => {
  await stub(page);
  await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-bar")).toBeVisible();
  await expect(page.locator("[data-hfy-offline-banner]")).toHaveCount(0);
  await context.setOffline(true);
  const banner = page.getByRole("status").filter({ hasText: "you're offline. the pages you already opened still work." });
  await expect(banner).toBeVisible();
  const b = await banner.evaluate((e) => {
    const c = getComputedStyle(e);
    const bar = document.querySelector(".hfy-bar").getBoundingClientRect();
    return { bg: c.backgroundColor, border: c.borderTopColor, size: parseFloat(c.fontSize), below: e.getBoundingClientRect().top >= bar.bottom, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  });
  expect(b).toMatchObject({ bg: TOKEN.surfaceRaised, border: TOKEN.gold, below: true });
  expect(b.size).toBeGreaterThanOrEqual(16);
  expect(b.scrollW).toBeLessThanOrEqual(b.innerW);
  await context.setOffline(false);
  await expect(page.locator("[data-hfy-offline-banner]")).toHaveCount(0);
});

test("iPhone, not installed: /me/notifications/ shows one add-to-home-screen card (the page's own), other pages keep the shell's", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({
    baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  await stub(page);
  await page.goto(`/about/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-install]")).toBeVisible();
  await page.goto(`/me/notifications/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-notify")).toBeVisible();
  await expect(page.locator(".io-shell")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("[data-hfy-install]")).toHaveCount(0);
  await ctx.close();
});

// ----------------------------------------------------------------------------------------------------------- notifications
test("notifications at 375: 'turn them on' is the full-width CTA with 'not now' centred under it; the page ends with the footer line", async ({ page }) => {
  await stub(page);
  await page.addInitScript(() => { Object.defineProperty(window, "Notification", { value: Object.assign(function Notification() {}, { permission: "default", requestPermission: async () => "default" }), configurable: true }); });
  await page.goto(`/me/notifications/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const on = page.locator('.hfy-notify [data-testid="push-nudge-on"]');
  if (await on.count()) {
    const nudge = await page.locator(".hfy-notify .iok-notify-nudge").boundingBox();
    const [bo, bd] = await Promise.all([on.boundingBox(), page.locator('.hfy-notify [data-testid="push-nudge-dismiss"]').boundingBox()]);
    expect(bo.width, "the CTA spans the card").toBeGreaterThan(nudge.width - 40);
    expect(bo.height).toBeGreaterThanOrEqual(56);
    expect(Math.abs(bd.x + bd.width / 2 - (nudge.x + nudge.width / 2))).toBeLessThanOrEqual(2);
    expect(bd.y).toBeGreaterThanOrEqual(bo.y + bo.height);
  }
  const foot = page.locator("footer.site-footer .site-footer__text");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toHaveText("harrisonfamily.us · kept by the family, for the family");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("posts page carries the footer line too", async ({ page }) => {
  await stub(page);
  await page.goto(`/posts/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const foot = page.locator("footer.site-footer .site-footer__text");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toHaveText("harrisonfamily.us · kept by the family, for the family");
});
