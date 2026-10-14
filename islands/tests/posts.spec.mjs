// HFY-TSK-067 at 375px: postsV2 on, /api + uploads + /auth/session stubbed by route interception; synthetic data only.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = { id: "I9001", label: "Test Person" };
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";

async function stub(page, { signedIn = true } = {}) {
  const s = { posts: [], comments: [], uploads: 0, puts: 0, postBodies: [], n: 0, deletes: [] };
  s.posts.push({ id: ULID(1), type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "Seeded older post", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/person/*.json", (r) => r.fulfill({ json: r.request().url().includes("I9001") ? PERSON : [] }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } : { authenticated: false } }));
  await page.route("**/media/posts/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("https://s3.test/**", (r) => { s.puts += 1; return r.fulfill({ status: 200, body: "" }); });
  await page.route("**/api/uploads", (r) => {
    s.uploads += 1;
    const b = r.request().postDataJSON();
    return r.fulfill({ status: 201, json: { uploadUrl: `https://s3.test/put/photo.png`, publicUrl: `http://127.0.0.1:8089/media/posts/${ULID(900)}/photo.png`, headers: { "Content-Type": b.contentType } } });
  });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const id = u.pathname.split("/")[3];
    if (req.method() === "DELETE") { s.deletes.push(id); s.posts = s.posts.filter((p) => p.id !== id); return r.fulfill({ status: 204, body: "" }); }
    if (req.method() === "GET" && id) { const p = s.posts.find((x) => x.id === id); return p ? r.fulfill({ json: p }) : r.fulfill({ status: 404, json: { error: "not_found", message: "no such post" } }); }
    if (req.method() === "GET") {
      const subj = u.searchParams.get("subject");
      return r.fulfill({ json: { items: s.posts.filter((p) => !subj || p.subject === subj).sort((a, b) => (a.id < b.id ? 1 : -1)), cursor: null } });
    }
    if (req.method() === "POST") {
      const b = req.postDataJSON();
      s.postBodies.push(b);
      s.n += 1;
      const p = { id: ULID(10 + s.n), type: "post", author: ME, subject: b.subject, body: b.body, attachments: b.attachments || [], visibility: b.visibility || "draft", created_at: T0, updated_at: T0, can: { edit: true, delete: true, publish: true } };
      s.posts.push(p);
      return r.fulfill({ status: 201, json: p });
    }
    return r.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/comments**", (r) => {
    const req = r.request();
    if (req.method() === "GET") return r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: s.comments, reactions: {} } } });
    const b = req.postDataJSON();
    const c = { id: ULID(500 + s.comments.length), threadId: b.subject, author: ME, body: b.body, created_at: T0, can: { edit: true, delete: true, react: false } };
    s.comments.push(c);
    return r.fulfill({ status: 201, json: c });
  });
  await page.addInitScript(() => sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9001", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })));
  return s;
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("compose on own page (stubbed upload) -> timeline -> /posts/?id= -> comment", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.getByRole("heading", { name: "share something" })).toBeVisible();
  await expect(mine.locator('input[name="subject"]')).toHaveCount(0); // capabilities subject:false: the page's person is the subject
  const box = mine.getByRole("textbox").first();
  await box.fill("Garden photo day");
  await mine.locator('input[type=file]').first().setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: PNG });
  await expect.poll(() => s.puts).toBe(1);
  const submit = mine.getByRole("button", { name: /^post$/i });
  const [hb, hs] = await Promise.all([box.boundingBox(), submit.boundingBox()]);
  expect(hs.height).toBeGreaterThanOrEqual(43.5);
  expect(await box.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
  await submit.click();
  await expect(mine.getByText("Garden photo day")).toBeVisible();
  await expect(mine.getByRole("status").filter({ hasText: /^posted$/ })).toBeVisible(); // the 3 s status ping
  expect(s.postBodies[0]).toMatchObject({ visibility: "published", subject: "I9001", body: "Garden photo day" });
  expect(s.postBodies[0].attachments[0]).toMatchObject({ kind: "image", mime: "image/png" });
  expect(s.uploads).toBe(1);
  expect(await noHScroll(page)).toBe(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const tl = page.locator("[data-hfy-timeline]");
  await expect(tl.getByText("Garden photo day")).toBeVisible();
  await expect(tl.getByText("Seeded older post")).toBeVisible();
  const order = await tl.locator("li").allInnerTexts();
  expect(order[0]).toContain("Garden photo day");
  await tl.getByRole("link", { name: /^comments/ }).first().click();
  await expect(page).toHaveURL(/\/posts\/\?id=01JZ/);
  const one = page.locator("[data-hfy-post]");
  await expect(one.getByText("Garden photo day")).toBeVisible();
  const cbox = one.locator("[data-hfy-comments]").getByRole("textbox");
  await cbox.fill("Lovely!");
  await one.locator("[data-hfy-comments]").getByRole("button", { name: /^post$/i }).click();
  await expect(one.locator("[data-hfy-comments]").getByRole("list").getByText("Lovely!")).toBeVisible();
  await expect(one.locator("[data-hfy-comments]").getByRole("status").filter({ hasText: /^posted$/ })).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test("delete asks first: inline 'delete this post?' -> keep (nothing sent) / delete (DELETE sent, row gone)", async ({ page }) => {
  const s = await stub(page);
  s.posts.push({ id: ULID(7), type: "post", author: ME, subject: ME.id, body: "Mine to delete", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: true, delete: true, publish: false } });
  await page.goto("/posts/?hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const row = page.locator(".hfy-posts__item", { hasText: "Mine to delete" });
  await expect(row).toBeVisible();
  await expect(page.locator(".hfy-posts__item", { hasText: "Seeded older post" }).getByRole("button", { name: "delete" })).toHaveCount(0);
  await row.getByRole("button", { name: "delete" }).click();
  const ask = row.getByRole("group", { name: "delete this post?" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "keep" })).toBeFocused();
  await ask.getByRole("button", { name: "keep" }).click();
  await expect(ask).toHaveCount(0);
  expect(s.deletes).toEqual([]);
  await row.getByRole("button", { name: "delete" }).click();
  await row.getByRole("group", { name: "delete this post?" }).getByRole("button", { name: "delete" }).click();
  await expect(page.locator(".hfy-posts__item", { hasText: "Mine to delete" })).toHaveCount(0);
  expect(s.deletes).toEqual([ULID(7)]);
});

test("home: the timeline mounts in the page's own <main>, above the footer, and uses the one time format", async ({ page }) => {
  const s = await stub(page);
  s.posts[0].created_at = new Date(Date.now() - 5 * 60e3).toISOString();
  await page.goto("/?hfy_flags=postsV2,shellV2", { waitUntil: "domcontentloaded" });
  const tl = page.locator("[data-hfy-timeline]");
  await expect(tl.getByText("Seeded older post")).toBeVisible();
  await expect(tl.getByRole("heading", { name: "latest from the family" })).toBeVisible();
  await expect(tl.locator("time").first()).toHaveText("5 min ago");
  const where = await page.evaluate(() => {
    const host = document.getElementById("hfy-timeline");
    const footer = document.querySelector("footer");
    return { pageMain: Boolean(host.closest("main:not([data-io-scroller])")), beforeFooter: Boolean(footer) && Boolean(host.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING), above: !footer || host.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top + 0.5 };
  });
  expect(where.pageMain, "inside main:not([data-io-scroller])").toBe(true);
  expect(where.beforeFooter, "the footer follows the timeline in the DOM").toBe(true);
  expect(where.above, "and on screen").toBe(true);
});

test("someone else's person page: no composer; /posts/ lists; missing id shows a banner", async ({ page }) => {
  await stub(page);
  await page.goto("/person/?id=I9003&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  expect(await page.locator("[data-hfy-my-posts]").count()).toBe(0);
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Seeded older post")).toBeVisible();
  await page.goto("/posts/?id=01JNOPE", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-banner]")).toContainText("that post wasn't found. if that's wrong, text J.");
});

test("flag off: homepage, person and /posts/ unchanged, no posts islands requested", async ({ page }) => {
  await stub(page);
  const asked = [];
  page.on("request", (q) => { if (/\/js\/islands\/(timeline|my-posts|posts)/.test(q.url())) asked.push(q.url()); });
  await page.goto("/?hfy_flags=-postsV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  // -personV2 too: with personV2 on (flags.json) its notes island replaces the legacy note as soon as it loads, a race this check lost
  // about one run in eight; the check is about postsV2 leaving the page alone.
  await page.goto("/person/?id=I9001&hfy_flags=-postsV2,-personV2", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("LEGACY NOTE")).toBeVisible();
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/posts are loading/i)).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
  expect(await page.locator("[data-hfy-timeline], [data-hfy-my-posts], [data-hfy-posts]").count()).toBe(0);
});

// HFY-TSK-315 (@io-kit/content 0.3.1): a post is a line, a photo, or both. What a photo-only post's row holds: the kit card is the
// meta row and the photo list only (no markdown or excerpt element for the empty body), every image's alt, and any element that is
// drawn with nothing in it (no children, no text, not an image), which must be none.
const photoOnlyRow = (row) => row.evaluate((li) => {
  const card = li.querySelector(".iok-content-card");
  const drawn = (e) => e.getClientRects().length > 0; // generates a box: not display:none, nor inside one
  return {
    card: [...card.children].filter(drawn).map((c) => c.className),
    markdown: card.querySelectorAll(".kit-md, .iok-content-card > p").length,
    alts: [...li.querySelectorAll("img")].map((i) => i.alt),
    empty: [...li.querySelectorAll("*")].filter((e) => drawn(e) && e.tagName !== "IMG" && e.children.length === 0 && e.textContent.trim() === "").map((e) => e.outerHTML.slice(0, 80)),
  };
});

test("HFY-TSK-315: post is enabled with a photo and an empty text box; the photo-only post shows as just its photo in my posts, the timeline and /posts/?id=", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  const box = mine.getByRole("textbox").first();
  const submit = mine.getByRole("button", { name: /^post$/i });
  const picker = mine.locator("input[type=file]").first();
  await expect(submit).toBeVisible();
  await submit.scrollIntoViewIfNeeded();
  await expect(submit, "the post button is wholly on screen at 375px, not clipped").toBeInViewport({ ratio: 1 });
  await expect(box).toHaveValue("");
  await expect(submit).toBeDisabled(); // nothing to post yet: no line, no photo

  await picker.setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: PNG });
  await expect.poll(() => s.puts).toBe(1);
  await expect(box).toHaveValue("");
  await expect(submit).toBeEnabled(); // a photo alone is enough
  await expect(submit).toBeInViewport({ ratio: 1 });
  expect(await box.evaluate((e) => e.required), "the empty box is not `required` while a photo is attached").toBe(false);
  await mine.getByRole("button", { name: "remove 1" }).click();
  await expect(submit).toBeDisabled(); // the photo was the only content
  expect(await box.evaluate((e) => e.required)).toBe(true);

  await picker.setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: PNG });
  await expect.poll(() => s.puts).toBe(2);
  await mine.getByRole("textbox", { name: "add a caption 1" }).fill("the garden at dusk");
  await box.fill("   "); // whitespace only is still an empty box
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(mine.getByRole("status").filter({ hasText: /^posted$/ })).toBeVisible();
  expect(s.postBodies).toHaveLength(1);
  expect(s.postBodies[0]).toMatchObject({ visibility: "published", subject: "I9001", body: "" });
  expect(s.postBodies[0].attachments).toEqual([expect.objectContaining({ kind: "image", mime: "image/png", alt: "the garden at dusk" })]);
  await expect(box).toHaveValue("");
  await expect(submit).toBeDisabled(); // the composer is clear again

  // P2-R47 (HFY-TSK-323): the typed text is the photo's visible caption, under it; the img alt is the who-posted fallback, so the
  // caption is not announced twice.
  const want = { card: ["iok-content-meta", "iok-content-media"], markdown: 0, alts: ["a photo from Test Person"], empty: [] };
  const row = (scope) => scope.locator(".hfy-posts__item").filter({ has: page.locator("figcaption", { hasText: "the garden at dusk" }) });
  await expect(row(mine)).toHaveCount(1);
  expect(await photoOnlyRow(row(mine))).toEqual(want);
  expect(await noHScroll(page)).toBe(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const tl = page.locator("[data-hfy-timeline]");
  await expect(row(tl)).toHaveCount(1);
  expect(await photoOnlyRow(row(tl))).toEqual(want);
  await expect(tl.locator(".hfy-posts__item").first().locator("figcaption")).toHaveText("the garden at dusk"); // newest first
  await expect(tl.getByText("Seeded older post")).toBeVisible();

  await row(tl).getByRole("link", { name: /^comments/ }).click();
  await expect(page).toHaveURL(/\/posts\/\?id=01JZ/);
  const one = page.locator("[data-hfy-post]");
  await expect(row(one)).toHaveCount(1);
  expect(await photoOnlyRow(row(one))).toEqual(want);
});

