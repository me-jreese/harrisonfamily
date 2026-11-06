// Moderation core (HFY-TSK-258, hfy-moderation-api-core; social.md section 11, BRD2 D2-19, R-32).
//
//   State lives inline on the item (post.moderation, comment.moderation, attachments[i].moderation) for cheap list filtering and is mirrored
//   in one MOD# item per target, which feeds the admin queue and the records overlay:
//     PK MOD#<kind>:<id>   SK META   GSI1 MODQ#open | MODQ#closed / <at>#<kind>:<id>
//   The inline state, the MOD# item, the AUDIT# entry (op "moderate", with the private reason) and the contribution event's hideOps all commit in
//   ONE transaction, through content.js commit() and comments.js commit(): this file only builds the pieces and the two routes.
//
//   POST /api/moderation  {target, action, note?, hide?, version?, reason?}   hide | unhide | request_changes | ask, for post, comment and photo targets (admins only)
//   GET  /api/moderation  ?state=open|closed&cursor=&limit=     the queue, newest first (admins only)
//
// Queue order: GET state=open is newest-opened first; GET state=closed is newest-resolved first (closedItem rewrites GSI1SK to resolved_at).
//
// request_changes and ask (hfy-moderation-ask-api): a note of 1 to 1000 characters, run through the R-18 guard by the source (422 contact_info, nothing
// stored), kept on the inline state and on the MOD# item and delivered as the notice's `detail`. `ask` keeps the item visible unless `hide:true`.
// An effective author edit of an item in changes_requested or question state closes the state, the MOD# item and the hide inside the edit's own
// transaction (content.js update, comments.js edit) and tells the asking admin (onModerationResolved -> moderation_resolved).
//
// Record targets (HFY-TSK-216, hfy-moderation-record-targets; BRD2 D2-19, R2-25): note {kind, handle}, mediaref {kind, person, media} and media {kind, handle}.
//   They need moderationRecordsV1 as well as moderationV1: while it is off they answer 422 unsupported_target, whatever their shape. A record has no inline
//   state: the MOD#note:<h>, MOD#mediaref:<person>:<media> or MOD#media:<h> item IS the overlay. The renderer (lambda/hfy-sync-render, overlay.py), the
//   records API, the edit bundle and MCP hfy_records_get read it (records/mod-overlay.js), so the item, its AUDIT# entry and a `marker` op (origin
//   "moderation", through applyBatch, which wakes the renderer) commit in ONE transaction. The notice goes to the page owner when they are a member,
//   otherwise to io (the gramps-owner group).
import { auditEntry, canView, redactModeration } from "@io-kit/content";
import { HttpError } from "./http.js";
import { emptyOps } from "./contrib.js";
import { pointer } from "./guard.js";
import { TxnCancelled, auditItem } from "./txn.js";
import { applyBatch } from "./sync/apply.js";
import { backrefs, get as getRecord } from "./records/index.js";

