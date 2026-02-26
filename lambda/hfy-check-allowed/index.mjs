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
const allowedOrigins = ALLOWED_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean);
const sessionTtlMs = Number(SESSION_TTL_SECONDS) * 1000;
const slotDurationMs = sessionTtlMs; // HMAC slot window matches session TTL (900 s)

let cachedHashes = null;
let cachedMapping = null;
let cachedSecret = null;

export const handler = async (event) => {
  const origin = event.headers?.origin || "";
  const corsHeaders = buildCors(origin);
  const method = event.httpMethod || event.requestContext?.http?.method || "";

  const requestId =
    event.requestContext?.requestId ||
    event.headers?.["x-amzn-trace-id"] ||
    crypto.randomUUID();

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

  // Parse body — malformed JSON → 400, never 500
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    console.warn("[HFY_CHECK_ALLOWED] Malformed JSON body", { requestId });
    return json(400, corsHeaders, { allowed: false, error: "bad_request" });
  }

  if (!body || typeof body !== "object") {
    return json(400, corsHeaders, { allowed: false, error: "bad_request" });
  }

  // Route based on body variant
  if (body.magic_token !== undefined) {
    return handleMagicTokenVerify(body, requestId, corsHeaders);
  }
  if (body.email !== undefined && body.id_token === undefined && body.token === undefined) {
    return handleMagicLinkRequest(body, requestId, corsHeaders);
  }
  return handleGoogleToken(body, requestId, corsHeaders);
};

// ─── Google ID token path ─────────────────────────────────────────────────────

async function handleGoogleToken(body, requestId, corsHeaders) {
  const idToken = body?.id_token || body?.token;

  if (!idToken || typeof idToken !== "string" || !idToken.trim()) {
    console.warn("[HFY_CHECK_ALLOWED] Missing or empty id_token", { requestId });
    return json(400, corsHeaders, { allowed: false, error: "bad_request" });
  }

  let payload;
  try {
    payload = await verifyGoogleToken(idToken.trim());
  } catch (err) {
    const msg = (err?.message || "").toLowerCase();
    // Distinguish expired tokens from structurally invalid ones
    if (
      msg.includes("too late") ||
      msg.includes("token expired") ||
      msg.includes("used after")
    ) {
      console.warn("[HFY_CHECK_ALLOWED] Google token expired", {
        requestId,
        message: err.message
      });
      return json(200, corsHeaders, { allowed: false, error: "token_expired" });
    }
    console.warn("[HFY_CHECK_ALLOWED] Invalid Google token", {
      requestId,
      message: err.message
    });
    return json(400, corsHeaders, { allowed: false, error: "invalid_token" });
  }

  const email = (payload?.email || "").toLowerCase().trim();
  if (!email || payload?.email_verified !== true) {
    console.warn("[HFY_CHECK_ALLOWED] Email not verified or missing", {
      requestId,
      emailPreview: redactEmail(email)
    });
    return json(403, corsHeaders, { allowed: false, error: "unverified_email" });
  }

  return issueSessionIfAllowed(email, requestId, corsHeaders);
}

// ─── Magic-link request path: { email } ──────────────────────────────────────

async function handleMagicLinkRequest(body, requestId, corsHeaders) {
  const email = normalizeEmail(body.email);

  if (!email || !isValidEmail(email)) {
    console.warn("[HFY_CHECK_ALLOWED] Invalid email in magic-link request", { requestId });
    return json(400, corsHeaders, { allowed: false, error: "invalid_email" });
  }

  // TODO (HFY-TSK-041): Generate HMAC slot token and send via SES.
  // Token generation sketch (secret + slot computed here when SES is wired):
  //   const secret = await loadSecret();
  //   const slot = currentSlot();
  //   const token = computeSlotHmac(secret, email, slot);
  //   await sendMagicLinkEmail(email, token);  // SES send
  console.info("[HFY_CHECK_ALLOWED] Magic-link request received (SES send pending HFY-TSK-041)", {
    requestId,
    emailPreview: redactEmail(email)
  });

  // Generic confirmation — does not reveal whether email is on allowlist
  return json(200, corsHeaders, { sent: true });
}

// ─── Magic-link verify path: { magic_token, email } ──────────────────────────

