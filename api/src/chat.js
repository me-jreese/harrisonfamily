// HFY-TSK-164 (hfy-chat-api-service-routes; chat.md sections 13 and 14.2-14.3, BRD2 11.5): the three service routes the chat Worker's Durable
// Object calls, and the service-token authentication they sit on.
//
//   GET  /api/chat/directory   the members the chat may list: id plus a label, never an email (the composite allowlist reader + resolveLabel)
//   POST /api/chat/push        up to 50 {recipient, conv, seq, actor}: one content-free web push each, sent in-process through the notify kit
//   POST /api/chat/archive     a conversation's META, membership epochs and up to 100 messages, mirrored idempotently into DynamoDB (R-35)
//
// Authentication is `auth: "service"` (routes.js, handler.js): an ES256 JWT in `Authorization: Bearer`, `iss` hfy-chat, `aud` hfy-api/chat, `sub`
// chat-hub, `exp - iat <= 60 s`, `jti` present, signed by a key listed in CHAT_SERVICE_PUBLIC_KEYS (stack parameter ChatServicePublicKeys, a JSON
// array of {kid, spki}). The session cookie is never read on these routes, and the service token opens no session route. With the parameter
// empty (RG-3 ships it empty; hfy-chat-worker-prod sets it) no token can verify, so every call is the same 401 as a bad token.
import { createPublicKey } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { buildDeclarativePush, sendToPrincipal } from "@io-kit/notify/server";
import { HttpError, logSafeError } from "./http.js";
import { TEMPLATE_REGISTRY } from "./shared/notify-registry.mjs";
import { cleanLabel, fallbackLabel } from "./labels.js";

export const CHAT_AUDIENCE = "hfy-api/chat";
export const CHAT_ISSUER = "hfy-chat";
export const CHAT_SUBJECT = "chat-hub";
export const CHAT_MAX_LIFETIME_SECONDS = 60;
export const CHAT_SERVICE_ACTOR = Object.freeze({ id: "service:chat", label: "chat", admin: false, service: true });
export const PUSH_FEATURE = "chat_message";

export const DIRECTORY_TTL_MS = 5 * 60_000;
export const MAX_PUSH_ITEMS = 50;
export const MAX_ARCHIVE_MESSAGES = 100;
export const MAX_ARCHIVE_MEMBERS = 500;
export const MAX_TEXT_BYTES = 4000;
export const MAX_SYS_BYTES = 2000;

/** A member id as the allowlist's values spell it (a gramps_id). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A conversation id: `dm:<uid>:<uid>` or `g:<ulid>`. */
export const CONV_RE = /^(?:dm:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|g:[A-Za-z0-9]{1,40})$/;
const CMID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLOCK_TOLERANCE_SECONDS = 5;

const challenge = (error, description) => `Bearer realm="harrisonfamily.us/api/chat"${error ? `, error="${error}", error_description="${description}"` : ""}`;
/** The one 401 every service authentication failure answers, so a caller learns nothing about which check failed. */
export const serviceUnauthenticated = () =>
  new HttpError(401, "unauthenticated", "a valid chat service token is required", undefined, { "www-authenticate": challenge("invalid_token", "the service token is missing, expired or not for this API") });
const unavailable = (msg = "chat is not available right now") => new HttpError(503, "unavailable", msg);
const bad = (msg) => new HttpError(400, "validation", msg);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Service token authentication
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * ChatServicePublicKeys -> [{kid, key}] (key is a KeyObject). The value is a JSON array of {kid, spki}, spki being the base64 of the DER
 * SubjectPublicKeyInfo (a PEM block is accepted too). Empty or whitespace is no keys. Anything malformed throws; an entry that is not a P-256
 * public key throws. The caller treats a throw as "no usable keys" (fail closed).
 */
export function parseServiceKeys(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  const list = JSON.parse(String(raw));
  if (!Array.isArray(list)) throw new TypeError("ChatServicePublicKeys must be a JSON array");
  return list.map((e) => {
    if (!e || typeof e.kid !== "string" || e.kid === "" || typeof e.spki !== "string" || e.spki === "") throw new TypeError("a key entry needs kid and spki");
    const text = e.spki.trim();
    const key = text.includes("BEGIN PUBLIC KEY") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new TypeError("a chat service key must be an ES256 (P-256) public key");
    return { kid: e.kid, key };
  });
}

