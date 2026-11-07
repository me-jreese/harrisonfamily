// The browse ports of the harrisonfamily adapter for @io-kit/media (HFY-TSK-388-0B; BRD D-31 to D-34, D-37, D-39; board B2 and B3): `listMedia` over
// GET /api/media and `getMedia` over GET /api/media/:id, returning the kit DTOs (MediaPage, MediaDetail). A sibling of hfy-media-source.js so the tag
// ports there stay untouched. `fetch` is injected so the unit tests run without a network.
//
//   listMedia({section, filter, cursor, limit, person?}) -> {cards, nextCursor, counts}            (the API reply already has the kit shape; cards are cleaned; `person` is a gramps_id: only the photos that person is tagged in, HFY-TSK-408)
//   getMedia(id, {section, filter})             -> {card, imageUrl, description?, origin, originRef?, originName?, neighbors?, tags, version}
//                                                  plus the extras the page uses: handle (the Gramps handle, for the shipped tag editor), commentsSubject.
// The API says `previousId` (the next newer item) and `nextId` (the next older one), `originBy.displayName` and, on a tag, `person: {displayName}`.
// The kit says `neighbors {prevId, nextId, position, total}` and `originName`. position and total come from the API (`position`, `total`); an older reply
// without them gives 0 and 0, which the page's labels draw as nothing. Errors: 404 is NOT_FOUND and 401 or 403 is FORBIDDEN (the kit shows "not found" for
// both), everything else REQUEST_FAILED with the HTTP status (0 for a network failure); the kit shows its error banner with a retry.
import { MediaError } from "@io-kit/media";

const SECTIONS = new Set(["all", "media", "posts"]);
const FILTERS = new Set(["all", "needs_tags", "of_me"]);
const PERSON_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);

/** The kit's card, from the API's: only the fields the kit reads, so an extra the API adds never reaches a DOM attribute. */
export function toCard(c) {
  const thumb = c && c.thumb && str(c.thumb.s320) ? { s320: c.thumb.s320, s800: str(c.thumb.s800) ?? c.thumb.s320, w: isNum(c.thumb.w) ? c.thumb.w : 0, h: isNum(c.thumb.h) ? c.thumb.h : 0 } : undefined;
  return {
    mediaId: String(c.mediaId), thumbUrl: String(c.thumbUrl ?? ""), ...(thumb ? { thumb } : {}), width: isNum(c.width) ? c.width : 0, height: isNum(c.height) ? c.height : 0,
    section: c.section === "posts" ? "posts" : "media", tagCount: isNum(c.tagCount) ? c.tagCount : 0, needsTags: c.needsTags === true,
    ...(str(c.title) ? { title: c.title } : {}), ...(isNum(c.year) ? { year: c.year } : {}),
  };
}

/** The kit's MediaDetail, from the API's. */
export function toDetail(d, id) {
  const prevId = str(d.previousId) ?? null;
  const nextId = str(d.nextId) ?? null;
  const inList = prevId !== null || nextId !== null || (isNum(d.position) && d.position > 0);
  return {
    card: toCard(d.card), imageUrl: String(d.imageUrl ?? ""), ...(str(d.description) ? { description: d.description } : {}), origin: d.origin === "post" || d.origin === "upload" ? d.origin : "gramps",
    ...(str(d.originRef) ? { originRef: d.originRef } : {}), ...(str(d.originBy?.displayName) ? { originName: d.originBy.displayName } : {}),
    ...(inList ? { neighbors: { prevId, nextId, position: isNum(d.position) ? d.position : 0, total: isNum(d.total) ? d.total : 0 } } : {}),
    tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => ({
      personId: String(t.personId), mediaId: String(t.mediaId ?? id), rect: Array.isArray(t.rect) ? t.rect : null, index: isNum(t.index) ? t.index : 0, state: t.state === "pending-proposal" ? "pending-proposal" : "applied",
      person: { displayName: str(t.person?.displayName) ?? String(t.personId) },
    })),
    version: String(d.version ?? ""), ...(str(d.handle) ? { handle: d.handle } : {}), ...(str(d.commentsSubject) ? { commentsSubject: d.commentsSubject } : {}),
  };
}

const query = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** `createHfyMediaBrowse({ fetch?, base? })` returns `{ listMedia, getMedia }`, the part of the kit's `MediaSource` the browser pages read. */
export function createHfyMediaBrowse({ fetch: fetchImpl = (...a) => globalThis.fetch(...a), base = "/api" } = {}) {
  async function get(path) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } });
    } catch {
      throw Object.assign(new MediaError("REQUEST_FAILED", "network"), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
    if (!res.ok) {
      const code = res.status === 404 ? "NOT_FOUND" : res.status === 401 || res.status === 403 ? "FORBIDDEN" : "REQUEST_FAILED";
      throw Object.assign(new MediaError(code, `HTTP ${res.status}`), { status: res.status });
    }
    if (!data || typeof data !== "object") throw Object.assign(new MediaError("REQUEST_FAILED", "empty reply"), { status: res.status });
    return data;
  }
  return {
    async listMedia(q) {
      const section = SECTIONS.has(q?.section) ? q.section : "media";
      const filter = FILTERS.has(q?.filter) ? q.filter : "all";
      const r = await get(`/media${query({ section, filter, cursor: q?.cursor, limit: q?.limit, person: typeof q?.person === "string" && PERSON_ID.test(q.person) ? q.person : undefined })}`);
      return {
        cards: (Array.isArray(r.cards) ? r.cards : []).map(toCard), nextCursor: str(r.nextCursor) ?? null,
        counts: { media: isNum(r.counts?.media) ? r.counts.media : 0, posts: isNum(r.counts?.posts) ? r.counts.posts : 0 },
      };
    },
    async getMedia(id, ctx) {
      const r = await get(`/media/${encodeURIComponent(id)}${query({ section: SECTIONS.has(ctx?.section) ? ctx.section : undefined, filter: FILTERS.has(ctx?.filter) ? ctx.filter : undefined })}`);
      return toDetail(r, id);
    },
  };
}
