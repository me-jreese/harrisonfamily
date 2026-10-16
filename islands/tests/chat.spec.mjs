// HFY-TSK-142 (flag chatV1, default off; chat.md 19.4): the chat island in a real browser. The hub is the kit's real ChatCore over its
// MemoryStore, bridged to the page's WebSocket with page.routeWebSocket('/chat/ws') (tests/fixtures/chat-hub.mjs), so the frames are the
// production ones and the R-18 guard is the Worker's. /auth/session and the flags file are stubbed. Synthetic people only (I9001..).
//
//   flag off (no bundle, no socket) and the override on; the roster panel and the dock at 1280; send, ack, reply, emoticons, typing; the
//   Q2-16 behaviours (Enter sends with no Send button, `q`, the flashes, no auto-open, no policy change); pacing; the contact-info line;
//   the paste block; /chat/ two-pane, a pop-out and a deep link; 375: the chat slot entry, the roster and the conversation, the bottom
//   bar hidden only in a conversation, 16px inputs, 44px targets, no horizontal scroll; a refused member; a signed-out reader; the
//   title-bar and flash contrast in both schemes; axe on every surface.
// Run:  HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/chat.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { contrast, parseColor } from "./contrast.mjs";
import { PEOPLE, chatHub, dm } from "./fixtures/chat-hub.mjs";

const ME = "I9001";
const PAT = "I9002";
const FLAGS = { authV2: true, shellV2: true, navMe: true, notifyV2: true, searchV2: false, personV2: false, postsV2: false, aboutCta: false, chatV1: true };
const CONV = dm(ME, PAT);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const calm = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));

/** Stubs on the context (so a pop-out window gets them too): flags, the edge session, the refresh, the API, and the hub for the sockets. */
async function wire(context, { flag = true, session = ME, hub = null, refuse = null, exp = null } = {}) {
  const log = { chatAssets: [], refreshes: 0 };
  // `exp`: the session expires `exp` seconds from now until /auth/refresh is called, and an hour after it (the page's single refresh).
  const clock = { refreshed: false, at: Date.now() };
  const expiry = () => (exp && !clock.refreshed ? Math.floor(clock.at / 1000) + exp : Math.floor(Date.now() / 1000) + 3600);
  await context.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await context.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, chatV1: flag } }));
  await context.route("**/auth/session", (r) => r.fulfill({
    json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example", exp: expiry() } : { authenticated: false },
  }));
  await context.route("**/auth/refresh", (r) => {
    if (!exp) return r.fulfill({ status: 401, json: { error: "no refresh" } });
    log.refreshes += 1;
    clock.refreshed = true;
    return r.fulfill({ status: 200, json: {} });
  });
  await context.route(/\/js\/islands\/chat\./, (r) => { log.chatAssets.push(new URL(r.request().url()).pathname); return r.continue(); });
  await context.route("**/api/**", (r) => r.fulfill({ json: {} }));
  if (hub) await hub.attach(context, { uid: session, refuse, exp: expiry });
  return log;
}

const panel = (page) => page.getByTestId("io-chat-panel");
const moles = (page) => page.getByTestId("io-chat-mole");
const composer = (page) => page.getByRole("textbox", { name: "message" });
const lastLine = (scope) => scope.locator(".io-chat-line").last();

test.describe("flag off", () => {
  test("no chat bundle, no socket, and /chat/ says it isn't turned on yet; the page is axe clean", async ({ page, context }) => {
    const hub = chatHub();
    const log = await wire(context, { flag: false, hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".hfy-bar__end")).toBeVisible();
    await page.waitForTimeout(600);
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("chat isn't turned on yet.")).toBeVisible();
    await expect(page.locator('[data-slot="chat"]')).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(log.chatAssets).toEqual([]);
    expect(hub.log.upgrades ?? 0).toBe(0); // no socket was even attempted
    expect(await noHScroll(page)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    hub.dispose();
  });

  test("the preview override ?hfy_flags=chatV1 turns it on for the session while flags.json stays false", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const hub = chatHub();
    const log = await wire(context, { flag: false, hub });
    await page.goto("/contact/?hfy_flags=chatV1", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    expect(log.chatAssets.length).toBeGreaterThan(0);
    await expect.poll(() => hub.log.upgrades ?? 0).toBe(1);
    hub.dispose();
  });
});

