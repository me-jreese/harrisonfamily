// CommentSource (@io-kit/comments contract) over the hfy-app table. threadId is the subject: `person:<gramps_id>` or `post:<ulid>`.
//   comment   PK THREAD#<threadId>  SK C#<ulid>           GSI1PK COMMENTS  GSI1SK <ulid>
//   reaction  PK THREAD#<threadId>  SK R#<target>#<by>    (one per principal per target)
import { CommentError, DEFAULT_LIMIT, DEFAULT_TOPIC, MAX_LIMIT, auditEntry, commentTarget, computeCan, canWrite, isEmoji } from "@io-kit/comments";
import { ContentError } from "@io-kit/content";
import { HttpError } from "./http.js";
import { auditItem, transact, versionGuard } from "./txn.js";

export const SUBJECT_RE = /^(person:[A-Za-z0-9_.-]{1,64}|post:[0-9A-HJKMNP-TV-Z]{26})$/;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");
const threadPk = (t) => `THREAD#${t}`;
const cKey = (t, id) => ({ PK: threadPk(t), SK: `C#${id}` });
const rKey = (t, target, by) => ({ PK: threadPk(t), SK: `R#${target}#${by}` });

/** Maps the API actor onto the comments Principal (admin => moderator role). */
export const toCommentPrincipal = (actor) => (actor ? { id: actor.id, label: actor.label, ...(actor.admin ? { roles: ["admin"] } : {}) } : null);

export function createCommentSource({ ddb, cmds, table, viewer, audit, now = () => Date.now(), ulid, uid, maxLength = 1000, getPost, onCreated, allowSelfReact = false }) {
  const canOpts = { allowSelfReact };
  const iso = () => new Date(now()).toISOString();
  const view = (c) => ({ ...structuredClone(c), can: computeCan(c, viewer, canOpts) });
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
  async function getComment(t, id) {
    checkThread(t);
    if (typeof id !== "string" || !ID_RE.test(id)) throw new CommentError("not_found", `comment ${id}`);
    const c = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: cKey(t, id) }))).Item?.comment;
    if (!c) throw new CommentError("not_found", `comment ${id}`);
    return c;
  }
  function body(raw) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") throw new CommentError("validation", "body is required", "body");
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
  async function commit(entry, { put, deletes = [] }) {
    const puts = [{ item: auditItem(entry, uid(), table) }];
    if (put) puts.unshift(put);
    try {
      await transact(ddb, cmds, table, { puts, deletes });
    } catch (e) {
      if (e?.name === "TransactionCanceledException") throw new HttpError(409, "conflict", "comment changed concurrently");
      throw new CommentError("server", "store unavailable");
    }
    if (self.audit) await self.audit(entry);
  }

  const self = {
    ...(audit ? { audit } : {}),
    async list(t, opts = {}) {
      checkThread(t);
      await checkPostVisible(t);
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      let lo = "C#";
      if (opts.cursor !== undefined) {
        let after;
        try { after = unb64(opts.cursor); } catch { throw new CommentError("cursor_invalid"); }
        if (!ID_RE.test(after)) throw new CommentError("cursor_invalid");
        lo = `C#${after}!`;
      }
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": threadPk(t), ":lo": lo, ":hi": "C#~" }, Limit: limit + 1,
      }));
      const rows = (r.Items ?? []).map((i) => i.comment);
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? b64(page[page.length - 1].id) : undefined;
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
      const text = body(input.body);
      await checkPostVisible(t); // not_found unless the post exists and is visible
      let parent;
      if (input.parentId !== undefined) {
        parent = await getComment(t, input.parentId);
      }
      const at = iso();
      const c = { id: ulid(now()), threadId: t, ...(parent ? { parentId: parent.id } : {}), author: { id: who.id, label: who.label }, body: text, created_at: at };
      await commit(auditEntry("create", c.id, who.id, null, c, at), {
        put: { item: { ...cKey(t, c.id), GSI1PK: "COMMENTS", GSI1SK: c.id, entity: "comment", comment: c }, condition: "attribute_not_exists(PK)" },
      });
      if (onCreated) await onCreated(c, { parent });
      return view(c);
    },
    // edit and delete are guarded on the edited_at they read (absent => never edited): a concurrent edit cancels the
    // write (409) instead of being lost, and the D-15 `before` is exactly the version replaced.
    async edit(t, id, input) {
      const who = need();
      const c = await getComment(t, id);
      await checkPostVisible(t);
      if (!computeCan(c, who, canOpts).edit) throw new CommentError("forbidden", "cannot edit this comment");
      const text = body(input.body);
      if (text === c.body) return view(c);
      const at = iso();
      const next = { ...c, body: text, edited_at: at };
      await commit(auditEntry("edit", id, who.id, structuredClone(c), next, at), {
        put: { item: { ...cKey(t, id), GSI1PK: "COMMENTS", GSI1SK: id, entity: "comment", comment: next }, ...versionGuard("comment", "edited_at", c.edited_at) },
      });
      return view(next);
    },
    // Not gated on post visibility: an author or admin can always remove a comment, even under a withdrawn post.
    async delete(t, id, opts = {}) {
      const who = need();
      const c = await getComment(t, id);
      if (!computeCan(c, who, canOpts).delete) throw new CommentError("forbidden", "cannot delete this comment");
      const cascade = (await reactionRows(t, `R#${commentTarget(id)}#`)).map((i) => ({ PK: i.PK, SK: i.SK }));
      const reason = opts.reason !== undefined && who.roles?.includes("admin") && c.author.id !== who.id ? opts.reason : undefined;
      await commit(auditEntry("delete", id, who.id, structuredClone(c), null, iso(), reason), {
        deletes: [{ key: cKey(t, id), ...versionGuard("comment", "edited_at", c.edited_at) }, ...cascade],
      });
    },
    async react(t, target, emoji) {
      const who = need();
      checkThread(t);
      await checkPostVisible(t);
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

/**
 * Removes a whole thread (comments + reactions), e.g. after its post is deleted. Each removed comment gets its own D-15
 * `delete` audit item (reason "post deleted") in the same transaction as the delete; at most 100 items per transaction.
 * Returns the number of comments removed.
 */
export async function purgeThread({ ddb, cmds, table, now = () => Date.now(), uid }, t, principalId, reason = "post deleted") {
  const rows = [];
  let key;
  for (let i = 0; i < 50; i += 1) {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": threadPk(t) }, ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) break;
  }
  let batch = { puts: [], deletes: [] };
  const size = () => batch.puts.length + batch.deletes.length;
  const flush = async () => {
    if (size() > 0) await transact(ddb, cmds, table, batch);
    batch = { puts: [], deletes: [] };
  };
  let removed = 0;
  for (const row of rows) {
    const isComment = row.SK.startsWith("C#") && row.comment;
    if (size() + (isComment ? 2 : 1) > 100) await flush();
    batch.deletes.push({ PK: row.PK, SK: row.SK });
    if (isComment) {
      const at = new Date(now()).toISOString();
      batch.puts.push({ item: auditItem(auditEntry("delete", row.comment.id, principalId, row.comment, null, at, reason), uid(), table) });
      removed += 1;
    }
  }
  await flush();
  return removed;
}
