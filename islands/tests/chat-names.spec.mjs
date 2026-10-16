// HFY-TSK-340 (P2-R46, @io-kit/chat 0.2.0): participant names in chat link to /person/?id=<gramps id> through the site's person-name rule
// (lib/person-name.jsx personHref), and a name with no person mapping stays plain text. Same fixtures as chat.spec.mjs (the kit's real
// ChatCore over the page's WebSocket); synthetic people only. Where the kit may draw an anchor (transcript, the page heading) it does;
// roster rows, docked title bars and picker rows are buttons, so they stay plain text (no link inside a button).
// Run:  HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/chat-names.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { PEOPLE, chatHub, dm } from "./fixtures/chat-hub.mjs";

const ME = "I9001";
const PAT = "I9002";
const LABEL_ONLY = "guest-7"; // a directory entry that is not a Gramps person id: no page to link to
const FLAGS = { authV2: true, shellV2: true, navMe: true, notifyV2: true, searchV2: false, personV2: false, postsV2: false, aboutCta: false, chatV1: true };
const people = [...PEOPLE, { id: LABEL_ONLY, label: "Guest Example" }];

async function wire(context, hub) {
  await context.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await context.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS }));
  await context.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME, grampsId: ME, label: "Sam Example", exp: Math.floor(Date.now() / 1000) + 3600 } }));
  await context.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await hub.attach(context, { uid: ME });
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const calm = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));

/** A linked name is an anchor to the person page with the id only, drawn without an underline in the text's own colour. */
async function expectNameLink(link, id) {
  await expect(link).toHaveAttribute("href", `/person/?id=${id}`);
  const s = await link.evaluate((a) => {
    const cs = getComputedStyle(a);
    const parent = getComputedStyle(a.parentElement);
    return { deco: cs.textDecorationLine, color: cs.color, parentColor: parent.color, weight: cs.fontWeight, parentWeight: parent.fontWeight };
  });
  expect(s.deco).toBe("none");
  expect(s.color).toBe(s.parentColor);
  expect(s.weight).toBe(s.parentWeight);
}

/** The id of the group conversation, as the hub's frames to a member name it (a group id is not a dm: id). */
const groupConv = (peer) => {
  for (const f of peer.received) {
    for (const c of [f.conv, f.id, ...(Array.isArray(f.convs) ? f.convs.map((x) => x.id) : [])]) if (typeof c === "string" && !c.startsWith("dm:")) return c;
  }
  return null;
};

const noPersonHref = (page, scope, name) => scope.getByText(name, { exact: false }).evaluateAll((els) => els.every((e) => !e.closest("a[href^='/person/']")));

