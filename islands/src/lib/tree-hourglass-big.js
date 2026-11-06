// The big hourglass tree on /tree/?view=tree (HFY-TSK-379 pass 3, flag familyVizHourglass; DIGEST sections 3, 4, 6 and 7). PLAIN DOM, a lazy chunk that
// islands/tree.jsx imports only when that view opens: no React, no chart library. The cards, the strips under them (2 px <i>, never SVG), the rings and the
// row names come from bigModel/bigLayout (hourglass-big.js), which hold every rule; this file draws them and owns the toolbar, the history and the bar.
// Its strings are inline literals (T-Copy: lower case, names keep their capitals); tests/hourglass-copy.test.mjs reads them from this source.
//
//   mountBig(host, {graph, focus, from, links, notice, sync})   draws the tree of `focus` into `host`; returns {destroy}.
//     links {kin, poster, table}  which of the "how are we related?", poster and table links exist for this visitor;
//     sync(id)                    tells the page (TreeApp) the new middle person after a tap, so its own state and address checks agree.
// The history is the browser's: a tap pushes `?focus=<id>` with history.state {hg: [the people before]}, popstate retraces it, "back to" goes to the start
// of that stack (history.go) and the stack's first entry is the start. The size and the open brothers and sisters are the view's own state, not in the address.
import { COPY, firstName, indexGraph } from "./hourglass-model.js";
import { bigLayout, bigModel, defaultLevel } from "./hourglass-big.js";
import { avatar, box, h, strip } from "./hourglass-dom.js";
import { listHref, ok, page } from "./hourglass-links.js";

const hg = () => (history.state && history.state.hg) || [];
const clamp = (n) => Math.max(0, Math.min(3, n));

