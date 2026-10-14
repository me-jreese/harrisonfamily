// HFY-TSK-140 (HFY-PLN-002 surfaces 7.10): the /join/ page's pure side, in node. Synthetic emails and answers only.
// Pins: the design's words; the draft never holding the code, the ticket, the email or the consent tick; the client check being the
// edge's validator; what each edge answer means; and that no email ever travels in a URL (the edge calls take none, the entry line is a
// plain /join/ link, and neither island's source builds an address-bearing href).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  COPY, DRAFT_KEY, FIELD_UI, STORE_CURRENT_CITY, allCopy, blankForm, checkForm, clearDraft, createJoinApi, draftOf, errorLine, fieldLines, formBody,
  formFields, loadDraft, readConfig, saveDraft, startOutcome, submitOutcome, summaryItems, verifyOutcome
} from "../src/lib/join.js";
import * as entry from "../src/lib/join-entry.js";
import { TURNSTILE_ACTION, TURNSTILE_SRC } from "../src/lib/turnstile.js";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = "sam.example@example.test";
const GOOD = {
  givenNames: "Sample Q", maidenSurname: "Example", gender: "female", nickname: "Sammy", birthPlace: "Springfield, IL", birthYear: "1962",
  currentPlace: "Portland, OR", movedYear: "", everMarried: "never_married", university: "Example State", graduationYear: "1984", otherDegrees: "", otherInstitutions: "", otherDegreeYears: "", forSelf: true
};
const year = new Date().getUTCFullYear();

test("the deck is the surfaces 7.10 copy", () => {
  assert.equal(COPY.title, "ask to join the family site");
  assert.equal(COPY.closed, "asking to join isn't open yet. if you're family, ask the person who told you about the site to reach out.");
  assert.equal(COPY.lede, "this site is just for family. tell us who you are and we'll add you. it takes about 5 minutes.");
  assert.equal(COPY.privacy, "we only use your email so you can sign in. we never show it to anyone.");
  assert.equal(COPY.firstCode, "first, we'll email you a 6-digit code.");
  assert.equal(COPY.emailHint, "a gmail address lets you sign in with google");
  assert.equal(COPY.sendCode, "email me a code");
  assert.equal(COPY.sentTo(EMAIL), `we sent a 6-digit code to ${EMAIL}. it works for 15 minutes.`);
  assert.equal(COPY.checkIt, "check it");
  assert.equal(COPY.noCode, "didn't get it? check spam, or");
  assert.equal(COPY.sendAnother, "send another");
  assert.equal(COPY.differentEmail, "use a different email");
  assert.equal([COPY.stepOf(2)].join(), "step 2 of 3");
  assert.equal(COPY.aboutYou, "about you");
  assert.equal(COPY.timeline, "your timeline");
  assert.equal(COPY.send, "send my request");
  assert.equal(`${COPY.doneTitle} ${COPY.done}`, "got it. we'll look at it and email you, usually within a few days.");
  assert.equal(COPY.doneAbout, "while you wait, the family's story is on the about page.");
  assert.equal(COPY.expired, "that took a while, so we need to check your email again. your answers are saved.");
  assert.equal(COPY.tooManyCodes, "that's a lot of codes. wait an hour, then try again.");
  assert.equal(COPY.badCode, "that code didn't work. check your email for the newest one.");
  assert.equal(COPY.busy, "we're getting a lot of requests right now. try again tomorrow.");
  assert.equal(COPY.closedNow, "asking to join is closed for now.");
  assert.equal(COPY.unavailable, "that didn't work. try again in a minute.");
  assert.equal(errorLine("birthYear", "year_format"), "just the year, like 1962.");
  assert.equal(errorLine("birthPlace", "street_not_allowed"), "just the city and state is plenty.");
  assert.equal(errorLine("nickname", "contact_info"), "that looks like a phone number. take it out, then send.");
});

