// Merged-person aliases on the site (merge-alias-redirect, SYNC-10). A person merged away leaves `person/<old>.json = {"mergedInto": "<new>"}`
// (written by the renderer). The legacy person page follows it in its mergedInto hook (person-page-mount-points); this module is the same rule
// for the islands: the personV2 island and the /tree/ page's ?focus=. Pure apart from the injected fetcher, so node tests cover it.

/** The id shape the site follows: the hook of 11ty/js/person-page.js uses the same pattern. */
export const MERGED_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Redirects followed at most (a cycle or a long chain stops there), matching the hook's MAX_MERGE_HOPS. */
export const MAX_MERGE_HOPS = 2;

/** The id a person JSON body points to, or null when it is not a stub, is malformed, or points at itself. */
export function mergedTarget(body, fromId) {
  const t = body && typeof body === "object" ? body.mergedInto : null;
  return typeof t === "string" && MERGED_ID_RE.test(t) && t !== fromId ? t : null;
}

/**
 * The person page address for a stub: `?id=<new>`, other parameters and the hash kept, `merged` counting the hops.
 * Returns {url} to go to, {limit: true} once MAX_MERGE_HOPS is spent, or null when `body` is not a followable stub.
 */
export function mergedRedirect(href, body, personId) {
  const target = mergedTarget(body, personId);
  if (!target) return null;
  const url = new URL(href);
  const hops = Number.parseInt(url.searchParams.get("merged") || "0", 10) || 0;
  if (hops >= MAX_MERGE_HOPS) return { limit: true };
  url.searchParams.set("id", target);
  url.searchParams.set("merged", String(hops + 1));
  return { url: url.toString() };
}

/**
 * Follow an old id through its stubs to the id that replaced it: `fetcher(url, init)` is a fetch (the gated dataFetch). Resolves the new id,
 * or null when `id` is not an alias (a live page, a 404, a network failure or a bad body all answer null: the caller keeps what it has).
 * Follows at most MAX_MERGE_HOPS stubs.
 */
export async function resolveMerged(fetcher, id, { signal } = {}) {
  let current = id;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    let next = null;
    try {
      const res = await fetcher(`/person/${encodeURIComponent(current)}.json`, { credentials: "same-origin", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
      next = res.ok ? mergedTarget(await res.json(), current) : null;
    } catch {
      next = null;
    }
    if (!next) break;
    current = next;
  }
  return current === id ? null : current;
}
