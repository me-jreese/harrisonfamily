// Lambda entry point: wires real AWS clients. Handler is `src/index.handler`.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoNotificationStore, DynamoSubscriptionStore, DynamoPreferencesStore } from "@io-kit/notify/server";
import { createUlidFactory } from "@io-kit/feed";
import { createMemberSet, queryFollowers } from "./notify.js";
import { createAdminList, createAuthenticator, createJwks } from "./auth.js";
import { createHandler } from "./handler.js";
import { forbidden, originVerified } from "./origin.js";
import { createPresignGet, createPresignPut } from "./presign.js";
import { createGroupResolver, OWNER_GROUP, UAT_GROUP } from "./policy.js";
import { configureFeatures, createFeatureGate, createFlagSource, DEFAULT_FLAGS_URL } from "./features.js";
import { createLabelResolver, createPersonExists, createPersonFacts, PERSON_KEY } from "./labels.js";
import { createMcpMount, isMcpPath } from "./mcp.js";
import { guardDobFromEnv } from "./guard.js";
import { createSyncAuthenticator } from "./sync/auth.js";
import { createIdPolicy, idPolicyFromEnv } from "./sync/id-policy.js";
import { createAccessRequests } from "./access-requests.js";
import { createSesMailer } from "./mailer.js";
import { logSafeError } from "./http.js";
import { registerRecordContributor } from "./record-contributor.js";
import { createFanoutNotifier, createRecordFanout, isReplayEvent, isStreamEvent } from "./record-change-fanout.js";

const env = process.env;
const cmds = { GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const table = env.TABLE_NAME ?? "hfy-app";

const ulid = createUlidFactory(); // one monotonic factory: the handler's ids and the id-policy hooks' audit ids

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

// HFY-TSK-254: subscriptions.put checks that the person exists with the same read (person/<id>.json); a read failure is a 503, not a 404.
const personExists = createPersonExists({
  load: async (grampsId) => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.MEDIA_BUCKET ?? "harrisonfamily-frontend", Key: PERSON_KEY(grampsId) }));
    return o.Body ? true : null;
  },
});

// HFY-TSK-141 (surf-access-admin-api): the `link` decision reads the person's own record for the living check (person/<id>.json, the PersonRecords grant).
const personFacts = createPersonFacts({
  load: async (grampsId) => {
    const o = await s3.send(new GetObjectCommand({ Bucket: env.MEDIA_BUCKET ?? "harrisonfamily-frontend", Key: PERSON_KEY(grampsId) }));
    return JSON.parse(await o.Body.transformToString());
  },
});

// io's S3 allowlist as a Map email -> { sub } (read-only, the AdminList grant): which addresses a member already signs in with. Cached 60 s; a failure is not cached.
let entriesCache = { at: -Infinity, map: new Map() };
const readEntries = async () => {
  if (Date.now() - entriesCache.at < 60_000) return entriesCache.map;
  const o = await s3.send(new GetObjectCommand({ Bucket: env.ADMIN_LIST_BUCKET ?? "harrisonfamily", Key: env.USER_GRAMPS_KEY ?? "config/userGrampsID.json" }));
  const raw = JSON.parse(await o.Body.transformToString());
  const map = new Map();
  for (const [email, v] of Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})) {
    const sub = typeof v === "string" ? v : v?.gramps_id ?? v?.sub;
    if (typeof sub === "string" && sub) map.set(String(email).trim().toLowerCase(), { sub });
  }
  entriesCache = { at: Date.now(), map };
  return map;
};

// The mailer: SES from the api role's own grant (app-stack-sync-infra: SesIdentityArn, SesFromAddress, SesConfigurationSet). Without them the admin routes
// still decide, and answer emailSent:false. The SDK client loads on first use and is never logged.
let sesClient;
const mailer = env.SES_FROM_ADDRESS && env.SES_CONFIGURATION_SET
  ? createSesMailer({
    from: env.SES_FROM_ADDRESS, configurationSet: env.SES_CONFIGURATION_SET,
    send: async (input) => {
      const mod = await import("@aws-sdk/client-sesv2");
      sesClient ??= new mod.SESv2Client({});
      return sesClient.send(new mod.SendEmailCommand(input));
    },
  })
  : undefined;
// Requester mail (approved, declined, awaiting record) goes through the Join identity and its own configuration set (HFY-TSK-331, P2-R61, Q2-09), never the
// general one above: without JOIN_* the decision still commits and answers emailSent:false (fail closed).
const requesterMailer = env.JOIN_FROM_ADDRESS && env.JOIN_SES_CONFIGURATION_SET
  ? createSesMailer({
    from: env.JOIN_FROM_ADDRESS, configurationSet: env.JOIN_SES_CONFIGURATION_SET,
    send: async (input) => {
      const mod = await import("@aws-sdk/client-sesv2");
      sesClient ??= new mod.SESv2Client({});
      return sesClient.send(new mod.SendEmailCommand(input));
    },
  })
  : undefined;

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

