// GET /api/me for the islands (HFY-TSK-298; the route is HFY-TSK-237, BRD2 D2-12, SOC-D16): who the viewer is and what the server lets
// them do. The one client reader: every island asks getMe(), the first call sends the request and every caller shares its answer, so a
// page costs at most one GET /api/me. The server computes admin and can.* from actor.admin; islands read them from here and never infer
// them from a comment's or post's can.delete. The answer only decides which controls to show: every write is re-checked on the server.
import { edgeSignedOut } from "./api.js";

/** The answer when /api/me cannot say: signed out (401, or a signed-out edge session), a network failure, any other error status or a
 * body that is not an object. Not admin, no capabilities. */
export const NOT_ME = Object.freeze({ id: null, label: null, admin: false, can: Object.freeze({}) });

let cached = null;

async function load(fetchImpl) {
  try {
    // A signed-out edge session makes the answer a certain 401: do not send it (the D-11 rule of createApi).
    if (await edgeSignedOut()) return NOT_ME;
    const res = await (fetchImpl || globalThis.fetch)("/api/me", { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) {
      if (res.status !== 401) console.warn(`me: GET /api/me answered ${res.status}; treating the viewer as not admin`);
      return NOT_ME;
    }
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NOT_ME;
    const can = body.can && typeof body.can === "object" && !Array.isArray(body.can) ? body.can : {};
    return Object.freeze({ ...body, admin: body.admin === true, can: Object.freeze({ ...can }) });
  } catch (e) {
    console.warn("me: GET /api/me failed; treating the viewer as not admin", e instanceof Error ? e.message : String(e));
    return NOT_ME;
  }
}

/** The viewer's /api/me answer, `{id, label, admin, can, ...}`, or NOT_ME. Never rejects. One request per page, shared by every caller. */
export function getMe({ fetchImpl } = {}) {
  return (cached ??= load(fetchImpl));
}

/** Drop the shared answer, so the next getMe() asks again (tests). */
export function forgetMe() {
  cached = null;
}

/** May the viewer moderate comments? `can.moderate` when the server sent it as a boolean, otherwise `admin`. */
export const canModerate = (me) => (typeof me?.can?.moderate === "boolean" ? me.can.moderate : me?.admin === true);
