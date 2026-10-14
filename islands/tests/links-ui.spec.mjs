// HFY-TSK-217: the links section on the person page (island person-links) and the /me/links/ editor (island links-editor), flag
// profileLinks, at 375 and 1280. Synthetic people and links only; /auth, /api, the flags file and the person JSON are stubbed. The stubbed
// PUT validates with the same shared validator the API runs.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/links-ui.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { validateLinks } from "../../shared/profile-links.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const LINKS = {
  instagram: { url: "https://www.instagram.com/sample.name", handle: "sample.name" },
  facebook: { url: "https://www.facebook.com/sample.name", handle: "sample.name" },
  website: { url: "https://example.org/", host: "example.org" }
};

/** /api/people/:id/links in memory: GET {links, version, can}, PUT with the shared validator, optionally one forced 409. */
async function stub(page, { flag = true, session = "I9001", links = LINKS, version = 3, conflictOnce = false } = {}) {
  const state = { links: { ...links }, version, puts: [], islandRequests: [], apiGets: 0, conflictOnce };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/(person-links|links-editor)\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({ json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" }, status: session ? 200 : 401 }));
  await page.route("**/api/people/*/links", async (r) => {
    const req = r.request();
    const id = new URL(req.url()).pathname.split("/")[3];
    if (req.method() === "GET") {
      state.apiGets += 1;
      return r.fulfill({ json: { links: state.links, version: state.version, can: { edit: session === id } } });
    }
    const body = req.postDataJSON();
    state.puts.push(body);
    if (state.conflictOnce) {
      state.conflictOnce = false;
      state.links = { website: { url: "https://example.net/", host: "example.net" } };
      state.version += 1;
      return r.fulfill({ status: 409, json: { error: "conflict", message: "links changed since you loaded them", details: { current: { links: state.links, version: state.version } } } });
    }
    if (body.version !== state.version) return r.fulfill({ status: 409, json: { error: "conflict", details: { current: { links: state.links, version: state.version } } } });
    const checked = validateLinks(body.links);
    if (!checked.ok) return r.fulfill({ status: 422, json: { error: "validation", message: "some links are not valid", details: { fields: checked.fields } } });
    for (const [k, v] of Object.entries(checked.links)) { if (v === null) delete state.links[k]; else state.links[k] = v; }
    state.version += 1;
    return r.fulfill({ json: { links: state.links, version: state.version } });
  });
  return state;
}

const openPerson = async (page, opts) => {
  const state = await stub(page, opts);
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
};
const openEditor = async (page, opts) => {
  const state = await stub(page, opts);
  await page.goto("/me/links/", { waitUntil: "domcontentloaded" });
  return state;
};
const slot = (page) => page.locator('#person-hero [data-slot="links"]');
const input = (page, name) => page.getByLabel(name, { exact: true });

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("person page: a labelled links section (h2 + chips), safe external links, the owner's edit chip, axe clean, section order intact", async ({ page }) => {
      await openPerson(page);
      const section = slot(page).locator("section.hfy-links");
      await expect(section).toBeVisible();
      await expect(section.getByRole("heading", { level: 2, name: "links" })).toBeVisible();
      const chips = section.locator("a[data-platform]");
      await expect(chips).toHaveCount(3);
      expect(await chips.evaluateAll((els) => els.map((e) => e.dataset.platform))).toEqual(["facebook", "instagram", "website"]);
      await expect(chips.nth(0)).toHaveText("facebook");
      await expect(chips.nth(1)).toHaveText("@sample.name");
      await expect(chips.nth(2)).toHaveText("example.org");
      await expect(chips.nth(1)).toHaveAttribute("aria-label", "instagram: @sample.name (opens in a new tab)");
      for (const a of await chips.all()) {
        await expect(a).toHaveAttribute("target", "_blank");
        await expect(a).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
        await expect(a).toHaveAttribute("referrerpolicy", "no-referrer");
        expect((await a.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
      }
      await expect(section.getByRole("link", { name: "edit links", exact: true })).toHaveAttribute("href", "/me/links/");
      // the person page's own section order is untouched: the links live inside the hero section's heading slot, not beside the sections
      const order = await page.evaluate(() => [...document.querySelectorAll("#person-content > section")].map((s) => s.id === "person-hero-section" ? s.id : (s.querySelector("h2")?.textContent.trim() ?? s.id)));
      expect(order).toEqual(["person-hero-section", "life", "family", "photos", "stories"]);
      expect(await section.evaluate((el) => el.parentElement.parentElement.parentElement.matches(".person-heading") || !!el.closest("#person-hero-section"))).toBe(true);
      if (name === "375") {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } else {
        const tops = await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        expect(new Set(tops).size, "one inline row").toBe(1);
      }
      expect(await axeViolations(page)).toEqual([]);
    });

    test("person page: an owner with no links gets 'add your links'; a visitor to a page with no links sees nothing", async ({ page }) => {
      await openPerson(page, { links: {} });
      await expect(slot(page).getByRole("link", { name: "add your links", exact: true })).toHaveAttribute("href", "/me/links/");
      await expect(slot(page).locator("a[data-platform]")).toHaveCount(0);
    });

    test("person page: a visitor to a page with no links sees nothing at all, and the slot takes no space", async ({ page }) => {
      const state = await openPerson(page, { links: {}, session: "I9099" });
      await expect.poll(() => state.apiGets).toBeGreaterThan(0);
      await expect(slot(page)).toBeEmpty();
      expect((await slot(page).boundingBox()) === null || (await slot(page).boundingBox()).height === 0).toBe(true);
      await expect(page.getByRole("heading", { name: "links", exact: true })).toHaveCount(0);
    });

    test("person page: a visitor sees the chips but no edit chip", async ({ page }) => {
      await openPerson(page, { session: "I9099" });
      await expect(slot(page).locator("a[data-platform]")).toHaveCount(3);
      await expect(slot(page).getByRole("link", { name: /edit links|add your links/ })).toHaveCount(0);
    });

    test("editor: seven labelled 16px inputs, hint and input attributes, signed-in axe clean, 44px targets", async ({ page }) => {
      await openEditor(page);
      await expect(page.getByRole("heading", { level: 1, name: "your links" })).toBeVisible();
      await expect(page.locator("[data-links-off]")).toHaveCount(0);
      const labels = ["facebook", "instagram", "snapchat", "tiktok", "linktree", "linkedin", "website"];
      await expect(input(page, "instagram")).toHaveValue("https://www.instagram.com/sample.name");
      for (const l of labels) {
        const el = input(page, l);
        await expect(el).toBeVisible();
        await expect(el).toHaveAttribute("inputmode", "url");
        await expect(el).toHaveAttribute("autocapitalize", "none");
        await expect(el).toHaveAttribute("spellcheck", "false");
        await expect(el).toHaveAttribute("autocomplete", "off");
        expect(await el.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
        expect((await el.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
        await expect(el).toHaveAccessibleDescription(l === "website" ? "the link to your website" : "@yourname, or the link to your profile");
      }
      const small = await page.evaluate(() => [...document.querySelectorAll(".hfy-links-editor button, .hfy-links-editor a")].filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map((e) => e.textContent));
      expect(small).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("editor: blur validates with the shared module, wrong_platform offers 'move it', axe clean with errors showing", async ({ page }) => {
      await openEditor(page, { links: {}, version: 0 });
      await input(page, "website").fill("https://www.instagram.com/sample.name");
      await input(page, "website").blur();
      await expect(page.getByText("that's an instagram link. move it to instagram?")).toBeVisible();
      await input(page, "facebook").fill("mailto:sample@example.org");
      await input(page, "facebook").blur();
      await expect(page.getByText("that's a way to message someone, not a profile. use your profile's address instead.")).toBeVisible();
      await input(page, "snapchat").fill("+1 555 010 0100");
      await input(page, "snapchat").blur();
      await expect(page.getByText("that looks like a phone number. take it out, then save.")).toBeVisible();
      await input(page, "tiktok").fill("https://vm.tiktok.com/ZSample/");
      await input(page, "tiktok").blur();
      await expect(page.getByText("that's a share link. open your profile and copy the address from there.")).toBeVisible();
      await expect(input(page, "website")).toHaveAttribute("aria-invalid", "true");
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole("button", { name: "move it" }).click();
      await expect(input(page, "website")).toHaveValue("");
      await expect(input(page, "instagram")).toHaveValue("https://www.instagram.com/sample.name");
      await expect(page.getByText("that's an instagram link. move it to instagram?")).toHaveCount(0);
      await expect(input(page, "instagram")).toBeFocused();
    });

    test("editor: save sends only the changed fields, pings 'saved', remove clears a field, and the page's chips match", async ({ page }) => {
      const state = await openEditor(page);
      await input(page, "snapchat").fill("@sample_snap");
      await page.getByRole("button", { name: "remove website" }).click();
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("saved");
      expect(state.puts).toEqual([{ links: { snapchat: "@sample_snap", website: null }, version: 3 }]);
      await expect(input(page, "snapchat")).toHaveValue("https://www.snapchat.com/@sample_snap");
      await expect(input(page, "website")).toHaveValue("");
      expect(state.version).toBe(4);
      // typing again clears the ping
      await input(page, "facebook").fill("https://www.facebook.com/sample.other");
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("");
    });

    test("editor: a 422 from the API puts the per-field error under its input; nothing is saved", async ({ page }) => {
      const state = await openEditor(page, { links: {}, version: 0 });
      // an address the page's own check lets through but the API refuses would be a validator drift: here the stub is the API, so force one
      await page.route("**/api/people/*/links", async (r) => {
        if (r.request().method() !== "PUT") return r.fallback();
        return r.fulfill({ status: 422, json: { error: "validation", message: "some links are not valid", details: { fields: [{ field: "linkedin", code: "not_a_profile", message: "that's an old linkedin address. open your linkedin profile and copy its current linkedin.com/in/ address from there." }] } } });
      });
      await input(page, "linkedin").fill("sample-name");
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.getByText("that's an old linkedin address.", { exact: false })).toBeVisible();
      await expect(input(page, "linkedin")).toHaveAttribute("aria-invalid", "true");
      expect(state.version).toBe(0);
    });

    test("editor: a 409 reloads the latest version with the line that says so", async ({ page }) => {
      const state = await openEditor(page, { conflictOnce: true });
      await input(page, "snapchat").fill("@sample_snap");
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("someone changed this a moment ago. your edits were replaced with the latest.");
      await expect(input(page, "website")).toHaveValue("https://example.net/");
      await expect(input(page, "instagram")).toHaveValue("");
      await expect(input(page, "snapchat")).toHaveValue("");
      // the next save carries the new version
      await input(page, "snapchat").fill("@sample_snap");
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("saved");
      expect(state.puts.at(-1).version).toBe(4);
    });

    test("editor: a 422 with no usable fields still tells the member it failed", async ({ page }) => {
      await openEditor(page, { links: {}, version: 0 });
      await page.route("**/api/people/*/links", (r) => r.request().method() !== "PUT" ? r.fallback() : r.fulfill({ status: 422, json: { error: "validation", message: "nope", details: {} } }));
      await input(page, "linkedin").fill("https://www.linkedin.com/in/sample-name");
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("that didn't work. try again.");
    });

    test("editor: saving with no changes sends nothing and says so", async ({ page }) => {
      const state = await openEditor(page);
      await page.getByRole("button", { name: "save", exact: true }).click();
      await expect(page.locator(".hfy-links-editor__status")).toHaveText("nothing to change yet.");
      expect(state.puts).toEqual([]);
    });

    test("editor: /api/me without an id shows the can't-tell line and never asks for links", async ({ page }) => {
      const state = await stub(page);
      await page.route("**/api/me", (r) => r.fulfill({ status: 200, json: { label: "Sam Example", admin: false, can: {} } }));
      await page.goto("/me/links/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("we can't tell which page is yours yet. try again in a moment.")).toBeVisible();
      expect(state.apiGets).toBe(0);
      await expect(page.locator("input")).toHaveCount(0);
    });

    test("editor: signed out shows the sign-in line, axe clean", async ({ page }) => {
      await openEditor(page, { session: null });
      const gate = page.locator(".hfy-links-editor [data-hfy-gate]");
      await expect(gate).toBeVisible();
      await expect(gate.getByRole("link", { name: "sign in", exact: true })).toHaveAttribute("href", "/auth/login?returnTo=%2Fme%2Flinks%2F");
      await expect(page.locator("input")).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("flag off: /me/links/ shows the neutral note and loads no feature bundle; the person page has no links section and loads none", async ({ page }) => {
      const state = await openEditor(page, { flag: false });
      await expect(page.locator("[data-links-off]")).toHaveText("your links aren't available yet.");
      await expect(page.getByRole("heading", { level: 1, name: "your links" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(state.islandRequests).toEqual([]);
      expect(state.apiGets).toBe(0);
      await expect(page.locator("input")).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);

      const state2 = await openPerson(page, { flag: false });
      await page.waitForLoadState("networkidle");
      expect(state2.islandRequests).toEqual([]);
      expect(state2.apiGets).toBe(0);
      await expect(slot(page)).toBeEmpty();
    });
  });
}
