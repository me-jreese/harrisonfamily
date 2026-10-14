// Lambda entry point: wires real AWS clients. Handler is `src/index.handler`.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoNotificationStore, DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createUlidFactory } from "@io-kit/feed";
import { createMemberSet } from "./notify.js";
import { createAdminList, createAuthenticator, createJwks } from "./auth.js";
import { createHandler } from "./handler.js";
import { forbidden, originVerified } from "./origin.js";
import { createPresignPut } from "./presign.js";
import { createGroupResolver, UAT_GROUP } from "./policy.js";
import { configureFeatures, createFeatureGate, createFlagSource, DEFAULT_FLAGS_URL } from "./features.js";
import { createLabelResolver, PERSON_KEY } from "./labels.js";
import { createMcpMount, isMcpPath } from "./mcp.js";
import { guardDobFromEnv } from "./guard.js";
import { createSyncAuthenticator } from "./sync/auth.js";
import { logSafeError } from "./http.js";

const env = process.env;
const cmds = { GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand };
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

// Member principals for record_updated_mine: the VALUES of the allowlist's config/userGrampsID.json (read through the role's config/* grant). Never logged.
const listMembers = createMemberSet({
  load: async () => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.ADMIN_LIST_BUCKET ?? "harrisonfamily", Key: env.USER_GRAMPS_KEY ?? "config/userGrampsID.json" }));
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
    console.error("push disabled", logSafeError(e));
  }
  return push;
}

// HFY-R68: author labels come from the site's own person records (s3://$MEDIA_BUCKET/person/<gramps_id>.json, field displayName), never from the
// allowlist (whose label is the member's email). Read-only on person/* (the Role's PersonRecords statement); cached per container; falls back to the gramps_id.
const resolveLabel = createLabelResolver({
  load: async (grampsId) => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.MEDIA_BUCKET ?? "harrisonfamily-frontend", Key: PERSON_KEY(grampsId) }));
    return JSON.parse(await o.Body.transformToString());
  },
});

const authenticate = createAuthenticator({
  issuer: env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth",
  audience: env.SESSION_AUDIENCE ?? "harrisonfamily-web",
  cookieName: env.SESSION_COOKIE ?? "io_id",
  getJwks,
  getAdmins,
  resolveLabel,
});

// HFY-TSK-073: MCP groups (mcp-authors, hfy-admin) from s3://$GROUPS_BUCKET/$GROUPS_KEY; read-only, fail closed. Shape documented in src/policy.js.
const getGroups = createGroupResolver({
  load: async () => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.GROUPS_BUCKET ?? "harrisonfamily", Key: env.GROUPS_KEY ?? "config/groups.json" }));
    return JSON.parse(await o.Body.transformToString());
  },
});

// HFY-TSK-238: the feature gate reads the flags file the site itself serves, over HTTPS through CloudFront (no S3 grant), cached 60 s,
// last good kept 10 minutes, then fail closed. The uat group comes from the same cached, fail-closed groups.json read as the MCP groups.
const features = configureFeatures(createFeatureGate({
  flags: createFlagSource({ url: env.FLAGS_URL ?? DEFAULT_FLAGS_URL }),
  isUat: async (sub) => (await getGroups({ sub })).includes(UAT_GROUP),
}));

// HFY-TSK-172: /api/sync/* takes the desktop client's bearer token (aud https://harrisonfamily.us/api/sync, client_id hfy-sync-desktop), authorized by the
// gramps-owner group of the same cached, fail-closed groups.json read. The routes answer 404 not_enabled unless SYNC_API_ENABLED=1 (stack parameter SyncApiEnabled).
const authenticateSync = createSyncAuthenticator({ issuer: env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth", getJwks, getGroups });

/** The inbox store (BRD2 D2-15): INBOX#<principal> rows on the app table. Unread items carry no TTL; the 90-day TTL starts when an item is read. */
export const INBOX_TTL = Object.freeze({ unreadTtlDays: null, readTtlDays: 90 });
export const createInboxStore = (client = ddb, commands = cmds, tableName = table) => new DynamoNotificationStore(client, commands, tableName, { ...INBOX_TTL });

let inner;
let mcp;
export const handler = async (event) => {
  if (!originVerified(event, env.ORIGIN_VERIFY)) return forbidden(); // HFY-R43, before any routing
  if (!inner) {
    const p = await loadPush();
    inner = createHandler({
      ddb, cmds, table, authenticate, authenticateSync, ulid: createUlidFactory(),
      subscriptions: new DynamoSubscriptionStore(ddb, cmds, table),
      preferences: new DynamoPreferencesStore(ddb, cmds, table),
      inbox: createInboxStore(),
      getAdmins, listMembers,
      presignPut: createPresignPut(), // signs content-type, no empty-body checksum (HFY-R58)
      s3, // checkLocation reads the first 256 KiB of a new post attachment (upload-guard.js; UploadReads in app-stack.yaml)
      guardDob: guardDobFromEnv(env), // HFY_GUARD_DOB=on (stack parameter GuardDob): the dob_not_allowed refusal; default off
      mediaBucket: env.MEDIA_BUCKET ?? "harrisonfamily-frontend",
      mediaPublicBase: env.MEDIA_PUBLIC_BASE ?? "https://harrisonfamily.us",
      features,
      ...p,
    });
  }
  const path = event.rawPath ?? event.path ?? "/";
  if (isMcpPath(path)) {
    mcp ??= createMcpMount({ invoke: inner.invoke, resolveGroups: getGroups, resolveLabel });
    return mcp.handle(event); // bearer-gated by @io-kit/mcp/edge; the API's cookie auth is never consulted here
  }
  return inner(event);
};
