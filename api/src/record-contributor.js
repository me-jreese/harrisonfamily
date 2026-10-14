// HFY-TSK-178 (hfy-record-change-fanout; BRD2 D2-02, D2-17, review DL-18): the ONE registrant of the self_edit and tag contribution ops.
//
// applyBatch() is the single choke point of every genealogy write, so the credit for a member's own save and for a photo tag is added here,
// inside the batch's own TransactWriteItems (the registry's contributor hook, sync/hooks.js), and nowhere else: no route, no caller and no
// afterCommit hook adds a self_edit or tag op. Counters therefore commit with the record change or not at all.
//
//   origin "self"  (a member saving their own record)  -> one self_edit event for person:<principal>, capped at one per record per UTC day
//                                                           by the CONTRIB#<principal>/CAP#self_edit#<subject>#<day> marker (contribOps writes
//                                                           the marker; this module reads it first and skips the credit when it exists)
//                                                           The record is the Person the batch changed. A member's direct writes are limited to their own record
//                                                           and its own-only objects (editing.md 3), so that is normally the principal's own Person, and a batch
//                                                           with no Person change (an own-only Event or Note) is credited to the principal's Person. A batch that
//                                                           does change a different Person is keyed (and capped) on that Person, so the cap is always per edited record.
//   origin self, tag, admin or proposal (a Person-class MediaRef region added, moved or removed) -> one tag event for the commit, weight 1, no cap,
//                                                           credited to the tagger: the batch principal, or for a proposal the proposer (on_behalf_of).
//                                                           Add, move AND remove are all credited because AC3 names "add, change or remove"; only the Person class
//                                                           counts (a crop on an Event or Family media list is not a person tag). A member moving their own avatar
//                                                           crop is a Person-class region change and is credited; that, and add/remove cycling, is accepted: the web
//                                                           origins that can write a region are the signed-in tagger, admin edits and approved proposals, and each
//                                                           commit is audited. A per-(media, person, day) cap would need a marker beside contribOps and is not in the AC.
//   every other origin (desktop, seed, graduation, moderation) -> nothing. A desktop push is maintenance and is never credited (social.md 7.1);
//                                                           a graduation credits its photo's author in its own transaction; a moderation marker
//                                                           changes no record. An admin's approval of a proposal is not credited (the proposer is).
//
// A contributor must be pure (sync/hooks.js): it runs on every attempt of a batch and writes nothing itself. The only I/O here is one
// consistent read of the CAP marker. The event id is derived from the batch id, so a rebuilt item set (a lost seq race) names the same event.
// A failure to read the marker counts the save (the marker Put has no condition, so the worst case is the benign double count the design
// accepts); nothing here may fail a batch for a reason of its own.
import { createHash } from "node:crypto";
import { canonicalJson } from "./records/ops.js";
import { contribOps, mergeOps, selfEditCapped } from "./contrib.js";
import { defaultHooks } from "./sync/hooks.js";
import { logSafeError } from "./http.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** The web origins whose commits can be a tag ("from any web origin", AC3), less graduation and moderation, which credit elsewhere or change no record. */
const TAG_ORIGINS = new Set(["self", "tag", "admin", "proposal"]);

