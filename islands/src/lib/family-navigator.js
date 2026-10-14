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
// Two layouts, one element. Below 43rem (the phone) it draws the 375 px layout described next. From 43rem (HFY-TSK-299, viz-mvp-visual-desktop; ADR 4.5)
// it draws the four-row card grid: grandparents (up to four, a dashed "not recorded" card for a missing one), parents, the focus family (the
// brothers and sisters beside the focus card, the selected partner beside it, the other unions as tabs) and the children. There is no pan or
// zoom: a row wider than its column shows its first cards and a "+N more" button that expands it in place (the cards never shrink, and no name
// is below 16 px). The element picks the layout from matchMedia and redraws when the window crosses 43rem; the detail panel and the
// "generations" Sheet are the island's (lib/tree-chart.jsx).
//
// Moving about (HFY-TSK-300, viz-mvp-visual-nav; ADR 4.2 and 9.1):
//   - six visible buttons, always drawn: to parents, to children, previous and next sibling, previous and next partner family (navigator-model
//     navMoves). The first four re-centre (hfy-focus); the partner-family pair selects a tab. A button with nowhere to go is aria-disabled and
//     stays in the tab order, so the keyboard is never dropped by a press at the end of a list.
//   - arrow keys walk the cards (_step): up to the parents (and from a parent to its parents), down to the children, left and right along a
//     line, and from the partner card on to the next or previous partner family. Enter and Space are the buttons' own. No letter or digit does
//     anything. A key with no card to go to is left to the page, which scrolls.
//   - touch: the element handles no touch event. It sets touch-action: pan-y, and only the children row, the siblings row and the tabs scroll
//     sideways, natively (family-navigator.css), so a vertical drag that starts on a card scrolls the page.
//   - after a re-centre that the keyboard started, focus is put on the new focus card (the one place the new person's name is a control);
//     a re-centre from the outline or Back is the page's (tree.jsx moves focus to the focus navigator's heading).
//     AC3 AMENDMENT (recorded in the acceptance evidence): the AC says "focus moves to the new focus card's heading". A heading cannot be put
//     inside a <button>, and arrow-key walking needs the keyboard to stay on the cards, so for a re-centre started in the cards the "heading" is
//     the focus card button, whose accessible name leads with the person's name. The page's plain h2 gets focus on the outline and Back paths.
//   - the element has no live region. The island's one polite region announces each re-centre (tree.jsx).
//
// The 375 px layout draws: the focus card, a parents strip, one tab per union
// ("with <partner>" or "partner not recorded"), that union's partner and children as a scroll-snap row, and the siblings as a row.
// Every person is one <button> with an accessible name like "Ben Example, father, 1878 to unknown". The focus card's name is "Ada Example,
// focus, 1878 to unknown, show details".
//
// Recorded deviation from the HFY-TSK-201 addendum (person names in tree UI outside the SVG use the PersonName helper, so a name is a link):
// a card here is a re-centre control (a <button>), and a link cannot be nested in a button, so the card's name is plain text inside it.
// The person link is carried where a link is valid: the details Sheet (its title, the parents, the partner and the children are PersonName
// links, and "view page" goes to the person) and the generation outline. tests/tree.spec.mjs "hfy-details" asserts those links.
import { COPY, navMoves, navigatorModel } from "./navigator-model.js";

export const TAG = "family-navigator";
export const EVENT_FOCUS = "hfy-focus";
export const EVENT_DETAILS = "hfy-details";

let serial = 0;
/** How long after this element emitted hfy-focus a focus change still counts as the answer to it. */
const ASK_WINDOW_MS = 1000;

/** A tiny element builder: h("li", {class: "x"}, child, "text"). Text goes in as text nodes, so a name can never inject markup. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const ROLE_PAIR = { focus: "focus", parent: "parent", grandparent: "grandparent", child: "child", sibling: "sibling", partner: "spouse" };

/** The width from which the four-row grid replaces the phone layout (viz ADR 4.5: 43rem). */
export const WIDE_QUERY = "(min-width: 43rem)";

