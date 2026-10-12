import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { SignJWT, createLocalJWKSet } from "jose";
import { createUlidFactory, ulidTime } from "@io-kit/feed";
import { DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { createAdminList, createAuthenticator } from "../src/auth.js";
import { createHandler } from "../src/handler.js";

export const TABLE = "hfy-app";
export const ISSUER = "https://harrisonfamily.us/auth";
export const AUDIENCE = "harrisonfamily-web";

/** Strictly increasing fake clock (like the kit memory stores) starting an hour after `after`. */
export function ticker(after = Date.now()) {
  let t = after + 3_600_000;
  return () => (t += 60_000);
}
export { createFakeDdb, cmds, createUlidFactory, ulidTime };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const pem = privateKey.export({ type: "pkcs8", format: "pem" });
export const signToken = (sub, { name = sub, exp = "1h", iss = ISSUER, aud = AUDIENCE } = {}) =>
  new SignJWT({ client_id: aud, token_use: "access", name })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" })
    .setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(privateKey);

/**
 * `intercept(cmd)` runs before every DynamoDB command reaches the fake (throw to simulate a store failure, or await another
 * request to simulate a race). The returned `ddb` is the raw fake, for assertions.
 */
export function makeApi({ admins = ["I0099"], withPush = true, audit, intercept } = {}) {
  const raw = createFakeDdb();
  const ddb = intercept ? { send: async (cmd) => { await intercept(cmd); return raw.send(cmd); } } : raw;
  const now = ticker();
  const sent = [];
  const presigned = [];
  const jwks = createLocalJWKSet({ keys: [{ ...createPublicKey(pem).export({ format: "jwk" }), kid: "hfy-session-1", alg: "RS256", use: "sig" }] });
  const authenticate = createAuthenticator({
    issuer: ISSUER, audience: AUDIENCE, getJwks: async () => jwks,
    getAdmins: createAdminList({ load: async () => ({ admins }) }), log: { warn() {}, error() {} },
  });
  const subscriptions = new DynamoSubscriptionStore(ddb, cmds, TABLE);
  const preferences = new DynamoPreferencesStore(ddb, cmds, TABLE);
  const handler = createHandler({
    ddb, cmds, table: TABLE, authenticate, ulid: createUlidFactory(), now, subscriptions, preferences,
    ...(audit ? { audit } : {}),
    presignPut: async (a) => { presigned.push(a); return `https://presign.test/${a.bucket}/${a.key}?sig=x`; },
    vapidPublicKey: "vapid-public", log: { warn() {}, error() {} },
    ...(withPush ? { vapid: { subject: "mailto:test@example.test", publicKey: "vapid-public", privateKey: "x" }, webpush: { async sendNotification(sub, payload) { sent.push({ sub, payload: JSON.parse(payload) }); } } } : {}),
  });
  const ev = (method, path, { token, body, query, ct = "application/json" } = {}) => ({
    requestContext: { http: { method } }, rawPath: path, queryStringParameters: query,
    headers: ct ? { "content-type": ct } : {}, cookies: token ? [`io_id=${token}`] : [],
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (method, path, opts) => {
    const r = await handler(ev(method, path, opts));
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
  };
  return { ddb: raw, call, sent, presigned, subscriptions, preferences, now };
}
