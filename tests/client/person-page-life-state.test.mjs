// HFY-TSK-427 (lifeStateV1, display only): 11ty/js/person-page.js says "status unknown" for a person the shared rule finds unknown, and
// pins its own copies (the two strings, the 85 / 24 thresholds, the rule) equal to islands/src/lib/life-state-copy.js and shared/life-state.mjs.
// Loads the real script into a vm sandbox with a stub DOM. Synthetic data only. Run: node --test tests/client/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { DEFAULTS, lifeState } from "../../shared/life-state.mjs";
import { HELP_FILL_IN_COPY, HELP_FILL_IN_HREF, NO_BIRTH_YEAR_COPY, STATUS_UNKNOWN_COPY } from "../../islands/src/lib/life-state-copy.js";

const SRC = readFileSync(new URL("../../11ty/js/person-page.js", import.meta.url), "utf8");
const NOW = new Date();
const yearsAgo = (n) => NOW.getUTCFullYear() - n;

function makeEl(id = "") {
  const classes = new Set(["d-none"]);
  const el = {
    id, innerHTML: "", textContent: "", className: "", hidden: false, style: {}, parentElement: null, children: [], tagName: "DIV",
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute() {}, getAttribute: () => null, appendChild(c) { return c; }, insertBefore(c) { return c; },
    insertAdjacentElement() {}, insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [], remove() {},
    addEventListener() {}, removeEventListener() {},
  };
  return el;
}

// Renders `person` with the real script under `flags`; `evidence` is the GET /api/life-state reply (or a function that throws).
async function render(person, { flags = {}, evidence = { evidence: [], confirmed: [] }, source = SRC } = {}) {
  const els = {};
  for (const id of ["person-app", "person-loading", "person-content", "person-error", "person-hero-section", "person-hero", "person-events-section", "person-events", "hfy-person-social", "person-family-data"]) els[id] = makeEl(id);
  const panel = makeEl("panel");
  const stories = [];
  panel.insertAdjacentHTML = (where, html) => { if (html.includes("class=\"story\"")) stories.push(html); };
  els["person-stories-section"] = Object.assign(makeEl("person-stories-section"), { querySelector: (sel) => (sel === ".notes-panel" ? panel : null) });
  const handlers = {};
  const errors = [];
  const document = {
    addEventListener: (type, fn) => { handlers[type] = fn; }, dispatchEvent() {}, getElementById: (id) => els[id] || null,
    createElement: () => makeEl(), querySelector: () => null, body: makeEl("body"), title: "",
  };
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error: (...args) => errors.push(args) }, URL, URLSearchParams, CustomEvent, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    document,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.location = { search: "?id=I0001", href: "https://example.test/person/?id=I0001", origin: "https://example.test", replace() {} };
  const requests = [];
  sandbox.HFYFeatureFlags = {
    resolveFlags: async () => flags,
    dataFetch: async (url) => {
      requests.push(url);
      if (url === "/api/life-state") {
        if (typeof evidence === "function") throw new Error("boom");
        return { status: 200, ok: true, json: async () => evidence };
      }
      return { status: 200, ok: true, json: async () => person };
    }
  };
  vm.runInNewContext(source, sandbox);
  handlers.DOMContentLoaded();
  for (let i = 0; i < 300 && els["person-content"].classList.contains("d-none") && !errors.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(els["person-content"].classList.contains("d-none"), false, "the page rendered");
  return { hero: els["person-hero"].innerHTML, family: els["person-family-data"].innerHTML, stories, requests, sandbox };
}

const rel = (name, id, birth, isLiving = true) => ({ handle: `h${id}`, grampsId: id, displayName: name, isLiving, lifespan: { birth: birth ? { year: birth } : {}, death: {} } });
const person = (over = {}) => ({
  handle: "hME", grampsId: "I0001", displayName: "Old Example", isLiving: true, lifespan: { birth: { year: yearsAgo(100) }, death: {} },
  familyTree: { parentFamilies: [{ father: rel("Dad Example", "I0002", yearsAgo(120), false), mother: rel("Mum Example", "I0003", yearsAgo(95)), children: [] }],
    spouseFamilies: [{ father: null, mother: rel("Wed Example", "I0004", null), children: [rel("Kid Example", "I0005", yearsAgo(20))] }] },
  ...over
});
const lines = (hero) => /<p class="person-lifespan"[^>]*>(.*?)<\/p>/.exec(hero)?.[1] ?? "";
const strip = (h) => h.replace(/<[^>]+>/g, "");

test("flag off: today's words, and no request for life state", async () => {
  const r = await render(person(), { flags: {} });
  assert.match(strip(lines(r.hero)), new RegExp(`${yearsAgo(100)} · living$`));
  assert.ok(r.family.includes(">living<") || r.family.includes("living</span>"));
  assert.ok(!r.family.includes("status unknown") && !r.hero.includes("status unknown"));
  assert.ok(!r.requests.includes("/api/life-state"));
});

