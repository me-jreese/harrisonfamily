// On this day, the past-year posts tier (HFY-TSK-194; surfaces.md section 4.4, BRD2 11.4 "4.4", review PS-14).
//
// Posts are indexed under GSI1PK=POSTS with GSI1SK=<ulid> (content.js itemsFor), and a ULID starts with its creation time, so one local calendar day of a past
// year is one key range. For each past year back to 2025 there is one Query: GSI1SK BETWEEN ulidFloor(dayStart) AND ulidCeil(dayEnd). Every candidate then passes:
//   - visibility = published (drafts and withdrawn posts are never an archive),
//   - moderation.js archiveView(post, viewer): the kit's canView plus the moderation rule (a post a moderator hid is not shown to anyone but its author and admins),
//   - attachments with moderation.hidden stripped for everyone else (archiveView redacts them),
//   - privacy-guard's BIRTHDAY_KEYWORDS: a post whose title, body or photo text names a birthday (or a birth) is skipped, so the module never resurfaces one,
//   - the hidden list (OTD#HIDDEN). The hide routes only take on-this-day item ids (evt: and birth:, surfaces.md 4.4), so no route puts a post id there today;
//     the filter is kept so a later record-level post hide needs no change here.
// The photo url is served only as an https URL or a root-relative /uploads/ path (safePhotoUrl); anything else is not shown.
// The served post is { id, n, author: {id, label}, excerpt, photo?: {url, alt} }: text only, for the island to render as text nodes.
import { archiveView } from "../moderation.js";
import { BIRTHDAY_KEYWORDS } from "../shared/privacy-guard.mjs";
import { gsiPosts } from "../keys.js";

/** The first year the site has posts (surfaces.md 4.4: "back to 2025"). */
export const FIRST_POST_YEAR = 2025;
/** At most this many past years are queried for one request. */
export const MAX_YEARS = 25;
/** Per-year page: a family posts a handful of times on any one day; the page is not walked further, and the Query runs newest first so a cut page drops the oldest. */
export const PAGE_LIMIT = 50;
export const EXCERPT_MAX = 140;
const QUERY_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeTime(ms) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) throw new RangeError(`ulid time out of range: ${ms}`);
  let out = "";
  let rest = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}
/** The smallest and the largest ULID of a millisecond. */
export const ulidFloor = (ms) => encodeTime(ms) + "0".repeat(16);
export const ulidCeil = (ms) => encodeTime(ms) + "Z".repeat(16);

/**
 * The instants (ms) that bound the local calendar day Y-MM-DD of a viewer whose `tzOffset` is Date.prototype.getTimezoneOffset() minutes
 * (UTC minus local: 420 for UTC-7, -540 for UTC+9). Returns null when that year has no such day (February 29).
 */
export function dayRange(year, month, day, tzOffset) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const start = probe.getTime() + tzOffset * 60_000;
  return { start, end: start + DAY_MS - 1 };
}

// ---- the birthday-keyword skip ----------------------------------------------------------------------------------------
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A keyword matches as a whole word (letters and digits on neither side); a space inside a keyword matches a run of white space; curly apostrophes fold to straight.
const KEYWORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...BIRTHDAY_KEYWORDS].sort((a, b) => b.length - a.length).map((k) => escape(k).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "iu");
export const mentionsBirthday = (text) => typeof text === "string" && KEYWORD_RE.test(text.normalize("NFKC").replace(/[‘’ʼ]/g, "'"));
const postTexts = (p) => [p.title, p.body, ...(Array.isArray(p.attachments) ? p.attachments.map((a) => a?.alt) : [])];

/** A photo url the island may put in an img: https, or a root-relative /uploads/ path with plain path characters. Otherwise null. */
export function safePhotoUrl(url) {
  if (typeof url !== "string" || url.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(url)) return null;
  if (/^\/uploads\/[A-Za-z0-9._~\/-]+$/.test(url)) return url.split("/").includes("..") ? null : url;
  if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(url)) return null;
  try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
}

const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
export function excerptOf(post) {
  const text = clean(post.body) || clean(post.title);
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The served shape of one visible archive post, or null when it must not be shown. `n` is whole years back. */
export function archiveEntry(stored, viewer, { n, hidden }) {
  const post = stored?.post ?? stored;
  if (!post || typeof post !== "object" || typeof post.id !== "string" || !post.author || typeof post.author.id !== "string") return null;
  if (post.visibility !== "published" || hidden.has(post.id)) return null;
  if (postTexts(post).some(mentionsBirthday)) return null;
  // HFY-TSK-258: the shared archive rule (canView, then the moderation fields and hidden photos dropped for everyone but the author and admins).
  const view = archiveView({ ...post, attachments: Array.isArray(post.attachments) ? post.attachments : [] }, viewer);
  if (!view) return null;
  const photo = view.attachments.map((a) => (a?.kind === "image" && a.moderation?.hidden !== true ? { url: safePhotoUrl(a.url), alt: a.alt } : null)).find((a) => a?.url);
  const excerpt = excerptOf(view);
  if (!excerpt && !photo) return null;
  return {
    id: post.id, n,
    author: { id: post.author.id, label: clean(post.author.label) || post.author.id },
    excerpt,
    ...(photo ? { photo: { url: photo.url, alt: clean(photo.alt) } } : {}),
  };
}

/**
 * Posts of earlier years on the viewer's local day `{ y, mo, d }`, most recent year first, each visible to `viewer`. `ddb` errors propagate (the route answers
 * without the archive tier rather than failing the whole module).
 */
export async function pastYearPosts({ ddb, cmds, table, viewer, today, tzOffset, hidden = new Set(), firstYear = FIRST_POST_YEAR }) {
  const years = [];
  for (let y = today.y - 1; y >= Math.max(firstYear, today.y - MAX_YEARS); y -= 1) {
    const range = dayRange(y, today.mo, today.d, tzOffset);
    if (range) years.push({ y, ...range });
  }
  const pages = [];
  for (let i = 0; i < years.length; i += QUERY_CONCURRENCY) {
    pages.push(...(await Promise.all(years.slice(i, i + QUERY_CONCURRENCY).map(async (yr) => {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": gsiPosts, ":lo": ulidFloor(yr.start), ":hi": ulidCeil(yr.end) },
        Limit: PAGE_LIMIT,
        ScanIndexForward: false, // a page that is cut keeps the newest posts of the day
      }));
      return { yr, items: r.Items ?? [] };
    }))));
  }
  const out = [];
  for (const { yr, items } of pages) {
    // newest first within the year
    for (const item of [...items].sort((a, b) => (a.GSI1SK < b.GSI1SK ? 1 : -1))) {
      const entry = archiveEntry(item, viewer, { n: today.y - yr.y, hidden });
      if (entry) out.push(entry);
    }
  }
  return out;
}
