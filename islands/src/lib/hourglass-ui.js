// The person page's family section with the hourglass on (HFY-TSK-379 pass 2, flag familyVizHourglass; DIGEST section 5, T-Both): the "tree · cards" switch and
// which of the two is shown. Plain DOM and its own small chunk, so a visitor on "cards" never loads the tree. Loaded by lib/tree-link.js with import().
//   tree   the hourglass (lib/tree-hourglass.js, a lazy chunk of its own) fills `.hfy-hg__tree`; the family list, the Graphviz frame, the card mini view and the
//          old "see in the family tree" link are hidden by 46-hourglass.css, not removed
//   cards  what the page shows with the flag off, unchanged (`classic()`: the mini view or the Graphviz frame, and the family list), plus one link "see the tree"
// The choice is remembered on this device (localStorage, in try/catch; the page works without it). When the tree cannot be drawn (the graph is gated, missing
// or has no entry for this person, or the chunk fails) the switch goes and the page is the one it is with the flag off.
import { cachedGraph } from "./tree-data.js";

export const VIEW_KEY = "hfy:person-family-view";

const ICON = {
  tree: "M12 3v6M6 9h12M6 9v4M18 9v4M12 15v6M4 13h4v4H4zM16 13h4v4h-4z",
  cards: "M4 5h7v14H4zM13 5h7v14h-7z"
};
const button = (v) => `<button type="button" data-v="${v}" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[v]}"/></svg>${v}</button>`;

/** The remembered view ("tree" unless "cards" was chosen), surviving a storage that throws. */
export function readView() {
  try { return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "tree"; } catch { return "tree"; }
}
const writeView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* the choice just is not remembered */ } };

const states = new WeakMap();

/**
 * Fill (or keep) the host for `id`. `ctx` is {fetcher, cache, links, classic}: `classic()` draws what the page shows with the flag off. Resolves true when
 * the hourglass took the section over (even if it then fell back), false when it could not start (no family section), so the caller draws the classic page.
 */
export async function fillHourglass(doc, host, id, { fetcher, cache, links, classic }) {
  const section = doc.getElementById("person-family-section");
  if (!section) return false;
  const old = states.get(host);
  if (old && old.id === id && old.wrap.isConnected) return true;
  old?.bar.remove();
  old?.wrap.remove();
  const make = (html) => Object.assign(doc.createElement("div"), { innerHTML: html }).firstChild;
  const wrap = make('<div class="hfy-hg"><div class="hfy-hg__tree"></div><p class="hfy-hg__cards"><button type="button" class="hfy-tree__lk">see the tree</button></p></div>');
  const bar = make(`<div class="hfy-hg__bar" role="group" aria-label="show family as">${button("tree")}${button("cards")}</div>`);
  host.prepend(wrap);
  (section.querySelector("h2") || { after: (n) => section.prepend(n) }).after(bar);
  states.set(host, { id, wrap, bar });
  let classicDone = false;
  let mounted = null;
  const drawClassic = () => { if (!classicDone) { classicDone = true; classic(); } };
  const drop = () => {
    bar.remove();
    wrap.remove();
    delete section.dataset.hfyView;
    states.delete(host);
    drawClassic();
  };
  const mount = async () => {
    const res = await cachedGraph(cache, fetcher);
    if (res.state !== "ready") return null;
    return (await import("./tree-hourglass.js")).mountHourglass(wrap.firstChild, { graph: res.graph, id, from: id, links });
  };
  const show = async (view, remember) => {
    section.dataset.hfyView = view;
    for (const b of bar.children) b.setAttribute("aria-pressed", String(b.dataset.v === view));
    if (remember) writeView(view);
    if (view === "cards") return drawClassic();
    mounted ||= mount().catch(() => null);
    if (!(await mounted) && states.get(host)?.wrap === wrap) drop();
  };
  for (const b of bar.children) b.onclick = () => show(b.dataset.v, true);
  wrap.querySelector(".hfy-tree__lk").onclick = () => show("tree", true);
  await show(readView(), false);
  return true;
}