test("copy: lowercase, no '!', no 'record', no 'users' or 'members'", () => {
  const all = allCopy();
  assert.ok(all.length > 80);
  for (const s of all) {
    assert.equal(s, s.toLowerCase(), s);
    assert.ok(!s.includes("!"), s);
    assert.ok(!/\brecords?\b/.test(s), s);
    assert.ok(!/\busers?\b/.test(s) && !/\bmembers?\b/.test(s), s);
  }
  for (const s of entry.allCopy()) assert.equal(s, s.toLowerCase());
  assert.equal(entry.LINE, "new here? ask to join.");
});

test("the form asks the Legacy Form's questions in order; gender is male or female; the current city is asked at city and state level (Q2-11(a))", () => {
  assert.equal(STORE_CURRENT_CITY, true);
  assert.deepEqual(formFields(1).map((f) => f.key), ["givenNames", "maidenSurname", "gender", "nickname", "birthPlace", "birthYear", "currentPlace", "movedYear", "everMarried"]);
  assert.deepEqual(formFields(2).map((f) => f.key), ["university", "graduationYear", "otherDegrees", "otherInstitutions", "otherDegreeYears"]);
  assert.deepEqual(FIELD_UI.gender.options.map((o) => o[0]), ["male", "female"]);
  assert.deepEqual(FIELD_UI.everMarried.options.map((o) => o[0]), ["married_once_still", "married_once_widowed", "married_once_divorced", "married_more_than_once", "never_married"]);
  for (const f of [...formFields(1), ...formFields(2)]) assert.ok(FIELD_UI[f.key], f.key);
});

test("the client check is the edge's validator: a good form passes, each bad answer gets its code and line", () => {
  assert.deepEqual(checkForm(GOOD, EMAIL), []);
  const bad = { ...GOOD, givenNames: "", gender: "", birthPlace: "12 Main Street, Springfield", birthYear: "62", nickname: "call 555 010 0100", forSelf: false };
  const got = Object.fromEntries(checkForm(bad, EMAIL).map((f) => [f.field, f.code]));
  assert.equal(got.givenNames, "required");
  assert.equal(got.gender, "required");
  assert.ok(["digits_not_allowed", "street_not_allowed"].includes(got.birthPlace), got.birthPlace);
  assert.equal(got.birthYear, "year_format");
  assert.equal(got.nickname, "contact_info");
  assert.equal(got.forSelf, "required");
  assert.equal(checkForm({ ...GOOD, birthYear: String(year + 1) }, EMAIL)[0].code, "year_range");
  assert.equal(checkForm({ ...GOOD, birthYear: String(year - 200) }, EMAIL)[0].code, "year_format");
  // the current city is asked and sent, at city and state level only: a missing one is required, a street or a postal code is refused
  assert.deepEqual(checkForm({ ...GOOD, currentPlace: "" }, EMAIL), [{ field: "currentPlace", code: "required" }]);
  for (const place of ["12 Main Street, Portland, OR", "Portland, OR 97201"]) {
    assert.deepEqual(checkForm({ ...GOOD, currentPlace: place }, EMAIL).map((f) => f.field), ["currentPlace"], place);
  }
  assert.equal(formBody({ ...GOOD, currentPlace: " Elsewhere, IL " }).currentPlace, "Elsewhere, IL");
  assert.equal("movedYear" in formBody(GOOD), false); // optional and blank
});

test("formBody trims, leaves blanks out and sends the consent tick as true", () => {
  const body = formBody({ ...GOOD, givenNames: "  Sample Q  ", nickname: "   ", otherDegrees: "" });
  assert.equal(body.givenNames, "Sample Q");
  assert.equal("nickname" in body, false);
  assert.equal(body.forSelf, true);
  assert.equal("forSelf" in formBody({ ...GOOD, forSelf: false }), false);
  assert.equal("email" in body, false);
});

test("the edge's fields[] become one line per field, in form order, with the field's own name in the summary", () => {
  const lines = fieldLines([{ field: "birthYear", code: "year_format" }, { field: "givenNames", code: "required" }, { field: "email", code: "invalid" }, { field: "nope", code: "invalid" }, { field: "birthYear", code: "year_range" }]);
  assert.deepEqual(Object.keys(lines).sort(), ["birthYear", "givenNames"]);
  assert.equal(lines.birthYear, "just the year, like 1962.");
  const items = summaryItems(lines);
  assert.deepEqual(items.map((i) => i.field), ["givenNames", "birthYear"]);
  assert.equal(items[1].text, "the year you were born: just the year, like 1962.");
  assert.deepEqual(fieldLines(undefined), {});
});

function memoryStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}

test("the draft holds the answers only: never the code, the ticket, the email or the consent tick", () => {
  const dirty = { ...GOOD, code: "123456", ticket: "tkt_" + "a".repeat(40), email: EMAIL, turnstileToken: "tok", forSelf: true, company: "x" };
  const kept = draftOf(dirty);
  assert.deepEqual(Object.keys(kept).sort(), ["birthPlace", "birthYear", "currentPlace", "everMarried", "gender", "givenNames", "graduationYear", "maidenSurname", "nickname", "university"].sort());
  const s = memoryStore();
  saveDraft(dirty, s);
  assert.equal(DRAFT_KEY, "hfy:join-draft");
  const raw = s.raw.get(DRAFT_KEY);
  for (const secret of ["123456", "tkt_", EMAIL, "tok", "forSelf", "company"]) assert.ok(!raw.includes(secret), `the draft holds ${secret}`);
  const back = loadDraft(s);
  assert.equal(back.givenNames, "Sample Q");
  assert.equal(back.forSelf, false);
  clearDraft(s);
  assert.equal(s.raw.has(DRAFT_KEY), false);
  assert.deepEqual(loadDraft(s), blankForm());
});

test("a stored draft is re-filtered on the way in, and blocked or broken storage never throws", () => {
  const s = memoryStore({ [DRAFT_KEY]: JSON.stringify({ givenNames: "Sample", code: "999999", ticket: "t", email: EMAIL, birthYear: 1962, forSelf: true }) });
  const d = loadDraft(s);
  assert.equal(d.givenNames, "Sample");
  assert.equal(d.birthYear, "", "a number is not a string answer");
  assert.equal(d.forSelf, false);
  for (const k of ["code", "ticket", "email"]) assert.equal(k in d, false);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadDraft(broken), blankForm());
  assert.doesNotThrow(() => saveDraft(GOOD, broken));
  assert.doesNotThrow(() => clearDraft(broken));
  assert.deepEqual(loadDraft(memoryStore({ [DRAFT_KEY]: "{not json" })), blankForm());
  assert.deepEqual(loadDraft(null), blankForm());
});

const res = (status, body = {}, retry) => ({ status, body, headers: { get: () => retry ?? null }, json: async () => body });

