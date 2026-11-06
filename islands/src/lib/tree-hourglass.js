// The small hourglass tree on the person page (HFY-TSK-379 pass 2, flag familyVizHourglass; DIGEST sections 2 to 4). PLAIN DOM: no React, no chart
// library. This file is the lazy chunk (`tree-hourglass`): lib/tree-link.js imports it with import(), never statically, so the person page's entry stays
// small. It draws the model of hourglass-model.js in the rows of hourglass-layout.js; CSS grid (46-hourglass.css) places the cards, and the connectors are
// 2 px strips (<i>) under them, never SVG. Every person is a real link (or, for a ghost, a button), named with their relationship.
//
//   mountHourglass(host, {graph, id, from, links})   draws the tree of `id` into `host` and returns its root; null when the person has nobody to
//                                                    draw (the caller then lets the page keep what it has). `graph` is the parsed graph.json (FamilyGraph or body), `from` the person
//                                                    page the visitor is on (the big tree's "back to"), `links` {table} says whether the table view is on.
//   bigHref(id, from, extra)                         the big tree's address, or null for an id the tree page would not take
import { COPY, familyModel, indexGraph } from "./hourglass-model.js";
import { smallLayout } from "./hourglass-layout.js";

// The tree page's id pattern (lib/tree-link.js treeLinkHref, lib/merged-person.js): an id outside it is never put in an address.
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const ok = (x) => typeof x === "string" && ID.test(x);

/** The big tree centred on `id`; `from` (the person page the visitor came from) is what its "back to" returns to. */
export const bigHref = (id, from, extra = "") => (ok(id) ? `/tree/?view=tree&focus=${id}${ok(from) ? `&from=${from}` : ""}${extra}` : null);

const h = (tag, cls, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  e.append(...kids.flat().filter(Boolean));
  return e;
};
const px = (n) => `${n}px`;
const page = (id) => (ok(id) ? `/person/?id=${id}` : null);

function avatar(c) {
  const a = h("span", "hfy-tree__av", { "aria-hidden": true }, c.initials);
  if (c.face) {
    const i = h("img", null, { src: c.face, alt: "", loading: "lazy", decoding: "async" });
    i.onerror = () => i.remove();
    a.append(i);
  }
  return a;
}

