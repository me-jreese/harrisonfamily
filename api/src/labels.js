// HFY-R68: the display label stored as `author.label` on comments, posts, their index items and the audit entry, and named in push notifications.
// That label is shown to EVERY member, so it must never be an email address. The io_id session's `name` claim is the allowlist entry's label, and the
// allowlist (s3://harrisonfamily/config/userGrampsID.json) maps email -> gramps_id with plain-string entries, so the kit falls back to the member's
// email as the label. This module keeps the label honest on both paths (HTTP cookie: src/auth.js, MCP bearer: src/mcp.js):
//   1. the token's own name, only when it is a usable, non-email label (an allowlist entry that carries an explicit label),
//   2. else the person's `displayName` from the site's own record, s3://<frontend bucket>/person/<gramps_id>.json,
//   3. else the gramps_id (the sub). Never an email, never an error.

/** Same ceiling as the auth edge's displayNameOf (auth/src/oauth.js): the label it mints as the access token's `name` claim. */
import { logSafeError } from "./http.js";

export const LABEL_MAX = 200;
/** What a gramps_id looks like. Only ids of this shape are ever turned into an S3 key (the sub is verified, this is defence in depth). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PERSON_KEY = (grampsId) => `person/${grampsId}.json`;

/**
 * A label that is safe to show to the whole family, or undefined. Rejects: not a string, empty, just the sub, over-long, any control
 * character, and anything containing "@" (an email address, or one embedded in other text). Same rules as the auth edge's displayNameOf.
 */
export function cleanLabel(raw, sub) {
  const n = typeof raw === "string" ? raw.trim() : "";
  if (!n || n === sub || n.length > LABEL_MAX || n.includes("@") || /[\u0000-\u001f\u007f]/.test(n)) return undefined;
  return n;
}

/** The last resort: the gramps_id. If even that were email-shaped (a misconfigured allowlist), a neutral word beats leaking an address. */
export const fallbackLabel = (sub) => {
  const s = typeof sub === "string" ? sub.trim() : "";
  return s && !s.includes("@") && !/[\u0000-\u001f\u007f]/.test(s) ? s : "family member";
};

/** The no-lookup resolver (tests, and any host that has no person records): the token's own usable name, else the sub. */
export const ownLabelOnly = async ({ sub, name }) => cleanLabel(name, sub) ?? fallbackLabel(sub);

/**
 * Builds `resolveLabel({ sub, name }) => Promise<string>`. It never throws and never returns an email.
 * `load(grampsId)` returns the parsed person record (or null); it may throw (S3 down, no such key, bad JSON). Results are cached in memory for
 * this container: a found label for `ttlMs` (1 h), a definite miss (no such record, S3's 403 for one, unparsable, no usable displayName) for
 * `missTtlMs` (1 min), and any other failed fetch for `errorTtlMs` (5 s, so an S3 blip is not stamped onto many comments, but a dead bucket is not hammered either). When a refresh
 * fails after a good label was cached, the old label keeps being served. Concurrent lookups for one id share one fetch.
 */
export function createLabelResolver({ load, ttlMs = 3_600_000, missTtlMs = 60_000, errorTtlMs = 5_000, timeoutMs = 3_000, maxEntries = 1_000, now = () => Date.now(), log = console }) {
  const cache = new Map(); // gramps_id -> { label: string|undefined, until: epoch ms }
  const inflight = new Map(); // gramps_id -> Promise<string|undefined>

  const fetchLabel = async (id) => {
    let timer;
    try {
      const rec = await Promise.race([
        Promise.resolve().then(() => load(id)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("person record fetch timed out")), timeoutMs); }),
      ]);
      const label = cleanLabel(rec && typeof rec === "object" ? rec.displayName : undefined, id);
      remember(id, label, now() + (label ? ttlMs : missTtlMs));
      return label;
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      const absent = e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || status === 404;
      // Without s3:ListBucket, S3 answers 403 AccessDenied for a key that does not exist; an unreadable (bad JSON) record is as final as an absent one.
      const definite = absent || e?.name === "AccessDenied" || e?.Code === "AccessDenied" || status === 403 || e instanceof SyntaxError;
      if (!absent) log.warn?.("author label unavailable (using the gramps_id)", id, logSafeError(e));
      const stale = cache.get(id)?.label;
      remember(id, stale, now() + (definite ? missTtlMs : errorTtlMs));
      return stale;
    } finally {
      clearTimeout(timer);
    }
  };
  const remember = (id, label, until) => {
    if (cache.size >= maxEntries && !cache.has(id)) cache.clear(); // the family is a few dozen ids; this only bounds a pathological container
    cache.set(id, { label, until });
  };

  return async function resolveLabel({ sub, name } = {}) {
    const own = cleanLabel(name, sub);
    if (own) return own;
    if (typeof sub !== "string" || !ID_RE.test(sub)) return fallbackLabel(sub);
    const hit = cache.get(sub);
    if (hit && hit.until > now()) return hit.label ?? fallbackLabel(sub);
    let pending = inflight.get(sub);
    if (!pending) {
      pending = fetchLabel(sub).finally(() => inflight.delete(sub));
      inflight.set(sub, pending);
    }
    return (await pending) ?? fallbackLabel(sub);
  };
}

/**
 * HFY-TSK-254: does the site have a person record for this gramps_id (person/<id>.json)? `load(id)` is the same S3 read as the label resolver's.
 * An absent key is false (S3 answers 403 AccessDenied for a missing key without s3:ListBucket, so that counts as absent too); any other failure throws,
 * so the caller can answer 503 instead of a wrong 404. Only ids of the gramps_id shape ever become a key.
 */
export function createPersonExists({ load }) {
  return async (grampsId) => {
    if (typeof grampsId !== "string" || !ID_RE.test(grampsId)) return false;
    try {
      const rec = await load(grampsId);
      return rec !== null && rec !== undefined;
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      if (e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.name === "AccessDenied" || e?.Code === "AccessDenied" || status === 404 || status === 403) return false;
      throw e;
    }
  };
}
