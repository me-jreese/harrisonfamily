#!/usr/bin/env node
// The local sync dev server (HFY-TSK-181, sync-dev-harness-e2e; sync.md 15, BRD2 11.1): the real /api/sync/* handler on 127.0.0.1, wired to
// stand-ins for everything AWS, so the desktop addon and the end-to-end scenarios (gramps/tests/e2e) can run against it with no network.
//
//   node api/scripts/sync-dev-server.mjs [--port N] [--data-dir DIR] [--log-file FILE] [--owner-sub ID] [--access-ttl SECONDS]
//                                        [--id-policy mint|assign] [--keep]
//
//   /api/*                   createHandler() from src/handler.js with the in-memory table (test/fake-ddb.js), the sync-bearer authenticator
//                            (src/sync/auth.js) and the production routes, unchanged. SYNC_API_ENABLED is set to 1 for this process only
//                            (reference-counted, so several servers in one process each restore it correctly in any close order).
//   /auth/authorize          the dev authorization endpoint: validates the PKCE request the addon sends and, with no sign-in page, approves it
//                            at once for the dev owner (a synthetic gramps-owner subject) and redirects to the loopback callback with code,
//                            state and iss. `prompt=login` is a step-up: the token then carries amr "mfa" and a fresh auth_time.
//   /auth/token              authorization_code (PKCE S256, one use) and refresh_token (rotating; a reused token revokes its family, as the real
//                            auth server does) -> RS256 access tokens for aud <origin>/api/sync, client_id hfy-sync-desktop, signed by a key made
//                            at start-up. /auth/.well-known/jwks.json publishes its public half.
//   /_s3/<bucket>/<key>      the presigned URLs of the media and snapshot buckets. The store behind them is a directory (<data-dir>/s3), and the
//                            handler's own S3 client (Head, Get, Put, Copy, Delete) is the same directory. A signed PUT is refused unless the
//                            Content-Type, Content-Length and x-amz-checksum-sha256 it was signed for arrive with matching bytes.
//   /_dev/*                  health, state, the SYNC#HEAD switches (writes_enabled, seeded, merges_enabled, min_client, ...), the auth knobs, and
//                            POST /_dev/apply: a batch through applyBatch() as a WEBSITE writer (origin admin by default; self, proposal, ... are accepted), for the scenarios that
//                            need a cloud-side edit or a cloud-created object (HFY-TSK-206: the Birth retyped to Residence on the web, an ID-less
//                            person under --id-policy assign). It is the same applyBatch, validator and id policy the real writers use.
//                            GET /_dev/items?prefix= lists the keys (never the contents) of the table items under a key prefix.
//                            POST /_dev/scrub {class, handle, obj} (HFY-TSK-205) stands in for privacy-expunge's --path mode until that task lands:
//                            it rewrites one live head's object (and its log entry) in place at the SAME version and seq and raises
//                            SYNC#HEAD.expunge_epoch by one, which is what an expunge does, so the addon's expunge-notice path (a changed hash at
//                            an unchanged version) runs end to end.
//                            POST /_dev/conflicts {class, handle, paths: [{path, base?, cloud?, desktop?}], kind?, gramps_id?, source?} (HFY-TSK-338) opens one conflict
//                            in the queue, as the desktop's mirror will (synthetic values only): 200 {id, ...}. GET /_dev/conflicts?state=open|resolved|dismissed lists the
//                            queue in the wire shape of /api/sync/conflicts, for a scenario that checks a decision, a reopening or a receipt. The decision itself is the real
//                            POST /api/sync/conflicts/:id/decision, which a scenario sends with the website owner's step-up session.
//                            addon-push (HFY-TSK-206) uses /_dev/apply, /_dev/items, the writes_enabled, seeded and merges_enabled switches, the
//                            auth knobs and the snapshot half of the presigned store; addon-pull-apply (HFY-TSK-205) uses the media half of the
//                            store and /_dev/scrub. The token-lifetime knob and the step-up and lost-response-replay scenarios are still reserved
//                            for the later tasks (addon-media).
//
// REQUEST LOG. Every request is appended to <data-dir>/requests.jsonl (--log-file) BEFORE its response is sent, so a test that has the response can
// grep the log for the request: one JSON object per line with method, path, query, status, the error code, byte counts, the body's sha256 and the
// body itself: a JSON body as an embedded JSON value (grep for "gramps_id":"I0001" as written, no escaping), any other text as `body_text`, a binary
// body (a blob PUT) as its hash and size only. The Authorization header is never logged. The bodies of /auth/token, which carry codes and refresh
// tokens, are logged as the names of their fields only. The file is mode 0600 and lives in the data directory, which holds only synthetic data.
// The log embeds tree content as written (a push body holds the objects it sends), so a "tree content is absent from the log" assertion is
// meaningful only for runs whose requests carry ids and hashes (bind, status); a scenario that pushes needs redaction first.
//
// DATA DIRECTORY. The server owns one folder: a fresh temporary directory, or <data-dir>/hfy-sync-dev/ when --data-dir is given. It empties only that
// folder's s3/ store at start (the table is in memory, so a leftover object would be an orphan); anything else in a caller's directory is never
// touched, and an existing hfy-sync-dev/ that does not carry this server's marker file is refused rather than emptied. A --log-file that names
// an existing non-empty file is refused, not truncated.
//
// SCOPE. 127.0.0.1 (or ::1) only; a request whose Host header is not the server's own address is refused (421), so a web page cannot reach it by DNS
// rebinding. /auth/authorize is unauthenticated BY DESIGN: it has no sign-in page and approves any well-formed PKCE request for the dev owner
// at once, for any loopback port, so any local process (or any page that can send a request to this port) can obtain an owner token for the
// synthetic data. That is why the server is loopback-only, holds only synthetic data and lives only as long as one test run. Do not point it at
// anything real. The table, the key and the refresh tokens live in memory; the S3 directory and the log are removed on exit unless --keep or a
// caller-supplied --data-dir is given (then only its hfy-sync-dev/ folder is left, as the caller asked). Nothing here is deployed: scripts/ci/package-api.sh drops api/scripts from the Lambda zip.
//
// In-process use (the vitest suite, api/test/sync-dev-server.test.js): `const dev = await startDevServer({...}); ... await dev.close()`.
import http from "node:http";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT, createLocalJWKSet } from "jose";
import { createUlidFactory } from "@io-kit/feed";
import { DynamoPreferencesStore, DynamoSubscriptionStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "../test/fake-ddb.js";
import { createHandler } from "../src/handler.js";
import { HttpError } from "../src/http.js";
import { applyBatch } from "../src/sync/apply.js";
import { createGroupResolver } from "../src/policy.js";
import { createSyncAuthenticator, SYNC_CLIENT_ID } from "../src/sync/auth.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { CONFLICT_STATES, conflictKey, conflictView } from "../src/sync/pull.js";
import { CLASSES, headKey, logKey, objectJson, recKey, sha256 } from "../src/sync/store.js";
import { resetStoreView } from "../src/records/index.js";
import { registerRecordContributor } from "../src/record-contributor.js";

export const DEV_OWNER_SUB = "I9001"; // synthetic; the gramps-owner of the dev groups config
export const DEV_TABLE = "hfy-dev";
export const SYNC_BUCKET = "hfy-dev-sync";
export const MEDIA_BUCKET = "hfy-dev-media";
export const DEFAULT_ACCESS_TTL_S = 3600;
const KID = "hfy-dev-1";
const CODE_TTL_MS = 60_000;
const MAX_API_BODY = 6 * 1024 * 1024; // the Lambda payload limit
const MAX_BLOB_BODY = 26 * 1024 * 1024; // MAX_MEDIA_BYTES (25 MiB) plus slack
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HEAD_FIELDS = Object.freeze({
  writes_enabled: (v) => typeof v === "boolean", seeded: (v) => typeof v === "boolean", merges_enabled: (v) => typeof v === "boolean", changes_feed: (v) => typeof v === "boolean",
  min_client: (v) => typeof v === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v),
  accepted_schema: (v) => Array.isArray(v) && v.length > 0 && v.every(Number.isInteger),
  redaction_version: (v) => Number.isInteger(v),
  expunge_epoch: (v) => Number.isInteger(v) && v >= 0,
  // Stands in for `sync-admin bump-tree-id` (HFY-TSK-275): the desktop then meets another cloud tree (D50) and rebases.
  tree_id: (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
});
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const sha256B64 = (buf) => createHash("sha256").update(buf).digest("base64");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---- the directory standing in for S3 ---------------------------------------------------------------------------------------

const BUCKET = /^[a-z0-9][a-z0-9.-]{2,62}$/;
const s3Error = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/**
 * The S3 client the handler uses (Head, Get, Put, Copy and Delete, with user metadata, content types and the SHA-256 checksum) over
 * <root>/objects/<bucket>/<key>, with each object's description in <root>/meta/<bucket>/<key>.json. A key that is also the prefix of another
 * key cannot exist here (a file and a directory); the keys this API writes never collide that way.
 */
export function createLocalS3(root) {
  const objects = join(resolve(root), "objects");
  const metas = join(resolve(root), "meta");
  const where = (base, bucket, key, suffix = "") => {
    if (typeof bucket !== "string" || !BUCKET.test(bucket)) throw s3Error("InvalidBucketName", 400);
    if (typeof key !== "string" || key === "" || key.length > 1024 || key.includes("\0") || key.startsWith("/") || key.split("/").some((p) => p === "" || p === "." || p === "..")) {
      throw s3Error("InvalidArgument", 400);
    }
    const p = resolve(base, bucket, key + suffix);
    if (!p.startsWith(join(base, bucket) + sep)) throw s3Error("InvalidArgument", 400);
    return p;
  };
  const read = async (bucket, key) => {
    let bytes;
    try {
      bytes = await readFile(where(objects, bucket, key));
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return undefined;
      throw e;
    }
    let meta = {};
    try {
      meta = JSON.parse(await readFile(where(metas, bucket, key, ".json"), "utf8"));
    } catch {
      meta = {};
    }
    return { bytes, contentType: meta.contentType ?? "application/octet-stream", metadata: meta.metadata ?? {}, cacheControl: meta.cacheControl };
  };
  // Each file is written to <root>/tmp and renamed into place, so a reader never sees half a file; the description goes first, so an object
  // that exists always has the description it was written with (and a crash leaves at most a description with no object).
  const tmp = join(resolve(root), "tmp");
  const put = async (file, data) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const t = join(tmp, randomUUID());
    await writeFile(t, data, { mode: 0o600 });
    await rename(t, file);
  };
  const write = async (bucket, key, bytes, { contentType, metadata, cacheControl } = {}) => {
    const file = where(objects, bucket, key);
    const m = where(metas, bucket, key, ".json");
    await put(m, JSON.stringify({ contentType, metadata: metadata ?? {}, cacheControl }));
    await put(file, bytes);
  };
  const toBytes = (body) => (typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body ?? []));
  return {
    root: resolve(root),
    read,
    write,
    async list(bucket) {
      const out = [];
      const walk = (dir, prefix) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) (e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : out.push(`${prefix}${e.name}`));
      };
      walk(join(objects, bucket), "");
      return out.sort();
    },
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === "PutObjectCommand") {
        const bytes = toBytes(i.Body);
        await write(i.Bucket, i.Key, bytes, { contentType: i.ContentType, metadata: i.Metadata, cacheControl: i.CacheControl });
        return { ChecksumSHA256: sha256B64(bytes) };
      }
      if (name === "HeadObjectCommand") {
        const o = await read(i.Bucket, i.Key);
        if (!o) throw s3Error("NotFound", 404);
        return { ContentLength: o.bytes.length, ContentType: o.contentType, Metadata: o.metadata, ...(i.ChecksumMode === "ENABLED" ? { ChecksumSHA256: sha256B64(o.bytes) } : {}) };
      }
      if (name === "GetObjectCommand") {
        const o = await read(i.Bucket, i.Key);
        if (!o) throw s3Error("NoSuchKey", 404);
        const size = o.bytes.length;
        const m = /^bytes=(\d*)-(\d*)$/.exec(i.Range ?? "");
        const [from, to] = !m ? [0, size - 1] : m[1] === "" ? [Math.max(0, size - Number(m[2])), size - 1] : [Number(m[1]), Math.min(size - 1, m[2] === "" ? size - 1 : Number(m[2]))];
        const bytes = o.bytes.subarray(from, to + 1);
        return {
          ContentType: o.contentType, Metadata: o.metadata, ...(m && size > 0 ? { ContentRange: `bytes ${from}-${to}/${size}` } : {}),
          Body: { transformToByteArray: async () => Uint8Array.from(bytes), transformToString: async () => bytes.toString("utf8") },
        };
      }
      if (name === "CopyObjectCommand") {
        const src = String(i.CopySource ?? "");
        const cut = src.indexOf("/");
        const o = cut > 0 ? await read(src.slice(0, cut), src.slice(cut + 1)) : undefined;
        if (!o) throw s3Error("NoSuchKey", 404);
        await write(i.Bucket, i.Key, o.bytes, o);
        return { CopyObjectResult: { ChecksumSHA256: sha256B64(o.bytes) } };
      }
      if (name === "DeleteObjectCommand") {
        await rm(where(objects, i.Bucket, i.Key), { force: true });
        await rm(where(metas, i.Bucket, i.Key, ".json"), { force: true });
        return {};
      }
      throw new Error(`local s3: unsupported ${name}`);
    },
  };
}

