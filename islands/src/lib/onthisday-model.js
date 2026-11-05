// On this day, the island's pure model (HFY-TSK-218, flag onThisDay; HFY-PLN-002 surfaces 4.5). No DOM and no React, so a node test pins it.
// The words come from shared/onthisday-copy.mjs (the one place the voice lives); this file decides what to ask for, what to group and
// which controls to offer. Every string the API serves (names, place, detail, excerpt, alt) is member-editable and is only ever
// returned as data here; the island puts it in the page as text nodes, never as HTML.
import { HEADINGS, FALLBACK_HEADING, REMEMBERING_LABEL, FOOTER_LINK, dateLine, renderItemParts, renderBrowsePromptParts, renderPostParts, renderPromptParts, yearWord } from "../../../shared/onthisday-copy.mjs";

export { REMEMBERING_LABEL, FOOTER_LINK };
export const HIDE_QUESTION = "hide this from on this day?";
export const HIDE_YES = "hide";
export const HIDE_NO = "keep";
export const HIDE_LABEL = "hide this";

const pad = (n) => String(n).padStart(2, "0");

/** The request query for a moment: the viewer's local day and `Date.getTimezoneOffset()` (minutes, west positive), as GET /api/onthisday takes them. */
export function queryFor(now = new Date()) {
  return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, tzOffset: now.getTimezoneOffset() };
}

/** The card's heading: the tier's own, and "on this day" for the archive and prompt tiers, which have none of their own. */
export const headingForTier = (tier) => HEADINGS[tier] ?? FALLBACK_HEADING;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * The served answer as view data, or null when there is nothing to show (an unusable body). Rows that cannot be worded are dropped.
 * { heading, dateText, rows: [{ id, tone, kind, parts, year, n, people }], remembering: [row], post, prompt, tier }
 */
export function viewOf(body) {
  if (!isObj(body)) return null;
  const seen = new Set();
  const rows = (Array.isArray(body.items) ? body.items : [])
    .map((it) => {
      if (!isObj(it) || seen.has(String(it.id))) return null;
      const parts = renderItemParts(it);
      if (parts) seen.add(String(it.id));
      return parts ? { id: String(it.id), tone: it.tone, kind: it.kind, parts, year: it.year, n: it.n, people: Array.isArray(it.people) ? it.people : [] } : null;
    })
    .filter(Boolean);
  const main = rows.filter((r) => r.tone !== "remember");
  const remembering = rows.filter((r) => r.tone === "remember");
  const p = Array.isArray(body.posts) ? body.posts.find((x) => isObj(x) && typeof x.id === "string" && Number.isInteger(x.n) && isObj(x.author)) : null;
  const post = p ? { id: p.id, parts: renderPostParts(p), excerpt: typeof p.excerpt === "string" ? p.excerpt : "", photo: safePhoto(p.photo) } : null;
  const prompt = isObj(body.prompt) ? body.prompt : null;
  if (!main.length && !remembering.length && !post && !prompt) return null;
  return { tier: body.tier, heading: headingForTier(body.tier), dateText: dateLine(body.date), rows: main, remembering, post, prompt };
}

/** A photo whose url is a same-origin path (never protocol-relative, never another host: no viewer IP or referrer leak), with its alt; anything else is dropped (the excerpt still shows). */
export function safePhoto(photo) {
  if (!isObj(photo) || typeof photo.url !== "string") return null;
  if (!/^\/(?![/\\])/.test(photo.url)) return null;
  return { url: photo.url, alt: typeof photo.alt === "string" ? photo.alt : "" };
}

/** The prompt as parts. `recordEdit` on: the full ask (add_day or generic). Off: the browse-only variant, which sends nobody to an editor. */
export function promptParts(prompt, flags) {
  if (flags && flags.recordEdit === true) return { variant: "edit", parts: renderPromptParts(prompt) };
  return { variant: "browse", parts: renderBrowsePromptParts(prompt) };
}

/** The dim line under a row: "2006 · 20 years ago". */
export const agoLine = (row) => `${row.year} · ${row.n} ${yearWord(row.n)} ago`;

/** Who sees the hide control: an admin, or a member whose own id is among the item's people (the API re-checks both). */
export function canHide(row, { admin, sub } = {}) {
  if (admin === true) return true;
  return Boolean(sub) && row.people.some((p) => p && p.grampsId === sub);
}