test("flag on: over 85 with no death and no evidence reads status unknown (header and family list), one request", async () => {
  const r = await render(person(), { flags: { lifeStateV1: true } });
  assert.equal(strip(lines(r.hero)), `born ${yearsAgo(100)} · status unknown`);
  assert.ok(!/living/.test(strip(r.hero)), "no 'living' in the header");
  assert.equal(r.requests.filter((u) => u === "/api/life-state").length, 1);
  const metas = [...r.family.matchAll(/<span class="family-meta">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(metas, ["father", "mother · status unknown", "birth year unknown", "living"]); // father deceased; mother 95; spouse no birth year; child 20
  assert.ok(!/status unknown[^]*status unknown[^]*status unknown/.test(r.family), "only the old relatives");
});

test("flag on: no birth year; an active member over 85; a young person; a deceased person", async () => {
  let r = await render(person({ lifespan: { birth: {}, death: {} } }), { flags: { lifeStateV1: true } });
  assert.equal(strip(lines(r.hero)), NO_BIRTH_YEAR_COPY);
  r = await render(person(), { flags: { lifeStateV1: true }, evidence: { evidence: [{ person: "I0001", at: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) }], confirmed: [] } });
  assert.equal(strip(lines(r.hero)), `${yearsAgo(100)} · living`, "active: as today");
  r = await render(person({ lifespan: { birth: { year: yearsAgo(30) }, death: {} } }), { flags: { lifeStateV1: true } });
  assert.equal(strip(lines(r.hero)), `${yearsAgo(30)} · living`);
  r = await render(person({ isLiving: false, lifespan: { birth: { year: 1900 }, death: { year: 1970 } } }), { flags: { lifeStateV1: true } });
  assert.equal(strip(lines(r.hero)), "1900 – 1970");
});

test("a failed evidence read fails closed (over 85 reads unknown), never 'living'", async () => {
  const r = await render(person(), { flags: { lifeStateV1: true }, evidence: () => {} });
  assert.equal(strip(lines(r.hero)), `born ${yearsAgo(100)} · status unknown`);
});

test("help fill in: only with lifeDatesV1, to the life dates queue", async () => {
  let r = await render(person(), { flags: { lifeStateV1: true, lifeDatesV1: true } });
  assert.ok(r.hero.includes(`<a class="person-life-help" href="${HELP_FILL_IN_HREF}">${HELP_FILL_IN_COPY}</a>`));
  r = await render(person(), { flags: { lifeStateV1: true } });
  assert.ok(!r.hero.includes("help fill in"));
});

test("stories stay for a person of unknown status (HIDE_STORIES_FOR_UNKNOWN = false); flipping it hides them", async () => {
  assert.match(SRC, /const HIDE_STORIES_FOR_UNKNOWN = false;/);
  const notes = [{ html: "<p>a synthetic story</p>", type: "Person Note" }];
  const flagged = { flags: { lifeStateV1: true } };
  const kept = await render(person({ notes }), flagged);
  assert.ok(kept.stories.length > 0, "the story is shown");
  const hidden = await render(person({ notes }), { ...flagged, source: SRC.replace("const HIDE_STORIES_FOR_UNKNOWN = false;", "const HIDE_STORIES_FOR_UNKNOWN = true;") });
  assert.equal(hidden.stories.length, 0, "flipped: hidden for an unknown person");
  const young = await render(person({ notes, lifespan: { birth: { year: yearsAgo(30) }, death: {} } }), { ...flagged, source: SRC.replace("const HIDE_STORIES_FOR_UNKNOWN = false;", "const HIDE_STORIES_FOR_UNKNOWN = true;") });
  assert.ok(young.stories.length > 0, "flipped: a person who is not unknown keeps theirs");
});

test("person-page.js pins: the strings, the thresholds and the rule equal the shared originals", async () => {
  assert.ok(SRC.includes(`const NO_BIRTH_YEAR_COPY = "${NO_BIRTH_YEAR_COPY}";`));
  assert.ok(SRC.includes(`const HELP_FILL_IN_HREF = "${HELP_FILL_IN_HREF}";`));
  assert.ok(SRC.includes(`statusUnknown: "${STATUS_UNKNOWN_COPY}"`));
  assert.ok(SRC.includes(`helpFillIn: "${HELP_FILL_IN_COPY}"`));
  assert.ok(SRC.includes(`const LS_THRESHOLD_YEARS = ${DEFAULTS.thresholdYears};`));
  assert.ok(SRC.includes(`const LS_EVIDENCE_MONTHS = ${DEFAULTS.evidenceMonths};`));
  // behaviour: expose the script's rule from a copy of the source and compare it with lifeState over a grid
  const probe = SRC.replace("  function personIdOf(person) {", "  window.__lifeIsUnknown = lifeIsUnknown;\n  function personIdOf(person) {");
  const r = await render(person(), { flags: {}, source: probe });
  const fn = r.sandbox.__lifeIsUnknown;
  assert.equal(typeof fn, "function");
  const now = new Date("2026-11-27T12:00:00Z");
  const births = [null, 0, "1941", 1941, 1940, 1939, 1980, "abc", 2026, -5];
  const days = [undefined, "2026-11-27", "2024-11-27", "2024-11-26", "2024-12-01", "2020-01-01", "2027-01-01", "nope", ""];
  for (const b of births) for (const e of days) for (const c of days.slice(0, 4)) {
    const expected = lifeState({ hasDeath: false, birthYear: b, evidenceAt: e, confirmedLivingAt: c, now }) === "unknown";
    const got = fn({ enabled: true, now, evidence: { I1: e }, confirmed: { I1: c } }, { id: "I1", living: true, birthYear: b });
    assert.equal(got, expected, `birth ${b} evidence ${e} confirmed ${c}`);
  }
  assert.equal(fn({ enabled: true, now, evidence: {}, confirmed: {} }, { id: "I1", living: false, birthYear: 1900 }), false);
  assert.equal(fn({ enabled: false, now }, { id: "I1", living: true, birthYear: 1900 }), false);
});
