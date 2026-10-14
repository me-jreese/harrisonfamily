// The browser mirror of the edit guard (HFY-PLN-002 editing design 6.3 path h, task edit-guard-wiring). It bundles the SAME core the
// API adapter runs (shared/edit-guard.mjs over shared/privacy-guard.mjs and shared/redaction-rules.mjs) with the same
// gramps/redaction/redaction-v1.json, so the editor, the relationship wizard and the review island can highlight a hit inline and
// disable submit. UX only: the API's 422 is the authority (D2-09), and there is no override. A shared corpus,
// shared/edit-guard.cases.json, gives identical findings on both sides.
//
//   const guard = createEditGuard({ dob });          // dob: the HFY_GUARD_DOB switch the page learns from the API
//   guard.checkObjects(resultingObjects)             // [{opId, obj, path, pointer, code, kind, span}]
//   guard.checkValue("note text", "proposal.note")   // spans for inline highlighting; the matched text is never returned
import policy from "../../../gramps/redaction/redaction-v1.json";
import { CODES, createEditGuard as createCore } from "../../../shared/edit-guard.mjs";
import { COPY } from "../../../shared/privacy-guard.mjs";

export { CODES };
/** The member-facing copy for each code (DS voice). */
export const EDIT_GUARD_COPY = Object.freeze({ ...COPY, never_in_cloud: "we don't keep that on the site, so please remove it to continue." });
export const createEditGuard = ({ dob = false } = {}) => createCore({ policy, dob });
/** Default guard: contact kinds only, like the API with HFY_GUARD_DOB off. */
export const editGuard = createEditGuard();
