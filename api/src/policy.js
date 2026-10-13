// HFY-TSK-073/077: the MCP/UI permission table and the S3 group config it is evaluated against. ONE table: the MCP core evaluates it per
// tools/list and tools/call, and scripts/gen-caps.mjs publishes it as dist/policy.json for the UI to read (M-09), so UI and MCP cannot disagree.
//
// Group config (read-only for the API): s3://$GROUPS_BUCKET/$GROUPS_KEY, default harrisonfamily/config/groups.json.
//   {
//     "version": 1,
//     "groups": {
//       "mcp-authors": { "emails": ["io-curated@example.org"], "subjects": [] },   // may be empty: nobody can author yet
//       "hfy-admin":   { "subjects": ["I0113"] }                                  // exactly the subject bound to gramps_id I0113
//     }
//   }
// `subjects` are gramps_ids (the token `sub`). `emails` resolve to a subject through the family allowlist (ALLOWLIST_KEY, optional) or an
// `email` claim; the group is granted only on an exact, case-insensitive match. hfy-admin accepts subjects ONLY (no email path), and the token's own
// `groups` claim (members/admins from the auth edge) is deliberately ignored for MCP authorization. Any load/parse failure fails closed (no groups).

import { logSafeError } from "./http.js";

export const AUTHORS_GROUP = "mcp-authors";
export const ADMIN_GROUP = "hfy-admin";
export const STEP_UP_MAX_AGE_SECONDS = 300;
/**
 * HFY-R67: step-up means user verification was performed, so ONLY "mfa" counts. The auth edge's passkeys run with userVerification "preferred":
 * the kit's passkeyAmr always emits "passkey" plus "hwk"/"swk" and adds "mfa" only when UV happened. "passkey"/"hwk"/"swk" alone are a single
 * possession factor (a PIN-less security key left on a shared computer) and must not unlock deletes. iPhone passkeys always perform UV.
 */
export const STRONG_AMR = ["mfa"];

const BOTH = [AUTHORS_GROUP, ADMIN_GROUP];
/** Action ids are the route names in routes.js. Exact rows beat globs; `*.delete` covers every delete action (current and future). */
export const POLICY_ROWS = [
  { action: "comments.list", show: BOTH, execute: BOTH },
  { action: "posts.list", show: BOTH, execute: BOTH },
  { action: "posts.get", show: BOTH, execute: BOTH },
  { action: "comments.create", show: BOTH, execute: BOTH, agentMode: "dry_run" },
  { action: "posts.create", show: BOTH, execute: BOTH, agentMode: "dry_run" },
  { action: "*.delete", show: [ADMIN_GROUP], execute: [ADMIN_GROUP], minAssurance: "step_up", agentMode: "dry_run" },
];
export const POLICY = { rows: POLICY_ROWS, defaultGroup: AUTHORS_GROUP };

export const policyDocument = () => ({ version: 1, defaultGroup: AUTHORS_GROUP, adminGroup: ADMIN_GROUP, stepUp: { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS, amr: STRONG_AMR }, rows: POLICY_ROWS });

const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
const lower = (s) => s.toLowerCase();

/** raw JSON -> { authors: {emails:Set, subjects:Set}, admins: Set }. Unknown shapes yield empty sets (fail closed). */
export function parseGroupsConfig(raw) {
  const g = raw && typeof raw === "object" ? raw.groups ?? {} : {};
  const a = g[AUTHORS_GROUP] ?? {};
  return {
    authors: { emails: new Set(strs(a.emails).map(lower)), subjects: new Set(strs(a.subjects)) },
    admins: new Set(strs(g[ADMIN_GROUP]?.subjects)),
  };
}

/**
 * Returns async ({sub, email?, emailVerified?}) => string[] (the effective MCP groups).
 * load(): the groups.json object. emailsFor(sub) (optional): emails the family allowlist binds to a subject.
 */
export function createGroupResolver({ load, emailsFor, ttlMs = 60_000, now = () => Date.now(), log = console }) {
  let cache = { at: -Infinity, cfg: parseGroupsConfig(null) };
  const cfg = async () => {
    if (now() - cache.at < ttlMs) return cache.cfg;
    try {
      cache = { at: now(), cfg: parseGroupsConfig(await load()) };
    } catch (e) {
      log.error?.("groups config unavailable (failing closed)", logSafeError(e));
      cache = { at: now() - ttlMs + 5_000, cfg: parseGroupsConfig(null) }; // retry in 5 s; nobody is granted anything meanwhile
    }
    return cache.cfg;
  };
  return async ({ sub, email, emailVerified }) => {
    if (typeof sub !== "string" || sub === "") return [];
    const c = await cfg();
    const out = [];
    let author = c.authors.subjects.has(sub);
    if (!author && c.authors.emails.size > 0) {
      const mine = [...(emailsFor ? await emailsFor(sub).catch(() => []) : []), ...(typeof email === "string" && emailVerified !== false ? [email] : [])];
      author = mine.some((e) => typeof e === "string" && c.authors.emails.has(lower(e)));
    }
    if (author) out.push(AUTHORS_GROUP);
    if (c.admins.has(sub)) out.push(ADMIN_GROUP);
    return out;
  };
}
