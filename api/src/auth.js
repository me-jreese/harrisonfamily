// Principal from the auth-edge session cookie (@io-kit/auth/server) + S3-driven admin list (Q-4).
import { createRemoteJWKSet, decodeJwt } from "jose";
import { resolveAuth } from "@io-kit/auth/server";
import { logSafeError, parseCookies } from "./http.js";
import { fallbackLabel, ownLabelOnly } from "./labels.js";

/** Remote JWKS published by the auth edge (HFY-R38). The edge alone holds the signing key; the API only ever sees public keys. */
export function createJwks(url, opts = {}) {
  return createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000, timeoutDuration: 5_000, ...opts });
}

/** The auth_time claim of a token resolveAuth has already verified; 0 when absent or not a number. Never falls back to iat. */
function signInTime(token) {
  try {
    const t = decodeJwt(token).auth_time;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

export function createAdminList({ load, ttlMs = 60_000, now = () => Date.now(), log = console }) {
  let cache = { at: -Infinity, ids: new Set() };
  return async () => {
    if (now() - cache.at < ttlMs) return cache.ids;
    try {
      const raw = await load();
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.admins) ? raw.admins : [];
      cache = { at: now(), ids: new Set(list.filter((x) => typeof x === "string")) };
    } catch (e) {
      log.error?.("admin list unavailable (failing closed)", logSafeError(e));
      cache = { at: now() - ttlMs + 5_000, ids: new Set() }; // retry in 5s, nobody is admin meanwhile
    }
    return cache.ids;
  };
}

/**
 * Returns async (event) => actor | null. null means no (valid) session. Throws nothing for bad tokens.
 * Actor: { id: gramps_id, label, admin, authTime }. `authTime` is the token's own auth_time claim in epoch seconds (the sign-in itself, which a refresh
 * never renews), or 0 when the token carries none. It is NOT the principal's authTime: @io-kit/auth falls back to iat, and a refreshed token's iat is
 * fresh, so that fallback would pass the step-up. A missing auth_time is stale, as in sync/auth.js. POST /api/changes reads it for the 900 s freshness
 * of a destructive admin change (editing design 7.4, DEC-E9). The label is shown to every member (author.label), so it is never an email (HFY-R68):
 * `resolveLabel({sub, name})` (src/labels.js) takes the session's name only when it is a usable non-email label, else the person's
 * displayName from the site's own record, else the gramps_id. The default does no lookup (name or gramps_id).
 */
export function createAuthenticator({ issuer, audience, cookieName = "io_id", getJwks, getAdmins, resolveLabel = ownLabelOnly, log = console }) {
  return async function authenticate(event) {
    const token = parseCookies(event)[cookieName];
    if (!token) return null;
    try {
      const { principal } = await resolveAuth(token, {
        issuers: [issuer],
        audiences: [audience],
        jwks: await getJwks(),
        tokenUse: null,
      });
      const admins = await getAdmins();
      // A label problem must never end a valid session. principal.displayName is the id token's `name` (else its email): resolveLabel rejects emails.
      const label = await Promise.resolve(resolveLabel({ sub: principal.sub, name: principal.displayName })).catch(() => fallbackLabel(principal.sub));
      return { id: principal.sub, label, admin: admins.has(principal.sub), authTime: signInTime(token) };
    } catch (e) {
      log.warn?.("session rejected", logSafeError(e));
      return null;
    }
  };
}
