// The small hourglass tree on the person page (HFY-TSK-379 pass 2, flag familyVizHourglass; DIGEST sections 2 to 4). PLAIN DOM: no React, no chart
// library. This file is the lazy chunk (`tree-hourglass`): lib/tree-link.js imports it with import(), never statically, so the person page's entry stays
// small. It draws the model of hourglass-model.js in the rows of hourglass-layout.js; CSS grid (46-hourglass.css) places the cards, and the connectors are
// 2 px strips (<i>) under them, never SVG. Every person is a real link (or, for a ghost, a button), named with their relationship.
// "know who? tell us" answers with the thank-you in a polite status line (<p role=status>) inside the tree: the islands have no shared plain-DOM toast (their
// toasts are React components of the editor and the shell), and this chunk takes no React, so it is a status line, not a toast.
//
//   mountHourglass(host, {graph, id, from, links})   draws the tree of `id` into `host` and returns its root; null when the person has nobody to
//                                                    draw (the caller then lets the page keep what it has). `graph` is the parsed graph.json (FamilyGraph or body), `from` the person
//                                                    page the visitor is on (the big tree's "back to"), `links` {table} says whether the table view is on.
import { familyModel, indexGraph } from "./hourglass-model.js";
import { smallLayout } from "./hourglass-layout.js";
import { avatar, body, btn, h, lk, px, speaker, strip, tell } from "./hourglass-dom.js";
import { bigHref, listHref, ok, page } from "./hourglass-links.js";

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
  const say = speaker(status);
  const flip = (k) => () => {
    state[k] = !state[k];
    draw(k);
  };
  const toggle = (k, text, open, aria, plain) => {
    const b = btn(`hfy-tree__tog${plain ? " is-plain" : ""}`, { "data-k": k, "aria-expanded": String(open), "aria-label": aria }, h("span", null, null, text));
    b.onclick = flip(k);
    return b;
  };

  function draw(refocus) {
    W = Math.round(root.clientWidth);
    if (!W) return;
    const L = smallLayout(model, { width: W, kidsOpen: state.kids, sibsOpen: state.sibs });
    const wide = L.wide;
    root.classList.toggle("is-wide", wide);
    const item = (c) => {
      if (typeof c === "string") return h("div", "hfy-tree__cap", null, c);
      if (c.ghost) return h("div", "hfy-tree__card is-ghost", null, h("span", null, null, c.text), tell(say));
      // an id the tree page would not take has no big tree to open: the chip is then plain text, not a link
      if (c.chip) return big ? h("a", "hfy-tree__card is-grandchild is-chip", { href: big, "aria-label": c.aria }, c.text) : h("div", "hfy-tree__card is-grandchild is-chip", null, c.text);
      const cur = c.role === "focus";
      const href = cur ? bigHref(c.id, from) : page(c.id);
      return h(href ? "a" : "div", `hfy-tree__card is-${c.role}`, { href, "aria-label": c.aria, "aria-current": cur && "page" },
        body(c, wide ? c.name : c.short, 0, 1, !(c.role === "grandparent" && !wide), c.both));
    };
    const grid = (cols, cells, cls) => {
      const g = h("div", cls);
      g.style.gridTemplateColumns = cols;
      for (const c of cells) { const e = item(c.item); e.style.gridColumn = `${c.col + 1} / span ${c.span}`; g.append(e); }
      return g;
    };
    const eq = (n) => `repeat(${n}, minmax(0, 1fr))`;
    const out = L.rows.map((r) => {
      if (r.kind === "note") return h("div", "hfy-tree__note", null, h("span", null, null, r.text), big && lk(bigHref(id, from, "&ggp=1"), r.button));
      if (r.kind === "cards") return grid(eq(r.cols), r.cells, `hfy-tree__row${r.sides ? " is-cap" : ""}`);
      if (r.kind === "gap") {
        const g = h("div", "hfy-tree__gap", { "aria-hidden": true }, r.strips.map(strip));
        g.style.height = px(r.h);
        return g;
      }
      if (r.kind === "band") {
        const sib = r.siblings && grid(eq(r.siblings.cols), r.siblings.cells, "hfy-tree__row is-open");
        const me = grid("1fr 1.4fr 1fr", r.person.cells, "hfy-tree__row");
        const also = r.also.length && h("div", "hfy-tree__also", null, h("span", null, null, "also with"), r.also.map((p) => h("a", "hfy-tree__chip", { href: page(p.id), "aria-label": p.aria }, `${p.name} · ${p.word}`)));
        return h("div", "hfy-tree__band", null, r.toggle && toggle("sibs", r.toggle.text, r.toggle.open, r.toggle.aria), sib, me, also);
      }
      if (r.kind === "toggle") return toggle("kids", r.text, r.open, null, true);
      const faces = r.items.map((c) => h(ok(c.id) ? "a" : "div", "hfy-tree__face", { href: page(c.id), "aria-label": c.aria }, avatar(c)));
      if (r.more) faces.push(big ? h("a", "hfy-tree__face is-more", { href: big, "aria-label": r.more.aria }, r.more.text) : h("div", "hfy-tree__face is-more", null, r.more.text));
      return h("div", null, null, h("div", "hfy-tree__faces", { role: "group", "aria-label": "grandchildren" }, faces), h("p", "hfy-tree__names", null, r.names));
    });
        out.push(h("div", "hfy-tree__foot", null,
      big && h("a", "hfy-tree__btn", { href: big, "aria-label": `open the big tree, centred on ${model.focus.name}` }, "open the big tree"),
      h("p", "hfy-tree__alt", null, "prefer a list?", " ", lk(listHref("outline", id), "outline"), links.table && [" · ", lk(listHref("table", id), "table")])));
    // A redraw (rotation, a scrollbar appearing) must not drop a keyboard user's place: the element that had focus is found again by what names it.
    const sig = (e) => (e && root.contains(e) ? [e.dataset.k, e.getAttribute("href"), e.getAttribute("aria-label")].join("|") : null);
    const was = sig(document.activeElement);
    view.replaceChildren(...out);
    if (refocus) root.querySelector(`[data-k="${refocus}"]`)?.focus();
    else if (was) [...root.querySelectorAll("a, button")].find((e) => sig(e) === was)?.focus();
  }

  draw();
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (Math.round(root.clientWidth) !== W) draw(); }).observe(root);
  return root;
}
