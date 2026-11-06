// HFY-TSK-388-0G (plan HFY-PLN-004, pass 1): the tag ports of the HFY MediaSource (BRD 5.1/5.2; D-04, D-05, D-06, D-09, D-13, P4-R24/25, P4-R37).
//
// READS. getTags/readTags use GET /api/media/:id, the same reply the Media Browser detail uses (api/src/media-browser.js): tags {personId, mediaId, rect, index,
//   state, person: {displayName}} and `version`. The server names every tagged person, living or deceased (P4-R37), applies the
//   person-gallery visibility rules (D-37) and reads rects Gramps-exact. The shipped editor reads the person-gallery JSON baked into the page instead; that JSON has
//   no `index` or `version`, which the kit's addressing (D-04) needs, so the Media Browser reply is the source here.
// WRITES. putTags translates every kit op into the shipped editor's EditOps (hfy-tag-wire.js) against the tagged person's edit bundle
//   (GET /api/edit/Person/:id) and posts them as POST /api/changes with an Idempotency-Key. The server decides: the viewer's own record saves now, another person's
//   becomes a proposal (D-09), so the result lists a proposal under `proposed` with state "pending-proposal". A stale base version, a stale index or rect, or a
//   409 from the server is a conflict in the result, never an overwrite. Ops of one batch share the base version read at the start, run in order, and each re-reads the
//   person's bundle, so a removal sees the earlier ones of its batch (send removals highest index first, as the kit says).
// KNOWN LIMIT (BASELINE row T-9). An add whose MediaRef is byte-identical to one the person already holds writes nothing (the ops engine's add is idempotent): the existing tag
//   is returned under `applied` with its own index and the op is listed in `result.identical`. A second tag with a different rect appends as D-04 says.
// CONSENT. HFY policy is permissive (D-13): everyone visible is taggable, hideAll is a no-op, the re-add lock is audit-only. selfUntag removes the member's own MediaRef
//   through the normal remove path with a note, builds the kit's audit record (reversible, carries the server's inverse), sets the (person, media) lock and keeps both
//   in the tag store; undoSelfUntag puts it back.
// PICKER. resolvePeople lists every member the family index lists, living or deceased (P4-R37), the viewer ("you") first, with the small photo URL when the index has one.
import { MediaError } from "@io-kit/media";
import { checkReAdd, lockKey, selfUntag as kitSelfUntag } from "@io-kit/media/consent";
import { authorRect, changesBody, idempotencyKey, normalizeRect, planTagOp } from "./hfy-tag-wire.js";
import { createTagStore } from "./tag-store.js";

export const SELF_UNTAG_NOTE = "Removed from this photo by the tagged person.";

const enc = encodeURIComponent;
const safeRect = (raw) => { try { return normalizeRect(raw === undefined ? null : raw); } catch { return null; } };

function mapError(e) {
  if (e instanceof MediaError && e.code !== "REQUEST_FAILED") return e;
  if (e && e.status === 404) return new MediaError("NOT_FOUND", "not found");
  if (e && e.status === 403) return new MediaError("FORBIDDEN", "not allowed");
  return e;
}
const isConflict = (e) => Boolean(e) && (e.status === 409 || e.serverCode === "version_conflict");

/** The default people source: the family index the shipped picker searches (lib/people-corpus.js), loaded when first used. */
export const corpusPeople = {
  async search(q, limit) { const { findTaggablePeople } = await import("./people-corpus.js"); return findTaggablePeople(q, limit); },
  async byId(id) {
    const { personNames } = await import("./people-corpus.js");
    const name = (await personNames()).get(id);
    return name ? { id, title: name, photo: "" } : null;
  },
};