/** The bearer token of a Function URL event, or undefined. */
function bearerOf(event) {
  const headers = event?.headers ?? {};
  const name = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  const v = name ? headers[name] : undefined;
  const m = typeof v === "string" ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(v.trim()) : null;
  return m ? m[1] : undefined;
}

/**
 * Returns async (event) => actor. `getKeys()` returns the raw ChatServicePublicKeys value (read on every call, so a parameter flip needs no
 * code change; parsing is cached per value). Throws the 401 HttpError for every failure; never returns null.
 */
export function createServiceAuthenticator({ getKeys, now = () => Date.now(), log = console } = {}) {
  if (typeof getKeys !== "function") throw new TypeError("createServiceAuthenticator: getKeys is required");
  let cached = { raw: undefined, keys: [] };
  const keysOf = () => {
    const raw = getKeys();
    if (raw === cached.raw) return cached.keys;
    let keys = [];
    try {
      keys = parseServiceKeys(raw);
    } catch (e) {
      log.error?.("ChatServicePublicKeys unusable (service calls refused)", logSafeError(e));
    }
    cached = { raw, keys };
    return keys;
  };
  return async function authenticateService(event) {
    const token = bearerOf(event);
    if (!token) throw serviceUnauthenticated();
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "ES256" || typeof header.kid !== "string") throw new Error("header");
      const entry = keysOf().find((k) => k.kid === header.kid);
      if (!entry) throw new Error("kid");
      const { payload } = await jwtVerify(token, entry.key, {
        algorithms: ["ES256"], issuer: CHAT_ISSUER, audience: CHAT_AUDIENCE, subject: CHAT_SUBJECT,
        requiredClaims: ["exp", "iat", "sub", "jti"], clockTolerance: CLOCK_TOLERANCE_SECONDS, currentDate: new Date(now()),
      });
      if (typeof payload.jti !== "string" || payload.jti === "" || !Number.isFinite(payload.iat) || payload.exp - payload.iat > CHAT_MAX_LIFETIME_SECONDS) throw new Error("claims");
    } catch (e) {
      log.warn?.("chat service token rejected", { name: typeof e?.code === "string" && /^[\w.-]{1,64}$/.test(e.code) ? e.code : "ChatTokenRejected" });
      throw serviceUnauthenticated();
    }
    return { ...CHAT_SERVICE_ACTOR };
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Every ALLOW# item's principal (DynamoDB grants, active or revoked), by one filtered Scan, so a member granted in the table and absent from io's
 * S3 file is listed. The composite reader then decides who is a member now. Bounded at 200 pages.
 */
