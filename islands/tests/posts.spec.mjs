// HFY-TSK-067 at 375px: postsV2 on, /api + uploads + /auth/session stubbed by route interception; synthetic data only.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = { id: "I9001", label: "Test Person" };
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";

async function stub(page, { signedIn = true } = {}) {
  const s = { posts: [], comments: [], uploads: 0, puts: 0, postBodies: [], n: 0 };
  s.posts.push({ id: ULID(1), type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "Seeded older post", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/person/*.json", (r) => r.fulfill({ json: r.request().url().includes("I9001") ? PERSON : [] }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } : { authenticated: false } }));
  await page.route("**/media/posts/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("https://s3.test/**", (r) => { s.puts += 1; return r.fulfill({ status: 200, body: "" }); });
  await page.route("**/api/uploads", (r) => {
    s.uploads += 1;
    const b = r.request().postDataJSON();
    return r.fulfill({ status: 201, json: { uploadUrl: `https://s3.test/put/${b.filename}`, publicUrl: `http://127.0.0.1:8089/media/posts/${ULID(900)}/${b.filename}`, headers: { "Content-Type": b.contentType } } });
  });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const id = u.pathname.split("/")[3];
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
  await expect(mine.getByText("Share something")).toBeVisible();
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
  await tl.getByRole("link", { name: /view post/i }).first().click();
  await expect(page).toHaveURL(/\/posts\/\?id=01JZ/);
  const one = page.locator("[data-hfy-post]");
  await expect(one.getByText("Garden photo day")).toBeVisible();
  const cbox = one.locator("[data-hfy-comments]").getByRole("textbox");
  await cbox.fill("Lovely!");
  await one.locator("[data-hfy-comments]").getByRole("button", { name: /^post$/i }).click();
  await expect(one.locator("[data-hfy-comments]").getByRole("list").getByText("Lovely!")).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test("someone else's person page: no composer; /posts/ lists; missing id shows a banner", async ({ page }) => {
  await stub(page);
  await page.goto("/person/?id=I9003&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  expect(await page.locator("[data-hfy-my-posts]").count()).toBe(0);
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Seeded older post")).toBeVisible();
  await page.goto("/posts/?id=01JNOPE", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-banner]")).toContainText("not found");
});

test("flag off: homepage, person and /posts/ unchanged, no posts islands requested", async ({ page }) => {
  await stub(page);
  const asked = [];
  page.on("request", (q) => { if (/\/js\/islands\/(timeline|my-posts|posts)/.test(q.url())) asked.push(q.url()); });
  await page.goto("/?hfy_flags=-postsV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("LEGACY NOTE")).toBeVisible();
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/posts are loading/i)).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
  expect(await page.locator("[data-hfy-timeline], [data-hfy-my-posts], [data-hfy-posts]").count()).toBe(0);
});
