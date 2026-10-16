// HFY-TSK-279 (sync-admin-status-page; sync.md 13.3, BRD2 11.1 7.1): the read behind /admin/sync/.
//
//   GET /api/sync/admin/status   {desktop, website, conflicts, batches}, for an hfy-admin or a gramps-owner session; anyone else is 403 not_allowed.
//
// It sits on the session cookie, behind SYNC_API_ENABLED (404 not_enabled when off). It only reads: the decision is POST /api/sync/conflicts/:id/decision
// (pull.js), which takes the gramps-owner's session plus a sign-in at most 300 s old. The page shows no member-facing data beyond the admin's own tree.
//   desktop    one entry per SYNC#CLIENT# heartbeat, newest first: addon and Gramps versions, the last run (result, counts, time).
//   website    head seq, rendered seq and the lag, the render mode, the last render error text, whether writes are paused and the store is seeded.
//   conflicts  the open queue (oldest first, up to 50) in the wire shape of conflictView, plus `owner`: whether this caller may decide, and `conflicts_more` when more than 50 are open.
//   `bound` is true once the head holds a tree_id. Desktop entries come from GSI1 (SYNCCLIENT), which only heartbeats written after HFY-TSK-279 carry, so a desktop appears after its next run.
//   The browser decision rides the session cookie (no tree-id handshake); Content-Type JSON (415 otherwise) is its CSRF guard, as for the other cookie POST routes. `manual` is add-on only.
//   batches    the ten newest push receipts: when, who (the principal), origin, the op count and the seq range. No ops, no object bodies.
import { HttpError } from "../http.js";
import { conflictView } from "./pull.js";

const ok = (body, status = 200) => ({ status, body });
const CONFLICTS_SHOWN = 50;
const CLIENTS_SHOWN = 10;
const BATCHES_SHOWN = 10;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v) => (Number.isInteger(v) ? v : null);

async function newest(store, pk, limit, forward = false) {
  const r = await store.ddb.send(new store.cmds.QueryCommand({
    TableName: store.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ScanIndexForward: forward, Limit: limit,
  }));
  return r.Items ?? [];
}

const clientView = (it) => ({
  id: String(it.client_instance_id ?? "").slice(0, 64), addon_version: it.addon_version ?? null, gramps_version: it.gramps_version ?? null, schema: int(it.schema), updated_at: it.updated_at ?? null,
  last_run: isObj(it.last_run) ? { action: it.last_run.action ?? null, result: it.last_run.result ?? null, exit_code: int(it.last_run.exit_code), counts: isObj(it.last_run.counts) ? it.last_run.counts : {}, finished_at: it.last_run.finished_at ?? null } : null,
});

const batchView = (it) => ({
  id: it.batch_id, at: it.at, by: it.principal ?? null, origin: it.origin ?? null, ops: Array.isArray(it.results) ? it.results.length : 0, seq_from: int(it.seq_from), seq_to: int(it.seq_to),
});

/** GET /api/sync/admin/status. */
export async function syncAdminStatus(c) {
  const owner = c.actor?.id ? (await c.isOwner(c.actor.id).catch(() => false)) === true : false;
  if (c.actor?.admin !== true && !owner) throw new HttpError(403, "not_allowed", "this page is for the people who look after the site");
  const store = { ddb: c.store.ddb, cmds: c.store.cmds, table: c.store.table };
  const get = async (Key) => (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key, ConsistentRead: true }))).Item;
  const [head, render, clients, conflicts, batches] = await Promise.all([
    get({ PK: "SYNC#HEAD", SK: "META" }), get({ PK: "SYNC#RENDER", SK: "STATE" }),
    newest(store, "SYNCCLIENT", CLIENTS_SHOWN), newest(store, "SYNCCONFLICT#open", CONFLICTS_SHOWN + 1, true), newest(store, "SYNCBATCH", BATCHES_SHOWN),
  ]);
  const headSeq = int(head?.seq) ?? 0;
  const rendered = int(render?.rendered_seq) ?? 0;
  const openRows = conflicts.filter((it) => it.PK?.startsWith("SYNC#CONFLICT#"));
  return ok({
    owner,
    desktop: clients.filter((it) => it.PK?.startsWith("SYNC#CLIENT#")).map(clientView),
    website: {
      head_seq: headSeq, rendered_seq: rendered, render_lag: Math.max(0, headSeq - rendered), render_mode: render?.mode ?? null,
      last_render_error: typeof render?.last_error === "string" ? render.last_error.slice(0, 300) : null,
      writes_enabled: head?.writes_enabled !== false, seeded: head?.seeded === true, bound: Boolean(head?.tree_id),
    },
    conflicts: openRows.slice(0, CONFLICTS_SHOWN).map(conflictView), conflicts_more: openRows.length > CONFLICTS_SHOWN,
    batches: batches.filter((it) => it.PK?.startsWith("SYNC#BATCH#")).map(batchView),
  });
}
