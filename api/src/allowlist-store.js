// The DynamoDB allowlist store (HFY-TSK-134, surfaces.md 7.6, Q2-10): the write side that grants and revokes ALLOW# items, and the
// composite member reader that every allowlist consumer shares. io's S3 file and its publisher are untouched and never write these items.
//
//   ALLOW#<normalized email> / META = { entity: "allow", sub, state: "active" | "revoked", source, requestId?, at, by },
//   GSI1PK ALLOWSUB#<sub>, GSI1SK ALLOW#<email>
//
// A DynamoDB item wins over the S3 file, active or revoked (see shared/allowlist-store.mjs). Only the access-request admin routes
// (surf-access-admin-api) write these; they compose the fragments below with their own ACCESSREQ# update in one transact() call.
import { createHash, randomUUID } from "node:crypto";
import { auditItem, transact } from "./txn.js";
import { allowKeys, allowSubKey, normalizeAllowEmail } from "./shared/allowlist-store.mjs";

// The reading side (the composite member reader, the single-email and per-sub reads) is the same code the auth edge runs; it lives in
// shared/ because both zips ship it. The chat directory route and any later consumer import it from here.
export {
  ALLOW_PREFIX, ALLOWSUB_PREFIX, allowKeys, allowSubKey, allowPrincipal, createCompositeMemberReader, emailOfAllowItem, isActiveAllowItem, isAllowedNow,
  listAllowBySub, normalizeAllowEmail, readAllowEntry,
} from "./shared/allowlist-store.mjs";

/** Where a grant came from. */
export const ALLOW_SOURCES = Object.freeze(["access-request", "admin", "import"]);
export const ALLOW_STATES = Object.freeze(["active", "revoked"]);

const bad = (msg) => new TypeError(`allowlist-store: ${msg}`);
const need = (v, name) => {
  if (typeof v !== "string" || !v) throw bad(`${name} is required`);
  return v;
};
function emailOf(raw) {
  const email = normalizeAllowEmail(raw);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw bad("email is not an address");
  return email;
}

/** sha256 hex of the normalized email: the id of the AUDIT#allow:<hash> items, so an audit trail never holds an address. */
export const emailHash = (email) => createHash("sha256").update(emailOf(email)).digest("hex");

/** The ALLOW# item for an active grant. */
export function allowItem({ email: rawEmail, sub, source, requestId, at, by, effectiveAt }) {
  const email = emailOf(rawEmail);
  if (!ALLOW_SOURCES.includes(source)) throw bad(`source must be one of ${ALLOW_SOURCES.join(", ")}`);
  return {
    ...allowKeys(email),
    GSI1PK: allowSubKey(need(sub, "sub")),
    GSI1SK: `ALLOW#${email}`,
    entity: "allow",
    sub,
    state: "active",
    source,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(effectiveAt !== undefined ? { effectiveAt: need(effectiveAt, "effectiveAt") } : {}),
    at: need(at, "at"),
    by: need(by, "by"),
  };
}

const auditEntry = (op, email, by, at, before, after) => ({ op, id: `allow:${emailHash(email)}`, principalId: by, at, before, after });

/**
 * Transaction fragments (`{ puts }`, the shape transact() takes) that grant an email: a conditional Put of the active item, which holds
 * only when no item exists or the existing one is revoked (an active grant fails with ConditionalCheckFailed, the tag `allow.grant`
 * names it in TxnCancelled.failures), and the AUDIT#allow:<emailHash> item, op allow.grant. The audit holds the sub, the state and
 * the source, never the address. `effectiveAt` (an ISO time) holds a second email back until then (shared/allowlist-store.mjs isAllowedNow). Callers add their own items (the ACCESSREQ# update) to the same call; `uid` is the audit item's
 * unique suffix (a ULID in production).
 */
export function grantItems({ email, sub, source, requestId, at, by, effectiveAt, uid = randomUUID(), table }) {
  const item = allowItem({ email, sub, source, requestId, at, by, effectiveAt });
  return {
    puts: [
      { item, condition: "attribute_not_exists(PK) OR #state = :revoked", names: { "#state": "state" }, values: { ":revoked": "revoked" }, tag: "allow.grant" },
      { item: auditItem(auditEntry("allow.grant", email, by, at, null, { sub, state: "active", source }), uid, table) },
    ],
  };
}

/**
 * Transaction fragments (`{ updates, puts }`) that revoke an email: an Update to `state = revoked` that holds only while the item is
 * active for `sub` (a revoked or absent item fails with ConditionalCheckFailed, tag `allow.revoke`), and the audit item, op
 * allow.revoke. The item stays, keys and GSI1 included, so the revocation keeps overriding io's S3 file.
 */
export function revokeItems({ email, sub, at, by, reason, uid = randomUUID(), table }) {
  const e = emailOf(email);
  need(sub, "sub");
  return {
    updates: [
      {
        key: allowKeys(e),
        update: "SET #state = :revoked, #revokedAt = :at, #revokedBy = :by",
        condition: "attribute_exists(PK) AND #state = :active AND #sub = :sub",
        names: { "#state": "state", "#revokedAt": "revokedAt", "#revokedBy": "revokedBy", "#sub": "sub" },
        values: { ":revoked": "revoked", ":active": "active", ":at": need(at, "at"), ":by": need(by, "by"), ":sub": sub },
        tag: "allow.revoke",
      },
    ],
    puts: [{ item: auditItem({ ...auditEntry("allow.revoke", e, by, at, { sub, state: "active" }, { sub, state: "revoked" }), ...(reason !== undefined ? { reason } : {}) }, uid, table) }],
  };
}

/** Grants alone, in one transaction. Rejects with TxnCancelled (`conditionFailed`) when the email is already active. */
export const grantAllow = (ddb, cmds, table, params, opts) => transact(ddb, cmds, table, grantItems({ ...params, table }), opts);

/** Revokes alone, in one transaction. Rejects with TxnCancelled (`conditionFailed`) when the item is absent, revoked or another sub's. */
export const revokeAllow = (ddb, cmds, table, params, opts) => transact(ddb, cmds, table, revokeItems({ ...params, table }), opts);
