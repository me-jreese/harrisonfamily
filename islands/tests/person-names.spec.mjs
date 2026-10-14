// HFY-TSK-323 at 375px, rulings P2-R46 (io: a listed name is a link, with no underline, to the person's page) and P2-R47 (the text typed
// in the composer's photo field is the photo's visible caption). On /posts/, the /posts/?id= page with its comments, the home timeline,
// a person page's comments and the account sheet's title: every author name with a Gramps person id is an <a> to /person/?id=<id> that looks like the plain name
// (same colour and weight, no underline in any state, the pointer, the theme focus ring) and is a 44px target in its header; a name
// without a person id is plain text; a tap on a name opens that page. /auth, /api, the person JSON and the media are stubbed by route
// interception; synthetic data only.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-names.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = { id: "I9001", label: "Test Person" };
const ANN = { id: "I9003", label: "Ann Other" };
const OLIVE = { id: "I9004", label: "Olive Other" };
const GUEST = { id: "guest-0001", label: "A Guest Example" }; // no Gramps person id: plain text
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const CAN = { edit: false, delete: false, publish: false, moderate: false };
const photo = (n, alt) => ({ kind: "image", url: `/media/posts/${ULID(900 + n)}/photo.png`, mime: "image/png", ...(alt ? { alt } : {}) });

const POSTS = [
  { id: ULID(3), type: "post", author: ANN, subject: ANN.id, body: "Ann's synthetic post.", attachments: [photo(1, "the lake at dusk")], visibility: "published", created_at: T0, updated_at: T0, can: CAN },
  { id: ULID(2), type: "post", author: GUEST, subject: ME.id, body: "A synthetic post with no person id.", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: CAN },
  { id: ULID(1), type: "post", author: ME, subject: ME.id, body: "My synthetic post.", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { ...CAN, edit: true, delete: true } },
];
const comment = (n, threadId, author, body) => ({ id: `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, "0")}`, threadId, author, body, created_at: T0, can: { edit: author === ME, delete: author === ME, react: author !== ME, moderate: false } });
const THREADS = {
  [`post:${ULID(3)}`]: [comment(1, `post:${ULID(3)}`, ME, "A synthetic reply."), comment(2, `post:${ULID(3)}`, GUEST, "A synthetic guest reply."), comment(3, `post:${ULID(3)}`, ANN, "Ann answers.")],
  "person:I9001": [comment(4, "person:I9001", OLIVE, "Olive's synthetic comment."), comment(5, "person:I9001", GUEST, "A guest's synthetic comment."), comment(6, "person:I9001", ANN, "Ann's synthetic comment.")],
};

async function stub(page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/person/*.json", (r) => r.fulfill({ json: r.request().url().includes("I9001") ? PERSON : [] }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME.id, label: ME.label, admin: false, can: { moderate: false, graduate: false, approve: false } } }));
  await page.route("**/media/posts/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    const id = u.pathname.split("/")[3];
    if (id) { const p = POSTS.find((x) => x.id === id); return p ? r.fulfill({ json: p }) : r.fulfill({ status: 404, json: { error: "not_found", message: "no such post" } }); }
    return r.fulfill({ json: { items: POSTS, cursor: null } });
  });
  await page.route("**/api/comments**", (r) => {
    const subject = new URL(r.request().url()).searchParams.get("subject");
    return r.fulfill({ json: { thread: { id: subject, topic: "comments", comments: THREADS[subject] || [], reactions: {} } } });
  });
  await page.addInitScript(() => sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9001", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })));
}

/**
 * Every author name in `scope`, as rendered: the post bylines (the kit's meta span) and the comment authors. For a link: its href, its
 * text-decoration line, whether its colour and weight are the plain name's (a post byline's surrounding span; a plain comment author's
 * span, so the thread under test needs one), the cursor, and whether a point 21px above and below its centre still hits it (a 44px
 * target). `hover` hovers each link first.
 */