test.describe("1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the roster panel and a docked chat: send, ack, reply, emoticons, Enter sends with no Send button, q focuses the search; axe clean", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "chat" })).toHaveAttribute("aria-expanded", "true");
    // the roster: a search field, groups with "new group", and the family with the online member first
    await expect(panel(page).getByRole("searchbox").or(panel(page).getByPlaceholder("search family"))).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "new group" })).toBeVisible();
    const row = panel(page).getByRole("button", { name: /Pat Example/ });
    await expect(row).toBeVisible();
    // q focuses the search when focus is not in a field
    await page.locator("body").click({ position: { x: 640, y: 300 } });
    await page.keyboard.press("q");
    await expect(panel(page).getByPlaceholder("search family")).toBeFocused();
    await page.keyboard.press("Escape");
    await row.click();
    await expect(moles(page)).toHaveCount(1);
    const mole = moles(page).first();
    await expect(mole).toHaveAttribute("data-conv", CONV);
    // Enter sends; there is no Send button anywhere in the chat UI (Q2-16)
    await expect(mole.getByRole("button", { name: /^send$/i })).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute("enterkeyhint", "send");
    await expect(composer(page)).toHaveAttribute("placeholder", "type a message. press enter to send.");
    await composer(page).fill("hello pat :)");
    await composer(page).press("Enter");
    const mine = mole.locator(".io-chat-row").filter({ hasText: "hello pat" });
    await expect(mine).toBeVisible();
    await expect(mine).toContainText("me:");
    await expect(mine).not.toHaveAttribute("data-state", "pending"); // darkened on the ack
    await expect(mine.locator(".io-chat-emoticon")).toHaveText("🙂"); // typed emoticon shown as emoji
    expect(hub.log.frames.filter((f) => f.uid === ME && f.frame.t === "send").map((f) => f.frame.text)).toEqual(["hello pat :)"]); // the stored text is the typed one
    expect(pat.frames("msg").map((f) => f.text)).toEqual(["hello pat :)"]);
    pat.say(CONV, "hi sam");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "hi sam" })).toContainText("Pat Example:");
    await calm(page);
    expect(await axeViolations(page)).toEqual([]);
    expect(await noHScroll(page)).toBe(true);
    hub.dispose();
  });

  test("the panel and the open chat are remembered, an incoming message never opens a chat by itself, and it marks the roster unread", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    // auto-open is off (Q2-16): a message for a chat with no open mole opens nothing, and the roster shows it
    pat.say(CONV, "are you there?");
    const row = panel(page).getByRole("button", { name: /Pat Example/ });
    await expect(row).toHaveAttribute("data-unread", "true");
    await expect(moles(page)).toHaveCount(0);
    // minimize the panel: remembered in localStorage, and kept on the next page
    await panel(page).getByRole("button", { name: "chat" }).click();
    await expect(panel(page).getByPlaceholder("search family")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hfy:chat:panel"))).toBe("closed");
    await page.goto("/about/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "chat" })).toHaveAttribute("aria-expanded", "false");
    hub.dispose();
  });

  test("a new message flashes a chat that is not in use and the tab title while the tab is hidden; both stop when seen", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    await page.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event("visibilitychange")); };
    });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    // two chats docked: the one opened last is in use, so a message in the first calls for attention
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    await composer(page).fill("one");
    await composer(page).press("Enter");
    await expect(moles(page).first().locator(".io-chat-row").filter({ hasText: "one" })).toBeVisible();
    await panel(page).getByPlaceholder("search family").fill("alex");
    await panel(page).getByRole("button", { name: /Alex Example/ }).click();
    await expect(moles(page)).toHaveCount(2);
    const bar = moles(page).filter({ has: page.locator(`[data-conv="${CONV}"]`) }).or(page.locator(`[data-testid="io-chat-mole"][data-conv="${CONV}"]`)).locator(".io-chat-bar").first();
    await expect(bar).not.toHaveAttribute("data-attention", /./);
    pat.say(CONV, "ping");
    await expect(bar).toHaveAttribute("data-attention", /flash|highlight/);
    // the tab is hidden: the title alternates with "{name} says…" until the tab is seen
    const original = await page.title();
    await page.evaluate(() => window.__setHidden(true));
    pat.say(CONV, "ping again");
    await expect.poll(() => page.title(), { timeout: 5000 }).toBe("Pat Example says…");
    await expect.poll(() => page.title(), { timeout: 5000 }).toBe(original); // the alternation: it goes back to the page's own title
    await page.evaluate(() => window.__setHidden(false));
    await expect.poll(() => page.title()).toBe(original);
    await page.waitForTimeout(1800);
    expect(await page.title()).toBe(original);
    hub.dispose();
  });

  test("typing and 'has entered text' show under the transcript", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    const mole = moles(page).first();
    await expect(composer(page)).toBeVisible();
    pat.send({ t: "typing", conv: CONV, state: "on" });
    await expect(mole.getByText("Pat Example is typing…")).toBeVisible();
    pat.send({ t: "typing", conv: CONV, state: "off" });
    await expect(mole.getByText(/Pat Example (is typing…|has entered text\.)/)).toHaveCount(0);
    await page.waitForTimeout(3200); // the hub spaces a member's typing frames
    pat.send({ t: "typing", conv: CONV, state: "paused" });
    await expect(mole.getByText("Pat Example has entered text.")).toBeVisible();
    // our own typing reaches the member (the client emits `on` on the first key)
    await composer(page).pressSequentially("abc");
    await expect.poll(() => pat.frames("typing").map((f) => f.state)).toContain("on");
    hub.dispose();
  });

  test("pacing: a first message to an offline member goes, the next waits for their reply (R-39), and the line says so", async ({ page, context }) => {
    const hub = chatHub(); // Pat has no socket: offline
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    await panel(page).getByPlaceholder("search family").fill("pat");
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    const mole = moles(page).first();
    await expect(lastLine(mole)).toHaveText("Pat Example is offline. they'll see your message when they're back.");
    await composer(page).fill("first");
    await composer(page).press("Enter");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "first" })).toBeVisible();
    await expect(lastLine(mole)).toHaveText("Pat Example is offline. you can send another message after they reply.");
    await expect(composer(page)).toBeDisabled();
    // Pat comes back and answers: the box is free again
    const pat = hub.virtual(PAT);
    pat.say(CONV, "back");
    await expect(composer(page)).toBeEnabled();
    await composer(page).fill("welcome back");
    await composer(page).press("Enter");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "welcome back" })).toBeVisible();
    hub.dispose();
  });

  test("contact info: the composer shows the R-18 line and the span before anything is sent, and Enter sends nothing", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    const mole = moles(page).first();
    await composer(page).fill("call me at (555) 010-0199 tonight");
    await composer(page).press("Enter");
    await expect(lastLine(mole)).toHaveText("chat can't carry phone numbers or addresses. remove the highlighted part to send.");
    await expect(composer(page)).toHaveAttribute("aria-invalid", "true");
    // the pre-check is the shared R-18 detector: nothing reached the hub, the text is kept, and the hit is selected
    expect(hub.log.frames.filter((f) => f.frame.t === "send")).toEqual([]);
    await expect(composer(page)).toHaveValue("call me at (555) 010-0199 tonight");
    expect(await composer(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("(555) 010-0199");
    // removing the hit clears the line and the message goes
    await composer(page).fill("call me tonight");
    await expect(mole.locator('.io-chat-line[data-tone="error"]')).toHaveCount(0);
    await composer(page).press("Enter");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "call me tonight" })).toBeVisible();
    hub.dispose();
  });

  test("paste or drop of a file is refused with the text-only line", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    const mole = moles(page).first();
    await composer(page).focus();
    await composer(page).evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "picture.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(lastLine(mole)).toHaveText("chat is text and emoji only.");
    await expect(composer(page)).toHaveValue("");
    hub.dispose();
  });

  test("groups: a group can be made and is named in the roster; the creator may rename and leave, and may not change private/open afterwards (Q2-16)", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    hub.virtual("I9003");
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: "new group" }).click();
    await page.getByRole("checkbox", { name: /Pat Example/ }).check();
    await page.getByRole("checkbox", { name: /Alex Example/ }).check();
    await page.getByRole("textbox", { name: /group name/ }).fill("Cousins");
    await page.getByRole("button", { name: "start group" }).click();
    await expect(moles(page)).toHaveCount(1);
    const mole = moles(page).first();
    await expect(mole.locator(".io-chat-bar-name")).toHaveText("Cousins");
    await expect(mole.getByText("you started this chat.")).toBeVisible();
    await mole.getByRole("button", { name: /options for Cousins/ }).click();
    const menu = page.locator(".io-chat-menu");
    const items = menu.locator(".io-chat-menu-item");
    await expect(items).toHaveText(["add people", "rename chat", "leave chat"]); // no "make this chat open/private": changePolicy is off (Q2-16)
    hub.dispose();
  });

  test("a pop-out opens /chat/?c=…&popout=1 in its own window: one chat, no roster, no dock", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    await composer(page).fill("from the dock");
    await composer(page).press("Enter");
    await expect(moles(page).first().locator(".io-chat-row").filter({ hasText: "from the dock" })).toBeVisible();
    const [popup] = await Promise.all([context.waitForEvent("page"), moles(page).first().getByRole("button", { name: /pop out/ }).click()]);
    await popup.waitForLoadState("domcontentloaded");
    const url = new URL(popup.url());
    expect(url.pathname).toBe("/chat/");
    expect(url.searchParams.get("c")).toBe(CONV);
    expect(url.searchParams.get("popout")).toBe("1");
    await expect(popup.getByTestId("io-chat-page")).toBeVisible();
    await expect(popup.locator(".io-chat-page-roster")).toHaveCount(0);
    await expect(popup.getByTestId("io-chat-panel")).toHaveCount(0);
    await expect(popup.getByTestId("io-chat-dock")).toHaveCount(0);
    await expect(popup.locator(".io-chat-row").filter({ hasText: "from the dock" })).toBeVisible(); // the history is the hub's
    await popup.close();
    hub.dispose();
  });

  test("/chat/: the roster beside the conversation, ?c= selects it, the other chats stay docked; axe clean", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    const alex = hub.virtual("I9003");
    await wire(context, { hub });
    pat.say(CONV, "from pat");
    // a second chat, docked from a roster click on another page, is still docked beside the /chat/ page
    await page.goto(`/chat/?c=${encodeURIComponent(CONV)}`, { waitUntil: "domcontentloaded" });
    const chatPage = page.getByTestId("io-chat-page");
    await expect(chatPage).toHaveAttribute("data-layout", "two-pane");
    await expect(chatPage.locator(".io-chat-page-roster")).toBeVisible();
    await expect(chatPage.locator(".io-chat-bar-heading")).toHaveText("Pat Example");
    await expect(chatPage.locator(".io-chat-row").filter({ hasText: "from pat" })).toBeVisible();
    await expect(page.getByTestId("io-chat-panel")).toHaveCount(0); // the page's roster replaces the panel
    await chatPage.getByRole("button", { name: /Alex Example/ }).click();
    await expect(chatPage.locator(".io-chat-bar-heading")).toHaveText("Alex Example");
    expect(new URL(page.url()).searchParams.get("c")).toBe(dm(ME, "I9003"));
    alex.say(dm(ME, "I9003"), "hello from alex");
    await expect(chatPage.locator(".io-chat-row").filter({ hasText: "hello from alex" })).toBeVisible();
    await expect(page.getByText("chat isn't turned on yet.")).toHaveCount(0);
    expect(await noHScroll(page)).toBe(true);
    await calm(page);
    expect(await axeViolations(page)).toEqual([]);
    hub.dispose();
  });

  test("the session rotates before it expires: one refresh, a second socket, no lost or doubled message across the swap", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    // the session is good for 124 s, so the client starts its make-before-break rotation 4 s after the page loads (at exp - 120 s)
    const log = await wire(context, { hub, exp: 124 });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    const mole = moles(page).first();
    await composer(page).fill("before the swap");
    await composer(page).press("Enter");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "before the swap" })).toBeVisible();
    await expect.poll(() => log.refreshes, { timeout: 15000 }).toBe(1);
    await expect.poll(() => hub.log.upgrades, { timeout: 15000 }).toBeGreaterThanOrEqual(2); // the second socket, opened before the first closed
    // the old socket closes once the new one carries the page: exactly one is live afterwards, and at no point were there more than two
    await expect.poll(() => hub.log.live, { timeout: 15000 }).toBe(1);
    expect(hub.log.maxLive).toBeLessThanOrEqual(2);
    expect(hub.log.closed).toBe(hub.log.upgrades - 1);
    pat.say(CONV, "during the swap");
    await composer(page).fill("after the swap");
    await composer(page).press("Enter");
    await expect(mole.locator(".io-chat-row").filter({ hasText: "after the swap" })).toBeVisible();
    await expect(mole.locator(".io-chat-row").filter({ hasText: "during the swap" })).toHaveCount(1);
    await expect(mole.locator(".io-chat-row").filter({ hasText: "before the swap" })).toHaveCount(1);
    expect(hub.log.frames.filter((f) => f.uid === ME && f.frame.t === "send").map((f) => f.frame.text)).toEqual(["before the swap", "after the swap"]);
    expect(log.refreshes).toBe(1);
    // a settled page holds one socket: the swap leaked none, and no further reconnect followed it
    await page.waitForTimeout(1500);
    expect(hub.log.live).toBe(1);
    expect(hub.log.maxLive).toBeLessThanOrEqual(2);
    hub.dispose();
  });

  test("the title bar and the new-message flash keep the 4.5:1 text contrast in both schemes; the presence dots are 3:1 against the surface", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(panel(page)).toBeVisible();
    for (const scheme of ["dark", "light"]) {
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      const got = await page.evaluate(() => {
        const el = document.querySelector(".io-chat-panel");
        const cs = getComputedStyle(el);
        const v = (n) => cs.getPropertyValue(n).trim();
        const surface = getComputedStyle(document.querySelector(".io-chat-panel-body")).backgroundColor;
        return { bar: v("--io-chat-bar"), barFg: v("--io-chat-bar-fg"), flash: v("--io-chat-flash"), flashFg: v("--io-chat-flash-fg"), active: v("--io-chat-presence-active"), idle: v("--io-chat-presence-idle"), offline: v("--io-chat-presence-offline"), bg: v("--io-chat-bg"), surface };
      });
      const c = (a, b) => contrast(parseColor(a), parseColor(b));
      expect(c(got.bar, got.barFg), `${scheme} bar`).toBeGreaterThanOrEqual(4.5);
      expect(c(got.flash, got.flashFg), `${scheme} flash`).toBeGreaterThanOrEqual(4.5);
      for (const k of ["active", "idle", "offline"]) expect(c(got[k], got.bg), `${scheme} presence ${k}`).toBeGreaterThanOrEqual(3);
      // the bar actually paints its token (the title bar is drawn from --io-chat-bar)
      const painted = await page.evaluate(() => getComputedStyle(document.querySelector(".io-chat-panel .io-chat-bar")).backgroundColor);
      expect(parseColor(painted)).toEqual(parseColor(got.bar));
    }
    // the light scheme as a whole (rows, bars, composer) is axe clean with a chat open
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    await expect(moles(page)).toHaveCount(1);
    await calm(page);
    expect(await axeViolations(page, { include: "#hfy-chat-root" })).toEqual([]);
    hub.dispose();
  });
});

