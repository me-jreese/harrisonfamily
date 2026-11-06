// HFY-TSK-238 (api-feature-gate; BRD2 D2-28, review PS-12 and DL-10): the one server-side gate for every PLN-002 route.
//
// - requireFeature(name) goes on a ROUTES entry (`gate: requireFeature("inboxV1")`). The route answers 404 not_found unless the flag is true in
//   the deployed flags file or the caller is in the `uat` group of config/groups.json. Signed out counts as "not uat", so a dark route is a
//   404 to everyone outside the group, never a 401 that would reveal it.
// - serverSwitch(name, check) is the alternative for the high-risk surfaces whose security boundary is a stack switch (HFY_EDITING,
//   ACCESS_REQUESTS, chat service auth, SYNC_API_ENABLED). The declaring task supplies `check`, so a declared switch is always enforced. A switch
//   whose check is a rule of the route's own rather than the stack switch alone says so in `rule`, which caps.json publishes beside the name.
// - gateExempt(reason) marks the one io-approved exemption, GET /api/me (BRD2 10.1). test/features.test.js fails for any other.
// - featureOn(name, principal) is the same rule for producers, for example the persist-first inbox writes (featureOn("inboxV1", recipient)).
//
// The flags file is the one the site loads: GET https://<site>/_data/flags.json, through CloudFront, so the gate needs no S3 grant. It is
// cached for 60 s; when a read fails the last good value is kept for up to 10 minutes after the last successful read, then every feature is
// off (fail closed) until a read succeeds again.
//
// The x-hfy-preview header carries the islands' ?hfy_flags value ("name" on, "-name" off). The server honours it only for uat principals:
// for anyone else ?hfy_flags stays UI-only (BRD2 1.3, the HFY-R42/R58 amendment), so a member cannot reach a dark route by previewing it.
import { HttpError, logSafeError } from "./http.js";
import { UAT_GROUP } from "./policy.js";

export { UAT_GROUP };
export const DEFAULT_FLAGS_URL = "https://harrisonfamily.us/_data/flags.json";
export const FLAGS_TTL_MS = 60_000;
export const FLAGS_MAX_STALE_MS = 600_000;
/** After a failed read the next attempt waits this long, so an outage costs one fetch per container per 5 s, not one per request. */
export const FLAGS_RETRY_MS = 5_000;
export const FLAGS_TIMEOUT_MS = 3_000;
export const PREVIEW_HEADER = "x-hfy-preview";
/** The stack switches a PLN-002 route may declare instead of a feature (api-feature-gate AC3). */
export const SERVER_SWITCHES = Object.freeze(["HFY_EDITING", "ACCESS_REQUESTS", "CHAT_SERVICE_AUTH", "SYNC_API_ENABLED"]);

/** A flag name as flags.json and ?hfy_flags spell it (camelCase word characters). */
const FLAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NO_FLAGS = Object.freeze({});
const notFound = () => new HttpError(404, "not_found", "no such route");

/** ROUTES entry member: the route is dark until flag `name` is on (or the caller is uat). */
export function requireFeature(name) {
  if (typeof name !== "string" || !FLAG_NAME_RE.test(name)) throw new TypeError(`requireFeature: invalid flag name ${JSON.stringify(name)}`);
  return Object.freeze({ type: "feature", name });
}

/**
 * ROUTES entry member: the route sits behind stack switch `name`. `check({actor})` runs on every call before the handler (and before the 401
 * for a signed-out caller): return true to continue, false for 404 not_found, or throw the switch's own HttpError (for example 404 not_enabled
 * for SYNC_API_ENABLED, 503 when chat service keys are unset). `check` also receives `params` (the matched path parameters) and `ctx`
 * ({ddb, cmds, table, now}) when the handler supplies them (the records routes read them to let a member reach their own record).
 * `rule` (optional) describes what `check` enforces when that is more than the stack switch, for caps.json (the member's second-email routes).
 */
export function serverSwitch(name, check, { rule } = {}) {
  if (!SERVER_SWITCHES.includes(name)) throw new TypeError(`serverSwitch: unknown switch ${JSON.stringify(name)} (one of ${SERVER_SWITCHES.join(", ")})`);
  if (typeof check !== "function") throw new TypeError(`serverSwitch(${name}): a check function is required, so the switch is enforced where it is declared`);
  if (rule !== undefined && (typeof rule !== "string" || rule.trim() === "")) throw new TypeError(`serverSwitch(${name}): rule is a description of what the check enforces`);
  return Object.freeze({ type: "switch", name, check, ...(rule !== undefined ? { rule } : {}) });
}

/** ROUTES entry member: an explicit, reviewed exemption from the gate. Only GET /api/me may carry it (BRD2 10.1; test/features.test.js). */
export function gateExempt(reason) {
  if (typeof reason !== "string" || reason.trim() === "") throw new TypeError("gateExempt: a reason is required");
  return Object.freeze({ type: "exempt", reason });
}

/** The caps.json view of a route's gate: {feature}, {switch, rule?} or {exempt}; undefined for an ungated (pre-PLN-002) route. */
export function describeGate(gate) {
  if (!gate) return undefined;
  if (gate.type === "feature") return { feature: gate.name };
  if (gate.type === "switch") return { switch: gate.name, ...(gate.rule ? { rule: gate.rule } : {}) };
  if (gate.type === "exempt") return { exempt: gate.reason };
  return { unknown: true };
}

