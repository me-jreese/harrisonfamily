// Principal from the auth-edge session cookie (@io-kit/auth/server) + S3-driven admin list (Q-4).
import { createPublicKey } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { resolveAuth } from "@io-kit/auth/server";
import { parseCookies } from "./http.js";

/** Secret is a PEM private key, or JSON {privateKey|pem, kid}. Only the derived PUBLIC key is kept in memory. */
export function jwksFromSecret(secretString, defaultKid = "hfy-session-1") {
  let pem = secretString;
  let kid = defaultKid;
  if (secretString.trim().startsWith("{")) {
    const o = JSON.parse(secretString);
    pem = o.privateKey ?? o.private_key ?? o.pem;
    kid = o.kid ?? kid;
  }
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  return createLocalJWKSet({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
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
      log.error?.("admin list unavailable (failing closed)", e instanceof Error ? e.message : String(e));
      cache = { at: now() - ttlMs + 5_000, ids: new Set() }; // retry in 5s, nobody is admin meanwhile
    }
    return cache.ids;
  };
}

/**
 * Returns async (event) => actor | null. null means no (valid) session. Throws nothing for bad tokens.
 * Actor: { id: gramps_id, label, admin }.
 */
export function createAuthenticator({ issuer, audience, cookieName = "io_id", getJwks, getAdmins, log = console }) {
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
      return { id: principal.sub, label: principal.displayName ?? principal.sub, admin: admins.has(principal.sub) };
    } catch (e) {
      log.warn?.("session rejected", e?.code ?? (e instanceof Error ? e.message : String(e)));
      return null;
    }
  };
}
