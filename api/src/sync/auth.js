// HFY-TSK-172 (sync-routes; sync.md 7.1, BRD2 11.1 7.1): the `sync-bearer` auth mode of /api/sync/*.
//
//   authenticateSync(event)   the desktop client's access token, from `Authorization: Bearer`. RS256 through the auth edge's JWKS, the pinned issuer,
//                             `aud` including https://harrisonfamily.us/api/sync, `client_id` equal to hfy-sync-desktop. Any failure is a 401 with a
//                             WWW-Authenticate challenge (S01). The session cookie is never consulted on these routes, and an hfy-admin cookie alone
//                             never reaches a sync route.
//   Authorization             the S3 groups config (`gramps-owner`, subjects only), never the token's own `groups` claim (the MCP precedent). The group
//                             resolver fails closed: an unreadable groups.json means nobody is the owner (S02).
//   step-up                   `amr` includes "mfa" and `now - auth_time <= 300 s` (policy.js; auth_time is never refreshed, HFY-R64). A missing, zero,
//                             future or malformed auth_time is stale.
import { jwtVerify } from "jose";
import { HttpError, logSafeError } from "../http.js";
import { OWNER_GROUP, STEP_UP_MAX_AGE_SECONDS, STRONG_AMR } from "../policy.js";

export const SYNC_AUDIENCE = "https://harrisonfamily.us/api/sync";
export const SYNC_CLIENT_ID = "hfy-sync-desktop";
export const SYNC_ISSUER = "https://harrisonfamily.us/auth";
export { OWNER_GROUP };
/** A token whose auth_time lies this far ahead of our clock is not fresh (clock skew allowance, seconds). */
const FUTURE_SKEW_SECONDS = 30;
const CLOCK_TOLERANCE_SECONDS = 30;

const challenge = (error, description) =>
  `Bearer realm="harrisonfamily.us/api/sync"${error ? `, error="${error}", error_description="${description}"` : ""}`;
/** The 401 every authentication failure answers: one body and one challenge, so a caller learns nothing about which check failed. */
export const unauthenticated = () => new HttpError(401, "unauthenticated", "a valid sync access token is required", undefined, { "www-authenticate": challenge("invalid_token", "the access token is missing, expired or not for this API") });

/** The bearer token of a Function URL event, or undefined. */
export function bearerOf(event) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  const v = key ? headers[key] : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(v.trim());
  return m ? m[1] : undefined;
}

const audOk = (aud, want) => (Array.isArray(aud) ? aud.includes(want) : aud === want);

/**
 * Is the step-up fresh? `claims` is `{amr, auth_time}` (or a principal's `.sync`); `nowMs` the clock.
 * Only "mfa" counts (HFY-R67). auth_time is epoch seconds; 0, absent, non-numeric and future values are stale.
 */
export function stepUpFresh(claims, nowMs, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS) {
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  if (!STRONG_AMR.some((m) => amr.includes(m))) return false;
  const authTime = claims?.authTime ?? claims?.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime) || authTime <= 0) return false;
  const age = nowMs / 1000 - authTime;
  return age >= -FUTURE_SKEW_SECONDS && age <= maxAgeSeconds;
}

/**
 * Returns async (event) => actor. Throws the 401 HttpError for any failure; never returns null.
 * The actor is `{id, label, admin:false, sync: {sub, owner, amr, authTime, clientId, stepUp(nowMs)}}`: it has no admin power on a sync route.
 * `getGroups({sub})` is the groups resolver (policy.js createGroupResolver); a rejection fails closed (not the owner).
 */
export function createSyncAuthenticator({ issuer = SYNC_ISSUER, audience = SYNC_AUDIENCE, clientId = SYNC_CLIENT_ID, getJwks, getGroups, now = () => Date.now(), log = console } = {}) {
  if (typeof getJwks !== "function") throw new TypeError("createSyncAuthenticator: getJwks is required");
  if (typeof getGroups !== "function") throw new TypeError("createSyncAuthenticator: getGroups is required");
  return async function authenticateSync(event) {
    const token = bearerOf(event);
    if (!token) throw unauthenticated();
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, await getJwks(), { issuer, algorithms: ["RS256"], clockTolerance: CLOCK_TOLERANCE_SECONDS, requiredClaims: ["exp", "iat", "sub"], currentDate: new Date(now()) }));
    } catch (e) {
      log.warn?.("sync token rejected", logSafeError(e));
      throw unauthenticated();
    }
    // aud and client_id are checked here, not delegated: a token minted for the web session or for the MCP server must not open /api/sync.
    if (!audOk(claims.aud, audience) || claims.client_id !== clientId || typeof claims.sub !== "string" || claims.sub === "") {
      log.warn?.("sync token rejected", { name: "SyncTokenBinding" });
      throw unauthenticated();
    }
    if (claims.token_use !== "access") throw unauthenticated();
    let groups = [];
    try {
      groups = await getGroups({ sub: claims.sub });
    } catch (e) {
      log.error?.("groups unavailable (failing closed)", logSafeError(e));
    }
    const amr = Array.isArray(claims.amr) ? claims.amr.filter((m) => typeof m === "string") : [];
    const authTime = typeof claims.auth_time === "number" ? claims.auth_time : 0;
    const sync = { sub: claims.sub, owner: Array.isArray(groups) && groups.includes(OWNER_GROUP), amr, authTime, clientId: claims.client_id };
    return { id: claims.sub, label: claims.sub, admin: false, sync: { ...sync, stepUp: (nowMs = now()) => stepUpFresh(sync, nowMs) } };
  };
}

/** 403 not_owner unless the actor is a gramps-owner. */
export function requireOwner(actor) {
  if (actor?.sync?.owner !== true) throw new HttpError(403, "not_owner", "only the tree owner may use the sync API");
}

/** 403 step_up_required unless the actor's sign-in is fresh (amr mfa, auth_time within 300 s). `reason` goes in details. */
export function requireStepUp(actor, nowMs = Date.now(), reason) {
  if (actor?.sync?.stepUp?.(nowMs) === true) return;
  throw new HttpError(403, "step_up_required", "this action needs a fresh sign-in with user verification", { max_age_seconds: STEP_UP_MAX_AGE_SECONDS, ...(reason ? { reason } : {}) });
}

/**
 * Conflict decisions (BRD2 11.1 7.1, PS-22): gramps-owner plus step-up, on the sync bearer. An hfy-admin cookie alone is refused: callers
 * pass the actor of the request, and a cookie actor carries no `sync` member, so it is not_owner whatever its admin flag says.
 */
export function requireConflictDecision(actor, nowMs = Date.now()) {
  requireOwner(actor);
  requireStepUp(actor, nowMs, "conflict_decision");
}