test("each edge answer means what the design says", () => {
  assert.deepEqual(readConfig({ status: 200, body: { open: true, turnstileSiteKey: "1x-site" } }), { state: "open", siteKey: "1x-site" });
  assert.deepEqual(readConfig({ status: 200, body: { open: false, turnstileSiteKey: "1x-site" } }), { state: "closed" });
  assert.deepEqual(readConfig({ status: 503, body: { detail: "closed" } }), { state: "closed" });
  for (const r of [{ status: 503, body: { detail: "unavailable" } }, { status: 0, body: {} }, { status: 200, body: { open: true } }, { status: 403, body: { detail: "forbidden" } }]) assert.deepEqual(readConfig(r), { state: "unavailable" });

  assert.deepEqual(startOutcome({ status: 202, body: { ok: true } }), { ok: true });
  assert.equal(startOutcome({ status: 400, body: { detail: "invalid_email" } }).field, "email");
  assert.equal(startOutcome({ status: 429, body: { detail: "rate_limited" } }).text, "that's a lot of codes. wait an hour, then try again.");
  assert.equal(startOutcome({ status: 403, body: { detail: "bot_check_failed" } }).kind, "bot");
  assert.equal(startOutcome({ status: 503, body: { detail: "closed" } }).kind, "closed");
  assert.equal(startOutcome({ status: 503, body: { detail: "queue_full" } }).text, COPY.busy);
  assert.equal(startOutcome({ status: 503, body: { detail: "unavailable" } }).text, COPY.unavailable);
  assert.equal(startOutcome({ status: 0, body: {} }).text, COPY.unavailable);

  assert.deepEqual(verifyOutcome({ status: 200, body: { ticket: "T".repeat(43), expiresAt: 1 } }), { ok: true, ticket: "T".repeat(43) });
  assert.equal(verifyOutcome({ status: 200, body: {} }).ok, undefined);
  assert.equal(verifyOutcome({ status: 400, body: { detail: "invalid_code" } }).text, "that code didn't work. check your email for the newest one.");
  assert.equal(verifyOutcome({ status: 410, body: { detail: "code_expired" } }).resend, true);
  assert.equal(verifyOutcome({ status: 429, body: { detail: "too_many_attempts" } }).resend, true);

  assert.equal(verifyOutcome({ status: 0, body: {} }).text, COPY.unavailable); // network failure: a plain failure line, no ticket
  assert.equal(verifyOutcome({ status: 0, body: {} }).ok, undefined);
  assert.equal(submitOutcome({ status: 0, body: {} }).text, COPY.unavailable);
  assert.equal(submitOutcome({ status: 0, body: {} }).settled, undefined);

  assert.deepEqual(submitOutcome({ status: 201, body: { ok: true, state: "pending" } }), { ok: true });
  assert.deepEqual(submitOutcome({ status: 409, body: { detail: "already_requested" } }), { settled: "requested" });
  assert.deepEqual(submitOutcome({ status: 409, body: { detail: "already_member" } }), { settled: "member" });
  assert.deepEqual(submitOutcome({ status: 403, body: { detail: "ticket_expired" } }), { kind: "ticket" });
  assert.deepEqual(submitOutcome({ status: 401, body: { detail: "ticket_expired" } }), { kind: "ticket" });
  assert.equal(submitOutcome({ status: 403, body: { detail: "bot_check_failed" } }).kind, "bot");
  assert.equal(submitOutcome({ status: 429, body: { detail: "rate_limited" } }).text, COPY.busy);
  const v = submitOutcome({ status: 400, body: { detail: "validation", fields: [{ field: "birthYear", code: "year_format" }] } });
  assert.equal(v.kind, "fields");
  assert.equal(v.lines.birthYear, "just the year, like 1962.");
});

test("the edge calls: JSON POST bodies with the CSRF header, the email only in a body, never a URL or a query string", async () => {
  const seen = [];
  const api = createJoinApi(async (url, init) => { seen.push({ url, init }); return res(202, { ok: true }); });
  await api.config();
  await api.start({ email: EMAIL, turnstileToken: "tok" });
  await api.verify({ email: EMAIL, code: "123456" });
  await api.submit({ ticket: "T".repeat(43), form: formBody(GOOD), turnstileToken: "tok" });
  assert.deepEqual(seen.map((s) => s.url), ["/auth/access-request/config", "/auth/access-request/start", "/auth/access-request/verify", "/auth/access-request"]);
  for (const s of seen) {
    assert.ok(!s.url.includes("?") && !s.url.includes("#") && !s.url.includes("@") && !s.url.includes("example"), s.url);
    assert.equal(s.init.headers["x-requested-with"], "io-kit");
    assert.equal(s.init.credentials, "same-origin");
  }
  assert.equal(seen[0].init.method, "GET");
  for (const s of seen.slice(1)) {
    assert.equal(s.init.method, "POST");
    assert.equal(s.init.headers["content-type"], "application/json");
  }
  assert.deepEqual(JSON.parse(seen[1].init.body), { email: EMAIL, turnstileToken: "tok", company: "" });
  assert.deepEqual(JSON.parse(seen[2].init.body), { email: EMAIL, code: "123456" });
  const submit = JSON.parse(seen[3].init.body);
  assert.deepEqual(Object.keys(submit).sort(), ["company", "form", "ticket", "turnstileToken"]);
  assert.equal(JSON.stringify(submit.form).includes(EMAIL), false, "the submit body carries the ticket, which is bound to the address");
  // a filled honeypot is passed on for the edge to catch
  await api.start({ email: EMAIL, turnstileToken: "tok", company: "acme" });
  assert.equal(JSON.parse(seen[4].init.body).company, "acme");
});

