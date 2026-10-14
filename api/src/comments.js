// CommentSource (@io-kit/comments contract) over the hfy-app table. threadId is the subject: `person:<gramps_id>`, `post:<ulid>` or `proposal:<ulid>`.
//   comment   PK THREAD#<threadId>  SK C#<ulid>           GSI1PK COMMENTS  GSI1SK <ulid>
//   reaction  PK THREAD#<threadId>  SK R#<target>#<by>    (one per principal per target)
import { CommentError, DEFAULT_LIMIT, DEFAULT_TOPIC, MAX_LIMIT, auditEntry, commentTarget, computeCan, canWrite, isEmoji } from "@io-kit/comments";
import { ContentError } from "@io-kit/content";
import { HttpError } from "./http.js";
import { TxnCancelled, auditItem, transact, versionGuard } from "./txn.js";
import { contribOps, emptyOps, getEvent, mergeOps, mergedSize, revokeOps } from "./contrib.js";
import { createGuard, pointer } from "./guard.js";
import { normalizeNew } from "./comment-photos.js";

export const SUBJECT_RE = /^(person:[A-Za-z0-9_.-]{1,64}|post:[0-9A-HJKMNP-TV-Z]{26}|proposal:[0-9A-HJKMNP-TV-Z]{26})$/;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");
const ORDERS = ["asc", "desc"];
// A cursor is bound to the order that issued it: base64url("a:<id>") or ("d:<id>"). A pre-order cursor (the bare id) was an asc one.
const mintCursor = (order, id) => b64(`${order === "desc" ? "d" : "a"}:${id}`);
const threadPk = (t) => `THREAD#${t}`;
const cKey = (t, id) => ({ PK: threadPk(t), SK: `C#${id}` });
const rKey = (t, target, by) => ({ PK: threadPk(t), SK: `R#${target}#${by}` });

/**
 * The write guard of a stored comment: `edited_at` (an author's edit) and `grad_v` (a graduation write, graduate.js) must both be as they were read, so a
 * concurrent edit, delete or graduation step cancels the other's write (409) instead of dropping it. An absent field must still be absent.
 */
export function commentGuard(c) {
  const g = versionGuard("comment", "edited_at", c.edited_at);
  return c.grad_v === undefined
    ? { ...g, condition: `${g.condition} AND attribute_not_exists(#doc.#gv)`, names: { ...g.names, "#gv": "grad_v" } }
    : { ...g, condition: `${g.condition} AND #doc.#gv = :gv`, names: { ...g.names, "#gv": "grad_v" }, values: { ...g.values, ":gv": c.grad_v } };
}

/** Does a photo on stored comment `c` have a graduation under way (graduate.js: reserved, not finished)? Such a comment is never deleted. */
export const hasPendingPhoto = (c) => Array.isArray(c?.attachments) && c.attachments.some((a) => a?.graduated?.state === "pending");

/** Maps the API actor onto the comments Principal (admin => moderator role). */
export const toCommentPrincipal = (actor) => (actor ? { id: actor.id, label: actor.label, ...(actor.admin ? { roles: ["admin"] } : {}) } : null);

/**
 * `guard` is src/guard.js createGuard(): the R-18 check on the body and every photo alt of each create and edit (422, nothing stored).
 * `proposalVisible(id)` (HFY-TSK-184) says whether the viewer may see proposal `id`: a `proposal:<ulid>` thread is exactly as visible as its proposal (the proposer,
 * the admins and the owners of the targeted pages), for list, create, edit and react. Without it every proposal thread is not_found (fail closed).
 * `photos` is src/comment-photos.js (parse, owned, bind): without it a comment cannot carry attachments (503, fail closed).
 * `isWithdrawn(grampsId)` (sync/store.js isPersonWithdrawn) says whether a person was withdrawn (made private); the thread of a withdrawn person is
 * 404 to everyone but an admin (HFY-TSK-178, BRD2 PS-06), so a withdraw hides the discussion with the page. Without it no person thread is hidden.
 * `via` is the origin stamped on the contribution event: "ui" for HTTP, "mcp" for an MCP tool call (handler.invoke).
 */
