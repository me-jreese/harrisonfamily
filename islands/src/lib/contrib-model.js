// The pure side of the person page's contributions column and hero chip (HFY-TSK-189, flag contribV1; social.md sections 7.5 and 8, R-26,
// R-27). No React and no DOM, so node:test reaches it (tests/contrib-model.test.mjs). lib/contrib-feed.jsx and lib/contrib-chip.jsx draw with it.
//
// A row is built from one `contributions.list` item `{id, kind, at, weight, photos, ref, subject?, href, hidden?}`. The server never sends body
// text, so a row is a sentence made from the kind, a count of photos and the name of the page it is about; the name comes from the people
// corpus and falls back to "a family page" (ruling P2-R46: a name that resolves is a link through the shared PersonName helper).
import { isPersonId, personPath } from "./person-name.js";

/** The first page and every "show older contributions" after it (social.md section 8: contributions 10). */
export const PAGE_SIZE = 10;
/** Pages fetched back to back while the viewer can see none of what came (a run of hidden entries): a stop, not a limit a family will meet. */
export const MAX_EMPTY_PAGES = 5;

export const COPY = {
  heading: "contributions",
  empty: "no contributions yet.",
  addPhoto: "add a photo",
  older: "show older contributions",
  failed: "that didn't work. try again, or text J.",
  retry: "try again",
  signedOut: "sign in to see contributions.",
  hidden: "hidden",
  loading: "loading contributions",
  fallbackPage: "a family page",
  fallbackPerson: "someone",
};

/** `42 contributions`, `1 contribution`, `0 contributions` (the chip and the column header). */
export const countCopy = (n) => {
  const x = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return `${x} contribution${x === 1 ? "" : "s"}`;
};

/** The glyph each kind draws (a currentColor mask icon, src/contrib.css); an unknown kind gets the plain one. */
export const GLYPHS = Object.freeze({ post: "post", comment: "comment", self_edit: "edit", proposal_accepted: "accepted", tag: "tag", photo_to_record: "photo" });
export const glyphOf = (kind) => GLYPHS[kind] ?? "other";

/** The Gramps person id a subject names: `person:I0001` or a bare `I0001`; null for a post, a proposal or anything else. */
export function subjectPerson(subject) {
  if (typeof subject !== "string") return null;
  const id = subject.startsWith("person:") ? subject.slice(7) : subject;
  return isPersonId(id) ? id : null;
}

/**
 * The row's link. The server computes `href` (a path on this site); anything that is not a plain same-origin path is not followed, and the
 * row goes to the page the entry is about, or the author's page, instead.
 */
export function safeHref(href, fallbackId) {
  if (typeof href === "string" && /^\/(?![/\\])[^\s\\]*$/.test(href)) return href;
  return personPath(isPersonId(fallbackId) ? fallbackId : "");
}

const photoCopy = (n) => (n > 0 ? ` with ${n} photo${n === 1 ? "" : "s"}` : "");

// kind -> where the page name goes: `before` {name} `after`, and the whole sentence when the name did not resolve.
const NAMED = {
  comment: { before: "commented on ", after: "'s page", fallback: `commented on ${COPY.fallbackPage}` },
  proposal_accepted: { before: "had a change accepted on ", after: "'s page", fallback: `had a change accepted on ${COPY.fallbackPage}` },
  tag: { before: "tagged ", after: " in a photo", fallback: `tagged ${COPY.fallbackPerson} in a photo` },
  photo_to_record: { before: "their photo was added to ", after: "'s page", fallback: `their photo was added to ${COPY.fallbackPage}` },
};

/**
 * One list item as a row, or null when it is not drawable. `names` is the people corpus as `Map<grampsId, displayName>` (empty while it
 * loads or when it failed). `ownerId` is the page the feed belongs to (the fallback link).
 *   { id, kind, glyph, lead, person: {id, name} | null, tail, text, href, at, hidden }
 * `lead` + the person's name + `tail` is the sentence; `text` is the same sentence as plain text (the link's accessible name).
 */
export function rowOf(item, names, ownerId) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || item.id === "" || typeof item.kind !== "string") return null;
  const subject = typeof item.subject === "string" ? item.subject : typeof item.ref?.thread === "string" ? item.ref.thread : undefined;
  const pid = subjectPerson(subject);
  const known = pid && names instanceof Map ? String(names.get(pid) ?? "").trim() : "";
  const base = { id: item.id, kind: item.kind, glyph: glyphOf(item.kind), at: item.at, hidden: item.hidden === true, href: safeHref(item.href, pid ?? ownerId) };
  const plain = (lead) => ({ ...base, lead, person: null, tail: "", text: lead });
  switch (item.kind) {
    case "post": return plain(`shared a post${photoCopy(Number.isFinite(item.photos) ? item.photos : 0)}`);
    case "self_edit": return plain("updated their page");
    case "comment":
      if (typeof subject === "string" && subject.startsWith("post:")) return plain("commented on a post");
    // falls through: a comment on a person page names the page
    case "proposal_accepted":
    case "tag":
    case "photo_to_record": {
      const t = NAMED[item.kind];
      if (!known) return plain(t.fallback);
      return { ...base, lead: t.before, person: { id: pid, name: known }, tail: t.after, text: `${t.before}${known}${t.after}` };
    }
    default: return plain("added something");
  }
}

/**
 * The rows a viewer may see. The API already withholds `hidden` entries from everyone but the author and admins; the client holds the same
 * line (a hidden entry is drawn only on the page of the member it belongs to, `ownerView`), so a stray row is never shown to anyone else.
 */
export function rowsFor(items, { names, ownerId, ownerView }) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.hidden === true && !ownerView) continue;
    const row = rowOf(item, names, ownerId);
    if (row) out.push(row);
  }
  return out;
}

/** The next cursor of a list body, or null on the last page. */
export const cursorOf = (body) => (body && typeof body.cursor === "string" && body.cursor ? body.cursor : null);

/** `contributions.stats` -> the total (an integer, at least 0), or null when the body is not a stats answer. */
export function totalOf(stats) {
  if (!stats || typeof stats !== "object" || !Number.isFinite(stats.total)) return null;
  return Math.max(0, Math.floor(stats.total));
}

/**
 * The hero chip: `{ total, text }`, or null to draw nothing (D2-17, IF-16: "0 contributions" shows on member pages, and the chip is hidden
 * only on records that are not members). The API gives no membership answer today, so the rule is conservative: it hides the chip only
 * when the answer says `member: false`, or the page is a deceased person's with nothing credited (an author is always a member, and a
 * deceased person has no account). Anything else, a living person with no contributions included, shows "0 contributions".
 */
export function chipFor(stats, person) {
  const total = totalOf(stats);
  if (total === null) return null;
  if (stats.member === false) return null;
  if (stats.member !== true && total === 0 && person && person.isLiving === false) return null;
  return { total, text: countCopy(total) };
}
