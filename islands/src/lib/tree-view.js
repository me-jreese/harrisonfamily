// The /tree/ page's view choice (HFY-TSK-301, viz-mvp-visual-fallback; viz.md sections 6 and 17): "cards" (the <family-navigator>, a lazy
// chunk) or "outline" (the focus navigator and the generation outline alone). Pure apart from the injected storage getter, so
// tests/tree-view.test.mjs runs every case in node, including a storage that throws.
//
// Order of precedence: `?view=` in the address, then what this browser remembered under `hfy:tree-view`, then "cards". The ADR also
// spells the cards view "chart" (`?view=outline|chart`), so that word is accepted. Every storage access is in try/catch: private windows
// and blocked site data make even the `localStorage` getter throw.

export const VIEW_KEY = "hfy:tree-view";
export const VIEWS = ["cards", "outline"];
// The lifelines view (HFY-TSK-269, flag familyVizTime): a third view that exists only while the flag is on. The page maps it back to "cards"
// when the flag is off, so a stored or shared `?view=lifelines` never strands anyone.
export const LIFELINES_VIEW = "lifelines";
// The table view (HFY-TSK-305, viz-v2-time-phone): the same people as the lifelines as a real table, the screen-reader path. Same flag, same chunk.
export const TABLE_VIEW = "table";
// The whole-family poster (HFY-TSK-272, familyVizBigTree, from 64rem). It is not a default and not always offered, so it is not in VIEWS: the page
// decides whether it is on offer, and a remembered or addressed "family" that is not on offer reads as the cards.
export const FAMILY_VIEW = "family";
// The faces tab (HFY-TSK-308, familyVizFaces): a mosaic of face crops grouped by photo. Offered only with the flag on; otherwise it reads as the cards.
export const FACES_VIEW = "faces";
// The big hourglass tree (HFY-TSK-379, flag familyVizHourglass): `?view=tree`. Not a view the toggle or the remembered choice knows: it is asked for by the address
// alone and only while the flag is on, so with the flag off `?view=tree` is an unknown view and reads as it always did (normalizeView gives null).
export const TREE_VIEW = "tree";
export const DEFAULT_VIEW = "cards";

// The "new" mark on the family page's tree tab (HFY-TSK-379 pass 4, T-Copy: "a quiet new for the first month"). The tab is offered while familyVizHourglass is
// on; the mark goes after this date. The date is a release choice (io), not a clock the page reads from a server: change it with the release, see
// docs/reference/hourglass-tree.md.
export const TREE_TAB_NEW_UNTIL = "2027-01-31T23:59:59Z";

/** The words of the tree tab, the "centred on" chip and the cards' link (T-Copy: lower case, names keep their capitals; tests/hourglass-copy.test.mjs checks them). */
export const TREE_COPY = {
  tab: "tree",
  fresh: "new",
  centred: "centred on",
  change: "change",
  changeAria: "change who the tree is centred on",
  see: (first) => `see ${first} in the tree`
};

/** Whether the tree tab still carries its quiet "new". `now` is a Date or a millisecond count; a clock that is not a number reads as past (no mark). */
export const treeTabIsNew = (now = Date.now()) => Number(now) <= Date.parse(TREE_TAB_NEW_UNTIL);

/** First given name of a graph person, else the first word of the name; "" for none. Titles (dr, mr ...) are skipped, as the hourglass tree does. */
export function firstNameOf(p) {
  const tokens = (s) => String(s || "").trim().replace(/^(?:rev|dr|mr|mrs|ms|miss)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  return p ? tokens(p.given)[0] || tokens(p.name)[0] || "" : "";
}

/**
 * The big tree's address for the family page's "tree" tab and the front card's "see {first} in the tree" link: `?view=tree&focus=<id>` and, when the
 * address already carries one (or `fromId`, the card link's own person), the `from=` person page that the big tree's "back" returns to. Nothing else of
 * the address is carried (`ggp` and `kin` belong to the views they were set in). Null for an id the page cannot put in an address.
 */
export function treeUrl(loc, focus, fromId = null) {
  if (typeof focus !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(focus)) return null;
  const from = fromId || new URLSearchParams(loc.search).get("from");
  const q = new URLSearchParams({ view: TREE_VIEW, focus });
  if (from && /^[A-Za-z0-9_-]{1,32}$/.test(from)) q.set("from", from);
  return `${loc.pathname}?${q.toString()}`;
}

/** Whether the address asks for the big tree (`?view=tree`); the page decides whether it is on offer. */
export const treeAsked = (search) => new URLSearchParams(search).get("view") === TREE_VIEW;

/** "cards" | "outline" | "lifelines" | "table" | "family" for a raw value (`chart` is an alias of `cards`), else null. */
export function normalizeView(value) {
  if (value === "outline") return "outline";
  if (value === LIFELINES_VIEW) return LIFELINES_VIEW;
  if (value === TABLE_VIEW) return TABLE_VIEW;
  if (value === "cards" || value === "chart") return "cards";
  if (value === FAMILY_VIEW) return FAMILY_VIEW;
  if (value === FACES_VIEW) return FACES_VIEW;
  return null;
}

/** The `?view=` value of a location search string, normalised, or null. */
export const viewParam = (search) => normalizeView(new URLSearchParams(search).get("view"));

/** What this browser remembered, or null (nothing stored, a value we do not know, or storage that throws). */
export function readStoredView(getStorage = () => localStorage) {
  try {
    return normalizeView(getStorage().getItem(VIEW_KEY));
  } catch {
    return null;
  }
}

/** Remember the view for next time. Returns whether it was stored; a refusing storage is not an error (the page still works). */
export function writeStoredView(view, getStorage = () => localStorage) {
  try {
    getStorage().setItem(VIEW_KEY, view);
    return true;
  } catch {
    return false;
  }
}

/** The view to open with: the address, else the stored choice, else the cards. */
export const initialView = (search, getStorage) => viewParam(search) || readStoredView(getStorage) || DEFAULT_VIEW;

/** The address with `?view=` set, every other parameter (`focus`) and the #fragment kept. */
export function viewUrl(loc, view) {
  const q = new URLSearchParams(loc.search);
  q.set("view", view);
  return `${loc.pathname}?${q.toString()}${loc.hash || ""}`;
}
