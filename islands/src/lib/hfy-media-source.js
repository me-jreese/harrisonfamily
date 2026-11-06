// The harrisonfamily adapter for @io-kit/media (HFY-TSK-388-0A; BRD D-01, D-02, D-03, D-05, D-09, D-11, D-12): the kit's `MediaSource` contract over the
// existing /api endpoints. Pass 1 implements the upload and portrait ports, the rect unit and `normalizeRect`; the list and detail reads are thin
// pass-throughs of GET /api/media (HFY-TSK-387-0E). The tag ports (getTags, putTags, resolvePeople, consent) are lib/hfy-tag-ports.js (HFY-TSK-388-0G, pass 1); the wire rules are lib/hfy-tag-wire.js and the offline queue is lib/tag-store.js. `fetch` is injected so the unit tests run without a network.
//
//   upload.presign   POST /api/uploads {purpose: portrait|item, subject}   -> {uploadId, url, expiresAt}; the PUT goes to the pending prefix (24 h, D-12)
//   upload.commit    POST /api/media/uploads {items}                        -> [{uploadId, mediaId, state}]; graduates the Media (tag hfy-web-upload, origin Attributes)
//                    and, for purpose item, appends the MediaRef (your own page now, another person's as a proposal: state pending-proposal)
//   portrait.setPortrait POST /api/media/portrait {personId, mediaId, crop} -> Tag[]; ONE submission: the MediaRef with the crop, moved to index 0
// The server gates are the flags mediaAddV1 (item presign; commit of an item) and portraitV1 (portrait route, portrait presign; commit of a portrait); while off these calls answer 404 (REQUEST_FAILED, status 404).
import { MediaError } from "@io-kit/media";
import { createTagPorts } from "./hfy-tag-ports.js";
import { authorRect, normalizeRect as wireNormalizeRect } from "./hfy-tag-wire.js";
import { createTagQueue, createTagStore } from "./tag-store.js";
import { getMe } from "./me.js";

export const RECT_UNIT = Object.freeze({ kind: "int-percent", min: 0, max: 100 });
/** D-07: the smallest tag is 2 x 2 grid units. */
export const MIN_TAG_UNITS = 2;
export const COMMIT_CHUNK = 10;

/**
 * Reads a stored rect the way Gramps does (D-03, P4-R16; api/src/rect.js): rounded half up, clamped to 0..100 and put in order; null for the whole image
 * `[0,0,100,100]` and for a point (x1 = x2 and y1 = y2); a line is kept; anything that is not null or four finite numbers is INVALID_RECT. The authoring guard (a
 * tag at least 2 x 2 units, integers) is `validateNewRect`, used by putTags.
 */
export function normalizeRect(rect) {
  try {
    return wireNormalizeRect(rect);
  } catch (e) {
    if (e && e.code === "RECT_INVALID") throw new MediaError("INVALID_RECT", e.message);
    throw e;
  }
}

const query = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** `createHfyMediaSource({ fetch?, base? })` returns a kit `MediaSource`. `base` is the API prefix (default /api). */
export function createHfyMediaSource({ fetch: fetchImpl = (...a) => globalThis.fetch(...a), base = "/api", viewer = async () => (await getMe()).id ?? null, store = createTagStore(), people, now } = {}) {
  async function request(method, path, body, headers) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method, credentials: "same-origin", headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers ?? {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Object.assign(new MediaError("REQUEST_FAILED", "network"), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
    if (!res.ok) {
      const serverCode = data?.error?.code ?? data?.code ?? data?.error;
      const code = serverCode === "photo_has_location" ? "PHOTO_HAS_LOCATION" : "REQUEST_FAILED";
      throw Object.assign(new MediaError(code, typeof data?.error?.message === "string" ? data.error.message : `HTTP ${res.status}`), { status: res.status, serverCode: typeof serverCode === "string" ? serverCode : undefined });
    }
    return data;
  }
  const ports = createTagPorts({ request, viewer, store, ...(people ? { people } : {}), ...(now ? { now } : {}) });

  return {
    rectUnit: RECT_UNIT,
    minTagUnits: MIN_TAG_UNITS,
    normalizeRect,

    upload: {
      async presign(req) {
        const r = await request("POST", "/uploads", { purpose: req.purpose, subject: req.subject });
        return { uploadId: r.uploadId, url: r.uploadUrl, expiresAt: r.expiresAt };
      },
      async commit(items) {
        const out = [];
        for (let i = 0; i < items.length; i += COMMIT_CHUNK) {
          const rows = items.slice(i, i + COMMIT_CHUNK).map((it) => ({
            uploadId: it.uploadId, purpose: it.purpose, subject: it.subject,
            ...(it.title !== undefined ? { title: it.title } : {}), ...(it.year !== undefined ? { year: it.year } : {}), ...(it.about === true ? { about: true } : {}),
            ...(it.description !== undefined ? { description: it.description } : {}),
          }));
          const r = await request("POST", "/media/uploads", { items: rows });
          for (const x of r.items) out.push({ uploadId: x.uploadId, mediaId: x.mediaId, state: x.state, ...(x.proposal ? { proposal: x.proposal } : {}) });
        }
        return out;
      },
    },
    portrait: {
      async setPortrait(req) {
        const r = await request("POST", "/media/portrait", { personId: req.personId, mediaId: req.mediaId, crop: normalizeCrop(req.crop) });
        return r.tags;
      },
    },

    listMedia: (q) => request("GET", `/media${query({ section: q.section, filter: q.filter, cursor: q.cursor, limit: q.limit })}`),
    getMedia: (id, ctx) => request("GET", `/media/${encodeURIComponent(id)}${query({ section: ctx?.section, filter: ctx?.filter })}`),
    getTags: ports.getTags,
    putTags: ports.putTags,
    resolvePeople: ports.resolvePeople,
    consent: ports.consent,

    // HFY extensions the pass-2 editor uses: names and version of a media's tags, the server's undo of a saved change, self-untag undo and audit, the offline queue.
    readTags: ports.readTags,
    undoReceipt: ports.undoReceipt,
    undoSelfUntag: ports.undoSelfUntag,
    selfUntags: ports.selfUntags,
    auditLog: ports.auditLog,
    queue: createTagQueue({ store }),
  };
}

/** A crop on the wire: null for the full frame, else four whole percents (the editor snaps to the grid). */
function normalizeCrop(crop) {
  if (crop === null || crop === undefined) return null;
  try {
    return authorRect(crop); // a crop is authored: whole percents, at least 2 x 2 (D-07); the full frame is null
  } catch (e) {
    if (e && e.code === "RECT_INVALID") throw new MediaError("INVALID_RECT", e.message);
    throw e;
  }
}
