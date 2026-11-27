// Life state on the pages (HFY-TSK-427, HFY-ISS-031, rulings P5-R2 to P5-R5; flag lifeStateV1, default false). Pure: no DOM, no fetch.
// The rule is shared/life-state.mjs (deceased | living | unknown); this file is the copy and the one question the pages ask:
// "does this page say 'status unknown' for this person?". Display only (P5-R5): it never changes what is hidden for privacy, never
// reads or writes the published isLiving flag beyond "the data says no death", and never writes a death.
// 11ty/js/person-page.js is a classic script that cannot import this file: it carries the same strings and the same 12-line rule,
// and tests/client/person-page-life-state.test.mjs pins its copies equal to these (and to shared/life-state.mjs).
import { lifeState, LIFE_STATE } from "../../../shared/life-state.mjs";

import { FLAG, STATUS_UNKNOWN_COPY, NO_BIRTH_YEAR_COPY, HELP_FILL_IN_COPY, HELP_FILL_IN_HREF, unknownLine } from "./life-state-words.js";

export { FLAG, STATUS_UNKNOWN_COPY, NO_BIRTH_YEAR_COPY, HELP_FILL_IN_COPY, HELP_FILL_IN_HREF, unknownLine };

/**
 * Is this person shown as "status unknown"? `ls` is the loaded evidence ({enabled, evidence: {id: day}, confirmed: {id: day}, now}) or
 * null/undefined. Always false with the flag off, and for anyone the published data does not call living (`living` must be exactly true:
 * a person with a recorded death, or with no flag at all, keeps today's words).
 */
export function isStatusUnknown(ls, { id, living, birthYear, deathYear } = {}) {
  if (!ls || ls.enabled !== true || living !== true) return false;
  const ev = ls.evidence && id ? ls.evidence[id] : undefined;
  const cf = ls.confirmed && id ? ls.confirmed[id] : undefined;
  return lifeState({ hasDeath: false, deathYear, birthYear, evidenceAt: ev, confirmedLivingAt: cf, now: ls.now }) === LIFE_STATE.unknown;
}
