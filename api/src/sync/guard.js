// HFY-TSK-172 (sync-routes; sync.md 7.1, 8.6, 17 S02-S04): the middleware every /api/sync/* route runs behind.
//
//   handshake   X-HFY-Sync-Client, X-HFY-Gramps-Version, X-HFY-Gramps-Schema and X-HFY-Redaction-Version on every call:
//                 426 upgrade_required       client older than min_client, a header missing or malformed, Gramps not 6.0, or a schema not accepted
//                 409 redaction_version_mismatch   the client's redaction rules are not the server's
//   group       403 not_owner unless the bearer's subject is in gramps-owner (groups.json, fail closed)
//   pause       503 sync_paused on every write route while SYNC#HEAD.writes_enabled is false (applyBatch repeats the check for every origin)
//   tree        checkTree(): 403 tree_mismatch when X-HFY-Tree-Id differs from the bound tree (routes that touch the tree call it; meta and bind do not)
//
// The SYNC_API_ENABLED stop (404 not_enabled) is the route's own `gate` (syncGate below) and runs before authentication.
import { HttpError } from "../http.js";
import { serverSwitch } from "../features.js";
import { requireOwner, requireStepUp } from "./auth.js";
import { MAX_OBJ_BYTES, MAX_OPS, REDACTION_VERSION, SCHEMA_VERSION, getSyncHead } from "./store.js";

export const API_VERSION = 1;
/** Server-side defaults. SYNC#HEAD.min_client and SYNC#HEAD.accepted_schema override them without a deploy (sync.md 4.1). */
export const DEFAULT_MIN_CLIENT = "0.1.0";
export const ACCEPTED_GRAMPS = Object.freeze(["6.0"]);
export const DEFAULT_ACCEPTED_SCHEMA = Object.freeze([SCHEMA_VERSION]);
export const MAX_BODY_BYTES = 2_097_152;
export const LIMITS = Object.freeze({ max_ops: MAX_OPS, max_obj_bytes: MAX_OBJ_BYTES, max_body_bytes: MAX_BODY_BYTES });

export const HEADERS = Object.freeze({ client: "x-hfy-sync-client", gramps: "x-hfy-gramps-version", schema: "x-hfy-gramps-schema", redaction: "x-hfy-redaction-version", tree: "x-hfy-tree-id" });

/**
 * The SYNC_API_ENABLED stop (BRD2 11.1 7.1: desktop-only). Anything but "1" answers 404 not_enabled to every caller, signed in or not.
 * `env` is read on each call, so a stack parameter flip needs no cold start beyond the environment change itself.
 */
export const syncGate = (env = () => process.env) => serverSwitch("SYNC_API_ENABLED", () => {
  if (env().SYNC_API_ENABLED === "1") return true;
  throw new HttpError(404, "not_enabled", "the sync API is not enabled");
});

