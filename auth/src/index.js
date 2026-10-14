// Lambda entry (nodejs22.x, ESM): wires AWS clients (runtime SDK v3) and serves createAuthEdge. Handler: src/index.handler.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, importPKCS8 } from "jose";
import { createIdentityService, createPasskeyService, ddbChallengeStore, ddbFromDocumentClient, ddbRefreshStore } from "@io-kit/auth/server";
import { buildResolver, cognitoLifecycle, cognitoPasswordAuthenticator, loadPasskeyBrowserBundle } from "@io-kit/auth/edge/deploy";
import { createAuthEdge, loadManifest } from "./edge.js";
import { DEFAULT_CLIENT_ID, DEFAULT_MCP_RESOURCE, createOAuthServer, ddbOAuthStore, desktopClient } from "./oauth.js";
import { createMembership } from "./membership.js";
import { createCompositeResolver } from "./allowlist.js";
import { forbidden, originVerified } from "./origin.js";
import { cognitoProvisioner } from "./cognito.js";
import { hfyLinkStore } from "./linkstore.js";
import { hfyPasskeyStore } from "./passkeystore.js";
import { ddbRateLimiter } from "./ratelimit.js";
import { createAccessRequest, createMailAlarmGate } from "./access-request.js";
import { createSesMailer } from "./mailer.js";

const sdk = (name) => import(name);

/** Secret is JSON {privateKeyPem, kid} (scripts/infra/create-session-key.sh) or a bare PKCS8 PEM. */
export function parseSigningSecret(s, defaultKid) {
  if (s.trim().startsWith("{")) {
    const o = JSON.parse(s);
    return { pem: o.privateKeyPem ?? o.privateKey ?? o.pem, kid: o.kid ?? defaultKid };
  }
  return { pem: s, kid: defaultKid };
}