export function createCommentSource({ ddb, cmds, table, viewer, audit, isWithdrawn, now = () => Date.now(), ulid, uid, maxLength = 1000, getPost, proposalVisible, onCreated, allowSelfReact = false, guard = createGuard(), photos, via = "ui" }) {
  const canOpts = { allowSelfReact };
  const iso = () => new Date(now()).toISOString();
  // `grad_v` is the graduation write counter (commentGuard): it never leaves the store.
  const view = (c) => {
    const { grad_v: _v, ...rest } = structuredClone(c);
    return { ...rest, can: computeCan(c, viewer, canOpts) };
  };
  const need = () => {
    if (viewer == null) throw new CommentError("unauthenticated");
    if (!canWrite(viewer)) throw new CommentError("forbidden", "read-only principal");
    return viewer;
  };
  // Only create may name a new thread; any other op on a malformed/unknown thread id is not_found.
  const checkThread = (t, create = false) => {
    if (typeof t !== "string" || !SUBJECT_RE.test(t)) {
      throw create ? new CommentError("validation", "invalid thread id", "threadId") : new CommentError("not_found", `thread ${t}`);
    }
  };
  // A post:<id> thread is exactly as visible as its post: a draft, withdrawn or deleted post hides its whole discussion
  // (list, create, edit, react) from anyone who cannot view the post. getPost throws not_found unless the viewer can see it.
  async function checkPostVisible(t) {
    if (!t.startsWith("post:") || !getPost) return;
    try {
      await getPost(t.slice(5));
    } catch (e) {
      if (e instanceof ContentError && e.code === "not_found") throw new CommentError("not_found", `thread ${t}`);
      throw e;
    }
  }
  // A proposal:<id> thread is exactly as visible as its proposal; anyone outside its visibility set gets not_found, as for a proposal that does not exist.
  async function checkProposalVisible(t) {
    if (!t.startsWith("proposal:")) return;
    if (!proposalVisible || (await proposalVisible(t.slice(9))) !== true) throw new CommentError("not_found", `thread ${t}`);
  }
  // A person:<id> thread of a withdrawn person is hidden from everyone but an admin: list, create, edit and react answer not_found. An admin keeps
  // reading and moderating it. A failed lookup is an error, never an open thread.
  async function checkPersonVisible(t) {
    if (!t.startsWith("person:") || typeof isWithdrawn !== "function") return;
    if (viewer?.roles?.includes("admin")) return;
    if (await isWithdrawn(t.slice(7))) throw new CommentError("not_found", `thread ${t}`);
  }
  const checkVisible = async (t) => {
    await checkPostVisible(t);
    await checkPersonVisible(t);
    await checkProposalVisible(t);
  };
  async function getComment(t, id) {
    checkThread(t);
    if (typeof id !== "string" || !ID_RE.test(id)) throw new CommentError("not_found", `comment ${id}`);
    const c = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: cKey(t, id) }))).Item?.comment;
    if (!c) throw new CommentError("not_found", `comment ${id}`);
    return c;
  }
  /**
   * A comment is text, a photo, or both: the trimmed body may be empty only while the comment holds at least one photo.
   * `body` is a required string on create and edit, photo or not (the kit's CreateInput/EditInput): a missing or non-string
   * body is refused rather than read as "", so a PATCH that leaves `body` out cannot wipe a photo comment's text.
   */
  function body(raw, photoCount = 0) {
    if (typeof raw !== "string") throw new CommentError("validation", "body is required", "body");
    const text = raw.trim();
    if (text === "" && photoCount === 0) throw new CommentError("validation", "body is required", "body");
    if (text.length > maxLength) throw new CommentError("validation", `body exceeds ${maxLength} characters`, "body");
    return text;
  }
  async function reactionRows(t, prefix = "R#") {
    const out = [];
    let key;
    for (let i = 0; i < 20; i += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": threadPk(t), ":sk": prefix }, ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      out.push(...(r.Items ?? []));
      key = r.LastEvaluatedKey;
      if (!key) break;
    }
    return out;
  }
  const altFields = (list) => list.map((a, i) => [pointer("attachments", i, "alt"), a.alt]);
  const photoParser = () => {
    if (!photos) throw new HttpError(503, "unavailable", "photos are not configured");
    return photos;
  };
  const parser = { parse: (url) => photoParser().parse(url) };
  // `graduated` is the marker of a photo's graduation into a record (graduate.js): an edit that re-describes or removes other photos keeps it.
  const stored = ({ id, path, mime, width, height, alt, graduated }) => ({ id, kind: "image", url: path, mime, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(alt ? { alt } : {}), ...(graduated ? { graduated } : {}) });
  // `updates` are the UPLOAD# bindings of new photos (tag "upload"); `ops` is a contrib.js fragment (credit or revoke). Both ride in
  // this transaction.
  async function commit(entry, { put, deletes = [], updates = [], ops = emptyOps() }) {
    const puts = [{ item: auditItem(entry, uid(), table) }];
    if (put) puts.unshift(put);
    try {
      await transact(ddb, cmds, table, mergeOps({ puts, deletes, updates }, ops));
    } catch (e) {
      // A failed condition is a 409; retries that ran out on TransactionConflict are a 503 busy; any other cancellation is the store failing.
      if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
      // An UPLOAD# binding changed between the read and the write (attached elsewhere, or not this member's): 403, nothing written.
      if (e instanceof TxnCancelled && e.conditionFailed && e.failures.length > 0 && e.failures.every((f) => f.tag === "upload")) throw new HttpError(403, "upload_not_owned", "that photo can't be attached here. add it again.");
      if (e instanceof TxnCancelled && e.conditionFailed) throw new HttpError(409, "conflict", "comment changed concurrently");
      throw new CommentError("server", "store unavailable");
    }
    if (self.audit) await self.audit(entry);
  }

  const self = {
    ...(audit ? { audit } : {}),
    async list(t, opts = {}) {
      checkThread(t);
      await checkVisible(t);
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const order = opts.order ?? "asc";
      if (!ORDERS.includes(order)) throw new CommentError("validation", "order must be asc or desc", "order");
      const desc = order === "desc";
      let after;
      if (opts.cursor !== undefined) {
        let raw;
        try { raw = unb64(opts.cursor); } catch { throw new CommentError("cursor_invalid"); }
        const m = /^([ad]):([0-9A-HJKMNP-TV-Z]{26})$/.exec(raw);
        const legacy = ID_RE.test(raw); // an asc cursor minted before order existed
        if (!(m ? (m[1] === "d") === desc : legacy && !desc)) throw new CommentError("cursor_invalid");
        after = m ? m[2] : raw;
      }
      // asc: SK in (C#<after>, C#~]; desc: SK in [C#, C#<after>), newest first. BETWEEN is inclusive, so desc drops the cursor row itself
      // when it still exists (it may have been deleted since), and asc starts just past it ("!" sorts below every id character).
      const lo = !desc && after !== undefined ? `C#${after}!` : "C#";
      const hi = desc && after !== undefined ? `C#${after}` : "C#~";
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": threadPk(t), ":lo": lo, ":hi": hi }, Limit: limit + 2, ...(desc ? { ScanIndexForward: false } : {}),
      }));
      const rows = (r.Items ?? []).map((i) => i.comment).filter((c) => c && !(desc && c.id === after));
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? mintCursor(order, page[page.length - 1].id) : undefined;
      const targets = new Set(["root", ...page.map((c) => commentTarget(c.id))]);
      const reactions = {};
      for (const item of (await reactionRows(t)).sort((a, b) => (a.reaction.created_at < b.reaction.created_at ? -1 : 1))) {
        if (targets.has(item.target)) (reactions[item.target] ??= []).push(item.reaction);
      }
      return { thread: { id: t, topic: DEFAULT_TOPIC, comments: page.map(view), reactions, ...(next ? { cursor: next } : {}) }, ...(next ? { cursor: next } : {}) };
    },
    async create(t, input) {
      const who = need();
      checkThread(t, true);
      const list = input.attachments === undefined ? [] : normalizeNew(input.attachments, parser);
      const text = body(input.body, list.length);
      guard("comments", "create", [[pointer("body"), input.body], ...altFields(list)]); // offsets into the body as submitted
      await checkVisible(t); // not_found unless the post, the person page or the proposal behind the thread is visible to the viewer
      let parent;
      if (input.parentId !== undefined) {
        parent = await getComment(t, input.parentId);
      }
      const at = iso();
      const id = ulid(now());
      const updates = list.length > 0 ? await photoParser().bind(list, who, id) : []; // 403 upload_not_owned, 400 upload_missing / photo_has_location
      const c = { id, threadId: t, ...(parent ? { parentId: parent.id } : {}), author: { id: who.id, label: who.label }, body: text, ...(list.length > 0 ? { attachments: list.map(stored) } : {}), created_at: at };
      // The credit commits with the comment (D2-17): one event, five counters, and the link on the stored comment.
      const credit = contribOps({
        actor: { id: who.id, label: who.label }, kind: "comment", ref: { type: "comment", id: c.id, thread: t }, subject: t,
        photos: Array.isArray(c.attachments) ? c.attachments.length : 0, at, via, uid,
      });
      c.contrib = { id: credit.event.id };
      await commit(auditEntry("create", c.id, who.id, null, c, at), {
        put: { item: { ...cKey(t, c.id), GSI1PK: "COMMENTS", GSI1SK: c.id, entity: "comment", comment: c }, condition: "attribute_not_exists(PK)" },
        updates,
        ops: credit,
      });
      if (onCreated) await onCreated(c, { parent });
      return view(c);
    },
    // edit and delete are guarded on the edited_at they read (absent => never edited): a concurrent edit cancels the
    // write (409) instead of being lost, and the D-15 `before` is exactly the version replaced.
    async edit(t, id, input) {
      const who = need();
      const c = await getComment(t, id);
      await checkVisible(t);
      if (!computeCan(c, who, canOpts).edit) throw new CommentError("forbidden", "cannot edit this comment");
      // `attachments` omitted leaves the photos as stored. A listed photo is matched to a stored one by url; an edit can remove
      // photos or change their alt, never add one (changing photos means a new comment), so an unknown url is refused after the
      // ownership check: another member's key answers 403 upload_not_owned, anything else 422 validation.
      const heldAll = c.attachments ?? [];
      let final = heldAll;
      let altChecked = [];
      if (input.attachments !== undefined) {
        const submitted = normalizeNew(input.attachments, parser);
        const held = new Map(heldAll.map((a) => [a.url, a]));
        const fresh = submitted.filter((a) => !held.has(a.path));
        if (fresh.length > 0) {
          await photoParser().owned(fresh, who);
          throw new CommentError("validation", "photos can only be removed from a comment", "attachments");
        }
        final = submitted.map((a) => stored({ ...held.get(a.path), path: a.path, alt: a.alt }));
        // A photo whose graduation is under way cannot be taken off the comment: the admin's retry resumes from it (graduate.js).
        const kept = new Set(final.map((a) => a.url));
        if (heldAll.some((a) => a.graduated?.state === "pending" && !kept.has(a.url))) throw new HttpError(409, "graduation_pending", "that photo is being added to a family page. try again in a minute.");
        altChecked = altFields(final);
      }
      const text = body(input.body, final.length);
      guard("comments", "update", [[pointer("body"), input.body], ...altChecked]); // before the no-op shortcut: an unchanged legacy hit is refused too
      if (text === c.body && JSON.stringify(final) === JSON.stringify(heldAll)) return view(c);
      const at = iso();
      const { attachments: _drop, ...rest } = c;
      const next = { ...rest, body: text, ...(final.length > 0 ? { attachments: final } : {}), edited_at: at };
      await commit(auditEntry("edit", id, who.id, structuredClone(c), next, at), {
        put: { item: { ...cKey(t, id), GSI1PK: "COMMENTS", GSI1SK: id, entity: "comment", comment: next }, ...commentGuard(c) },
      });
      return view(next);
    },
    // Not gated on post visibility: an author or admin can always remove a comment, even under a withdrawn post.
    async delete(t, id, opts = {}) {
      const who = need();
      const c = await getComment(t, id);
      if (!computeCan(c, who, canOpts).delete) throw new CommentError("forbidden", "cannot delete this comment");
      // A photo whose graduation is under way (reserved, not finished) keeps its comment: the admin's retry needs it to finalize (audit, credit, notice).
      // A write between this read and the delete moves grad_v, so commentGuard cancels the delete (409) instead.
      if (hasPendingPhoto(c)) throw new HttpError(409, "graduation_pending", "a photo on this comment is being added to a family page. try again in a minute.");
      const cascade = (await reactionRows(t, `R#${commentTarget(id)}#`)).map((i) => ({ PK: i.PK, SK: i.SK }));
      const reason = opts.reason !== undefined && who.roles?.includes("admin") && c.author.id !== who.id ? opts.reason : undefined;
      // Deletes revoke the credit, whoever deletes: the event sits under the comment's author.
      const event = c.contrib ? await getEvent({ ddb, cmds, table }, c.author.id, c.contrib.id) : undefined;
      await commit(auditEntry("delete", id, who.id, structuredClone(c), null, iso(), reason), {
        deletes: [{ key: cKey(t, id), ...commentGuard(c) }, ...cascade],
        ...(event ? { ops: revokeOps(event) } : {}),
      });
    },
    async react(t, target, emoji) {
      const who = need();
      checkThread(t);
      await checkVisible(t);
      if (!isEmoji(emoji)) throw new CommentError("validation", "not an emoji", "emoji");
      let owner;
      if (target.startsWith("comment:")) owner = (await getComment(t, target.slice(8))).author.id;
      else if (target !== "root") {
        if (target.startsWith("attachment:")) throw new CommentError("not_found", target);
        throw new CommentError("validation", "unknown target", "target");
      }
      if (owner === who.id && !allowSelfReact) throw new CommentError("self_react", "cannot react to your own item");
      const key = rKey(t, target, who.id);
      const mine = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: key }))).Item?.reaction;
      if (mine?.emoji === emoji) {
        await ddb.send(new cmds.DeleteCommand({ TableName: table, Key: key }));
        return { removed: true };
      }
      const reaction = { emoji, by: who.id, created_at: iso() };
      await ddb.send(new cmds.PutCommand({ TableName: table, Item: { ...key, entity: "reaction", target, reaction } }));
      return { removed: false, reaction };
    },
  };
  return self;
}

