// Shared harrisonfamily API client (HFY-TSK-066). Same-origin, session cookie from the auth edge, JSON in and out, typed errors.
// Later islands (posts, notify) reuse createApi/api; errors carry the server's {error, message, details.field} body.
export class ApiError extends Error {
  /** `details` is the body's `details`: `fields` is its per-field error list (a 422) and `current` the stored item (a 409). */
  constructor(status, code, message, field, details) {
    super(message || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (field !== undefined) this.field = field;
    if (details && typeof details === "object") {
      this.details = details;
      if (Array.isArray(details.fields)) this.fields = details.fields;
    }
  }
}

const codeForStatus = (s) => (s === 401 ? "unauthenticated" : s === 403 ? "forbidden" : s === 404 ? "not_found" : s === 400 || s === 422 ? "validation" : "server");

/**
 * HFY-TSK-069 (D-11): true only when authV2's shared session probe (HFYFeatureFlags.edgeSession -> GET /auth/session, refreshed once if it
 * lapsed) answered "signed out". authV2 off, no feature-flags.js, an unreachable /auth/session or any error => false, so the request is sent
 * exactly as before. Used to skip /api calls that can only answer 401 (and log a console error) for a visitor who is not signed in.
 */
export async function edgeSignedOut() {
  const flags = globalThis.HFYFeatureFlags;
  if (!flags || typeof flags.edgeSession !== "function") return false;
  try {
    const s = await flags.edgeSession();
    return Boolean(s) && s.authenticated === false;
  } catch {
    return false;
  }
}

/** The 401 body the API itself answers with, for a call that was not sent because the edge session says signed out. */
export const signedOutResponse = () => new Response(JSON.stringify({ error: "unauthenticated", message: "Sign in to continue." }), { status: 401, headers: { "Content-Type": "application/json" } });

export function createApi({ base = "/api", fetchImpl, skipWhenSignedOut = base === "/api" } = {}) {
  async function request(method, path, { query, body, headers, signal } = {}) {
    // Every /api route needs the session cookie: with a signed-out edge session the answer is a certain 401, so do not send it.
    if (skipWhenSignedOut && (await edgeSignedOut())) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString() : "";
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    const init = { method, credentials: "include", ...(signal ? { signal } : {}), headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await (fetchImpl || globalThis.fetch)(url, init);
    } catch (e) {
      throw new ApiError(0, "network", e?.message || "network error");
    }
    if (res.status === 204) return undefined;
    let data;
    try { data = await res.json(); } catch { data = undefined; }
    if (!res.ok) throw new ApiError(res.status, (data && typeof data.error === "string" && data.error) || codeForStatus(res.status), data?.message, data?.details?.field, data?.details);
    return data;
  }
  return {
    request,
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) => request("POST", path, { ...opts, body }),
    put: (path, body, opts) => request("PUT", path, { ...opts, body }),
    patch: (path, body, opts) => request("PATCH", path, { ...opts, body }),
    del: (path, opts) => request("DELETE", path, opts),
  };
}

export const api = createApi();

/** Auth-edge session: { authenticated, sub?, label? }. Never throws; signed-out on any failure. */
export async function getSession(fetchImpl) {
  try {
    const s = await createApi({ base: "", fetchImpl }).get("/auth/session");
    return s && s.authenticated ? { authenticated: true, sub: s.sub, label: s.label || s.sub } : { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}
