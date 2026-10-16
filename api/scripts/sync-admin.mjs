#!/usr/bin/env node
// Operator tooling for the cloud record store and its renderer (HFY-TSK-177; BRD2 D2-05, D2-33, 19.7; review DL-15, DL-28).
//
//   node scripts/sync-admin.mjs pause    --all --dry-run|--apply [--by <name>]
//   node scripts/sync-admin.mjs resume   --all --dry-run|--apply [--by <name>]
//   node scripts/sync-admin.mjs render   --dry-run|--apply (--full | --allow-mass-delete | --prune-foreign) [--function <name>]
//   node scripts/sync-admin.mjs resurrect --batch <batch_id> --dry-run|--apply [--include-withdrawn] [--by <name>]
//   node scripts/sync-admin.mjs rebuild-heads --to-seq <N|head> --dry-run|--apply [--by <name>]
//   node scripts/sync-admin.mjs copy-back  --from-table <side-table> --dry-run|--apply [--by <name>]
//   node scripts/sync-admin.mjs bump-tree-id [--reseed] --dry-run|--apply [--by <name>]
//   common: [--table hfy-app] [--region us-west-2]
//
//   pause      sets SYNC#HEAD.writes_enabled to false: applyBatch() then refuses every origin (desktop, seed, web edits, proposals,
//              graduation, moderation, tagging) with 503 sync_paused, and the desktop's push routes answer the same. `--all` names that
//              store-wide scope; the SYNC_API_ENABLED environment switch is the separate, desktop-only stop.
//   resume     sets it back to true.
//   rebuild-heads, copy-back, bump-tree-id   the store-scoped recovery (HFY-TSK-275, review SI-04; src/sync/refold.js, scripts/sync-recovery.mjs,
//              docs/how-to/operate-the-sync-store.md). They never swap TABLE_NAME and touch only REC#, SYNC#, GID# and IDALIAS# items;
//              every --apply needs the store paused first.
//   render     invokes the hfy-sync-render Lambda with an operator payload. --full forces a full pass although the cursor is current;
//              --allow-mass-delete adds {"allow_mass_delete": true} (lets one pass delete more than the guard's limit, after review);
//              --prune-foreign adds {"prune_foreign": true} (deletes renderer-shaped keys under the data prefixes that the renderer
//              never wrote, after review). Each of the three forces a full pass. A dry run reads SYNC#HEAD and SYNC#RENDER and prints the
//              payload; it invokes nothing.
//   resurrect  re-creates the heads of the deletes and withdraws of one batch from the append-only log (see below).
//
// EVERY --apply IS A PRODUCTION WRITE (pause, resume and resurrect write app-table items; render makes the renderer write and delete site
// files). It runs only after io's go-ahead in the session, recorded verbatim in the worklog together with the dry-run output (AGENTS.md;
// BRD2 10.2 rule 15; review DL-28). The G-seed approval covers setting writes_enabled for the seed, nothing else. Always run --dry-run first.
//
// resurrect. A delete or withdraw tombstones the head at once (the log keeps the version before it). For each such op of the batch this
// plans a new head at the next version, with a new log entry (op create, origin admin, principal operator:sync-admin, base_version the
// tombstone's) at a new dense seq, and re-claims the object's GID item. It is refused, object by object and with the reason named, when:
//   - the tombstone is older than 72 hours (the expunge grace: privacy-expunge removes the history after it),
//   - the log holds no usable prior version (obj_json null or expunged, or its hash does not match),
//   - the head moved after the tombstone (it is no longer the tombstone this batch wrote),
//   - the op is a privacy withdraw and --include-withdrawn was not passed (re-creating it republishes a withdrawn record),
//   - the delete was a merge (the id alias and the survivor are the merge's business, not this tool's),
//   - the object is a Media (its blob descriptor is on the head, not in the log),
//   - the gramps_id now belongs to another object.
// Objects that can be resurrected are written in transactions of at most 20, each pinned to the SYNC#HEAD seq it read; a pinned write
// that loses a race stops the run (rerun the dry run). A second --apply plans nothing for what it already re-created.
// Output names classes, opaque handles, versions, reasons and counts only: no object text and no gramps_id.
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { auditItem, assertTxnSize } from "../src/txn.js";
import { batchKey, gidClaimItem, gidKey, headItem, headKey, logItem, logKey, recKey, seqKey, sha256 } from "../src/sync/store.js";
import { RecoveryError, bumpTreeId, copyBack, rebuildHeads } from "./sync-recovery.mjs";

