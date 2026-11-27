// The client's one read of GET /api/life-state (HFY-TSK-427; the route is HFY-TSK-426, behind lifeStateV1 and 404 when off). With the flag
// off: no request and `{enabled: false}`. With it on: one request per page load, memoised (and shared with 11ty/js/person-page.js through
// `window.HFYLifeState`), failing CLOSED: an error, a signed-out page or a body that is not the contract means "no evidence", so people
// older than the threshold read "status unknown" (never "living" by default). Nothing here writes anything.
import { api } from "./api.js";
import { FLAG } from "./life-state-copy.js";

export const EMPTY = Object.freeze({ evidence: Object.freeze({}), confirmed: Object.freeze({}) });
let memo = null;

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);

/** The newest day per person from a list of {person, at}; entries that are not that shape are dropped. */
function newest(list) {
  const out = {};
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.person !== "string" || !isDay(e.at)) continue;
    if (!out[e.person] || e.at > out[e.person]) out[e.person] = e.at;
  }
  return out;
}

/** `{enabled: true, evidence, confirmed, now}` from a reply body, or no evidence when the body is not the contract. */
export function readLifeState(reply, now = new Date()) {
  const ok = reply && typeof reply === "object" && !Array.isArray(reply);
  return { enabled: true, evidence: ok ? newest(reply.evidence) : {}, confirmed: ok ? newest(reply.confirmed) : {}, now };
}

async function flagOn() {
  try {
    const resolve = typeof window !== "undefined" ? window.HFYFeatureFlags?.resolveFlags : null;
    const f = await Promise.resolve(typeof resolve === "function" ? resolve() : {});
    return Boolean(f) && f[FLAG] === true;
  } catch { return false; }
}

/** Resolves the evidence once per page load. Never rejects. `deps` is for tests: `{flagOn, get, now, shared: false}`. */
export function loadLifeState(deps = {}) {
  const share = deps.shared !== false && typeof window !== "undefined";
  if (share && window.HFYLifeState) return window.HFYLifeState;
  if (memo && deps.shared !== false) return memo;
  const get = deps.get || ((p) => api.get(p));
  const now = deps.now || (() => new Date());
  const p = (async () => {
    if (!(await (deps.flagOn || flagOn)())) return { enabled: false };
    try { return readLifeState(await get("/life-state"), now()); } catch { return readLifeState(null, now()); }
  })();
  if (deps.shared !== false) { memo = p; if (share) window.HFYLifeState = p; }
  return p;
}

/** Forget the memo (tests). */
export function forgetLifeState() { memo = null; if (typeof window !== "undefined") delete window.HFYLifeState; }
