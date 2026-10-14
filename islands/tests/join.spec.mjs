// HFY-TSK-140: the /join/ page (island join) and the signed-out entry lines (island join-entry), flag accessRequests, at 375 and 1280.
// The edge routes, the flags file, the session and Cloudflare's Turnstile script are all stubbed; synthetic answers only. The stubbed
// submit validates with the same shared validator the edge runs.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/join.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { validateForm } from "../../shared/legacy-form.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const EMAIL = "sam.example@example.test";
const CODE = "123456";
const TICKET = "tkT3st".padEnd(43, "x");
const DRAFT_KEY = "hfy:join-draft";
const ANSWERS = {
  givenNames: "Sample Q", maidenSurname: "Example", nickname: "Sammy", birthPlace: "Springfield, IL", birthYear: "1962", currentPlace: "Portland, OR",
  university: "Example State", graduationYear: "1984"
};

// window.turnstile, enough for the island: render() hands over a token at once, reset() hands over a fresh one.
const TURNSTILE_JS = `(function(){var n=0,o={};window.__ts={renders:[],refresh:[],resets:0};window.turnstile={
  render:function(el,opts){var id=++n;o[id]=opts;window.__ts.renders.push(opts.action);window.__ts.refresh.push(opts["refresh-expired"]);el.setAttribute("data-ts-widget",String(id));opts.callback("ts-token-"+id+"-0");return id},
  reset:function(id){window.__ts.resets++;o[id]&&o[id].callback("ts-token-"+id+"-"+window.__ts.resets)},
  remove:function(id){delete o[id]}}})();`;

/** Everything the page talks to, in memory. `replies` overrides any edge route: (body, state) => {status, json, headers?}. */
async function stub(page, { flag = true, session = null, config = { status: 200, json: { open: true, turnstileSiteKey: "1x-test-site-key" } }, replies = {}, turnstile = true } = {}) {
  const state = { calls: [], urls: [], islandRequests: [], turnstileRequests: 0, starts: 0, submits: 0, ticketSpent: false };
  page.on("request", (r) => state.urls.push(r.url()));
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, accessRequests: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/js\/islands\/join(-entry)?\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route(/challenges\.cloudflare\.com\/turnstile/, (r) => {
    state.turnstileRequests += 1;
    return turnstile ? r.fulfill({ contentType: "text/javascript", body: TURNSTILE_JS }) : r.abort();
  });
  await page.route("**/auth/access-request/config", (r) => {
    state.calls.push({ route: "config", method: r.request().method(), headers: r.request().headers() });
    return r.fulfill(config);
  });
  await page.route(/\/auth\/access-request(\/(start|verify))?$/, async (r) => {
    const req = r.request();
    const route = new URL(req.url()).pathname.replace("/auth/access-request", "").replace("/", "") || "submit";
    const body = req.postDataJSON();
    state.calls.push({ route, method: req.method(), headers: req.headers(), body });
    if (replies[route]) { const out = await replies[route](body, state); if (out.abort) return r.abort(); return r.fulfill({ status: out.status, json: out.json ?? {}, headers: out.headers }); }
    if (route === "start") { state.starts += 1; return r.fulfill({ status: 202, json: { ok: true } }); }
    if (route === "verify") {
      return body.code === CODE && body.email === EMAIL
        ? r.fulfill({ json: { ticket: TICKET, expiresAt: Math.floor(Date.now() / 1000) + 3600 } })
        : r.fulfill({ status: 400, json: { detail: "invalid_code" } });
    }
    state.submits += 1;
    if (body.ticket !== TICKET) return r.fulfill({ status: 403, json: { detail: "ticket_expired" } });
    const checked = validateForm({ ...body.form, email: EMAIL }, { storeCurrentCity: true });
    if (!checked.ok) return r.fulfill({ status: 400, json: { detail: "validation", fields: checked.fields } });
    return r.fulfill({ status: 201, json: { ok: true, state: "pending" } });
  });
  return state;
}

