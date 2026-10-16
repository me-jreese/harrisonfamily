// Admin web deletes and the possible-duplicate queue: the pure model (HFY-TSK-295, edit-admin-delete; Q2-15; BRD2 R-06, R-08). No DOM, no React,
// so a node test pins the words and the rules (tests/admin-delete.test.mjs). Behind the `adminDelete` flag, for admins only; the server enforces both
// (a member is 403 not_allowed, a dark route is 404). Copy is lowercase, plain, and says "page" where the code says "record".
//
//   deleting     POST /api/admin/deletes: a dry run first (always with remove_references: true, so the sheet can say what goes with the page and
//                which other pages lose a link), then the same body under an Idempotency-Key. A sign-in older than 15 minutes is 401 step_up_required.
//   duplicates   GET /api/admin/duplicates: pairs the matcher thinks may be one person. Read-only: merging is done in Gramps on the desktop.
import { newIdempotencyKey } from "./editor-save.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

/** The classes an admin may delete on the website (Q2-15). A repository or a note is not on the list. */
export const DELETE_CLASSES = Object.freeze(["Person", "Family", "Event", "Place", "Source", "Citation", "Media"]);

export const NOUN = Object.freeze({ Person: "person", Family: "family", Event: "event", Place: "place", Source: "source", Citation: "source citation", Media: "photo or file" });

export const COPY = Object.freeze({
  sectionTitle: "delete",
  lead: "deleting is for good. you'll see everything that would go, and everything that would lose a link, before anything happens.",
  button: "delete this page…",
  buttonTitle: (cls) => `delete this ${NOUN[cls] || "page"}…`,
  sheetTitle: (cls) => `delete this ${NOUN[cls] || "page"}?`,
  planning: "checking what this would touch",
  goesH: "will be deleted",
  linksH: "will lose a link to it",
  linksNote: "these pages stay. only the link to what you're deleting is taken out.",
  idsNote: (ids) => `${ids.length === 1 ? "the id" : "the ids"} ${ids.join(", ")} can never be used again.`,
  forGood: "this can't be undone from the website.",
  budgetLine: (b) => `${b.used} deleted in the last day. a day's limit is ${b.limit}.`,
  overBudget: "too many things were deleted in the last 24 hours to delete more here. use gramps on the desktop, or try again tomorrow.",
  confirm: "delete for good",
  retryConfirm: "try the delete again",
  cancel: "keep it",
  deleting: "deleting",
  done: "deleted.",
  doneGone: "that page is gone.",
  home: "back to the family",
  signIn: "sign in",
  signInAgain: "you'll be asked to sign in again to confirm.",
  why: Object.freeze({
    target: "",
    source_citation: "a source citation that belongs only to this source",
    emptied_family: "a family left with nobody in it",
    exclusive_event: "an event that only this page used",
  }),
  tab: "possible duplicates",
  dupLead: "people who may be in the tree twice. this list only shows them: nothing is changed or marked here. merge the ones that are the same person in gramps on the desktop.",
  dupEmpty: "no possible duplicates right now.",
  dupLoading: "looking for possible duplicates",
  dupFailed: "the list didn't load. try again in a moment.",
  retry: "try again",
  more: "show more",
  and: "and",
  open: "open page",
  scoreSame: "very close names",
  scoreClose: "close names",
});

/** True when the viewer may see the delete panel: an admin, the flag on, a class on the list. */
export const canDelete = ({ cls, viewer, flags } = {}) => Boolean(viewer) && viewer.admin === true && Boolean(flags) && flags.adminDelete === true && DELETE_CLASSES.includes(cls);

/** True when the viewer may see the duplicates tab: an admin and the flag on. */
export const canSeeDuplicates = ({ admin, flags } = {}) => admin === true && Boolean(flags) && flags.adminDelete === true;

/** The request body. `version` is the version the editor loaded; the dry run and the delete send the same body, so the receipt matches. */
export function deleteBody({ key, version, dryRun = false }) {
  return { targets: [key], base_versions: { [key]: version }, remove_references: true, ...(dryRun ? { dry_run: true } : {}) };
}

