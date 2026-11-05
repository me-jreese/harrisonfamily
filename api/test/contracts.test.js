// AC1 (offline half): the kit contract suites run against the real stores over the in-memory DynamoDB fake.
import { describe, it } from "vitest";
import { registerContentContract, FIXTURE_POSTS } from "@io-kit/content/testing";
import { registerCommentContract } from "@io-kit/comments/testing";
import { createContentSource, seedPosts } from "../src/content.js";
import { createCommentSource } from "../src/comments.js";
import { UPLOAD_BINDING_SECONDS, UPLOAD_PURPOSE_POST, uploadKeys } from "../src/uploads.js";
import { TABLE, contractPhotos, checkUploadPhoto, cmds, createFakeDdb, createUlidFactory, ticker, ulidTime } from "./world.js";

// @io-kit/content 0.1.1+ reports a case the host cannot run (a capability it does not declare) through `skip`, so it shows as skipped, never as passed.
const api = { describe, it: (name, fn) => it(name, fn), skip: (name, fn) => it.skip(name, fn) };

/**
 * The kit's CS-17 and CS-19 post example.test photos; this host only takes its own uploads (/uploads/posts/<ulid>/<name>, bound to the writer). The
 * wrapper stands in for the browser's presign: a photo url it has not seen on this post becomes a fresh upload path with an UPLOAD# binding for the
 * writer, a url the post already holds keeps its path (so an edit that resubmits a photo is a resubmit), and every post that comes back shows the
 * kit's url again. Anything else (a junk entry, an unsafe url) goes through untouched, so the host's own validation answers.
 */
function photoWorld(ddb, now, ulid) {
  const back = new Map(); // upload path -> the url the kit used
  const mapOut = (p) => (p?.attachments ? { ...p, attachments: p.attachments.map((a) => (back.has(a.url) ? { ...a, url: back.get(a.url) } : a)) } : p);
  const bind = async (owner, a) => {
    const id = ulid(now());
    const path = `/uploads/posts/${id}/photo.png`;
    await ddb.send(new cmds.PutCommand({
      TableName: TABLE,
      Item: { ...uploadKeys(id), entity: "upload", owner, purpose: UPLOAD_PURPOSE_POST, key: path.slice(1), contentType: a.mime, ttl: Math.floor(now() / 1000) + UPLOAD_BINDING_SECONDS },
    }));
    back.set(path, a.url);
    return path;
  };
  const mapIn = async (owner, list, held = []) => {
    if (!Array.isArray(list)) return list;
    return Promise.all(list.map(async (a) => {
      if (typeof a?.url !== "string" || !a.url.startsWith("https://m.example.test/")) return a;
      const kept = held.find((h) => back.get(h.url) === a.url);
      return { ...a, url: kept ? kept.url : await bind(owner, a) };
    }));
  };
  return {
    wrap(src, actor) {
      const heldOf = async (id) => (await src.get(id).catch(() => ({ attachments: [] }))).attachments ?? [];
      return {
        ...src,
        async list(args) { const r = await src.list(args); return { ...r, items: r.items.map(mapOut) }; },
        async get(id) { return mapOut(await src.get(id)); },
        async createDraft(input) { return mapOut(await src.createDraft(input.attachments ? { ...input, attachments: await mapIn(actor.id, input.attachments) } : input)); },
        async update(id, patch) { return mapOut(await src.update(id, patch.attachments ? { ...patch, attachments: await mapIn(actor.id, patch.attachments, await heldOf(id)) } : patch)); },
        async setVisibility(id, v) { return mapOut(await src.setVisibility(id, v)); },
        async moderate(id, m, opts) { return mapOut(await src.moderate(id, m, opts)); },
      };
    },
  };
}

registerContentContract(
  {
    async make() {
      const ddb = createFakeDdb();
      await seedPosts({ ddb, cmds, table: TABLE }, FIXTURE_POSTS);
      const now = ticker(Math.max(0, ...FIXTURE_POSTS.map((p) => ulidTime(p.id))));
      const ulid = createUlidFactory();
      const audit = [];
      const photos = photoWorld(ddb, now, ulid);
      return { audit, as: (actor) => photos.wrap(createContentSource({ ddb, cmds, table: TABLE, actor, now, ulid, uid: () => ulid(now()), audit: (e) => void audit.push(e), checkUpload: checkUploadPhoto }), actor) };
    },
    author: { id: "I0001", label: "Ann Author" },
    other: { id: "I0002", label: "Olive Other" },
    admin: { id: "I0099", label: "Admin", admin: true },
    // hfy-moderation-api-core: this host moderates (hide, unhide, request_changes, ask), so CS-15 to CS-18 run, and CS-19 checks a photo-only post whose only photo is hidden.
    capabilities: { moderation: true },
  },
  api,
  "hfy posts (CS) over DynamoDB fake",
);

const roles = (id, label, r) => ({ id, label, ...(r ? { roles: r } : {}) });
registerCommentContract(
  {
    async make() {
      const ddb = createFakeDdb();
      const now = ticker();
      const ulid = createUlidFactory();
      const audit = [];
      return { audit, as: (viewer) => createCommentSource({ ddb, cmds, table: TABLE, viewer, now, ulid, uid: () => ulid(now()), maxLength: 1000, audit: (e) => void audit.push(e), photos: contractPhotos /* test-only policy; the production UPLOAD#/HEAD binding is covered over HTTP in comment-photos.test.js */ }) };
    },
    threadId: "person:I0001",
    author: roles("I0003", "Ann Author"),
    other: roles("I0004", "Olive Other"),
    admin: roles("I0099", "Admin", ["admin"]),
    reader: roles("I0005", "Rita Reader", ["reader"]),
    maxLength: 1000,
    // @io-kit/comments 0.3.0 CC-24..CC-27 need CommentSource.moderate, which comments.js provides (hfy-moderation-api-core).
    features: { reactions: true, moderation: true },
  },
  api,
  "hfy comments (CC) over DynamoDB fake",
);