async function names(page, scope, { hover = false } = {}) {
  const out = [];
  const bylines = scope.locator(".iok-content-meta > span:first-child");
  const authors = scope.locator(".io-comments-author");
  for (const [kind, loc] of [["post", bylines], ["comment", authors]]) {
    for (let i = 0; i < await loc.count(); i += 1) {
      const el = loc.nth(i);
      const link = kind === "post" ? el.locator("a") : el.and(page.locator("a"));
      if (hover && await link.count()) { await link.scrollIntoViewIfNeeded(); await link.hover(); }
      out.push(await el.evaluate((n, { kind, hovered }) => {
        const a = n.tagName === "A" ? n : n.querySelector("a");
        const text = n.textContent.trim();
        if (!a) return { kind, text, tag: n.tagName === "SPAN" && kind === "comment" ? "SPAN" : "TEXT" };
        if (!hovered) a.scrollIntoView({ block: "center" }); // elementFromPoint sees only the viewport
        const cs = getComputedStyle(a);
        const plain = kind === "post" ? getComputedStyle(n) : getComputedStyle(n.closest(".io-comments").querySelector("span.io-comments-author"));
        const r = a.getBoundingClientRect();
        const hit = (dy) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + dy)?.closest("a") === a;
        return {
          kind, text, tag: "A", href: a.getAttribute("href"), deco: cs.textDecorationLine, sameColor: cs.color === plain.color,
          sameWeight: cs.fontWeight === plain.fontWeight, cursor: cs.cursor, target44: hit(-21) && hit(21),
        };
      }, { kind, hovered: hover }));
    }
  }
  return out;
}
const linked = (kind, who) => ({ kind, text: who.label, tag: "A", href: `/person/?id=${who.id}`, deco: "none", sameColor: true, sameWeight: true, cursor: "pointer", target44: true });
const plain = (kind, who) => ({ kind, text: who.label, tag: kind === "comment" ? "SPAN" : "TEXT" });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The link's :focus-visible ring: a solid outline of the theme's focus colour and ring width (`focus`: focus it first, by script). */
const focusRing = (link, focus = true) => link.evaluate((a, focus) => {
  if (focus) a.focus();
  const probe = document.createElement("span");
  probe.style.color = "var(--io-color-semantic-focus)";
  probe.style.width = "var(--io-control-focus-ring)";
  probe.style.position = "absolute";
  document.body.append(probe);
  const want = { color: getComputedStyle(probe).color, width: getComputedStyle(probe).width };
  probe.remove();
  const cs = getComputedStyle(a);
  return { visible: a.matches(":focus-visible"), style: cs.outlineStyle, color: cs.outlineColor === want.color, width: cs.outlineWidth === want.width };
}, focus);
const RING = { visible: true, style: "solid", color: true, width: true };

test("/posts/: each byline with a person id is a link to that page with the name's look; a byline without one is plain text", async ({ page }) => {
  await stub(page);
  await page.goto("/posts/?hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const list = page.locator("[data-hfy-posts]");
  await expect(list.getByText("My synthetic post.")).toBeVisible();
  expect(await names(page, list)).toEqual([linked("post", ANN), plain("post", GUEST), linked("post", ME)]);
  expect(await names(page, list, { hover: true }), "no underline and the same colour while hovered").toEqual([linked("post", ANN), plain("post", GUEST), linked("post", ME)]);
  expect(await focusRing(list.locator("a.iok-content-author").first())).toEqual(RING);
  expect(await noHScroll(page)).toBe(true);
});

test("/posts/?id=: the post's author and every comment author with a person id link to their page; a guest stays plain text", async ({ page }) => {
  await stub(page);
  await page.goto(`/posts/?id=${ULID(3)}&hfy_flags=postsV2`, { waitUntil: "domcontentloaded" });
  const one = page.locator("[data-hfy-post]");
  await expect(one.locator("[data-hfy-comments]").getByText("Ann answers.")).toBeVisible();
  const want = [linked("post", ANN), linked("comment", ME), plain("comment", GUEST), linked("comment", ANN)];
  expect(await names(page, one)).toEqual(want);
  expect(await names(page, one, { hover: true })).toEqual(want);
  const author = one.locator("[data-hfy-comments] a.io-comments-author").first();
  expect(await focusRing(author)).toEqual(RING);
  await author.click();
  await expect(page).toHaveURL(/\/person\/\?id=I9001$/);
});

test("home: 'latest from the family' bylines link to the author's page", async ({ page }) => {
  await stub(page);
  await page.goto("/?hfy_flags=postsV2,shellV2", { waitUntil: "domcontentloaded" });
  const tl = page.locator("[data-hfy-timeline]");
  await expect(tl.getByText("My synthetic post.")).toBeVisible();
  expect(await names(page, tl)).toEqual([linked("post", ANN), plain("post", GUEST), linked("post", ME)]);
  await tl.locator("a.iok-content-author", { hasText: ANN.label }).click();
  await expect(page).toHaveURL(/\/person\/\?id=I9003$/);
});

test("the account sheet's title, the member's own name, links to their page with the title's look", async ({ page }) => {
  await stub(page);
  await page.goto("/?hfy_flags=postsV2,shellV2", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: `you're signed in as ${ME.label}` }).click();
  const sheet = page.getByRole("dialog", { name: ME.label });
  const name = sheet.getByRole("heading").getByRole("link", { name: ME.label });
  await expect(name).toHaveAttribute("href", "/person/?id=I9001");
  expect(await name.evaluate((a) => {
    const cs = getComputedStyle(a);
    const title = getComputedStyle(a.parentElement);
    const r = a.getBoundingClientRect();
    const hit = (dy) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + dy)?.closest("a") === a;
    return { deco: cs.textDecorationLine, color: cs.color === title.color, weight: cs.fontWeight === title.fontWeight, family: cs.fontFamily === title.fontFamily, cursor: cs.cursor, target44: hit(-21) && hit(21) };
  })).toEqual({ deco: "none", color: true, weight: true, family: true, cursor: "pointer", target44: true });
  // the sheet was opened with a click, so a scripted focus would not be :focus-visible; Tab from the panel reaches the name first
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  expect(await focusRing(name, false)).toEqual(RING);
  await name.click();
  await expect(page).toHaveURL(/\/person\/\?id=I9001$/);
});

