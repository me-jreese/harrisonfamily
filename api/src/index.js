// Lambda entry point: wires real AWS clients. Handler is `src/index.handler`.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createUlidFactory } from "@io-kit/feed";
import { createAdminList, createAuthenticator, createJwks } from "./auth.js";
import { createHandler } from "./handler.js";

const env = process.env;
const cmds = { GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, TransactWriteCommand };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const table = env.TABLE_NAME ?? "hfy-app";

const secretString = async (id) => (await secrets.send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? "";
const jwks = createJwks(env.SESSION_JWKS_URL ?? "https://harrisonfamily.us/auth/.well-known/jwks.json");
const getJwks = async () => jwks;

const getAdmins = createAdminList({
  load: async () => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.ADMIN_LIST_BUCKET ?? "harrisonfamily", Key: env.ADMIN_LIST_KEY ?? "config/admins.json" }));
    return JSON.parse(await o.Body.transformToString());
  },
});

// Optional push delivery: VAPID keys live in a secret {publicKey, privateKey, subject}. Absent => notifications are stored/configured but not sent.
let push;
async function loadPush() {
  if (push) return push;
  push = { vapid: undefined, webpush: undefined, vapidPublicKey: "" };
  if (!env.VAPID_SECRET) return push;
  try {
    const v = JSON.parse(await secretString(env.VAPID_SECRET));
    const mod = await import("web-push");
    push = { vapid: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, webpush: mod.default ?? mod, vapidPublicKey: v.publicKey };
  } catch (e) {
    console.error("push disabled", e instanceof Error ? e.message : String(e));
  }
  return push;
}

const authenticate = createAuthenticator({
  issuer: env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth",
  audience: env.SESSION_AUDIENCE ?? "harrisonfamily-web",
  cookieName: env.SESSION_COOKIE ?? "io_id",
  getJwks,
  getAdmins,
});

let inner;
export const handler = async (event) => {
  if (!inner) {
    const p = await loadPush();
    inner = createHandler({
      ddb, cmds, table, authenticate, ulid: createUlidFactory(),
      subscriptions: new DynamoSubscriptionStore(ddb, cmds, table),
      preferences: new DynamoPreferencesStore(ddb, cmds, table),
      ...p,
    });
  }
  return inner(event);
};
