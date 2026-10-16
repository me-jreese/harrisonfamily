// HFY-TSK-277 (changes-feed; sync.md 7.2, BRD2 11.1 and the PS-05 row): GET /api/sync/changes, the ARCH-B dense change feed.
//
//   GET /api/sync/changes?since=<seq>&limit=<1..500>
//     200 { ops: [{seq, op, class, handle, gramps_id, version, hash, obj, at, origin, expunged?}], head_seq, next_since, dense: true, expunge_epoch }
//     400 bad_cursor   since is beyond the head (the log is shorter than the client believes: a restore, or a client bug)
//     400 validation   since or limit is not an integer in range
//     404 not_enabled  SYNC#HEAD.changes_feed is not the boolean true (the server switch; default off, so the route is dark until io flips it)
//     410 gap_too_large the log read from since+1 is missing a seq (the log is kept forever, so this is reserved for damage): take a snapshot
//
// "Dense" means every seq in (since, next_since] is in `ops`, in order, with no holes: a marker entry (a session close) is an op with `op:
// "marker"` and a null class, handle and object, so a client can prove it missed nothing by checking that the seqs run one by one. A client
// that cannot (a hole, a version that does not follow the one it holds, an object that does not hash to `hash`) must take a full snapshot.
//
// What an op carries. `obj` is the redacted canonical object the log entry holds for a create or an update, and null for a delete, a
// withdraw or a marker (a tombstone). `hash` is the entry's sha256 of that object. An entry privacy-expunge has scrubbed (`expunged: true`
// on the log item) keeps its seq and version but returns `obj: null, expunged: true`, so the object value never leaves the store again; a
// client that reads such an op must not trust its cached copy of that head and takes a snapshot. The principal, the batch id and the
// on-behalf-of subject are never returned.
//
// `expunge_epoch` (SYNC#HEAD.expunge_epoch, absent = 0) is what lets a client with a cached state notice a scrub in place: an expunge rewrites
// log entries and heads without advancing seq, so a cache at the head seq looks current while it still holds the old value. The client
// compares the epoch it cached with this one and takes a snapshot when they differ (the snapshot route keys its own cache on the same epoch).
//
// Paging. A page holds at most `limit` ops and at most RESPONSE_OBJ_BYTES of object text, and always at least one op, so a response stays
// under the Lambda response limit. `next_since` is the seq of the last op returned (or `since` when there are none), so a client pages with
// next_since until it equals head_seq.
import { HttpError, logSafeError } from "../http.js";
import { logKey, seqKey } from "./store.js";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
/** Object text per page: DynamoDB reads are 1 MB a page and the Lambda response limit is 6 MB; a single object is at most 200 KB. */
export const RESPONSE_OBJ_BYTES = 3_000_000;

const SEQ = /^\d{1,12}$/;
const bad = (field, message) => new HttpError(400, "validation", message ?? `${field} is invalid`, { fields: [{ field, code: "invalid" }] });

function intParam(raw, field, { min, max, fallback }) {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || !SEQ.test(raw)) throw bad(field);
  const n = Number(raw);
  if (n < min || n > max) throw bad(field);
  return n;
}

/** The wire shape of one log item. Exported for the tests. */
export function changeOp(item) {
  const expunged = item.expunged === true;
  const live = (item.op === "create" || item.op === "update") && !expunged && typeof item.obj_json === "string";
  return {
    seq: item.seq,
    op: item.op,
    class: item.class ?? null,
    handle: item.handle ?? null,
    gramps_id: item.gramps_id ?? "",
    version: Number.isInteger(item.version) ? item.version : null,
    hash: live && typeof item.hash === "string" ? item.hash : null,
    obj: live ? JSON.parse(item.obj_json) : null,
    at: item.at,
    origin: item.origin,
    ...(expunged ? { expunged: true } : {}),
  };
}

const gap = () => new HttpError(410, "gap_too_large", "the change log has a gap after that cursor; take a snapshot");

/** GET /api/sync/changes. */
export async function syncChanges(c) {
  const { store, head } = c.sync;
  if (head?.changes_feed !== true) throw new HttpError(404, "not_enabled", "the change feed is not enabled");
  c.sync.checkTree();
  const q = c.query ?? {};
  const headSeq = Number.isInteger(head?.seq) ? head.seq : 0;
  const since = intParam(q.since, "since", { min: 0, max: 999_999_999_999, fallback: 0 });
  const limit = intParam(q.limit, "limit", { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  if (since > headSeq) throw new HttpError(400, "bad_cursor", "since is beyond the head of the change log", { head_seq: headSeq });
  const epoch = Number.isInteger(head?.expunge_epoch) ? head.expunge_epoch : 0;

  const last = Math.min(since + limit, headSeq);
  const ops = [];
  let next = since + 1; // the seq the next item must have
  let bytes = 0;
  let full = false;
  let start;
  try {
    while (last > since && !full) {
      const r = await store.ddb.send(new store.cmds.QueryCommand({
        TableName: store.table,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": logKey(1).PK, ":lo": seqKey(since + 1), ":hi": seqKey(last) },
        ConsistentRead: true,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      for (const item of r.Items ?? []) {
        if (item.seq !== next || item.SK !== seqKey(next)) throw gap();
        const size = typeof item.obj_json === "string" ? item.obj_json.length : 0;
        if (ops.length > 0 && bytes + size > RESPONSE_OBJ_BYTES) { full = true; break; }
        ops.push(changeOp(item));
        bytes += size;
        next += 1;
      }
      start = r.LastEvaluatedKey;
      if (!start) break;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    store.log?.error?.("change feed read failed", logSafeError(e, { route: "sync.changes" }));
    throw new HttpError(503, "retryable", "the store is busy; retry");
  }
  if (!full && next !== last + 1 && last > since) throw gap(); // the page ended short of the head it was bounded by
  return { status: 200, body: { ops, head_seq: headSeq, next_since: ops.length ? ops[ops.length - 1].seq : since, dense: true, expunge_epoch: epoch } };
}
