// Shared harrisonfamily API client (HFY-TSK-066). Same-origin, session cookie from the auth edge, JSON in and out, typed errors.
// Later islands (posts, notify) reuse createApi/api; errors carry the server's {error, message, details.field} body.
export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

const codeForStatus = (s) => (s === 401 ? "unauthenticated" : s === 403 ? "forbidden" : s === 404 ? "not_found" : s === 400 || s === 422 ? "validation" : "server");

export function createApi({ base = "/api", fetchImpl } = {}) {
  async function request(method, path, { query, body, headers } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString() : "";
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    const init = { method, credentials: "include", headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } };
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
    if (!res.ok) throw new ApiError(res.status, (data && typeof data.error === "string" && data.error) || codeForStatus(res.status), data?.message, data?.details?.field);
    return data;
  }
  return {
    request,
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) => request("POST", path, { ...opts, body }),
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