export async function scanAllowSubs(ddb, cmds, table) {
  const subs = new Set();
  let key;
  for (let page = 0; page < 200; page += 1) {
    const r = await ddb.send(new cmds.ScanCommand({
      TableName: table, FilterExpression: "begins_with(PK, :allow)", ProjectionExpression: "PK, #s", ExpressionAttributeNames: { "#s": "sub" },
      ExpressionAttributeValues: { ":allow": "ALLOW#" }, ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const it of r.Items ?? []) if (typeof it.sub === "string") subs.add(it.sub);
    key = r.LastEvaluatedKey;
    if (!key) break;
  }
  return subs;
}

/**
 * deps: { readEntries, member, listGranted?, resolveLabel, now?, ttlMs?, log? }.
 * `readEntries()` is io's S3 file as a Map email -> {sub}; `member(sub)` is the composite allowlist reader (shared/allowlist-store.mjs: it applies
 * the DynamoDB items over the file, so a revoked grant is not a member) and resolves null for a non-member; `listGranted()` lists the subs of the
 * ALLOW# items. The answer is cached 5 minutes; a failed read is never cached and never served from the cache: fail closed (503), and the hub
 * keeps its snapshot. Labels come from resolveLabel (HFY-R68): never an email.
 */
export function createDirectory({ readEntries, member, listGranted, resolveLabel, now = () => Date.now(), ttlMs = DIRECTORY_TTL_MS, log = console }) {
  let cache;
  let inflight;
  const labelOf = async (sub) => {
    const l = await Promise.resolve(resolveLabel?.({ sub })).catch(() => undefined);
    return cleanLabel(l, sub) ?? fallbackLabel(sub);
  };
  async function build() {
    if (typeof readEntries !== "function" || typeof member !== "function") throw new Error("directory sources not configured");
    const subs = new Set();
    for (const v of (await readEntries()).values()) if (typeof v?.sub === "string" && ID_RE.test(v.sub)) subs.add(v.sub);
    if (listGranted) for (const s of await listGranted()) if (ID_RE.test(s)) subs.add(s);
    const ids = [...subs].sort();
    const live = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if ((await member(id)) !== null) live.push(id);
      }
    }));
    live.sort();
    const members = [];
    for (const id of live) members.push({ id, label: await labelOf(id) });
    return { version: 1, generated_at: new Date(now()).toISOString(), members };
  }
  return async function directory() {
    if (cache && now() - cache.at < ttlMs) return cache.body;
    inflight ??= build().finally(() => { inflight = undefined; });
    try {
      const body = await inflight;
      cache = { at: now(), body };
      return body;
    } catch (e) {
      log.error?.("chat directory unavailable (failing closed)", logSafeError(e));
      throw unavailable();
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The page a chat push opens (chat.md section 13): the /chat/ page with the conversation selected. */
export const chatPath = (conv) => `/chat/?c=${encodeURIComponent(conv)}`;

/**
 * Throws unless `payload` is a Declarative Web Push message that shows a notification: a non-empty title and a same-origin navigate path. iOS revokes
 * a subscription that receives a silent push (chat.md section 2 item 11, R2-37), so a payload without a title is never sent. It also refuses any
 * field that could carry message text.
 */
export function assertShowsNotification(payload) {
  const n = payload?.notification;
  if (payload?.web_push !== 8030 || !n || typeof n.title !== "string" || n.title.trim() === "") throw new TypeError("a chat push must show a notification: title is required");
  if (typeof n.navigate !== "string" || !/^\/(?!\/)/.test(n.navigate)) throw new TypeError("a chat push needs a same-origin navigate path");
  if (n.silent === true) throw new TypeError("a chat push is never silent");
  const extra = Object.keys(n.data ?? {}).filter((k) => k !== "conv" && k !== "seq");
  if (extra.length) throw new TypeError("a chat push carries conv and seq only");
  return payload;
}

/**
 * Builds the push for one item, or null when the recipient has not turned chat texts on. CHAT-D12 (BRD2 11.5, io's words): chat web push is a
 * per-user setting that defaults OFF, so only an explicit `features.chat_message.enabled === true` preference gets one. The text is the registry's
 * level 0 line, or the level 1 line naming the actor's label when the recipient chose names; never message text.
 */
export function buildChatPush({ prefs, conv, seq, actorLabel }) {
  if (prefs?.features?.[PUSH_FEATURE]?.enabled !== true) return null;
  const payload = buildDeclarativePush({
    registry: TEMPLATE_REGISTRY, feature: PUSH_FEATURE, prefs, navigate: chatPath(conv), fields: actorLabel ? { actor: actorLabel } : {},
  });
  if (!payload) return null;
  payload.notification.data = { conv, seq }; // for the client's dedupe only
  return assertShowsNotification(payload);
}

function parsePushItems(body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_PUSH_ITEMS) throw bad(`items must hold 1 to ${MAX_PUSH_ITEMS} entries`);
  return items.map((it, i) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw bad(`items[${i}] must be an object`);
    if (typeof it.recipient !== "string" || !ID_RE.test(it.recipient)) throw bad(`items[${i}].recipient is not an id`);
    if (typeof it.actor !== "string" || !ID_RE.test(it.actor)) throw bad(`items[${i}].actor is not an id`);
    if (typeof it.conv !== "string" || !CONV_RE.test(it.conv)) throw bad(`items[${i}].conv is not a conversation id`);
    if (!Number.isSafeInteger(it.seq) || it.seq < 1) throw bad(`items[${i}].seq must be a positive integer`);
    return { recipient: it.recipient, actor: it.actor, conv: it.conv, seq: it.seq };
  });
}

/**
 * deps: { subscriptions, preferences, webpush, vapid, resolveLabel, log }. Without VAPID or the stores the route answers {sent:0, skipped:n, disabled:true}.
 * `sent` counts items that reached at least one device; `skipped` the rest (the recipient has chat texts off, has no device, or a send failed).
 */