const headerOf = (event, name) => {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : undefined;
  return typeof v === "string" ? v.trim() : undefined;
};

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]{1,32})?$/;
/** "1.2.3" or "1.2.3-rc1" -> [1,2,3], else null. */
export const parseSemver = (v) => {
  const m = typeof v === "string" ? SEMVER.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** Negative when a < b. Both are [major, minor, patch]. */
export const compareSemver = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const intOf = (v) => (typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : null);

/** The server's side of the handshake, from SYNC#HEAD (absent head = the defaults). */
export function handshakeTerms(head) {
  const minClient = typeof head?.min_client === "string" && parseSemver(head.min_client) ? head.min_client : DEFAULT_MIN_CLIENT;
  const schema = Array.isArray(head?.accepted_schema) && head.accepted_schema.every(Number.isInteger) && head.accepted_schema.length ? [...head.accepted_schema] : [...DEFAULT_ACCEPTED_SCHEMA];
  const redaction = Number.isInteger(head?.redaction_version) ? head.redaction_version : REDACTION_VERSION;
  return { min_client: minClient, accepted: { gramps: [...ACCEPTED_GRAMPS], schema }, redaction_version: redaction };
}

const upgrade = (terms, reason, message) => new HttpError(426, "upgrade_required", message, { reason, min_client: terms.min_client, accepted: terms.accepted, redaction_version: terms.redaction_version });

/**
 * Checks the four handshake headers against `terms`. Returns `{client, gramps, schema, redaction}` (what the client said) or throws
 * 426 / 409. Never echoes a header value back: the reason is a fixed word.
 */
export function checkHandshake(event, terms) {
  const clientHeader = headerOf(event, HEADERS.client);
  const m = /^hfy_sync\/(.+)$/.exec(clientHeader ?? "");
  const version = m ? parseSemver(m[1]) : null;
  if (!version) throw upgrade(terms, "client_header", "send X-HFY-Sync-Client: hfy_sync/<semver>; update the add-on");
  if (compareSemver(version, parseSemver(terms.min_client)) < 0) throw upgrade(terms, "client_too_old", "this add-on is too old for the sync API; update it");

  const gramps = headerOf(event, HEADERS.gramps);
  const gm = /^(\d{1,4})\.(\d{1,4})(?:\.\d{1,4})?$/.exec(gramps ?? "");
  if (!gm || !terms.accepted.gramps.includes(`${gm[1]}.${gm[2]}`)) throw upgrade(terms, "gramps_version", "this Gramps version is not supported by the sync API");

  const schema = intOf(headerOf(event, HEADERS.schema));
  if (schema === null || !terms.accepted.schema.includes(schema)) throw upgrade(terms, "schema", "this Gramps database schema is not supported by the sync API");

  const redaction = intOf(headerOf(event, HEADERS.redaction));
  if (redaction === null) throw upgrade(terms, "redaction_header", "send X-HFY-Redaction-Version; update the add-on");
  if (redaction !== terms.redaction_version) throw new HttpError(409, "redaction_version_mismatch", "the add-on and the server use different redaction rules; update the add-on", { redaction_version: terms.redaction_version });
  return { client: clientHeader, gramps, schema, redaction };
}

/**
 * Runs the middleware for one sync-bearer request and returns the `c.sync` context the route handler gets:
 *   { head, terms, handshake, treeId, checkTree(), requireStepUp(reason), writesEnabled }
 * Order: gramps-owner -> body size -> handshake -> pause (writes only). The bearer was verified before this (handler.js).
 * @param {{ctx: {ddb, cmds, table}, event, actor, route, now?: () => number}} a
 */
export async function syncContext({ ctx, event, actor, route, now = () => Date.now() }) {
  requireOwner(actor); // before the head read and the handshake: a non-owner learns nothing from the 426 body
  const head = await getSyncHead(ctx);
  const terms = handshakeTerms(head);
  const body = event?.body;
  if (typeof body === "string" && Buffer.byteLength(body, event.isBase64Encoded ? "base64" : "utf8") > MAX_BODY_BYTES) throw new HttpError(413, "batch_too_large", `the request body is over ${MAX_BODY_BYTES} bytes`);
  const handshake = checkHandshake(event, terms);
  const writesEnabled = head?.writes_enabled !== false;
  if (route.write && !route.pausedOk && !writesEnabled) throw new HttpError(503, "sync_paused", "sync is paused");
  const treeId = headerOf(event, HEADERS.tree);
  return {
    head,
    terms,
    handshake,
    treeId,
    writesEnabled,
    /** 403 tree_mismatch when the client names a tree other than the bound one. A client with no tree yet (nothing bound) passes. */
    checkTree() {
      if (head?.tree_id && treeId !== head.tree_id) throw new HttpError(403, "tree_mismatch", "this request is for a different tree than the one bound to the cloud");
    },
    requireStepUp: (reason) => requireStepUp(actor, now(), reason),
    stepUp: () => actor.sync.stepUp(now()),
  };
}
