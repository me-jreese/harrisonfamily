// HFY-TSK-066: the kit CommentSource contract (@io-kit/comments 0.3.1, CC-01..CC-27) against the harrisonfamily adapter over a mocked
// fetch. The mock /api is the kit's in-memory store behind the same routes and error body as api/src/routes.js.
import { describe, it } from "node:test";
import { CommentError } from "@io-kit/comments";
import { COMMENT_CONTRACT_CASES, createMemoryCommentStore, registerCommentContract } from "@io-kit/comments/testing";
import { createApi } from "../src/lib/api.js";
import { createHfyCommentSource } from "../src/lib/comment-source.js";

const roles = (id, label, r) => ({ id, label, ...(r ? { roles: r } : {}) });
const harness = {
  async make() {
    const audit = [];
    const store = createMemoryCommentStore({ maxLength: 1000, seed: [{ threadId: "person:I0001", comments: [] }], audit: (e) => void audit.push(e) });
    const fetchFor = (viewer) => async (url, init) => {
      const u = new URL(url, "http://x");
      const q = Object.fromEntries(u.searchParams);
      const body = init.body ? JSON.parse(init.body) : {};
      const src = store.as(viewer);
      const m = u.pathname.match(/^\/api\/comments(?:\/([^/]+)(\/react)?)?$/);
      const reply = (status, b) => ({ status, ok: status < 400, json: async () => b });
      try {
        const subject = body.subject ?? q.subject;
        if (!m) return reply(404, { error: "not_found" });
        if (!m[1] && init.method === "GET") return reply(200, await src.list(subject, { ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}), ...(q.order ? { order: q.order } : {}) }));
        if (!m[1] && init.method === "POST") return reply(201, await src.create(subject, { body: body.body }));
        if (m[2]) return reply(200, await src.react(subject, `comment:${m[1]}`, body.emoji));
        if (init.method === "PATCH") return reply(200, await src.edit(subject, m[1], { body: body.body }));
        if (init.method === "DELETE") { await src.delete(subject, m[1], q.reason ? { reason: q.reason } : {}); return reply(204); }
        return reply(405, { error: "validation" });
      } catch (e) {
        if (e instanceof CommentError) return reply(e.status, { error: e.code, message: e.message, ...(e.field ? { details: { field: e.field } } : {}) });
        throw e;
      }
    };
    return { audit, as: (viewer) => createHfyCommentSource(createApi({ fetchImpl: fetchFor(viewer) })) };
  },
  threadId: "person:I0001",
  author: roles("I0003", "Ann Author"),
  other: roles("I0004", "Olive Other"),
  admin: roles("I0099", "Admin", ["admin"]),
  reader: roles("I0005", "Rita Reader", ["reader"]),
  maxLength: 1000,
  // The islands thread offers no photos (no Thread onUpload; comment photos are commentPhotosV1, off) and the adapter sends none, so the
  // photo cases (CC-18, CC-19, CC-22) are n/a; it has no `moderate` (an admin deletes, with a reason), so CC-24..CC-27 are n/a too.
  // CC-23 (the can.moderate matrix) and the order cases (CC-20, CC-21) run.
  features: { reactions: true, attachments: false, moderation: false },
};

const NA_ROOT = new Set(["CC-13-react-many"]); // /api/comments/:id/react targets comments only; the contract case reacts on `root`
const NEEDS = {
  reactions: harness.features.reactions,
  admin: Boolean(harness.admin),
  reader: Boolean(harness.reader),
  "no-self-react": !harness.features.allowSelfReact,
  attachments: harness.features.attachments !== false,
  moderation: harness.features.moderation !== false,
};
const applied = COMMENT_CONTRACT_CASES.filter((c) => !NA_ROOT.has(c.id)).filter((c) => !c.needs || NEEDS[c.needs]);
console.log(`contract cases: ${COMMENT_CONTRACT_CASES.length} total, ${applied.length} run, ${COMMENT_CONTRACT_CASES.length - applied.length} n/a`);
registerCommentContract(harness, { describe, it: (name, fn) => (NA_ROOT.has(name.split(":")[0]) || [...NA_ROOT].some((id) => name.startsWith(id.slice(0, 5))) ? it.skip(name, fn) : it(name, fn)) }, "hfy comments adapter over mocked /api");