async function handleMagicTokenVerify(body, requestId, corsHeaders) {
  const email = normalizeEmail(body.email);
  const magicToken = body.magic_token;

  if (!email || !isValidEmail(email)) {
    console.warn("[HFY_CHECK_ALLOWED] Invalid email in magic-token verify", { requestId });
    return json(400, corsHeaders, { allowed: false, error: "invalid_email" });
  }

  if (!magicToken || typeof magicToken !== "string" || !magicToken.trim()) {
    console.warn("[HFY_CHECK_ALLOWED] Missing magic_token field", { requestId });
    return json(400, corsHeaders, { allowed: false, error: "bad_request" });
  }

  let secret;
  try {
    secret = await loadSecret();
  } catch (err) {
    console.error("[HFY_CHECK_ALLOWED] Failed to load secret for magic-token verify", {
      requestId,
      message: err?.message
    });
    return json(500, corsHeaders, { allowed: false, error: "server_error" });
  }

  // Check current slot and previous slot (covers the 900-second boundary edge case)
  const slot = currentSlot();
  const validTokens = [
    computeSlotHmac(secret, email, slot),
    computeSlotHmac(secret, email, slot - 1)
  ];
  const tokenValid = validTokens.some((t) => timingSafeEqual(t, magicToken.trim()));

  if (!tokenValid) {
    console.warn("[HFY_CHECK_ALLOWED] Magic token expired or invalid", {
      requestId,
      emailPreview: redactEmail(email)
    });
    return json(200, corsHeaders, { allowed: false });
  }

  return issueSessionIfAllowed(email, requestId, corsHeaders);
}

// ─── Shared session issuance ──────────────────────────────────────────────────

async function issueSessionIfAllowed(email, requestId, corsHeaders) {
  let hashList, mapping, secret;
  try {
    [hashList, mapping, secret] = await Promise.all([
      loadAllowlistHashes(),
      loadEmailMapping(),
      loadSecret()
    ]);
  } catch (err) {
    console.error("[HFY_CHECK_ALLOWED] Failed to load config resources", {
      requestId,
      message: err?.message
    });
    return json(500, corsHeaders, { allowed: false, error: "server_error" });
  }

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

  console.info("[HFY_CHECK_ALLOWED] Allowlist match — session issued", {
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
}

// ─── HMAC slot helpers ────────────────────────────────────────────────────────

function currentSlot() {
  return Math.floor(Date.now() / slotDurationMs);
}

function computeSlotHmac(secret, email, slot) {
  return crypto.createHmac("sha256", secret).update(`${email}:${slot}`).digest("base64url");
}

function timingSafeEqual(a, b) {
  try {
    const aBuf = Buffer.from(a, "base64url");
    const bBuf = Buffer.from(b, "base64url");
    if (aBuf.length !== bBuf.length) {
      // Still do a comparison to avoid length-based timing leak
      crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// ─── Email helpers ────────────────────────────────────────────────────────────

function normalizeEmail(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.toLowerCase().trim();
}

function isValidEmail(email) {
  // Covers local@domain.tld format; rejects consecutive dots, excessive length
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,63}$/.test(email) && email.length <= 254;
}

// ─── Data loaders (warm Lambda cache) ────────────────────────────────────────

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
  if (cachedHashes) return cachedHashes;
  const response = await s3.send(
    new GetObjectCommand({ Bucket: HASH_BUCKET, Key: HASH_KEY })
  );
  const body = await response.Body.transformToString();
  cachedHashes = JSON.parse(body);
  return cachedHashes;
}

async function loadEmailMapping() {
  if (cachedMapping) return cachedMapping;
  const response = await s3.send(
    new GetObjectCommand({ Bucket: MAPPING_BUCKET, Key: MAPPING_KEY })
  );
  const body = await response.Body.transformToString();
  cachedMapping = JSON.parse(body);
  return cachedMapping;
}

async function loadSecret() {
  if (cachedSecret) return cachedSecret;
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: SECRET_NAME })
  );
  cachedSecret = response.SecretString;
  return cachedSecret;
}

// ─── CORS + response helpers ──────────────────────────────────────────────────

function buildCors(origin) {
  const allowedOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0] || "*";
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
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload)
  };
}