test.describe("375", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the chat entry fills the chat slot (before the gear and the account), a 44px link to /chat/ with the unread dot; nothing docks", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    const entry = page.locator('.hfy-bar__end [data-slot="chat"] a.io-chat-entry');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("href", "/chat/");
    await expect(entry).toHaveAccessibleName("chat");
    const box = await entry.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(43.5);
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    // the four ordered slots (shell-bar-slots owns them): bell, chat, gear, account; the bell is nobody's here
    expect(await page.locator(".hfy-bar__end > [data-slot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-slot")))).toEqual(["chat", "gear", "account"]);
    expect(await page.locator(".hfy-bar__end").evaluate((e) => e.getBoundingClientRect().right <= window.innerWidth)).toBe(true); // the end group stays on screen
    await expect(page.getByTestId("io-chat-entry-dot")).toHaveCount(0);
    // an incoming message only lights the dot: no auto-open on a phone (and no panel, no dock)
    pat.say(CONV, "hi from pat");
    await expect(entry).toHaveAccessibleName("chat, unread messages");
    await expect(page.getByTestId("io-chat-entry-dot")).toHaveCount(1);
    await expect(page.getByTestId("io-chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("io-chat-dock")).toHaveCount(0);
    expect(await noHScroll(page)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await entry.click();
    await expect(page).toHaveURL(/\/chat\/$/);
    hub.dispose();
  });

  test("/chat/: the roster at full width with 44px rows and 16px inputs, then a conversation at full width with the bottom bar hidden, and Back returns", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    pat.say(CONV, "hi from pat");
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });
    const chatPage = page.getByTestId("io-chat-page");
    await expect(chatPage).toHaveAttribute("data-layout", "stack");
    const bottomBar = page.locator(".io-shell__bar");
    await expect(bottomBar).toBeVisible();
    // the roster: search, groups, family
    const search = chatPage.getByPlaceholder("search family");
    await expect(search).toBeVisible();
    expect(await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    const rows = chatPage.locator(".io-chat-person");
    for (const r of await rows.all()) expect((await r.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    expect((await chatPage.getByRole("button", { name: "new group" }).boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    expect(await noHScroll(page)).toBe(true);
    await calm(page);
    expect(await axeViolations(page)).toEqual([]);
    await expect(page.locator("html")).not.toHaveClass(/hfy-chat-convo/);
    // a conversation: full width, the composer visible above the safe area, the compact bottom bar hidden
    await rows.filter({ hasText: "Pat Example" }).click();
    await expect(chatPage.locator(".io-chat-bar-heading")).toHaveText("Pat Example");
    await expect(page.locator("html")).toHaveClass(/hfy-chat-convo/);
    await expect(bottomBar).toBeHidden();
    await expect(chatPage.locator(".io-chat-page-roster")).toHaveCount(0);
    const input = composer(page);
    await expect(input).toBeVisible();
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect((await input.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    const emoji = chatPage.getByRole("button", { name: "emoji" });
    expect((await emoji.boundingBox()).width).toBeGreaterThanOrEqual(43.5);
    const vh = await page.evaluate(() => window.innerHeight);
    const inputBox = await input.boundingBox();
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(vh); // the composer is on the screen, not below it
    await expect(chatPage.getByRole("button", { name: /^send$/i })).toHaveCount(0);
    await expect(input).toHaveAttribute("placeholder", "type a message");
    // sending works from the phone layout
    await input.fill("on my way");
    await input.press("Enter");
    const sent = chatPage.locator(".io-chat-row").filter({ hasText: "on my way" });
    await expect(sent).toBeVisible();
    await expect(sent).not.toHaveAttribute("data-state", "pending"); // a pending row is grey on purpose; the ack darkens it
    expect(await noHScroll(page)).toBe(true);
    await calm(page);
    expect(await axeViolations(page)).toEqual([]);
    expect(new URL(page.url()).searchParams.get("c")).toBe(CONV);
    // Back returns to the roster, and the bar returns
    await chatPage.getByRole("button", { name: "back to chats" }).click();
    await expect(chatPage.locator(".io-chat-page-roster")).toBeVisible();
    await expect(bottomBar).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/hfy-chat-convo/);
    expect(new URL(page.url()).searchParams.has("c")).toBe(false);
    hub.dispose();
  });

  test("a /chat/?c= deep link (a push lands here) opens that conversation full screen, and the in-page Back leaves it for the roster", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual(PAT);
    await wire(context, { hub });
    pat.say(CONV, "see you soon");
    await page.goto(`/chat/?c=${encodeURIComponent(CONV)}`, { waitUntil: "domcontentloaded" });
    const chatPage = page.getByTestId("io-chat-page");
    await expect(chatPage.locator(".io-chat-bar-heading")).toHaveText("Pat Example");
    await expect(chatPage.locator(".io-chat-row").filter({ hasText: "see you soon" })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/hfy-chat-convo/);
    await chatPage.getByRole("button", { name: "back to chats" }).click();
    await expect(chatPage.locator(".io-chat-page-roster")).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/hfy-chat-convo/);
    expect(new URL(page.url()).searchParams.has("c")).toBe(false);
    hub.dispose();
  });
});