export function mountHourglass(host, { graph, id, from = id, links = {} }) {
  const model = familyModel(indexGraph(graph), id);
  if (!model || model.empty) return null;
  const big = bigHref(id, from);
  const root = h("div", "hfy-tree", { role: "group", "aria-label": `family tree of ${model.focus.name}` });
  const view = h("div");
  const status = h("p", "hfy-tree__status", { role: "status" });
  root.append(view, status);
  host.replaceChildren(root);
  const state = { kids: false, sibs: false };
  let W = 0;
  let timer;

  const say = (t) => {
    status.textContent = t;
    clearTimeout(timer);
    timer = setTimeout(() => (status.textContent = ""), 6000);
  };
  const flip = (k) => () => {
    state[k] = !state[k];
    draw(k);
  };
  const toggle = (k, text, open, aria, plain) => {
    const b = h("button", `hfy-tree__tog${plain ? " is-plain" : ""}`, { type: "button", "data-k": k, "aria-expanded": String(open), "aria-label": aria }, h("span", null, null, text));
    b.onclick = flip(k);
    return b;
  };

  function draw(refocus) {
    W = Math.round(root.clientWidth);
    if (!W) return;
    const L = smallLayout(model, { width: W, kidsOpen: state.kids, sibsOpen: state.sibs });
    const wide = L.wide;
    root.classList.toggle("is-wide", wide);
    const ghost = (c) => {
      const b = h("button", "hfy-tree__lk", { type: "button" }, COPY.tellUs);
      b.onclick = () => say(COPY.thanks);
      return h("div", "hfy-tree__card is-ghost", null, h("span", null, null, c.text), b);
    };
    const item = (c) => {
      if (typeof c === "string") return h("div", "hfy-tree__cap", null, c);
      if (c.ghost) return ghost(c);
      if (c.chip) return h("a", "hfy-tree__card is-grandchild is-chip", { href: big, "aria-label": c.aria }, c.text);
      const cur = c.role === "focus";
      const href = cur ? bigHref(c.id, from) : page(c.id);
      return h(href ? "a" : "div", `hfy-tree__card is-${c.role}`, { href, "aria-label": c.aria, "aria-current": cur && "page" },
        avatar(c), h("span", "hfy-tree__nm", null, wide ? c.name : c.short), c.years && h("span", "hfy-tree__yr", null, c.years),
        !(c.role === "grandparent" && !wide) && c.word && h("span", "hfy-tree__wd", null, c.word), c.both && h("span", "hfy-tree__both", null, COPY.bothSides));
    };
    const grid = (cols, cells, cls) => {
      const g = h("div", cls);
      g.style.gridTemplateColumns = cols;
      for (const c of cells) { const e = item(c.item); e.style.gridColumn = `${c.col + 1} / span ${c.span}`; g.append(e); }
      return g;
    };
    const eq = (n) => `repeat(${n}, minmax(0, 1fr))`;
    const out = L.rows.map((r) => {
      if (r.kind === "note") return h("div", "hfy-tree__note", null, h("span", null, null, r.text), h("a", "hfy-tree__lk", { href: bigHref(id, from, "&ggp=1") }, r.button));
      if (r.kind === "cards") return grid(eq(r.cols), r.cells, `hfy-tree__row${r.sides ? " is-cap" : ""}`);
      if (r.kind === "gap") {
        const g = h("div", "hfy-tree__gap", { "aria-hidden": true }, r.strips.map((s) => {
          const i = h("i", `hfy-tree__ln ${s.w > s.h ? "is-h" : "is-v"}${s.dashed ? " is-dash" : ""}${s.rep ? " is-rep" : ""}`);
          Object.assign(i.style, { left: px(s.x), top: px(s.y), width: px(s.w), height: px(s.h) });
          return i;
        }));
        g.style.height = px(r.h);
        return g;
      }
      if (r.kind === "band") {
        const sib = r.siblings && grid(eq(r.siblings.cols), r.siblings.cells, "hfy-tree__row is-open");
        const me = grid("1fr 1.4fr 1fr", r.person.cells, "hfy-tree__row");
        const also = r.also.length && h("div", "hfy-tree__also", null, h("span", null, null, COPY.also), r.also.map((p) => h("a", "hfy-tree__chip", { href: page(p.id), "aria-label": p.aria }, `${p.name} · ${p.word}`)));
        return h("div", "hfy-tree__band", null, r.toggle && toggle("sibs", r.toggle.text, r.toggle.open, r.toggle.aria), sib, me, also);
      }
      if (r.kind === "toggle") return toggle("kids", r.text, r.open, null, true);
      const faces = r.items.map((c) => h(ok(c.id) ? "a" : "div", "hfy-tree__face", { href: page(c.id), "aria-label": c.aria }, avatar(c)));
      if (r.more) faces.push(h("a", "hfy-tree__face is-more", { href: big, "aria-label": r.more.aria }, r.more.text));
      return h("div", null, null, h("div", "hfy-tree__faces", { role: "group", "aria-label": "grandchildren" }, faces), h("p", "hfy-tree__names", null, r.names));
    });
    const list = (v) => `/tree/?view=${v}&focus=${id}`;
    out.push(h("div", "hfy-tree__foot", null,
      h("a", "hfy-tree__btn", { href: big, "aria-label": COPY.openBigAria(model.focus.name) }, COPY.openBig),
      h("p", "hfy-tree__alt", null, COPY.prefer, " ", h("a", "hfy-tree__lk", { href: list("outline") }, COPY.outline), links.table && [" · ", h("a", "hfy-tree__lk", { href: list("table") }, COPY.table)])));
    view.replaceChildren(...out);
    if (refocus) root.querySelector(`[data-k="${refocus}"]`)?.focus();
  }

  draw();
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (Math.round(root.clientWidth) !== W) draw(); }).observe(root);
  return root;
}
