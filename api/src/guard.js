// The R-18 guard on today's member write paths (HFY-PLN-002 BRD2 5.2 and 5.3, task privacy-guard-existing-paths): post create
// and edit (body, title, every attachment alt) in content.js and comment create and edit (body) in comments.js, which the MCP
// tools reach through handler.invoke. One detector for every runtime: shared/privacy-guard.mjs (src/shared is the symlink).
//
// A refusal is 422 {error: "contact_info" | "dob_not_allowed", message, errors: [{pointer, kind, span: [start, end]}]}. The
// matched text is never in the body, the error or a log line: the log carries counts per code only (logRefusal).
//
// The DOB heuristic waits for io's answer to Q2-17 line 5 (BRD2 10.1): `dob` is the HFY_GUARD_DOB switch (stack parameter
// GuardDob, default off). Off, only the contact kinds are scanned, so a birthday-only text passes; contact kinds are refused
// from the first deploy either way.
import { DOB_KINDS, COPY, KINDS, rejectContactInfo } from "./shared/privacy-guard.mjs";
import { HttpError } from "./http.js";

/** The kinds refused whatever the switch says: phone, email, street_address, po_box, contact_url. */
export const CONTACT_KINDS = Object.freeze(KINDS.filter((k) => !DOB_KINDS.includes(k)));

/** HFY_GUARD_DOB=on turns the dob_not_allowed refusal on; anything else (unset included) leaves it off. */
export const guardDobFromEnv = (env = process.env) => String(env.HFY_GUARD_DOB ?? "").trim().toLowerCase() === "on";

/** A guard refusal: 422, the DS copy as the message, and pointers, kinds and spans only. */
export class GuardError extends HttpError {
  constructor(code, errors) {
    super(422, code, COPY[code]);
    this.name = "GuardError";
    this.errors = errors;
  }
}

/** JSON pointer escaping (RFC 6901) for a field name; indexes pass through. */
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
export const pointer = (...parts) => `/${parts.map(esc).join("/")}`;

/**
 * Returns `check(surface, op, fields)`. `fields` is `[pointer, text]` pairs; a non-string or empty text is skipped (the shape
 * checks own those). Throws GuardError when any field holds a hit; `code` is dob_not_allowed only when every hit is a dob kind.
 * `log.info("privacy_guard", {surface, op, counts})` records the refusal with counts per code, never text, offsets or ids.
 */
export function createGuard({ dob = false, log } = {}) {
  const opts = dob ? {} : { kinds: CONTACT_KINDS };
  return function check(surface, op, fields) {
    const errors = [];
    for (const [ptr, text] of fields) {
      if (typeof text !== "string" || text === "") continue;
      const v = rejectContactInfo(text, opts);
      if (!v.ok) for (const s of v.spans) errors.push({ pointer: ptr, kind: s.kind, span: [s.start, s.end] });
    }
    if (errors.length === 0) return;
    const code = errors.every((e) => DOB_KINDS.includes(e.kind)) ? "dob_not_allowed" : "contact_info";
    logRefusal(log, surface, op, errors);
    throw new GuardError(code, errors);
  };
}

/** Counts per code (contact_info, dob_not_allowed) for one refusal. Exported for the captured-log test. */
export function countsPerCode(errors) {
  const counts = {};
  for (const e of errors) {
    const c = DOB_KINDS.includes(e.kind) ? "dob_not_allowed" : "contact_info";
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

function logRefusal(log, surface, op, errors) {
  try {
    log?.info?.("privacy_guard", { surface, op, counts: countsPerCode(errors) });
  } catch {
    // logging never changes the answer
  }
}