export const MODQ_OPEN = "MODQ#open";
export const MODQ_CLOSED = "MODQ#closed";
/** The kinds the route moderates now. */
export const CONTENT_KINDS = Object.freeze(["post", "comment", "photo"]);
/** Record kinds (records domain): the route answers 422 unsupported_target while moderationRecordsV1 is off. */
export const RECORD_KINDS = Object.freeze(["note", "mediaref", "media"]);
export const ACTIONS = Object.freeze(["hide", "unhide", "request_changes", "ask"]);
/** The actions that carry the admin's note to the author. */
export const NOTE_ACTIONS = Object.freeze(["request_changes", "ask"]);
export const MAX_REASON = 200;
export const MAX_NOTE = 1000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ULID_RE = new RegExp(`^${ULID}$`);
const THREAD_RE = /^(person:[A-Za-z0-9_.-]{1,64}|post:[0-9A-HJKMNP-TV-Z]{26}|proposal:[0-9A-HJKMNP-TV-Z]{26})$/;
const ATT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The flag that opens the record targets (review DL-17): they wait for the cutover and hfy-social-flip-2. */
export const RECORDS_FLAG = "moderationRecordsV1";
const QUEUE_SK_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[\w:/#.-]{1,300}$/;

// ---- the one visibility rule (social.md 11.3) -------------------------------------------------------------------------------------------------

/** Does `viewer` hold the admin role? Takes the API actor ({admin}) and the comments Principal ({roles}). */
export const isAdminViewer = (viewer) => viewer != null && (viewer.admin === true || (Array.isArray(viewer.roles) && viewer.roles.includes("admin")));

/** `moderationVisible(item, viewer) = !item.moderation?.hidden || viewer.id === item.author.id || viewer.admin`. */
export const moderationVisible = (item, viewer) =>
  item?.moderation?.hidden !== true || (viewer != null && (viewer.id === item?.author?.id || isAdminViewer(viewer)));

/** May `viewer` see the moderation fields of `item` (the author and admins; nobody else)? */
export const moderationPrivileged = (item, viewer) => viewer != null && (viewer.id === item?.author?.id || isAdminViewer(viewer));

/**
 * Is a stored comment hidden from everyone but its author and admins: moderation hides it, or it is a photo-only comment (no text) whose
 * every photo a moderator hid, which would otherwise reach other viewers as an empty comment (the rule the kit's canView applies to posts).
 */
export const commentHidden = (c) =>
  c?.moderation?.hidden === true ||
  ((c?.body ?? "").trim() === "" && Array.isArray(c?.attachments) && c.attachments.length > 0 && c.attachments.every((a) => a?.moderation?.hidden === true));

/** A copy of `attachments` without the photos a moderator hid (what everyone but the author and admins receives). */
export const shownAttachments = (attachments) => (Array.isArray(attachments) ? attachments.filter((a) => a?.moderation?.hidden !== true) : []);

/**
 * The archive tier of On this day (and any other reader of past posts): the post as `viewer` may see it, or null. It passes the kit's canView
 * (draft, withdrawn and moderation-hidden posts, and a photo-only post whose every photo is hidden), then drops the moderation fields and hidden
 * photos for everyone but the author and admins. GET /api/onthisday (surf-onthisday-api) calls this for each candidate post.
 */
export function archiveView(post, viewer) {
  if (!post || !canView(post, viewer)) return null;
  return redactModeration(post, viewer);
}

// ---- targets and MOD# items -------------------------------------------------------------------------------------------------------------------

/**
 * The target key `<kind>:<id>` of a validated target. A comment id is `<thread>/<ulid>`; a photo id is `<parent kind>:<parent id>#<attachment id>`.
 * The caller validates the shape first (parseTarget).
 */
export function targetKey(t) {
  if (t.kind === "post") return `post:${t.id}`;
  if (t.kind === "comment") return `comment:${t.thread}/${t.id}`;
  if (t.kind === "note" || t.kind === "media") return `${t.kind}:${t.handle}`;
  if (t.kind === "mediaref") return `mediaref:${t.person}:${t.media}`;
  if (t.kind === "photo") return `photo:${t.parent.kind}:${t.parent.kind === "comment" ? `${t.parent.thread}/${t.parent.id}` : t.parent.id}#${t.attachment}`;
  throw new TypeError(`moderation: unknown target kind ${t.kind}`);
}
export const modKeys = (key) => ({ PK: `MOD#${key}`, SK: "META" });

const POST_PHOTO_RE = new RegExp(`/uploads/posts/(${ULID})/`);
/** A post photo has no id of its own: its upload's ulid (the path /uploads/posts/<ulid>/<name>) names it, and survives an edit that reorders the photos. */
export const postAttachmentId = (a) => POST_PHOTO_RE.exec(String(a?.url ?? ""))?.[1];

const bad = (field, message) => new HttpError(400, "validation", message, { fields: [{ field, code: "invalid" }] });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The request's target, shape-checked: {kind:"post", id} | {kind:"comment", id, thread} | {kind:"photo", parent:{kind:"post", id} | {kind:"comment", id, thread}, attachment}
 * plus the record kinds {kind:"note", handle} | {kind:"media", handle} | {kind:"mediaref", person, media}. With `records` false (moderationRecordsV1 off) a record kind
 * is returned as {kind} unchecked, for the route to refuse with 422 unsupported_target. Throws 400 validation.
 */
export function parseTarget(raw, { records = false } = {}) {
  if (!isObj(raw)) throw bad("target", "target must be an object");
  const { kind } = raw;
  if (RECORD_KINDS.includes(kind)) {
    if (!records) return { kind };
    const handle = (v, field) => {
      if (typeof v !== "string" || !HANDLE_RE.test(v)) throw bad(field, `${field} must be a record handle`);
      return v;
    };
    if (kind === "mediaref") return { kind, person: handle(raw.person, "target.person"), media: handle(raw.media, "target.media") };
    return { kind, handle: handle(raw.handle, "target.handle") };
  }
  if (!CONTENT_KINDS.includes(kind)) throw bad("target", "target.kind must be post, comment or photo");
  const id = (v, field) => {
    if (typeof v !== "string" || !ULID_RE.test(v)) throw bad(field, `${field} must be an id`);
    return v;
  };
  const thread = (v, field) => {
    if (typeof v !== "string" || !THREAD_RE.test(v)) throw bad(field, `${field} must be person:<gramps_id>, post:<ulid> or proposal:<ulid>`);
    return v;
  };
  if (kind === "post") return { kind, id: id(raw.id, "target.id") };
  if (kind === "comment") return { kind, id: id(raw.id, "target.id"), thread: thread(raw.thread, "target.thread") };
  const p = raw.parent;
  if (!isObj(p) || (p.kind !== "post" && p.kind !== "comment")) throw bad("target.parent", "target.parent.kind must be post or comment");
  const parent = p.kind === "post" ? { kind: "post", id: id(p.id, "target.parent.id") } : { kind: "comment", id: id(p.id, "target.parent.id"), thread: thread(p.thread, "target.parent.thread") };
  const a = typeof raw.attachment === "number" ? String(raw.attachment) : raw.attachment;
  if (typeof a !== "string" || !ATT_RE.test(a)) throw bad("target.attachment", "target.attachment must be an attachment id");
  return { kind, parent, attachment: a };
}

/**
 * The route body's action, note, hide flag, reason and version, shape-checked. `note` is required (1..1000 after trimming) for request_changes and ask and
 * refused for hide and unhide (null, absent and "" count as absent); `hide` is a boolean that only `ask` reads (request_changes always hides, a plain hide hides);
 * `reason` is optional and private (audit only). The contact-info guard on the note runs in the source, which stores nothing when it refuses.
 */
export function parseAction(body) {
  const action = body?.action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) throw bad("action", "action must be hide, unhide, request_changes or ask");
  let note;
  const given = body.note !== undefined && body.note !== null && body.note !== "";
  if (NOTE_ACTIONS.includes(action)) {
    note = typeof body.note === "string" ? body.note.trim() : "";
    if (note === "") throw bad("note", "a note is required");
    if (note.length > MAX_NOTE) throw bad("note", `note must be at most ${MAX_NOTE} characters`);
  } else if (given) throw bad("note", "a note goes with request_changes or ask");
  if (body.hide !== undefined && body.hide !== null && typeof body.hide !== "boolean") throw bad("hide", "hide must be true or false");
  let reason;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.trim().length > MAX_REASON) throw bad("reason", `reason must be text of at most ${MAX_REASON} characters`);
    reason = body.reason.trim() || undefined;
  }
  if (body.version !== undefined && (typeof body.version !== "string" || body.version === "" || body.version.length > 64)) throw bad("version", "version must be the updated_at or edited_at you saw");
  return {
    action, ...(note !== undefined ? { note } : {}), ...(action === "ask" ? { hide: body.hide === true } : {}),
    ...(reason !== undefined ? { reason } : {}), ...(body.version !== undefined ? { version: body.version } : {}),
  };
}