// ---- the dev authorization server -------------------------------------------------------------------------------------------

/**
 * The dev auth server's state: a signing key, the one-use codes and the refresh families. `origin` is the server's own address (the
 * issuer is <origin>/auth, the audience <origin>/api/sync).
 */
export function createDevAuth({ origin, ownerSub = DEV_OWNER_SUB, accessTtlSeconds = DEFAULT_ACCESS_TTL_S, now = () => Date.now() }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  const issuer = `${origin}/auth`;
  const audience = `${origin}/api/sync`;
  const codes = new Map(); // code -> request
  const redeemed = new Map(); // code -> the refresh family it produced (a code shown again revokes that family: RFC 6749 4.1.2, BCP 9700)
  const refreshTokens = new Map(); // token -> { family, used }
  const families = new Map(); // family -> { revoked, authTime, amr }
  const state = { accessTtlSeconds };

  const sign = ({ sub, amr, authTime }) => {
    const iat = Math.floor(now() / 1000);
    return new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr, auth_time: authTime, scope: "sync" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setSubject(sub).setIssuer(issuer).setAudience(audience).setIssuedAt(iat).setExpirationTime(iat + state.accessTtlSeconds)
      .sign(privateKey);
  };
  const newRefresh = (family) => {
    const token = `hfyrt_${b64u(randomBytes(32))}`;
    refreshTokens.set(token, { family, used: false });
    return token;
  };
  const oauthError = (status, error, description) => ({ status, body: { error, error_description: description } });

  /** The authorization endpoint: a redirect target, or a 400 for a request that cannot be trusted with one. */
  function authorize(q) {
    const redirectUri = q.redirect_uri ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/.test(redirectUri)) return oauthError(400, "invalid_request", "redirect_uri must be a loopback callback");
    const fail = (error, description) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", issuer);
      return { status: 302, location: u.toString() };
    };
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (q.client_id !== SYNC_CLIENT_ID) return fail("unauthorized_client", "unknown client_id");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "")) return fail("invalid_request", "PKCE S256 is required");
    if (!q.state) return fail("invalid_request", "state is required");
    if (q.resource !== audience) return fail("invalid_target", "resource must be this server's /api/sync");
    if (q.scope !== undefined && q.scope !== "sync") return fail("invalid_scope", "scope must be sync");
    const code = b64u(randomBytes(24));
    codes.set(code, { challenge: q.code_challenge, redirectUri, resource: audience, stepUp: q.prompt === "login", expires: now() + CODE_TTL_MS });
    const u = new URL(redirectUri);
    u.searchParams.set("code", code);
    u.searchParams.set("state", q.state);
    u.searchParams.set("iss", issuer);
    return { status: 302, location: u.toString() };
  }

  async function token(f) {
    const bad = (d) => oauthError(400, "invalid_grant", d);
    if (f.client_id !== SYNC_CLIENT_ID) return oauthError(400, "invalid_client", "unknown client_id");
    if (f.resource !== undefined && f.resource !== audience) return oauthError(400, "invalid_target", "resource must be this server's /api/sync");
    if (f.grant_type === "authorization_code") {
      const req = codes.get(f.code ?? "");
      codes.delete(f.code ?? ""); // one use, whatever the outcome
      if (!req && redeemed.has(f.code ?? "")) {
        families.get(redeemed.get(f.code)).revoked = true; // a used code shown again: whoever holds the tokens it produced is not trusted
        return bad("the code was already used");
      }
      if (!req || req.expires < now()) return bad("the code is unknown, used or expired");
      if (f.redirect_uri !== req.redirectUri) return bad("redirect_uri does not match");
      if (!f.code_verifier || !safeEq(b64u(createHash("sha256").update(f.code_verifier).digest()), req.challenge)) return bad("the PKCE verifier does not match");
      const family = randomUUID();
      const authTime = Math.floor(now() / 1000);
      const amr = req.stepUp ? ["pwd", "mfa"] : ["pwd"];
      families.set(family, { revoked: false, authTime, amr });
      redeemed.set(f.code, family);
      return { status: 200, body: await tokenBody(family) };
    }
    if (f.grant_type === "refresh_token") {
      const r = refreshTokens.get(f.refresh_token ?? "");
      if (!r) return bad("the refresh token is unknown");
      const fam = families.get(r.family);
      if (fam.revoked) return bad("the refresh token family is revoked");
      if (r.used) {
        fam.revoked = true; // a rotated token shown again: someone holds a stale copy, so nothing in the family is trusted any more
        return bad("the refresh token was already used");
      }
      r.used = true;
      return { status: 200, body: await tokenBody(r.family) };
    }
    return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
  // auth_time and amr are those of the sign-in and never move on a refresh (HFY-R64): a step-up grows stale after 300 s.
  async function tokenBody(family) {
    const fam = families.get(family);
    return {
      access_token: await sign({ sub: ownerSub, amr: fam.amr, authTime: fam.authTime }), refresh_token: newRefresh(family),
      token_type: "Bearer", expires_in: state.accessTtlSeconds, scope: "sync",
    };
  }
  return {
    issuer, audience, ownerSub, state,
    jwks: () => ({ keys: [jwk] }),
    getJwks: async () => createLocalJWKSet({ keys: [jwk] }),
    authorize, token,
    /** A token as if the owner had signed in (for tests that need no browser dance). `stepUp` gives amr mfa and a fresh auth_time. */
    mint: ({ sub = ownerSub, stepUp = false, authAgeSeconds = 0 } = {}) => sign({ sub, amr: stepUp ? ["pwd", "mfa"] : ["pwd"], authTime: Math.floor(now() / 1000) - authAgeSeconds }),
    revokeAll() {
      for (const f of families.values()) f.revoked = true;
    },
  };
}

