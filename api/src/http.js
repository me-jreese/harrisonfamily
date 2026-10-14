// Small HTTP helpers shared by the handler and routes.
import { ContentError } from "@io-kit/content";
import { CommentError } from "@io-kit/comments";

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  vary: "authorization, cookie",
};

export function json(statusCode, body, extra = {}) {
  return { statusCode, headers: { ...JSON_HEADERS, ...extra }, body: body === undefined ? "" : JSON.stringify(body) };
}

export class HttpError extends Error {
  /**
   * `details` (optional) is sent as the body's `details`: `{fields: [{field, code, suggest?}]}` on a 422, `{current}` on a 409, or
   * a SyncError's structured conflict description (src/sync/apply.js).
   */
  constructor(status, code, message, details, headers) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (headers !== undefined) this.headers = headers; // extra response headers, for example WWW-Authenticate on a 401 (HFY-TSK-172)
  }
}

/** A log-safe token: a short word-character string, else the fallback. Error names and codes only ever pass through this. */
const logToken = (v, fallback) => (typeof v === "string" && /^[\w.-]{1,64}$/.test(v) ? v : fallback);

/**
 * The only thing the API logs about an unexpected error: `{name, code, route, requestId}` (PS-20). Never `message` or `stack`:
 * a JSON.parse failure quotes the text it choked on, and a cancelled transaction's reasons can carry the old item. `route` is the
 * matched route's name and `requestId` the Function URL's request id; both are optional.
 */
export function logSafeError(e, ctx = {}) {
  return {
    name: logToken(e instanceof Error ? e.name : undefined, "NonError"),
    code: logToken(e?.code, undefined),
    route: logToken(ctx.route, undefined),
    requestId: logToken(ctx.requestId, undefined),
  };
}

/** Maps any thrown value to a JSON error response. Unknown errors are 500 with no detail, logged as `logSafeError` only. */
export function errorResponse(e, log = console, ctx = {}) {
  // `errors` is the R-18 guard's [{pointer, kind, span}] (src/guard.js): positions only, never the matched text. `details` is the
  // HttpError's own structured, already-redacted object: `{fields}` on a 422 and `{current}` on a 409 (HFY-TSK-193), and applyBatch's
  // SyncError conflict description (per-op current versions and objects, HFY-TSK-243). An error that carries both sends both.
  if (e instanceof HttpError) {
    return json(e.status, {
      error: e.code,
      message: e.message,
      ...(Array.isArray(e.errors) ? { errors: e.errors } : {}),
      ...(e.details && typeof e.details === "object" ? { details: e.details } : {}),
    }, e.headers && typeof e.headers === "object" ? e.headers : {});
  }
  if (e instanceof ContentError) {
    return json(e.status, { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
  }
  if (e instanceof CommentError) return json(e.status, { error: e.code, message: e.message, ...(e.field ? { details: { field: e.field } } : {}) });
  log.error?.("unhandled", logSafeError(e, ctx));
  return json(500, { error: "internal", message: "internal error" });
}

export function parseCookies(event) {
  const out = {};
  const parts = [...(event.cookies ?? [])];
  const h = event.headers?.cookie ?? event.headers?.Cookie;
  if (h) parts.push(...h.split(";"));
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}
