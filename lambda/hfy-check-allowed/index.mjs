import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const {
  GOOGLE_CLIENT_ID,
  HASH_BUCKET = "harrisonfamily",
  HASH_KEY = "config/allowed_hashes.json",
  MAPPING_BUCKET = "harrisonfamily",
  MAPPING_KEY = "config/userGrampsID.json",
  SECRET_NAME = "HFY_ALLOWLIST_HMAC_SECRET",
  ALLOWED_ORIGINS = "",
  SESSION_TTL_SECONDS = "900"
} = process.env;

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const allowedOrigins = ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
const sessionTtlMs = Number(SESSION_TTL_SECONDS) * 1000;

let cachedHashes = null;
let cachedMapping = null;
let cachedSecret = null;

export const handler = async (event) => {
  const origin = event.headers?.origin || "";
  const corsHeaders = buildCors(origin);
  const method = event.httpMethod || event.requestContext?.http?.method || "";

  const requestId = event.requestContext?.requestId || event.headers?.["x-amzn-trace-id"] || crypto.randomUUID();
  console.info("[HFY_CHECK_ALLOWED] Incoming request", {
    requestId,
    method,
    origin,
    path: event.rawPath || event.requestContext?.http?.path || "unknown"
  });

  if (method.toUpperCase() === "OPTIONS") {
    console.info("[HFY_CHECK_ALLOWED] Responding to CORS preflight", { requestId });
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (method.toUpperCase() !== "POST") {
    console.warn("[HFY_CHECK_ALLOWED] Method not allowed", { requestId, method });
    return json(405, corsHeaders, { error: "Method Not Allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const idToken = body?.id_token || body?.token;

    if (!idToken) {
      console.warn("[HFY_CHECK_ALLOWED] Missing id_token", { requestId });
      return json(400, corsHeaders, { allowed: false, error: "missing id_token" });
    }

    const payload = await verifyGoogleToken(idToken);
    const email = (payload?.email || "").toLowerCase().trim();

    if (!email || payload?.email_verified !== true) {
      console.warn("[HFY_CHECK_ALLOWED] Email not verified or missing", {
        requestId,
        emailPreview: redactEmail(email)
      });
      return json(403, corsHeaders, { allowed: false, error: "unverified email" });
    }

    const [hashList, mapping, secret] = await Promise.all([
      loadAllowlistHashes(),
      loadEmailMapping(),
      loadSecret()
    ]);

    const digest = crypto.createHmac("sha256", secret).update(email).digest("hex");
    const grampsId = mapping[email];
    const allowed = hashList.includes(digest) && Boolean(grampsId);

    if (!allowed) {
      console.warn("[HFY_CHECK_ALLOWED] Email not on allowlist or missing Gramps ID", {
        requestId,
        emailPreview: redactEmail(email),
        hasMapping: Boolean(grampsId)
      });
      return json(403, corsHeaders, { allowed: false });
    }

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = new Date(now + sessionTtlMs).toISOString();

    console.info("[HFY_CHECK_ALLOWED] Allowlist match", {
      requestId,
      emailPreview: redactEmail(email),
      grampsId,
      expiresAt
    });

    return json(200, corsHeaders, {
      allowed: true,
      grampsId,
      sessionToken,
      issuedAt: new Date(now).toISOString(),
      expiresAt,
      expiresIn: Number(SESSION_TTL_SECONDS)
    });
  } catch (error) {
    console.error("[HFY_CHECK_ALLOWED] Error verifying request", {
      message: error?.message,
      stack: error?.stack
    });
    return json(500, corsHeaders, { allowed: false, error: "server error" });
  }
};

function redactEmail(email = "") {
  if (!email) return "unknown";
  const [user, domain] = email.split("@");
  if (!domain) return `${email.slice(0, 3)}***`;
  return `${user.slice(0, 3)}***@${domain}`;
}

async function verifyGoogleToken(idToken) {
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID
  });
  return ticket.getPayload();
}

async function loadAllowlistHashes() {
  if (cachedHashes) {
    return cachedHashes;
  }
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: HASH_BUCKET,
      Key: HASH_KEY
    })
  );
  const body = await response.Body.transformToString();
  cachedHashes = JSON.parse(body);
  return cachedHashes;
}

async function loadEmailMapping() {
  if (cachedMapping) {
    return cachedMapping;
  }
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: MAPPING_BUCKET,
      Key: MAPPING_KEY
    })
  );
  const body = await response.Body.transformToString();
  cachedMapping = JSON.parse(body);
  return cachedMapping;
}

async function loadSecret() {
  if (cachedSecret) {
    return cachedSecret;
  }
  const response = await secrets.send(
    new GetSecretValueCommand({
      SecretId: SECRET_NAME
    })
  );
  cachedSecret = response.SecretString;
  return cachedSecret;
}

function buildCors(origin) {
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}

function json(statusCode, headers, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  };
}
