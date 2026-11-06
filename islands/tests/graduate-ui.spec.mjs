// HFY-TSK-215 (R-02; social.md section 10) at 375 px and 1280 px: "add to a family page…" on a comment photo for an admin, with graduateV1 on
// (the loader forces commentPhotosV1 and moderationV1 on with it) and off. /auth/session, /api/me, /api/comments, the graduate route, the person
// pages and the people index are stubbed by route interception. Synthetic data only.
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/graduate-ui.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const ADMIN = { id: "I9002", label: "Ada Example" };
const MEMBER = { id: "I9004", label: "Mo Member" };
const AUTHOR = { id: "I9003", label: "Ann Other" };
const PEOPLE = [
  { grampsId: "I9001", displayName: "Test Person (synthetic)", lifespanSummary: "1900 - 1970" },
  { grampsId: "I9005", displayName: "Quillfeather Example", lifespanSummary: "1920 - 1990" },
  { grampsId: "I9006", displayName: "Quillham Sample", lifespanSummary: "1930 - 2000" },
];
const FLAGS = JSON.parse(readFileSync(new URL("../../11ty/_data/flags.json", import.meta.url), "utf8"));
const photo = (n, over = {}) => ({ id: `att${n}`, kind: "image", url: `/uploads/comments/${ULID(80 + n)}/c${n}.jpg`, mime: "image/jpeg", alt: `a photo from ${AUTHOR.label}`, ...over });
const comment = (n, attachments, over = {}) => ({ id: ULID(n), threadId: "person:I9001", author: AUTHOR, body: `Synthetic comment ${n}`, attachments, created_at: T0, can: { edit: false, delete: false, react: false, moderate: true }, ...over });

async function stub(page, { viewer = ADMIN, admin = true, comments = [], flag = true, graduate } = {}) {
  const s = { calls: [], comments: [...comments] };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  // commentPhotosV1 and moderationV1 are off in the build: graduateV1 alone has to bring them in.
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, graduateV1: flag, commentPhotosV1: false, moderationV1: false } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/person/*.json", (r) => (r.request().url().includes("I9001.json") || r.request().url().includes("index.json") ? r.fallback() : r.fulfill({ json: [] })));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: viewer.id, grampsId: viewer.id, label: viewer.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: viewer.id, label: viewer.label, admin, can: { moderate: admin, graduate: admin, approve: admin } } }));
  await page.route("**/uploads/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("**/api/comments**", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: s.comments, reactions: {} } } });
    return r.fulfill({ status: 204, body: "" });
  });
  // registered last, so it wins over the generic comments route above
  await page.route(/\/api\/comments\/[^/]+\/attachments\/[^/]+\/graduate$/, (r) => {
    const body = r.request().postDataJSON();
    s.calls.push({ path: new URL(r.request().url()).pathname, body });
    return graduate ? graduate(r, body, s) : r.fulfill({ status: 201, json: { media: { handle: "h1" }, person: body.person, state: "done" } });
  });
  await page.addInitScript((id) => sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: id, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })), viewer.id);
  return s;
}

