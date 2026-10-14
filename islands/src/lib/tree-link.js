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

/** Wire it to the page: now (the page may have rendered already) and after every render. Returns the stop function. */
export function mountTreeLink(win = window) {
  const doc = win.document;
  let flagOn = false;
  const idNow = () => new URLSearchParams(win.location.search).get("id");
  const fill = (id) => fillTreeLink(doc, id, flagOn);
  const onRendered = (e) => fill(e?.detail?.personId ?? idNow());
  Promise.resolve(win.HFYFeatureFlags?.resolveFlags?.())
    .catch(() => null)
    .then((flags) => { flagOn = Boolean(flags) && flags.familyViz === true; fill(idNow()); });
  doc.addEventListener("hfy:person-rendered", onRendered);
  return () => doc.removeEventListener("hfy:person-rendered", onRendered);
}
