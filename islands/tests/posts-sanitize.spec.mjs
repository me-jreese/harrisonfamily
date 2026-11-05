// HFY-TSK-171 (PS-11) at 375px: postsV2 on, /api and /auth/session stubbed by route interception; synthetic data only.
// A post body is member-written markdown. The HFY SanitizePolicy (src/lib/sanitize-policy.js) means a markdown image to an external
// host is never requested and a mailto: link is not a link; an https link and a photo attachment still work.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = { id: "I9001", label: "Test Person" };
const T0 = "2026-01-01T00:00:00.000Z";
const ID = "01JZZZZZZZZZZZZZZZZZZZZ001";
const EXTERNAL = "tracker.example.test";

const BODY = [
  "hello from the garden",
  "",
  `![tiny pixel](https://${EXTERNAL}/pixel.png)`,
  "",
  "[write me](mailto:someone@example.test) or [read more](https://example.test/read)",
  "",
  `<img src="https://${EXTERNAL}/raw.png" alt="raw">`
].join("\n");

async function stub(page) {
  const asked = [];
  page.on("request", (q) => { if (new URL(q.url()).hostname === EXTERNAL) asked.push(q.url()); });
  const post = { id: ID, type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: BODY, attachments: [{ kind: "image", url: "/media/posts/garden.png", mime: "image/png" }], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false, moderate: false } };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  // Nothing may leave for the external host; a request would still be recorded above before this aborts it.
  await page.route(`https://${EXTERNAL}/**`, (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("**/person/*.json", (r) => r.fulfill({ json: r.request().url().includes("I9001") ? PERSON : [] }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } }));
  await page.route("**/media/posts/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    const id = u.pathname.split("/")[3];
    if (id) return id === ID ? r.fulfill({ json: post }) : r.fulfill({ status: 404, json: { error: "not_found", message: "no such post" } });
    return r.fulfill({ json: { items: [post], cursor: null } });
  });
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.addInitScript(() => sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9001", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })));
  return asked;
}

// What the post's markdown body holds: images, mailto links, https links, and the kit's own attachment photo.
const body = (scope) => scope.locator(".kit-md").evaluate((md) => {
  const card = md.closest("article");
  return {
    text: md.textContent,
    bodyImages: md.querySelectorAll("img").length,
    mailto: card.querySelectorAll('a[href^="mailto:"]').length,
    writeMeIsLink: Boolean([...md.querySelectorAll("a")].find((a) => a.textContent === "write me")),
    readMore: [...md.querySelectorAll("a")].filter((a) => a.textContent === "read more").map((a) => ({ href: a.getAttribute("href"), rel: a.rel })),
    attachmentImages: card.querySelectorAll("figure img").length
  };
});

for (const [name, url, scope] of [
  ["the /posts/ list (PostCard)", "/posts/?hfy_flags=postsV2", (p) => p.locator(".hfy-posts__item").first()],
  ["the home timeline (PostCard)", "/?hfy_flags=postsV2,shellV2", (p) => p.locator("[data-hfy-timeline] li").first()],
  ["one post at /posts/?id= (ArticleView or PostCard)", `/posts/?id=${ID}&hfy_flags=postsV2`, (p) => p.locator("[data-hfy-post]")]
]) {
  test(`${name}: a markdown image to an external host is never requested, mailto: is no link, an https link and the photo attachment stay`, async ({ page }) => {
    const asked = await stub(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const row = scope(page);
    await expect(row.getByText("hello from the garden")).toBeVisible();
    const photo = row.locator("figure img").first();
    await photo.scrollIntoViewIfNeeded(); // the kit lazy-loads it
    await expect(photo, "the attachment photo still draws").toBeVisible();
    await page.waitForTimeout(700); // an image request would have started by now
    const b = await body(row);
    expect(b.bodyImages, "no <img> inside the markdown body").toBe(0);
    expect(b.attachmentImages, "the photo attachment is the only image").toBe(1);
    expect(b.mailto, "no mailto: link anywhere in the card").toBe(0);
    expect(b.writeMeIsLink, "the mailto text stays as text, not a link").toBe(false);
    expect(b.text).toContain("write me");
    expect(b.text, "raw html is inert text, not an element").toContain("<img src=");
    expect(b.readMore).toEqual([{ href: "https://example.test/read", rel: "noopener noreferrer nofollow ugc" }]);
    expect(asked, `a request went to ${EXTERNAL}`).toEqual([]);
  });
}
