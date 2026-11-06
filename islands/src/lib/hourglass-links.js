// The addresses the hourglass trees link with (HFY-TSK-379, flag familyVizHourglass), pure so tests/hourglass-big-links.test.mjs can walk the round trip:
//   person page -> small tree -> big tree (/tree/?view=tree&focus=<id>&from=<id>) -> a person's page or one of the family views -> back.
// An id outside the tree page's id pattern is never put in an address (lib/tree-link.js treeLinkHref, lib/merged-person.js).
const ID = /^[A-Za-z0-9_-]{1,32}$/;
export const ok = (x) => typeof x === "string" && ID.test(x);

/** The big tree centred on `id`; `from` (the person page the visitor came from) is what its "back to" returns to. Null for a bad id. */
export const bigHref = (id, from) => (ok(id) ? `/tree/?view=tree&focus=${id}${ok(from) ? `&from=${from}` : ""}` : null);

/** The person's own page, null for a bad id. */
export const page = (id) => (ok(id) ? `/person/?id=${id}` : null);

/** A view of the family page with `id` in front: ?view=cards|outline|table|family. `extra` is e.g. "&kin=1", the relationship panel opened. */
export const listHref = (view, id, extra = "") => `/tree/?view=${view}&focus=${id}${extra}`;
