// privacy-guard-existing-paths AC2 and AC11 at 375 px: the R-18 pre-check in the post composer and the comment composer. The span
// is marked, the DS copy sits under the field, submit is disabled and the text is kept; nothing is sent while a hit remains.
// postsV2 on; /api, uploads and /auth/session stubbed by route interception; synthetic data only (555-01xx, example.org).
// HFY_GUARD_SHOTS=<dir> also saves the two error states as <dir>/240-post-composer-error.png and 240-comment-composer-error.png.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = { id: "I9001", label: "Test Person" };
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const CONTACT = "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.";
const DOB = "we only keep the birth year on the site.";
const SHOTS = process.env.HFY_GUARD_SHOTS;

async function stub(page, { dobOn = false } = {}) {
  const s = { postBodies: [], commentBodies: [], comments: [], uploadBodies: [], puts: 0 };
  const post = { id: ULID(1), type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "Seeded older post", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } };
  s.comments.push({ id: ULID(400), threadId: `post:${ULID(1)}`, author: ME, body: "an older comment of mine", created_at: T0, can: { edit: true, delete: true, react: false } });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/person/*.json", (r) => r.fulfill({ json: r.request().url().includes("I9001") ? PERSON : [] }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } }));
  await page.route("**/media/posts/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("https://s3.test/**", (r) => { s.puts += 1; return r.fulfill({ status: 200, body: "" }); });
  await page.route("**/api/uploads", (r) => {
    const b = r.request().postDataJSON();
    s.uploadBodies.push(b);
    return r.fulfill({ status: 201, json: { uploadUrl: "https://s3.test/put/photo.png", publicUrl: `http://127.0.0.1:8089/media/posts/${ULID(900)}/photo.png`, headers: { "Content-Type": b.contentType } } });
  });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    const id = new URL(req.url()).pathname.split("/")[3];
    if (req.method() === "GET" && id) return r.fulfill({ json: post });
    if (req.method() === "GET") return r.fulfill({ json: { items: [post], cursor: null } });
    const b = req.postDataJSON();
    s.postBodies.push(b);
    // the server's DOB switch, as the API answers it (src/guard.js): 422 dob_not_allowed, positions only
    if (dobOn && /birthday/.test(b.body)) return r.fulfill({ status: 422, json: { error: "dob_not_allowed", message: DOB, errors: [{ pointer: "/body", kind: "dob_heuristic", span: [0, 1] }] } });
    return r.fulfill({ status: 201, json: { id: ULID(20), type: "post", author: ME, subject: b.subject, body: b.body, attachments: b.attachments || [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: true, delete: true, publish: false } } });
  });
  await page.route("**/api/comments**", (r) => {
    const req = r.request();
    if (req.method() === "GET") return r.fulfill({ json: { thread: { id: `post:${ULID(1)}`, topic: "comments", comments: s.comments, reactions: {} } } });
    const b = req.postDataJSON();
    s.commentBodies.push(b);
    const c = { id: ULID(500 + s.comments.length), threadId: b.subject, author: ME, body: b.body, created_at: T0, can: { edit: true, delete: true, react: false } };
    s.comments.push(c);
    return r.fulfill({ status: 201, json: c });
  });
  return s;
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** The mark's box lies inside its field's box: the highlight is drawn on the field, not somewhere else on the page. */
async function markInside(mark, field) {
  const [m, f] = await Promise.all([mark.boundingBox(), field.boundingBox()]);
  return m.x >= f.x - 0.5 && m.y >= f.y - 0.5 && m.x + m.width <= f.x + f.width + 0.5 && m.y + m.height <= f.y + f.height + 0.5 && m.width > 4;
}
async function shot(page, locator, name) {
  if (!SHOTS) return;
  await locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, name) });
}

test("post composer: a phone number is marked, the copy shows, post is disabled and the text is kept until it is removed", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  const box = mine.getByRole("textbox").first();
  const submit = mine.getByRole("button", { name: /^post$/i });
  const text = "back from the lake! call me on 555-0142 when you're free";
  await box.fill(text);
  const mark = mine.locator("[data-hfy-guard-mark]");
  await expect(mark).toHaveText("555-0142");
  await expect(mine.locator("[data-hfy-guard-msg]")).toHaveText(CONTACT);
  await expect(submit).toBeDisabled();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  const describedBy = await box.getAttribute("aria-describedby");
  expect(await page.locator(`#${describedBy.split(" ").pop()}`).textContent()).toBe(CONTACT);
  expect(await markInside(mark, box)).toBe(true);
  expect(await noHScroll(page)).toBe(true);
  await shot(page, mine.locator(".hfy-posts__composer"), "240-post-composer-error.png");
  // a forced submit is stopped before the kit sees it, and the span is selected for the member
  await mine.locator("form").evaluate((f) => f.requestSubmit());
  await expect(box).toBeFocused();
  expect(await box.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("555-0142");
  await expect(box).toHaveValue(text); // the text is kept
  expect(s.postBodies).toEqual([]);
  // removing the number lifts the block
  await box.fill("back from the lake! call me when you're free");
  await expect(mark).toHaveCount(0);
  await expect(mine.locator("[data-hfy-guard-msg]")).toHaveCount(0);
  await expect(box).not.toHaveAttribute("aria-invalid", "true");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => s.postBodies.length).toBe(1);
  expect(s.postBodies[0].body).toBe("back from the lake! call me when you're free");
});