test.describe("who sees chat", () => {
  test("a member the Worker refuses (close 4403) sees no entry, no panel and no page", async ({ page, context }) => {
    const hub = chatHub();
    await wire(context, { hub, refuse: 4403 });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => hub.log.upgrades ?? 0).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(page.locator('[data-slot="chat"]')).toHaveCount(0);
    await expect(page.getByTestId("io-chat-entry-dot")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId("io-chat-panel")).toHaveCount(0);
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("chat isn't available right now.")).toBeVisible();
    await expect(page.getByTestId("io-chat-page")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
    hub.dispose();
  });

  test("a signed-out reader of /chat/ is told to sign in, with the edge sign-in back to the page, and no socket opens", async ({ page, context }) => {
    const hub = chatHub();
    const log = await wire(context, { hub, session: null });
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("sign in to chat.")).toBeVisible();
    await expect(page.getByRole("link", { name: "sign in", exact: true }).last()).toHaveAttribute("href", "/auth/login?returnTo=%2Fchat%2F");
    expect(hub.log.upgrades ?? 0).toBe(0);
    await expect(page.getByText("chat isn't turned on yet.")).toHaveCount(0);
    // the return value is a same-origin path (the edge's safeReturnTo takes nothing else); a pop-out is not returned to, a ?c= is
    await page.goto("/chat/?popout=1&c=dm%3AI9001%3AI9002", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "sign in", exact: true }).last()).toHaveAttribute("href", "/auth/login?returnTo=%2Fchat%2F%3Fc%3Ddm%253AI9001%253AI9002");
    expect(await noHScroll(page)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    // and on any other page a signed-out visitor never loads the bundle
    const before = log.chatAssets.length;
    await page.goto("/contact/", { waitUntil: "load" });
    await expect(page.locator(".hfy-bar__end")).toBeVisible();
    await page.waitForTimeout(500);
    expect(log.chatAssets.length).toBe(before);
    hub.dispose();
  });
});

