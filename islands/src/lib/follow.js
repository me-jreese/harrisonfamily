// HFY-TSK-186 (flag recordSubsV1; social.md section 6, R-12): the client for record follows and its copy. Pure apart from the api it is
// given, so tests/follow.test.mjs runs it in node. Routes (HFY-TSK-254): GET /api/subscriptions?subject=person:<id>,
// GET /api/subscriptions?cursor=&limit=, PUT and DELETE /api/subscriptions/person/<id>.
import { api as defaultApi } from "./api.js";

export const FOLLOW_COPY = {
  follow: "follow",
  following: "following",
  followLabel: "follow this page",
  helper: "we'll let you know when this page changes.",
  failed: "that didn't save. try again, or text J.",
  listTitle: "pages you follow",
  listFailed: "that didn't work. try again, or text J.",
  empty: "you're not following any pages yet. open someone's page and tap follow.",
  unfollow: "unfollow",
  showMore: "show more",
  unknownPage: "a page",
};
/** The first page of "pages you follow" and each "show more" after it. */
export const PAGE_SIZE = 10;
export const HELPER_KEY = "hfy:follow-helper";

const SUBJECT = /^person:(.+)$/;
export const subjectFor = (personId) => `person:${personId}`;
export const personIdOf = (subject) => { const m = SUBJECT.exec(typeof subject === "string" ? subject : ""); return m ? m[1] : null; };

/** Am I following `personId`? A boolean; rejects with the ApiError (a 404 means the routes are dark: the flag is off at the API). */
export async function getFollowing(personId, api = defaultApi) {
  const r = await api.get("/subscriptions", { query: { subject: subjectFor(personId) } });
  return r && r.subscribed === true;
}
export const follow = (personId, api = defaultApi) => api.put(`/subscriptions/person/${encodeURIComponent(personId)}`, {});
export const unfollow = (personId, api = defaultApi) => api.del(`/subscriptions/person/${encodeURIComponent(personId)}`);

/** One page of my follows, newest first: `{ items: [{ id, createdAt }], cursor }` (cursor null on the last page). */
export async function listFollows({ cursor, limit = PAGE_SIZE } = {}, api = defaultApi) {
  const r = await api.get("/subscriptions", { query: { cursor, limit } });
  const items = (Array.isArray(r && r.items) ? r.items : []).map((i) => ({ id: personIdOf(i && i.subject), createdAt: i && i.created_at })).filter((i) => i.id);
  return { items, cursor: r && typeof r.cursor === "string" && r.cursor ? r.cursor : null };
}

/** The one-line helper shows on the first follow only. Storage can throw (private window): then it shows, every time. */
export function helperSeen(storage = globalThis.localStorage) {
  try { return storage.getItem(HELPER_KEY) === "1"; } catch { return false; }
}
export function markHelperSeen(storage = globalThis.localStorage) {
  try { storage.setItem(HELPER_KEY, "1"); } catch { /* the helper shows again next time */ }
}