async function init() {
  const path = process.env.EDGE_MANIFEST_PATH ?? new URL("../edge.manifest.json", import.meta.url).pathname;
  const m = loadManifest(JSON.parse(readFileSync(path, "utf8")), process.env);
  const [{ DynamoDBClient }, lib, { S3Client, GetObjectCommand }, sm] = await Promise.all([
    sdk("@aws-sdk/client-dynamodb"), sdk("@aws-sdk/lib-dynamodb"), sdk("@aws-sdk/client-s3"), sdk("@aws-sdk/client-secrets-manager"),
  ]);
  const secret = (await new sm.SecretsManagerClient({}).send(new sm.GetSecretValueCommand({ SecretId: m.session.signingKeySecretName }))).SecretString;
  if (typeof secret !== "string") throw new Error("signing key secret has no string value");
  const { pem, kid } = parseSigningSecret(secret, m.session.kid);
  m.session.kid = kid;
  const publicJwk = { ...(await exportJWK(createPublicKey(createPrivateKey(pem)))), kid, alg: "RS256", use: "sig" };

  const tableName = process.env[m.store.tableEnv ?? "AUTH_TABLE"];
  if (!tableName) throw new Error(`environment variable ${m.store.tableEnv ?? "AUTH_TABLE"} is not set`);
  const doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ddb = ddbFromDocumentClient(doc, lib);
  const s3 = new S3Client({});
  const readObject = async (bucket, key) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToString();
  // The composite resolver (HFY-TSK-134): a DynamoDB ALLOW# item wins over io's S3 file, active or revoked; no item means the file decides,
  // exactly as before, and a DynamoDB error falls back to the file. The manifest's resolver stays s3_allowlist.
  const resolver = createCompositeResolver({ s3: buildResolver(m.resolver, { readObject }), ddb: doc, cmds: lib, table: tableName });
  const privateKey = await importPKCS8(pem, "RS256");
  const cog = { region: m.idp.userPoolId.split("_")[0], clientId: m.idp.clientId };
  const gis = m.providers.find((p) => p.kind === "google" && p.mode === "gis_id_token");
  const identity = createIdentityService({
    resolver,
    links: hfyLinkStore({ client: ddb, tableName }), // writes GSI1SK so GSI1 indexes LINK# items (HFY-R58 ruling 6)
    ...(gis ? { google: { clientId: gis.clientId } } : {}),
    sessions: {
      issuer: m.session.issuer, audience: m.session.audience, kid,
      privateKey,
      store: ddbRefreshStore({ client: ddb, tableName }),
      accessTtlSeconds: m.session.accessTtlSeconds, defaultProfile: m.session.profile,
    },
    passwordAuth: cognitoPasswordAuthenticator(cog),
    passwords: await cognitoAdmin(m.idp.userPoolId, resolver),
  });
  // MCP authorization server (HFY-TSK-076). Redirect URIs and resources come from stack parameters; unset => OAuth routes are off.
  const csv = (v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const redirectUris = csv(process.env.MCP_REDIRECT_URIS);
  const resources = csv(process.env.MCP_RESOURCES);
  const oauth = redirectUris.length
    ? createOAuthServer({
        issuer: m.session.issuer,
        // HFY-TSK-120: the MCP client keeps its exact-match redirect URIs; the Gramps desktop client (loopback, any port) is registered
        // only when HFY_SYNC_DESKTOP_CLIENT=1 (default off until the sync routes ship).
        clients: [
          { id: process.env.MCP_CLIENT_ID || DEFAULT_CLIENT_ID, redirectUris, resources: resources.length ? resources : [DEFAULT_MCP_RESOURCE] },
          ...(process.env.HFY_SYNC_DESKTOP_CLIENT === "1" ? [desktopClient()] : []),
        ],
        corsOrigins: csv(process.env.MCP_CORS_ORIGINS),
        jwks: createLocalJWKSet({ keys: [publicJwk] }),
        store: ddbOAuthStore({ doc, cmds: lib, table: tableName }), signer: { privateKey, kid },
        groupsFor: createMembership({
          readAllowlist: () => readObject(m.resolver.bucket, m.resolver.key),
          readAdmins: () => readObject(m.resolver.bucket, process.env.ADMIN_LIST_KEY ?? "config/admins.json"),
          ddb: doc, cmds: lib, table: tableName,
        }),
      })
    : undefined;
  // Passkeys (HFY-TSK-078, HFY-R52/R53/R57): same table; credentials PASSKEY#<id> + GSI1PK/GSI1SK, challenges PASSKEYCHAL#<challenge> (DynamoDB TTL).
  // userVerification stays "preferred" for sign-in (HFY-R67). The kit's amr is ["passkey", "hwk"|"swk"] plus "mfa" only when the
  // authenticator performed user verification, and the MCP step-up delete accepts only "mfa" (api/src/policy.js STRONG_AMR).
  const pk = m.providers.find((p) => p.kind === "passkey");
  const authOrigin = String(m.authOrigin ?? `https://${m.site}`).replace(/\/+$/, "");
  const passkeys = pk
    ? createPasskeyService({
        rpID: pk.rpId ?? m.site, rpName: pk.rpName ?? m.site, origin: pk.origins ?? [authOrigin], userVerification: "preferred",
        store: hfyPasskeyStore({ client: ddb, tableName }), // writes GSI1SK so GSI1 indexes PASSKEY# items (HFY-R67)
        challenges: ddbChallengeStore({ client: ddb, tableName }),
      })
    : undefined;
  const limiter = ddbRateLimiter({ doc, cmds: lib, table: tableName });
  const accessRequests = createAccessRequestRoutes({ m, doc, cmds: lib, tableName, limiter, sm, resolver });
  return createAuthEdge({
    manifest: m, identity, accessRequests, publicJwk, ...(passkeys ? { passkeys, passkeyClientScript: loadPasskeyBrowserBundle() } : {}), ...(oauth ? { oauth } : {}), lifecycle: cognitoLifecycle(cog),
    limiter, // POST /auth/password/forgot (HFY-R58 ruling 5) and the access-request routes (surfaces.md 7.5)
    verify: { issuers: [m.session.issuer], audiences: [m.session.audience], jwks: createLocalJWKSet({ keys: [publicJwk] }) },
  });
}

/**
 * The anonymous access-request routes (HFY-TSK-195). ACCESS_REQUESTS is read per request, so the routes answer 503 "closed" until the
 * stack parameter is on. The two secrets (Turnstile, pepper) and the SES and CloudWatch clients load on first use and are never logged.
 * Mail goes out from the JOIN identity (JOIN_FROM_ADDRESS, JOIN_SES_CONFIGURATION_SET), not the Cognito and API one; the code route
 * stops while one of the JOIN_MAIL_ALARMS bounce or complaint alarms is in ALARM.
 */
export function createAccessRequestRoutes({ m, doc, cmds, tableName, limiter, sm, resolver, env = process.env, sdkImport = sdk }) {
  const once = (fn) => { let v; return async () => (v ??= await fn()); }; // a rejection is not cached
  const secretString = async (name) => {
    if (!name) throw new Error("secret name not set");
    const out = (await new sm.SecretsManagerClient({}).send(new sm.GetSecretValueCommand({ SecretId: name }))).SecretString;
    if (typeof out !== "string" || !out) throw new Error("secret has no string value");
    return out;
  };
  const turnstile = once(async () => {
    const raw = (await secretString(env.TURNSTILE_SECRET_NAME)).trim();
    if (!raw.startsWith("{")) return raw;
    const o = JSON.parse(raw); // a JSON secret is also accepted: {"secret": "..."}
    const v = o.secret ?? o.secretKey ?? o.TURNSTILE_SECRET;
    if (typeof v !== "string" || !v) throw new Error("turnstile secret has no key");
    return v;
  });
  const pepper = once(async () => (await secretString(env.ACCESS_REQUEST_PEPPER_SECRET)).trim());
  const ses = once(async () => {
    const mod = await sdkImport("@aws-sdk/client-sesv2");
    return { client: new mod.SESv2Client({}), SendEmailCommand: mod.SendEmailCommand };
  });
  const cw = once(async () => {
    const mod = await sdkImport("@aws-sdk/client-cloudwatch");
    return { client: new mod.CloudWatchClient({}), DescribeAlarmsCommand: mod.DescribeAlarmsCommand };
  });
  const site = new URL(String(m.authOrigin ?? `https://${m.site}`));
  return createAccessRequest({
    flag: () => env.ACCESS_REQUESTS === "on",
    siteOrigin: site.origin, siteHost: site.hostname, turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
    ddb: doc, cmds, table: tableName, limiter,
    secrets: { turnstile, pepper },
    mailer: {
      send: async (msg) => {
        const { client, SendEmailCommand } = await ses();
        return createSesMailer({
          from: env.JOIN_FROM_ADDRESS, configurationSet: env.JOIN_SES_CONFIGURATION_SET || undefined,
          send: (input) => client.send(new SendEmailCommand(input)),
        }).send(msg);
      },
    },
    isMember: async (email) => (await resolver(email, { kind: "password" })) != null,
    mailAlarm: createMailAlarmGate({
      names: (env.JOIN_MAIL_ALARMS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      describeAlarms: async (names) => {
        const { client, DescribeAlarmsCommand } = await cw();
        return (await client.send(new DescribeAlarmsCommand({ AlarmNames: names, AlarmTypes: ["MetricAlarm"] }))).MetricAlarms ?? [];
      },
    }),
  });
}

/** AdminCreateUser happens only after the allowlist check, inside cognitoProvisioner (HFY-R58 ruling 5). */
async function cognitoAdmin(userPoolId, resolver) {
  const cip = await sdk("@aws-sdk/client-cognito-identity-provider");
  const client = new cip.CognitoIdentityProviderClient({});
  return cognitoProvisioner({ userPoolId, resolver, send: (name, input) => client.send(new cip[`${name}Command`](input)) });
}

let app;
export const handler = async (event) => {
  if (!originVerified(event, process.env.ORIGIN_VERIFY)) return forbidden(); // HFY-R43, before any routing
  app ??= init();
  try {
    return await (await app)(event);
  } catch (e) {
    app = undefined; // retry init next invocation
    console.error(JSON.stringify({ msg: "hfy-auth-edge failed", error: e instanceof Error ? e.message : String(e) }));
    return { statusCode: 500, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: '{"code":"AUTH_CONFIG"}' };
  }
};
