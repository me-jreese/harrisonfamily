// The R-18 / R-19 guard in every edit path (HFY-PLN-002 editing design 6.3, task edit-guard-wiring): the server adapter over the
// shared core (shared/edit-guard.mjs, which wraps the one detector and the one isBirthLike predicate over
// gramps/redaction/redaction-v1.json). The rules and the finding shape are documented there; this file adds the policy read, the
// 422 error and the log line, which carries counts per code and never text, offsets or ids.
//
//   const guard = createRecordGuard({ dob: guardDobFromEnv(), log });
//   guard.assertObjects(resultingObjects, { surface: "changes", opIdFor });   // throws RecordGuardError (422)
//   guard.assertValue(note, "proposal.note");  guard.assertValue(stubs, "intent.stubs");
//
// No route calls it yet; its first caller is `edit-api-core` (then `relationship-api`, `proposal-store-api`), so it ships in the
// hfy-api zip unreachable.
import { existsSync, readFileSync } from "node:fs";
import { COPY as TEXT_COPY } from "../shared/privacy-guard.mjs";
import { CODES, countsPerCode, createEditGuard } from "../shared/edit-guard.mjs";
import { guardDobFromEnv } from "../guard.js";
import { HttpError } from "../http.js";

export { CODES, countsPerCode, guardDobFromEnv };
export const COPY = Object.freeze({ ...TEXT_COPY, never_in_cloud: "we don't keep that on the site, so please remove it to continue." });
const ORDER = [CODES.contact, CODES.dob, CODES.never]; // the code a mixed refusal reports

let cached = null;
const POLICY = "gramps/redaction/redaction-v1.json";
/** Where the policy sits for a guard.js at `base`: the zip stages gramps/ beside src/ (../../gramps from src/records), the checkout keeps it at the repo root (../../../gramps from api/src/records). */
export function policyUrl(base = import.meta.url, exists = existsSync) {
  const staged = new URL(`../../${POLICY}`, base);
  const checkout = new URL(`../../../${POLICY}`, base);
  return exists(staged) ? staged : checkout;
}
/** The parsed gramps/redaction/redaction-v1.json, found in either layout. */
export function loadPolicy() {
  cached ??= JSON.parse(readFileSync(policyUrl(), "utf8"));
  return cached;
}

/** 422 {error: code, message, errors: [{opId, obj, path, pointer, code, kind, span}]}. No matched text, ever. */
export class RecordGuardError extends HttpError {
  constructor(errors) {
    const code = ORDER.find((c) => errors.some((e) => e.code === c)) ?? CODES.contact;
    super(422, code, COPY[code]);
    this.name = "RecordGuardError";
    this.errors = errors;
  }
}

/** `policy` defaults to loadPolicy(); `dob` is the DOB-heuristic switch; `log.info("privacy_guard", {surface, op, counts})` on a refusal. */
export function createRecordGuard({ policy, dob = false, log } = {}) {
  const core = createEditGuard({ policy: policy ?? loadPolicy(), dob });
  function assertClean(errors, { surface = "records", op = "check" } = {}) {
    if (!errors.length) return;
    try { log?.info?.("privacy_guard", { surface, op, counts: countsPerCode(errors) }); } catch { /* logging never changes the answer */ }
    throw new RecordGuardError(errors);
  }
  return {
    ...core,
    assertClean,
    assertObjects: (objects, opts = {}) => assertClean(core.checkObjects(objects, opts), opts),
    assertTexts: (fields, opts = {}) => assertClean(core.checkTexts(fields, opts), opts),
    assertValue: (value, obj, opts = {}) => assertClean(core.checkValue(value, obj, opts), opts),
  };
}
