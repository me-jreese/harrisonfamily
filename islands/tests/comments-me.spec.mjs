// HFY-TSK-298: the comments island takes moderator rights only from the shared GET /api/me (admin, or can.moderate when present); a 401 or
// a failure means not a moderator. Each delete control still follows that comment's server-computed can.delete (the kit gates it).
// Viewers: member, author, admin, signed out, /api/me failure. /auth/session, /api/me, /api/comments and the person JSON are stubbed by
// route interception; synthetic data only.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/comments-me.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const ME = { id: "I9002", label: "Sam Example" };
const ANN = { id: "I9003", label: "Ann Other" };
const OLIVE = { id: "I9004", label: "Olive Other" };
const T0 = "2026-01-01T00:00:00.000Z";
const URL_ = "/person/?id=I9001&hfy_flags=personV2";
const mk = (n, author, body, can) => ({ id: `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, "0")}`, threadId: "person:I9001", author, body, created_at: T0, can });

// The server's can.* per comment. ANN_OPEN carries can.delete true for this viewer: the old island turned exactly that into admin rights.
const ANN_OPEN = mk(1, ANN, "A synthetic comment the server lets this viewer delete.", { edit: false, delete: true, react: true });
const OLIVE_SHUT = mk(2, OLIVE, "A synthetic comment nobody here may delete.", { edit: false, delete: false, react: true });
const MINE = mk(3, ME, "Mine to delete.", { edit: true, delete: true, react: false });
const MINE_SHUT = mk(4, ME, "Mine, but the server says no delete.", { edit: false, delete: false, react: false });

const MEMBER = { id: ME.id, label: ME.label, admin: false, can: { moderate: false, graduate: false, approve: false } };
const ADMIN = { id: ME.id, label: ME.label, admin: true, can: { moderate: true, graduate: true, approve: true } };

/** `me`: a JSON body (200), a number (that status), or "abort" (network failure). */
async function stub(page, { signedIn = true, me = MEMBER, comments = [ANN_OPEN, OLIVE_SHUT, MINE] } = {}) {
  const s = { me: [], deletes: [], cookies: [] };
  let meAnswered;
  const meDone = new Promise((res) => { meAnswered = res; });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/person/*.json", (r) => (r.request().url().includes("I9001") ? r.fallback() : r.fulfill({ json: [] })));
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", async (r) => {
    s.me.push(r.request().method());
    s.cookies.push((await r.request().allHeaders()).cookie || "");
    try {
      if (me === "abort") return await r.abort("failed");
      if (typeof me === "number") return await r.fulfill({ status: me, json: { error: me === 401 ? "unauthenticated" : "server" } });
      return await r.fulfill({ json: me });
    } finally { meAnswered(); }
  });
  await page.route("**/api/comments**", async (r) => {
    const req = r.request();
    if (req.method() === "DELETE") { s.deletes.push(new URL(req.url())); return r.fulfill({ status: 204, body: "" }); }
    // Render the thread only after /api/me has answered, so an absent control is a decision, not a race (bounded: a build that never
    // asks still renders, and fails on the assertions instead of hanging).
    if (signedIn) await Promise.race([meDone, new Promise((res) => setTimeout(res, 2000))]);
    return r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments, reactions: {} } } });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9002", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() }));
  });
  return s;
}

const thread = (page) => page.locator("[data-hfy-comments]");
const item = (page, c) => thread(page).locator(".io-comments-list > li", { hasText: c.body });
const plainDelete = (loc) => loc.locator(".io-comments-actions > .io-comments-control", { hasText: /^delete$/ });
const moderate = (loc) => loc.locator(".io-comments-moderation");
/** Let React apply any state the /api/me answer causes before checking that a control is absent. */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 150))));

async function open(page, s) {
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await expect(item(page, MINE)).toBeVisible();
  await expect.poll(() => s.me.length).toBe(1);
  await settle(page);
}

// ------------------------------------------------------------------------------------------------------------- member
test("member: /api/me admin false gives no moderate control, even on a comment whose can.delete is true", async ({ page }) => {
  const s = await stub(page, { me: MEMBER });
  await open(page, s);
  await expect(moderate(thread(page))).toHaveCount(0);
  await expect(thread(page).getByText("delete as moderator")).toHaveCount(0);
  // another member's comment: no delete of any kind (the kit offers the plain delete on own comments only)
  await expect(plainDelete(item(page, ANN_OPEN))).toHaveCount(0);
  await expect(plainDelete(item(page, OLIVE_SHUT))).toHaveCount(0);
  // the member's own comment is unchanged: edit and delete
  await expect(plainDelete(item(page, MINE))).toHaveCount(1);
  await expect(item(page, MINE).getByRole("button", { name: "edit", exact: true })).toBeVisible();
  expect(s.me).toEqual(["GET"]);
});

