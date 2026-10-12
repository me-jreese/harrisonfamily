// HFY-TSK-066: the kit CommentSource contract (CC-01..CC-17) against the harrisonfamily adapter over a mocked fetch.
// The mock /api is the kit's in-memory store behind the same routes and error body as api/src/routes.js.
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
        if (!m[1] && init.method === "GET") return reply(200, await src.list(subject, { ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}) }));
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
  features: { reactions: true },
};

const NA_ROOT = new Set(["CC-13-react-many"]); // /api/comments/:id/react targets comments only; the contract case reacts on `root`
const applied = COMMENT_CONTRACT_CASES.filter((c) => !NA_ROOT.has(c.id)).filter((c) => !c.needs || (c.needs === "reactions" ? harness.features.reactions : c.needs === "admin" ? harness.admin : c.needs === "reader" ? harness.reader : !harness.features.allowSelfReact));
console.log(`contract cases: ${COMMENT_CONTRACT_CASES.length} total, ${applied.length} run, ${COMMENT_CONTRACT_CASES.length - applied.length} n/a`);
registerCommentContract(harness, { describe, it: (name, fn) => (NA_ROOT.has(name.split(":")[0]) || [...NA_ROOT].some((id) => name.startsWith(id.slice(0, 5))) ? it.skip(name, fn) : it(name, fn)) }, "hfy comments adapter over mocked /api");
