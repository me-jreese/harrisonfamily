// The person page's "see in the family tree" link (HFY-TSK-201, familyViz): the [data-slot="tree-link"] host of person-page-mount-points,
// which sits in the family section directly after the Graphviz frame. Only the host and the hfy:person-rendered event are used; the
// page's own script (11ty/js/person-page.js) is not touched. The hero and its slots are rebuilt by each render, so the link is
// (re)filled on every event, and never added twice.

/** The tree page, centred on `id` (a gramps id). Null for anything that is not a plausible id. */
export const treeLinkHref = (id) => (typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id) ? `/tree/?focus=${encodeURIComponent(id)}` : null);

export const TREE_LINK_TEXT = "see in the family tree";

/** Fill the host: one anchor with the link, or nothing when the flag is off or the id is not usable. Idempotent. */
export function fillTreeLink(doc, personId, familyViz) {
  const host = doc.querySelector('[data-slot="tree-link"]');
  if (!host) return false;
  const href = familyViz === true ? treeLinkHref(personId) : null;
  const existing = host.querySelector("a[data-tree-link]");
  if (!href) { existing?.remove(); return false; }
  if (existing) { existing.setAttribute("href", href); return true; }
  const a = doc.createElement("a");
  a.setAttribute("data-tree-link", "");
  a.setAttribute("href", href);
  a.textContent = TREE_LINK_TEXT;
  host.appendChild(a);
  return true;
}

/** Event dispatched when the mini focus view is wanted but not drawn; person-page.js then draws the Graphviz frame it had held back. */
export const MINI_UNAVAILABLE = "hfy:person-mini-unavailable";

/** Wire it to the page: now (the page may have rendered already) and after every render. Returns the stop function. */
export function mountTreeLink(win = window) {
  const doc = win.document;
  let flagOn = false;
  let miniOn = false;
  let hourglassOn = false;
  let tableOn = false;
  let resolved = false;
  const cache = {}; // the graph, loaded once for this mount
  const idNow = () => new URLSearchParams(win.location.search).get("id");
  const unavailable = (id) => doc.dispatchEvent(new CustomEvent(MINI_UNAVAILABLE, { detail: { personId: id } }));
  const fetcher = (u, i) => (win.HFYFeatureFlags?.dataFetch ? win.HFYFeatureFlags.dataFetch(u, i, { interactive: false }) : win.fetch(u, i));
  // What the page shows without the hourglass: the card mini focus view (HFY-TSK-289, familyVizPersonMini) in the tree-link host, else the Graphviz frame
  // that person-page.js held back. The hourglass's "cards" view and its fallback draw exactly this.
  const classic = (id, host, linked) => {
    if (!(miniOn && linked)) { host.querySelector("[data-person-mini]")?.remove(); unavailable(id); return; }
    import("./person-mini.js")
      .then((m) => m.fillMini(doc, host, id, treeLinkHref(id), fetcher, cache))
      .then((shown) => { if (!shown && idNow() === id) unavailable(id); })
      .catch(() => unavailable(id));
  };
  const fill = (id) => {
    const linked = fillTreeLink(doc, id, flagOn);
    // HFY-TSK-289 (familyVizPersonMini): the mini focus view shares the host with the link. It needs familyViz too (the graph is /tree/'s).
    const host = doc.querySelector('[data-slot="tree-link"]');
    if (!host) { unavailable(id); return; }
    const plain = () => classic(id, host, linked);
    // HFY-TSK-379 (familyVizHourglass, needs familyViz): the tree/cards switch and the hourglass; it wins over the mini view. Any failure is the plain page.
    if (!(hourglassOn && linked && id)) { plain(); return; }
    import("./hourglass-ui.js")
      .then((m) => m.fillHourglass(doc, host, id, { fetcher, cache, links: { table: tableOn }, classic: plain }))
      .then((took) => { if (!took) plain(); })
      .catch(plain);
  };
  // Before the flags are read nothing is wanted or signalled: the first fill below runs once they are.
  const onRendered = (e) => { if (resolved) fill(e?.detail?.personId ?? idNow()); };
  Promise.resolve(win.HFYFeatureFlags?.resolveFlags?.())
    .catch(() => null)
    .then((flags) => {
      flagOn = Boolean(flags) && flags.familyViz === true;
      miniOn = flagOn && flags.familyVizPersonMini === true;
      hourglassOn = flagOn && flags.familyVizHourglass === true;
      tableOn = flagOn && flags.familyVizTime === true;
      resolved = true;
      fill(idNow());
    });
  doc.addEventListener("hfy:person-rendered", onRendered);
  return () => doc.removeEventListener("hfy:person-rendered", onRendered);
}
