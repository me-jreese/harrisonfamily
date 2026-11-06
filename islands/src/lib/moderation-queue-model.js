// /me/moderation/: the pure model of the admin moderation queue island (HFY-TSK-192, hfy-moderation-queue-page; R-32; social.md 11.5 and 11.6),
// behind the default-off flag moderationV1. GET /api/moderation?state=open|closed&cursor= lists the queue newest first; "unhide" is the same
// POST /api/moderation the item menus send (lib/moderation.js). No React here: the words, the tabs, the row shape and the paging.
import { COPY as MOD_COPY } from "./moderation.js";
import { formatTime } from "./time.js";

export const FLAG = "moderationV1";
export const PAGE_SIZE = 25;

export const COPY = {
  heading: "moderation",
  signedOut: "sign in to see what's been moderated.",
  signIn: "sign in",
  notAdmin: "this page is for the people who look after the site.",
  empty: { open: "nothing is waiting. everything is visible.", closed: "nothing has been closed yet." },
  open: "open",
  unhide: MOD_COPY.unhide,
  close: MOD_COPY.close,
  more: "show more",
  loading: "loading",
  someone: "someone",
  by: "asked by",
  kindOf: { post: "post", comment: "comment", photo: "photo", note: "note", mediaref: "record link", media: "record photo" },
};

/** The two tabs, in order. `state` is the API's `?state=`. */
export const TABS = Object.freeze([
  { id: "open", label: "open", state: "open" },
  { id: "closed", label: "closed", state: "closed" },
]);
export const tabById = (id) => TABS.find((t) => t.id === id) ?? TABS[0];
/** `?tab=closed` -> "closed"; anything else is the open tab. */
export const parseTab = (search) => tabById(new URLSearchParams(String(search ?? "")).get("tab")).id;
export const locationFor = (tab) => (tab === "open" ? "" : `?tab=${encodeURIComponent(tab)}`);

/** What kind of item a row is: a photo is "photo" (its parent is the post or comment it sits on). */
export const kindWord = (target) => COPY.kindOf[target?.kind] ?? String(target?.kind ?? "item");
/** The row's state in words. */
export function stateWords(row) {
  if (row.open === false) return "closed";
  if (row.state === "changes_requested") return row.hidden ? "changes asked for, hidden" : "changes asked for";
  if (row.state === "question") return row.hidden ? "question open, hidden" : "question open";
  return row.hidden ? "hidden" : "open";
}
export const authorLabel = (row) => (typeof row?.author?.label === "string" && row.author.label.trim() !== "" ? row.author.label.trim() : COPY.someone);
/** When it was opened, or for a closed row when it was closed. */
export const whenOf = (row, now = Date.now()) => formatTime(row.open === false ? row.resolved_at ?? row.at : row.at, now);
/** A stable key for a row: its target. */
export const rowKey = (row) => JSON.stringify(row.target ?? {});
/** Only a same-site path is a link to open. */
export const safeHref = (href) => (typeof href === "string" && /^\/(?!\/)/.test(href) ? href : null);
/** The unhide button's label: "unhide" for a hidden item, "close" for an open question that hides nothing. */
export const unhideLabel = (row) => (row.hidden === true ? COPY.unhide : COPY.close);
export const canUnhide = (row) => row.open !== false;

/** The queue request: GET /api/moderation with the state, the page size and the cursor. */
export const listQuery = (tab, cursor) => ({ state: tabById(tab).state, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
/** A page of the API's answer as `{items, cursor}`; anything else is an empty page. */
export function readPage(body) {
  const items = Array.isArray(body?.items) ? body.items.filter((r) => r && typeof r === "object" && r.target && typeof r.target === "object") : [];
  return { items, cursor: typeof body?.cursor === "string" && body.cursor !== "" ? body.cursor : null };
}
/** Add a next page below the rows already shown, dropping a repeat. */
export function appendPage(shown, page) {
  const seen = new Set(shown.map(rowKey));
  return [...shown, ...page.items.filter((r) => !seen.has(rowKey(r)))];
}
/** The row without the item that was just unhidden. */
export const withoutRow = (rows, row) => rows.filter((r) => rowKey(r) !== rowKey(row));