/** A ULID that is a pure function of (time, seed): 10 characters of time, then 16 characters from the first 80 bits of sha256(seed). */
export function deriveUlid(atMs, seed) {
  let t = atMs;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = createHash("sha256").update(seed).digest();
  let bits = 0n;
  for (let i = 0; i < 10; i += 1) bits = (bits << 8n) | BigInt(bytes[i]);
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

const isRegion = (ref) => ref !== null && typeof ref === "object" && Array.isArray(ref.rect) && ref.rect.length === 4;
const mediaList = (obj) => (obj !== null && typeof obj === "object" && Array.isArray(obj.media_list) ? obj.media_list : []);

/**
 * The person-region MediaRefs a change adds, moves or removes: the elements of the Person's before and after media_list that the other side lacks,
 * compared as canonical JSON. A MediaRef without a region (a photo attached to the page) is not a tag, and neither is a region on any class but
 * Person. Only a live create or update counts.
 */
export function tagChanges(change) {
  if (!change || change.class !== "Person" || (change.op !== "create" && change.op !== "update")) return [];
  const key = (e) => canonicalJson(e);
  const before = mediaList(change.before).map((e) => [key(e), e]);
  const after = mediaList(change.after).map((e) => [key(e), e]);
  const had = new Set(before.map(([k]) => k));
  const has = new Set(after.map(([k]) => k));
  return [...before.filter(([k]) => !has.has(k)), ...after.filter(([k]) => !had.has(k))].map(([, e]) => e).filter(isRegion);
}

/** The gramps_id of the first Person a batch tagged (the tagged person), or undefined. */
function taggedPerson(changes) {
  for (const c of changes) if (tagChanges(c).length > 0 && GID_RE.test(String(c.gramps_id ?? ""))) return c.gramps_id;
  return undefined;
}

/** The gramps_id of the first live Person a batch created or updated (the record that was edited), or undefined. */
function editedPerson(changes) {
  for (const c of changes) if (c.class === "Person" && (c.op === "create" || c.op === "update") && GID_RE.test(String(c.gramps_id ?? ""))) return c.gramps_id;
  return undefined;
}

/**
 * The contributor function: `(batch, origin) => fragment | undefined`. `store` is { ddb, cmds, table }.
 * `batch` is the applyBatch batch { batch_id, origin, principal, at, changes: [{ op, class, handle, gramps_id, before, after, ... }] }.
 */
export function createRecordContributor({ ddb, cmds, table, log = console }) {
  const store = { ddb, cmds, table };
  return async function recordContributor(batch, origin) {
    if (!TAG_ORIGINS.has(origin)) return undefined; // desktop, seed, graduation and moderation never credit here
    const principal = batch?.principal;
    const at = batch?.at;
    const changes = Array.isArray(batch?.changes) ? batch.changes : [];
    if (typeof principal !== "string" || !GID_RE.test(principal) || typeof at !== "string" || !AT_RE.test(at) || changes.length === 0) return undefined;
    const atMs = Date.parse(at);
    if (Number.isNaN(atMs)) return undefined;
    const fragments = [];

    if (origin === "self") {
      const actor = { id: principal };
      const edited = editedPerson(changes) ?? principal; // the record the batch changed; an own-only Event or Note batch has no Person change, so it is the member's own.
      const subject = `person:${edited}`;
      let capped = false;
      try {
        capped = await selfEditCapped(store, { actor, subject, at });
      } catch (e) {
        log.error?.("self_edit cap read failed (counting the save)", logSafeError(e));
      }
      if (!capped) {
        fragments.push(contribOps({ actor, kind: "self_edit", ref: { type: "record", id: edited }, subject, at, id: deriveUlid(atMs, `${batch.batch_id}:self_edit`) }));
      }
    }

    if (changes.some((c) => tagChanges(c).length > 0)) {
      const tagged = taggedPerson(changes);
      // The tagger: a proposal's author when the batch is an approved proposal (the approver is never credited), else whoever made the commit.
      const taggerId = origin === "proposal" && typeof batch.on_behalf_of === "string" && GID_RE.test(batch.on_behalf_of) ? batch.on_behalf_of : principal;
      const actor = { id: taggerId };
      fragments.push(contribOps({
        actor, kind: "tag", ref: { type: "tag", id: batch.batch_id }, ...(tagged ? { subject: `person:${tagged}` } : {}), at, id: deriveUlid(atMs, `${batch.batch_id}:tag`),
      }));
    }
    if (fragments.length === 0) return undefined;
    const { puts, deletes, updates, checks } = mergeOps(...fragments);
    return { puts, deletes, updates, checks };
  };
}

const registrations = new WeakMap(); // hooks registry -> { fn, remove }

/**
 * Registers the contributor on `hooks` (default: the process-wide registry). A registry takes it once: a second call (a module loaded twice,
 * a second container init) returns the first call's remover, because two closures would write the same event twice into one transaction.
 */
export function registerRecordContributor(store, hooks = defaultHooks) {
  const existing = registrations.get(hooks);
  if (existing && hooks.contributors().includes(existing.fn)) return existing.remove;
  const fn = createRecordContributor(store);
  const off = hooks.registerContributor(fn);
  const remove = () => {
    if (registrations.get(hooks)?.fn === fn) registrations.delete(hooks);
    off();
  };
  registrations.set(hooks, { fn, remove });
  return remove;
}