/** The items of thread `t` (comments and reactions), or only its comments with `commentsOnly`; at most 50 pages, as purgeThread removes. */
async function threadRows({ ddb, cmds, table }, t, commentsOnly = false) {
  const rows = [];
  let key;
  for (let i = 0; i < 50; i += 1) {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table,
      KeyConditionExpression: commentsOnly ? "PK = :pk AND begins_with(SK, :sk)" : "PK = :pk",
      ExpressionAttributeValues: { ":pk": threadPk(t), ...(commentsOnly ? { ":sk": "C#" } : {}) },
      ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) break;
  }
  return rows;
}

/**
 * The check a post delete runs before it writes anything (handler.js wires it as the content source's beforeDelete): while a photo on any
 * comment of thread `t` has a graduation under way, the delete is 409 graduation_pending, as a comment delete is. The admin's retry
 * finishes the graduation (audit, credit, notice), and the post can then be deleted. A reservation that lands after this read is
 * covered by purgeThread, which keeps such a comment.
 */
export async function refusePendingGraduation(ctx, t) {
  if ((await threadRows(ctx, t, true)).some((row) => hasPendingPhoto(row.comment))) {
    throw new HttpError(409, "graduation_pending", "a photo in this post's discussion is being added to a family page. try again in a minute.");
  }
}