export function createChatPush({ subscriptions, preferences, webpush, vapid, resolveLabel, log = console }) {
  const enabled = Boolean(subscriptions && preferences && webpush && vapid);
  return async function push(body) {
    const items = parsePushItems(body);
    if (!enabled) return { sent: 0, skipped: items.length, disabled: true };
    let sent = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const it = items[next++];
        try {
          if (it.recipient === it.actor) continue;
          const prefs = await preferences.get(it.recipient).catch(() => null);
          const level1 = prefs?.features?.[PUSH_FEATURE]?.detail === 1;
          const actorLabel = level1 ? cleanLabel(await Promise.resolve(resolveLabel?.({ sub: it.actor })).catch(() => undefined), it.actor) ?? undefined : undefined;
          const payload = buildChatPush({ prefs, conv: it.conv, seq: it.seq, actorLabel });
          if (!payload) continue;
          const r = await sendToPrincipal({ store: subscriptions, webpush, vapid, principal: it.recipient, payload });
          if (r.sent > 0) sent += 1;
        } catch (e) {
          log.error?.("chat push failed", logSafeError(e));
        }
      }
    }));
    return { sent, skipped: items.length - sent };
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Archive mirror
// ---------------------------------------------------------------------------------------------------------------------------------------------

const pad = (n, w) => String(n).padStart(w, "0");
const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const optId = (v, what) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !ID_RE.test(v)) throw bad(`${what} is not an id`);
  return v;
};

/** Validates the archive body; returns the normalized {conv, members, msgs}. Throws 400 validation. */
export function parseArchive(body) {
  const c = body?.conv;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw bad("conv is required");
  if (typeof c.id !== "string" || !CONV_RE.test(c.id)) throw bad("conv.id is not a conversation id");
  if (c.kind !== "dm" && c.kind !== "group") throw bad("conv.kind must be dm or group");
  if ((c.kind === "dm") !== c.id.startsWith("dm:")) throw bad("conv.kind does not match conv.id");
  if (c.name !== undefined && c.name !== null && (typeof c.name !== "string" || Buffer.byteLength(c.name) > 400)) throw bad("conv.name is too long");
  if (c.policy !== undefined && c.policy !== null && c.policy !== "private" && c.policy !== "open") throw bad("conv.policy must be private or open");
  if (!isInt(c.created_at)) throw bad("conv.created_at must be an integer");
  if (!isInt(c.last_seq)) throw bad("conv.last_seq must be an integer");
  const creator = optId(c.creator, "conv.creator");
  if (!Array.isArray(body.members) || body.members.length > MAX_ARCHIVE_MEMBERS) throw bad(`members must be an array of at most ${MAX_ARCHIVE_MEMBERS}`);
  if (!Array.isArray(body.msgs) || body.msgs.length > MAX_ARCHIVE_MESSAGES) throw bad(`msgs must be an array of at most ${MAX_ARCHIVE_MESSAGES}`);
  const members = body.members.map((m, i) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw bad(`members[${i}] must be an object`);
    if (typeof m.uid !== "string" || !ID_RE.test(m.uid)) throw bad(`members[${i}].uid is not an id`);
    if (!isInt(m.epoch, 1) || m.epoch > 9999) throw bad(`members[${i}].epoch must be an integer from 1 to 9999`);
    if (!isInt(m.join_seq, 1)) throw bad(`members[${i}].join_seq must be an integer`);
    if (m.left_seq !== undefined && m.left_seq !== null && !isInt(m.left_seq, 1)) throw bad(`members[${i}].left_seq must be an integer`);
    return { uid: m.uid, epoch: m.epoch, join_seq: m.join_seq, left_seq: m.left_seq ?? null, invited_by: optId(m.invited_by, `members[${i}].invited_by`) ?? null };
  });
  const msgs = body.msgs.map((m, i) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw bad(`msgs[${i}] must be an object`);
    if (!isInt(m.seq, 1) || m.seq > 9_999_999_999) throw bad(`msgs[${i}].seq must be an integer`);
    if (typeof m.cmid !== "string" || !CMID_RE.test(m.cmid)) throw bad(`msgs[${i}].cmid is not an id`);
    if (typeof m.from !== "string" || !ID_RE.test(m.from)) throw bad(`msgs[${i}].from is not an id`);
    if (m.kind !== "msg" && m.kind !== "sys") throw bad(`msgs[${i}].kind must be msg or sys`);
    if (!isInt(m.ts)) throw bad(`msgs[${i}].ts must be an integer`);
    const out = { seq: m.seq, cmid: m.cmid, from: m.from, kind: m.kind, ts: m.ts };
    if (m.text !== undefined && m.text !== null) {
      if (typeof m.text !== "string" || Buffer.byteLength(m.text) > MAX_TEXT_BYTES) throw bad(`msgs[${i}].text is over ${MAX_TEXT_BYTES} bytes`);
      out.text = m.text;
    }
    if (m.sys !== undefined && m.sys !== null) {
      if (typeof m.sys !== "object" || Array.isArray(m.sys) || Buffer.byteLength(JSON.stringify(m.sys)) > MAX_SYS_BYTES) throw bad(`msgs[${i}].sys is not a small object`);
      out.sys = m.sys;
    }
    return out;
  });
  return {
    conv: { id: c.id, kind: c.kind, name: typeof c.name === "string" ? c.name : null, creator: creator ?? null, policy: c.policy ?? null, created_at: c.created_at, last_seq: c.last_seq },
    members, msgs,
  };
}

