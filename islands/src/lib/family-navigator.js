// <family-navigator>: the Family Card Navigator, Concept A of the visualization ADR (HFY-TSK-145, viz-mvp-visual; viz ADR section 9.1).
//
// Our own code, framework-free: no React, no shadow root (so the theme tokens, theme-lint and axe all apply to what it draws) and no
// third-party runtime module. tests/bundle.test.mjs lists the modules of the navigator chunk and fails on anything that is not ours.
//
//   const el = document.createElement("family-navigator");
//   el.graph = familyGraph;      // a FamilyGraph (lib/family-graph.js)
//   el.focus = "I9001";          // the centred person's id
//
// `focus` is a property on purpose (the ADR's contract): it shadows HTMLElement.focus() on this element. The element is not focusable
// itself (no tabindex), so nothing needs the method; its cards and tabs are the focusable parts.
//
// Events, both bubbling and composed, `detail: {id}`:
//   hfy-focus     a card other than the focus card was activated: re-centre on that person
//   hfy-details   the focus card was activated: show the details sheet (rendered by the island, never by this element)
//
// What it draws (375 px layout; the ADR's other widths are separate tasks): the focus card, a parents strip, one tab per union
// ("with <partner>" or "partner not recorded"), that union's partner and children as a scroll-snap row, and the siblings as a row.
// Every person is one <button> with an accessible name like "Ben Example, father, 1878 to unknown".
import { COPY, navigatorModel } from "./navigator-model.js";

export const TAG = "family-navigator";
export const EVENT_FOCUS = "hfy-focus";
export const EVENT_DETAILS = "hfy-details";

let serial = 0;