test("a network failure is status 0, not a throw; a non-JSON body is an empty body", async () => {
  const down = createJoinApi(async () => { throw new TypeError("offline"); });
  assert.deepEqual(await down.config(), { status: 0, body: {}, retryAfter: 0 });
  const html = createJoinApi(async () => ({ status: 502, headers: { get: () => null }, json: async () => { throw new SyntaxError("x"); } }));
  assert.deepEqual(await html.start({ email: EMAIL, turnstileToken: "t" }), { status: 502, body: {}, retryAfter: 0 });
});

test("no email ever travels in a URL: the entry line is a plain /join/ link and the sources build no address-bearing href", () => {
  assert.equal(entry.JOIN_HREF, "/join/");
  assert.ok(!/[?#=@]/.test(entry.JOIN_HREF));
  for (const file of ["src/islands/join.jsx", "src/islands/join-entry.jsx", "src/lib/join.js", "src/lib/join-entry.js", "src/lib/turnstile.js"]) {
    const src = readFileSync(join(islandsDir, file), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    assert.doesNotMatch(src, /encodeURIComponent\s*\(\s*email/i, `${file}: an address in a URL`);
    assert.doesNotMatch(src, /[?&]email=/i, `${file}: an email query parameter`);
    assert.doesNotMatch(src, /href=\{[^}]*email/i, `${file}: an href built from the email`);
    assert.doesNotMatch(src, /(location\.(search|hash|href)|history\.(push|replace)State)[^;\n]*email/i, `${file}: the address pushed into the location`);
    assert.doesNotMatch(src, /localStorage/, `${file}: the draft (and everything else) is sessionStorage`);
  }
  const jsx = readFileSync(join(islandsDir, "src/islands/join.jsx"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(jsx, /sessionStorage/, "the island reaches storage only through the draft helpers");
});

test("the entry line goes to the three pages and no others, after the page's own call to action", () => {
  assert.equal(entry.pageOf("/")?.name, "home");
  assert.equal(entry.pageOf("/index.html")?.name, "home");
  assert.equal(entry.pageOf("/about/")?.name, "about");
  assert.equal(entry.pageOf("/about")?.name, "about");
  assert.equal(entry.pageOf("/contact/")?.name, "contact");
  for (const p of ["/join/", "/me/", "/posts/", "/person/", "/search/", "/privacy/", "/terms/", "/contact/x/"]) assert.equal(entry.pageOf(p), null, p);
  const doc = { querySelector: (sel) => (sel === entry.PLACES.about[0] ? { sel } : null) };
  assert.deepEqual(entry.entryTarget(doc, "/about/"), { host: { sel: "section.about-hero" }, position: "afterend", page: "about" });
  assert.equal(entry.entryTarget(doc, "/"), null, "no anchor, no line");
  assert.equal(entry.entryTarget(doc, "/posts/"), null);
});

test("Turnstile is the one third-party script, asked for by the join island with action join", () => {
  assert.equal(TURNSTILE_ACTION, "join");
  assert.match(TURNSTILE_SRC, /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  const owners = ["src/islands/join.jsx", "src/lib/turnstile.js"];
  for (const f of ["src/islands/join-entry.jsx", "src/islands/about-cta.jsx", "src/islands/shell.jsx"]) assert.doesNotMatch(readFileSync(join(islandsDir, f), "utf8"), /turnstile/i, f);
  assert.ok(owners.every((f) => /turnstile/i.test(readFileSync(join(islandsDir, f), "utf8"))));
  assert.match(readFileSync(join(islandsDir, "src/islands/join.jsx"), "utf8"), /"refresh-expired": "auto"/); // an idle token renews itself
});

test("the Legacy Form validator bundles for the islands' browser target and runs from the bundle", async () => {
  const out = await build({
    stdin: { contents: 'export * from "../shared/legacy-form.mjs";', resolveDir: islandsDir, loader: "js" },
    bundle: true, format: "esm", platform: "browser", target: ["es2020", "safari15"], minify: true, write: false, logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /\(\?<[=!]/, "a lookbehind would not run in safari15");
  assert.doesNotMatch(code, /\brequire\(|from ?"node:/);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  assert.equal(mod.validateForm({ ...formBody(GOOD), email: EMAIL }, { storeCurrentCity: false }).ok, true);
});