class Base extends (typeof HTMLElement === "undefined" ? class {} : HTMLElement) {}

export class FamilyNavigator extends Base {
  constructor() {
    super();
    this._graph = null;
    this._focus = null;
    this._union = 0;
    this._queued = false;
    this._wide = false;
    this._mq = null;
    this._ro = null;
    this._frame = 0;
    this._expanded = new Set();
    this._moves = [];
    this._ring = [];
    this._refocus = false;
    this._askedAt = -Infinity;
    this._entering = false;
    this._uid = `hfy-nav-${(serial += 1)}`;
    this._onClick = (e) => this._click(e);
    this._onKey = (e) => this._key(e);
    this._onMedia = () => this._media();
  }

  get graph() { return this._graph; }
  set graph(g) { this._graph = g || null; this._union = 0; this._expanded.clear(); this._queue(); }
  get focus() { return this._focus; }
  set focus(id) {
    const next = id || null;
    if (next !== this._focus) {
      this._union = 0;
      this._expanded.clear();
      // A re-centre this element asked for, with the keyboard still in it, puts the keyboard on the new focus card. One the page made (Back,
      // forward, the outline) is the page's to focus, even if document.activeElement is still inside here. A re-centre (not the first draw) eases in.
      this._refocus = Date.now() - this._askedAt < ASK_WINDOW_MS && this.contains(document.activeElement);
      this._askedAt = -Infinity;
      this._entering = this._focus !== null;
    }
    this._focus = next;
    this._queue();
  }

