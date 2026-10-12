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
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Maps any thrown value to a JSON error response. Unknown errors are 500 with no detail. */
export function errorResponse(e, log = console) {
  if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
  if (e instanceof ContentError) {
    return json(e.status, { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
  }
  if (e instanceof CommentError) return json(e.status, { error: e.code, message: e.message, ...(e.field ? { details: { field: e.field } } : {}) });
  log.error?.("unhandled", e instanceof Error ? e.stack : String(e));
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