test("post composer: a photo's description is checked too, and an emptied box stays disabled by the kit's own rule", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  const box = mine.getByRole("textbox").first();
  const submit = mine.getByRole("button", { name: /^post$/i });
  await box.fill("garden day");
  await mine.locator("input[type=file]").first().setInputFiles({ name: "Jane Example.png", mimeType: "image/png", buffer: PNG });
  await expect.poll(() => s.puts).toBe(1);
  const alt = mine.locator(".iok-content-attachment > input").first();
  await alt.fill("outside 42 Example Street");
  await expect(mine.locator("[data-hfy-guard-mark]")).toHaveText(/42 Example Street/);
  await expect(submit).toBeDisabled();
  await alt.fill("the garden");
  await expect(submit).toBeEnabled();
  await box.fill("");
  await expect(submit).toBeDisabled();
  await box.fill("garden day, again");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => s.postBodies.length).toBe(1);
  // the file's own name is never sent (AC6); the fixed "photo" keeps the API live before the RG-2 change set working
  expect(s.uploadBodies).toEqual([{ filename: "photo", contentType: "image/png", size: PNG.length }]);
  expect(JSON.stringify(s.uploadBodies)).not.toMatch(/Jane|Example\.png/);
  expect(JSON.stringify(s.postBodies[0])).not.toMatch(/Jane|Example\.png/);
});

test("post composer: the server's dob_not_allowed keeps the text, shows the birth-year copy and turns the birthday check on", async ({ page }) => {
  const s = await stub(page, { dobOn: true });
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  const box = mine.getByRole("textbox").first();
  await box.fill("her birthday is May 5th");
  await mine.getByRole("button", { name: /^post$/i }).click();
  await expect(mine.getByRole("alert")).toHaveText(DOB);
  await expect(box).toHaveValue("her birthday is May 5th");
  await expect(mine.locator("[data-hfy-guard-mark]")).toHaveText("May 5th");
  await expect(mine.getByRole("button", { name: /^post$/i })).toBeDisabled();
  expect(s.postBodies).toHaveLength(1);
});

test("comment composer: an email is marked, post is disabled, Enter sends nothing; an edit box is guarded the same way", async ({ page }) => {
  const s = await stub(page);
  await page.goto(`/posts/?id=${ULID(1)}&hfy_flags=postsV2`, { waitUntil: "domcontentloaded" });
  const section = page.locator("[data-hfy-comments]");
  await expect(section.getByText("an older comment of mine")).toBeVisible();
  const box = section.locator(".io-comments-composer textarea").last();
  const submit = section.getByRole("button", { name: /^post$/i });
  await box.fill("so good to see everyone. write to ann@example.org");
  const mark = section.locator("[data-hfy-guard-mark]");
  await expect(mark).toHaveText("ann@example.org");
  await expect(section.locator("[data-hfy-guard-msg]")).toHaveText(CONTACT);
  await expect(submit).toBeDisabled();
  expect(await markInside(mark, box)).toBe(true);
  expect(await noHScroll(page)).toBe(true);
  await shot(page, section.locator(".io-comments-composer").last(), "240-comment-composer-error.png");
  await box.press("Enter");
  await expect(box).toHaveValue("so good to see everyone. write to ann@example.org");
  expect(await box.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("ann@example.org");
  expect(s.commentBodies).toEqual([]);
  await box.fill("so good to see everyone.");
  await expect(submit).toBeEnabled();
  await box.press("Enter");
  await expect.poll(() => s.commentBodies.length).toBe(1);
  // the edit box of an own comment
  await section.getByRole("button", { name: "edit" }).first().click();
  const edit = section.locator(".io-comments-list .io-comments-composer textarea");
  await edit.fill("an older comment of mine. text me on 555-0187");
  await expect(section.locator(".io-comments-list [data-hfy-guard-mark]")).toHaveText("555-0187");
  await expect(section.getByRole("button", { name: "save" })).toBeDisabled();
  await edit.fill("an older comment of mine, edited");
  await expect(section.getByRole("button", { name: "save" })).toBeEnabled();
});