const isConditionFailure = (e) => e?.name === "ConditionalCheckFailedException";

/**
 * Items on the app table: CHAT#<conv> / META, E#<uid>#<epoch:4> and M#<seq:10>. No `ttl` (R-35: kept until the privacy-expunge task removes them) and no
 * GSI1 attributes (the mirror is never listed by an index). Every write is idempotent:
 *   - M#: written once (attribute_not_exists); a replay changes nothing.
 *   - E#: a closed epoch is never reopened by a stale replay.
 *   - META: overwritten per batch, but never to an older last_seq.
 */
export function createArchive({ ddb, cmds, table, now = () => Date.now(), log = console }) {
  const put = async (item, condition) => {
    try {
      await ddb.send(new cmds.PutCommand({ TableName: table, Item: item, ...(condition ? { ConditionExpression: condition.expr, ExpressionAttributeNames: condition.names, ExpressionAttributeValues: condition.values } : {}) }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  };
  return async function archive(body) {
    const { conv, members, msgs } = parseArchive(body);
    const PK = `CHAT#${conv.id}`;
    try {
      await put(
        { PK, SK: "META", entity: "chat_conv", kind: conv.kind, name: conv.name, creator: conv.creator, policy: conv.policy, created_at: conv.created_at, last_seq: conv.last_seq, archived_at: now() },
        { expr: "attribute_not_exists(PK) OR #ls <= :ls", names: { "#ls": "last_seq" }, values: { ":ls": conv.last_seq } },
      );
      for (const m of members) {
        await put(
          { PK, SK: `E#${m.uid}#${pad(m.epoch, 4)}`, entity: "chat_member", uid: m.uid, epoch: m.epoch, join_seq: m.join_seq, ...(m.left_seq !== null ? { left_seq: m.left_seq } : {}), ...(m.invited_by !== null ? { invited_by: m.invited_by } : {}) },
          { expr: "attribute_not_exists(PK) OR attribute_not_exists(#l) OR #l = :l", names: { "#l": "left_seq" }, values: { ":l": m.left_seq ?? -1 } },
        );
      }
      for (const m of msgs) {
        await put(
          { PK, SK: `M#${pad(m.seq, 10)}`, entity: "chat_msg", seq: m.seq, cmid: m.cmid, from: m.from, kind: m.kind, ts: m.ts, ...(m.text !== undefined ? { text: m.text } : {}), ...(m.sys !== undefined ? { sys: m.sys } : {}) },
          { expr: "attribute_not_exists(PK)", names: undefined, values: undefined },
        );
      }
    } catch (e) {
      log.error?.("chat archive failed", logSafeError(e));
      throw unavailable("the archive could not be written");
    }
    return { stored: msgs.length, through_seq: msgs.reduce((hi, m) => Math.max(hi, m.seq), 0) };
  };
}

/**
 * The handler's `c.chat`: { directory(), push(body), archive(body) }, built once per container (the directory cache lives in it).
 * deps: createDirectory's, createChatPush's and createArchive's.
 */
export function createChatService(deps) {
  const directory = createDirectory({
    readEntries: deps.readEntries, member: deps.memberReader, resolveLabel: deps.resolveLabel, now: deps.now, log: deps.log,
    listGranted: deps.listGranted ?? (deps.ddb ? () => scanAllowSubs(deps.ddb, deps.cmds, deps.table) : undefined),
  });
  return { directory, push: createChatPush(deps), archive: createArchive(deps) };
}