export const GRACE_MS = 72 * 3600 * 1000;
export const CHUNK = 20; // 2 fixed items + 3 per object stays far under the 100-item transaction limit
export const PRINCIPAL = "operator:sync-admin";
export const DEFAULT_FUNCTION = "hfy-sync-render";

export class AdminError extends Error {}

const get = async ({ ddb, cmds, table }, Key) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
const iso = (now) => new Date(now()).toISOString();

async function auditPut(ctx, id, op, before, after, by, at) {
  return auditItem({ id, op, principalId: by, at, before, after }, randomUUID(), ctx.table);
}

// ---- pause / resume ---------------------------------------------------------------------------------------------------
async function setWrites(ctx, enabled, { apply, by = "operator" }) {
  const { log } = ctx;
  const head = await get(ctx, headKey());
  if (!head) throw new AdminError("there is no SYNC#HEAD item: the store is not initialised, so there is nothing to pause or resume");
  const word = enabled ? "resume" : "pause";
  const now = head.writes_enabled !== false; // absent counts as enabled (applyBatch pauses only on an explicit false)
  log(`${word}: writes_enabled is ${head.writes_enabled === undefined ? "absent (enabled)" : String(head.writes_enabled)}; target ${enabled}`);
  if (now === enabled && head.writes_enabled !== undefined) {
    log(`${word}: already ${enabled ? "enabled" : "paused"}; nothing to change`);
    return { changed: false, apply };
  }
  if (!apply) {
    log("dry run: nothing written");
    return { changed: false, planned: true, apply };
  }
  const at = iso(ctx.now);
  const names = { "#we": "writes_enabled", "#u": "updated_at" };
  const values = { ":to": enabled, ":at": at };
  // Pinned to the value read, so a concurrent change fails instead of being overwritten.
  let condition = "attribute_exists(PK)";
  if (head.writes_enabled === undefined) condition += " AND attribute_not_exists(#we)";
  else {
    condition += " AND #we = :was";
    values[":was"] = head.writes_enabled;
  }
  const audit = await auditPut(ctx, `sync-admin:${word}:${at}`, `sync-admin.${word}`, { writes_enabled: head.writes_enabled ?? null }, { writes_enabled: enabled }, by, at);
  await ctx.ddb.send(
    new ctx.cmds.TransactWriteCommand({
      TransactItems: [
        { Update: { TableName: ctx.table, Key: headKey(), UpdateExpression: "SET #we = :to, #u = :at", ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
        { Put: { TableName: ctx.table, Item: audit } },
      ],
    }),
  );
  log(`${word}: writes_enabled is now ${enabled}`);
  return { changed: true, apply };
}
export const pause = (ctx, o) => setWrites(ctx, false, o);
export const resume = (ctx, o) => setWrites(ctx, true, o);

// ---- render -----------------------------------------------------------------------------------------------------------
/** The Lambda payload for the render flags. Every flag is the literal `true`, which is what the renderer accepts. */
export function renderPayload({ full, allowMassDelete, pruneForeign }) {
  if (!full && !allowMassDelete && !pruneForeign) throw new AdminError("render needs --full, --allow-mass-delete or --prune-foreign");
  return { force: true, ...(allowMassDelete ? { allow_mass_delete: true } : {}), ...(pruneForeign ? { prune_foreign: true } : {}) };
}

/** Reads an invoke result (the CLI's metadata JSON and the response body) and throws on a function error. Names the error type only. */
export function checkInvokeResult(metaText, body) {
  let meta = {};
  try {
    meta = JSON.parse(String(metaText || "{}"));
  } catch {
    throw new AdminError("aws lambda invoke printed metadata that is not JSON; check the function's runs before retrying");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(body));
  } catch {
    /* the response need not be JSON */
  }
  const errType = meta.FunctionError || parsed?.errorType;
  if (errType || (parsed && typeof parsed === "object" && parsed.errorMessage)) {
    const msg = String(parsed?.errorMessage ?? "").slice(0, 200);
    throw new AdminError(`the renderer failed (${parsed?.errorType ?? meta.FunctionError}${msg ? `: ${msg}` : ""}); see SYNC#RENDER.last_error`);
  }
  if (meta.StatusCode !== undefined && meta.StatusCode !== 200) throw new AdminError(`aws lambda invoke returned status ${meta.StatusCode}`);
  return String(body);
}

/**
 * Invokes the Lambda through the AWS CLI (the api package carries no Lambda client; the operator's credentials come from the CLI).
 * The response goes to a temp file, so the CLI's metadata (StatusCode, FunctionError) on stdout stays separate. The CLI exits 0 when the
 * function itself fails, so the metadata and body are checked. --cli-read-timeout 0 waits for a full pass: the default 60 s timeout would
 * fail the CLI while the Lambda kept running, and a retry would start a second, overlapping pass.
 */
export async function cliInvoke({ functionName, region, payload, run = execFile }) {
  const dir = await mkdtemp(join(tmpdir(), "sync-admin-"));
  const outFile = join(dir, "response.json");
  try {
    const stdout = await new Promise((resolve, reject) => {
      run(
        "aws",
        ["lambda", "invoke", "--function-name", functionName, "--region", region, "--cli-read-timeout", "0", "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify(payload), outFile],
        { maxBuffer: 1 << 20 },
        (err, out) => (err ? reject(new AdminError(`aws lambda invoke failed (${err.code ?? "error"}); the renderer may still be running: check SYNC#RENDER before retrying`)) : resolve(String(out))),
      );
    });
    let body = "";
    try {
      body = await readFile(outFile, "utf8");
    } catch {
      /* no body written */
    }
    return checkInvokeResult(stdout, body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function render(ctx, { apply, full = false, allowMassDelete = false, pruneForeign = false, functionName = DEFAULT_FUNCTION, region = "us-west-2", invoke = cliInvoke }) {
  const { log } = ctx;
  const payload = renderPayload({ full, allowMassDelete, pruneForeign });
  const head = await get(ctx, headKey());
  const state = await get(ctx, { PK: "SYNC#RENDER", SK: "STATE" });
  log(`render: head seq ${head?.seq ?? "none"}, rendered_seq ${state?.rendered_seq ?? "none"}, mode ${state?.mode ?? "unknown"}${state?.last_error ? `, last_error ${state.last_error}` : ""}`);
  log(`render: ${functionName} payload ${JSON.stringify(payload)}`);
  if (allowMassDelete) log("render: --allow-mass-delete lets this pass delete past the guard; review the refused deletes first");
  if (pruneForeign) log("render: --prune-foreign deletes keys the renderer never wrote under the data prefixes; review the foreign list first");
  if (!apply) {
    log("dry run: nothing invoked");
    return { payload, invoked: false };
  }
  const out = await invoke({ functionName, region, payload });
  log(`render: invoked; response ${out.trim().slice(0, 500)}`);
  return { payload, invoked: true, response: out };
}
export { render };

// ---- resurrect --------------------------------------------------------------------------------------------------------
async function queryAll(ctx, input) {
  const out = [];
  let key;
  for (let i = 0; i < 100; i += 1) {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({ ...input, ...(key ? { ExclusiveStartKey: key } : {}) }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return out;
  }
  throw new AdminError("a listing did not end; stopping");
}

/** The deletes and withdraws of a batch, read from the log by the receipt's seq range. */
async function batchTombstones(ctx, batchId) {
  const receipt = await get(ctx, batchKey(batchId));
  if (!receipt) throw new AdminError("no SYNC#BATCH receipt for that batch id");
  const entries = [];
  for (let seq = receipt.seq_from; seq <= receipt.seq_to; seq += 1) {
    const e = await get(ctx, logKey(seq));
    if (e && e.batch_id === batchId && (e.op === "delete" || e.op === "withdraw") && e.class) entries.push(e);
  }
  return entries;
}

/** Plans one tombstone. Returns { ok, ... } or { ok: false, reason }. */
async function planOne(ctx, tomb, nowMs, includeWithdrawn = false) {
  const ref = { class: tomb.class, handle: tomb.handle, version: tomb.version, op: tomb.op };
  const refuse = (reason) => ({ ok: false, ref, reason });
  if (tomb.reason === "merge") return refuse("merge"); // the log entry of a merge delete (apply.js op.reason)
  if (tomb.op === "withdraw" && !includeWithdrawn) return refuse("withdrawn_private_needs_flag");
  if (tomb.class === "Media") return refuse("media_blob_not_in_log");
  if (!(nowMs - Date.parse(tomb.at) <= GRACE_MS)) return refuse("past_grace");
  const headNow = await get(ctx, recKey(tomb.class, tomb.handle));
  if (!headNow) return refuse("head_missing");
  if (headNow.deleted !== true) return refuse("already_live");
  if (headNow.version !== tomb.version) return refuse("head_moved");
  const hist = await queryAll(ctx, {
    TableName: ctx.table,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": `RECHIST#${tomb.class}#${tomb.handle}` },
  });
  const prior = hist
    .filter((e) => e.version < tomb.version && (e.op === "create" || e.op === "update"))
    .sort((a, b) => b.version - a.version)[0];
  if (!prior || prior.obj_json == null || prior.expunged === true || headNow.expunged === true) return refuse("no_prior_version");
  if (prior.hash && prior.hash !== sha256(prior.obj_json)) return refuse("hash_mismatch");
  const grampsId = prior.gramps_id ?? "";
  let gid = null;
  if (grampsId && tomb.class !== "Tag") {
    gid = (await get(ctx, gidKey(tomb.class, grampsId))) ?? null;
    if (gid && gid.handle !== tomb.handle) return refuse("gramps_id_taken");
    if (gid && gid.reason === "merged") return refuse("merge");
  }
  return { ok: true, ref, tomb, prior, gramps_id: grampsId, gid };
}

async function commitChunk(ctx, chunk, batchId, by) {
  const head = await get(ctx, headKey());
  if (!head || !Number.isInteger(head.seq)) throw new AdminError("SYNC#HEAD has no seq");
  const at = iso(ctx.now);
  let seq = head.seq;
  const items = [];
  for (const p of chunk) {
    seq += 1;
    const version = p.tomb.version + 1;
    const base = { class: p.tomb.class, handle: p.tomb.handle, gramps_id: p.gramps_id, version, seq, objJson: p.prior.obj_json, at, origin: "admin" };
    items.push({
      Put: {
        TableName: ctx.table,
        Item: headItem({ ...base, deleted: false, by: PRINCIPAL }),
        ConditionExpression: "#d = :t AND #v = :v",
        ExpressionAttributeNames: { "#d": "deleted", "#v": "version" },
        ExpressionAttributeValues: { ":t": true, ":v": p.tomb.version },
      },
    });
    items.push({
      Put: {
        TableName: ctx.table,
        Item: { ...logItem({ ...base, op: "create", batch_id: `resurrect:${batchId}`, base_version: p.tomb.version, principal: PRINCIPAL }), resurrected_from: { batch_id: batchId, seq: p.tomb.seq, op: p.tomb.op } },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    if (p.gramps_id && p.tomb.class !== "Tag") {
      const claim = gidClaimItem(p.tomb.class, p.gramps_id, p.tomb.handle, { at, batch_id: `resurrect:${batchId}` });
      items.push({
        Put: {
          TableName: ctx.table,
          Item: claim,
          ...(p.gid
            ? { ConditionExpression: "#h = :h", ExpressionAttributeNames: { "#h": "handle" }, ExpressionAttributeValues: { ":h": p.tomb.handle } }
            : { ConditionExpression: "attribute_not_exists(PK)" }),
        },
      });
    }
  }
  const countable = typeof head.live_heads === "number";
  const values = { ":to": seq, ":old": head.seq, ":at": at };
  const names = { "#s": "seq", "#u": "updated_at" };
  if (countable) {
    names["#lh"] = "live_heads";
    values[":lh"] = chunk.length;
  }
  let weCond = "";
  names["#we"] = "writes_enabled";
  if (head.writes_enabled === undefined) weCond = " AND attribute_not_exists(#we)";
  else {
    weCond = " AND #we = :we";
    values[":we"] = head.writes_enabled;
  }
  const audit = await auditPut(
    ctx,
    `sync-admin:resurrect:${batchId}:${head.seq + 1}`,
    "sync-admin.resurrect",
    chunk.map((p) => ({ class: p.tomb.class, handle: p.tomb.handle, version: p.tomb.version })),
    chunk.map((p, i) => ({ class: p.tomb.class, handle: p.tomb.handle, version: p.tomb.version + 1, seq: head.seq + 1 + i })),
    by,
    at,
  );
  items.unshift({
    Update: {
      TableName: ctx.table,
      Key: headKey(),
      UpdateExpression: countable ? "SET #s = :to, #u = :at ADD #lh :lh" : "SET #s = :to, #u = :at",
      ConditionExpression: `#s = :old${weCond}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  });
  items.push({ Put: { TableName: ctx.table, Item: audit } });
  assertTxnSize(items);
  await ctx.ddb.send(new ctx.cmds.TransactWriteCommand({ TransactItems: items }));
  return { seq_from: head.seq + 1, seq_to: seq };
}

async function resurrect(ctx, { apply, batch, by = "operator", includeWithdrawn = false }) {
  const { log } = ctx;
  if (!batch || !/^[A-Za-z0-9]{1,64}$/.test(batch)) throw new AdminError("resurrect needs --batch <batch_id>");
  const nowMs = ctx.now();
  const tombs = await batchTombstones(ctx, batch);
  const plans = [];
  for (const t of tombs) plans.push(await planOne(ctx, t, nowMs, includeWithdrawn));
  const ok = plans.filter((p) => p.ok);
  const refused = plans.filter((p) => !p.ok);
  log(`resurrect: batch ${batch} holds ${tombs.length} delete/withdraw op(s)`);
  for (const p of ok) log(`  will re-create  ${p.ref.class} ${p.ref.handle} (tombstone v${p.ref.version} ${p.ref.op} -> v${p.ref.version + 1}, from v${p.prior.version})`);
  for (const p of refused) log(`  refused         ${p.ref.class} ${p.ref.handle} (v${p.ref.version} ${p.ref.op}): ${p.reason}`);
  const wd = ok.filter((p) => p.ref.op === "withdraw").length;
  if (wd > 0) log(`WARNING: ${wd} of these are privacy withdraws (reason private). Re-creating them puts the record back in the store and the next render republishes it. Proceed only on io's explicit go-ahead for the withdrawn records.`);
  log(`plan: ${ok.length} to re-create, ${refused.length} refused`);
  if (!apply) {
    log("dry run: nothing written");
    return { plan: plans, written: 0 };
  }
  let written = 0;
  for (let i = 0; i < ok.length; i += CHUNK) {
    const chunk = ok.slice(i, i + CHUNK);
    const r = await commitChunk(ctx, chunk, batch, by);
    written += chunk.length;
    log(`applied: ${chunk.length} head(s) at seq ${seqKey(r.seq_from)}..${seqKey(r.seq_to)}`);
  }
  log(`applied: ${written} head(s) re-created`);
  return { plan: plans, written };
}
export { resurrect };

// ---- cli --------------------------------------------------------------------------------------------------------------
export const HELP = `sync-admin.mjs: operator tooling for the cloud record store and its renderer.

Usage:
  node scripts/sync-admin.mjs pause     --all --dry-run|--apply [--by <name>]
  node scripts/sync-admin.mjs resume    --all --dry-run|--apply [--by <name>]
  node scripts/sync-admin.mjs render    --dry-run|--apply (--full | --allow-mass-delete | --prune-foreign) [--function <name>]
  node scripts/sync-admin.mjs resurrect --batch <batch_id> --dry-run|--apply [--include-withdrawn] [--by <name>]
  node scripts/sync-admin.mjs rebuild-heads --to-seq <N|head> --dry-run|--apply [--by <name>]
  node scripts/sync-admin.mjs copy-back --from-table <side-table> --dry-run|--apply [--by <name>]
  node scripts/sync-admin.mjs bump-tree-id [--reseed] --dry-run|--apply [--by <name>]
Common: [--table hfy-app] [--region us-west-2]   Exactly one of --dry-run or --apply is required (once).
pause --all stops every writer of the store at once (the switch is store-wide); the recovery commands (rebuild-heads, copy-back, bump-tree-id)
refuse --apply until the store is paused, and never swap TABLE_NAME. -h/--help prints this.

IO'S GO-AHEAD IS REQUIRED. Every production --apply writes app-table items (pause, resume and resurrect) or makes the renderer write and
delete site files (render). Run it only after io's go-ahead in the session, recorded verbatim in the worklog with the dry-run output
(AGENTS.md; review DL-28). Always run --dry-run first. See docs/how-to/operate-the-sync-store.md.
`;

const COMMANDS = ["pause", "resume", "render", "resurrect", "rebuild-heads", "copy-back", "bump-tree-id"];

export function parseArgs(argv) {
  const out = { command: undefined, apply: undefined, table: process.env.TABLE_NAME ?? "hfy-app", region: process.env.AWS_REGION ?? "us-west-2" };
  const rest = [...argv];
  if (rest.includes("-h") || rest.includes("--help")) return { help: true };
  out.command = rest.shift();
  if (!COMMANDS.includes(out.command)) throw new AdminError(`unknown or missing command ${out.command ?? ""} (${COMMANDS.join(", ")})`);
  const modes = { dry: 0, apply: 0 };
  const value = (flag, i) => {
    if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) throw new AdminError(`${flag} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--dry-run") modes.dry += 1;
    else if (a === "--apply") modes.apply += 1;
    else if (a === "--table") out.table = value(a, i++);
    else if (a === "--region") out.region = value(a, i++);
    else if (a === "--by") out.by = value(a, i++);
    else if (a === "--batch") out.batch = value(a, i++);
    else if (a === "--function") out.functionName = value(a, i++);
    else if (a === "--to-seq") out.toSeq = value(a, i++);
    else if (a === "--from-table") out.fromTable = value(a, i++);
    else if (a === "--reseed") out.reseed = true;
    else if (a === "--all") out.all = true;
    else if (a === "--include-withdrawn") out.includeWithdrawn = true;
    else if (a === "--full") out.full = true;
    else if (a === "--allow-mass-delete") out.allowMassDelete = true;
    else if (a === "--prune-foreign") out.pruneForeign = true;
    else throw new AdminError(`unknown argument ${a}`);
  }
  if (modes.dry + modes.apply !== 1) throw new AdminError("pass exactly one of --dry-run or --apply");
  out.apply = modes.apply === 1;
  const allowed = {
    pause: ["by", "all"],
    resume: ["by", "all"],
    render: ["full", "allowMassDelete", "pruneForeign", "functionName"],
    resurrect: ["by", "batch", "includeWithdrawn"],
    "rebuild-heads": ["by", "toSeq"],
    "copy-back": ["by", "fromTable"],
    "bump-tree-id": ["by", "reseed"],
  }[out.command];
  for (const k of ["by", "batch", "all", "includeWithdrawn", "full", "allowMassDelete", "pruneForeign", "functionName", "toSeq", "fromTable", "reseed"]) {
    if (out[k] !== undefined && !allowed.includes(k)) throw new AdminError(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace("function-name", "function")} does not apply to ${out.command}`);
  }
  if (out.command === "rebuild-heads" && out.toSeq === undefined) throw new AdminError("rebuild-heads needs --to-seq <N> (or head for the log's last seq)");
  if (out.command === "copy-back" && out.fromTable === undefined) throw new AdminError("copy-back needs --from-table <side-table>");
  if (!out.table || !out.region) throw new AdminError("--table and --region need a value");
  return out;
}

/** Runs a parsed command. `ctx` = { ddb, cmds, table, log, now }. */
export async function run(args, ctx) {
  switch (args.command) {
    case "pause":
      return pause(ctx, args);
    case "resume":
      return resume(ctx, args);
    case "render":
      return render(ctx, args);
    case "resurrect":
      return resurrect(ctx, args);
    case "rebuild-heads":
      return rebuildHeads(ctx, args);
    case "copy-back":
      return copyBack(ctx, args);
    case "bump-tree-id":
      return bumpTreeId(ctx, args);
    default:
      throw new AdminError(`unknown command ${args.command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
    } else {
      const [{ DynamoDBClient }, lib] = await Promise.all([import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb")]);
      const ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), { marshallOptions: { removeUndefinedValues: true } });
      const cmds = { GetCommand: lib.GetCommand, QueryCommand: lib.QueryCommand, ScanCommand: lib.ScanCommand, TransactWriteCommand: lib.TransactWriteCommand };
      await run(args, { ddb, cmds, table: args.table, log: console.log, now: () => Date.now() });
    }
  } catch (e) {
    console.error(`sync-admin: ${e.message}`);
    process.exitCode = 1;
  }
}
export { RecoveryError };
