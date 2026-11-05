// The date of a Life row on the person page (HFY-TSK-373; sync design 5.2 blanks `date.text` of every birth-like event in the cloud
// renderer's output and keeps the structured `year`). Run: node --test tests/client/*.test.mjs. Loads the real 11ty/js/person-page.js into
// a vm sandbox with a small stub DOM, fires DOMContentLoaded with a synthetic person and reads what renderEvents and renderLifespan wrote.
// Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../11ty/js/person-page.js", import.meta.url), "utf8");

function makeEl(id = "") {
  const classes = new Set(["d-none"]);
  const attrs = new Map();
  const el = {
    id, innerHTML: "", textContent: "", className: "", hidden: false, style: {}, parentElement: null, children: [], tagName: "DIV",
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    appendChild(c) { c.parentElement = el; return c; }, insertBefore(c) { c.parentElement = el; return c; },
    insertAdjacentElement() {}, insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [], remove() {},
    addEventListener() {}, removeEventListener() {},
  };
  return el;
}

// Renders `person` with the real script; resolves { events, hero } as the HTML the page wrote.
async function render(person) {
  const els = {};
  for (const id of ["person-app", "person-loading", "person-content", "person-error", "person-hero-section", "person-hero", "person-events-section", "person-events", "hfy-person-social"]) els[id] = makeEl(id);
  const panel = makeEl("panel");
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
  sandbox.HFYFeatureFlags = { dataFetch: async () => ({ status: 200, ok: true, json: async () => person }) };
  vm.runInNewContext(SRC, sandbox);
  handlers.DOMContentLoaded();
  for (let i = 0; i < 200 && els["person-content"].classList.contains("d-none") && !errors.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [], "the page rendered without an error");
  assert.equal(els["person-content"].classList.contains("d-none"), false, "the page rendered");
  return { events: els["person-events"].innerHTML, hero: els["person-hero"].innerHTML };
}

const dateCells = (html) => [...html.matchAll(/<span class="timeline-date">([^<]*)<\/span>/g)].map((m) => m[1]);
const withDate = (date) => ({ displayName: "Test Person (synthetic)", events: [{ label: "Birth", date }] });
const cellFor = async (date) => dateCells((await render(withDate(date))).events);

test("text present: shown as it is (escaped), whatever the year says", async () => {
  assert.deepEqual(await cellFor({ text: "about 1900", year: 1901 }), ["about 1900"]);
  assert.deepEqual(await cellFor({ text: "1900-03-02" }), ["1900-03-02"]);
  assert.deepEqual(await cellFor({ text: "<b>1900</b> & \"x\"", year: 1900 }), ["&lt;b&gt;1900&lt;/b&gt; &amp; &quot;x&quot;"]);
});

test("text empty, a positive whole year: the year as digits", async () => {
  assert.deepEqual(await cellFor({ text: "", year: 1950 }), ["1950"]);
  assert.deepEqual(await cellFor({ year: 1874 }), ["1874"]);
  assert.deepEqual(await cellFor({ text: null, year: 7 }), ["7"]);
});

test("text empty and no year: the unknown wording (a null date, an empty object, a null year)", async () => {
  assert.deepEqual(await cellFor(null), ["date unknown"]);
  assert.deepEqual(await cellFor(undefined), ["date unknown"]);
  assert.deepEqual(await cellFor({}), ["date unknown"]);
  assert.deepEqual(await cellFor({ text: "", year: null }), ["date unknown"]);
  assert.deepEqual(await cellFor({ text: "" }), ["date unknown"]);
});

test("year zero or negative: the unknown wording", async () => {
  assert.deepEqual(await cellFor({ text: "", year: 0 }), ["date unknown"]);
  assert.deepEqual(await cellFor({ text: "", year: -0 }), ["date unknown"]);
  assert.deepEqual(await cellFor({ text: "", year: -1950 }), ["date unknown"]);
});

test("a year that is not a whole number: the unknown wording (a string, a fraction, NaN, Infinity, a huge number, other types)", async () => {
  for (const year of ["1950", " 1950 ", "", 1950.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, 2 ** 60, true, [1950], { year: 1950 }]) {
    assert.deepEqual(await cellFor({ text: "", year }), ["date unknown"], String(year));
  }
});

test("a rendered year is digits only", async () => {
  for (const year of [1, 1950, 2026, 9999, Number.MAX_SAFE_INTEGER]) {
    const [cell] = await cellFor({ text: "", year });
    assert.match(cell, /^[0-9]+$/, String(year));
    assert.equal(cell, String(year));
  }
});

test("no month or day can appear: nothing but the year is read from the date object", async () => {
  const date = {
    text: "", year: 1950, month: 3, day: 14, modifier: 3, quality: 1, calendar: 1,
    dateval: [14, 3, 1950, false], sortval: 2433000, iso: "1950-03-14", display: "14 March 1950", monthName: "march", full: "14 mar 1950",
  };
  const [cell] = await cellFor(date);
  assert.equal(cell, "1950");
  assert.doesNotMatch(cell, /march|mar\b|14|03|-/i);
  // the same object with no usable year shows no part of it either
  const [none] = await cellFor({ ...date, year: 0 });
  assert.equal(none, "date unknown");
});

test("rows keep their order and each event is judged alone; the label, note and place are as before", async () => {
  const { events } = await render({
    displayName: "Test Person (synthetic)",
    events: [
      { label: "Birth", date: { text: "", year: 1900 }, place: { displayName: "Example Parish, Louisiana" } },
      { label: "Event", description: "A synthetic note.", date: null },
      { label: "Death", date: { text: "1975", year: 1975 } },
      { label: "Baptism", date: { text: "", year: "1901" } },
    ],
  });
  assert.deepEqual(dateCells(events), ["1900", "date unknown", "1975", "date unknown"]);
  assert.match(events, /<span class="timeline-event">birth<\/span>/);
  assert.match(events, /<span class="timeline-event">event<\/span>\s*<span class="timeline-note">A synthetic note\.<\/span>/);
  assert.match(events, /<span class="timeline-place">Example Parish, Louisiana<\/span>/);
});

test("the hero lifespan line is unchanged (it reads the structured birth and death year, never a date text)", async () => {
  const person = { displayName: "Test Person (synthetic)", lifespan: { birth: { year: 1900, place: { displayName: "Example Parish" } }, death: { year: 1975 } }, events: [{ label: "Birth", date: { text: "", year: 1900 } }] };
  assert.match((await render(person)).hero, /<p class="person-lifespan">1900 – 1975 · Example Parish<\/p>/);
});