/** The ?hfy_flags syntax: comma-separated names, "-name" forces off. Anything that is not a flag name is ignored; at most 32 entries. */
export function parsePreview(raw) {
  const out = new Map();
  if (typeof raw !== "string" || raw === "") return out;
  for (const token of raw.split(",").slice(0, 32)) {
    const t = token.trim();
    const off = t.startsWith("-");
    const name = off ? t.slice(1) : t;
    if (FLAG_NAME_RE.test(name)) out.set(name, !off);
  }
  return out;
}

/** The x-hfy-preview value of a Function URL event (header names matched in any case), or undefined. */
export function previewOf(event) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === PREVIEW_HEADER);
  const v = key ? headers[key] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v.slice(0, 512) : undefined;
}

class FlagsReadError extends Error {
  constructor(code) {
    super(code);
    this.name = "FlagsReadError";
    this.code = code;
  }
}

/** flags.json -> a frozen {name: boolean} map. Anything but a JSON object is a failed read (the last good value stays). */
function normalizeFlags(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new FlagsReadError("flags_not_object");
  return Object.freeze(Object.fromEntries(Object.entries(raw).filter(([k, v]) => FLAG_NAME_RE.test(k) && typeof v === "boolean")));
}

/**
 * Returns async () => frozen flags map. Never throws. `now` is injectable so tests drive the cache and the 10-minute limit with a fake clock.
 * Concurrent callers share one in-flight read.
 */
export function createFlagSource({
  url = DEFAULT_FLAGS_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = FLAGS_TTL_MS, maxStaleMs = FLAGS_MAX_STALE_MS,
  retryMs = FLAGS_RETRY_MS, timeoutMs = FLAGS_TIMEOUT_MS, log = console,
} = {}) {
  if (typeof url !== "string" || !url.startsWith("https://")) throw new TypeError("createFlagSource: the flags url must be https://");
  let good; // {flags, at}: the last successful read
  let nextAt = -Infinity; // no read before this time
  let inflight;

  async function read() {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new FlagsReadError(`http_${res.status}`);
    return normalizeFlags(await res.json());
  }
  async function refresh() {
    try {
      const flags = await read();
      good = { flags, at: now() };
      nextAt = good.at + ttlMs;
    } catch (e) {
      nextAt = now() + retryMs;
      const stale = good ? now() - good.at : undefined;
      log.error?.(stale !== undefined && stale <= maxStaleMs ? "flags read failed (keeping the last good flags)" : "flags read failed (features off)", logSafeError(e));
    }
  }
  return async function currentFlags() {
    if (now() >= nextAt) {
      inflight ??= refresh().finally(() => { inflight = undefined; });
      await inflight;
    }
    return good && now() - good.at <= maxStaleMs ? good.flags : NO_FLAGS;
  };
}

/**
 * The gate. `flags()` returns the deployed flags map (createFlagSource); `isUat(sub)` says whether a gramps_id is in the uat group of
 * config/groups.json (index.js builds it from the cached, fail-closed groups resolver in policy.js).
 *
 * featureOn(name, principal, {preview}): principal is an actor {id} or a gramps_id string; preview is the raw x-hfy-preview value of the
 * principal's own request. Members, admins and signed-out callers get the deployed value and their preview is ignored. A uat principal gets
 * true unless their preview forces the flag off ("-name"), so UAT on production sees every dark route and, for producers, receives the
 * dark writes (for example inbox items) addressed to them.
 */
export function createFeatureGate({ flags, isUat, log = console }) {
  const subOf = (p) => (typeof p === "string" ? p : typeof p?.id === "string" ? p.id : undefined);
  async function uat(principal) {
    const sub = subOf(principal);
    if (!sub) return false;
    try {
      return (await isUat(sub)) === true;
    } catch (e) {
      log.error?.("uat lookup failed (not uat)", logSafeError(e));
      return false;
    }
  }
  async function featureOn(name, principal, opts) {
    if (typeof name !== "string" || !FLAG_NAME_RE.test(name)) return false;
    if (await uat(principal)) return parsePreview(opts?.preview).get(name) ?? true;
    try {
      return (await flags())[name] === true;
    } catch (e) {
      log.error?.("flags unavailable (features off)", logSafeError(e)); // createFlagSource never throws; any other source fails closed
      return false;
    }
  }
  /** Throws the refusal for `gate` (404 not_found, or a switch's own error); returns when the caller may proceed. */
  async function check(gate, actor, opts) {
    if (gate === undefined || gate === null || gate.type === "exempt") return;
    if (gate.type === "feature") {
      if (await featureOn(gate.name, actor, opts)) return;
      throw notFound();
    }
    if (gate.type === "switch") {
      if ((await gate.check({ actor, params: opts?.params, ctx: opts?.ctx })) === true) return;
      throw notFound();
    }
    throw notFound(); // an unknown gate kind fails closed
  }
  async function allows(gate, actor, opts) {
    try {
      await check(gate, actor, opts);
      return true;
    } catch (e) {
      if (e instanceof HttpError) return false;
      throw e;
    }
  }
  return { featureOn, check, allows };
}

/** Everything off and nobody uat: what the API uses until index.js configures the real gate (and what a test gets by default). */
export const closedFeatureGate = () => createFeatureGate({ flags: async () => NO_FLAGS, isUat: async () => false });

let configured = closedFeatureGate();
/** index.js installs the deployed gate once per container; null puts back the closed gate. Returns the gate now in force. */
export function configureFeatures(gate) {
  configured = gate ?? closedFeatureGate();
  return configured;
}
export const currentFeatureGate = () => configured;

/** For producers: is feature `name` on for `principal` (a gramps_id or actor)? Same rule as requireFeature; false until configured. */
export const featureOn = (name, principal, opts) => configured.featureOn(name, principal, opts);
