// The Media Browser read API (HFY-TSK-387-0E, BRD D-29..D-40, 5.10, V0): list and detail over the cloud record store, the published media index (thumbnails
// and image keys) and the post store. Read-only; no write, no MCP tool. The shapes follow the @io-kit/media contract DTOs (MediaPage, MediaCard, MediaDetail,
// Tag), extended only with optional fields.
//
// Sections (D-34). `media` = every visible Media that carries neither Gramps Tag below it as `hfy-post`; `posts` = Media tagged `hfy-post` PLUS the image
// attachments of published posts that have not graduated yet (pre-backfill). Origin: hfy-post -> "post", hfy-web-upload -> "upload", neither -> "gramps".
// This file is the one sanctioned reader of those two Tags; nothing else branches on them (T-14).
//
// Visibility (D-37) is the person gallery's rule, the one isMediaPublished() applies to a comment thread: the Media is public (not private), and a
// non-private MediaRef of a live, non-private Person lists it. The list evaluates that rule in memory over the same store view (a parity test pins the
// two to the same answers); the detail asks isMediaPublished() itself as well. An open hidden MOD# item (media: or mediaref:) removes the Media or the tag
// for everyone but an admin (the owner's own-hidden view of records/mod-overlay.js is deliberately NOT extended to this browser: stricter, fail closed).
//
// Redaction (P4-R18; rule SYNC-15, transform.py:790-791): a Person with no death ref is living. In a tag, a living person's displayName is replaced by
// LIVING_NAME and the tag carries nothing else about the person; the same goes for a living post author or uploader in the origin line.
//
// addedAt: the Media's Gramps `change` (epoch seconds; the last time the object changed, the only per-Media time the store holds), or for a post attachment
// that has not graduated the post's published_at / created_at. Newest first, ties by id descending. The cursor is the (addedAt, id) of the last card, so a
// concurrent insert never duplicates or skips a card on later pages; a card that is edited and so moves to the top while paging is the one case it can miss.
import { createHash } from "node:crypto";
import { hiddenByModeration } from "@io-kit/content";
import { HttpError, logSafeError } from "./http.js";
import { isMediaPublished } from "./media-visible.js";
import { MODQ_OPEN, postAttachmentId } from "./moderation.js";
import { storeView } from "./records/index.js";
import { ATTR_ADDED_BY, ATTR_SOURCE, postIdOfSource } from "./media-origin.js";

export const LIVING_NAME = "a living family member";
export const SECTIONS = Object.freeze(["media", "posts", "all"]);
export const FILTERS = Object.freeze(["all", "needs_tags", "of_me"]);
export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 60;
export const TAG_POST = "hfy-post";
export const TAG_UPLOAD = "hfy-web-upload";
export { ATTR_ADDED_BY, ATTR_SOURCE };
const POST_PAGE_CAP = 200;
const ATTACHMENT_PREFIX = "pa-";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const notFound = () => new HttpError(404, "not_found", "no such media");
const invalid = (field, message) => new HttpError(400, "validation", message, { fields: [{ field, code: "invalid" }] });
const unavailable = (message = "the media browser is unavailable") => new HttpError(503, "unavailable", message);
const isAdmin = (a) => a?.admin === true || (Array.isArray(a?.roles) && a.roles.includes("admin"));
const sha = (s) => createHash("sha1").update(s).digest("hex");

/** Person is living by the legacy rule SYNC-15: no death ref. */
export const isLiving = (person) => !(Number.isInteger(person?.death_ref_index) && person.death_ref_index >= 0);

function personName(obj) {
  const first = obj?.primary_name?.first_name;
  const names = arr(obj?.primary_name?.surname_list);
  const last = (names.find((s) => s?.primary) ?? names[0])?.surname;
  const label = [first, last].filter((x) => typeof x === "string" && x !== "").join(" ").trim();
  return label === "" ? undefined : label.slice(0, 120);
}