/**
 * The action of a source-level moderate(), checked: `{action, note?, hide, reason?}`. `fail(field, message)` throws the host's own typed error
 * (ContentError or CommentError, both `validation`). A note is required for request_changes and ask (1..1000 after trimming); the private
 * reason is at most 200 characters and goes to the audit entry only.
 */
export function normalizeModerate(input, fail) {
  const action = input?.action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) fail("action", "action must be hide, unhide, request_changes or ask");
  let note;
  if (action === "request_changes" || action === "ask") {
    note = typeof input.note === "string" ? input.note.trim() : "";
    if (note === "") fail("note", "a note is required");
    if (note.length > MAX_NOTE) fail("note", `note exceeds ${MAX_NOTE} characters`);
  }
  let reason;
  if (input.reason !== undefined) {
    const r = typeof input.reason === "string" ? input.reason.trim() : null;
    if (r === null || r.length > MAX_REASON) fail("reason", `reason must be text of at most ${MAX_REASON} characters`);
    reason = r === "" ? undefined : r;
  }
  return { action, ...(note !== undefined ? { note } : {}), hide: input.hide === true, ...(reason !== undefined ? { reason } : {}) };
}

/** The MOD# item of a target. `prior` is the item it replaces (its `version` is bumped), or undefined. */
export function modItem({ target, author, state, hidden, by, at, note, href, prior }) {
  const key = targetKey(target);
  return {
    ...modKeys(key),
    GSI1PK: MODQ_OPEN,
    GSI1SK: `${at}#${key}`,
    entity: "mod",
    target,
    author_id: author.id,
    author: { id: author.id, ...(typeof author.label === "string" ? { label: author.label } : {}) },
    state,
    hidden,
    by: { id: by.id, ...(typeof by.label === "string" ? { label: by.label } : {}) },
    at,
    ...(note !== undefined ? { note } : {}),
    ...(typeof href === "string" ? { href } : {}),
    open: true,
    version: (prior?.version ?? 0) + 1,
  };
}