test("a person page's comments: every author with a person id links to their page; a guest stays plain text", async ({ page }) => {
  await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=personV2", { waitUntil: "domcontentloaded" });
  const thread = page.locator("[data-hfy-comments]");
  await expect(thread.getByText("Ann's synthetic comment.")).toBeVisible();
  expect(await names(page, thread)).toEqual([linked("comment", OLIVE), plain("comment", GUEST), linked("comment", ANN)]);
  expect(await names(page, thread, { hover: true })).toEqual([linked("comment", OLIVE), plain("comment", GUEST), linked("comment", ANN)]);
  expect(await noHScroll(page)).toBe(true);
});

test.describe("touch at 375", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  test("a tap on a byline or a comment author opens that person's page", async ({ page }) => {
    await stub(page);
    await page.goto("/?hfy_flags=postsV2,shellV2", { waitUntil: "domcontentloaded" });
    const tl = page.locator("[data-hfy-timeline]");
    await tl.locator("a.iok-content-author", { hasText: ANN.label }).tap();
    await expect(page).toHaveURL(/\/person\/\?id=I9003$/);
    await page.goto("/person/?id=I9001&hfy_flags=personV2", { waitUntil: "domcontentloaded" });
    const olive = page.locator("[data-hfy-comments] a.io-comments-author", { hasText: OLIVE.label });
    await olive.scrollIntoViewIfNeeded();
    await olive.tap();
    await expect(page).toHaveURL(/\/person\/\?id=I9004$/);
  });
});

test("P2-R47: a photo's caption shows under it, and its alt is the who-posted fallback, not the caption again", async ({ page }) => {
  await stub(page);
  await page.goto("/posts/?hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const row = page.locator(".hfy-posts__item", { hasText: "Ann's synthetic post." });
  const caption = row.locator("figure.iok-content-figure > figcaption");
  await expect(caption).toHaveText("the lake at dusk");
  await expect(caption).toBeVisible();
  const img = row.locator("figure.iok-content-figure > img");
  await expect(img).toHaveAttribute("alt", "a photo from Ann Other");
  await expect(row.getByRole("figure", { name: "the lake at dusk" })).toBeVisible();
  const [ib, cb] = await Promise.all([img.boundingBox(), caption.boundingBox()]);
  expect(cb.y, "the caption sits under the photo").toBeGreaterThanOrEqual(ib.y + ib.height - 0.5);
  expect(await caption.evaluate((c) => parseFloat(getComputedStyle(c).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await noHScroll(page)).toBe(true);
});
