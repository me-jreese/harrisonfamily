import { generateKeyPairSync } from "node:crypto";
import { SignJWT, exportPKCS8 } from "jose";
import { createUlidFactory, ulidTime } from "@io-kit/feed";
import { DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { createAdminList, createAuthenticator, jwksFromSecret } from "../src/auth.js";
import { createHandler } from "../src/handler.js";

export const TABLE = "hfy-app";
export const ISSUER = "https://harrisonfamily.us/auth";
export const AUDIENCE = "harrisonfamily";

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

export function makeApi({ admins = ["I0099"], withPush = true } = {}) {
  const ddb = createFakeDdb();
  const now = ticker();
  const sent = [];
  const jwks = jwksFromSecret(pem);
  const authenticate = createAuthenticator({
    issuer: ISSUER, audience: AUDIENCE, getJwks: async () => jwks,
    getAdmins: createAdminList({ load: async () => ({ admins }) }), log: { warn() {}, error() {} },
  });
  const subscriptions = new DynamoSubscriptionStore(ddb, cmds, TABLE);
  const preferences = new DynamoPreferencesStore(ddb, cmds, TABLE);
  const handler = createHandler({
    ddb, cmds, table: TABLE, authenticate, ulid: createUlidFactory(), now, subscriptions, preferences,
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
  return { ddb, call, sent, subscriptions, preferences, now };
}
