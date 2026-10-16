// Store-scoped recovery for the cloud record store (HFY-TSK-275; review SI-04; BRD2 19.8). Imported by sync-admin.mjs, which owns the CLI.
//
//   rebuild-heads --to-seq N   refold REC#, GID# and IDALIAS# in place from the append-only SYNC#LOG (src/sync/refold.js). A rollback does not bring
//                              back a privacy withdraw (unless --include-withdrawn, and then only inside the 72-hour grace), a merge or a Media.
//   copy-back --from-table T   when the log itself is damaged: copy only REC#, SYNC#, GID# and IDALIAS# items from a side table
//                              (a point-in-time restore of the app table to a NEW table) back into the live table.
//   bump-tree-id [--reseed]    give the store a new tree_id: every desktop gets 403 tree_mismatch and runs `hfy-sync rebase`.
//
// TABLE_NAME is never swapped. A table swap would roll back every domain that lives in the table (members, posts, comments, uploads,
// chat, notifications), which is the hazard review SI-04 closes. These commands touch the four sync partitions and nothing else, and the
// tests prove it: every item outside them is byte for byte what it was.
//
// Every --apply needs the store paused first (`sync-admin.mjs pause --all --apply`): applyBatch() then refuses every origin, so nothing
// races the rewrite. Each write transaction is guarded by a ConditionCheck on SYNC#HEAD (still paused, still the seq that was read), so a
// resume or a write in the middle stops the run at the next chunk; rerun the dry run to see what is left. The audit trail is one
// SYNC#ADMIN item per run (a partition no recovery overwrites or deletes). Output names classes, opaque handles, field names, versions and
// counts: never object text and never a gramps_id.
import { randomUUID } from "node:crypto";
import { PRINCIPAL, ADMIN_PK, SYNC_PREFIXES, checkLog, diffItems, foldLog, isSyncPartition, itemPk, planRollback, withdrawWarning } from "../src/sync/refold.js";
import { headKey, seqKey } from "../src/sync/store.js";

export class RecoveryError extends Error {}

const CHUNK_ITEMS = 25;
const CHUNK_BYTES = 3_000_000; // a transaction is capped at 4 MB; an object is up to 200 KB and the head and the log each hold a copy
const LOG_CHUNK = 20;
const SHOWN = 30;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const iso = (now) => new Date(now()).toISOString();
const epochOf = (head) => (Number.isInteger(head?.expunge_epoch) ? head.expunge_epoch : 0); // SYNC#HEAD.expunge_epoch, absent = 0 (the rule of every consumer)
const bytes = (item) => Buffer.byteLength(JSON.stringify(item));

const get = async ({ ddb, cmds }, table, Key) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;

async function pages(ctx, make) {
  const out = [];
  let key;
  for (let i = 0; i < 10000; i += 1) {
    const r = await ctx.ddb.send(make(key));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return out;
  }
  throw new RecoveryError("a listing did not end; stopping");
}

/** The whole change log of a table, in seq order. */
export const readLog = (ctx, table) =>
  pages(ctx, (key) => new ctx.cmds.QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "SYNC#LOG" }, ConsistentRead: true, ...(key ? { ExclusiveStartKey: key } : {}) }));

/** Every item of the sync partitions of a table (SYNC#ADMIN excluded), one scan. */
export async function readSync(ctx, table) {
  const values = Object.fromEntries(SYNC_PREFIXES.map((p, i) => [`:p${i}`, p]));
  const filter = SYNC_PREFIXES.map((_, i) => `begins_with(PK, :p${i})`).join(" OR ");
  const items = await pages(ctx, (key) => new ctx.cmds.ScanCommand({ TableName: table, FilterExpression: filter, ExpressionAttributeValues: values, ConsistentRead: true, ...(ctx.scanLimit ? { Limit: ctx.scanLimit } : {}), ...(key ? { ExclusiveStartKey: key } : {}) }));
  return items.filter((i) => isSyncPartition(i.PK));
}
const byPrefix = (items, prefix) => new Map(items.filter((i) => i.PK.startsWith(prefix)).map((i) => [itemPk(i), i]));