export function mountBig(host, { graph, focus, from, links = {}, notice = "", sync = () => {} }) {
  const idx = indexGraph(graph);
  const has = (x) => idx.people.has(x);
  const first = (x) => firstName(idx.people.get(x));
  const paneMq = matchMedia("(min-width: 1100px)");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const st = { f: focus, lv: defaultLevel(innerWidth), sibs: false, n: 0 };
  let timer;
  let resetting = false;
  let seen = false;
  // The person page the visitor came from; with none, whoever the stack started on.
  const came = () => (ok(from) && has(from) ? from : null);
  const home = () => came() || hg()[0] || st.f;
  const atStart = () => !hg().length && st.lv === defaultLevel(innerWidth) && !st.sibs && st.f === home();

  const root = h("section", "hfy-bt", { "aria-label": "the family tree" });
  const back = h("button", "hfy-bt__back", { type: "button" }, "back");
  const tools = h("div", "hfy-bt__tools", { role: "group", "aria-label": "zoom and view" });
  const size = h("span", "hfy-bt__size");
  const canvas = h("div", "hfy-bt__canvas");
  const stage = h("div", "hfy-bt__stage", { role: "group", "aria-label": "the family tree" }, canvas);
  const status = h("p", "hfy-bt__status", { role: "status" });
  const bar = h("div", "hfy-bt__bar", { role: "group", "aria-label": "who is in the middle" });
  root.append(h("div", "hfy-bt__top", null, back, h("h2", null, null, "the family tree")), tools, h("div", "hfy-bt__main", null, stage, status), bar);
  host.replaceChildren(root);

  const say = (t) => {
    status.textContent = t;
    clearTimeout(timer);
    timer = setTimeout(() => (status.textContent = ""), 6000);
  };
  const url = (id) => {
    const q = new URLSearchParams(location.search);
    q.set("focus", id);
    return `${location.pathname}?${q}`;
  };
  const setLevel = (n) => { if (clamp(n) !== st.lv) { st.lv = clamp(n); draw(); } };
  // One table drives the toolbar: key, text, accessible name, action. Buttons stay in the DOM (aria-disabled, never disabled) so a focused one keeps focus at its limit.
  const BT = {};
  [["out", "−", "zoom out", () => setLevel(st.lv - 1)], ["in", "+", "zoom in", () => setLevel(st.lv + 1)], ["all", "see all", null, () => setLevel(0)], ["to", null, null, () => reset()]].forEach(([k, text, aria, act]) => {
    const b = (BT[k] = h("button", `hfy-bt__tool is-${k}`, { type: "button", "aria-label": aria }, text));
    b.onclick = () => b.getAttribute("aria-disabled") === "true" || act();
    tools.append(b);
  });
  tools.append(size);

  const goBack = () => { if (!hg().length && came()) location.assign(page(came())); else history.back(); };
  back.onclick = goBack;
  const reset = () => {
    const n = hg().length;
    resetting = true;
    if (n) history.go(-n); else settle();
  };
  const shown = (t) => { draw(); stage.querySelector("[aria-current]").focus({ preventScroll: true }); say(`now centred on ${first(t)}`); };
  // After "back to" (the start of the stack reached) or a step back or forward: the address says who is in the middle.
  function settle() {
    const id = new URLSearchParams(location.search).get("focus");
    if (!has(id)) return;
    st.f = id;
    st.sibs = false;
    if (resetting) {
      resetting = false;
      st.lv = defaultLevel(innerWidth);
      if (st.f !== home()) { history.replaceState({ hg: [] }, "", url(home())); st.f = home(); }
      sync(st.f);
    }
    shown(st.f);
  }
  const tap = (id) => {
    if (id === st.f) return say("already in the middle");
    history.pushState({ hg: [...hg(), st.f] }, "", url(id));
    sync(id);
    st.f = id;
    st.sibs = false;
    shown(id);
  };

  function node(n, av) {
    let e;
    if (n.kind === "ghost") {
      const tell = n.tell && h("button", "hfy-tree__lk", { type: "button" }, COPY.tellUs);
      if (tell) tell.onclick = () => say(COPY.thanks);
      e = h("div", "hfy-tree__card is-ghost", null, h("span", null, { "aria-hidden": n.label !== n.text }, n.label), n.label !== n.text && h("span", "hfy-bt__sr", null, n.text), tell);
    } else if (n.kind === "chip") {
      e = h("button", `hfy-tree__card is-chip is-${n.role}`, { type: "button", "aria-label": n.aria, "aria-expanded": n.act === "sibs" ? String(n.expanded) : null, "data-k": `${n.act}:${n.target || ""}` }, n.label);
      e.onclick = () => (n.act === "sibs" ? ((st.sibs = !st.sibs), draw(), canvas.querySelector('[data-k^="sibs"]').focus({ preventScroll: true })) : tap(n.target));
    } else {
      const c = n.card;
      e = h("button", `hfy-tree__card is-${n.role}`, { type: "button", "aria-label": n.aria, "aria-current": n.current && "true", "data-k": c.id },
        avatar(c, av), n.text && [h("span", "hfy-tree__nm", null, n.name), c.years && h("span", "hfy-tree__yr", null, c.years), c.word && h("span", "hfy-tree__wd", null, c.word)],
        n.showBoth && h("span", "hfy-tree__both", null, COPY.bothSides));
      e.onclick = () => tap(c.id);
    }
    return box(e, n.left, n.top, n.width, n.height);
  }

  function draw(centre = true) {
    const wide = paneMq.matches;
    const m = bigModel(idx, st.f);
    const L = bigLayout(m, st.lv, { sibsOpen: st.sibs });
    const key = (document.activeElement && stage.contains(document.activeElement) && document.activeElement.dataset.k) || null;
    root.classList.toggle("is-pane", wide);
    root.dataset.level = st.lv;
    canvas.style.width = `${L.width}px`;
    canvas.style.height = `${L.height}px`;
    canvas.className = `hfy-bt__canvas ${++st.n % 2 ? "fa" : "fb"}`;
    canvas.replaceChildren(h("div", "hfy-bt__lines", { "aria-hidden": true }, L.strips.map(strip), L.rings.map((r) => box(h("i", "hfy-bt__ring"), r.cx - r.size / 2, r.cy - r.size / 2)), L.labels.map((l) => box(h("span", "hfy-bt__lab", null, l.text), l.x, l.y))), ...L.nodes.map((n) => node(n, L.size.av)));
    if (key) canvas.querySelector(`[data-k="${key}"]`)?.focus({ preventScroll: true });
    // toolbar: aria-disabled at the limits, aria-pressed on the two toggles
    const lim = { out: st.lv === 0, in: st.lv === 3, to: atStart() };
    for (const k in BT) { if (k in lim) BT[k].setAttribute("aria-disabled", String(lim[k])); if (k === "all") BT[k].setAttribute("aria-pressed", String(st.lv === 0)); }
    BT.to.textContent = `back to ${first(home())}`;
    size.textContent = `size: ${L.size.name}`;
    const prev = hg().at(-1);
    back.setAttribute("aria-label", prev ? `one step back, to ${first(prev)}` : came() ? `back to ${first(came())}'s page` : "back");
    // the bar (phone) or the panel (from 1100 px)
    const c = m.focus;
    const rel = came() ? (st.f === came() ? (wide ? "the person whose page you came from" : "whose page you came from") : `from ${first(came())}'s page`) : "";
    const view = (v, text) => h("a", "hfy-tree__lk", { href: listHref(v, st.f) }, text);
    const label = wide ? "see this family as" : "see this as";
    bar.replaceChildren(...[
      h("div", "hfy-bt__who", null, avatar(c, wide ? 72 : 40), h("div", null, null, h("h3", null, null, c.name), h("p", null, null, [c.years, rel].filter(Boolean).join(" · ")))),
      h("div", "hfy-bt__acts", null, h("a", "hfy-bt__btn", { href: page(st.f) }, `open ${c.first}'s page`), links.kin && h("a", "hfy-bt__btn is-alt", { href: listHref("cards", st.f, "&kin=1") }, "how are we related?")),
      h("div", "hfy-bt__see", { role: "group", "aria-label": label }, h("span", null, null, label), view("cards", "cards"), links.poster && view("family", wide ? "the whole-family poster" : "poster"), view("outline", "outline"), links.table && view("table", "table")),
      wide && h("p", "hfy-bt__help", null, "tap someone to put them in the middle. the buttons zoom. the back button takes you to who you had before.")].filter(Boolean));
    if (centre) {
      const a = canvas.querySelector("[aria-current]").getBoundingClientRect();
      const b = stage.getBoundingClientRect();
      stage.scrollTo({ left: stage.scrollLeft + a.left + a.width / 2 - b.left - b.width / 2, top: stage.scrollTop + a.top + a.height / 2 - b.top - b.height / 2, behavior: seen && !calm.matches ? "smooth" : "auto" });
      seen = true;
    }
  }

  root.onkeydown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const act = { "+": () => setLevel(st.lv + 1), "=": () => setLevel(st.lv + 1), "-": () => setLevel(st.lv - 1), 0: () => setLevel(0), Escape: goBack }[e.key];
    if (act) { e.preventDefault(); act(); }
  };
  const onPane = () => draw(false);
  addEventListener("popstate", settle);
  paneMq.addEventListener("change", onPane);
  draw();
  if (notice) say(notice);
  return { destroy() { removeEventListener("popstate", settle); paneMq.removeEventListener("change", onPane); clearTimeout(timer); host.replaceChildren(); } };
}