/**
 * The same item closed: not hidden, queued under MODQ#closed, with who closed it (an admin's id, or "author" for an author's edit or delete).
 * The closed queue is ordered by when the item was resolved (GSI1SK = `<resolved_at>#<key>`), so the newest resolution comes first; the open
 * queue keeps the time the item was opened.
 */
export function closedItem(prior, { resolvedBy, at }) {
  return { ...prior, GSI1PK: MODQ_CLOSED, GSI1SK: `${at}#${prior.PK.slice("MOD#".length)}`, open: false, hidden: false, resolved_by: resolvedBy, resolved_at: at, version: (prior.version ?? 0) + 1 };
}

/** One MOD# item as it is stored now (consistent read), or undefined. */
export async function readMod({ ddb, cmds, table }, key) {
  const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: modKeys(key), ConsistentRead: true }));
  return r.Item;
}

/** The Put of `item` over `prior`: it must still be the version that was read (or absent), else the transaction cancels (409). */
const replace = (item, prior) => ({
  item,
  ...(prior ? { condition: "#v = :pv", names: { "#v": "version" }, values: { ":pv": prior.version } } : { condition: "attribute_not_exists(PK)" }),
});

/** A transact() fragment that opens (or replaces) the MOD# item of `target`. */
export async function openModOps(ctx, { target, author, state, hidden, by, at, note, href }) {
  const prior = await readMod(ctx, targetKey(target));
  return { ...emptyOps(), puts: [replace(modItem({ target, author, state, hidden, by, at, note, href, prior }), prior)] };
}

/** A fragment that closes the open MOD# items of `keys`; a key with no open item adds nothing. */
export async function closeModOps(ctx, keys, { resolvedBy, at }) {
  const out = emptyOps();
  for (const key of new Set(keys)) {
    const prior = await readMod(ctx, key);
    if (prior && prior.open !== false) out.puts.push(replace(closedItem(prior, { resolvedBy, at }), prior));
  }
  return out;
}

// ---- the queue ---------------------------------------------------------------------------------------------------------------------------

const enc = encodeURIComponent;
export function hrefOf(target) {
  if (RECORD_KINDS.includes(target.kind)) return "/me/review/"; // a record row carries its own `href` (the holder's page); this is only the fallback
  const to = target.kind === "photo" ? target.parent : target;
  const anchor = target.kind === "photo" ? "#photos" : "";
  if (to.kind === "post") return `/posts/?id=${enc(to.id)}${anchor}`;
  const t = to.thread;
  const where = t.startsWith("post:") ? `/posts/?id=${enc(t.slice(5))}` : t.startsWith("person:") ? `/person/?id=${enc(t.slice(7))}` : "/me/review/";
  return `${where}#comment-${to.id}`;
}

/** A queue row: what an admin needs to find the item and what was done. Never the private reason. */
const rowOf = (it) => ({
  target: it.target, state: it.state, hidden: it.hidden === true, by: it.by, at: it.at,
  ...(typeof it.note === "string" ? { note: it.note } : {}),
  open: it.open !== false,
  ...(it.open === false ? { resolved_by: it.resolved_by, resolved_at: it.resolved_at } : {}),
  author: it.author ?? { id: it.author_id }, href: typeof it.href === "string" ? it.href : hrefOf(it.target),
});