// ------------------------------------------------------------------------------------------------------------- author
test("author: the own delete follows that comment's can.delete; it still asks first and sends the DELETE", async ({ page }) => {
  const s = await stub(page, { me: MEMBER, comments: [ANN_OPEN, MINE, MINE_SHUT] });
  await open(page, s);
  await expect(plainDelete(item(page, MINE_SHUT))).toHaveCount(0);
  await expect(moderate(item(page, MINE_SHUT))).toHaveCount(0);
  await expect(moderate(item(page, MINE))).toHaveCount(0);
  const mine = item(page, MINE);
  await plainDelete(mine).click();
  const ask = mine.getByRole("group", { name: "delete this comment?" });
  await expect(ask).toBeVisible();
  expect(s.deletes).toEqual([]);
  await ask.getByRole("button", { name: "delete", exact: true }).click();
  await expect.poll(() => s.deletes.length).toBe(1);
  expect(s.deletes[0].pathname).toBe(`/api/comments/${MINE.id}`);
  expect(s.deletes[0].searchParams.get("subject")).toBe("person:I9001");
  expect(s.deletes[0].searchParams.has("reason")).toBe(false);
});

// ------------------------------------------------------------------------------------------------------------- admin
test("admin: /api/me admin true gives moderate on others' comments whose can.delete is true, and only there", async ({ page }) => {
  const s = await stub(page, { me: ADMIN, comments: [ANN_OPEN, OLIVE_SHUT, MINE] });
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  const ann = item(page, ANN_OPEN);
  await expect(moderate(ann)).toHaveCount(1);
  await settle(page);
  // per-comment can.delete still gates it: no moderate where the server said no, none on the admin's own comment
  await expect(moderate(item(page, OLIVE_SHUT))).toHaveCount(0);
  await expect(moderate(item(page, MINE))).toHaveCount(0);
  await expect(plainDelete(item(page, MINE))).toHaveCount(1);
  await expect(plainDelete(ann)).toHaveCount(0);
  // the two-step moderator delete sends the reason
  await ann.locator(".io-comments-moderation > summary").click();
  await ann.getByRole("textbox", { name: "reason" }).fill("synthetic reason");
  await ann.getByRole("button", { name: "delete as moderator" }).click();
  await expect.poll(() => s.deletes.length).toBe(1);
  expect(s.deletes[0].pathname).toBe(`/api/comments/${ANN_OPEN.id}`);
  expect(s.deletes[0].searchParams.get("reason")).toBe("synthetic reason");
  expect(s.me).toEqual(["GET"]);
});

for (const [name, me, shows] of [
  ["admin true without can: admin decides", { id: ME.id, label: ME.label, admin: true }, true],
  ["admin true, can.moderate false: can.moderate decides", { id: ME.id, label: ME.label, admin: true, can: { moderate: false } }, false],
]) {
  test(`admin: ${name}`, async ({ page }) => {
    const s = await stub(page, { me });
    await open(page, s);
    await expect(moderate(item(page, ANN_OPEN))).toHaveCount(shows ? 1 : 0);
  });
}

// ------------------------------------------------------------------------------------------------------------- signed out
test("signed out: the sign-in line, no thread and no GET /api/me", async ({ page }) => {
  const s = await stub(page, { signedIn: false, me: ADMIN });
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await expect(thread(page).locator("[data-hfy-signin]")).toContainText("sign in to leave a comment.");
  await settle(page);
  await page.waitForTimeout(300);
  await expect(thread(page).locator(".io-comments")).toHaveCount(0);
  expect(s.me).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------- /api/me failure
for (const [name, me] of [["a 401", 401], ["a 500", 500], ["a network failure", "abort"]]) {
  test(`/api/me failure (${name}): not a moderator, even where can.delete is true; the own delete still works`, async ({ page }) => {
    const s = await stub(page, { me });
    await open(page, s);
    await expect(moderate(thread(page))).toHaveCount(0);
    await expect(plainDelete(item(page, ANN_OPEN))).toHaveCount(0);
    const mine = item(page, MINE);
    await plainDelete(mine).click();
    await mine.getByRole("group", { name: "delete this comment?" }).getByRole("button", { name: "delete", exact: true }).click();
    await expect.poll(() => s.deletes.length).toBe(1);
    expect(s.deletes[0].pathname).toBe(`/api/comments/${MINE.id}`);
    expect(s.me).toEqual(["GET"]); // one call, not retried
  });
}

// ------------------------------------------------------------------------------------------------------------- shared call
test("one GET /api/me per page, with the same-origin session cookie", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "hfy_synthetic", value: "synthetic", url: baseURL }]);
  const s = await stub(page, { me: ADMIN });
  await open(page, s);
  await expect(moderate(item(page, ANN_OPEN))).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(s.me).toEqual(["GET"]);
  expect(s.cookies[0]).toContain("hfy_synthetic=synthetic");
});