/** `createTagPorts({ request, viewer, store, people, now })` -> the tag half of a kit MediaSource plus the HFY extensions (readTags, receipts, audit, undo). */
export function createTagPorts({ request, viewer, store = createTagStore(), people = corpusPeople, now = () => new Date().toISOString() }) {
  const handles = new Map();
  const auditLog = [];
  let locks = null;
  let selfUntags = null;

  const wrap = async (fn) => { try { return await fn(); } catch (e) { throw mapError(e); } };
  const record = async (entry) => { auditLog.push({ ...entry, at: now() }); try { await store.set("audit", auditLog.slice(-200)); } catch { /* audit stays in memory */ } };
  const getLocks = async () => (locks ??= new Set((await store.get("locks")) || []));
  const saveLocks = async () => store.set("locks", [...locks]);
  const getUntags = async () => (selfUntags ??= (await store.get("selfUntags")) || []);
  const saveUntags = async () => store.set("selfUntags", selfUntags.slice(-50));

  const readDetail = (mediaId) => wrap(() => request("GET", `/media/${enc(mediaId)}`));
  const bundleOf = (personId) => wrap(() => request("GET", `/edit/Person/${enc(personId)}`));
  async function handleOf(mediaId) {
    if (!handles.has(mediaId)) {
      const b = await wrap(() => request("GET", `/edit/Media/${enc(mediaId)}`));
      if (!b || !b.obj || typeof b.obj.handle !== "string") throw new MediaError("NOT_FOUND", "no such media");
      handles.set(mediaId, b.obj.handle);
    }
    return handles.get(mediaId);
  }

  /** The tags of one media with the names to show for them and the version to write against. Every tagged person is named by the server (P4-R37). */
  async function readTags(mediaId) {
    const d = await readDetail(mediaId);
    const names = {};
    const tags = (Array.isArray(d && d.tags) ? d.tags : []).map((t) => {
      if (!names[t.personId]) names[t.personId] = { displayName: (t.person && t.person.displayName) || t.personId };
      return { personId: t.personId, mediaId, rect: safeRect(t.rect), index: t.index, state: t.state === "pending-proposal" ? "pending-proposal" : "applied" };
    });
    return { tags, names, version: d && d.version };
  }

  async function post(bundle, planned, note, keyParts) {
    return wrap(() => request("POST", "/changes", changesBody({ bundle, ops: planned.ops, note }), { "Idempotency-Key": idempotencyKey([bundle.key, bundle.version, planned.ops, keyParts]) }));
  }

  async function putTags(ops) {
    const result = { applied: [], proposed: [], conflicts: [], receipts: [], identical: [] };
    for (const op of ops) {
      if (op.op === "remove") continue;
      try { authorRect(op.op === "add" ? op.rect : op.to); } catch (e) { throw new MediaError("INVALID_RECT", e.message); }
    }
    const actor = await viewer();
    const versions = new Map();
    const baseOf = async (mediaId) => { if (!versions.has(mediaId)) versions.set(mediaId, (await readDetail(mediaId)).version); return versions.get(mediaId); };
    for (const op of ops) {
      if (op.baseVersion !== (await baseOf(op.mediaId))) { result.conflicts.push(op); continue; }
      if (!(await consent.isTaggable(op.personId))) throw new MediaError("NOT_TAGGABLE", "not taggable");
      if (op.op === "add" && checkReAdd(await getLocks(), op.personId, op.mediaId, actor || "", "audit-only") === "audit-only") {
        await record({ action: "re-add-lock-audit", actor: actor || "", personId: op.personId, mediaId: op.mediaId });
      }
      const handle = await handleOf(op.mediaId);
      const bundle = await bundleOf(op.personId);
      const planned = planTagOp(bundle, handle, op);
      if (!planned.ok) {
        if (planned.reason === "stale") result.conflicts.push(op);
        else if (planned.reason === "identical") { result.identical.push(op); result.applied.push({ personId: op.personId, mediaId: op.mediaId, rect: planned.rect, index: planned.index, state: "applied" }); } // nothing to write: see planTagOp
        else if (planned.reason === "nochange") result.applied.push({ personId: op.personId, mediaId: op.mediaId, rect: op.to, index: op.index, state: "applied" });
        else throw new MediaError("INVALID_RECT", "that rect cannot be stored");
        continue;
      }
      let res;
      try { res = await post(bundle, planned, "", [op.op, op.mediaId, op.index, op.rect, op.to]); } catch (e) {
        if (isConflict(e)) { result.conflicts.push(op); continue; }
        throw e;
      }
      const state = res && res.proposal ? "pending-proposal" : "applied";
      const tag = { personId: op.personId, mediaId: op.mediaId, rect: planned.rect, index: planned.index, state };
      if (state === "pending-proposal") result.proposed.push(tag);
      else if (op.op !== "remove") result.applied.push(tag);
      result.receipts.push({ op, state, target: bundle.key, ...(res && res.proposal ? { proposal: res.proposal.id } : {}), ...(res && res.applied && res.applied.undo ? { undo: res.applied.undo } : {}) });
      if (state === "applied") await record({ action: `tag-${op.op}`, actor: actor || "", personId: op.personId, mediaId: op.mediaId });
    }
    return result;
  }

  /** Undo one change the server applied now (the inverse it handed back, the shipped editor's undo). */
  async function undoReceipt(receipt) {
    if (!receipt || !receipt.undo || !receipt.target) throw new MediaError("NOT_FOUND", "nothing to undo");
    return wrap(() => request("POST", "/changes", { target: receipt.target, base_versions: receipt.undo.base_versions, ops: receipt.undo.ops }, { "Idempotency-Key": idempotencyKey(["undo", receipt.target, receipt.undo.base_versions, receipt.undo.ops]) }));
  }

  /** Every member the family index lists (private people are not in it), no filter on living status; the viewer ("you") comes first, whether or not the search found them. */
  async function resolvePeople(q, opts = {}) {
    const limit = opts.limit ?? 10;
    const actor = await viewer();
    const needle = String(q || "").trim().toLowerCase();
    const rows = await people.search(String(q || ""), limit * 3);
    const out = [];
    for (const r of rows || []) out.push({ personId: r.id, displayName: r.title, ...(r.photo ? { thumbUrl: r.photo } : {}) });
    const at = actor ? out.findIndex((p) => p.personId === actor) : -1;
    if (at > 0) out.unshift(...out.splice(at, 1));
    else if (actor && at < 0) {
      const me = await people.byId(actor);
      if (me && (needle === "" || String(me.title).toLowerCase().includes(needle))) out.unshift({ personId: actor, displayName: me.title, ...(me.photo ? { thumbUrl: me.photo } : {}) });
    }
    return out.slice(0, limit);
  }

  const consent = {
    isTaggable: async () => true, // D-13: every visible person is taggable
    async selfUntag(personId, mediaId, index) {
      const actor = await viewer();
      if (!actor || actor !== personId) throw new MediaError("FORBIDDEN", "only the tagged person may remove their own tag");
      const handle = await handleOf(mediaId);
      const bundle = await bundleOf(personId);
      const list = Array.isArray(bundle.obj && bundle.obj.media_list) ? bundle.obj.media_list : [];
      const el = list[index];
      if (!el || el.ref !== handle) throw new MediaError("NOT_FOUND", "no such tag");
      const book = { lists: { [personId]: list.map((r) => ({ mediaId: r && r.ref === handle ? mediaId : String(r && r.ref), rect: safeRect(r && r.rect) })) }, versions: {} };
      const kit = kitSelfUntag(book, { personId, mediaId, index, actor }, { now });
      const planned = planTagOp(bundle, handle, { op: "remove", personId, mediaId, index, rect: safeRect(el.rect), baseVersion: "" });
      if (!planned.ok) throw new MediaError("NOT_FOUND", "no such tag");
      const res = await post(bundle, planned, SELF_UNTAG_NOTE, ["self-untag"]);
      if (res && res.proposal) throw new MediaError("FORBIDDEN", "the removal was not saved now");
      const entry = { ...kit.audit, ...(res && res.applied && res.applied.undo ? { undo: res.applied.undo, target: bundle.key } : {}) };
      (await getUntags()).push(entry); await saveUntags();
      (await getLocks()).add(kit.audit.lock); await saveLocks();
      await record({ action: "self-untag", actor, personId, mediaId });
    },
    async hideAll() { /* HFY policy (BRD 5.2): a no-op */ },
    datamapClass: { name: "photo-tag", verbs: ["view", "export", "correct", "delete"] },
  };

  /** Put a self-untagged tag back: the server's inverse when it still applies, else a fresh add of the same rect (at the end). The re-add lock is released. */
  async function undoSelfUntag(entry) {
    const actor = await viewer();
    if (!entry || actor !== entry.personId) throw new MediaError("FORBIDDEN", "only the tagged person may restore their tag");
    let done = false;
    if (entry.undo && entry.target) {
      try { await undoReceipt(entry); done = true; } catch (e) { if (!(e && e.status >= 400)) throw e; }
    }
    if (!done) {
      const bundle = await bundleOf(entry.personId);
      const planned = planTagOp(bundle, await handleOf(entry.mediaId), { op: "add", personId: entry.personId, mediaId: entry.mediaId, rect: entry.rect, baseVersion: "" });
      if (!planned.ok) throw new MediaError("INVALID_RECT", "that rect cannot be stored");
      await post(bundle, planned, "", ["undo-self-untag"]);
    }
    (await getLocks()).delete(lockKey(entry.personId, entry.mediaId)); await saveLocks();
    const list = await getUntags();
    const at = list.findIndex((x) => x.personId === entry.personId && x.mediaId === entry.mediaId && x.at === entry.at);
    if (at >= 0) { list.splice(at, 1); await saveUntags(); }
    await record({ action: "self-untag-undo", actor, personId: entry.personId, mediaId: entry.mediaId });
  }

  return {
    getTags: async (mediaId) => (await readTags(mediaId)).tags,
    putTags,
    resolvePeople,
    consent,
    readTags,
    undoReceipt,
    undoSelfUntag,
    selfUntags: async () => (await getUntags()).map((x) => ({ ...x })),
    auditLog: () => auditLog.map((x) => ({ ...x })),
  };
}
