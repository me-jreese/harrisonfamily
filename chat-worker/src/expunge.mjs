// The hub half of the admin route (HFY-TSK-337): a mixin over the kit's ChatHub that nulls one message's text everywhere the hub
// holds it, and makes every later read show that message as removed.
//
// What the hub keeps a message's text in (@io-kit/chat 0.1.6; the tests pin each place, and walk the object for any other):
//   1. the `msg` table of the object's SQLite storage: `text` becomes NULL; `seq`, `from_uid`, `cmid`, `kind` and `ts` stay, so the
//      order, the sender, a retried send's ack and the 30-day window do not move;
//   2. the archive: the batch a drain is posting right now holds the text in memory, and the next batch is read from (1). An expunge
//      waits for a drain in flight to settle before it nulls, so the text it answers "nulled" for cannot be posted afterwards (the
//      caller deletes the mirror row only once this route answered, and the order matters);
//   3. there is no ring buffer, no history cache and no outbox that carries text: pushes are `{recipient, conv, seq, actor}` and the
//      directory is labels. The object graph walk in the tests fails if a later kit adds one.
// A read after the expunge (a `page`, or the `resume` batch of a `hello`) shows `{text: null, expunged: true}` at the same seq.
//
// The kit builds its history frames from `store.visible()` and `core.toMsg()`; both are patched on the instance here, because the
// kit has no notion of a removed message (a follow-up for the kit: see docs/how-to/deploy-the-chat-worker.md).
import { MAX_BODY_CHARS, HUB_ADMIN_PATH, adminConfigured, bearerOk, json, parseBody, readCapped } from "./admin.mjs";

/** Installs the read side on a hub: rows that were nulled come back from the store and out of the core as removed. */
function installReads(hub, sql) {
  const store = hub.store;
  const core = hub.core;
  if (typeof store?.visible !== "function" || typeof store?.archiveBatches !== "function" || typeof core?.toMsg !== "function") {
    // A kit that moved these must fail the first test, not quietly serve the text of a removed message.
    throw new Error("expunge: the kit's hub no longer has store.visible, store.archiveBatches or core.toMsg");
  }
  /** A message row the store read as an empty string (or null) is a candidate; the table says whether it was nulled. */
  const mark = (conv, rows) => {
    const cand = rows.filter((r) => r.kind === "msg" && (r.text === "" || r.text === null));
    if (cand.length === 0) return rows;
    const lo = Math.min(...cand.map((r) => r.seq));
    const hi = Math.max(...cand.map((r) => r.seq));
    const gone = new Set(
      sql.exec("SELECT seq FROM msg WHERE conv = ? AND kind = 'msg' AND text IS NULL AND seq BETWEEN ? AND ?", conv, lo, hi).toArray().map((r) => Number(r.seq)),
    );
    for (const r of cand) {
      if (gone.has(r.seq)) {
        r.text = null;
        r.expunged = true;
      }
    }
    return rows;
  };
  const visible = store.visible.bind(store);
  store.visible = (uid, conv, q) => mark(conv, visible(uid, conv, q));
  const batches = store.archiveBatches.bind(store);
  store.archiveBatches = (maxMsgs, maxConvs) => {
    const out = batches(maxMsgs, maxConvs);
    for (const b of out) mark(b.conv.id, b.msgs);
    return out;
  };
  const toMsg = core.toMsg.bind(core);
  core.toMsg = (row) =>
    row.kind === "msg" && row.expunged === true
      ? { conv: row.conv, seq: row.seq, cmid: row.cmid, from: row.from, ts: row.ts, kind: "msg", text: null, expunged: true }
      : toMsg(row);
}

/** How many drains one expunge waits for. A drain is single-flight and runs at most 50 rounds, so more than a couple is already odd. */
const SETTLE_ROUNDS = 20;

/**
 * Wait for the archive drain in flight, if any: its batch was read before this expunge and still holds the text. Loops until none is
 * running (a new one can start the moment one ends), at most SETTLE_ROUNDS drains: there is no timer in this bundle, so the bound is
 * a count. Returns false when a drain is still running at the end, and the route answers 503 so the caller retries instead of being
 * told "nulled" while a batch with the text may still be posted.
 */
async function settleArchive(server) {
  for (let i = 0; i < SETTLE_ROUNDS && server?.archiving; i++) {
    try {
      await server.archiving;
    } catch {
      /* a failed drain is retried by the next alarm, from the table */
    }
  }
  return !server?.archiving;
}

/**
 * `withExpunge(Base)` is `Base` plus the admin route. `Base` is the kit's `ChatHub` or a `chatHubClass(...)` result; the constructor
 * arguments pass through untouched.
 */
export function withExpunge(Base) {
  return class extends Base {
    #ctx;
    #env;

    constructor(...args) {
      super(...args);
      this.#ctx = args[0];
      this.#env = args[1] ?? {};
      installReads(this, this.#ctx.storage.sql);
    }

    async fetch(request) {
      if (new URL(request.url).pathname === HUB_ADMIN_PATH) return this.#admin(request);
      return super.fetch(request);
    }

    async #admin(request) {
      if (!(await bearerOk(request, this.#env))) return adminConfigured(this.#env) ? json(401, { error: "unauthorized" }) : json(404, { error: "not_found" });
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const text = await readCapped(request);
      if (text === null || text.length > MAX_BODY_CHARS) return json(413, { error: "too_large" });
      const ref = parseBody(text);
      if (!ref) return json(400, { error: "bad_request" });
      await this.ready;
      await settleArchive(this.server);
      // From here to the return there is no await: the read, the update and the answer are one step of the object.
      const sql = this.#ctx.storage.sql;
      const nulled = this.#ctx.storage.transactionSync(() => {
        // A drain may have started between the last wait and this step; this check is the one that counts, because nothing can start one
        // from here to the update. Busy: touch nothing, and the caller retries.
        if (this.server?.archiving) return "busy";
        const row = sql.exec("SELECT kind, text FROM msg WHERE conv = ? AND seq = ?", ref.conv, ref.seq).toArray()[0];
        if (!row) return null;
        if (row.kind !== "msg" || row.text === null || row.text === undefined) return 0;
        sql.exec("UPDATE msg SET text = NULL WHERE conv = ? AND seq = ? AND kind = 'msg'", ref.conv, ref.seq);
        return 1;
      });
      if (nulled === "busy") return json(503, { error: "archive_busy" }, { "retry-after": "5" });
      return nulled === null ? json(404, { error: "not_found" }) : json(200, { nulled });
    }
  };
}
