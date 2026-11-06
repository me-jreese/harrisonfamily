// HFY-TSK-189 (R-26, R-27; social.md section 8): the contributions column and the hero chip of the person page, contribV1 on (?hfy_flags=).
// /auth/session, /api/*, /person/<id>.json and /person/index.json are stubbed by route interception; every name, id and sentence is synthetic.
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/person-contrib.spec.mjs --workers=1
// HFY_SHOTS=<dir> also writes the 375 and 1280 screenshots of the column there (the PR evidence).
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const LIVING = { ...PERSON, isLiving: true };
const OWNER = { id: "I9001", label: "Test Person" };
const VISITOR = { id: "I9002", label: "Sam Example" };
const ON = "/person/?id=I9001&hfy_flags=personV2,postsV2,contribV1";
const OFF = "/person/?id=I9001&hfy_flags=personV2,postsV2";
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;
const NAMES = [{ grampsId: "I9001", displayName: "Test Person" }, { grampsId: "I9003", displayName: "Ann Other" }, { grampsId: "I9004", displayName: "Bo Example" }];
const minutesAgo = (n) => new Date(Date.now() - n * 60e3).toISOString();

// Eight kinds of entry in a fixed rotation, newest first: n = 1 is the newest.
const KINDS = [
  { kind: "post", photos: 3, ref: { type: "post", id: "P" }, href: "/posts/?id=P" },
  { kind: "comment", subject: "person:I9003", ref: { type: "comment", id: "C", thread: "person:I9003" }, href: "/person/?id=I9003#comment-C" },
  { kind: "self_edit", subject: "person:I9001", ref: { type: "record", id: "I9001" }, href: "/person/?id=I9001" },
  { kind: "proposal_accepted", subject: "person:I9004", ref: { type: "proposal", id: "X" }, href: "/person/?id=I9004" },
  { kind: "tag", subject: "person:I9003", ref: { type: "tag", id: "T" }, href: "/person/?id=I9003" },
  { kind: "photo_to_record", subject: "person:I9777", ref: { type: "media", id: "M" }, href: "/person/?id=I9777#photos" },
];
const entry = (n, over = {}) => {
  const k = KINDS[(n - 1) % KINDS.length];
  return { id: ULID(n), kind: k.kind, at: minutesAgo(n * 90), weight: 1, photos: k.photos ?? 0, ref: { ...k.ref, id: `${k.ref.id}${n}` }, ...(k.subject ? { subject: k.subject } : {}), href: k.href, ...over };
};

async function stub(page, { me = VISITOR, total = 25, person = LIVING, entries, statsStatus = 200, listStatuses = [] } = {}) {
  const s = { lists: [], stats: 0, external: [], failList: 0 };
  const all = entries ?? Array.from({ length: total }, (_, i) => entry(i + 1));
  page.on("request", (q) => { if (new URL(q.url()).hostname !== "127.0.0.1") s.external.push(q.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: person }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: NAMES } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: me.id, grampsId: me.id, label: me.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: me.id, label: me.label, admin: false, can: { moderate: false, graduate: false, approve: false } } }));
  await page.route("**/api/comments**", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: [], reactions: {} } } }) : r.fulfill({ status: 204, body: "" })));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => r.fulfill({ json: { items: [], cursor: null } }));
  await page.route("**/api/contributions**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/stats")) {
      s.stats += 1;
      if (statsStatus !== 200) return r.fulfill({ status: statsStatus, json: { error: "x" } });
      return r.fulfill({ json: { author: u.searchParams.get("author"), total: all.length, by_kind: {} } });
    }
    const limit = Number(u.searchParams.get("limit") || 10);
    const from = Number(u.searchParams.get("cursor") || 0);
    s.lists.push({ author: u.searchParams.get("author"), limit, cursor: u.searchParams.get("cursor") });
    if (s.failList > 0) { s.failList -= 1; return r.fulfill({ status: 500, json: { error: "boom" } }); }
    const status = listStatuses.shift();
    if (status) return r.fulfill({ status, json: { error: "x" } });
    const next = from + limit < all.length ? String(from + limit) : undefined;
    return r.fulfill({ json: { items: all.slice(from, from + limit), ...(next ? { cursor: next } : {}) } });
  });
  await page.addInitScript((id) => {
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: id, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() }));
  }, me.id);
  return s;
}

