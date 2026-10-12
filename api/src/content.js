// ContentSource over the hfy-app table. Implements the @io-kit/content contract (CS suite) with D-15 audit
// items written in the same TransactWriteItems call as the data change.
import { ContentError, POST_TYPES, VISIBILITIES, auditEntry, canView, computeCan, withCan, DEFAULT_LIMIT, MAX_LIMIT } from "@io-kit/content";
import { postKeys, gsiPosts, gsiAuthor, gsiSubject } from "./keys.js";
import { auditItem, transact, queryPartition } from "./txn.js";

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};
const filterId = (f) => hash(JSON.stringify([f?.subject ?? null, f?.type ?? null, f?.author ?? null, f?.visibility ?? null]));

const MAX_BODY = 20_000; // keeps post item x3 + audit before/after well under the 400KB item limit

export function createContentSource({ ddb, cmds, table, actor, audit, now = () => Date.now(), ulid, uid }) {
  const requireActor = () => {
    if (!actor) throw new ContentError("forbidden", "sign in to write");
    return actor;
  };
  const view = (p) => withCan(structuredClone(p), actor);

  async function fetchStored(id) {
    const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: postKeys(id) }));
    return r.Item?.post ?? null;
  }
  async function visible(id) {
    const p = await fetchStored(id);
    if (!p || !canView(p, actor)) throw new ContentError("not_found", `no post ${id}`, { id });
    return p;
  }
  function validateBody(body) {
    if (typeof body !== "string" || body.trim() === "") throw new ContentError("validation", "body is required", { field: "body" });
    if (body.length > MAX_BODY) throw new ContentError("validation", "body too long", { field: "body" });
  }

  /** Main item + author index + optional subject index; all carry the full post so list reads need no second fetch. */
  function itemsFor(post) {
    const base = { entity: "post", post };
    const items = [
      { ...postKeys(post.id), GSI1PK: gsiPosts, GSI1SK: post.id, ...base },
      { PK: `POST#${post.id}`, SK: "IDX#AUTHOR", GSI1PK: gsiAuthor(post.author.id), GSI1SK: post.id, ...base },
    ];
    if (post.subject) items.push({ PK: `POST#${post.id}`, SK: "IDX#SUBJECT", GSI1PK: gsiSubject(post.subject), GSI1SK: post.id, ...base });
    return items;
  }
  const allKeys = (id) => [postKeys(id), { PK: `POST#${id}`, SK: "IDX#AUTHOR" }, { PK: `POST#${id}`, SK: "IDX#SUBJECT" }];

  async function commit(op, id, before, after, at, { create = false } = {}) {
    const who = requireActor();
    const entry = auditEntry(op, id, who.id, before, after, at);
    const puts = [];
    const deletes = [];
    if (after) {
      const items = itemsFor(after);
      items.forEach((item, i) =>
        puts.push({ item, ...(i === 0 ? { condition: create ? "attribute_not_exists(PK)" : "attribute_exists(PK)" } : {}) }),
      );
      if (!after.subject) deletes.push({ PK: `POST#${id}`, SK: "IDX#SUBJECT" });
    } else {
      deletes.push(...allKeys(id));
    }
    puts.push({ item: auditItem(entry, uid(), table) });
    try {
      await transact(ddb, cmds, table, { puts, deletes });
    } catch (e) {
      if (e?.name === "TransactionCanceledException") throw new ContentError("conflict", "record changed concurrently", { id });
      throw new ContentError("unavailable", "store unavailable", { id });
    }
    if (self.audit) await self.audit(entry);
  }

  const self = {
    ...(audit ? { audit } : {}),
    async list(args = {}) {
      if (args.signal?.aborted) throw new ContentError("unavailable", "aborted");
      const f = args.filter;
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(args.limit ?? DEFAULT_LIMIT)));
      let after = null;
      if (args.cursor) {
        const m = /^c1\.([0-9A-Z]{26})\.([0-9a-f]+)$/.exec(args.cursor);
        if (!m || m[2] !== filterId(f)) throw new ContentError("cursor_invalid", "cursor does not belong to this listing");
        after = m[1];
      }
      const pk = f?.subject !== undefined ? gsiSubject(f.subject) : f?.author !== undefined ? gsiAuthor(f.author) : gsiPosts;
      const accept = (item) => {
        const p = item.post;
        return (
          canView(p, actor) &&
          (f?.subject === undefined || p.subject === f.subject) &&
          (f?.type === undefined || p.type === f.type) &&
          (f?.author === undefined || p.author.id === f.author) &&
          (f?.visibility === undefined || p.visibility === f.visibility)
        );
      };
      const rows = await queryPartition(ddb, cmds, table, { pk, after, accept, want: limit + 1 });
      const page = rows.slice(0, limit).map((r) => r.post);
      const last = page[page.length - 1];
      return { items: page.map(view), cursor: rows.length > limit && last ? `c1.${last.id}.${filterId(f)}` : null };
    },
    async get(id) {
      return view(await visible(id));
    },
    async createDraft(input) {
      const who = requireActor();
      validateBody(input.body);
      if (input.type !== undefined && !POST_TYPES.includes(input.type)) throw new ContentError("validation", "unknown type", { field: "type" });
      const at = new Date(now()).toISOString();
      const post = {
        id: ulid(now()),
        type: input.type ?? "post",
        author: { id: who.id, label: who.label },
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        body: input.body,
        attachments: structuredClone(input.attachments ?? []),
        visibility: "draft",
        created_at: at,
        updated_at: at,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
      };
      await commit("create", post.id, null, post, at, { create: true });
      return view(post);
    },
    async update(id, patch) {
      const current = await visible(id);
      if (!computeCan(current, actor).edit) throw new ContentError("forbidden", "only the author can edit", { id });
      if (patch.body !== undefined) validateBody(patch.body);
      const before = structuredClone(current);
      const next = { ...current };
      if (patch.body !== undefined) next.body = patch.body;
      if (patch.attachments !== undefined) next.attachments = structuredClone(patch.attachments);
      for (const k of ["title", "subject"]) {
        const v = patch[k];
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = v;
      }
      next.updated_at = new Date(now()).toISOString();
      await commit("update", id, before, next, next.updated_at);
      return view(next);
    },
    async setVisibility(id, visibility) {
      if (!VISIBILITIES.includes(visibility)) throw new ContentError("validation", "unknown visibility", { field: "visibility" });
      const current = await visible(id);
      if (!computeCan(current, actor).publish) throw new ContentError("forbidden", "only the author can change visibility", { id });
      if (current.visibility === visibility) return view(current);
      const before = structuredClone(current);
      const next = { ...current, visibility, updated_at: new Date(now()).toISOString() };
      await commit("visibility", id, before, next, next.updated_at);
      return view(next);
    },
    async delete(id) {
      const current = await visible(id);
      if (!computeCan(current, actor).delete) throw new ContentError("forbidden", "not allowed to delete", { id });
      await commit("delete", id, structuredClone(current), null, new Date(now()).toISOString());
    },
  };
  return self;
}

/** Test/seed helper: writes StoredPost rows (main + index items) without audit. */
export async function seedPosts({ ddb, cmds, table }, posts) {
  for (const post of posts) {
    const base = { entity: "post", post };
    await ddb.send(new cmds.PutCommand({ TableName: table, Item: { ...postKeys(post.id), GSI1PK: gsiPosts, GSI1SK: post.id, ...base } }));
    await ddb.send(new cmds.PutCommand({ TableName: table, Item: { PK: `POST#${post.id}`, SK: "IDX#AUTHOR", GSI1PK: gsiAuthor(post.author.id), GSI1SK: post.id, ...base } }));
    if (post.subject) await ddb.send(new cmds.PutCommand({ TableName: table, Item: { PK: `POST#${post.id}`, SK: "IDX#SUBJECT", GSI1PK: gsiSubject(post.subject), GSI1SK: post.id, ...base } }));
  }
}