  connectedCallback() {
    this.addEventListener("click", this._onClick);
    this.addEventListener("keydown", this._onKey);
    if (typeof matchMedia === "function") {
      this._mq = matchMedia(WIDE_QUERY);
      this._wide = this._mq.matches;
      this._mq.addEventListener?.("change", this._onMedia);
    }
    // The rows' "+N more" depends on the column's width: refit when it changes (a window resize, the panel opening, a font arriving).
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this._refit());
      this._ro.observe(this);
    }
    // A web font arriving changes the cards' widths without changing the column's: refit then too.
    document.fonts?.ready?.then(() => this._refit(true), () => {});
    this._render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this._onClick);
    this.removeEventListener("keydown", this._onKey);
    this._mq?.removeEventListener?.("change", this._onMedia);
    this._mq = null;
    this._ro?.disconnect();
    this._ro = null;
    this._retry = false;
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
  }

  // The window crossed 43rem: redraw in the other layout, keeping the keyboard where it was.
  _media() {
    const wide = Boolean(this._mq?.matches);
    if (wide === this._wide) return;
    this._wide = wide;
    this._render();
  }

  // Setting graph and focus one after the other renders once.
  _queue() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; this._render(); });
  }

  _emit(name, id) {
    // The element itself asked for this re-centre (a tap, Enter/Space or a move button): note it, so the focus setter can tell it from a re-centre
    // the page made (Back, forward, the outline) while the keyboard happened to still be inside the element. Expires, in case the page declined.
    if (name === EVENT_FOCUS) this._askedAt = Date.now();
    this.dispatchEvent(new CustomEvent(name, { detail: { id }, bubbles: true, composed: true }));
  }

  _click(e) {
    const more = e.target.closest?.("[data-more]");
    if (more && this.contains(more)) {
      const key = more.getAttribute("data-more");
      if (this._expanded.has(key)) this._expanded.delete(key); else this._expanded.add(key);
      this._render(`more:${key}`);
      return;
    }
    const move = e.target.closest?.("[data-move]");
    if (move && this.contains(move)) {
      if (move.getAttribute("aria-disabled") === "true") return;
      const key = move.getAttribute("data-move");
      const mv = this._moves.find((x) => x.key === key);
      if (mv?.to) this._emit(EVENT_FOCUS, mv.to);
      else if (mv && mv.union !== null) this._select(mv.union, `move:${key}`);
      return;
    }
    const card = e.target.closest?.("[data-person]");
    if (card && this.contains(card)) {
      this._emit(card.getAttribute("data-role") === "focus" ? EVENT_DETAILS : EVENT_FOCUS, card.getAttribute("data-person"));
      return;
    }
    const tab = e.target.closest?.("[role=tab]");
    if (tab && this.contains(tab)) this._select(Number(tab.getAttribute("data-union")), `tab:${tab.getAttribute("data-union")}`);
  }

  // The keys: the tab pattern's arrows on a tab, the card walk on a card or a "+N more" button. Nothing else is handled (no single-character
  // shortcuts), and Enter and Space are the buttons' own.
  _key(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tab = e.target.closest?.("[role=tab]");
    if (tab && this.contains(tab)) {
      const tabs = [...this.querySelectorAll("[role=tab]")];
      const at = tabs.indexOf(tab);
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = (to + tabs.length) % tabs.length;
      // Focus follows the tab (the WAI-ARIA tab pattern): without this _render would refocus the OLD tab, which is now tabindex -1.
      this._select(next, `tab:${next}`);
      return;
    }
    if (e.shiftKey) return; // the card walk is unshifted arrows only; the tabs above keep their own Shift behaviour as before
    const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
    const from = e.target.closest?.("[data-person], [data-more]");
    if (!dir || !from || !this.contains(from)) return;
    const to = this._step(from, dir);
    if (!to) return; // nowhere to go: the key stays the page's (an arrow scrolls)
    e.preventDefault();
    if (to instanceof Element) to.focus();
    else this._select(to.union, "role:partner");
  }

  // Where an arrow key goes from `from`: a card or "+N more" button to focus, {union: i} to select another partner family, or null.
  // Cards carry data-line (the row they are drawn in) and data-role; hidden ones (behind "+N more") are skipped.
  _step(from, dir) {
    const lineOf = (el) => el.getAttribute("data-line") || el.closest("ul")?.querySelector("[data-line]")?.getAttribute("data-line") || "";
    const items = [...this.querySelectorAll("[data-person], [data-more]")].filter((el) => !el.closest("[hidden]"));
    const roleOf = (el) => el.getAttribute("data-role");
    const first = (pick) => items.find(pick) || null;
    const role = roleOf(from);
    if (dir === "left" || dir === "right") {
      const step = dir === "left" ? -1 : 1;
      // Stacked, the brothers and sisters are a separate row from the focus card, so the focus card and the brothers and sisters walk one
      // chain in birth order (the same order as the previous and next sibling buttons).
      if ((role === "focus" || role === "sibling") && !this._wide) {
        const at = this._ring.indexOf(from.getAttribute("data-person"));
        const to = at < 0 ? undefined : this._ring[at + step];
        return to ? first((el) => el.getAttribute("data-person") === to) : null;
      }
      const line = lineOf(from);
      const same = items.filter((el) => lineOf(el) === line);
      const next = same[same.indexOf(from) + step];
      if (next) return next;
      if (role === "partner") {
        const to = this._union + step;
        return to >= 0 && to < (this._unionCount || 0) ? { union: to } : null;
      }
      return null;
    }
    // Up and down are meanings, not screen positions: up is towards the parents, down towards the children. Stacked (the phone), the partner's
    // card sits between the focus card and the children, so it is a step on the way down.
    const partner = first((el) => roleOf(el) === "partner");
    const focus = first((el) => roleOf(el) === "focus");
    const child = first((el) => roleOf(el) === "child");
    const parent = first((el) => roleOf(el) === "parent");
    if (dir === "up") {
      if (role === "grandparent") return null;
      if (role === "child") return !this._wide && partner ? partner : focus;
      if (role === "partner" && !this._wide) return focus;
      if (role === "parent") return first((el) => roleOf(el) === "grandparent" && el.getAttribute("data-via") === from.getAttribute("data-pi"));
      return parent; // the focus, the partner (grid) and the brothers and sisters: up to the parents
    }
    if (role === "child" || from.hasAttribute("data-more")) return null;
    if (role === "grandparent") return first((el) => roleOf(el) === "parent" && el.getAttribute("data-pi") === from.getAttribute("data-via"));
    if (role === "parent") return focus;
    if (role === "focus" && !this._wide && partner) return partner;
    return child; // the focus, the partner and the brothers and sisters: down to the children
  }

  // `focusKey` is the data-key the render puts keyboard focus on; omitted, focus stays on whatever had it.
  _select(i, focusKey = null) {
    if (!Number.isInteger(i) || i === this._union) return;
    this._union = i;
    this._render(focusKey);
  }

  _card(c, line = null, extra = {}) {
    const isFocus = c.kind === "focus";
    const role = ROLE_PAIR[c.kind];
    const face = c.face ? h("img", { class: "hfy-nav__face", src: c.face, alt: "", width: 160, height: 160, loading: "lazy", decoding: "async" }) : null;
    if (face) face.addEventListener("error", () => face.replaceWith(h("span", { class: "hfy-nav__initials", "aria-hidden": "true" }, c.initials)), { once: true });
    return h(
      "button",
      { type: "button", class: `hfy-nav__card${isFocus ? " hfy-nav__card--focus" : ""}`, "data-person": c.id, "data-role": c.kind, "data-line": line, "data-pi": extra.pi, "data-via": extra.via, "data-key": `card:${c.id}`, "aria-label": c.label },
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

  _row(cards, label, line) {
    return h("ul", { class: "hfy-nav__row", "aria-label": label }, cards.map((c) => h("li", { class: "hfy-nav__item" }, this._card(c, line))));
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
      u.partner ? h("div", { class: "hfy-nav__partner" }, this._card(u.partner, "partner")) : null,
      u.children.length ? this._row(u.children, `children, ${u.tab}`, "kids") : h("p", { class: "hfy-nav__none" }, COPY.childrenNone)
    );
    return this._section("unions", title, tabs, panel);
  }

  // The six movement buttons (navMoves): always all six, the ones with nowhere to go aria-disabled.
  _toolbar() {
    return h(
      "div", { class: "hfy-nav__moves", role: "group", "aria-label": "move around the family" },
      this._moves.map((mv) => h("button", {
        type: "button", class: "hfy-nav__move", "data-move": mv.key, "data-key": `move:${mv.key}`, "aria-label": mv.label,
        "aria-disabled": mv.to === null && mv.union === null ? "true" : null
      }, mv.text))
    );
  }

  // ---- the four-row grid (from 43rem) ----

  _missing(text) { return h("p", { class: "hfy-nav__missing" }, text); }

  /**
   * One line of cards that may be longer than its column. `key` names it for "+N more" (this._expanded holds the open ones); _fit hides the
   * cards that do not fit and writes the button. The cards are never scaled: they keep their width and the rest waits behind the button.
   */
  _line(key, label, nodes, cls = "") {
    const open = this._expanded.has(key);
    const items = nodes.map((n) => h("li", { class: "hfy-nav__item" }, n));
    if (items.length > 1) {
      items.push(h("li", { class: "hfy-nav__item hfy-nav__item--more", "data-more-item": "", hidden: true }, h("button", { type: "button", class: "hfy-nav__more", "data-more": key, "data-key": `more:${key}`, "data-label": label, "aria-expanded": open ? "true" : "false" })));
    }
    return h("ul", { class: `hfy-nav__line ${cls}`.trim(), "aria-label": label, "data-fit": key, "data-expanded": open ? "" : null }, items);
  }

  _band(id, title, ...body) {
    return h("section", { class: `hfy-nav__block hfy-nav__band hfy-nav__band--${id}`, "aria-labelledby": `${this._uid}-${id}` }, h("h3", { id: `${this._uid}-${id}`, class: "hfy-nav__heading" }, title), ...body);
  }

  _renderWide(m) {
    const gp = m.grandparents;
    const grandparents = this._band(
      "grandparents", "grandparents",
      gp.message ? h("p", { class: "hfy-nav__none" }, gp.message) : this._line("gp", "grandparents", gp.cards.map((c, i) => (c ? this._card(c, "gp", { via: Math.floor(i / 2) }) : this._missing(COPY.grandparentMissing))), "hfy-nav__line--center")
    );
    const parentNodes = [...m.parents.cards.map((c, i) => this._card(c, "parents", { pi: i })), ...(m.parents.placeholder ? [this._missing(m.parents.placeholder)] : [])];
    const parents = this._band("parents", "parents", parentNodes.length ? this._line("parents", "parents", parentNodes, "hfy-nav__line--center") : h("p", { class: "hfy-nav__none" }, m.parents.message));

    const at = Math.min(this._union, Math.max(m.unions.length - 1, 0));
    const u = m.unions[at] || null;
    const tabbed = m.unions.length > 1;
    const family = this._band(
      "family", "family",
      h(
        "div", { class: "hfy-nav__famrow" },
        h("div", { class: "hfy-nav__cell hfy-nav__cell--sibs" }, m.siblings.length ? this._line("sibs", "brothers and sisters", m.siblings.map((c) => this._card(c, "family"))) : null),
        h("div", { class: "hfy-nav__cell hfy-nav__cell--focus hfy-nav__focus" }, this._card(m.focus, "family")),
        h("div", { class: "hfy-nav__cell hfy-nav__cell--partner" }, u ? (u.partner ? this._card(u.partner, "family") : this._missing(COPY.partnerMissing)) : null)
      ),
      tabbed
        ? h(
          "div", { class: "hfy-nav__tabs", role: "tablist", "aria-label": "partner families" },
          m.unions.map((x, i) => h("button", {
            type: "button", role: "tab", class: "hfy-nav__tab", id: `${this._uid}-tab-${i}`, "data-union": i, "data-key": `tab:${i}`,
            "aria-selected": i === at ? "true" : "false", "aria-controls": `${this._uid}-panel`, tabindex: i === at ? "0" : "-1"
          }, x.tab))
        )
        : null
    );
    const kids = u ? (u.children.length ? this._line(`kids:${u.id}`, `children${u.partner ? `, ${u.tab}` : ""}`, u.children.map((c) => this._card(c, "kids")), "hfy-nav__line--center") : h("p", { class: "hfy-nav__none" }, COPY.childrenNone)) : h("p", { class: "hfy-nav__none" }, COPY.noUnions);
    const children = h(
      "section",
      tabbed
        ? { class: "hfy-nav__block hfy-nav__band hfy-nav__band--children", role: "tabpanel", id: `${this._uid}-panel`, "aria-labelledby": `${this._uid}-tab-${at}` }
        : { class: "hfy-nav__block hfy-nav__band hfy-nav__band--children", "aria-labelledby": `${this._uid}-children` },
      h("h3", { id: `${this._uid}-children`, class: "hfy-nav__heading" }, "children"),
      kids
    );
    return [grandparents, parents, family, children];
  }

  // Hide the cards of each line that do not fit its column and write its "+N more" button. Layout is read, so this runs after the DOM is in place.
  _fit() {
    if (!this._wide) return;
    this._retry = false;
    for (const ul of this.querySelectorAll("ul[data-fit]")) {
      const key = ul.getAttribute("data-fit");
      const cards = [...ul.children].filter((li) => !li.hasAttribute("data-more-item"));
      const moreLi = ul.querySelector("[data-more-item]");
      for (const li of cards) li.hidden = false;
      if (!moreLi) continue;
      moreLi.hidden = true;
      const avail = ul.clientWidth;
      const w = cards[0].offsetWidth;
      if (!avail || !w) { this._retry = true; continue; } // not laid out yet (display:none): measure again at the next refit
      const gap = parseFloat(getComputedStyle(ul).columnGap) || 0;
      if (cards.length * w + (cards.length - 1) * gap <= avail + 0.5) continue; // the whole line fits: nothing to hide
      const btn = moreLi.firstElementChild;
      const label = btn.getAttribute("data-label");
      moreLi.hidden = false;
      if (this._expanded.has(key)) {
        btn.textContent = "show fewer";
        btn.setAttribute("aria-label", `show fewer ${label}`);
        continue;
      }
      btn.textContent = `+${cards.length - 1} more`;
      const room = avail - moreLi.offsetWidth;
      const keep = Math.min(cards.length - 1, Math.max(1, Math.floor(room / (w + gap))));
      cards.slice(keep).forEach((li) => { li.hidden = true; });
      btn.textContent = `+${cards.length - keep} more`;
      btn.setAttribute("aria-label", `+${cards.length - keep} more ${label}`);
    }
  }

  // A resize observer callback: refit once per frame, and only when the width changed (hiding cards changes the height, which must not loop).
  // `force` (fonts ready) and `_retry` (a line could not be measured) refit without a width change.
  _refit(force = false) {
    if (!this._wide || this._frame || !this.isConnected || (!force && !this._retry && this.clientWidth === this._lastWidth)) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._lastWidth = this.clientWidth;
      this._fit();
    });
  }

  _render(focusKey = null) {
    if (!this.isConnected) return;
    const refocus = this._refocus;
    const entering = this._entering;
    this._refocus = false;
    this._entering = false;
    const had = refocus ? "role:focus" : focusKey || (this.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null);
    const m = this._graph && this._focus ? navigatorModel(this._graph, this._focus) : null;
    if (!m) { this.replaceChildren(); return; }
    this._unionCount = m.unions.length;
    this._moves = navMoves(m, this._union);
    this._ring = m.ring.map((r) => r.id);
    const title = `family chart centred on ${m.name}. the outline has the same information.`;
    let body;
    if (this._wide) {
      body = this._renderWide(m);
    } else {
      const parents = m.parents.cards.length
        ? h(
          "ul", { class: "hfy-nav__strip", "aria-label": "parents" },
          m.parents.cards.map((c, i) => h("li", { class: "hfy-nav__item" }, this._card(c, "parents", { pi: i }))),
          m.parents.placeholder ? h("li", { class: "hfy-nav__item" }, h("p", { class: "hfy-nav__missing" }, m.parents.placeholder)) : null
        )
        : h("p", { class: "hfy-nav__none" }, m.parents.message);
      body = [
        h("div", { class: "hfy-nav__focus" }, this._card(m.focus, "focus")),
        this._section("parents", "parents", parents),
        this._unions(m),
        m.siblings.length ? this._section("siblings", "brothers and sisters", this._row(m.siblings, "brothers and sisters", "sibs")) : null
      ];
    }
    const root = h(
      "section", { class: `hfy-nav${this._wide ? " hfy-nav--wide" : ""}${entering ? " hfy-nav--enter" : ""}`, "aria-labelledby": `${this._uid}-title`, "data-nav-focus": m.id, "data-nav-layout": this._wide ? "grid" : "stack" },
      h("h2", { id: `${this._uid}-title`, class: "hfy-nav__title" }, title),
      m.notice ? h("p", { class: "hfy-nav__notice", "data-nav-notice": "" }, m.notice) : null,
      this._toolbar(),
      ...body
    );
    this.replaceChildren(root);
    this._lastWidth = this.clientWidth;
    this._fit();
    // A re-render must not drop the keyboard: put focus back on the same control (a card that became the focus card has the same key).
    // (Matched by comparing the attribute, never by building a selector from a graph id: an odd character in an id cannot throw here.)
    // "role:focus" and "role:partner" name a card by what it is (the new focus card, the selected partner), not by whose it is.
    if (had) {
      const byRole = had.startsWith("role:") ? this.querySelector(`.hfy-nav__card[data-role="${had.slice(5)}"]`) : null;
      (byRole || [...this.querySelectorAll("[data-key]")].find((e) => e.getAttribute("data-key") === had) || this.querySelector(".hfy-nav__card--focus"))?.focus({ preventScroll: true });
    }
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