// HFY-TSK-315 review: a photo posted with no caption and an empty box. The upload carries no alt and the member typed none, so the
// request has none either; every list renders the photo as "a photo from <name>" (posts-ui photoAlt), never alt="", so the row is more
// than a name and a time to a screen reader. In a post with several photos the fallback counts them, and a typed caption shows under
// its photo (P2-R47, HFY-TSK-323) instead of standing in for the alt.
test("HFY-TSK-315: a photo posted with no caption reads as \"a photo from <name>\" in my posts, the timeline and /posts/?id=", async ({ page }) => {
  const s = await stub(page);
  s.posts.push({
    id: ULID(2), type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "",
    attachments: [
      { kind: "image", url: `http://127.0.0.1:8089/media/posts/${ULID(901)}/photo.png`, mime: "image/png", alt: "the lake" },
      { kind: "image", url: `http://127.0.0.1:8089/media/posts/${ULID(902)}/photo.png`, mime: "image/png" },
      { kind: "image", url: `http://127.0.0.1:8089/media/posts/${ULID(903)}/photo.png`, mime: "image/png", alt: "  " },
    ],
    visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false },
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  const box = mine.getByRole("textbox").first();
  const submit = mine.getByRole("button", { name: /^post$/i });
  await mine.locator("input[type=file]").first().setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: PNG });
  await expect.poll(() => s.puts).toBe(1);
  await expect(mine.getByRole("textbox", { name: "add a caption 1" })).toHaveValue("");
  await expect(box).toHaveValue("");
  await submit.scrollIntoViewIfNeeded();
  await expect(submit, "post is on screen and enabled at 320px with only an undescribed photo").toBeInViewport({ ratio: 1 });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(mine.getByRole("status").filter({ hasText: /^posted$/ })).toBeVisible();
  expect(s.postBodies).toHaveLength(1);
  expect(s.postBodies[0]).toMatchObject({ body: "" });
  expect(s.postBodies[0].attachments).toHaveLength(1);
  expect(s.postBodies[0].attachments[0].alt ?? "", "nothing is written into the post: the fallback is render only").toBe("");

  const want = { card: ["iok-content-meta", "iok-content-media"], markdown: 0, alts: ["a photo from Test Person"], empty: [] };
  const row = (scope) => scope.locator(".hfy-posts__item").filter({ has: page.getByRole("img", { name: "a photo from Test Person" }) });
  await expect(row(mine)).toHaveCount(1);
  expect(await photoOnlyRow(row(mine))).toEqual(want);
  await expect(row(mine)).toMatchAriaSnapshot(`
    - listitem:
      - article:
        - link "Test Person":
          - /url: /person/?id=I9001
        - time
        - list:
          - listitem:
            - figure:
              - img "a photo from Test Person"
      - link "comments on Test Person's post"
      - button "delete"
  `);
  expect(await noHScroll(page)).toBe(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const tl = page.locator("[data-hfy-timeline]");
  await expect(row(tl)).toHaveCount(1);
  expect(await photoOnlyRow(row(tl))).toEqual(want);
  const several = tl.locator(".hfy-posts__item").filter({ has: page.locator("figcaption", { hasText: "the lake" }) });
  expect(await several.locator("img").evaluateAll((imgs) => imgs.map((i) => i.alt))).toEqual(["photo 1 of 3 from Ann Other", "photo 2 of 3 from Ann Other", "photo 3 of 3 from Ann Other"]);
  await expect(several.locator("figcaption"), "only the typed caption draws; a blank one does not").toHaveText(["the lake"]);
  expect(await noHScroll(page)).toBe(true);

  await row(tl).getByRole("link", { name: /^comments/ }).click();
  await expect(page).toHaveURL(/\/posts\/\?id=01JZ/);
  const one = page.locator("[data-hfy-post]");
  await expect(row(one)).toHaveCount(1);
  expect(await photoOnlyRow(row(one))).toEqual(want);
});
