// HFY-TSK-282: puts a Playwright page in front of the REAL API over the fake store (api/test/edit-e2e-world.js). The browser's /api calls are answered
// by the API handler itself (routes, gates, privacy guard, rebase, transactions); only /auth, the flags file and the static people index are stubbed,
// because the site's static files and Cognito are not part of the API. The signed-in member is `who.id`: change it and reload to act as someone else.
import { createEditWorld } from "../../api/test/edit-e2e-world.js";

export { createEditWorld };
export const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, recordEdit: true, proposalReview: true, relationshipWizard: true };
// The people the wizard's search can find: the static index only (the records themselves come from the API).
export const PEOPLE = [
  { grampsId: "I0003", displayName: "Hazel Birchwell", lifespanSummary: "" },
  { grampsId: "I0006", displayName: "Briar Testwood", lifespanSummary: "" },
];

/** Route a page's auth, flags, people index and /api to `world`, acting as `who.id`. Every API exchange is recorded in `log`. */
export async function attach(page, world, who, { flags = {} } = {}) {
  const log = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: who.id ? { authenticated: true, sub: who.id, grampsId: who.id, label: who.label || "Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const headers = await req.allHeaders();
    const keep = {};
    for (const k of ["idempotency-key", "if-match"]) if (headers[k]) keep[k] = headers[k];
    const body = req.postData() ? req.postDataJSON() : undefined;
    const res = await world.call(req.method(), u.pathname, who.id, { body, query: Object.fromEntries(u.searchParams), headers: keep });
    log.push({ method: req.method(), path: u.pathname, query: u.search, status: res.status, body });
    const out = { "content-type": "application/json" };
    for (const k of ["etag", "idempotent-replayed"]) if (res.headers?.[k]) out[k] = res.headers[k];
    return r.fulfill({ status: res.status, headers: out, body: JSON.stringify(res.body ?? {}) });
  });
  return log;
}
