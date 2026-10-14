import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { SignJWT, createLocalJWKSet } from "jose";
import { createUlidFactory, ulidTime } from "@io-kit/feed";
import { DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createFakeDdb, cmds } from "./fake-ddb.js";
import { createAdminList, createAuthenticator } from "../src/auth.js";
import { createHandler } from "../src/handler.js";
import { createFeatureGate } from "../src/features.js";

export const TABLE = "hfy-app";
export const ISSUER = "https://harrisonfamily.us/auth";
export const AUDIENCE = "harrisonfamily-web";

/** Strictly increasing fake clock (like the kit memory stores) starting an hour after `after`. */
export function ticker(after = Date.now()) {
  let t = after + 3_600_000;
  return () => (t += 60_000);
}
export { createFakeDdb, cmds, createUlidFactory, ulidTime };

/**
 * A member-upload image the posts store accepts (normalizeAttachments only takes `/uploads/posts/<ulid>/<name>`), for the kit
 * contract's photo-only case (@io-kit/content 0.3.1 CS-19, `ContentContractHarness.photo`) and the photo-only post tests.
 */
export const UPLOAD_PHOTO = Object.freeze({ kind: "image", url: "/uploads/posts/01J00000000000000000000000/photo-only.png", mime: "image/png", alt: "a photo" });

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const pem = privateKey.export({ type: "pkcs8", format: "pem" });
export const signToken = (sub, { name = sub, exp = "1h", iss = ISSUER, aud = AUDIENCE } = {}) =>
  new SignJWT({ client_id: aud, token_use: "access", name })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" })
    .setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(privateKey);

/** A synthetic JPEG with no metadata at all (SOI, EOI): what a clean browser upload looks like to checkLocation. */
export const CLEAN_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * A fake S3 for checkLocation: GetObject over `objects` (key -> {bytes, contentType}). A Range (bytes=a-b, or the suffix form
 * bytes=-n) is honoured and answered with Content-Range "bytes a-b/<size>", as S3 does; a missing key answers like S3 without
 * s3:ListBucket (403 AccessDenied). `gets` records each GetObject input.
 */
export function createFakeS3(objects = new Map()) {
  const gets = [];
  return {
    objects,
    gets,
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") throw new Error(`fake s3: unsupported ${cmd.constructor.name}`);
      const i = cmd.input;
      gets.push(i);
      const o = objects.get(i.Key);
      if (!o) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      const size = o.bytes.length;
      const m = /^bytes=(\d*)-(\d*)$/.exec(i.Range ?? "");
      const [from, to] = !m ? [0, size - 1] : m[1] === "" ? [Math.max(0, size - Number(m[2])), size - 1] : [Number(m[1]), Math.min(size - 1, m[2] === "" ? size - 1 : Number(m[2]))];
      const bytes = o.bytes.subarray(from, to + 1);
      return {
        ContentType: o.contentType, ...(m && size > 0 ? { ContentRange: `bytes ${from}-${to}/${size}` } : {}),
        Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
      };
    },
  };
}

/**
 * `intercept(cmd)` runs before every DynamoDB command reaches the fake (throw to simulate a store failure, or await another
 * request to simulate a race). The returned `ddb` is the raw fake, for assertions. Every presign also "uploads" CLEAN_JPEG under
 * its key with its content type (set `autoPut: false` to leave the bucket empty); tests swap `s3.objects` entries for fixtures.
 * `guardDob` is the HFY_GUARD_DOB switch.
 * Feature gate (HFY-TSK-238): `flags` is the deployed flags map (an object read on every call, so a test can flip it, or an async
 * function such as a createFlagSource), `uat` the uat subjects, or `features` a whole gate. With none of them the handler uses the
 * closed default (everything off, nobody uat). `routes` replaces the registry (tests mount gated routes with defineRoutes); `inbox`
 * is a persist-first inbox store.
 */
export function makeApi({ admins = ["I0099"], withPush = true, audit, intercept, resolveLabel, log = { warn() {}, error() {} }, guardDob, autoPut = true, flags, uat, features, routes, inbox } = {}) {
  const raw = createFakeDdb();
  const s3 = createFakeS3();
  const ddb = intercept ? { send: async (cmd) => { await intercept(cmd); return raw.send(cmd); } } : raw;
  const now = ticker();
  const sent = [];
  const presigned = [];
  const jwks = createLocalJWKSet({ keys: [{ ...createPublicKey(pem).export({ format: "jwk" }), kid: "hfy-session-1", alg: "RS256", use: "sig" }] });
  const authenticate = createAuthenticator({
    issuer: ISSUER, audience: AUDIENCE, getJwks: async () => jwks,
    getAdmins: createAdminList({ load: async () => ({ admins }) }), log: { warn() {}, error() {} },
    ...(resolveLabel ? { resolveLabel } : {}),
  });
  const gate = features ?? (flags !== undefined || uat !== undefined
    ? createFeatureGate({ flags: typeof flags === "function" ? flags : async () => ({ ...(flags ?? {}) }), isUat: async (sub) => (uat ?? []).includes(sub) })
    : undefined);
  const subscriptions = new DynamoSubscriptionStore(ddb, cmds, TABLE);
  const preferences = new DynamoPreferencesStore(ddb, cmds, TABLE);
  const handler = createHandler({
    ddb, cmds, table: TABLE, authenticate, ulid: createUlidFactory(), now, subscriptions, preferences,
    ...(audit ? { audit } : {}),
    ...(gate ? { features: gate } : {}), ...(routes ? { routes } : {}), ...(inbox ? { inbox } : {}),
    presignPut: async (a) => {
      presigned.push(a);
      if (autoPut) s3.objects.set(a.key, { bytes: CLEAN_JPEG, contentType: a.contentType });
      return `https://presign.test/${a.bucket}/${a.key}?sig=x`;
    },
    s3, ...(guardDob !== undefined ? { guardDob } : {}),
    vapidPublicKey: "vapid-public", log,
    ...(withPush ? { vapid: { subject: "mailto:test@example.test", publicKey: "vapid-public", privateKey: "x" }, webpush: { async sendNotification(sub, payload) { sent.push({ sub, payload: JSON.parse(payload) }); } } } : {}),
  });
  const ev = (method, path, { token, body, query, ct = "application/json", headers = {} } = {}) => ({
    requestContext: { http: { method } }, rawPath: path, queryStringParameters: query,
    headers: { ...(ct ? { "content-type": ct } : {}), ...headers }, cookies: token ? [`io_id=${token}`] : [],
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (method, path, opts) => {
    const r = await handler(ev(method, path, opts));
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
  };
  return { ddb: raw, handler, call, sent, presigned, subscriptions, preferences, now, s3 };
}