/** A tiny element builder: h("li", {class: "x"}, child, "text"). Text goes in as text nodes, so a name can never inject markup. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const ROLE_PAIR = { focus: "focus", parent: "parent", child: "child", sibling: "sibling", partner: "spouse" };

class Base extends (typeof HTMLElement === "undefined" ? class {} : HTMLElement) {}

export class FamilyNavigator extends Base {
  constructor() {
    super();
    this._graph = null;
    this._focus = null;
    this._union = 0;
    this._queued = false;
    this._uid = `hfy-nav-${(serial += 1)}`;
    this._onClick = (e) => this._click(e);
    this._onKey = (e) => this._key(e);
  }

  get graph() { return this._graph; }
  set graph(g) { this._graph = g || null; this._union = 0; this._queue(); }
  get focus() { return this._focus; }
  set focus(id) {
    const next = id || null;
    if (next !== this._focus) this._union = 0;
    this._focus = next;
    this._queue();
  }

  connectedCallback() {
    this.addEventListener("click", this._onClick);
    this.addEventListener("keydown", this._onKey);
    this._render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this._onClick);
    this.removeEventListener("keydown", this._onKey);
  }

  // Setting graph and focus one after the other renders once.
  _queue() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; this._render(); });
  }

  _emit(name, id) {
    this.dispatchEvent(new CustomEvent(name, { detail: { id }, bubbles: true, composed: true }));
  }

  _click(e) {
    const card = e.target.closest?.("[data-person]");
    if (card && this.contains(card)) {
      this._emit(card.getAttribute("data-role") === "focus" ? EVENT_DETAILS : EVENT_FOCUS, card.getAttribute("data-person"));
      return;
    }
    const tab = e.target.closest?.("[role=tab]");
    if (tab && this.contains(tab)) this._select(Number(tab.getAttribute("data-union")));
  }

  // The tab pattern's arrow keys. Nothing else is handled here: cards are buttons, so Enter and Space already activate them.
  _key(e) {
    const tab = e.target.closest?.("[role=tab]");
    if (!tab || !this.contains(tab) || e.altKey || e.ctrlKey || e.metaKey) return;
    const tabs = [...this.querySelectorAll("[role=tab]")];
    const at = tabs.indexOf(tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    this._select((to + tabs.length) % tabs.length);
  }

  _select(i) {
    if (!Number.isInteger(i) || i === this._union) return;
    this._union = i;
    this._render();
  }

  _card(c) {
    const isFocus = c.kind === "focus";
    const role = ROLE_PAIR[c.kind];
    const face = c.face ? h("img", { class: "hfy-nav__face", src: c.face, alt: "", width: 160, height: 160, loading: "lazy", decoding: "async" }) : null;
    if (face) face.addEventListener("error", () => face.replaceWith(h("span", { class: "hfy-nav__initials", "aria-hidden": "true" }, c.initials)), { once: true });
    return h(
      "button",
      { type: "button", class: `hfy-nav__card${isFocus ? " hfy-nav__card--focus" : ""}`, "data-person": c.id, "data-role": c.kind, "data-key": `card:${c.id}`, "aria-label": c.label },
      h("span", { class: "hfy-nav__avatar", "data-pair": role, "aria-hidden": "true" }, face || h("span", { class: "hfy-nav__initials" }, c.initials)),
      h(
        "span",
        { class: "hfy-nav__text" },
        h("span", { class: "hfy-nav__name" }, c.name),
        c.role ? h("span", { class: "hfy-nav__role" }, c.role) : null,
        h("span", { class: "hfy-nav__years" }, c.years),
        c.place ? h("span", { class: "hfy-nav__place" }, c.place) : null,
        c.badges.length ? h("span", { class: "hfy-nav__badges" }, c.badges.map((b) => h("span", { class: "hfy-nav__badge" }, b))) : null
      )
    );
  }

  _row(cards, label) {
    return h("ul", { class: "hfy-nav__row", "aria-label": label }, cards.map((c) => h("li", { class: "hfy-nav__item" }, this._card(c))));
  }

  _section(id, title, ...body) {
    return h("section", { class: "hfy-nav__block", "aria-labelledby": `${this._uid}-${id}` }, h("h3", { id: `${this._uid}-${id}`, class: "hfy-nav__heading" }, title), ...body);
  }

  _unions(m) {
    const title = "partners and children";
    if (!m.unions.length) return this._section("unions", title, h("p", { class: "hfy-nav__none" }, COPY.noUnions));
    const at = Math.min(this._union, m.unions.length - 1);
    const u = m.unions[at];
    const tabs = h(
      "div",
      { class: "hfy-nav__tabs", role: "tablist", "aria-label": "partner families" },
      m.unions.map((x, i) => h("button", {
        type: "button", role: "tab", class: "hfy-nav__tab", id: `${this._uid}-tab-${i}`, "data-union": i, "data-key": `tab:${i}`,
        "aria-selected": i === at ? "true" : "false", "aria-controls": `${this._uid}-panel`, tabindex: i === at ? "0" : "-1"
      }, x.tab))
    );
    const panel = h(
      "div",
      { class: "hfy-nav__panel", role: "tabpanel", id: `${this._uid}-panel`, "aria-labelledby": `${this._uid}-tab-${at}` },
      u.partner ? h("div", { class: "hfy-nav__partner" }, this._card(u.partner)) : null,
      u.children.length ? this._row(u.children, `children, ${u.tab}`) : h("p", { class: "hfy-nav__none" }, COPY.childrenNone)
    );
    return this._section("unions", title, tabs, panel);
  }

  _render() {
    if (!this.isConnected) return;
    const had = this.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null;
    const m = this._graph && this._focus ? navigatorModel(this._graph, this._focus) : null;
    if (!m) { this.replaceChildren(); return; }
    const title = `family chart centred on ${m.name}. the outline has the same information.`;
    const parents = m.parents.cards.length
      ? h(
        "ul", { class: "hfy-nav__strip", "aria-label": "parents" },
        m.parents.cards.map((c) => h("li", { class: "hfy-nav__item" }, this._card(c))),
        m.parents.placeholder ? h("li", { class: "hfy-nav__item" }, h("p", { class: "hfy-nav__missing" }, m.parents.placeholder)) : null
      )
      : h("p", { class: "hfy-nav__none" }, m.parents.message);
    const root = h(
      "section", { class: "hfy-nav", "aria-labelledby": `${this._uid}-title`, "data-nav-focus": m.id },
      h("h2", { id: `${this._uid}-title`, class: "hfy-nav__title" }, title),
      m.notice ? h("p", { class: "hfy-nav__notice", "data-nav-notice": "" }, m.notice) : null,
      h("div", { class: "hfy-nav__focus" }, this._card(m.focus)),
      this._section("parents", "parents", parents),
      this._unions(m),
      m.siblings.length ? this._section("siblings", "brothers and sisters", this._row(m.siblings, "brothers and sisters")) : null
    );
    this.replaceChildren(root);
    // A re-render must not drop the keyboard: put focus back on the same control (a card that became the focus card has the same key).
    if (had) (this.querySelector(`[data-key="${had}"]`) || this.querySelector(".hfy-nav__card--focus"))?.focus({ preventScroll: true });
  }
}

/**
 * Listen for the element's two events. `onFocus(id)` re-centres; `onDetails(id)` opens the sheet. Returns the unbind function.
 * Pure DOM, no React: tests/family-navigator.test.mjs dispatches each event on a plain EventTarget.
 */
export function bindNavigatorEvents(target, { onFocus, onDetails }) {
  const focus = (e) => { if (typeof e.detail?.id === "string") onFocus(e.detail.id); };
  const details = (e) => { if (typeof e.detail?.id === "string") onDetails(e.detail.id); };
  target.addEventListener(EVENT_FOCUS, focus);
  target.addEventListener(EVENT_DETAILS, details);
  return () => {
    target.removeEventListener(EVENT_FOCUS, focus);
    target.removeEventListener(EVENT_DETAILS, details);
  };
}

/** Define <family-navigator> once; throws when the browser refuses (the caller turns that into the chart's fallback). */
export function defineFamilyNavigator() {
  if (typeof customElements === "undefined") throw new Error("custom elements are not available");
  if (!customElements.get(TAG)) customElements.define(TAG, FamilyNavigator);
  return FamilyNavigator;
}