export { newIdempotencyKey };

const label = (item) => {
  const name = str(item.label);
  const id = str(item.gramps_id);
  const noun = NOUN[item.class] || "page";
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  return id ? `${noun} ${id}` : noun;
};

/** The dry run's answer as the sheet shows it: { deletes: [{text, key}], updates: [{text, key}], ids: [..], budget: {text, over}|null }. */
export function planView(body) {
  const plan = isObj(body) && isObj(body.plan) ? body.plan : {};
  const deletes = arr(plan.delete).map((d) => {
    const why = COPY.why[d.why] || "";
    return { key: str(d.key), text: why ? `${label(d)}: ${why}` : label(d) };
  });
  const updates = arr(plan.update).map((u) => ({ key: str(u.key), text: label(u) }));
  const ids = arr(plan.retired_ids).filter((x) => typeof x === "string" && x);
  const b = isObj(body) && isObj(body.budget) ? body.budget : null;
  const budget = b ? { over: b.over === true, text: b.over === true ? COPY.overBudget : COPY.budgetLine(b) } : null;
  return { deletes, updates, ids, budget };
}

/**
 * The words for every error the two routes can answer: { text, signIn, stepUp, reload, retry }. `retry` is true when the same request may be sent
 * again as it is (the answer never came back, or the site failed): the sheet keeps its confirm button and re-sends under the SAME Idempotency-Key, so a
 * delete that did commit replays its receipt instead of failing on a stale version.
 */
export function problemFor(err) {
  const status = isObj(err) || err instanceof Error ? err.status : 0;
  const code = isObj(err) || err instanceof Error ? err.code : "";
  const base = { signIn: false, stepUp: false, reload: false, retry: false };
  if (code === "step_up_required" || status === 401) return { ...base, text: "sign in again to confirm. deleting needs a sign-in from the last 15 minutes.", signIn: true, stepUp: code === "step_up_required" };
  if (code === "delete_budget") return { ...base, text: COPY.overBudget };
  if (code === "version_conflict") return { ...base, text: "this page changed after you opened it. reload the page and look again before deleting.", reload: true };
  if (code === "still_referenced") return { ...base, text: "some pages still point at this and can't be cleaned up from here. use gramps on the desktop." };
  if (code === "cannot_delete_account_person") return { ...base, text: "this person signs in to the site, so they can't be deleted here. unlink the account first, then delete in gramps on the desktop." };
  if (code === "too_large") return { ...base, text: "this would touch too many pages at once (more than 24). use gramps on the desktop." };
  if (code === "not_allowed" || status === 403) return { ...base, text: "only an admin can delete things on the website." };
  if (status === 404) return { ...base, text: "that page is already gone." };
  if (code === "idempotency_mismatch") return { ...base, text: "that didn't go through. reload the page and try again.", reload: true };
  if (status === 0) return { ...base, text: "that didn't reach the site. check your connection and try again.", retry: true };
  if (status === 400 || status === 422) return { ...base, text: "the website won't allow that change." };
  return { ...base, text: "that didn't work. try again in a moment.", retry: !status || status >= 500 };
}

/** One queue row: the two people and how close the match is. `href` is the person's page. */
export function pairRow(item) {
  const side = (p) => {
    const id = str(p && p.gramps_id);
    const life = str(p && p.lifespan);
    const name = str(p && p.displayName) || id || "someone";
    const detail = [id, life].filter(Boolean).join(", ");
    return { key: str(p && p.key), id, name, life, href: id ? `/person/?id=${encodeURIComponent(id)}` : null, text: detail ? `${name} (${detail})` : name };
  };
  const a = side(item && item.a);
  const b = side(item && item.b);
  return { key: `${a.key}|${b.key}`, a, b, strength: Number(item && item.score) >= 4 ? COPY.scoreSame : COPY.scoreClose };
}
