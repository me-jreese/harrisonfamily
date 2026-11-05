// The person page's mini focus view (HFY-TSK-289, viz-v2-retire-graphviz, flag familyVizPersonMini; viz.md section 4, BRD2 D2-25): the
// person, their parents, partners and children as small linked cards, read from the same graph.json as /tree/. It fills the
// [data-slot="tree-link"] host in place of the Graphviz frame, which person-page.js no longer draws with the flag on. Names are
// PersonName links (P2-R46). No framework and no d3: plain DOM, so the person bundle grows only by the lazy chunk that holds this file.
import { loadGraph, yearsLabel } from "./tree-data.js";
import { personNameNode } from "./person-name.js";

/** Most cards in one group before the rest collapse into a "+N more" link to the tree page. */
export const MINI_MAX = 6;

export const MINI_COPY = {
  label: "family around this person",
  groups: { parents: "parents", partners: "partners", children: "children" },
  focus: "this person",
  more: (n) => `+${n} more in the family tree`
};

/**
 * The model for one person: {focus, groups:[{key, title, shown:[{id,name,years}], more}]}; null when the person is not in the graph.
 * Empty groups are dropped, so a person with no recorded relatives has no groups at all.
 */
export function miniModel(graph, id, max = MINI_MAX) {
  const p = graph.person(id);
  if (!p) return null;
  const card = (pid) => {
    const q = graph.person(pid);
    return { id: pid, name: q.name, years: yearsLabel(q) };
  };
  const sources = [
    ["parents", graph.parents(id)],
    ["partners", graph.partners(id)],
    ["children", graph.children(id)]
  ];
  const groups = [];
  for (const [key, list] of sources) {
    const ids = list.map((r) => r.id).filter((x) => graph.has(x) && x !== id);
    if (!ids.length) continue;
    groups.push({ key, title: MINI_COPY.groups[key], shown: ids.slice(0, max).map(card), more: Math.max(0, ids.length - max) });
  }
  return { focus: card(id), groups };
}

/** Draw the model into `doc` as one element; `treeHref` is where "+N more" goes. */
export function renderMini(doc, model, treeHref) {
  const root = doc.createElement("div");
  root.className = "hfy-mini";
  root.setAttribute("data-person-mini", "");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", MINI_COPY.label);
  const cardOf = (c, extra) => {
    const el = doc.createElement("div");
    el.className = extra ? `hfy-mini__card ${extra}` : "hfy-mini__card";
    if (extra) el.setAttribute("aria-current", "true");
    const years = doc.createElement("span");
    years.className = "hfy-mini__years";
    years.textContent = c.years;
    el.append(personNameNode(doc, { id: c.id, name: c.name }), years);
    return el;
  };
  for (const g of model.groups.filter((x) => x.key === "parents")) root.append(groupEl(doc, g, cardOf, treeHref));
  const mid = doc.createElement("div");
  mid.className = "hfy-mini__row";
  mid.setAttribute("data-mini-group", "focus");
  const label = doc.createElement("h3");
  label.className = "hfy-mini__title";
  label.textContent = MINI_COPY.focus;
  mid.append(label, cardOf(model.focus, "hfy-mini__card--focus"));
  root.append(mid);
  for (const g of model.groups.filter((x) => x.key !== "parents")) root.append(groupEl(doc, g, cardOf, treeHref));
  return root;
}

function groupEl(doc, g, cardOf, treeHref) {
  const row = doc.createElement("div");
  row.className = "hfy-mini__row";
  row.setAttribute("data-mini-group", g.key);
  const title = doc.createElement("h3");
  title.className = "hfy-mini__title";
  title.textContent = g.title;
  row.append(title);
  for (const c of g.shown) row.append(cardOf(c));
  if (g.more > 0 && treeHref) {
    const a = doc.createElement("a");
    a.className = "hfy-mini__more";
    a.setAttribute("href", treeHref);
    a.textContent = MINI_COPY.more(g.more);
    row.append(a);
  }
  return row;
}

let graphPromise = null;

/** Fill (or refill) the host's mini view for `personId`. Resolves true when a view is shown; any failure leaves the host as it was. */
export async function fillMini(doc, host, personId, treeHref, fetcher) {
  host.querySelector("[data-person-mini]")?.remove();
  if (!personId) return false;
  if (!graphPromise) graphPromise = loadGraph(fetcher).then((r) => { if (r.state !== "ready") graphPromise = null; return r; });
  const res = await graphPromise;
  if (res.state !== "ready") return false;
  const model = miniModel(res.graph, personId);
  if (!model) return false;
  host.querySelector("[data-person-mini]")?.remove(); // a second render may have finished first
  host.insertBefore(renderMini(doc, model, treeHref), host.firstChild);
  return true;
}