for (const scheme of ["light", "dark"]) {
  for (const [label, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]]) {
    test.describe(`${label} ${scheme}`, () => {
      test.use({ viewport, colorScheme: scheme });

      test("the /chat/ page: the heading and the transcript link a person, a label-only member stays plain, the roster rows stay buttons; axe clean", async ({ page, context }) => {
        const hub = chatHub({ people });
        const pat = hub.virtual(PAT);
        const guest = hub.virtual(LABEL_ONLY);
        await wire(context, hub);
        pat.say(dm(ME, PAT), "hello from pat");
        guest.say(dm(ME, LABEL_ONLY), "hello from the guest");
        await page.goto("/chat/", { waitUntil: "domcontentloaded" });
        const chatPage = page.getByTestId("io-chat-page");
        // roster: names are plain text in buttons, never a nested anchor
        const patRow = chatPage.getByRole("button", { name: /Pat Example/ });
        await expect(patRow).toBeVisible();
        await expect(chatPage.locator(".io-chat-person a")).toHaveCount(0);
        await patRow.click();
        const heading = chatPage.locator(".io-chat-bar-heading");
        await expect(heading).toContainText("Pat Example");
        await expectNameLink(heading.getByRole("link", { name: "Pat Example" }), PAT);
        const line = chatPage.locator(".io-chat-row").filter({ hasText: "hello from pat" });
        await expect(line).toBeVisible();
        await expectNameLink(line.getByRole("link", { name: "Pat Example" }), PAT);
        // a name with no person mapping: plain text, no link
        await page.goto(`/chat/?c=${encodeURIComponent(dm(ME, LABEL_ONLY))}`, { waitUntil: "domcontentloaded" }); // a phone shows one pane at a time
        await expect(chatPage.locator(".io-chat-bar-heading")).toHaveText("Guest Example");
        const gline = chatPage.locator(".io-chat-row").filter({ hasText: "hello from the guest" });
        await expect(gline).toContainText("Guest Example");
        await expect(gline.locator("a")).toHaveCount(0);
        await expect(chatPage.locator(".io-chat-bar-heading a")).toHaveCount(0);
        // nothing puts a name or an email in a URL
        for (const href of await chatPage.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
          if (href.startsWith("/person/")) expect(href).toMatch(/^\/person\/\?id=I\d+$/);
        }
        expect(await noHScroll(page)).toBe(true);
        await calm(page);
        expect(await axeViolations(page)).toEqual([]);
        hub.dispose();
      });

      if (label === "1280") {
        test("the panel, the docked title bar and a group (mapped member links, label-only member plain): names link in the transcript, stay plain text in buttons (roster, title bar, picker); axe clean", async ({ page, context }) => {
          const hub = chatHub({ people });
          const pat = hub.virtual(PAT);
          hub.virtual("I9003");
          const guest = hub.virtual(LABEL_ONLY);
          await wire(context, hub);
          await page.goto("/contact/", { waitUntil: "domcontentloaded" });
          const panel = page.getByTestId("io-chat-panel");
          await expect(panel).toBeVisible();
          await expect(panel.locator("a[href^='/person/']")).toHaveCount(0); // the roster rows are buttons
          await panel.getByRole("button", { name: /Pat Example/ }).click();
          const mole = page.getByTestId("io-chat-mole").first();
          await expect(mole.locator(".io-chat-bar-name")).toHaveText("Pat Example");
          await expect(mole.locator(".io-chat-bar-name a, .io-chat-bar button a")).toHaveCount(0); // the title bar is a button
          pat.say(dm(ME, PAT), "hi sam");
          const row = mole.locator(".io-chat-row").filter({ hasText: "hi sam" });
          await expectNameLink(row.getByRole("link", { name: "Pat Example" }), PAT);
          // a group of two people and a label-only member: the picker rows stay plain, the group's transcript links only the mapped names
          await panel.getByRole("button", { name: "new group" }).click();
          await expect(page.getByRole("checkbox", { name: /Guest Example/ })).toBeVisible();
          await expect(page.locator("label a[href^='/person/']")).toHaveCount(0);
          await page.getByRole("checkbox", { name: /Pat Example/ }).check();
          await page.getByRole("checkbox", { name: /Guest Example/ }).check();
          await page.getByRole("textbox", { name: /group name/ }).fill("Cousins");
          await page.getByRole("button", { name: "start group" }).click();
          const group = page.getByTestId("io-chat-mole").filter({ has: page.locator(".io-chat-bar-name", { hasText: "Cousins" }) });
          await expect(group).toBeVisible();
          expect(await noPersonHref(page, group.locator(".io-chat-bar"), "Cousins")).toBe(true);
          // the group's id is read off the frames the hub sent a member, then both members speak in it
          await expect.poll(() => groupConv(pat)).toBeTruthy();
          const conv = groupConv(pat);
          pat.say(conv, "group hello from pat");
          guest.say(conv, "group hello from the guest");
          const pline = group.locator(".io-chat-row").filter({ hasText: "group hello from pat" });
          await expectNameLink(pline.getByRole("link", { name: "Pat Example" }), PAT);
          const gline = group.locator(".io-chat-row").filter({ hasText: "group hello from the guest" });
          await expect(gline).toContainText("Guest Example");
          await expect(gline.locator("a")).toHaveCount(0);
          await calm(page);
          expect(await axeViolations(page)).toEqual([]);
          expect(await noHScroll(page)).toBe(true);
          hub.dispose();
        });
      }
    });
  }
}