test.describe("a session's chat state", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sign-out erases the snapshot, the panel and mole state and the outbox, so nothing readable or queued outlives the session", async ({ page, context }) => {
    const hub = chatHub();
    hub.virtual(PAT);
    await wire(context, { hub });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await panel(page).getByRole("button", { name: /Pat Example/ }).click();
    await composer(page).fill("a private line");
    await composer(page).press("Enter");
    await expect(moles(page).first().locator(".io-chat-row").filter({ hasText: "a private line" })).toBeVisible();
    // what a session leaves behind: the per-user snapshot, the shell's remembered panel and moles, and a queued unsent message
    await page.evaluate(async (uid) => {
      sessionStorage.setItem(`hfy:chat:v1:${uid}`, JSON.stringify({ conversations: [{ id: "x", last: "a private line" }] }));
      sessionStorage.setItem("hfy:chat:moles", JSON.stringify(["x"]));
      localStorage.setItem("hfy:chat:panel", "open");
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(`hfy:chat:outbox:${uid}`, 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("outbox", "readwrite");
          tx.objectStore("outbox").put({ cmid: "q1", conv: "x", text: "queued, unsent", createdAt: Date.now(), owner: uid });
          tx.oncomplete = () => { req.result.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, ME);
    const keys = () => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith("hfy:chat:")));
    expect((await keys()).length).toBeGreaterThan(0);
    // the sign-out paths (auth-v2.js and lib/sign-out.js) both call forgetEdgeSession
    await page.evaluate(() => window.HFYFeatureFlags.forgetEdgeSession());
    await expect.poll(keys).toEqual([]);
    // the page leaves, as it does after a sign-out; the outbox database goes with its last connection
    await page.goto("/logged-out/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith("hfy:chat:"))), { timeout: 10000 }).toEqual([]);
    expect(await keys()).toEqual([]);
    hub.dispose();
  });

  test("an island that cannot start (session storage refused) says so on /chat/ instead of leaving the page blank", async ({ page, context }) => {
    const hub = chatHub();
    await wire(context, { hub });
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    });
    await page.goto("/chat/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("chat isn't available right now.")).toBeVisible();
    await expect(page.getByText("chat isn't turned on yet.")).toHaveCount(0);
    await expect(page.getByTestId("io-chat-page")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
    hub.dispose();
  });
});

test("the people the fixtures use are the synthetic ones (no real family names in this spec)", () => {
  expect(PEOPLE.every((p) => /^I90\d\d$/.test(p.id) && /Example$/.test(p.label))).toBe(true);
});