const validThumb = (t) => isObj(t) && typeof t.s320 === "string" && typeof t.s800 === "string" && Number.isInteger(t.w) && t.w > 0 && Number.isInteger(t.h) && t.h > 0;
const url = (base, path) => (/^https?:\/\//.test(path) ? path : `${base}/${String(path).replace(/^\/+/, "")}`);
const rectOf = (r) => (Array.isArray(r) && r.length === 4 && r.every((n) => Number.isInteger(n)) ? [...r] : null);
const yearOf = (d) => (Array.isArray(d?.dateval) && Number.isInteger(d.dateval[2]) && d.dateval[2] > 0 ? d.dateval[2] : undefined);
const attr = (obj, string) => arr(obj.attribute_list).find((a) => a?.type?.string === string)?.value;
const describe = (obj) => { const v = arr(obj.attribute_list).find((a) => a?.type?.value === 2)?.value; return typeof v === "string" && v !== "" ? v : undefined; };

// ---- the pure catalogue --------------------------------------------------------------------------------------------------------------------------------
/**
 * Every browsable item for `viewer`, newest first. `heads`: [{class, handle, gramps_id?, version, obj}] (Person, Media, Tag live heads); `index`: Map media
 * handle -> media/index.json entry; `posts`: the published posts the viewer may see; `hidden`: Set of open hidden MOD# targets; `base`: the site origin.
 */
export function buildCatalog({ heads, index, posts, hidden, viewer, base }) {
  const admin = isAdmin(viewer);
  const isHidden = (t) => !admin && hidden.has(t);
  const persons = new Map();
  const personByGid = new Map();
  const tagName = new Map();
  const medias = [];
  for (const h of heads) {
    if (!isObj(h?.obj)) continue;
    if (h.class === "Person") {
      persons.set(h.handle, h);
      const gid = h.gramps_id ?? h.obj.gramps_id;
      if (gid) personByGid.set(gid, h);
    } else if (h.class === "Media") medias.push(h);
    else if (h.class === "Tag" && typeof h.obj.name === "string") tagName.set(h.handle, h.obj.name);
  }
  medias.sort((a, b) => (a.handle < b.handle ? -1 : 1));

  // media handle -> every non-private MediaRef of a live, non-private person: { person, index (position in that person's media_list), ref }
  const refs = new Map();
  for (const p of [...persons.values()].sort((a, b) => (a.handle < b.handle ? -1 : 1))) {
    if (p.obj.private === true) continue;
    arr(p.obj.media_list).forEach((r, i) => {
      if (!isObj(r) || typeof r.ref !== "string" || r.private === true) return;
      if (!refs.has(r.ref)) refs.set(r.ref, []);
      refs.get(r.ref).push({ person: p, index: i, ref: r });
    });
  }

  const graduatedValues = []; // every attribute value of every Media: a post photo whose upload id appears here has graduated
  for (const m of medias) for (const a of arr(m.obj.attribute_list)) if (typeof a?.value === "string") graduatedValues.push(a.value);

  const postsById = new Map();
  for (const p of posts) if (isObj(p) && typeof p.id === "string") postsById.set(p.id, p);

  const items = [];
  const seen = new Set();
  for (const m of medias) {
    const gid = m.gramps_id ?? m.obj.gramps_id;
    if (m.obj.private === true || !gid || seen.has(gid) || isHidden(`media:${m.handle}`)) continue;
    const entries = refs.get(m.handle) ?? [];
    if (entries.length === 0) continue; // not reachable through a non-private MediaRef of a non-private person: not in the person gallery
    const entry = index.get(m.handle);
    if (!entry || entry.missing === true || typeof entry.s3Key !== "string") continue; // nothing to show yet: the renderer has not published it
    seen.add(gid);
    const tags = entries.filter((e) => !isHidden(`mediaref:${e.person.handle}:${m.handle}`));
    const names = arr(m.obj.tag_list).map((h) => tagName.get(h));
    const origin = names.includes(TAG_POST) ? "post" : names.includes(TAG_UPLOAD) ? "upload" : "gramps";
    const t = validThumb(entry.thumb) ? entry.thumb : null;
    const at = Number.isFinite(m.obj.change) ? m.obj.change * 1000 : 0;
    const card = {
      mediaId: gid, thumbUrl: url(base, t ? t.s320 : entry.s3Key), width: t ? t.w : 0, height: t ? t.h : 0,
      section: origin === "post" ? "posts" : "media", tagCount: tags.length, needsTags: tags.length === 0,
      ...(typeof m.obj.desc === "string" && m.obj.desc !== "" ? { title: m.obj.desc } : {}),
      ...(yearOf(m.obj.date) ? { year: yearOf(m.obj.date) } : {}),
      grampsId: gid, addedAt: new Date(at).toISOString(),
      ...(t ? { thumb: { s320: url(base, t.s320), s800: url(base, t.s800), w: t.w, h: t.h } } : {}),
    };
    items.push({ id: gid, at, kind: "media", card, media: m, tags, origin, image: url(base, entry.s3Key), description: describe(m.obj),
      postId: postIdOfSource(attr(m.obj, ATTR_SOURCE)), addedBy: attr(m.obj, ATTR_ADDED_BY) });
  }

  // Post attachments that have not graduated (D-34, pre-backfill): not taggable, so never in needs_tags or of_me.
  for (const post of posts) {
    if (!isObj(post) || post.visibility !== "published" || (!admin && (post.moderation?.hidden === true || hiddenByModeration(post)))) continue;
    const at = Date.parse(post.published_at ?? post.created_at ?? "") || 0;
    for (const a of arr(post.attachments)) {
      const upload = postAttachmentId(a);
      if (a?.kind !== "image" || typeof a.url !== "string" || upload === undefined || (!admin && a.moderation?.hidden === true)) continue;
      if (graduatedValues.some((v) => v.includes(upload))) continue;
      const id = `${ATTACHMENT_PREFIX}${upload}`;
      const src = url(base, a.url);
      items.push({ id, at, kind: "attachment", postId: post.id, image: src, description: undefined, origin: "post", tags: [],
        card: {
          mediaId: id, thumbUrl: src, width: Number.isInteger(a.width) ? a.width : 0, height: Number.isInteger(a.height) ? a.height : 0, section: "posts",
          tagCount: 0, needsTags: false, ...(typeof a.alt === "string" && a.alt !== "" ? { title: a.alt } : {}), addedAt: new Date(at).toISOString(),
        } });
    }
  }

  items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { items, postsById, personByGid, viewerGid: typeof viewer?.id === "string" ? viewer.id : undefined };
}

const inSection = (item, section) => section === "all" || item.card.section === section;
const matchesFilter = (cat, item, filter) =>
  filter === "all" ? true
    : item.kind !== "media" ? false
      : filter === "needs_tags" ? item.tags.length === 0
        : cat.viewerGid !== undefined && item.tags.some((t) => (t.person.gramps_id ?? t.person.obj.gramps_id) === cat.viewerGid);

const cursorTag = (section, filter) => sha(`${section}|${filter}`).slice(0, 8);
const encodeCursor = (item, section, filter) => `c1.${Buffer.from(JSON.stringify([item.at, item.id])).toString("base64url")}.${cursorTag(section, filter)}`;
function decodeCursor(c, section, filter) {
  const m = /^c1\.([A-Za-z0-9_-]{1,200})\.([0-9a-f]{8})$/.exec(c);
  if (!m || m[2] !== cursorTag(section, filter)) throw invalid("cursor", "cursor does not belong to this listing");
  try {
    const [at, id] = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (Number.isFinite(at) && typeof id === "string") return { at, id };
  } catch { /* falls through */ }
  throw invalid("cursor", "cursor does not belong to this listing");
}

function parseQuery(q = {}, { forDetail = false } = {}) {
  const section = q.section === undefined || q.section === "" ? (forDetail ? undefined : "media") : q.section;
  if (section !== undefined && !SECTIONS.includes(section)) throw invalid("section", `section must be one of ${SECTIONS.join(", ")}`);
  const filter = q.filter === undefined || q.filter === "" ? "all" : q.filter;
  if (!FILTERS.includes(filter)) throw invalid("filter", `filter must be one of ${FILTERS.join(", ")}`);
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== "") {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid("limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { section, filter, limit, cursor: q.cursor === undefined || q.cursor === "" ? undefined : String(q.cursor) };
}

export function pageOf(cat, query) {
  const { section, filter, limit, cursor } = parseQuery(query);
  const counts = { media: 0, posts: 0 };
  for (const it of cat.items) if (matchesFilter(cat, it, filter)) counts[it.card.section] += 1;
  const list = cat.items.filter((it) => inSection(it, section) && matchesFilter(cat, it, filter));
  let from = 0;
  if (cursor !== undefined) {
    const c = decodeCursor(cursor, section, filter);
    from = list.findIndex((it) => it.at < c.at || (it.at === c.at && it.id < c.id));
    if (from < 0) from = list.length;
  }
  const page = list.slice(from, from + limit);
  return { cards: page.map((it) => it.card), nextCursor: from + limit < list.length ? encodeCursor(page[page.length - 1], section, filter) : null, counts };
}

export function detailOf(cat, id, query) {
  const item = cat.items.find((it) => it.id === id);
  if (!item) throw notFound();
  const q = parseQuery(query, { forDetail: true });
  const section = q.section ?? item.card.section;
  const list = cat.items.filter((it) => inSection(it, section) && matchesFilter(cat, it, q.filter));
  const at = list.findIndex((it) => it.id === id);
  const redactPerson = (gid) => {
    const p = gid ? cat.personByGid.get(gid) : undefined;
    return p && isLiving(p.obj) ? { displayName: LIVING_NAME, redacted: true } : { displayName: p ? personName(p.obj) : undefined, redacted: false };
  };

  const tags = item.tags.map((e) => {
    const gid = e.person.gramps_id ?? e.person.obj.gramps_id;
    const living = isLiving(e.person.obj);
    return {
      personId: gid, mediaId: id, rect: rectOf(e.ref.rect), index: e.index, state: "applied",
      person: living ? { displayName: LIVING_NAME, living: true } : { displayName: personName(e.person.obj) ?? gid, living: false },
    };
  });
  const post = item.postId ? cat.postsById.get(item.postId) : undefined; // only a post the viewer can see is linked
  let originRef;
  let originBy;
  if (item.origin === "post" && post) {
    const a = redactPerson(post.author?.id);
    originRef = post.id;
    originBy = { displayName: a.displayName ?? (typeof post.author?.label === "string" ? post.author.label : undefined) };
    if (a.redacted) originBy = { displayName: LIVING_NAME };
  } else if (item.origin === "upload" && typeof item.addedBy === "string") {
    const a = redactPerson(item.addedBy);
    if (!a.redacted) originRef = item.addedBy;
    originBy = { displayName: a.displayName };
  }
  if (originBy && originBy.displayName === undefined) originBy = undefined;

  const version = sha([item.media ? `${item.media.handle}:${item.media.version}` : `${id}:0`, ...item.tags.map((e) => `${e.person.handle}:${e.index}:${e.person.version}`)].join("|")).slice(0, 16);
  return {
    card: item.card, imageUrl: item.image, ...(item.description ? { description: item.description } : {}), origin: item.origin,
    ...(originRef ? { originRef } : {}), tags, version,
    ...(originBy ? { originBy } : {}),
    ...(item.media ? { handle: item.media.handle } : {}),
    ...(at >= 0 ? { position: at + 1, total: list.length } : {}),
    commentsSubject: item.kind === "media" ? `media:${id}` : item.postId ? `post:${item.postId}` : undefined,
    previousId: at > 0 ? list[at - 1].id : null, nextId: at >= 0 && at + 1 < list.length ? list[at + 1].id : null,
  };
}

// ---- sources -------------------------------------------------------------------------------------------------------------------------------------------
/** The reader of media/index.json: Map media handle -> entry, cached `ttlMs`; a failed read is not cached and throws. `load()` returns the parsed index. */
export function createMediaIndexReader({ load, now = () => Date.now(), ttlMs = 60_000 }) {
  let cached = { at: -Infinity, map: null };
  return async () => {
    if (cached.map && now() - cached.at < ttlMs) return cached.map;
    const raw = await load();
    if (!Array.isArray(raw)) throw new Error("media index is not a list");
    const map = new Map();
    for (const e of raw) if (isObj(e) && typeof e.handle === "string") map.set(e.handle, e);
    cached = { at: now(), map };
    return map;
  };
}

const defaultHeads = async (ctx) => (await storeView(ctx)).live()
  .filter((h) => h.class === "Person" || h.class === "Media" || h.class === "Tag")
  .map((h) => ({ class: h.class, handle: h.handle, gramps_id: h.gramps_id, version: h.version, obj: h.obj }));

/** The targets of every open, hidden MOD# item (media:<h>, mediaref:<person>:<media>), from the open queue (GSI1 MODQ#open). */
async function defaultHidden(ctx) {
  const out = new Set();
  let start;
  do {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": MODQ_OPEN },
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    for (const it of r.Items ?? []) {
      if (it.hidden === true && it.open !== false && typeof it.PK === "string" && /^MOD#(media|mediaref):/.test(it.PK)) out.add(it.PK.slice(4));
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Every published post the viewer can see, through the content source (its own canView and moderation rules apply). */
async function listPosts(content) {
  const out = [];
  let cursor;
  for (let i = 0; i < POST_PAGE_CAP; i += 1) {
    const r = await content.list({ limit: 100, filter: { visibility: "published" }, ...(cursor ? { cursor } : {}) });
    out.push(...r.items);
    if (!r.cursor) return out;
    cursor = r.cursor;
  }
  throw unavailable("too many posts to browse");
}

/** The per-request service. `readIndex` is createMediaIndexReader's function; `loadHeads`, `loadHidden`, `isPublished` are test seams. */
export function createMediaBrowser({ ctx, actor, content, readIndex, publicBase = "https://harrisonfamily.us", log = console, loadHeads = defaultHeads, loadHidden = defaultHidden, isPublished = isMediaPublished }) {
  const viewer = { id: actor?.id, admin: isAdmin(actor) };
  const base = String(publicBase).replace(/\/+$/, "");
  let pending;
  const guarded = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log.error?.("media browser read failed", logSafeError(e)); // codes only, never a name
      throw unavailable();
    }
  };
  const catalog = () => {
    pending ??= guarded(async () => {
      if (typeof readIndex !== "function") throw new Error("media index is not configured");
      const [heads, index, posts, hidden] = await Promise.all([loadHeads(ctx), readIndex(), listPosts(content), loadHidden(ctx)]);
      return buildCatalog({ heads, index, posts, hidden, viewer, base });
    });
    pending.catch(() => { pending = undefined; });
    return pending;
  };
  return {
    /** GET /api/media: MediaPage { cards, nextCursor, counts }. */
    list: (query) => guarded(async () => pageOf(await catalog(), query)),
    /** GET /api/media/:id: MediaDetail. A Media the person gallery does not show is 404, the same answer as one that does not exist. */
    get: (id, query) => guarded(async () => {
      if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw notFound();
      const cat = await catalog();
      const detail = detailOf(cat, id, query);
      if (!id.startsWith(ATTACHMENT_PREFIX) && !(await isPublished(ctx, id))) throw notFound();
      return detail;
    }),
  };
}