// ---- presigned URLs ---------------------------------------------------------------------------------------------------------

function createSigner(origin, now) {
  const secret = randomBytes(32);
  const mac = (parts) => createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");
  const url = (method, bucket, key, params, expiresIn) => {
    const exp = Math.floor(now() / 1000) + expiresIn;
    const u = new URL(`${origin}/_s3/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
    for (const [k, v] of Object.entries({ ...params, exp })) if (v !== undefined) u.searchParams.set(k, String(v));
    u.searchParams.set("sig", mac([method, bucket, key, ...[...u.searchParams].filter(([k]) => k !== "sig").sort().map(([k, v]) => `${k}=${v}`)]));
    return u.toString();
  };
  const check = (method, bucket, key, searchParams) => {
    const sig = searchParams.get("sig") ?? "";
    const rest = [...searchParams].filter(([k]) => k !== "sig").sort().map(([k, v]) => `${k}=${v}`);
    if (!safeEq(sig, mac([method, bucket, key, ...rest]))) return false;
    return Number(searchParams.get("exp")) >= Math.floor(now() / 1000);
  };
  return { url, check };
}

// ---- the server -------------------------------------------------------------------------------------------------------------

const readBody = (req, limit) => new Promise((resolveBody, reject) => {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) { // refused before one byte is read
    reject(Object.assign(new Error("body too large"), { status: 413, unread: true }));
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) {
      reject(Object.assign(new Error("body too large"), { status: 413 })); // the rest is read and dropped; the answer closes the connection
      chunks.length = 0;
    } else if (size - c.length <= limit) chunks.push(c);
  });
  req.on("end", () => resolveBody(Buffer.concat(chunks)));
  req.on("error", reject);
});

const isUtf8 = (buf) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
};
const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[v.length - 1] : v;
};

// SYNC_API_ENABLED is process-global (syncGate() reads it on each call), so servers sharing a process share it: the first one in sets it to 1 and
// remembers what it was, the last one out puts that back, in whatever order they close.
const syncFlag = { users: 0, before: undefined };
function holdSyncFlag() {
  if (syncFlag.users === 0) {
    syncFlag.before = process.env.SYNC_API_ENABLED;
    process.env.SYNC_API_ENABLED = "1";
  }
  syncFlag.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    syncFlag.users -= 1;
    if (syncFlag.users === 0) {
      if (syncFlag.before === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = syncFlag.before;
    }
  };
}

export const OWNED_DIR = "hfy-sync-dev"; // the folder inside a caller-supplied --data-dir that the server owns
const OWNED_MARKER = ".hfy-sync-dev";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Starts the server. Options: port (0 = any), dataDir (default a fresh temp directory, removed at close unless keep; a supplied one is kept, and
 * only its hfy-sync-dev/ folder is used), logFile (refused when it names an existing non-empty file), ownerSub, accessTtlSeconds,
 * idPolicy ("mint"|"assign"), keep, requestTimeoutMs, now. Returns { origin, port, dataDir, logFile, auth, ddb, s3, close() }, where dataDir is
 * the folder the server owns (s3/ and requests.jsonl live there).
 */
export async function startDevServer(opts = {}) {
  const cleanup = [];
  try {
    return await startInner(opts, cleanup);
  } catch (e) {
    for (const f of cleanup.reverse()) await f();
    throw e;
  }
}

async function startInner({ port = 0, host = "127.0.0.1", dataDir, logFile, ownerSub = DEV_OWNER_SUB, accessTtlSeconds = DEFAULT_ACCESS_TTL_S, idPolicy, keep = false, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, now = () => Date.now() }, cleanup) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("the sync dev server binds a loopback address only");
  const ownsDir = dataDir === undefined;
  const root = resolve(dataDir ?? mkdtempSync(join(tmpdir(), "hfy-sync-dev-")));
  const dir = ownsDir ? root : join(root, OWNED_DIR);
  if (ownsDir) cleanup.push(() => rmSync(dir, { recursive: true, force: true })); // before any refusal below, so a refused start leaves nothing behind
  if (!ownsDir && existsSync(dir) && !existsSync(join(dir, OWNED_MARKER))) {
    throw new Error(`${dir} exists and is not a sync dev server folder; remove it or name another --data-dir`);
  }
  if (!ownsDir && existsSync(root) && !statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const logPath = resolve(logFile ?? join(dir, "requests.jsonl"));
  if (logFile !== undefined && existsSync(logPath) && (!statSync(logPath).isFile() || statSync(logPath).size > 0)) {
    throw new Error(`${logPath} exists and is not empty; the sync dev server will not overwrite it`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!ownsDir) writeFileSync(join(dir, OWNED_MARKER), "owned by api/scripts/sync-dev-server.mjs: its s3/ store is emptied at every start\n", { mode: 0o600 });
  const releaseSyncFlag = holdSyncFlag(); // syncGate() reads SYNC_API_ENABLED on each call
  cleanup.push(releaseSyncFlag);
  rmSync(join(dir, "s3"), { recursive: true, force: true }); // a fresh store: the table is in memory, so a leftover object would be an orphan
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  closeSync(openSync(logPath, "w", 0o600));

  const ddb = createFakeDdb();
  const s3 = createLocalS3(join(dir, "s3"));
  const hooks = createHookRegistry();
  registerRecordContributor({ ddb, cmds, table: DEV_TABLE }, hooks);
  const log = { warn() {}, error: (m, d) => process.stderr.write(`sync-dev-server: ${m} ${JSON.stringify(d ?? {})}\n`) };

  // The server needs its own address before the handler is built (the issuer and the audience carry it), and the address needs the port.
  const server = http.createServer({
    requestTimeout: requestTimeoutMs, headersTimeout: Math.min(10_000, requestTimeoutMs), connectionsCheckingInterval: Math.min(1000, requestTimeoutMs),
  });
  cleanup.push(() => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }));
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  const boundPort = server.address().port;
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`;
  const hostHeader = new Set([`${host}:${boundPort}`, `localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`]);

  const auth = createDevAuth({ origin, ownerSub, accessTtlSeconds, now });
  const signer = createSigner(origin, now);
  const groups = { version: 1, groups: { "gramps-owner": { subjects: [ownerSub] } } };
  const authenticateSync = createSyncAuthenticator({
    issuer: auth.issuer, audience: auth.audience, getJwks: auth.getJwks, now,
    getGroups: createGroupResolver({ load: async () => groups, log }), log,
  });
  const ulid = createUlidFactory();
  const uid = () => ulid(now());
  const handler = createHandler({
    ddb, cmds, table: DEV_TABLE, now, log, ulid,
    authenticate: async () => null, // no cookie session here: only the sync-bearer routes are served
    authenticateSync,
    subscriptions: new DynamoSubscriptionStore(ddb, cmds, DEV_TABLE), preferences: new DynamoPreferencesStore(ddb, cmds, DEV_TABLE),
    s3, syncHooks: hooks, syncBucket: SYNC_BUCKET, mediaBucket: MEDIA_BUCKET,
    ...(idPolicy ? { idPolicy: { mode: idPolicy } } : {}),
    presignPut: async ({ bucket, key, contentType, size, expiresIn, checksumSha256 }) => signer.url("PUT", bucket, key, { ct: contentType, size, sha: checksumSha256 }, expiresIn),
    presignGet: async ({ bucket, key, expiresIn, contentType }) => signer.url("GET", bucket, key, { rct: contentType }, expiresIn),
  });

  let n = 0;
  const logRequest = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

  async function route(req, res, url, body) {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    if (path === "/auth/authorize" && method === "GET") {
      const r = auth.authorize(q);
      return r.status === 302 ? { status: 302, headers: { location: r.location, "cache-control": "no-store" }, body: "" } : json(r.status, r.body);
    }
    if (path === "/auth/token" && method === "POST") {
      const fields = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
      const r = await auth.token(fields);
      return json(r.status, r.body);
    }
    if (path === "/auth/.well-known/jwks.json" && method === "GET") return json(200, auth.jwks());
    if (path.startsWith("/_s3/")) return s3Route(method, path, url.searchParams, req, body);
    if (path.startsWith("/_dev/")) return devRoute(method, path, body, url);
    if (path.startsWith("/api/") || path === "/api") {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const r = await handler({
        requestContext: { http: { method }, requestId: `dev-${n}` }, rawPath: path, queryStringParameters: Object.keys(q).length ? q : undefined,
        headers, cookies: [], body: body.length ? body.toString("utf8") : undefined, isBase64Encoded: false,
      });
      return { status: r.statusCode, headers: r.headers ?? {}, body: r.isBase64Encoded ? Buffer.from(r.body, "base64") : (r.body ?? "") };
    }
    return json(404, { error: "not_found", message: "no such route" });
  }
  const json = (status, obj) => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: obj === undefined ? "" : JSON.stringify(obj) });

  async function s3Route(method, path, params, req, body) {
    const rest = path.slice("/_s3/".length);
    const cut = rest.indexOf("/");
    if (cut < 1) return json(404, { error: "NoSuchKey" });
    const bucket = rest.slice(0, cut);
    const key = rest.slice(cut + 1).split("/").map(decodeURIComponent).join("/");
    if (!signer.check(method, bucket, key, params)) return json(403, { error: "AccessDenied", message: "the signature does not match or has expired" });
    try {
      if (method === "PUT") {
        // What S3 enforces for the headers the presigner signed: the type, the length and the SHA-256 of the body must be the signed ones.
        if (params.has("ct") && header(req, "content-type") !== params.get("ct")) return json(403, { error: "SignatureDoesNotMatch", message: "Content-Type is not the signed one" });
        if (params.has("size") && body.length !== Number(params.get("size"))) return json(400, { error: "IncompleteBody", message: "Content-Length is not the signed one" });
        if (params.has("sha")) {
          if (header(req, "x-amz-checksum-sha256") !== params.get("sha")) return json(403, { error: "SignatureDoesNotMatch", message: "x-amz-checksum-sha256 is not the signed one" });
          if (sha256B64(body) !== params.get("sha")) return json(400, { error: "BadDigest", message: "the body does not hash to the signed checksum" });
        }
        await s3.write(bucket, key, body, { contentType: header(req, "content-type") });
        return { status: 200, headers: { etag: `"${createHash("md5").update(body).digest("hex")}"` }, body: "" };
      }
      if (method === "GET" || method === "HEAD") {
        const o = await s3.read(bucket, key);
        if (!o) return json(404, { error: "NoSuchKey" });
        return {
          status: 200, body: method === "HEAD" ? "" : o.bytes,
          headers: { "content-type": params.get("rct") ?? o.contentType, "content-length": String(o.bytes.length), "cache-control": "private, no-store" },
        };
      }
      return json(405, { error: "method_not_allowed" });
    } catch (e) {
      return json(e.$metadata?.httpStatusCode ?? 500, { error: e.name === "Error" ? "internal" : e.name });
    }
  }

  async function devRoute(method, path, body, url) {
    const parsed = () => {
      try {
        const v = body.length ? JSON.parse(body.toString("utf8")) : {};
        return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
      } catch {
        return undefined;
      }
    };
    const getHead = async () => (await ddb.send(new cmds.GetCommand({ TableName: DEV_TABLE, Key: headKey(), ConsistentRead: true }))).Item ?? null;
    if (path === "/_dev/health" && method === "GET") return json(200, { ok: true, origin });
    if (path === "/_dev/state" && method === "GET") {
      return json(200, { head: await getHead(), table_items: ddb.all().length, s3_objects: { [SYNC_BUCKET]: (await s3.list(SYNC_BUCKET)).length, [MEDIA_BUCKET]: (await s3.list(MEDIA_BUCKET)).length } });
    }
    if (path === "/_dev/head" && method === "GET") return json(200, { head: await getHead() });
    if (path === "/_dev/items" && method === "GET") {
      // The keys (PK and SK, nothing else) of the items whose PK starts with ?prefix=, for a scenario that asks "is there an IDALIAS item?".
      // Keys only: item contents are tree data, and the request log would hold them.
      const prefix = url.searchParams.get("prefix") ?? "";
      return json(200, { items: ddb.all().filter((it) => typeof it.PK === "string" && it.PK.startsWith(prefix)).map((it) => ({ PK: it.PK, SK: it.SK })).slice(0, 500) });
    }
    if (path === "/_dev/head" && method === "PATCH") {
      // Stands in for `sync-admin pause|resume` and the seed flip: sets only the switches named, each checked for its type.
      const b = parsed();
      if (!b || Object.keys(b).length === 0) return json(400, { error: "validation", message: "send a JSON object of head switches" });
      for (const [k, v] of Object.entries(b)) if (!Object.hasOwn(HEAD_FIELDS, k) || !HEAD_FIELDS[k](v)) return json(400, { error: "validation", message: `${k} is not a settable head switch or has the wrong type` });
      const head = (await getHead()) ?? { ...headKey() };
      await ddb.send(new cmds.PutCommand({ TableName: DEV_TABLE, Item: { ...head, ...b, updated_at: new Date(now()).toISOString() } }));
      return json(200, { head: await getHead() });
    }
    if (path === "/_dev/apply" && method === "POST") {
      // A website-side writer: {origin?: "admin", principal?: "web-dev", idempotency_key, ops, step_up?: bool}. 200 applyBatch's result; an
      // applyBatch refusal is answered with its own status and {error, message, details}, like the real routes.
      const b = parsed();
      if (!b || !Array.isArray(b.ops) || typeof b.idempotency_key !== "string") return json(400, { error: "validation", message: "send {idempotency_key, ops, origin?, principal?, step_up?}" });
      try {
        const r = await applyBatch(
          { ddb, cmds, table: DEV_TABLE, now, uid, log, hooks, ...(idPolicy ? { idPolicy: { mode: idPolicy } } : {}) },
          { principal: typeof b.principal === "string" ? b.principal : "web-dev", origin: typeof b.origin === "string" ? b.origin : "admin", idempotencyKey: b.idempotency_key, ops: b.ops, stepUp: b.step_up === true, client: { agent: "sync-dev-apply" } },
        );
        return json(200, r);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
        throw e;
      }
    }
    if (path === "/_dev/conflicts" && method === "POST") {
      const b = parsed();
      const okPath = (p) => p !== null && typeof p === "object" && !Array.isArray(p) && typeof p.path === "string";
      if (!b || !CLASSES.includes(b.class) || typeof b.handle !== "string" || !Array.isArray(b.paths) || !b.paths.length || !b.paths.every(okPath)) {
        return json(400, { error: "validation", message: "send {class, handle, paths: [{path, base?, cloud?, desktop?}], kind?, gramps_id?}" });
      }
      const id = uid().replace(/[^A-Za-z0-9]/g, "").slice(0, 26).padEnd(26, "0");
      const openedAt = new Date(now()).toISOString();
      const item = {
        ...conflictKey(id), GSI1PK: "SYNCCONFLICT#open", GSI1SK: `${openedAt}#${id}`, entity: "syncconflict", class: b.class, handle: b.handle,
        gramps_id: typeof b.gramps_id === "string" ? b.gramps_id : "", kind: typeof b.kind === "string" ? b.kind : "field",
        source: typeof b.source === "string" ? b.source : "desktop_parked", state: "open", opened_at: openedAt,
        paths: b.paths.map((p) => ({ path: p.path, base: p.base ?? null, cloud: p.cloud ?? null, desktop: p.desktop ?? null })),
      };
      await ddb.send(new cmds.PutCommand({ TableName: DEV_TABLE, Item: item }));
      return json(200, conflictView(item));
    }
    if (path === "/_dev/conflicts" && method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      if (!CONFLICT_STATES.includes(state)) return json(400, { error: "validation", message: "state must be open, resolved or dismissed" });
      const r = await ddb.send(new cmds.QueryCommand({ TableName: DEV_TABLE, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `SYNCCONFLICT#${state}` } }));
      return json(200, { state, conflicts: (r.Items ?? []).map(conflictView) });
    }
    if (path === "/_dev/auth" && method === "PATCH") {
      const b = parsed();
      if (!b) return json(400, { error: "validation", message: "send a JSON object" });
      if (b.access_ttl_seconds !== undefined) {
        if (!Number.isInteger(b.access_ttl_seconds) || b.access_ttl_seconds < 1 || b.access_ttl_seconds > 86_400) return json(400, { error: "validation", message: "access_ttl_seconds must be 1 to 86400" });
        auth.state.accessTtlSeconds = b.access_ttl_seconds;
      }
      if (b.revoke_all === true) auth.revokeAll();
      return json(200, { access_ttl_seconds: auth.state.accessTtlSeconds });
    }
    if (path === "/_dev/scrub" && method === "POST") {
      const b = parsed();
      const obj = b?.obj;
      if (!b || !CLASSES.includes(b.class) || typeof b.handle !== "string" || obj === null || typeof obj !== "object" || Array.isArray(obj) || obj.handle !== b.handle || obj._class !== b.class) {
        return json(400, { error: "validation", message: "send {class, handle, obj} with obj the scrubbed object of that class and handle" });
      }
      const item = (await ddb.send(new cmds.GetCommand({ TableName: DEV_TABLE, Key: recKey(b.class, b.handle), ConsistentRead: true }))).Item;
      if (!item || item.deleted === true) return json(404, { error: "not_found", message: "no live head with that class and handle" });
      const objJson = objectJson(obj);
      const hash = sha256(objJson);
      await ddb.send(new cmds.PutCommand({ TableName: DEV_TABLE, Item: { ...item, obj_json: objJson, hash } }));
      const entry = (await ddb.send(new cmds.GetCommand({ TableName: DEV_TABLE, Key: logKey(item.seq), ConsistentRead: true }))).Item;
      if (entry && entry.handle === b.handle && entry.class === b.class) await ddb.send(new cmds.PutCommand({ TableName: DEV_TABLE, Item: { ...entry, obj_json: objJson, hash } }));
      const head = (await getHead()) ?? { ...headKey() };
      const epoch = (Number.isInteger(head.expunge_epoch) ? head.expunge_epoch : 0) + 1;
      await ddb.send(new cmds.PutCommand({ TableName: DEV_TABLE, Item: { ...head, expunge_epoch: epoch, updated_at: new Date(now()).toISOString() } }));
      resetStoreView({ ddb, table: DEV_TABLE });
      return json(200, { class: b.class, handle: b.handle, version: item.version, seq: item.seq, hash, expunge_epoch: epoch });
    }
    return json(404, { error: "not_found", message: "no such dev route" });
  }

  server.on("request", async (req, res) => {
    const at = new Date(now()).toISOString();
    const entry = { seq: (n += 1), at, method: req.method, path: "", query: {}, status: 0 };
    let body = Buffer.alloc(0);
    let out;
    try {
      const url = new URL(req.url ?? "/", origin);
      entry.path = url.pathname;
      entry.query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "sig"));
      if (!hostHeader.has(String(req.headers.host ?? ""))) {
        out = json(421, { error: "misdirected_request", message: "this server answers only to its own loopback address" });
      } else {
        body = await readBody(req, url.pathname.startsWith("/_s3/") ? MAX_BLOB_BODY : MAX_API_BODY);
        out = await route(req, res, url, body);
      }
    } catch (e) {
      out = e.status === 413 ? { ...json(413, { error: "batch_too_large", message: "the request body is too large" }), close: true } : json(500, { error: "internal", message: "internal error" });
      if (e.status !== 413 && !req.destroyed) log.error("unhandled", { name: e?.name }); // a client that went away mid-body is not news
    }
    // The log line first, then the response: a client that has its answer can already grep the log.
    entry.status = out.status;
    entry.auth = req.headers.authorization ? "bearer" : "none";
    for (const k of ["content-type", "idempotency-key", "x-hfy-sync-client", "x-hfy-gramps-version", "x-hfy-gramps-schema", "x-hfy-redaction-version", "x-hfy-tree-id"]) {
      if (req.headers[k] !== undefined) (entry.headers ??= {})[k] = header(req, k);
    }
    entry.req_bytes = body.length;
    if (body.length) {
      entry.body_sha256 = sha256Hex(body);
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      if (entry.path === "/auth/token") entry.body_fields = [...new URLSearchParams(body.toString("utf8")).keys()]; // names only: the values are codes and tokens
      else if (ct.startsWith("application/json") && isUtf8(body)) {
        try {
          entry.body = JSON.parse(body.toString("utf8"));
        } catch {
          entry.body_text = body.toString("utf8");
        }
      } else if ((ct.startsWith("text/") || ct.startsWith("application/x-www-form-urlencoded")) && isUtf8(body)) entry.body_text = body.toString("utf8");
      else entry.body_binary = true;
    }
    try {
      const parsed = typeof out.body === "string" && String(out.headers["content-type"] ?? "").startsWith("application/json") && out.body ? JSON.parse(out.body) : undefined;
      if (parsed && typeof parsed.error === "string") entry.error = parsed.error;
    } catch {
      /* not JSON */
    }
    try {
      logRequest(entry);
    } catch (e) {
      log.error("request log write failed", { name: e?.name });
    }
    const payload = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body ?? "", "utf8");
    res.writeHead(out.status, { "content-length": String(payload.length), ...out.headers, ...(out.close ? { connection: "close" } : {}) });
    res.end(req.method === "HEAD" ? undefined : payload);
  });

  return {
    origin, port: boundPort, dataDir: dir, logFile: logPath, auth, ddb, s3, handler,
    async close() {
      await new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections?.();
      });
      releaseSyncFlag();
      if (ownsDir && !keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- command line -----------------------------------------------------------------------------------------------------------

export const HELP = `usage: node api/scripts/sync-dev-server.mjs [--port N] [--data-dir DIR] [--log-file FILE] [--owner-sub ID]
                                            [--access-ttl SECONDS] [--id-policy mint|assign] [--keep]
Serves /api/sync/*, the dev /auth endpoints and the presigned-URL store on 127.0.0.1. Prints one JSON line when it is listening. Stop it with SIGTERM.
--data-dir DIR keeps DIR and uses only DIR/${OWNED_DIR}/ in it (its s3/ store is emptied at start). --log-file FILE must not name a non-empty file.
/auth/authorize signs in the synthetic owner with no prompt: run this server only on a machine you trust, for synthetic data.`;

export function parseArgs(argv) {
  const o = {};
  const need = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--port") { o.port = Number(need(i, a)); i += 1; if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port must be 0 to 65535"); }
    else if (a === "--data-dir") { o.dataDir = need(i, a); i += 1; }
    else if (a === "--log-file") { o.logFile = need(i, a); i += 1; }
    else if (a === "--owner-sub") { o.ownerSub = need(i, a); i += 1; if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.ownerSub)) throw new Error("--owner-sub is not a usable subject"); }
    else if (a === "--access-ttl") { o.accessTtlSeconds = Number(need(i, a)); i += 1; if (!Number.isInteger(o.accessTtlSeconds) || o.accessTtlSeconds < 1 || o.accessTtlSeconds > 86_400) throw new Error("--access-ttl must be 1 to 86400 seconds"); }
    else if (a === "--id-policy") { o.idPolicy = need(i, a); i += 1; if (!["mint", "assign"].includes(o.idPolicy)) throw new Error("--id-policy must be mint or assign"); }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`sync-dev-server: ${e.message}\n${HELP}\n`);
    return 64;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const dev = await startDevServer(opts);
  const stop = async () => {
    await dev.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.write(`${JSON.stringify({ event: "ready", origin: dev.origin, port: dev.port, data_dir: dev.dataDir, log_file: dev.logFile, owner_sub: dev.auth.ownerSub })}\n`);
  return undefined; // keep running
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code); }, (e) => { process.stderr.write(`sync-dev-server: ${e.message}\n`); process.exit(70); });
}
