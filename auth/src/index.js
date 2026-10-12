// Lambda entry (nodejs22.x, ESM): wires AWS clients (runtime SDK v3) and serves createAuthEdge. Handler: src/index.handler.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, importPKCS8 } from "jose";
import { createIdentityService, ddbFromDocumentClient, ddbLinkStore, ddbRefreshStore } from "@io-kit/auth/server";
import { buildResolver, cognitoLifecycle, cognitoPasswordAuthenticator } from "@io-kit/auth/edge/deploy";
import { createAuthEdge, loadManifest } from "./edge.js";
import { createOAuthServer, ddbOAuthStore } from "./oauth.js";
import { createMembership } from "./membership.js";
import { forbidden, originVerified } from "./origin.js";

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
  const resolver = buildResolver(m.resolver, { readObject });
  const privateKey = await importPKCS8(pem, "RS256");
  const cog = { region: m.idp.userPoolId.split("_")[0], clientId: m.idp.clientId };
  const gis = m.providers.find((p) => p.kind === "google" && p.mode === "gis_id_token");
  const identity = createIdentityService({
    resolver,
    links: ddbLinkStore({ client: ddb, tableName }),
    ...(gis ? { google: { clientId: gis.clientId } } : {}),
    sessions: {
      issuer: m.session.issuer, audience: m.session.audience, kid,
      privateKey,
      store: ddbRefreshStore({ client: ddb, tableName }),
      accessTtlSeconds: m.session.accessTtlSeconds, defaultProfile: m.session.profile,
    },
    passwordAuth: cognitoPasswordAuthenticator(cog),
    passwords: await cognitoProvisioner(m.idp.userPoolId),
  });
  // MCP authorization server (HFY-TSK-076). Redirect URIs and resources come from stack parameters; unset => OAuth routes are off.
  const csv = (v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const redirectUris = csv(process.env.MCP_REDIRECT_URIS);
  const resources = csv(process.env.MCP_RESOURCES);
  const oauth = redirectUris.length
    ? createOAuthServer({
        issuer: m.session.issuer, redirectUris, resources: resources.length ? resources : ["https://mcp.harrisonfamily.us"],
        corsOrigins: csv(process.env.MCP_CORS_ORIGINS),
        ...(process.env.MCP_CLIENT_ID ? { clientId: process.env.MCP_CLIENT_ID } : {}),
        store: ddbOAuthStore({ doc, cmds: lib, table: tableName }), signer: { privateKey, kid },
        groupsFor: createMembership({
          readAllowlist: () => readObject(m.resolver.bucket, m.resolver.key),
          readAdmins: () => readObject(m.resolver.bucket, process.env.ADMIN_LIST_KEY ?? "config/admins.json"),
        }),
      })
    : undefined;
  return createAuthEdge({
    manifest: m, identity, publicJwk, ...(oauth ? { oauth } : {}), lifecycle: cognitoLifecycle(cog),
    verify: { issuers: [m.session.issuer], audiences: [m.session.audience], jwks: createLocalJWKSet({ keys: [publicJwk] }) },
  });
}

async function cognitoProvisioner(userPoolId) {
  const cip = await sdk("@aws-sdk/client-cognito-identity-provider");
  const client = new cip.CognitoIdentityProviderClient({});
  const call = (C, input) => client.send(new cip[C](input));
  return {
    async setPassword({ email, password }) {
      let user;
      try { user = await call("AdminGetUserCommand", { UserPoolId: userPoolId, Username: email }); }
      catch {
        user = await call("AdminCreateUserCommand", { UserPoolId: userPoolId, Username: email, MessageAction: "SUPPRESS", UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }] });
      }
      await call("AdminSetUserPasswordCommand", { UserPoolId: userPoolId, Username: email, Password: password, Permanent: true });
      const attrs = user.UserAttributes ?? user.User?.Attributes ?? [];
      return { idpIssuer: `https://cognito-idp.${userPoolId.split("_")[0]}.amazonaws.com/${userPoolId}`, idpSub: String(attrs.find((a) => a.Name === "sub")?.Value ?? "") };
    },
  };
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