const open = async (page, opts) => {
  const state = await stub(page, opts);
  await page.goto("/join/", { waitUntil: "domcontentloaded" });
  return state;
};
const stepHeading = (page, text) => page.getByRole("heading", { level: 2, name: new RegExp(text) });
const bodyOf = (state, route) => state.calls.filter((c) => c.route === route).map((c) => c.body);

async function toStep2(page) {
  await page.getByLabel("your email").fill(EMAIL);
  await expect(page.locator("[data-ts-widget]")).toHaveCount(1);
  await page.getByRole("button", { name: "email me a code" }).click();
  await expect(stepHeading(page, "check your email")).toBeFocused();
}
async function toStep3(page) {
  await toStep2(page);
  await page.getByLabel("6-digit code").fill(CODE);
  await page.getByRole("button", { name: "check it" }).click();
  await expect(stepHeading(page, "tell us about you")).toBeFocused();
}
async function fillAnswers(page, a = ANSWERS) {
  await page.getByLabel("your given names").fill(a.givenNames);
  await page.getByLabel("your last name at birth").fill(a.maidenSurname);
  await page.getByRole("radio", { name: "female" }).check();
  await page.getByLabel("what does the family call you?").fill(a.nickname);
  await page.getByLabel("where were you born?").fill(a.birthPlace);
  await page.getByLabel("what year were you born?").fill(a.birthYear);
  await page.getByLabel("where do you live now?").fill(a.currentPlace);
  await page.getByRole("radio", { name: "never married" }).check();
  await page.getByLabel("if you graduated from a university, which one?").fill(a.university);
  await page.getByLabel("what year did you graduate?").fill(a.graduationYear);
}
const draftOf = (page) => page.evaluate((k) => sessionStorage.getItem(k), DRAFT_KEY);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("happy path: three steps, focus on each heading, the right calls, no email in any URL, axe clean, draft cleared", async ({ page }) => {
      const state = await open(page);
      await expect(page.getByRole("heading", { level: 1, name: "ask to join the family site" })).toBeVisible();
      await expect(page.locator("[data-join-off]")).toHaveCount(0);
      // step 1
      await expect(stepHeading(page, "your email")).toBeVisible();
      await expect(page.getByText("step 1 of 3")).toBeVisible();
      await expect(page.getByText("this site is just for family. tell us who you are and we'll add you. it takes about 5 minutes.")).toBeVisible();
      await expect(page.getByText("we only use your email so you can sign in. we never show it to anyone.")).toBeVisible();
      await expect(page.getByText("first, we'll email you a 6-digit code.")).toBeVisible();
      await expect(page.getByText("a gmail address lets you sign in with google")).toBeVisible();
      const emailInput = page.getByLabel("your email");
      expect(await emailInput.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await expect(page.locator("[data-ts-widget]")).toHaveCount(1);
      expect(await page.evaluate(() => window.__ts.renders)).toEqual(["join"]);
      expect(await axeViolations(page)).toEqual([]);
      expect(state.calls[0]).toMatchObject({ route: "config", method: "GET" });
      expect(state.calls[0].headers["x-requested-with"]).toBe("io-kit");
      await toStep2(page);
      // step 2
      await expect(page.getByText("step 2 of 3")).toBeVisible();
      await expect(page.getByText(`we sent a 6-digit code to ${EMAIL}. it works for 15 minutes.`)).toBeVisible();
      const code = page.getByLabel("6-digit code");
      await expect(code).toHaveAttribute("autocomplete", "one-time-code");
      await expect(code).toHaveAttribute("inputmode", "numeric");
      await expect(page.getByRole("button", { name: "send another" })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: "use a different email" })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await code.fill(CODE);
      await page.getByRole("button", { name: "check it" }).click();
      // step 3
      await expect(stepHeading(page, "tell us about you")).toBeFocused();
      await expect(page.getByText("step 3 of 3")).toBeVisible();
      await expect(page.getByRole("group", { name: "about you" })).toBeVisible();
      await expect(page.getByRole("group", { name: "your timeline" })).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "gender" }).getByRole("radio")).toHaveCount(2);
      await expect(page.getByRole("radiogroup", { name: "were you ever married?" }).getByRole("radio")).toHaveCount(5);
      await expect(page.getByLabel("where do you live now?")).toHaveCount(1); // Q2-11(a): city and state only
      await expect(page.getByLabel("what year did you move to your region?")).toHaveCount(1);
      expect(await axeViolations(page)).toEqual([]);
      await fillAnswers(page);
      // the draft follows the answers, and never holds the code, the ticket or the email
      await expect.poll(() => draftOf(page)).toContain("Sample Q");
      const draft = await draftOf(page);
      for (const secret of [CODE, TICKET, EMAIL, "ts-token"]) expect(draft).not.toContain(secret);
      await page.getByLabel("this is about me, not someone else").check();
      await page.getByRole("button", { name: "send my request" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "got it." })).toBeFocused();
      await expect(page.getByText("we'll look at it and email you, usually within a few days.")).toBeVisible();
      await expect(page.getByText(/while you wait, the family's story is on/)).toBeVisible();
      await expect(page.getByRole("link", { name: "the about page" })).toHaveAttribute("href", "/about/");
      expect(await draftOf(page)).toBeNull();
      expect(await axeViolations(page)).toEqual([]);
      // the calls
      expect(bodyOf(state, "start")).toEqual([{ email: EMAIL, turnstileToken: expect.stringMatching(/^ts-token-/), company: "" }]);
      expect(bodyOf(state, "verify")).toEqual([{ email: EMAIL, code: CODE }]);
      const [submit] = bodyOf(state, "submit");
      expect(submit.ticket).toBe(TICKET);
      expect(submit.form).toMatchObject({ givenNames: "Sample Q", gender: "female", birthYear: "1962", currentPlace: "Portland, OR", everMarried: "never_married", forSelf: true });
      expect(JSON.stringify(submit.form)).not.toContain(EMAIL);
      for (const c of state.calls.filter((x) => x.route !== "config")) {
        expect(c.method).toBe("POST");
        expect(c.headers["x-requested-with"]).toBe("io-kit");
        expect(c.headers["content-type"]).toContain("application/json");
      }
      // no email in any URL, encoded or not, and no query string on any edge call
      const enc = [EMAIL, encodeURIComponent(EMAIL), EMAIL.replace("@", "%40"), "sam.example"];
      for (const u of state.urls) {
        for (const e of enc) expect(u, `an address in ${u}`).not.toContain(e);
        if (u.includes("/auth/access-request")) expect(new URL(u).search).toBe("");
      }
      expect(new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).hash).toBe("");
    });

    test("a wrong code: the line is in the summary and under the field, focus goes to the summary, and the right code goes on", async ({ page }) => {
      await open(page);
      await toStep2(page);
      const code = page.getByLabel("6-digit code");
      await code.fill("000000");
      await page.getByRole("button", { name: "check it" }).click();
      const summary = page.locator("[data-join-summary]");
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute("role", "alert");
      await expect(summary).toBeFocused();
      await expect(summary.getByRole("link", { name: "that code didn't work. check your email for the newest one." })).toBeVisible();
      await expect(code).toHaveAttribute("aria-invalid", "true");
      const describedBy = await code.getAttribute("aria-describedby");
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("that code didn't work. check your email for the newest one.");
      expect(await axeViolations(page)).toEqual([]);
      await summary.getByRole("link").click();
      await expect(code).toBeFocused();
      await code.fill(CODE);
      await page.getByRole("button", { name: "check it" }).click();
      await expect(stepHeading(page, "tell us about you")).toBeFocused();
    });

    test("a short code never reaches the edge", async ({ page }) => {
      const state = await open(page);
      await toStep2(page);
      await page.getByLabel("6-digit code").fill("12 34");
      await page.getByRole("button", { name: "check it" }).click();
      await expect(page.locator("[data-join-summary]")).toContainText("the code is the 6 digits from the email.");
      expect(bodyOf(state, "verify")).toEqual([]);
    });

    test("the ticket expires at submit: back to step 1 with the notice and the answers kept, never the code or ticket", async ({ page }) => {
      let spent = false;
      const state = await open(page, {
        replies: { submit: (body) => { if (!spent) { spent = true; return { status: 403, json: { detail: "ticket_expired" } }; } return { status: 201, json: { ok: true, state: "pending" } }; } }
      });
      await toStep3(page);
      await fillAnswers(page);
      await page.getByLabel("this is about me, not someone else").check();
      await page.getByRole("button", { name: "send my request" }).click();
      const heading = stepHeading(page, "your email");
      await expect(heading).toBeFocused();
      await expect(page.getByText("step 1 of 3")).toBeVisible();
      const notice = page.locator("[data-join-notice]");
      await expect(notice).toHaveText("that took a while, so we need to check your email again. your answers are saved.");
      await expect(notice).toHaveAttribute("role", "status");
      const draft = JSON.parse(await draftOf(page));
      expect(draft).toMatchObject(ANSWERS);
      for (const secret of [CODE, TICKET, EMAIL]) expect(JSON.stringify(draft)).not.toContain(secret);
      expect(await axeViolations(page)).toEqual([]);
      // a fresh code, and the answers are all still there
      await toStep2(page);
      await page.getByLabel("6-digit code").fill(CODE);
      await page.getByRole("button", { name: "check it" }).click();
      await expect(stepHeading(page, "tell us about you")).toBeFocused();
      await expect(page.getByLabel("your given names")).toHaveValue(ANSWERS.givenNames);
      await expect(page.getByLabel("what year were you born?")).toHaveValue(ANSWERS.birthYear);
      await expect(page.getByRole("radio", { name: "female" })).toBeChecked();
      await expect(page.getByLabel("this is about me, not someone else")).toBeChecked(); // kept in the form, though the draft never holds it
      await page.getByRole("button", { name: "send my request" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "got it." })).toBeFocused();
      expect(state.submits).toBe(0); // the stubbed replies took both submits
      expect(await draftOf(page)).toBeNull();
    });

    test("a reload in step 3 keeps the answers in the form (after the mailbox is checked again)", async ({ page }) => {
      await open(page);
      await toStep3(page);
      await fillAnswers(page);
      await expect.poll(() => draftOf(page)).toContain("Springfield, IL");
      await page.reload({ waitUntil: "domcontentloaded" });
      await toStep3(page);
      await expect(page.getByLabel("where were you born?")).toHaveValue("Springfield, IL");
      await expect(page.getByRole("radio", { name: "never married" })).toBeChecked();
      await expect(page.getByLabel("this is about me, not someone else")).not.toBeChecked(); // after a reload the consent is given again
    });

    test("429 at step 1: the 'lot of codes' line, in an alert, and the visitor stays on step 1", async ({ page }) => {
      const state = await open(page, { replies: { start: () => ({ status: 429, json: { detail: "rate_limited" }, headers: { "retry-after": "3600" } }) } });
      await page.getByLabel("your email").fill(EMAIL);
      await expect(page.locator("[data-ts-widget]")).toHaveCount(1);
      await page.getByRole("button", { name: "email me a code" }).click();
      const failure = page.locator("[data-join-failure]");
      await expect(failure).toHaveText("that's a lot of codes. wait an hour, then try again.");
      await expect(failure).toHaveAttribute("role", "alert");
      await expect(stepHeading(page, "your email")).toBeVisible();
      await expect(page.getByLabel("your email")).toHaveValue(EMAIL);
      expect(await page.evaluate(() => window.__ts.resets)).toBeGreaterThan(0); // the spent token was replaced
      expect(await axeViolations(page)).toEqual([]);
      expect(bodyOf(state, "start")).toHaveLength(1);
    });

    test("the other answers: bot check, busy, unavailable, already requested, already on the list", async ({ page }) => {
      let next = { status: 403, json: { detail: "bot_check_failed" } };
      await open(page, { replies: { start: () => next } });
      await page.getByLabel("your email").fill(EMAIL);
      await expect(page.locator("[data-ts-widget]")).toHaveCount(1);
      const send = page.getByRole("button", { name: "email me a code" });
      await send.click();
      await expect(page.locator("[data-join-failure]")).toHaveText("we couldn't check that you're a person. try again in a minute.");
      next = { status: 503, json: { detail: "queue_full" } };
      await send.click();
      await expect(page.locator("[data-join-failure]")).toHaveText("we're getting a lot of requests right now. try again tomorrow.");
      next = { status: 503, json: { detail: "unavailable" } };
      await send.click();
      await expect(page.locator("[data-join-failure]")).toHaveText("that didn't work. try again in a minute.");
      next = { status: 400, json: { detail: "invalid_email" } };
      await send.click();
      await expect(page.locator("[data-join-summary]")).toContainText("that email doesn't look right. check it, then try again.");
      next = { status: 503, json: { detail: "closed" } };
      await send.click();
      await expect(page.getByText("asking to join is closed for now.")).toBeVisible();
    });

    test("409 at submit: 'already requested' and 'already on the list' end the flow with a sign-in link for a member", async ({ page }) => {
      for (const [detail, heading] of [["already_requested", "we already have your request. we'll email you."], ["already_member", "you're already on the list."]]) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await open(page, { replies: { submit: () => ({ status: 409, json: { detail } }) } });
        await toStep3(page);
        await fillAnswers(page);
        await page.getByLabel("this is about me, not someone else").check();
        await page.getByRole("button", { name: "send my request" }).click();
        await expect(page.getByRole("heading", { level: 2, name: heading })).toBeFocused();
        if (detail === "already_member") await expect(page.getByRole("link", { name: "sign in" })).toHaveAttribute("href", "/auth/login");
        expect(await draftOf(page)).toBeNull();
        expect(await axeViolations(page)).toEqual([]);
      }
    });

    test("step 3 errors: nothing blank goes out; the summary links to each field; a phone number and a street are named in the voice; the edge's 400 shows the same way", async ({ page }) => {
      const state = await open(page);
      await toStep3(page);
      await page.getByRole("button", { name: "send my request" }).click();
      const summary = page.locator("[data-join-summary]");
      await expect(summary).toBeFocused();
      await expect(summary).toHaveAttribute("role", "alert");
      for (const line of ["your given names: we need this one.", "gender: pick one.", "the year you were born: we need this one.", "the box about you: tick this box to send your request."]) {
        await expect(summary.getByRole("link", { name: line })).toBeVisible();
      }
      expect(state.submits).toBe(0);
      expect(bodyOf(state, "submit")).toEqual([]);
      await expect(page.getByLabel("your given names")).toHaveAttribute("aria-invalid", "true");
      expect(await axeViolations(page)).toEqual([]);
      await summary.getByRole("link", { name: /^gender/ }).click();
      await expect(page.getByRole("radio", { name: "male", exact: true })).toBeFocused();
      await fillAnswers(page);
      await page.getByLabel("what does the family call you?").fill("call 555 010 0100");
      await page.getByLabel("where were you born?").fill("12 Main Street, Springfield");
      await page.getByLabel("what year were you born?").fill("62");
      await page.getByLabel("this is about me, not someone else").check();
      await page.getByRole("button", { name: "send my request" }).click();
      await expect(summary).toContainText("that looks like a phone number. take it out, then send.");
      await expect(summary).toContainText("just the city and state is plenty.");
      await expect(summary).toContainText("just the year, like 1962.");
      expect(bodyOf(state, "submit")).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("the edge's own 400 (a field the page let through) is shown on that field", async ({ page }) => {
      await open(page, { replies: { submit: () => ({ status: 400, json: { detail: "validation", fields: [{ field: "birthPlace", code: "street_not_allowed" }, { field: "email", code: "invalid" }] } }) } });
      await toStep3(page);
      await fillAnswers(page);
      await page.getByLabel("this is about me, not someone else").check();
      await page.getByRole("button", { name: "send my request" }).click();
      await expect(page.locator("[data-join-summary]")).toContainText("where you were born: just the city and state is plenty.");
      await expect(page.getByLabel("where were you born?")).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("[data-join-summary]")).toBeFocused();
    });

    test("closed: the flag off keeps the static note and loads nothing; config closed or open:false shows the same note", async ({ page }) => {
      const off = await open(page, { flag: false });
      await expect(page.locator("[data-join-off]")).toHaveText("asking to join isn't open yet. if you're family, ask the person who told you about the site to reach out.");
      await expect(page.getByRole("button", { name: "email me a code" })).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
      expect(off.islandRequests).toEqual([]);
      expect(off.turnstileRequests).toBe(0);
      expect(off.calls).toEqual([]);
      for (const config of [{ status: 503, json: { detail: "closed" } }, { status: 200, json: { open: false, turnstileSiteKey: "x" } }]) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        const on = await open(page, { config });
        await expect(page.locator("[data-join-state=closed]")).toHaveText("asking to join isn't open yet. if you're family, ask the person who told you about the site to reach out.");
        await expect(page.locator("[data-join-off]")).toHaveCount(0);
        await expect(page.getByLabel("your email")).toHaveCount(0);
        expect(on.turnstileRequests, "Turnstile loads only once asking to join is open").toBe(0);
        expect(await axeViolations(page)).toEqual([]);
      }
    });

    test("an unreachable edge says so and offers to try again", async ({ page }) => {
      let up = false;
      await open(page, { config: { status: 502, json: {} } });
      await expect(page.getByText("that didn't work. try again in a minute.")).toBeVisible();
      await page.unroute("**/auth/access-request/config");
      await page.route("**/auth/access-request/config", (r) => { up = true; return r.fulfill({ json: { open: true, turnstileSiteKey: "1x-test-site-key" } }); });
      await page.getByRole("button", { name: "try again" }).click();
      await expect(stepHeading(page, "your email")).toBeVisible();
      expect(up).toBe(true);
    });

    test("a Turnstile script that cannot load says so, and nothing is sent", async ({ page }) => {
      const state = await open(page, { turnstile: false });
      await page.getByLabel("your email").fill(EMAIL);
      await expect(page.locator("[data-join-failure]")).toHaveText("we couldn't check that you're a person. try again in a minute.");
      await page.getByRole("button", { name: "email me a code" }).click();
      expect(bodyOf(state, "start")).toEqual([]);
    });

    test("the honeypot is out of the tab order and the tree, and a filled one reaches the edge", async ({ page }) => {
      const state = await open(page);
      const trap = page.locator('.hfy-join__trap input[name="company"]');
      await expect(page.locator(".hfy-join__trap")).toHaveAttribute("aria-hidden", "true");
      await expect(trap).toHaveAttribute("tabindex", "-1");
      await page.getByLabel("your email").fill(EMAIL);
      await expect(page.locator("[data-ts-widget]")).toHaveCount(1);
      await trap.evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "acme"); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.getByRole("button", { name: "email me a code" }).click();
      await expect(stepHeading(page, "check your email")).toBeFocused();
      expect(bodyOf(state, "start")[0].company).toBe("acme");
    });

    test("send another: held for 60 seconds, then a fresh code is asked for with a fresh check", async ({ page }) => {
      await page.clock.install();
      const state = await open(page);
      await toStep2(page);
      const again = page.getByRole("button", { name: "send another" });
      await expect(again).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-join-wait]")).toContainText("you can ask for another in 60 seconds.");
      await again.click({ force: true }); // aria-disabled, not disabled: the press does nothing
      expect(bodyOf(state, "start")).toHaveLength(1);
      await page.clock.runFor(61_000);
      await expect(again).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-join-wait]")).toHaveCount(0);
      await again.click();
      await expect(page.locator("[data-join-notice]")).toHaveText("we sent another code.");
      const starts = bodyOf(state, "start");
      expect(starts).toHaveLength(2);
      expect(starts[1].turnstileToken).not.toBe(starts[0].turnstileToken);
      await expect(again).toHaveAttribute("aria-disabled", "true");
    });

    test("a network failure on the code and on the submit: the failure is announced, the step stays, the answers are kept; the check asks to refresh itself", async ({ page }) => {
      let cut = true;
      await open(page, { replies: { verify: (b) => (cut ? { abort: true } : { status: 200, json: { ticket: TICKET } }), submit: () => ({ abort: true }) } });
      await toStep2(page);
      await page.getByLabel("6-digit code").fill(CODE);
      await page.getByRole("button", { name: "check it" }).click();
      await expect(page.locator("[data-join-failure]")).toHaveText("that didn't work. try again in a minute.");
      await expect(page.locator("[data-join-failure]")).toHaveAttribute("role", "alert");
      await expect(stepHeading(page, "check your email")).toBeVisible();
      await expect(page.getByLabel("6-digit code")).toHaveValue(CODE);
      cut = false;
      await page.getByRole("button", { name: "check it" }).click();
      await expect(stepHeading(page, "tell us about you")).toBeFocused();
      await fillAnswers(page);
      await page.getByLabel("this is about me, not someone else").check();
      await page.getByRole("button", { name: "send my request" }).click();
      await expect(page.locator("[data-join-failure]")).toHaveText("that didn't work. try again in a minute.");
      await expect(page.getByLabel("what year were you born?")).toHaveValue(ANSWERS.birthYear);
      expect(await draftOf(page)).not.toBeNull();
      expect(await page.evaluate(() => window.__ts.refresh)).toContain("auto"); // an idle step 3 does not strand the visitor on an expired token
    });

    test("use a different email: back to step 1 with the address to change", async ({ page }) => {
      await open(page);
      await toStep2(page);
      await page.getByRole("button", { name: "use a different email" }).click();
      await expect(stepHeading(page, "your email")).toBeFocused();
      await expect(page.getByLabel("your email")).toHaveValue(EMAIL);
    });
  });
}

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`entry lines ${name}px`, () => {
    test.use({ viewport });

    for (const path of ["/", "/about/", "/contact/"]) {
      test(`${path}: signed out and the flag on, the line is a plain link to /join/; axe clean`, async ({ page }) => {
        const state = await stub(page);
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const line = page.locator("[data-hfy-join-entry]");
        await expect(line).toHaveCount(1);
        await expect(line).toHaveText("new here? ask to join.");
        const link = line.getByRole("link", { name: "ask to join." });
        await expect(link).toHaveAttribute("href", "/join/");
        const box = await link.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await axeViolations(page, { include: "#hfy-join-entry" })).toEqual([]);
        await link.click();
        await expect(page).toHaveURL(/\/join\/$/);
        expect(state.urls.filter((u) => u.includes("@") || u.includes("%40"))).toEqual([]);
      });
    }

    test("signed in, flag off, or an unreachable session: no line, and with the flag off no bundle is requested", async ({ page }) => {
      for (const [opts, expectBundle] of [[{ session: "I9001" }, true], [{ flag: false }, false]]) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        const state = await stub(page, opts);
        await page.goto("/about/", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(600);
        await expect(page.locator("[data-hfy-join-entry]")).toHaveCount(0);
        expect(state.islandRequests.length > 0).toBe(expectBundle);
      }
    });
  });
}
