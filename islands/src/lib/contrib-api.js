// The contributions reads of the person page (HFY-TSK-189, flag contribV1; routes: hfy-contrib-read-api, social.md 7.5):
//   GET /api/contributions?author=<gramps id>&cursor=&limit=   the author's events, newest first
//   GET /api/contributions/stats?author=<gramps id>            the author's counters
// Stats are read once per person per page view and shared by the column header and the hero chip. A failed read is forgotten so the next
// caller retries. Pure apart from the api it is given, so tests/contrib-model.test.mjs runs it in node.
import { api as defaultApi } from "./api.js";
import { PAGE_SIZE, cursorOf } from "./contrib-model.js";

const reads = new Map();

/** `contributions.stats` for a person: the body, shared by every caller. Rejects with the ApiError (404 = the routes are dark). */
export function readStats(personId, api = defaultApi) {
  if (!reads.has(personId)) {
    const p = Promise.resolve(api.get("/contributions/stats", { query: { author: personId } })).catch((e) => {
      reads.delete(personId);
      throw e;
    });
    reads.set(personId, p);
  }
  return reads.get(personId);
}

/** Drop the shared stats (tests). */
export function forgetStats() {
  reads.clear();
}

/** One page of `contributions.list`: `{ items, cursor }`, the cursor null on the last page. Rejects with the ApiError. */
export async function readPage(personId, { cursor, limit = PAGE_SIZE } = {}, api = defaultApi) {
  const body = await api.get("/contributions", { query: { author: personId, cursor, limit } });
  return { items: Array.isArray(body && body.items) ? body.items : [], cursor: cursorOf(body) };
}