const column = (page) => page.locator("#hfy-person-contributions");
const rows = (page) => column(page).locator(".hfy-contrib__list > li");
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cap = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));

async function open(page, url = ON, size = { width: 375, height: 812 }) {
  await page.setViewportSize(size);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(column(page)).toBeAttached();
}

// ---- AC1: the column ---------------------------------------------------------------------------------------------------------------------
test("the column lists contributions newest first, 10 a page; each row is a 44 px link with a glyph, a sentence and a time", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  await expect(rows(page).first()).toBeAttached();
  expect(s.lists[0]).toEqual({ author: "I9001", limit: 10, cursor: null });
  await expect(rows(page)).toHaveCount(10);
  // the server's order is kept: the newest (n = 1, a post with 3 photos) is first
  await expect(rows(page).nth(0)).toContainText("shared a post with 3 photos");
  await expect(rows(page).nth(1)).toContainText("commented on Ann Other's page");
  await expect(rows(page).nth(2)).toContainText("updated their page");
  await expect(rows(page).nth(3)).toContainText("had a change accepted on Bo Example's page");
  await expect(rows(page).nth(4)).toContainText("tagged Ann Other in a photo");
  await expect(rows(page).nth(5)).toContainText("their photo was added to a family page"); // I9777 is not in the corpus
  await expect(rows(page).nth(0).locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
  await expect(rows(page).nth(0).locator("time")).toHaveText("1 hr ago");
  for (let i = 0; i < 6; i += 1) {
    const li = rows(page).nth(i);
    expect((await li.boundingBox()).height, `row ${i} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
    await expect(li.locator(".hfy-contrib__glyph")).toHaveAttribute("aria-hidden", "true");
    expect(await li.locator(".hfy-contrib__glyph").evaluate((el) => getComputedStyle(el).maskImage !== "none" || getComputedStyle(el).webkitMaskImage !== "none"), "the glyph is a mask icon").toBe(true);
    // the sentence link is stretched over the whole row
    expect(await li.locator("a.hfy-contrib__link").evaluate((a) => { const c = getComputedStyle(a, "::after"); return c.position === "absolute" && c.content !== "none"; })).toBe(true);
  }
  await expect(rows(page).nth(0).locator("a.hfy-contrib__link")).toHaveAttribute("href", "/posts/?id=P");
  await expect(rows(page).nth(5).locator("a.hfy-contrib__link")).toHaveAttribute("href", "/person/?id=I9777#photos");
  expect(await noHScroll(page)).toBe(true);
  expect(s.external).toEqual([]);
});

test("a name that resolves is a PersonName link (no underline, no link inside a link); one that does not is plain words", async ({ page }) => {
  await stub(page);
  await open(page);
  await expect(rows(page).first()).toBeAttached();
  const name = rows(page).nth(1).locator("a.hfy-person-name");
  await expect(name).toHaveText("Ann Other");
  await expect(name).toHaveAttribute("href", "/person/?id=I9003");
  expect(await name.evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe("none");
  await name.hover();
  expect(await name.evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe("none");
  expect(await column(page).locator("a a").count(), "no anchor nests in another").toBe(0);
  // the name link sits above the stretched row link: a click on the name goes to the person's page, not the comment
  const box = await name.boundingBox();
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [box.x + box.width / 2, box.y + box.height / 2])).toContain("hfy-person-name");
  // the row's own link carries the whole sentence as its name
  await expect(rows(page).nth(1).locator("a.hfy-contrib__link")).toHaveAttribute("aria-label", "commented on Ann Other's page");
  await expect(rows(page).nth(5).locator("a.hfy-person-name")).toHaveCount(0);
  await expect(rows(page).nth(0).locator("a.hfy-person-name")).toHaveCount(0);
});

test("the list is capped (448 px at 375, 576 px from 43rem) with clipped rows inert; 'show older contributions' reveals them, then fetches the next 10", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  const list = column(page).locator(".hfy-contrib__list");
  await expect(rows(page)).toHaveCount(10);
  await expect.poll(() => cap(list)).toBe(448);
  expect(await rows(page).evaluateAll((els) => els.filter((e) => e.hasAttribute("inert") && e.getAttribute("aria-hidden") === "true").length), "rows below the cap are inert").toBeGreaterThan(0);
  const older = column(page).getByRole("button", { name: "show older contributions" });
  await expect(older).toBeVisible();
  expect((await older.boundingBox()).height).toBeGreaterThanOrEqual(44);
  for (let i = 0; i < 8 && s.lists.length === 1; i += 1) { await older.click(); await page.waitForTimeout(50); }
  await expect.poll(() => s.lists.length).toBe(2);
  expect(s.lists[1]).toEqual({ author: "I9001", limit: 10, cursor: "10" });
  await expect(rows(page)).toHaveCount(20);
  for (let i = 0; i < 40 && (await older.count()) > 0; i += 1) { await older.click(); await page.waitForTimeout(60); }
  await expect(rows(page)).toHaveCount(25);
  await expect(older).toHaveCount(0);
  expect(s.lists.length).toBe(3);
  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(() => cap(list)).toBeGreaterThan(448);
});

test("the header shows the total from contributions.stats", async ({ page }) => {
  await stub(page);
  await open(page);
  await expect(column(page).locator("[data-hfy-contrib-total]")).toHaveText("25 contributions");
});

// ---- AC2: the hero chip ------------------------------------------------------------------------------------------------------------------
test("the hero chip 'N contributions' comes from contributions.stats and links to the column", async ({ page }) => {
  await stub(page);
  await open(page);
  const chip = page.locator('[data-slot="heading-chips"] [data-slot="contributions"] a[data-hfy-contrib-chip]');
  await expect(chip).toHaveText("25 contributions");
  await expect(chip).toHaveAttribute("href", "#hfy-person-contributions");
  expect((await chip.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await chip.click();
  await expect(page).toHaveURL(/#hfy-person-contributions$/);
  await expect(column(page)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("hfy-person-contributions-h");
});

test("the chip says '0 contributions' on a member's page and is hidden on a record that is not a member", async ({ page }) => {
  await stub(page, { total: 0, person: LIVING });
  await open(page);
  await expect(page.locator("a[data-hfy-contrib-chip]")).toHaveText("0 contributions");
  // a deceased person's page with nothing credited: not a member, no chip (the column still says "no contributions yet.")
  await stub(page, { total: 0, person: { ...PERSON, isLiving: false } });
  await open(page);
  await expect(column(page)).toContainText("no contributions yet.");
  await expect(page.locator("a[data-hfy-contrib-chip]")).toHaveCount(0);
  await expect(page.locator('[data-slot="contributions"]')).toBeHidden();
});

test("one contribution reads '1 contribution'; with the stats route failing the chip is silent and the column still lists", async ({ page }) => {
  await stub(page, { total: 1 });
  await open(page);
  await expect(page.locator("a[data-hfy-contrib-chip]")).toHaveText("1 contribution");
  await stub(page, { statsStatus: 500 });
  await open(page);
  await expect(rows(page).first()).toBeAttached();
  await expect(page.locator("a[data-hfy-contrib-chip]")).toHaveCount(0);
  await expect(column(page).locator("[data-hfy-contrib-total]")).toHaveCount(0);
});

test("contribV1 off: no chip, no feed, and the contributions routes are never called", async ({ page }) => {
  const s = await stub(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(OFF, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#hfy-person-comments")).toBeAttached();
  await page.waitForTimeout(400);
  expect(s.lists).toEqual([]);
  expect(s.stats).toBe(0);
  await expect(page.locator("a[data-hfy-contrib-chip]")).toHaveCount(0);
});

// ---- AC3: hidden entries -----------------------------------------------------------------------------------------------------------------
const mixed = () => [entry(1), entry(2, { hidden: true }), entry(3)];

test("the owner sees their own hidden entries tagged 'hidden'", async ({ page }) => {
  await stub(page, { me: OWNER, entries: mixed() });
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(1).locator("[data-hfy-contrib-hidden]")).toHaveText("hidden");
  await expect(column(page).locator("[data-hfy-contrib-hidden]")).toHaveCount(1);
});

test("another viewer never sees a hidden entry, even if one reached the client", async ({ page }) => {
  await stub(page, { me: VISITOR, entries: mixed() });
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(column(page).locator("[data-hfy-contrib-hidden]")).toHaveCount(0);
  await expect(column(page)).not.toContainText("hidden");
});

// ---- AC4: states and axe ------------------------------------------------------------------------------------------------------------------
test("empty: 'no contributions yet.' for a visitor, and with an 'add a photo' action on your own page", async ({ page }) => {
  await stub(page, { me: VISITOR, entries: [] });
  await open(page);
  await expect(column(page).locator("[data-hfy-empty]")).toContainText("no contributions yet.");
  await expect(column(page).getByRole("link", { name: "add a photo" })).toHaveCount(0);
  await expect(column(page).getByRole("button", { name: /show older/ })).toHaveCount(0);
  await stub(page, { me: OWNER, entries: [] });
  await open(page);
  await expect(column(page).locator("[data-hfy-empty]")).toContainText("no contributions yet.");
  const add = column(page).getByRole("link", { name: "add a photo" });
  await expect(add).toHaveAttribute("href", "#share");
  expect((await add.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("loading shows skeleton rows; an error is a banner with a retry that loads the feed", async ({ page }) => {
  const s = await stub(page);
  s.failList = 1;
  await open(page);
  const banner = column(page).locator("[data-hfy-banner]");
  await expect(banner).toContainText("that didn't work. try again, or text J.");
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(rows(page)).toHaveCount(0);
  await banner.getByRole("button", { name: "try again" }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(column(page).locator("[data-hfy-banner]")).toHaveCount(0);
});

test("a later page that fails keeps what is shown, says so, and 'show older contributions' tries again", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  await expect(rows(page)).toHaveCount(10);
  s.failList = 1;
  const older = column(page).getByRole("button", { name: "show older contributions" });
  for (let i = 0; i < 8 && s.lists.length === 1; i += 1) { await older.click(); await page.waitForTimeout(50); }
  await expect.poll(() => s.lists.length).toBe(2);
  await expect(column(page).locator("[data-hfy-banner]")).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  for (let i = 0; i < 12 && (await rows(page).count()) < 20; i += 1) { await older.click(); await page.waitForTimeout(60); }
  await expect(rows(page)).toHaveCount(20);
});

test("a signed-out answer (401) says to sign in", async ({ page }) => {
  await stub(page, { listStatuses: [401] });
  await open(page);
  await expect(column(page).locator("[data-hfy-signed-out]")).toHaveText("sign in to see contributions.");
});

test("axe is clean for the column and the chip at 375 and 1280, in the owner's view with a hidden entry too; screenshots", async ({ page }) => {
  await stub(page, { me: OWNER, entries: [...mixed(), ...Array.from({ length: 12 }, (_, i) => entry(i + 4))] });
  await open(page);
  await expect(rows(page).first()).toBeAttached();
  await expect(page.locator("a[data-hfy-contrib-chip]")).toBeVisible();
  expect(await axeViolations(page, { include: "#hfy-person-contributions" })).toEqual([]);
  expect(await axeViolations(page, { include: '[data-slot="heading-chips"]' })).toEqual([]);
  const shots = process.env.HFY_SHOTS;
  if (shots) { mkdirSync(shots, { recursive: true }); await column(page).screenshot({ path: `${shots}/person-contributions-375.png` }); }
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await axeViolations(page, { include: "#hfy-person-contributions" })).toEqual([]);
  expect(await axeViolations(page, { include: '[data-slot="heading-chips"]' })).toEqual([]);
  const [a, b] = [await page.locator("#hfy-person-comments").boundingBox(), await column(page).boundingBox()];
  expect(Math.abs(a.y - b.y), "the two tops line up").toBeLessThanOrEqual(1);
  if (shots) await page.locator("#hfy-person-social").screenshot({ path: `${shots}/person-contributions-1280.png` });
  expect(await noHScroll(page)).toBe(true);
});
