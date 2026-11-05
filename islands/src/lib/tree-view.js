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
export const DEFAULT_VIEW = "cards";

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
