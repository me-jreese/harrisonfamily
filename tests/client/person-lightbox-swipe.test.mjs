// HFY-TSK-406: the person-page lightbox swipe (swipe down >= 80 px closes, sideways >= 80 px steps to the next/previous photo) is inert while the tag editor is open.
// The islands editor marks the open editor with `photo-tag-edit-on` on the modal (person-tag-editor.jsx setEditing). Run: node --test tests/client/*.test.mjs.
// Loads the real 11ty/js/person-page.js into a vm sandbox with a small stub DOM, opens the lightbox on the second of three synthetic photos and fires touch events
// on the modal body. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../11ty/js/person-page.js", import.meta.url), "utf8");

function makeEl(id = "", tag = "DIV") {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  const el = {
    id, innerHTML: "", textContent: "", className: "", hidden: false, style: {}, parentElement: null, children: [], tagName: tag, disabled: false,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
    },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => attrs.delete(k),
    appendChild(c) { c.parentElement = el; return c; }, insertBefore(c) { c.parentElement = el; return c; },
    insertAdjacentElement() {}, insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, removeEventListener() {},
    fire(type, event) { for (const fn of listeners[type] || []) fn(event); },
  };
  return el;
}

// Renders a person with three photos, opens the second in the lightbox and returns the pieces the swipe tests need.
async function lightbox() {
  const els = {};
  for (const id of ["person-app", "person-loading", "person-content", "person-error", "person-hero-section", "person-hero", "person-events-section", "person-events", "hfy-person-social",
    "person-media-grid", "mediaLightbox", "mediaLightboxImage", "mediaLightboxCaption", "mediaLightboxMeta", "mediaLightboxCounter", "mediaLightboxSpinner", "mediaLightboxDownload"]) els[id] = makeEl(id);
  els["person-content"].classList.add("d-none");
  const body = makeEl("modal-body");
  els.mediaLightbox.querySelector = (sel) => (sel === ".modal-body" ? body : null);
  const panel = makeEl("panel");
  els["person-stories-section"] = Object.assign(makeEl("person-stories-section"), { querySelector: (sel) => (sel === ".notes-panel" ? panel : null) });
  const handlers = {};
  const errors = [];
  const document = {
    addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {}, dispatchEvent() {}, getElementById: (id) => els[id] || null,
    createElement: () => makeEl(), querySelector: () => null, body: makeEl("body"), title: "",
  };
  const shown = [];
  const hidden = [];
  class Modal { constructor(el) { this.el = el; } show() { shown.push(this); } hide() { hidden.push(this); } }
  class FakeImage { set src(v) { this._src = v; } get src() { return this._src; } }
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error: (...args) => errors.push(args) }, URL, URLSearchParams, CustomEvent, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    document, Image: FakeImage,
  };
  sandbox.window = sandbox;
  sandbox.bootstrap = { Modal };
  sandbox.addEventListener = () => {};
  sandbox.location = { search: "?id=I0001", href: "https://example.test/person/?id=I0001", origin: "https://example.test", replace() {} };
  const person = { displayName: "Test Person (synthetic)", events: [], mediaGallery: [1, 2, 3].map((n) => ({ handle: `h${n}`, title: `Photo ${n}`, mime: "image/jpeg" })) };
  sandbox.HFYFeatureFlags = { dataFetch: async () => ({ status: 200, ok: true, json: async () => person }) };
  vm.runInNewContext(SRC, sandbox);
  handlers.DOMContentLoaded();
  for (let i = 0; i < 200 && els["person-content"].classList.contains("d-none") && !errors.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [], "the page rendered without an error");
  const trigger = makeEl("trigger", "BUTTON");
  trigger.setAttribute("data-media-index", "1");
  els["person-media-grid"].fire("click", { target: { closest: () => trigger }, preventDefault() {} });
  assert.equal(shown.length, 1, "the lightbox opened");
  assert.equal(els.mediaLightboxCounter.textContent, "2 of 3");
  const touch = (x, y) => ({ clientX: x, clientY: y });
  const swipe = (dx, dy) => {
    body.fire("touchstart", { touches: [touch(200, 300)] });
    body.fire("touchend", { touches: [], changedTouches: [touch(200 + dx, 300 + dy)] });
  };
  return { swipe, hidden, counter: () => els.mediaLightboxCounter.textContent, editing: (on) => els.mediaLightbox.classList.toggle("photo-tag-edit-on", on) };
}

test("editor closed: a swipe down of 150 px closes the lightbox", async () => {
  const lb = await lightbox();
  lb.swipe(0, 150);
  assert.equal(lb.hidden.length, 1);
});

test("editor open: the same swipe down does not close the lightbox", async () => {
  const lb = await lightbox();
  lb.editing(true);
  lb.swipe(0, 150);
  assert.equal(lb.hidden.length, 0);
});

test("editor open, then closed again: the swipe works again", async () => {
  const lb = await lightbox();
  lb.editing(true);
  lb.swipe(0, 150);
  lb.editing(false);
  lb.swipe(0, 150);
  assert.equal(lb.hidden.length, 1);
});

test("editor closed: a sideways swipe of 120 px steps to the next or previous photo", async () => {
  const lb = await lightbox();
  lb.swipe(-120, 0);
  assert.equal(lb.counter(), "3 of 3");
  lb.swipe(120, 0);
  assert.equal(lb.counter(), "2 of 3");
  assert.equal(lb.hidden.length, 0);
});

test("editor open: a sideways swipe does not step, in either direction", async () => {
  const lb = await lightbox();
  lb.editing(true);
  lb.swipe(-120, 0);
  lb.swipe(120, 0);
  assert.equal(lb.counter(), "2 of 3");
  assert.equal(lb.hidden.length, 0);
});

test("a gesture that starts while the editor is open and ends after it closed does nothing", async () => {
  const lb = await lightbox();
  lb.editing(true);
  lb.swipe(0, 0); // touchstart ignored while editing
  lb.editing(false);
  lb.swipe(0, 40); // below the threshold
  assert.equal(lb.hidden.length, 0);
});