const thread = (page) => page.locator("[data-hfy-comments]");
const li = (page, n) => thread(page).locator(".io-comments-list > li", { hasText: `Synthetic comment ${n}` });
const trigger = (loc) => loc.getByRole("button", { name: "add to a family page…" });
const open = async (page) => { await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" }); await expect(thread(page).getByRole("textbox", { name: "say something" })).toBeVisible(); };
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("an admin adds a photo: the picker defaults to the thread's person, the title is the alt text, and the badge links to the photos", async ({ page }) => {
  const s = await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await expect(trigger(li(page, 1))).toBeVisible();
  await trigger(li(page, 1)).click();
  const form = li(page, 1).locator("[data-hfy-grad-form]");
  await expect(form.getByRole("combobox", { name: "which page?" })).toHaveValue(/Test Person|I9001/);
  await expect(form.getByRole("textbox", { name: "title" })).toHaveValue(`a photo from ${AUTHOR.label}`);
  await form.getByRole("textbox", { name: "title" }).fill("The dock at dusk");
  await form.getByRole("button", { name: "add to page" }).click();
  await expect.poll(() => s.calls.length).toBe(1);
  expect(s.calls[0]).toEqual({ path: `/api/comments/${ULID(1)}/attachments/att1/graduate`, body: { subject: "person:I9001", person: "I9001", title: "The dock at dusk" } });
  const badge = li(page, 1).locator("[data-hfy-grad-badge]");
  await expect(badge).toHaveAttribute("href", "/person/?id=I9001#photos");
  await expect(badge).toContainText(/^on .+’s page$/);
  await expect(trigger(li(page, 1))).toHaveCount(0);
});

test("the picker picks another person from the list, and typed text alone is not a value", async ({ page }) => {
  const s = await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await trigger(li(page, 1)).click();
  const box = li(page, 1).getByRole("combobox", { name: "which page?" });
  await box.fill("Quillf");
  await expect(li(page, 1).getByRole("option", { name: /Quillfeather Example/ })).toBeVisible();
  // typing cleared the default: without a pick, adding is refused in the form
  await li(page, 1).getByRole("button", { name: "add to page" }).click();
  await expect(li(page, 1).getByRole("alert")).toHaveText("pick a page from the list.");
  expect(s.calls).toHaveLength(0);
  await li(page, 1).getByRole("option", { name: /Quillfeather Example/ }).click();
  await li(page, 1).getByRole("button", { name: "add to page" }).click();
  await expect.poll(() => s.calls.length).toBe(1);
  expect(s.calls[0].body.person).toBe("I9005");
  await expect(li(page, 1).locator("[data-hfy-grad-badge]")).toHaveText("on Quillfeather Example’s page");
  await expect(li(page, 1).locator("[data-hfy-grad-badge]")).toHaveAttribute("href", "/person/?id=I9005#photos");
});

test("cancel closes the form and gives focus back; the form is inline, not a dialog", async ({ page }) => {
  await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await trigger(li(page, 1)).click();
  await expect(li(page, 1).locator("[data-hfy-grad-form]")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await li(page, 1).getByRole("button", { name: "cancel" }).click();
  await expect(li(page, 1).locator("[data-hfy-grad-form]")).toHaveCount(0);
  await expect(trigger(li(page, 1))).toBeFocused();
});

test("errors: a 503 uses the E15 line, a validation refusal sits under the title, and another person's page is named (E18)", async ({ page }) => {
  let n = 0;
  await stub(page, {
    comments: [comment(1, [photo(1)])],
    graduate: (r) => {
      n += 1;
      if (n === 1) return r.fulfill({ status: 503, json: { error: "graduate_copy_failed", message: "x" } });
      if (n === 2) return r.fulfill({ status: 400, json: { error: "validation", message: "x", details: { field: "title", pointer: "/desc" } } });
      return r.fulfill({ status: 409, json: { error: "already_graduated", message: "x", details: { person: "I9005" } } });
    },
  });
  await open(page);
  await trigger(li(page, 1)).click();
  const add = li(page, 1).getByRole("button", { name: "add to page" });
  await add.click();
  await expect(li(page, 1).getByRole("alert")).toHaveText("couldn't add it to the page right now. try again in a minute.");
  await add.click();
  const under = li(page, 1).locator("[data-hfy-grad-form] .hfy-grad__field", { has: page.getByRole("textbox", { name: "title" }) }).getByRole("alert");
  await expect(under).toHaveText("that title didn't work. check it and try again.");
  await add.click();
  await expect(li(page, 1).getByRole("alert")).toHaveText("this photo is already on Quillfeather Example’s page.");
});

test("a reservation pending for more than 15 minutes shows retry, which resumes it; a fresh one only says it is adding", async ({ page }) => {
  const stale = new Date(Date.now() - 16 * 60_000).toISOString();
  const fresh = new Date(Date.now() - 2 * 60_000).toISOString();
  const s = await stub(page, {
    comments: [
      comment(1, [photo(1, { graduated: { state: "pending", person: "I9005", at: stale, title: "Kept title" } })]),
      comment(2, [photo(2, { graduated: { state: "pending", person: "I9005", at: fresh } })]),
      comment(3, [photo(3, { graduated: { state: "done", person: "I9005" } })]),
    ],
  });
  await open(page);
  await expect(li(page, 2).locator("[data-hfy-grad-pending]")).toHaveText("adding to a page…");
  await expect(li(page, 2).getByRole("button", { name: "retry" })).toHaveCount(0);
  await expect(li(page, 3).locator("[data-hfy-grad-badge]")).toHaveAttribute("href", "/person/?id=I9005#photos");
  await li(page, 1).getByRole("button", { name: "retry" }).click();
  await expect.poll(() => s.calls.length).toBe(1);
  expect(s.calls[0].body).toEqual({ subject: "person:I9001", person: "I9005", title: "Kept title" });
  await expect(li(page, 1).locator("[data-hfy-grad-badge]")).toBeVisible();
});

test("375 px: inputs are 16 px, buttons are full width and 44 px tall, nothing scrolls sideways, axe is clean", async ({ page }) => {
  await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await trigger(li(page, 1)).click();
  await li(page, 1).getByRole("combobox", { name: "which page?" }).fill("Quill");
  await expect(li(page, 1).getByRole("option").first()).toBeVisible();
  const form = li(page, 1).locator("[data-hfy-grad-form]");
  for (const name of ["which page?", "title"]) expect(await form.getByRole(name === "title" ? "textbox" : "combobox", { name }).evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
  const field = await form.locator(".hfy-grad__pick").boundingBox();
  const list = await form.getByRole("listbox").boundingBox();
  expect(list.y, "the results are a list under the input").toBeGreaterThan(field.y + 40);
  await form.getByRole("option").first().click();
  const fb = await form.boundingBox();
  for (const name of ["add to page", "cancel"]) {
    const b = await form.getByRole("button", { name }).boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(Math.abs(b.width - (fb.width - 2 * 16)) < 40 || b.width > fb.width * 0.7, `${name} is full width`).toBe(true);
  }
  expect(await noHScroll(page)).toBe(true);
  expect(await axeViolations(page, { include: "[data-hfy-comments]" })).toEqual([]);
});

test("1280 px: the form is inline and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await trigger(li(page, 1)).click();
  await expect(li(page, 1).locator("[data-hfy-grad-form]")).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  expect(await axeViolations(page, { include: "[data-hfy-comments]" })).toEqual([]);
});

test("a member who is not an admin, and the flag off, see no control", async ({ browser }) => {
  for (const cfg of [{ viewer: MEMBER, admin: false, flag: true }, { viewer: ADMIN, admin: true, flag: false }]) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await stub(page, { ...cfg, comments: [comment(1, [photo(1)], { can: { edit: false, delete: false, react: false, moderate: cfg.admin } })] });
    await open(page);
    await expect(li(page, 1).locator("img").first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(thread(page).getByRole("button", { name: "add to a family page…" })).toHaveCount(0);
    await ctx.close();
  }
});

test("graduateV1 alone brings the moderation controls: the hide control sits beside the add control", async ({ page }) => {
  await stub(page, { comments: [comment(1, [photo(1)])] });
  await open(page);
  await expect(li(page, 1).getByRole("button", { name: /^moderate photo/ })).toBeVisible();
  await expect(trigger(li(page, 1))).toBeVisible();
});