/** Splits `list` into chunks of at most `maxItems` items and about `maxBytes` bytes (`sizeOf` gives an item's size). */
function chunkSized(list, sizeOf, maxItems, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const x of list) {
    const b = sizeOf(x);
    if (cur.length >= maxItems || (cur.length > 0 && size + b > maxBytes)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(x);
    size += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Splits write operations into transactions of at most 25 items and about 3 MB. */
export const chunkOps = (ops) => chunkSized(ops, (op) => (op.put ? bytes(op.put) : 200), CHUNK_ITEMS);

/** Splits appended log entries into transactions of at most 20 entries (one more slot goes to the SYNC#HEAD update) and about 3 MB. */
export const chunkLog = (entries) => chunkSized(entries, bytes, LOG_CHUNK);

const guard = (table, seq) => ({
  ConditionCheck: {
    TableName: table, Key: headKey(), ConditionExpression: "#we = :f AND #s = :s", ExpressionAttributeNames: { "#we": "writes_enabled", "#s": "seq" },
    ExpressionAttributeValues: { ":f": false, ":s": seq },
  },
});
const toTxn = (table, op) => (op.put ? { Put: { TableName: table, Item: op.put } } : { Delete: { TableName: table, Key: op.del } });
const send = (ctx, items) => ctx.ddb.send(new ctx.cmds.TransactWriteCommand({ TransactItems: items }));

function auditPut(ctx, op, by, at, detail) {
  return { Put: { TableName: ctx.table, Item: { PK: ADMIN_PK, SK: `${at}#${op}#${randomUUID().slice(0, 8)}`, entity: "syncadmin", op: `sync-admin.${op}`, by, at, ...detail } } };
}

function requirePaused(head, what) {
  if (!head) throw new RecoveryError(`there is no SYNC#HEAD item: ${what} needs an initialised store`);
  if (head.writes_enabled !== false) throw new RecoveryError(`writes are not paused: run "sync-admin.mjs pause --all --apply" first, then --apply ${what}`);
}

const listLines = (log, label, rows) => {
  for (const r of rows.slice(0, SHOWN)) log(`  ${label}  ${r}`);
  if (rows.length > SHOWN) log(`  ... and ${rows.length - SHOWN} more ${label} line(s)`);
};
const fieldNote = (p) => `${p.kind}${p.fields?.length ? `: ${p.fields.join(", ")}` : ""}`;

// ---- rebuild-heads ------------------------------------------------------------------------------------------------------------
/** Parses --to-seq: a non-negative integer or the word `head`. */
export function parseToSeq(value, headSeq) {
  if (value === "head") return headSeq;
  if (!/^\d{1,12}$/.test(String(value ?? ""))) throw new RecoveryError('--to-seq needs a seq number (or "head" for the log\'s last seq)');
  const n = Number(value);
  if (n > headSeq) throw new RecoveryError(`--to-seq ${n} is past the last seq of the log (${headSeq})`);
  return n;
}

/**
 * Plans (and with `apply`, performs) the refold. Returns { plan, applied }.
 * When toSeq is behind the log's tail the store is rolled back to that seq by appended admin entries (planRollback), so the log stays
 * append-only and heads == fold(log) holds afterwards.
 */
export async function rebuildHeads(ctx, { apply, toSeq, by = "operator", includeWithdrawn = false }) {
  const { log, table } = ctx;
  const head = await get(ctx, table, headKey());
  if (!head) throw new RecoveryError("there is no SYNC#HEAD item: the store is not initialised, so there is nothing to rebuild");
  const headSeq = Number.isInteger(head.seq) ? head.seq : 0;
  const target = parseToSeq(toSeq, headSeq);
  const entries = await readLog(ctx, table);
  const check = checkLog(entries, headSeq);
  log(`rebuild-heads: the log holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; SYNC#HEAD.seq is ${headSeq}`);
  if (!check.ok) {
    for (const p of check.problems.slice(0, 10)) log(`  damaged  ${p.code} at seq ${p.seq}`);
    throw new RecoveryError(`the log is damaged (${check.problems.length}${check.problems.length >= 50 ? "+" : ""} problem(s)), so the heads cannot be refolded from it: restore a side table and use copy-back (docs/how-to/operate-the-sync-store.md)`);
  }
  const at = iso(ctx.now);
  const { entries: rollback, skipped, refused, withdrawn, media: mediaRolled } = planRollback(entries, target, { at, batchId: `rebuild:${target}:${headSeq}`, includeWithdrawn });
  const stored = await readSync(ctx, table);
  const storedHeads = byPrefix(stored, "REC#");
  const blobs = new Map([...storedHeads.values()].filter((i) => i.class === "Media" && i.deleted !== true && i.blob !== undefined).map((i) => [`${i.class}#${i.handle}`, i.blob]));
  const storedAliases = new Map([...byPrefix(stored, "IDALIAS#").values()].map((i) => [`${i.class}#${i.old_gramps_id}`, i]));
  const folded = foldLog([...entries, ...rollback], { blobs, aliases: storedAliases });
  const keepHeads = new Set(folded.expunged.map((k) => `REC#${k}\u0000HEAD`));
  const dHeads = diffItems(folded.heads, storedHeads, keepHeads);
  const dGids = diffItems(folded.gids, byPrefix(stored, "GID#"));
  const dAliases = diffItems(folded.aliases, byPrefix(stored, "IDALIAS#"));
  const finalSeq = headSeq + rollback.length;
  const countable = typeof head.live_heads === "number";
  const liveFix = countable && head.live_heads !== folded.live ? { from: head.live_heads, to: folded.live } : null;

  log(`rebuild-heads: refolding to seq ${target}${rollback.length ? `: ${rollback.length} appended admin entr${rollback.length === 1 ? "y" : "ies"} (seq ${headSeq + 1}..${finalSeq}) put the store back to that state` : ""}`);
  log(`heads:   ${dHeads.unchanged} match, ${dHeads.puts.length} to write, ${dHeads.deletes.length} to delete${folded.expunged.length ? `, ${folded.expunged.length} expunged (kept)` : ""}`);
  log(`gid:     ${dGids.unchanged} match, ${dGids.puts.length} to write, ${dGids.deletes.length} to delete`);
  log(`idalias: ${dAliases.unchanged} match, ${dAliases.puts.length} to write, ${dAliases.deletes.length} to delete`);
  log(`live_heads: ${countable ? (liveFix ? `stored ${liveFix.from}, folded ${liveFix.to}: will be corrected` : `${folded.live}, correct`) : "not counted; left as it is"}`);
  if (skipped.length) log(`note: ${skipped.length} object(s) were expunged by a privacy erasure at or after seq ${target}; their text is gone from the log, so they are left as they are (expunged: left as is)`);
  if (refused.length) log(`note: ${refused.length} deleted or withdrawn object(s) would have been re-created by this rollback; they stay tombstones (refused, reasons below). Privacy withdraws need --include-withdrawn and io's explicit go-ahead; a merge, a Media and a withdraw past the 72-hour grace are not brought back by this tool`);
  if (mediaRolled.length) log(`note: ${mediaRolled.length} live Media head(s) go back to older text but keep their newest blob descriptor (it is not in the log); check each file's sha256 and size afterwards`);
  const mediaRewritten = dHeads.puts.filter((p) => p.item.class === "Media" && p.item.deleted !== true && p.item.blob !== undefined).length;
  if (mediaRewritten && !mediaRolled.length) log(`note: ${mediaRewritten} live Media head(s) are rewritten with the blob descriptor the store holds; check each file's sha256 and size afterwards`);
  if (folded.blobsUnknown) log(`note: ${folded.blobsUnknown} live Media head(s) have no blob descriptor in the store; the log does not hold it, so they are written without one`);
  if (folded.mergeAliasesUnknown) log(`note: ${folded.mergeAliasesUnknown} merge alias(es) have no survivor id in the store or the log; written with none`);
  listLines(log, "expunged", skipped.map((k) => `left as is ${k.split("#")[0]} ${k.slice(k.indexOf("#") + 1)}`));
  listLines(log, "refused ", refused.map((r) => `left as is ${r.key.split("#")[0]} ${r.key.slice(r.key.indexOf("#") + 1)}: ${r.reason}`));
  listLines(log, "rollback", rollback.map((e) => `${e.op} ${e.class} ${e.handle} v${e.version} (seq ${e.seq})`));
  if (withdrawn.length) log(withdrawWarning(withdrawn.length));
  listLines(log, "head   ", [...dHeads.puts.map((p) => `put ${p.item.class} ${p.item.handle} v${p.item.version} (${fieldNote(p)})`), ...dHeads.deletes.map((d) => `delete ${d.item.class} ${d.item.handle}`)]);
  listLines(log, "gid    ", [...dGids.puts.map((p) => `put ${p.item.class} (${fieldNote(p)})`), ...dGids.deletes.map((d) => `delete ${d.item.class}`)]);
  listLines(log, "idalias", [...dAliases.puts.map((p) => `put ${p.item.class} (${fieldNote(p)})`), ...dAliases.deletes.map((d) => `delete ${d.item.class}`)]);
  const writes = dHeads.puts.length + dHeads.deletes.length + dGids.puts.length + dGids.deletes.length + dAliases.puts.length + dAliases.deletes.length + rollback.length + (liveFix ? 1 : 0);
  const plan = { target, headSeq, finalSeq, rollback, skipped, refused, withdrawn, media: mediaRolled, heads: dHeads, gids: dGids, aliases: dAliases, liveFix, writes };
  log(`plan: ${writes === 0 ? "nothing to change: the heads already equal the log" : `${writes} write(s)`}`);
  if (!apply) {
    log("dry run: nothing written");
    return { plan, applied: 0 };
  }
  requirePaused(head, "rebuild-heads");

  // Phase A: the appended entries, in transactions that also move SYNC#HEAD.seq (pinned to the seq read and to the pause).
  let seq = headSeq;
  for (const chunk of chunkLog(rollback)) {
    const to = seq + chunk.length;
    await send(ctx, [
      {
        Update: {
          TableName: table, Key: headKey(), UpdateExpression: "SET #s = :to, #u = :at", ConditionExpression: "#s = :old AND #we = :f",
          ExpressionAttributeNames: { "#s": "seq", "#u": "updated_at", "#we": "writes_enabled" }, ExpressionAttributeValues: { ":to": to, ":old": seq, ":at": at, ":f": false },
        },
      },
      ...chunk.map((e) => ({ Put: { TableName: table, Item: e, ConditionExpression: "attribute_not_exists(PK)" } })),
    ]);
    seq = to;
    log(`applied: ${chunk.length} log entr${chunk.length === 1 ? "y" : "ies"}, seq ${seqKey(to - chunk.length + 1)}..${seqKey(to)}`);
  }
  // Phase B: the heads, GID and alias items, guarded by the pause and the final seq.
  const ops = [
    ...dHeads.puts.map((p) => ({ put: p.item })), ...dHeads.deletes.map((d) => ({ del: d.key })),
    ...dGids.puts.map((p) => ({ put: p.item })), ...dGids.deletes.map((d) => ({ del: d.key })),
    ...dAliases.puts.map((p) => ({ put: p.item })), ...dAliases.deletes.map((d) => ({ del: d.key })),
  ];
  let written = 0;
  for (const chunk of chunkOps(ops)) {
    await send(ctx, [guard(table, finalSeq), ...chunk.map((op) => toTxn(table, op))]);
    written += chunk.length;
    log(`applied: ${chunk.length} item(s) (${written} of ${ops.length})`);
  }
  const detail = { to_seq: target, head_seq: headSeq, final_seq: finalSeq, appended: rollback.length, refused: refused.length, withdrawn_recreated: withdrawn.length, heads_written: dHeads.puts.length, heads_deleted: dHeads.deletes.length, gid_written: dGids.puts.length, gid_deleted: dGids.deletes.length, alias_written: dAliases.puts.length, alias_deleted: dAliases.deletes.length };
  const last = [auditPut(ctx, "rebuild-heads", by, at, detail)];
  if (liveFix) {
    last.unshift({
      Update: {
        TableName: table, Key: headKey(), UpdateExpression: "SET #lh = :to, #u = :at", ConditionExpression: "#s = :s AND #we = :f AND #lh = :from",
        ExpressionAttributeNames: { "#lh": "live_heads", "#u": "updated_at", "#s": "seq", "#we": "writes_enabled" }, ExpressionAttributeValues: { ":to": liveFix.to, ":from": liveFix.from, ":at": at, ":s": finalSeq, ":f": false },
      },
    });
  } else last.unshift(guard(table, finalSeq));
  await send(ctx, last);
  log(`applied: ${written} item(s) rewritten${liveFix ? ", live_heads corrected" : ""}. Run rebuild-heads --dry-run again: it must report nothing to change.`);
  return { plan, applied: writes };
}

// ---- copy-back ----------------------------------------------------------------------------------------------------------------
/**
 * Copies the sync partitions of a side table (a PITR restore of the app table to a new name) into the live table: puts what differs,
 * deletes what the side table lacks, and touches nothing outside REC#, SYNC#, GID# and IDALIAS#. SYNC#HEAD comes across with
 * writes_enabled forced to false, so the restored store stays paused until bump-tree-id, the desktop rebases and `resume`, and with
 * expunge_epoch set to max(live, restore point) + 1: the restore moves seq backwards, and the epoch is the one value every cache of the
 * store (the store view, snapshots/, the graph marker, the desktop's delta cache) already checks besides seq.
 */
export async function copyBack(ctx, { apply, fromTable, by = "operator" }) {
  const { log, table } = ctx;
  if (!TABLE_NAME.test(String(fromTable ?? ""))) throw new RecoveryError("--from-table needs the name of the side table");
  if (fromTable === table) throw new RecoveryError("--from-table is the live table itself: restore the point-in-time copy to a NEW table first, and name that one");
  const srcHead = await get(ctx, fromTable, headKey());
  if (!srcHead) throw new RecoveryError("the side table has no SYNC#HEAD item: it is not a restore of the app table");
  const srcEntries = await readLog(ctx, fromTable);
  const check = checkLog(srcEntries, Number.isInteger(srcHead.seq) ? srcHead.seq : 0);
  if (!check.ok) {
    for (const p of check.problems.slice(0, 10)) log(`  damaged  ${p.code} at seq ${p.seq}`);
    throw new RecoveryError("the side table's log is damaged too; restore from an earlier point in time");
  }
  const tgtHead = await get(ctx, table, headKey());
  const src = await readSync(ctx, fromTable);
  const tgt = await readSync(ctx, table);
  const stored = new Map(tgt.map((i) => [itemPk(i), i]));
  // SYNC#HEAD comes across paused, and with expunge_epoch above both the live table's and the restore point's. Every consumer of the store
  // keys its cache on that epoch (the store view of each warm Lambda, snapshots/<seq>.jsonl.gz, the graph render marker, the desktop's
  // delta cache), and the restore moves seq BACKWARDS, where seq alone cannot tell a cache of the abandoned timeline from the new one.
  // Once nothing else differs the epoch is left where it is, so a second run finds the store converged (the head is not bumped again).
  const liveEpoch = epochOf(tgtHead);
  const restoredEpoch = epochOf(srcHead);
  const withEpoch = (item, epoch) => (epoch > 0 || item.expunge_epoch !== undefined ? { ...item, expunge_epoch: epoch } : item); // an absent epoch stays absent while it is 0
  const expectedFor = (epoch) => new Map(src.map((item) => [itemPk(item), item.PK === "SYNC#HEAD" ? withEpoch({ ...item, writes_enabled: false }, epoch) : item]));
  let epoch = Math.max(liveEpoch, restoredEpoch);
  let d = diffItems(expectedFor(epoch), stored);
  if (d.puts.length + d.deletes.length > 0) {
    epoch += 1;
    d = diffItems(expectedFor(epoch), stored);
  }
  const part = (p) => ({ puts: d.puts.filter((x) => x.item.PK.startsWith(p)).length, deletes: d.deletes.filter((x) => x.item.PK.startsWith(p)).length });
  log(`copy-back: side table has ${src.length} sync item(s) and a log of ${srcEntries.length} entr${srcEntries.length === 1 ? "y" : "ies"} (seq ${srcHead.seq ?? 0}); the live table has ${tgt.length} sync item(s), log seq ${tgtHead?.seq ?? "none"}`);
  for (const p of SYNC_PREFIXES) {
    const c = part(p);
    log(`${p.padEnd(9)} ${c.puts} to write, ${c.deletes} to delete`);
  }
  log(`${d.unchanged} item(s) already match; no other partition is read for writing or touched`);
  const liveSeq = Number.isInteger(tgtHead?.seq) ? tgtHead.seq : 0;
  const restoredSeq = Number.isInteger(srcHead.seq) ? srcHead.seq : 0;
  if (restoredSeq < liveSeq) {
    log(`note: the live log reached seq ${liveSeq} and the restore holds ${restoredSeq}, so ${liveSeq > restoredSeq + 1 ? `seqs ${restoredSeq + 1}..${liveSeq} will` : `seq ${liveSeq} will`} be used again by new writes. The notification claims (RECFAN#) of ${liveSeq > restoredSeq + 1 ? "those seqs are" : "that seq are"} outside the sync partitions and stay: notifications for the reused seq(s) can be dropped as already sent (docs/how-to/operate-the-sync-store.md)`);
  }
  log(`SYNC#HEAD: written with writes_enabled false${tgtHead?.tree_id !== srcHead.tree_id ? "; its tree_id differs from the live table's" : ""}`);
  const bumped = epoch > Math.max(liveEpoch, restoredEpoch);
  log(`expunge_epoch: live ${liveEpoch}, restore point ${restoredEpoch}: ${bumped ? `written as ${epoch}, so every warm store view, cached snapshot, graph build and desktop delta cache built on the abandoned timeline is dropped (the restore moves seq backwards, which seq alone cannot show them)` : `stays ${epoch} (nothing else differs)`}`);
  const what = (item) => [`${item.PK.split("#")[0]}#`, item.class, item.PK.startsWith("REC#") ? item.handle : undefined].filter(Boolean).join(" ");
  listLines(log, "write ", d.puts.map((p) => `${what(p.item)} (${fieldNote(p)})`));
  listLines(log, "delete", d.deletes.map((x) => what(x.item)));
  const plan = { puts: d.puts.length, deletes: d.deletes.length, unchanged: d.unchanged, epoch };
  log(`plan: ${plan.puts + plan.deletes === 0 ? "nothing to copy" : `${plan.puts} to write, ${plan.deletes} to delete`}`);
  if (!apply) {
    log("dry run: nothing written");
    return { plan, applied: 0 };
  }
  requirePaused(tgtHead, "copy-back");
  const headPut = d.puts.find((p) => p.item.PK === "SYNC#HEAD");
  const ops = [...d.puts.filter((p) => p !== headPut).map((p) => ({ put: p.item })), ...d.deletes.filter((x) => x.item.PK !== "SYNC#HEAD").map((x) => ({ del: x.key }))];
  let written = 0;
  for (const chunk of chunkOps(ops)) {
    await send(ctx, [
      { ConditionCheck: { TableName: table, Key: headKey(), ConditionExpression: "#we = :f", ExpressionAttributeNames: { "#we": "writes_enabled" }, ExpressionAttributeValues: { ":f": false } } },
      ...chunk.map((op) => toTxn(table, op)),
    ]);
    written += chunk.length;
    log(`applied: ${chunk.length} item(s) (${written} of ${ops.length})`);
  }
  const at = iso(ctx.now);
  const final = [auditPut(ctx, "copy-back", by, at, { from_table: fromTable, written: plan.puts, deleted: plan.deletes, expunge_epoch: epoch })];
  if (headPut) {
    final.unshift({ Put: { TableName: table, Item: headPut.item, ConditionExpression: "#we = :f", ExpressionAttributeNames: { "#we": "writes_enabled" }, ExpressionAttributeValues: { ":f": false } } });
  }
  await send(ctx, final);
  log(`applied: ${plan.puts} written, ${plan.deletes} deleted. The store is still paused. Next: rebuild-heads --to-seq head --dry-run (must report nothing), then bump-tree-id.`);
  return { plan, applied: plan.puts + plan.deletes };
}

// ---- bump-tree-id -------------------------------------------------------------------------------------------------------------
/**
 * Sets SYNC#HEAD.tree_id to a new uuid. From then on a desktop that names the old tree gets 403 tree_mismatch on a push, and its pull
 * stops at the handshake (D50), until the person runs `hfy-sync rebase`. With `reseed` the store is also marked not seeded and the open
 * push session pointer is cleared: the next session carries seed:true, so its batches are origin "seed" and silent (no notifications).
 */
export async function bumpTreeId(ctx, { apply, by = "operator", reseed = false }) {
  const { log, table } = ctx;
  const head = await get(ctx, table, headKey());
  if (!head) throw new RecoveryError("there is no SYNC#HEAD item: the store is not initialised, so there is no tree to give a new id");
  if (!head.tree_id) throw new RecoveryError("the store has no tree_id yet (nothing is bound): there is nothing to bump");
  log(`bump-tree-id: writes_enabled is ${head.writes_enabled === undefined ? "absent (enabled)" : String(head.writes_enabled)}; seeded ${head.seeded === true}`);
  log("bump-tree-id: the tree_id will change; every desktop gets 403 tree_mismatch (push) or D50 at the handshake (pull) until it runs hfy-sync rebase; nothing is pushed automatically");
  if (reseed) log("bump-tree-id: --reseed marks the store not seeded: web and proposal writes are refused (503 store_not_seeded) until a seed session completes; the next session carries seed:true and its batches are silent");
  if (!apply) {
    log("dry run: nothing written");
    return { changed: false };
  }
  requirePaused(head, "bump-tree-id");
  const at = iso(ctx.now);
  const next = (ctx.uuid ?? randomUUID)();
  const names = { "#t": "tree_id", "#u": "updated_at", "#we": "writes_enabled", "#s": "seq" };
  const values = { ":new": next, ":old": head.tree_id, ":at": at, ":f": false, ":s": head.seq ?? 0 };
  let update = "SET #t = :new, #u = :at";
  if (reseed) {
    names["#sd"] = "seeded";
    names["#os"] = "open_session";
    values[":no"] = false;
    update = "SET #t = :new, #u = :at, #sd = :no REMOVE #os";
  }
  if (head.seq === undefined) throw new RecoveryError("SYNC#HEAD has no seq");
  await send(ctx, [
    { Update: { TableName: table, Key: headKey(), UpdateExpression: update, ConditionExpression: "#t = :old AND #we = :f AND #s = :s", ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
    auditPut(ctx, "bump-tree-id", by, at, { reseed, seq: head.seq }),
  ]);
  log(`bump-tree-id: tree_id changed${reseed ? "; the store is marked not seeded" : ""}. The store is still paused: resume it after the desktop has rebased.`);
  return { changed: true, treeId: next };
}

export { PRINCIPAL };