function parseLimit(v) {
  if (v === undefined || v === "") return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad("limit", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return n;
}
const encodeCursor = (sk) => Buffer.from(sk, "utf8").toString("base64url");
function decodeCursor(cursor) {
  const sk = typeof cursor === "string" && /^[A-Za-z0-9_-]{1,400}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  if (!QUEUE_SK_RE.test(sk)) throw new HttpError(400, "cursor_invalid", "that cursor is not valid. start again.");
  return sk;
}

// ---- the routes --------------------------------------------------------------------------------------------------------------------------

/** The notice each route action sends the author (notify.js MODERATION_KINDS). */
const NOTICE_KIND = Object.freeze({ hide: "hidden", unhide: "unhidden", request_changes: "request", ask: "question" });
const forbidden = () => new HttpError(403, "forbidden", "only a moderator can do that");
const notFound = () => new HttpError(404, "not_found", "no such item");

/**
 * `content` and `comments` are the request's sources (content.js, comments.js) acting as the admin; `notifier` is notify.js createNotifier
 * (onModeration never throws); `afterCommit(label, fn)` runs a post-commit side effect and logs its failure.
 */
export function createModeration({
  ddb, cmds, table, actor, content, comments, notifier, afterCommit = async (_l, fn) => fn(),
  // Record targets (HFY-TSK-216): `store` is the record-store context (handler.build's `store`), `featureOn(name)` the request's flag read, `guard` the R-18 check,
  // `listMembers()` the member gramps_ids (a Set), `getOwners()` the gramps-owner subjects, `apply` replaces applyBatch (tests), `uid` and `now` as everywhere.
  store, featureOn = async () => false, guard, listMembers, getOwners, apply = applyBatch, uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36), now = () => Date.now(), log = console,
}) {
  const admin = () => {
    if (actor?.admin !== true) throw forbidden();
  };
  const iso = () => new Date(now()).toISOString();

  // ---- record targets ----------------------------------------------------------------------------------------------------------------------

  /** The head of the record a target names (404 when there is none or it is a tombstone), and the {class, handle} the marker op is about. */
  async function locateRecord(target) {
    const need = async (cls, handle) => {
      const head = await getRecord(store, cls, handle);
      if (!head) throw notFound();
      return head;
    };
    if (target.kind === "note") return { head: await need("Note", target.handle), ref: { class: "Note", handle: target.handle } };
    if (target.kind === "media") return { head: await need("Media", target.handle), ref: { class: "Media", handle: target.handle } };
    const head = await need("Person", target.person);
    const list = Array.isArray(head.obj?.media_list) ? head.obj.media_list : [];
    if (!list.some((r) => isObj(r) && r.ref === target.media)) throw notFound();
    return { head, ref: { class: "Person", handle: target.person } };
  }

  /** The Person handles whose page shows the target: the holder of a MediaRef, or the Persons that reach a Note or Media (at most three hops, Event or Family between). */
  async function holders(target) {
    if (target.kind === "mediaref") return [target.person];
    const start = `${target.kind === "note" ? "Note" : "Media"}:${target.handle}`;
    const seen = new Set([start]);
    const persons = [];
    let layer = [start];
    for (let depth = 0; depth < 3 && layer.length > 0 && persons.length < 20; depth++) {
      const next = [];
      for (const key of layer) {
        for (const ref of await backrefs(store, key)) {
          if (seen.has(ref)) continue;
          seen.add(ref);
          if (ref.startsWith("Person:")) persons.push(ref.slice("Person:".length));
          else next.push(ref);
        }
      }
      layer = next;
    }
    return persons;
  }

  /** Who is told, and where the item lives: the page owner when they are a member, otherwise io (the gramps-owner); `gid` is the first holder's gramps_id (the link). */
  async function recipientOf(handles) {
    const members = listMembers ? await listMembers().catch(() => new Set()) : new Set();
    let gid;
    let owner;
    for (const handle of handles) {
      const head = await getRecord(store, "Person", handle);
      const id = typeof head?.obj?.gramps_id === "string" ? head.obj.gramps_id : undefined;
      if (!id) continue;
      gid ??= id;
      if (owner === undefined && members.has(id)) owner = id;
    }
    if (owner !== undefined) return { id: owner, member: true, gid };
    const owners = getOwners ? await getOwners().catch(() => []) : [];
    return { id: owners[0], member: false, gid };
  }

  /** POST /api/moderation for a note, mediaref or media: the MOD# item, its audit entry and a marker op in one applyBatch transaction. */
  async function postRecord(target, { action, note, hide, reason, version }) {
    const key = targetKey(target);
    const { head, ref } = await locateRecord(target);
    if (version !== undefined && version !== String(head.version)) throw new HttpError(409, "conflict", "that record changed since you looked");
    const holderHandles = await holders(target);
    const who = await recipientOf(holderHandles);
    if (who.member && who.id === actor.id) throw new HttpError(400, "self_moderation", "you can't moderate your own item. edit it or ask for it to be removed instead.");
    if (note !== undefined) guard?.("moderation", "moderate", [[pointer("note"), note]]); // R-18: 422 contact_info, nothing stored
    const at = iso();
    const by = { id: actor.id, label: actor.label };
    const prior = await readMod({ ddb, cmds, table }, key);
    const open = prior !== undefined && prior.open !== false;
    let state = null;
    let mod;
    if (action === "unhide") {
      if (open) mod = await closeModOps({ ddb, cmds, table }, [key], { resolvedBy: actor.id, at });
    } else {
      const st = action === "hide" ? "hidden" : action === "request_changes" ? "changes_requested" : "question";
      const hidden = action === "ask" ? hide === true : true;
      if (!(action === "hide" && open && prior.state === "hidden" && prior.hidden === true)) {
        const href = who.gid ? `/person/?id=${encodeURIComponent(who.gid)}#${target.kind === "note" ? "stories" : "photos"}` : undefined;
        mod = await openModOps({ ddb, cmds, table }, { target, author: { id: who.id ?? actor.id }, state: st, hidden, by, at, note, href });
      }
      state = { state: st, hidden, by, at, ...(note !== undefined ? { note } : {}), open: true };
    }
    const before = open ? { state: prior.state, hidden: prior.hidden === true } : null;
    if (mod === undefined) { // a repeated hide, or an unhide of what is not moderated: nothing changes, nothing is sent
      const kept = open ? { state: prior.state, hidden: prior.hidden === true, by: prior.by, at: prior.at, ...(prior.note !== undefined ? { note: prior.note } : {}), open: true } : null;
      return { status: 200, body: { target, moderation: action === "unhide" ? null : kept, item: { class: ref.class, handle: ref.handle, version: head.version } } };
    }
    const entry = auditEntry("moderate", key, actor.id, before, state, at, reason);
    const extra = { ...mod, puts: [...mod.puts, { item: auditItem(entry, uid(), table) }] };
    try {
      await apply(store, { principal: actor.id, origin: "moderation", idempotencyKey: `moderation:${uid()}`, ops: [{ op_id: "1", op: "marker", reason: "moderation", ref }], extra });
    } catch (e) {
      if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
      if (e instanceof TxnCancelled && e.conditionFailed) throw new HttpError(409, "conflict", "that item was moderated by someone else just now. look again.");
      throw e;
    }
    if (who.id !== undefined) {
      await afterCommit("moderation notification", () =>
        notifier.onModeration({
          kind: NOTICE_KIND[action], ...(note !== undefined ? { note } : {}), item: target.kind === "note" ? "story" : "photo", target: key,
          authorId: who.id, by: { id: actor.id, label: actor.label }, navigate: who.gid ? `/person/?id=${encodeURIComponent(who.gid)}#${target.kind === "note" ? "stories" : "photos"}` : "/",
        }));
    } else log.warn?.("moderation: no recipient for a record item (no member owner, no gramps-owner)");
    return { status: 200, body: { target, moderation: state, item: { class: ref.class, handle: ref.handle, version: head.version } } };
  }

  /** The item behind a target as the admin sees it, with its author, version and (for a photo) the photo; 404 when there is none. */
  async function locate(target) {
    if (target.kind === "post" || (target.kind === "photo" && target.parent.kind === "post")) {
      const id = target.kind === "post" ? target.id : target.parent.id;
      const item = await content.get(id).catch((e) => { throw e?.code === "not_found" ? notFound() : e; });
      if (target.kind === "photo" && !(item.attachments ?? []).some((a) => postAttachmentId(a) === target.attachment)) throw notFound();
      return { item, parentKind: "post", version: item.updated_at, itemKind: item.subject ? "story" : "post" };
    }
    const c = target.kind === "comment" ? target : target.parent;
    const item = await comments.get(c.thread, c.id).catch((e) => { throw e?.code === "not_found" ? notFound() : e; });
    if (target.kind === "photo" && !(item.attachments ?? []).some((a) => a.id === target.attachment)) throw notFound();
    return { item, parentKind: "comment", version: item.edited_at ?? item.created_at, itemKind: "comment" };
  }

  /** The moderation state of the target (for "did this change anything" and the response). */
  const stateOf = (target, item) => {
    if (target.kind === "photo") {
      const list = item.attachments ?? [];
      const a = target.parent.kind === "post" ? list.find((x) => postAttachmentId(x) === target.attachment) : list.find((x) => x.id === target.attachment);
      return a?.moderation ?? null;
    }
    return item.moderation ?? null;
  };

  return {
    /** POST /api/moderation. Returns {status, body}. */
    async post(body) {
      admin(); // before anything is read or validated: a member learns nothing about the route
      // A record target needs moderationRecordsV1 as well (DL-17): while it is off, any record kind is 422 unsupported_target before its shape is read.
      const recordsOn = RECORD_KINDS.includes(body?.target?.kind) ? (await featureOn(RECORDS_FLAG)) === true : false;
      const target = parseTarget(body.target, { records: recordsOn });
      const { action, note, hide, reason, version } = parseAction(body);
      if (RECORD_KINDS.includes(target.kind)) {
        if (!recordsOn || store === undefined) throw new HttpError(422, "unsupported_target", "that kind of item can't be moderated yet.");
        return postRecord(target, { action, note, hide, reason, version });
      }
      // A note is for the whole item: a photo is hidden or unhidden, never asked about (the source refuses it too).
      if (target.kind === "photo" && note !== undefined) throw bad("note", "a note is for the whole post or comment, not one photo");
      const found = await locate(target);
      if (found.item.author?.id === actor.id) throw new HttpError(400, "self_moderation", "you can't moderate your own item. withdraw or delete it instead.");
      const before = stateOf(target, found.item);
      // `wrote` flips only when the source's transaction committed a change. A no-op (another admin got there between locate and moderate: a repeated
      // hide, or an unhide of what is not hidden) leaves it false, so this caller sends no duplicate notice for a change it did not make.
      let wrote = false;
      const opts = { ...(version !== undefined ? { version } : {}), onWrite: () => { wrote = true; } };
      const input = { action, ...(note !== undefined ? { note } : {}), ...(hide !== undefined ? { hide } : {}), ...(reason !== undefined ? { reason } : {}) };
      let item;
      if (target.kind === "post") item = await content.moderate(target.id, input, opts);
      else if (target.kind === "comment") item = await comments.moderate(target.thread, target.id, input, opts);
      else if (target.parent.kind === "post") item = await content.moderate(target.parent.id, { ...input, attachment: target.attachment }, opts);
      else item = await comments.moderate(target.parent.thread, target.parent.id, { ...input, attachment: target.attachment }, opts);
      const after = stateOf(target, item);
      if (wrote && JSON.stringify(before) !== JSON.stringify(after)) {
        await afterCommit("moderation notification", () =>
          notifier.onModeration({
            kind: NOTICE_KIND[action], ...(note !== undefined ? { note } : {}), item: target.kind === "photo" ? "photo" : found.itemKind, target: targetKey(target),
            authorId: found.item.author.id, by: { id: actor.id, label: actor.label }, navigate: hrefOf(target),
          }));
      }
      return { status: 200, body: { target, moderation: after, item } };
    },

    /** GET /api/moderation?state=open|closed&cursor=&limit=: {items, cursor}, newest first. */
    async list(query = {}) {
      admin();
      const state = query.state ?? "open";
      if (state !== "open" && state !== "closed") throw bad("state", "state must be open or closed");
      const size = parseLimit(query.limit);
      const after = query.cursor !== undefined && query.cursor !== "" ? decodeCursor(query.cursor) : undefined;
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1",
        KeyConditionExpression: after ? "GSI1PK = :pk AND GSI1SK < :after" : "GSI1PK = :pk",
        ExpressionAttributeValues: after ? { ":pk": state === "open" ? MODQ_OPEN : MODQ_CLOSED, ":after": after } : { ":pk": state === "open" ? MODQ_OPEN : MODQ_CLOSED },
        ScanIndexForward: false, Limit: size + 1,
      }));
      const rows = r.Items ?? [];
      const page = rows.slice(0, size);
      return { items: page.map(rowOf), cursor: rows.length > size && page.length > 0 ? encodeCursor(page[page.length - 1].GSI1SK) : null };
    },
  };
}