/**
 * Removes a whole thread (comments + reactions), e.g. after its post is deleted. Each removed comment gets its own D-15
 * `delete` audit item (reason "post deleted") in the same transaction as the delete, and its contribution is revoked there too
 * (BRD2 D2-17: deletes revoke, cascade included). The revokes of one batch are merged (mergeOps), so 30 comments by one author in
 * one month are one decrement per counter key instead of 30 duplicate targets. A batch holds at most 100 actions after the merge.
 * A comment with a photo whose graduation is pending (hasPendingPhoto) is kept, as a comment delete refuses it: a reservation can land
 * between a post delete's check (refusePendingGraduation) and its commit, and the admin's retry needs the comment to finalize. No
 * reservation starts once the post is gone (graduate.js checks the post in the reserve's transaction), and the graduation route removes
 * the rest of the thread once that photo's graduation is no longer pending. Returns the number of comments removed.
 */
export async function purgeThread({ ddb, cmds, table, now = () => Date.now(), uid }, t, principalId, reason = "post deleted") {
  const rows = (await threadRows({ ddb, cmds, table }, t)).filter((row) => !(row.SK.startsWith("C#") && hasPendingPhoto(row.comment)));
  // The stored events of the comments that were credited (a comment from before the ledger has none and revokes nothing).
  const events = new Map();
  const credited = rows.filter((row) => row.SK.startsWith("C#") && row.comment?.contrib);
  for (let i = 0; i < credited.length; i += 25) {
    await Promise.all(credited.slice(i, i + 25).map(async ({ comment: c }) => {
      const e = await getEvent({ ddb, cmds, table }, c.author.id, c.contrib.id);
      if (e) events.set(c.id, e);
    }));
  }
  // Each batch entry keeps its row, so a retry can rebuild the revokes from fresh events.
  const opsFor = (row) => (events.has(row.comment?.id) ? revokeOps(events.get(row.comment.id)) : emptyOps());
  const refresh = async (batchRows) => {
    for (const row of batchRows.filter((r) => r.SK.startsWith("C#") && r.comment?.contrib)) {
      const e = await getEvent({ ddb, cmds, table }, row.comment.author.id, row.comment.contrib.id);
      if (e) events.set(row.comment.id, e);
      else events.delete(row.comment.id);
    }
  };
  let batch = [];
  const build = () => mergeOps(...batch.flatMap(({ frag, row }) => [frag, opsFor(row)]));
  const flush = async () => {
    if (batch.length === 0) return;
    try {
      await transact(ddb, cmds, table, build());
    } catch (e) {
      // A revoke deletes its event only if it still exists. If the comment's author deleted it between our read and this batch, the
      // condition fails and the whole batch is cancelled. Re-read the batch's events (the vanished one has already been revoked by that
      // delete, so it drops out) and commit once more. Busy and store failures are not retried here: transact() already did.
      if (!(e instanceof TxnCancelled) || e.kind !== "condition") throw e;
      await refresh(batch.map(({ row }) => row));
      await transact(ddb, cmds, table, build());
    }
    batch = [];
  };
  let removed = 0;
  for (const row of rows) {
    const isComment = row.SK.startsWith("C#") && row.comment;
    const frag = { puts: [], deletes: [{ PK: row.PK, SK: row.SK }] };
    if (isComment) {
      const at = new Date(now()).toISOString();
      frag.puts.push({ item: auditItem(auditEntry("delete", row.comment.id, principalId, row.comment, null, at, reason), uid(), table) });
    }
    if (batch.length > 0 && mergedSize(...batch.flatMap((b) => [b.frag, opsFor(b.row)]), frag, opsFor(row)) > 100) await flush();
    batch.push({ frag, row });
    if (isComment) removed += 1;
  }
  await flush();
  return removed;
}