// Fail closed is silent per request, so say it once at cold start: requester mail stops (emailSent:false) until JoinFromAddress and JoinSesConfigurationSet are set.
if (!requesterMailer) console.warn("JOIN_FROM_ADDRESS or JOIN_SES_CONFIGURATION_SET is empty: access-request mail to requesters is disabled (decisions still commit with emailSent:false)");

const isOwner = async (sub) => (await getGroups({ sub })).includes(OWNER_GROUP);

// HFY-TSK-141: the access-request domain the desktop's first id assignment (assign mode, Q2-03) completes through: the policy asks which request a created
// Person came from, then links it. The approval path (mint mode) uses the handler's own instance. HFY_ID_POLICY is read as everywhere (unset = off).
const accessRequests = createAccessRequests({ ddb, cmds, table, now: () => Date.now(), uid: () => ulid(Date.now()), mailer, requesterMailer, getAdmins, isOwner, personFacts, readEntries, guardDob: guardDobFromEnv(env), log: console });
// A bad HFY_ID_POLICY value must not stop the whole API at start-up: leave the policy unset here and let policyOf() report it as 500 id_policy_misconfigured per request.
let idPolicy;
try {
  idPolicy = createIdPolicy({ mode: idPolicyFromEnv(env).mode, accessRequestOf: accessRequests.accessRequestOf, completeAccessRequest: accessRequests.completeById });
} catch (e) {
  console.error("id policy misconfigured", logSafeError(e));
}

// HFY-TSK-172: /api/sync/* takes the desktop client's bearer token (aud https://harrisonfamily.us/api/sync, client_id hfy-sync-desktop), authorized by the
// gramps-owner group of the same cached, fail-closed groups.json read. The routes answer 404 not_enabled unless SYNC_API_ENABLED=1 (stack parameter SyncApiEnabled).
const authenticateSync = createSyncAuthenticator({ issuer: env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth", getJwks, getGroups });

/** The inbox store (BRD2 D2-15): INBOX#<principal> rows on the app table. Unread items carry no TTL; the 90-day TTL starts when an item is read. */
export const INBOX_TTL = Object.freeze({ unreadTtlDays: null, readTtlDays: 90 });
export const createInboxStore = (client = ddb, commands = cmds, tableName = table) => new DynamoNotificationStore(client, commands, tableName, { ...INBOX_TTL });

// HFY-TSK-178 (hfy-record-change-fanout): the self_edit and tag contribution ops come only from this contributor, added inside applyBatch's own
// transaction by the commit-hook registry (sync/hooks.js). It is registered once per container, on the process-wide registry the push and edit routes use.
registerRecordContributor({ ddb, cmds, table });

// The render-outbox consumer (src/record-change-fanout.js), the only source of record-change notifications. Triggered by the table stream (SYNC#RENDERED inserts) or a direct invoke
// { source: "record-fanout", seq }; neither comes through the Function URL, so neither carries the origin header. Recipients are gated by recordSubsV1.
let fanout;
async function recordFanout() {
  if (fanout) return fanout;
  const p = await loadPush();
  const notifier = createFanoutNotifier({
    subscriptions: new DynamoSubscriptionStore(ddb, cmds, table), preferences: new DynamoPreferencesStore(ddb, cmds, table),
    webpush: p.webpush, vapid: p.vapid, inbox: createInboxStore(), featureOn: (name, principal) => features.featureOn(name, principal),
    listMembers, followersOf: queryFollowers(ddb, cmds, table), log: console,
  });
  fanout = createRecordFanout({ ddb, cmds, table, notifier, labelOf: (sub) => resolveLabel({ sub }), log: console });
  return fanout;
}

let inner;
let mcp;
export const handler = async (event, context) => {
  const remainingMs = () => context?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  if (isStreamEvent(event)) return (await recordFanout()).handleStream(event, { remainingMs });
  if (isReplayEvent(event)) return (await recordFanout()).handleInvoke(event, { remainingMs });
  if (!originVerified(event, env.ORIGIN_VERIFY)) return forbidden(); // HFY-R43, before any routing
  if (!inner) {
    const p = await loadPush();
    inner = createHandler({
      ddb, cmds, table, authenticate, authenticateSync, ulid,
      subscriptions: new DynamoSubscriptionStore(ddb, cmds, table),
      preferences: new DynamoPreferencesStore(ddb, cmds, table),
      inbox: createInboxStore(),
      getAdmins, listMembers, personExists,
      presignGet: createPresignGet(), // the sync pull routes: snapshot and blob downloads, 300 s
      syncBucket: env.SYNC_BUCKET ?? "harrisonfamily-sync",
      presignPut: createPresignPut(), // signs content-type, no empty-body checksum (HFY-R58)
      s3, // checkLocation reads the first 256 KiB of a new post attachment (upload-guard.js; UploadReads in app-stack.yaml)
      guardDob: guardDobFromEnv(env), // HFY_GUARD_DOB=on (stack parameter GuardDob): the dob_not_allowed refusal; default off
      mediaBucket: env.MEDIA_BUCKET ?? "harrisonfamily-frontend",
      mediaPublicBase: env.MEDIA_PUBLIC_BASE ?? "https://harrisonfamily.us",
      features, isOwner, mailer, requesterMailer, personFacts, readEntries, idPolicy,
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
