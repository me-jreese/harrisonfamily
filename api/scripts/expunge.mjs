#!/usr/bin/env node
// Remove something from every cloud copy (HFY-TSK-204, privacy-expunge; BRD2 D2-33, review PS-05 and SI-18, runbook 19.11).
//
//   node scripts/expunge.mjs --record <Class>:<handle> [--path <pointer> [--replacement <text>] [--sweep]] [--apply]
//   node scripts/expunge.mjs --proposal <ulid> [--apply]
//   node scripts/expunge.mjs --chat <conv>:<seq> [--apply]
//   node scripts/expunge.mjs --upload <key> [--apply]
//   node scripts/expunge.mjs --due [--now] [--apply]            the record expunges that withdraws scheduled (see below)
//   common: [--dry-run] [--table hfy-app] [--region us-west-2] [--sync-bucket harrisonfamily-sync] [--site-bucket harrisonfamily-frontend]
//
// DRY RUN BY DEFAULT. Without --apply (or with --dry-run) nothing is written, deleted or invoked: the run reads and prints counts. --apply
// needs io's step-up: the sync access token of a gramps-owner whose sign-in is fresh (amr mfa, auth_time within 300 s), in the environment
// variable EXPUNGE_ACCESS_TOKEN (never an argument, which shell history keeps). Each --apply writes one AUDIT#expunge:<id> item with the
// mode and counts only: no handle, no id, no text. Output names counts and classes only.
//
// --record <Class>:<handle>   without --path, the whole record: it must already be a tombstone (a withdraw or a delete; a live head is refused,
//                             withdraw it first). (a) every SYNC#LOG entry of the handle (found through GSI1 RECHIST# and the head's seq) and the
//                             head get obj_json null and expunged true; hash and seq stay. (b) every snapshot (snapshots/) and all its noncurrent
//                             versions are deleted and the snapshot is rebuilt. (c) the render-shadow copies of the record's rendered files, of the
//                             pages that embedded it (now or in any stored version of them: a delete that cleaned a reference away does not hide
//                             the page) and of the index files are deleted with their versions, and, when the site bucket is versioned, the
//                             noncurrent versions of those keys there. person/graph.json, the graph renderer's aggregate of a Person, Family,
//                             Event, Place or Media, is one of those keys; it has no shadow copy, and its current version is the graph renderer's
//                             to rewrite (it does so on the epoch below), so run the sweep after that pass. (d) a Media record's photo: every version of media/<handle>.<ext> and of
//                             media/.staging/<handle>/* (the renderer never writes or deletes a binary, and the tombstone no longer names the
//                             file, so the keys come from the handle).
//                             The open and decided sync conflicts of the handle lose their values. SYNC#HEAD.expunge_epoch rises by one in the same
//                             transaction as the head rewrite, which is what makes every reader (the store view, the snapshot cache) drop what it held.
//                             CREDENTIALS. One process reaches the table and the sync bucket with io's usual administrator credentials. The
//                             data-write guard (scripts/infra/apply-data-write-guard.sh), once applied, denies s3:PutObject, s3:DeleteObject and
//                             s3:DeleteObjectVersion on the rendered data prefixes, and s3:DeleteObject and s3:DeleteObjectVersion on media/* (binaries
//                             included), to every principal but the renderers and hfy-data-breakglass. Those administrator credentials then cannot
//                             delete a site-bucket version or a photo. hfy-data-breakglass can, but reaches neither the table nor the sync bucket, so
//                             the site-bucket calls of this run use a second set of credentials, the break-glass session, from the environment
//                             variables EXPUNGE_SITE_AWS_ACCESS_KEY_ID, EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY and EXPUNGE_SITE_AWS_SESSION_TOKEN (all
//                             three or none; never arguments). Without them every call uses the one set, which is right while the guard is off.
//                             A delete the guard refuses stops the run after the table is rewritten, names the cause, and the same command, run
//                             again with the session set, finishes it.
// --record ... --path <ptr>   one value of a live or tombstoned record, as an RFC 6901 pointer into the object (for example /text/string). In
//                             every log entry and in the head, a string becomes --replacement (default the empty string) and any other
//                             object member is removed; an array element that is not a string is refused. This rewrites append-only
//                             history: an audited exception (SI-18). Hashes are recomputed, version and seq do not move, so the changed
//                             hash at an unchanged version is the expunge notice the desktop add-on acts on. The identity members
//                             (handle, _class, gramps_id) are refused. Steps (b) and (c) follow; a Media photo (d) is not touched (only the
//                             whole record removes the file). The live site files still hold the old value until sync-admin render --full has
//                             rewritten them, and on a versioned site bucket the render turns each of them into a noncurrent version that
//                             still holds it. Run the same line again after the render with --sweep: a path that is no longer found is then
//                             expected, not a typo, and (b) and (c) delete the copies the render left.
// --proposal <ulid>           PROP#<ulid> META and every IDX# copy lose the proposal document and their index keys (they stay as an expunged stub),
//                             the proposal thread's comments and reactions are deleted, the audit rows of those comments lose before and after,
//                             and the comments' photos are deleted from the site bucket with every version. The AUDIT#proposal:<ulid> rows
//                             (every state change) lose before, after and any decision reason; the IDEM# receipts whose result echoes the proposal
//                             are deleted (one filtered table scan finds them); the PROPREQ# item of a system proposal loses its content hash. The
//                             inbox rows of a decision (90 days after read) can hold the reason an admin typed and expire on their own.
// --chat <conv>:<seq>         the chat hub nulls the message text through its admin route (CHAT_HUB_ADMIN_URL, CHAT_HUB_ADMIN_TOKEN), then the
//                             CHAT#<conv>/M#<seq> mirror row is deleted. The hub goes first, so a later archive batch cannot bring the text back.
// --upload <key>              every version of uploads/posts|comments/<ulid>/photo.<ext> in the site bucket, and its UPLOAD# binding.
// --due [--now]               the pending EXPUNGE#<Class>#<handle> items (written by every privacy withdraw, due 72 hours later so a mistaken mass
//                             withdraw can still be resurrected) whose time has come; --now takes all of them at once (tests). Runs the whole-record
//                             expunge for each. A stale item (the head is live again) is dropped.
//
// A crash part-way is finished by running the same command again: the head rewrite also writes EXPUNGE#SWEEP, and that item and the record's
// EXPUNGE# schedule item are deleted only after the snapshot versions were replaced. --due runs the snapshot step whenever EXPUNGE#SWEEP exists.
// The 35-day DynamoDB point-in-time recovery tail is outside this tool's reach and is disclosed in the privacy text and the runbook.
// After a record or path expunge run `sync-admin.mjs render --full`, so the live site files are rewritten from the store.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetBucketVersioningCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { assertTxnSize, auditItem } from "../src/txn.js";
import { CLASSES, EXPUNGE_QUEUE, expungeKey, headKey, logKey, objectJson, recKey, sha256 } from "../src/sync/store.js";
import { HANDLE_SHAPE } from "../src/records/ops.js";
import { rebuildStoreView, storeView } from "../src/records/index.js";
import { collectRefs } from "../src/records/semantics.js";
import { SNAPSHOT_PREFIX, writeSnapshot } from "../src/sync/pull.js";
import { createSyncAuthenticator, requireOwner, requireStepUp } from "../src/sync/auth.js";

/** `code` is a short fixed word: a --due run logs the name and the code of a failure, never its message (a message can carry a value). */
export class ExpungeError extends Error {
  constructor(message, code = "refused") {
    super(message);
    this.name = "ExpungeError";
    this.code = code;
  }
}

/** A DynamoDB transaction that lost a condition or a race (a resurrect, an edit): the caller reads the record again. */
const isCancelled = (e) => e?.name === "TransactionCanceledException";

/**
 * The item that says a snapshot sweep is owed. It is written in the same transaction as the head rewrite and deleted only after the snapshot
 * versions were replaced, so a crash between the two leaves it behind and the next run finishes the sweep (a rerun of the record itself
 * finds nothing left to rewrite and would otherwise never clean up the old snapshot versions).
 */
export const SWEEP_KEY = Object.freeze({ PK: "EXPUNGE#SWEEP", SK: "META" });

export const DEFAULT_SYNC_BUCKET = "harrisonfamily-sync";
export const DEFAULT_SITE_BUCKET = "harrisonfamily-frontend";
export const MODES = Object.freeze(["record", "proposal", "chat", "upload", "due"]);
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const CONV_RE = /^(?:dm:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|g:[A-Za-z0-9]{1,40})$/;
export const UPLOAD_KEY_RE = /^uploads\/(?:posts|comments)\/([0-9A-HJKMNP-TV-Z]{26})\/photo\.[a-z0-9]{2,5}$/;
/** Transaction items per write: far under DynamoDB's 100, so an item carrying a 200 KB object stays under the 4 MB limit too. */
export const TXN_CHUNK = 20;
/** Members of a record that --path never rewrites: they are the identity of the object. */
const IDENTITY_MEMBERS = new Set(["handle", "_class", "gramps_id"]);

const get = async ({ ddb, cmds, table }, Key) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
const iso = (ctx) => new Date(ctx.now()).toISOString();
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

async function queryAll(ctx, input) {
  const out = [];
  let key;
  for (let i = 0; i < 1000; i += 1) {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({ TableName: ctx.table, ...input, ...(key ? { ExclusiveStartKey: key } : {}) }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return out;
  }
  throw new ExpungeError("a listing did not end; stopping");
}

/** Bytes per transaction: DynamoDB allows 4 MB in all, and a path rewrite carries a whole object (up to 200 KB) per item. */
export const TXN_BYTES = 1_500_000;

/**
 * Writes `items` (TransactItems) in transactions of at most TXN_CHUNK items and about TXN_BYTES bytes. `guard` (a ConditionCheck) rides in every
 * transaction, so a record that moved under the run (a resurrect, an edit) cancels the next chunk instead of being half rewritten.
 */
async function transactAll(ctx, items, guard) {
  let part = [];
  let bytes = 0;
  const flush = async () => {
    if (part.length === 0) return;
    const send = guard ? [...part, guard] : part;
    assertTxnSize(send);
    await ctx.ddb.send(new ctx.cmds.TransactWriteCommand({ TransactItems: send }));
    part = [];
    bytes = 0;
  };
  for (const it of items) {
    const n = JSON.stringify(it).length;
    if (part.length >= TXN_CHUNK || (part.length > 0 && bytes + n > TXN_BYTES)) await flush();
    part.push(it);
    bytes += n;
  }
  await flush();
}

// ---- S3 -----------------------------------------------------------------------------------------------------------------
/**
 * The client for the rendered data prefixes of the site bucket (the record steps): the break-glass session when the run was given one, else the
 * run's only client. The data-write guard denies deletes there to every other principal, io's administrator credentials included. Everything else
 * (the sync bucket, uploads/) uses `ctx.s3`: hfy-data-breakglass does not reach it.
 */
const siteClient = (ctx) => ctx.siteS3 ?? ctx.s3;

async function bucketVersioned(ctx, bucket, s3 = ctx.s3) {
  const r = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  return r?.Status === "Enabled" || r?.Status === "Suspended";
}

/** Every version and delete marker whose key starts with `prefix`: [{ key, versionId, latest, marker }]. */
async function listVersions(ctx, bucket, prefix, s3 = ctx.s3) {
  const out = [];
  let marker;
  for (let i = 0; i < 1000; i += 1) {
    const r = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, ...(marker ? { KeyMarker: marker.key, VersionIdMarker: marker.version } : {}) }));
    for (const v of r.Versions ?? []) out.push({ key: v.Key, versionId: v.VersionId, latest: v.IsLatest === true, marker: false });
    for (const v of r.DeleteMarkers ?? []) out.push({ key: v.Key, versionId: v.VersionId, latest: v.IsLatest === true, marker: true });
    if (r.IsTruncated !== true) return out;
    marker = { key: r.NextKeyMarker, version: r.NextVersionIdMarker };
  }
  throw new ExpungeError("a version listing did not end; stopping");
}

/** Deletes the listed versions for good (a VersionId is named whenever the bucket is versioned, so no delete marker is left behind). */
async function deleteVersions(ctx, bucket, list, versioned, s3 = ctx.s3) {
  for (const v of list) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.key, ...(versioned && v.versionId ? { VersionId: v.versionId } : {}) }));
}

/** The versions of exactly `key` (a prefix listing also returns longer keys). */
const exactVersions = async (ctx, bucket, key, s3 = ctx.s3) => (await listVersions(ctx, bucket, key, s3)).filter((v) => v.key === key);

/** S3 refused the call for lack of permission (an explicit bucket-policy deny answers 403 AccessDenied). */
const isDenied = (e) => e?.name === "AccessDenied" || e?.$metadata?.httpStatusCode === 403;

/**
 * Deletes site-bucket versions of the rendered data prefixes with the site client. A refusal is not a bug to retry blindly: the data-write guard
 * denies those deletes to every principal but the renderers and hfy-data-breakglass. The table side of the run is already done and is not undone;
 * the same command, run again with the break-glass session in EXPUNGE_SITE_AWS_*, finishes the job. The message names no key.
 */
async function deleteSiteVersions(ctx, list, versioned) {
  try {
    await deleteVersions(ctx, ctx.siteBucket, list, versioned, siteClient(ctx));
  } catch (e) {
    if (!isDenied(e)) throw e;
    throw new ExpungeError(
      `the site bucket refused a delete: the data-write guard denies s3:DeleteObject and s3:DeleteObjectVersion on the data prefixes and media/ to every role except the renderers and hfy-data-breakglass. The table is already rewritten; set ${SITE_ENV.join(", ")} from a break-glass session and run the same command again`,
      "site_denied",
    );
  }
}

/** The environment variables that carry the break-glass session for the site bucket (all three or none). */
export const SITE_ENV = Object.freeze(["EXPUNGE_SITE_AWS_ACCESS_KEY_ID", "EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY", "EXPUNGE_SITE_AWS_SESSION_TOKEN"]);

/** The S3 client of the break-glass session from `env`, or undefined when none is set. `make` builds a client from `{ region, credentials }`. */
export function createSiteClient(env, region, make) {
  const [accessKeyId, secretAccessKey, sessionToken] = SITE_ENV.map((k) => env[k]);
  if (!accessKeyId && !secretAccessKey && !sessionToken) return undefined;
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new ExpungeError(`set ${SITE_ENV.join(", ")} together, or none of them`);
  return make({ region, credentials: { accessKeyId, secretAccessKey, sessionToken } });
}

// ---- audit ----------------------------------------------------------------------------------------------------------------
/** The AUDIT#expunge:<id> item of a run. It holds the mode and counts only. */
function auditPut(ctx, who, mode, counts) {
  const at = iso(ctx);
  return auditItem({ id: `expunge:${ctx.uid()}`, op: "expunge", principalId: who.sub, at, before: null, after: { mode, counts } }, ctx.uid(), ctx.table);
}

// ---- JSON pointers ---------------------------------------------------------------------------------------------------------
/** The tokens of an RFC 6901 pointer. Refuses the root and the identity members. */
export function parsePointer(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/" || pointer.length > 512) throw new ExpungeError("--path must be an RFC 6901 pointer such as /text/string");
  const tokens = pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.some((t) => t === "")) throw new ExpungeError("--path has an empty segment");
  if (IDENTITY_MEMBERS.has(tokens[0]) && tokens.length === 1) throw new ExpungeError("--path may not name handle, _class or gramps_id: they are the identity of the object");
  return tokens;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/**
 * Scrubs the value at `tokens` in `obj` in place: a string becomes `replacement`, any other object member is removed, an array element that is
 * not a string is refused (removing it would move its neighbours). Returns true when something changed, false when the path is absent.
 */
export function scrubAt(obj, tokens, replacement = "") {
  let cur = obj;
  for (const t of tokens.slice(0, -1)) {
    if (Array.isArray(cur)) cur = /^(?:0|[1-9]\d*)$/.test(t) ? cur[Number(t)] : undefined;
    else if (isObj(cur) && Object.hasOwn(cur, t)) cur = cur[t];
    else return false;
    if (cur === null || typeof cur !== "object") return false;
  }
  const last = tokens.at(-1);
  if (Array.isArray(cur)) {
    if (!/^(?:0|[1-9]\d*)$/.test(last) || Number(last) >= cur.length) return false;
    const i = Number(last);
    if (typeof cur[i] !== "string") throw new ExpungeError("--path names an array element that is not a string; point at its parent member instead");
    if (cur[i] === replacement) return false;
    cur[i] = replacement;
    return true;
  }
  if (!isObj(cur) || !Object.hasOwn(cur, last)) return false;
  if (typeof cur[last] === "string") {
    if (cur[last] === replacement) return false;
    setOwn(cur, last, replacement);
    return true;
  }
  delete cur[last];
  return true;
}

// ---- which rendered files carry a record ---------------------------------------------------------------------------------------
const FILE_DIR = { Family: "family", Event: "event", Note: "note", Place: "place", Media: "media" };
/**
 * person/graph.json is the graph renderer's one aggregate file (hfy-graph-render, HFY-TSK-274). It is built from every class the graph reads
 * (graph/src/project.mjs READ_CLASSES: Person, Family, Event, Place, Media; never a Note), so an expunge of any of them reaches it, and the
 * renderer writes a new version of it on every content change. It has no render-shadow copy, so only its noncurrent site versions are swept.
 */
const GRAPH_FILE = "person/graph.json";
const INDEX_FILES = {
  Person: ["person/index.json", "person/search-index.json", GRAPH_FILE],
  Family: [GRAPH_FILE],
  Event: [GRAPH_FILE],
  Place: ["place/index.json", GRAPH_FILE],
  Media: ["media/index.json", GRAPH_FILE],
};

const fileOf = (h) => {
  if (h.class === "Person") return h.gramps_id ? `person/${h.gramps_id}.json` : null;
  return FILE_DIR[h.class] ? `${FILE_DIR[h.class]}/${h.handle}.json` : null;
};

/**
 * The site keys that can carry `cls:handle`: its own file, the index files of its class, and the file of every object that references it,
 * transitively until a Person is reached (a Person page is terminal, as in the renderer). `target` is the head item or view entry of the record.
 *
 * `view.refs` holds only the references that are live now. A delete that cleaned a reference away (a Note taken off its Person, a Person taken
 * off its Family) leaves the pages that embedded the record out of that graph, while their earlier versions in a versioned site bucket still hold
 * it. `history` (target key -> Set of source keys, from referenceHistory) adds every reference any stored version ever had; a source that is
 * deleted now is listed too, because its file keeps noncurrent versions.
 */
export function renderedKeys(view, target, history) {
  const keys = new Set();
  const add = (h) => {
    const f = fileOf(h);
    if (f) keys.add(f);
    for (const k of INDEX_FILES[h.class] ?? []) keys.add(k);
  };
  add({ class: target.class, handle: target.handle, gramps_id: target.gramps_id });
  const seen = new Set();
  const queue = [`${target.class}:${target.handle}`];
  while (queue.length > 0) {
    const t = queue.shift();
    for (const src of new Set([...(view.refs.get(t) ?? []), ...(history?.get(t) ?? [])])) {
      if (seen.has(src)) continue;
      seen.add(src);
      const h = view.heads.get(src);
      if (!h || (h.deleted && !history?.get(t)?.has(src))) continue;
      add(h);
      if (h.class !== "Person") queue.push(src);
    }
  }
  return [...keys].sort();
}

/**
 * Every reference that any stored version of any record ever held: target key ("Class:handle") -> Set of source keys. One read of SYNC#LOG, parsing
 * every entry that still holds an object (an expunged one holds none). It is read once per run, before anything is rewritten, so a --due run that
 * expunges several records still sees the references of the ones it already nulled.
 */
export async function referenceHistory(ctx) {
  const refs = new Map();
  let key;
  for (let i = 0; i < 100000; i += 1) {
    const r = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": logKey(1).PK }, ConsistentRead: true, ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const e of r.Items ?? []) {
      if (typeof e.obj_json !== "string" || e.expunged === true || !e.class || !e.handle) continue;
      let obj;
      try {
        obj = JSON.parse(e.obj_json);
      } catch {
        continue; // not an object we can read: it holds nothing to follow
      }
      const src = `${e.class}:${e.handle}`;
      for (const t of collectRefs(obj)) {
        const k = `${t.cls}:${t.handle}`;
        if (k !== src) (refs.get(k) ?? refs.set(k, new Set()).get(k)).add(src);
      }
    }
    key = r.LastEvaluatedKey;
    if (!key) return refs;
  }
  throw new ExpungeError("a log listing did not end; stopping");
}

/** `referenceHistory`, read once per run when the run carries a memo (`run` adds one), else read now. */
function historyFor(ctx) {
  if (!ctx.memo) return referenceHistory(ctx);
  return (ctx.memo.history ??= referenceHistory(ctx));
}

// ---- record mode ------------------------------------------------------------------------------------------------------------
async function recordHistory(ctx, cls, handle, head) {
  const idx = await queryAll(ctx, {
    IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `RECHIST#${cls}#${handle}` },
  });
  // GSI1 is eventually consistent: the head's own entry is always added, and every entry is re-read from the table.
  const seqs = new Set(idx.map((e) => e.seq).filter(Number.isInteger));
  if (Number.isInteger(head?.seq)) seqs.add(head.seq);
  const entries = [];
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    const e = await get(ctx, logKey(seq));
    if (e && e.class === cls && e.handle === handle) entries.push(e);
  }
  return entries;
}

/** The sync conflicts of one handle, in every state. */
async function handleConflicts(ctx, cls, handle) {
  const out = [];
  for (const state of ["open", "resolved", "dismissed"]) {
    const items = await queryAll(ctx, { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `SYNCCONFLICT#${state}` } });
    // A path entry that holds anything besides its `path` carries values (cloud, local ...): those are redacted, and a redacted one is not found again.
    for (const it of items) if (it.class === cls && it.handle === handle && Array.isArray(it.paths) && it.paths.some((p) => Object.keys(p ?? {}).some((k) => k !== "path"))) out.push(it);
  }
  return out;
}

/** Rewrites one object copy, pinned to the hash it was read with (a concurrent writer changes the hash, and the write fails instead of undoing it). */
const rewriteUpdate = (ctx, key, objJson, oldHash) => ({
  Update: {
    TableName: ctx.table, Key: key, UpdateExpression: "SET #oj = :j, #h = :h", ConditionExpression: "#h = :old",
    ExpressionAttributeNames: { "#oj": "obj_json", "#h": "hash" }, ExpressionAttributeValues: { ":j": objJson, ":h": sha256(objJson), ":old": oldHash },
  },
});
const nullUpdate = (ctx, key) => ({
  Update: {
    TableName: ctx.table, Key: key, UpdateExpression: "SET #oj = :n, #ex = :t", ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: { "#oj": "obj_json", "#ex": "expunged" }, ExpressionAttributeValues: { ":n": null, ":t": true },
  },
});

/** Every version of every snapshot object (and the checkpoint). */
async function snapshotCopies(ctx) {
  const sync = ctx.syncBucket;
  return { sync, syncVersioned: await bucketVersioned(ctx, sync), snapshots: await listVersions(ctx, sync, SNAPSHOT_PREFIX) };
}

/**
 * A Media record's photo: every version of media/<handle>.<ext> (a binary, never the rendered media/<handle>.json) and of the staging copies under
 * media/.staging/<handle>/. The renderer never writes or deletes either (sync-render.md), so nothing else would. `handle` is already shaped like a
 * Gramps handle (hex), so it is safe in a pattern.
 */
async function mediaPhotoVersions(ctx, handle) {
  const s3 = siteClient(ctx);
  const binary = new RegExp(`^media/${handle}\\.(?!json$)[^/]+$`, "i"); // any extension but the rendered json, an older or upper-case one included
  const own = (await listVersions(ctx, ctx.siteBucket, `media/${handle}.`, s3)).filter((v) => binary.test(v.key));
  const staged = (await listVersions(ctx, ctx.siteBucket, `media/.staging/${handle}/`, s3)).filter((v) => v.key.startsWith(`media/.staging/${handle}/`));
  return [...own, ...staged];
}

/**
 * Steps (b), (c) and (d) shared by every record run: what the snapshots, the rendered copies and a Media photo hold. `snapshots` false leaves the
 * snapshots to the caller. `photoOf` is the handle of a Media record that is being removed whole (its photo goes too), else undefined.
 */
async function copiesOf(ctx, keys, { snapshots: withSnapshots = true, photoOf } = {}) {
  const { sync, syncVersioned, snapshots } = withSnapshots ? await snapshotCopies(ctx) : { sync: ctx.syncBucket, syncVersioned: await bucketVersioned(ctx, ctx.syncBucket), snapshots: [] };
  const shadow = [];
  for (const k of keys) shadow.push(...(await exactVersions(ctx, sync, `render-shadow/${k}`)));
  const s3 = siteClient(ctx);
  const siteVersioned = await bucketVersioned(ctx, ctx.siteBucket, s3);
  const site = [];
  if (siteVersioned) for (const k of keys) site.push(...(await exactVersions(ctx, ctx.siteBucket, k, s3)).filter((v) => !v.latest));
  const photo = photoOf ? await mediaPhotoVersions(ctx, photoOf) : [];
  return { sync, syncVersioned, snapshots, shadow, siteVersioned, site, photo };
}

/** Deletes the snapshot versions and rebuilds the snapshot from a fresh view; then removes anything a racing writer left behind. */
async function resnapshot(ctx, copies) {
  await deleteVersions(ctx, copies.sync, copies.snapshots, copies.syncVersioned);
  const store = { ddb: ctx.ddb, cmds: ctx.cmds, table: ctx.table, now: ctx.now, s3: ctx.s3, syncBucket: ctx.syncBucket, log: { warn() {}, error() {} } };
  const view = await rebuildStoreView(store);
  const head = await get(ctx, headKey());
  await writeSnapshot(store, { seq: view.seq, head, heads: [...view.heads.values()] });
  const keep = new Set([`${SNAPSHOT_PREFIX}${view.seq}.jsonl.gz`, `${SNAPSHOT_PREFIX}latest.json`]);
  const stray = (await listVersions(ctx, copies.sync, SNAPSHOT_PREFIX)).filter((v) => !(v.latest && !v.marker && keep.has(v.key)));
  await deleteVersions(ctx, copies.sync, stray, copies.syncVersioned);
  return stray.length;
}

/**
 * Deletes the schedule items and the sweep marker once the snapshot is rebuilt. Nothing owed is dropped before then: a crash earlier leaves them,
 * and the next run (--due, or the same --record) finishes the cleanup.
 */
async function finishSweep(ctx, scheduleKeys) {
  for (const Key of scheduleKeys) await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key }));
  await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key: SWEEP_KEY }));
}

/**
 * One record. `path` undefined: the whole record (tombstones only). `sweep` (with `path`): this run follows sync-admin render, so a path that is no
 * longer found is expected and only the copies outside the table are removed. `due` is the EXPUNGE# item when a --due run called this.
 * Returns { counts, skipped?, schedule? } (`schedule` is the key of the EXPUNGE# item a deferred run still owes a delete, after its sweep).
 * A transaction that a resurrect or an edit cancelled is retried once from a fresh read (what was nulled before it stays nulled).
 */
export async function expungeRecord(ctx, opts) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await expungeRecordOnce(ctx, opts);
    } catch (e) {
      if (!isCancelled(e)) throw e;
      if (attempt >= 1) throw new ExpungeError("the record changed while it was being expunged (a resurrect or an edit); run the same command again", "record_moved");
      ctx.log("record: it changed while being expunged; reading it again");
    }
  }
}

async function expungeRecordOnce(ctx, { cls, handle, path, replacement = "", apply = false, who, due, deferSnapshot = false, sweep = false }) {
  const { log } = ctx;
  if (!CLASSES.includes(cls)) throw new ExpungeError(`unknown class ${String(cls).slice(0, 32)}`, "unknown_class");
  if (typeof handle !== "string" || !HANDLE_SHAPE.test(handle)) throw new ExpungeError("the handle is not shaped like a Gramps handle", "handle_shape");
  const tokens = path === undefined ? undefined : parsePointer(path);
  const head = await get(ctx, recKey(cls, handle));
  if (!head) throw new ExpungeError("no such record in the store", "no_such_record");
  if (tokens === undefined && head.deleted !== true) {
    if (due) return { skipped: "live", counts: {} };
    throw new ExpungeError("that record is live: withdraw or delete it first (a withdraw schedules this expunge), or use --path to scrub one value", "live");
  }
  if (due && tokens === undefined && due.version !== head.version) return { skipped: "moved", counts: {} };
  const entries = await recordHistory(ctx, cls, handle, head);
  const sweepOwed = Boolean(await get(ctx, SWEEP_KEY));

  // The rewrites of the object copies.
  const logItems = [];
  let headItem;
  // Every transaction that touches a log entry also checks the head is still the one read here, so a resurrect or an edit cancels the next chunk.
  const guard = {
    ConditionCheck: tokens === undefined
      ? { TableName: ctx.table, Key: recKey(cls, handle), ConditionExpression: "#d = :t AND #v = :v AND #s = :s", ExpressionAttributeNames: { "#d": "deleted", "#v": "version", "#s": "seq" }, ExpressionAttributeValues: { ":t": true, ":v": head.version, ":s": head.seq } }
      : { TableName: ctx.table, Key: recKey(cls, handle), ConditionExpression: "#v = :v AND #s = :s", ExpressionAttributeNames: { "#v": "version", "#s": "seq" }, ExpressionAttributeValues: { ":v": head.version, ":s": head.seq } },
  };
  if (tokens === undefined) {
    for (const e of entries) if (!(e.expunged === true && e.obj_json == null)) logItems.push(nullUpdate(ctx, logKey(e.seq)));
    if (!(head.expunged === true && head.obj_json == null)) headItem = { Update: { ...nullUpdate(ctx, recKey(cls, handle)).Update, ConditionExpression: "#d = :t AND #v = :v AND #s = :s", ExpressionAttributeNames: { "#oj": "obj_json", "#ex": "expunged", "#d": "deleted", "#v": "version", "#s": "seq" }, ExpressionAttributeValues: { ":n": null, ":t": true, ":v": head.version, ":s": head.seq } } };
  } else {
    const scrub = (item) => {
      if (item.obj_json == null || item.expunged === true) return null;
      const obj = JSON.parse(item.obj_json);
      if (!scrubAt(obj, tokens, replacement)) return null;
      return objectJson(obj);
    };
    for (const e of entries) {
      const next = scrub(e);
      if (next !== null && next !== e.obj_json) logItems.push(rewriteUpdate(ctx, logKey(e.seq), next, e.hash ?? sha256(e.obj_json)));
    }
    const next = scrub(head);
    if (next !== null && next !== head.obj_json) headItem = rewriteUpdate(ctx, recKey(cls, handle), next, head.hash ?? sha256(head.obj_json));
    // A rerun after a crash finds the value already gone; when a sweep is owed it finishes that instead of refusing (a typo still is refused).
    if (logItems.length === 0 && !headItem && !sweepOwed && !sweep) throw new ExpungeError("the path was not found in any copy of that record (or already holds the replacement); after a render, add --sweep to remove the copies it left", "path_not_found");
  }
  const conflicts = await handleConflicts(ctx, cls, handle);
  const rewrites = logItems.length + (headItem ? 1 : 0) + conflicts.length;
  const view = await storeView({ ddb: ctx.ddb, cmds: ctx.cmds, table: ctx.table, now: ctx.now });
  const keys = renderedKeys(view, { class: cls, handle, gramps_id: head.gramps_id }, await historyFor(ctx));
  // A Media photo goes with a whole-record expunge only (the record is a tombstone here); --path never removes the file.
  const photoOf = tokens === undefined && cls === "Media" ? handle : undefined;
  const copies = await copiesOf(ctx, keys, { snapshots: !deferSnapshot, photoOf });
  const scheduleKey = (await get(ctx, expungeKey(cls, handle))) ? expungeKey(cls, handle) : undefined;
  const counts = {
    log_entries: logItems.length, head: headItem ? 1 : 0, conflicts: conflicts.length, snapshot_versions: copies.snapshots.length, shadow_versions: copies.shadow.length,
    site_noncurrent_versions: copies.site.length, rendered_keys: keys.length, schedule_items: scheduleKey ? 1 : 0,
    ...(photoOf ? { media_file_versions: copies.photo.length } : {}),
  };
  log(`record ${cls}${path ? " (one value)" : ""}: ${plural(counts.log_entries, "log entry", "log entries")}, ${plural(counts.head, "head")}, ${plural(counts.conflicts, "conflict")}, ${plural(counts.snapshot_versions, "snapshot version")}, ${plural(counts.shadow_versions, "shadow version")}, ${plural(counts.site_noncurrent_versions, "noncurrent site version")} over ${plural(keys.length, "rendered key")}${copies.siteVersioned ? "" : " (the site bucket is not versioned)"}${photoOf ? `; ${plural(counts.media_file_versions, "photo file version")} (the file and its staging copies)` : ""}${rewrites === 0 ? "; nothing left to rewrite, only the copies outside the table" : ""}`);
  if (!apply) return { counts };

  const at = iso(ctx);
  // The log entries first (each chunk guarded by the head), then the conflicts.
  await transactAll(ctx, logItems, guard);
  await transactAll(ctx, conflicts.map((c) => ({
    Update: {
      TableName: ctx.table, Key: { PK: c.PK, SK: c.SK }, UpdateExpression: "SET #p = :p", ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#p": "paths" }, ExpressionAttributeValues: { ":p": c.paths.map((p) => ({ path: p?.path })) },
    },
  })));
  if (rewrites > 0) {
    // The head rewrite, the epoch, the sweep marker and the audit commit together. The schedule item stays until the snapshot is rebuilt.
    const final = [];
    if (headItem) final.push(headItem);
    final.push({
      Update: {
        TableName: ctx.table, Key: headKey(), UpdateExpression: "SET #u = :at ADD #ee :one", ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#u": "updated_at", "#ee": "expunge_epoch" }, ExpressionAttributeValues: { ":at": at, ":one": 1 },
      },
    });
    final.push({ Put: { TableName: ctx.table, Item: { ...SWEEP_KEY, entity: "expunge_sweep", at } } });
    final.push({ Put: { TableName: ctx.table, Item: auditPut(ctx, who, tokens === undefined ? "record" : "record-path", counts) } });
    await transactAll(ctx, final);
  }
  // The copies outside the table. The shadow and the site bucket first, then the snapshot is rebuilt from the table as it now is.
  await deleteVersions(ctx, copies.sync, copies.shadow, copies.syncVersioned);
  await deleteSiteVersions(ctx, [...copies.site, ...copies.photo], copies.siteVersioned);
  if (deferSnapshot) return { counts, schedule: scheduleKey };
  const stray = await resnapshot(ctx, copies);
  await finishSweep(ctx, scheduleKey ? [scheduleKey] : []);
  log(`record ${cls}: applied${stray ? `; ${plural(stray, "stray snapshot version")} removed after the rebuild` : ""}. Run sync-admin render --full so the site files are rewritten from the store.`);
  return { counts };
}

// ---- due mode -----------------------------------------------------------------------------------------------------------------
async function expungeDue(ctx, { now: takeAll = false, apply, who }) {
  const { log } = ctx;
  const bound = `${iso(ctx)}~`; // GSI1SK is `<due_at>#<Class>#<handle>`; "~" sorts after "#"
  const items = await queryAll(ctx, takeAll
    ? { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": EXPUNGE_QUEUE } }
    : { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk AND GSI1SK <= :after", ExpressionAttributeValues: { ":pk": EXPUNGE_QUEUE, ":after": bound } });
  log(`due: ${plural(items.length, "scheduled expunge")} ${takeAll ? "(--now: all of them)" : "past the 72-hour grace"}`);
  const total = { records: 0, skipped: 0, failed: 0 };
  const owed = []; // schedule items to delete once the snapshot is rebuilt
  for (const it of items) {
    const label = CLASSES.includes(it.class) ? it.class : "record"; // a schedule item is data: only a known class name is printed
    try {
      const r = await expungeRecord(ctx, { cls: it.class, handle: it.handle, apply, who, due: it, deferSnapshot: true });
      if (r.skipped) {
        total.skipped += 1;
        log(`due: skipped one ${label} (${r.skipped}); ${apply ? "its schedule item is dropped" : "a run with --apply drops its schedule item"}`);
        if (apply) await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key: expungeKey(it.class, it.handle) }));
      } else {
        total.records += 1;
        if (r.schedule) owed.push(r.schedule);
      }
    } catch (e) {
      // A failure line names the class, the error name and its code: a thrown message can carry a handle or a value.
      if (!(e instanceof ExpungeError) && !isCancelled(e)) throw e;
      total.failed += 1;
      log(`due: one ${label} failed (${e.name}${e.code ? ` ${e.code}` : ""}); its schedule item stays for the next run`);
    }
  }
  // One snapshot rebuild for the whole run, not one per record. It also runs when a crashed run left a sweep owed, even with no record due now.
  const snaps = await snapshotCopies(ctx);
  total.snapshot_versions = snaps.snapshots.length;
  const sweepOwed = Boolean(await get(ctx, SWEEP_KEY));
  const sweep = total.records > 0 || sweepOwed;
  if (apply && sweep) {
    total.stray = await resnapshot(ctx, snaps);
    await finishSweep(ctx, owed);
    if (total.records > 0) await ctx.ddb.send(new ctx.cmds.PutCommand({ TableName: ctx.table, Item: auditPut(ctx, who, "due", { records: total.records, snapshot_versions: total.snapshot_versions }) }));
  }
  log(`due: ${total.records} expunged, ${total.skipped} skipped, ${total.failed} failed; ${plural(snaps.snapshots.length, "snapshot version")} ${apply && sweep ? "replaced by a rebuilt snapshot" : "would be replaced"}${sweepOwed ? " (a sweep was owed from an earlier run)" : ""}. Run sync-admin render --full so the site files are rewritten from the store.`);
  return { counts: total };
}

// ---- proposal mode ------------------------------------------------------------------------------------------------------------
/** The IDEM# receipts and PROPREQ# items that point at proposal `id`, by one filtered scan on `entity`. */
async function proposalReceipts(ctx, id) {
  const found = [];
  let key;
  for (let i = 0; i < 10000; i += 1) {
    const r = await ctx.ddb.send(new ctx.cmds.ScanCommand({
      TableName: ctx.table, FilterExpression: "#e IN (:e0, :e1)", ExpressionAttributeNames: { "#e": "entity" }, ExpressionAttributeValues: { ":e0": "idem", ":e1": "proposal_request" },
      ConsistentRead: true, ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    found.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) {
      const body = (it) => it.result?.body;
      return {
        receipts: found.filter((it) => it.entity === "idem" && (body(it)?.id === id || body(it)?.proposal?.id === id)),
        requests: found.filter((it) => it.entity === "proposal_request" && it.id === id && it.expunged !== true),
      };
    }
  }
  throw new ExpungeError("a table scan did not end; stopping");
}

async function expungeProposal(ctx, { id, apply, who }) {
  const { log } = ctx;
  if (!ULID_RE.test(id ?? "")) throw new ExpungeError("--proposal needs a 26-character ULID");
  const rows = await queryAll(ctx, { KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `PROP#${id}` }, ConsistentRead: true });
  if (rows.length === 0) throw new ExpungeError("no such proposal");
  const thread = await queryAll(ctx, { KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `THREAD#proposal:${id}` }, ConsistentRead: true });
  const comments = thread.filter((r) => r.SK.startsWith("C#") && r.comment);
  const photoKeys = [...new Set(comments.flatMap((r) => (Array.isArray(r.comment.attachments) ? r.comment.attachments : []).map((a) => (typeof a?.url === "string" ? a.url.replace(/^\//, "") : "")).filter((k) => UPLOAD_KEY_RE.test(k))))];
  const audits = [];
  for (const c of comments) audits.push(...(await queryAll(ctx, { KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `AUDIT#${c.comment.id}` } })));
  // The proposal's own audit trail (create, amend, withdraw, decide): states and counts, plus the free-text reason an admin typed on a decision.
  const propAudits = await queryAll(ctx, { KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `AUDIT#proposal:${id}` }, ConsistentRead: true });
  // The idempotency receipts (24 hours, but a deleted-by-TTL item can linger) echo the proposal in their result body, and a system proposal's
  // PROPREQ# item holds a hash of its content. Neither is reachable by key from the proposal id, so one filtered scan finds them.
  const { receipts, requests } = await proposalReceipts(ctx, id);
  const siteVersioned = photoKeys.length > 0 ? await bucketVersioned(ctx, ctx.siteBucket) : false;
  const photoVersions = [];
  for (const k of photoKeys) photoVersions.push(...(await exactVersions(ctx, ctx.siteBucket, k)));
  const counts = {
    proposal_items: rows.length, thread_items: thread.length, comment_audits: audits.length, proposal_audits: propAudits.length, receipts: receipts.length, request_items: requests.length,
    photos: photoKeys.length, photo_versions: photoVersions.length,
  };
  log(`proposal: ${plural(counts.proposal_items, "item")} to redact, ${plural(counts.thread_items, "thread item")} (${plural(comments.length, "comment")}) to delete, ${plural(counts.comment_audits, "comment audit row")} and ${plural(counts.proposal_audits, "proposal audit row")} to redact, ${plural(counts.receipts, "idempotency receipt")} to delete, ${plural(counts.request_items, "request item")} to redact, ${plural(counts.photos, "photo")} (${plural(counts.photo_versions, "version")}) to delete`);
  if (!apply) return { counts };

  const at = iso(ctx);
  await transactAll(ctx, rows.map((r) => ({
    Update: {
      TableName: ctx.table, Key: { PK: r.PK, SK: r.SK }, UpdateExpression: "SET #e = :e, #x = :t, #xa = :at REMOVE #p, GSI1PK, GSI1SK", ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#e": "entity", "#x": "expunged", "#xa": "expunged_at", "#p": "proposal" }, ExpressionAttributeValues: { ":e": "proposal_expunged", ":t": true, ":at": at },
    },
  })));
  await transactAll(ctx, thread.map((r) => ({ Delete: { TableName: ctx.table, Key: { PK: r.PK, SK: r.SK } } })));
  // The audit rows of the comments and of the proposal keep who, what and when, and lose the text they copied, a decision reason included
  // (an audited exception to append-only).
  await transactAll(ctx, [...audits, ...propAudits].map((r) => ({
    Update: {
      TableName: ctx.table, Key: { PK: r.PK, SK: r.SK }, UpdateExpression: "SET #b = :n, #a = :n, #r = :t REMOVE #rs", ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#b": "before", "#a": "after", "#r": "redacted", "#rs": "reason" }, ExpressionAttributeValues: { ":n": null, ":t": true },
    },
  })));
  // The receipts go (a replay inside their 24 hours then files a new request); the PROPREQ# items lose their content hash, so a reused request id
  // is refused as a different suggestion and the id still resolves to the (expunged) proposal.
  await transactAll(ctx, receipts.map((r) => ({ Delete: { TableName: ctx.table, Key: { PK: r.PK, SK: r.SK } } })));
  await transactAll(ctx, requests.map((r) => ({
    Update: {
      TableName: ctx.table, Key: { PK: r.PK, SK: r.SK }, UpdateExpression: "SET #x = :t REMOVE #rh", ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#x": "expunged", "#rh": "requestHash" }, ExpressionAttributeValues: { ":t": true },
    },
  })));
  await deleteVersions(ctx, ctx.siteBucket, photoVersions, siteVersioned);
  for (const k of photoKeys) await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key: { PK: `UPLOAD#${UPLOAD_KEY_RE.exec(k)[1]}`, SK: "META" } }));
  await ctx.ddb.send(new ctx.cmds.PutCommand({ TableName: ctx.table, Item: auditPut(ctx, who, "proposal", counts) }));
  log("proposal: applied");
  return { counts };
}

// ---- chat mode ----------------------------------------------------------------------------------------------------------------
/** `<conv>:<seq>`: the conversation id itself holds colons, so the seq is what follows the last one. */
export function parseChatRef(ref) {
  const i = typeof ref === "string" ? ref.lastIndexOf(":") : -1;
  const conv = i > 0 ? ref.slice(0, i) : "";
  const seq = i > 0 ? ref.slice(i + 1) : "";
  if (!CONV_RE.test(conv) || !/^[1-9]\d{0,9}$/.test(seq)) throw new ExpungeError("--chat needs <conv>:<seq>, for example g:<id>:42");
  return { conv, seq: Number(seq) };
}

/** The chat hub's admin route: POST <url>/admin/expunge {conv, seq} with a bearer token; 200 {nulled: 0|1}, 404 when the hub has no such message. */
export function createHubClient({ url, token, fetchImpl = globalThis.fetch }) {
  if (!url || !token) throw new ExpungeError("the chat hub needs CHAT_HUB_ADMIN_URL and CHAT_HUB_ADMIN_TOKEN");
  const u = new URL(url);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new ExpungeError("CHAT_HUB_ADMIN_URL must be https");
  return {
    async nullMessage({ conv, seq }) {
      const r = await fetchImpl(`${url.replace(/\/+$/, "")}/admin/expunge`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ conv, seq }),
      });
      if (r.status === 404) return { nulled: 0 };
      if (r.status === 503) throw new ExpungeError("the chat hub is busy archiving and nulled nothing: run the same command again in a minute");
      if (!r.ok) throw new ExpungeError(`the chat hub answered ${r.status}`);
      const body = await r.json().catch(() => ({}));
      return { nulled: body?.nulled === 0 ? 0 : 1 };
    },
  };
}

/** Printed on every chat run: the pinned chat client cannot yet decode a history that holds a removed message (docs/how-to/deploy-the-chat-worker.md). */
export const CHAT_CLIENT_WARNING =
  "chat: WARNING: @io-kit/chat 0.1.6 clients reject a history batch that holds a removed message (text null), so after --apply that conversation's history will not load for them. Run it only while chat is dark (chatV1 flag off, UAT only) until the kit release that shows 'message removed' is pinned.";

async function expungeChat(ctx, { ref, apply, who }) {
  const { log } = ctx;
  const { conv, seq } = parseChatRef(ref);
  const key = { PK: `CHAT#${conv}`, SK: `M#${String(seq).padStart(10, "0")}` };
  const row = await get(ctx, key);
  const counts = { mirror_rows: row ? 1 : 0, hub_messages: 0 };
  log(`chat: ${plural(counts.mirror_rows, "mirror row")} to delete; the hub message is nulled through its admin route when applied`);
  log(CHAT_CLIENT_WARNING);
  if (!apply) return { counts };
  if (!ctx.hub) throw new ExpungeError("the chat hub is not configured: set CHAT_HUB_ADMIN_URL and CHAT_HUB_ADMIN_TOKEN");
  counts.hub_messages = (await ctx.hub.nullMessage({ conv, seq })).nulled;
  // The hub is the source the archive mirrors from, so it is nulled first: a batch that arrives later carries no text.
  await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key: key }));
  await ctx.ddb.send(new ctx.cmds.PutCommand({ TableName: ctx.table, Item: auditPut(ctx, who, "chat", counts) }));
  log(`chat: applied (${plural(counts.hub_messages, "hub message")} nulled, ${plural(counts.mirror_rows, "mirror row")} deleted)`);
  return { counts };
}

// ---- upload mode --------------------------------------------------------------------------------------------------------------
async function expungeUpload(ctx, { key, apply, who }) {
  const { log } = ctx;
  const m = UPLOAD_KEY_RE.exec(key ?? "");
  if (!m) throw new ExpungeError("--upload needs a key such as uploads/posts/<ulid>/photo.jpg or uploads/comments/<ulid>/photo.png");
  const versioned = await bucketVersioned(ctx, ctx.siteBucket);
  const versions = await exactVersions(ctx, ctx.siteBucket, key);
  const binding = await get(ctx, { PK: `UPLOAD#${m[1]}`, SK: "META" });
  const counts = { versions: versions.length, bindings: binding ? 1 : 0 };
  log(`upload: ${plural(counts.versions, "object version")} (delete markers included) and ${plural(counts.bindings, "UPLOAD# binding")} to delete`);
  if (!apply) return { counts };
  await deleteVersions(ctx, ctx.siteBucket, versions, versioned);
  if (binding) await ctx.ddb.send(new ctx.cmds.DeleteCommand({ TableName: ctx.table, Key: { PK: `UPLOAD#${m[1]}`, SK: "META" } }));
  await ctx.ddb.send(new ctx.cmds.PutCommand({ TableName: ctx.table, Item: auditPut(ctx, who, "upload", counts) }));
  log("upload: applied");
  return { counts };
}

// ---- step-up and the CLI --------------------------------------------------------------------------------------------------------
/**
 * io's step-up: the token must verify as a sync access token of a gramps-owner whose sign-in is fresh (amr mfa, auth_time within 300 s).
 * `authenticate` is createSyncAuthenticator's function. Returns { sub }. Nothing from the token is printed.
 */
export async function stepUpFrom(authenticate, token, nowMs = Date.now()) {
  if (typeof token !== "string" || token === "") throw new ExpungeError("--apply needs io's step-up: set EXPUNGE_ACCESS_TOKEN to the sync access token of a fresh sign-in (amr mfa, auth_time within 300 s)");
  let actor;
  try {
    actor = await authenticate({ headers: { authorization: `Bearer ${token}` } });
    requireOwner(actor);
    requireStepUp(actor, nowMs, "expunge");
  } catch (e) {
    throw new ExpungeError(`step-up refused: ${e?.code ?? e?.name ?? "error"}; sign in again as the tree owner (user verification) and retry within 300 seconds`);
  }
  return { sub: actor.id };
}

export const HELP = `expunge.mjs: remove a record value, proposal, chat message or upload from every cloud copy.

Usage:
  node scripts/expunge.mjs --record <Class>:<handle> [--path <pointer> [--replacement <text>] [--sweep]] [--apply]
  node scripts/expunge.mjs --proposal <ulid> [--apply]
  node scripts/expunge.mjs --chat <conv>:<seq> [--apply]
  node scripts/expunge.mjs --upload <key> [--apply]
  node scripts/expunge.mjs --due [--now] [--apply]
Common: [--dry-run] [--table hfy-app] [--region us-west-2] [--sync-bucket harrisonfamily-sync] [--site-bucket harrisonfamily-frontend]
Dry run by default: without --apply nothing is written. -h/--help prints this.

--apply NEEDS IO'S STEP-UP: EXPUNGE_ACCESS_TOKEN holds the sync access token of the tree owner's fresh sign-in (mfa, auth_time within
300 s). A chat expunge also needs CHAT_HUB_ADMIN_URL and CHAT_HUB_ADMIN_TOKEN. Run the dry run first and read the counts. Each --apply writes
AUDIT#expunge:<id> with counts only. See docs/how-to/operate-the-sync-store.md (remove something from the cloud).

--record on the rendered data prefixes of the site bucket: once the data-write guard is applied, the administrator credentials cannot delete
versions there or a Media photo. Hand the site-bucket calls a break-glass session (hfy-data-breakglass) in EXPUNGE_SITE_AWS_ACCESS_KEY_ID,
EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY and EXPUNGE_SITE_AWS_SESSION_TOKEN (all three or none); the table and the sync bucket keep the usual credentials.
--sweep (with --path) runs the copies steps again after sync-admin render --full, when a path that is no longer found is expected.
`;

export function parseArgs(argv, env = process.env) {
  const out = { apply: false, table: env.TABLE_NAME ?? "hfy-app", region: env.AWS_REGION ?? "us-west-2" };
  const rest = [...argv];
  if (rest.includes("-h") || rest.includes("--help")) return { help: true };
  const modes = [];
  let dry = 0;
  let apply = 0;
  const value = (flag, i) => {
    if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) throw new ExpungeError(`${flag} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--dry-run") dry += 1;
    else if (a === "--apply") apply += 1;
    else if (a === "--record") {
      modes.push("record");
      out.record = value(a, i++);
    } else if (a === "--proposal") {
      modes.push("proposal");
      out.proposal = value(a, i++);
    } else if (a === "--chat") {
      modes.push("chat");
      out.chat = value(a, i++);
    } else if (a === "--upload") {
      modes.push("upload");
      out.upload = value(a, i++);
    } else if (a === "--due") {
      modes.push("due");
      out.due = true;
    }
    else if (a === "--now") out.now = true;
    else if (a === "--sweep") out.sweep = true;
    else if (a === "--path") out.path = value(a, i++);
    else if (a === "--replacement") out.replacement = value(a, i++);
    else if (a === "--table") out.table = value(a, i++);
    else if (a === "--region") out.region = value(a, i++);
    else if (a === "--sync-bucket") out.syncBucket = value(a, i++);
    else if (a === "--site-bucket") out.siteBucket = value(a, i++);
    else throw new ExpungeError(`unknown argument ${a}`);
  }
  if (modes.length !== 1) throw new ExpungeError("pass exactly one of --record, --proposal, --chat, --upload or --due");
  if (dry + apply > 1 || dry > 1 || apply > 1) throw new ExpungeError("pass --dry-run or --apply once, not both (dry run is the default)");
  out.apply = apply === 1;
  out.mode = modes[0];
  if (out.path !== undefined && out.mode !== "record") throw new ExpungeError("--path only applies to --record");
  if (out.replacement !== undefined && out.path === undefined) throw new ExpungeError("--replacement only applies with --path");
  if (out.now && out.mode !== "due") throw new ExpungeError("--now only applies to --due");
  if (out.sweep && (out.mode !== "record" || out.path === undefined)) throw new ExpungeError("--sweep only applies to --record with --path (a whole-record run can simply be run again)");
  if (out.mode === "record") {
    const i = out.record.indexOf(":");
    const cls = i > 0 ? out.record.slice(0, i) : "";
    const handle = i > 0 ? out.record.slice(i + 1) : "";
    if (!CLASSES.includes(cls) || !HANDLE_SHAPE.test(handle)) throw new ExpungeError("--record needs <Class>:<handle>, for example Note:<28 hex characters>");
    out.cls = cls;
    out.handle = handle;
    if (out.path !== undefined) parsePointer(out.path);
  }
  if (out.mode === "proposal" && !ULID_RE.test(out.proposal)) throw new ExpungeError("--proposal needs a 26-character ULID");
  if (out.mode === "chat") parseChatRef(out.chat);
  if (out.mode === "upload" && !UPLOAD_KEY_RE.test(out.upload)) throw new ExpungeError("--upload needs a key such as uploads/posts/<ulid>/photo.jpg");
  if (!out.table || !out.region) throw new ExpungeError("--table and --region need a value");
  return out;
}

/**
 * Runs a parsed command. `ctx` = { ddb, cmds, table, s3, syncBucket, siteBucket, log, now, uid, stepUp?, hub? }.
 * On --apply, `ctx.stepUp()` must resolve to { sub } before anything is written.
 */
export async function run(args, ctx) {
  let who = { sub: "operator" };
  if (args.apply) {
    if (typeof ctx.stepUp !== "function") throw new ExpungeError("--apply needs io's step-up and none is configured");
    who = await ctx.stepUp();
  } else ctx.log("dry run: nothing is written, deleted or sent");
  // `memo` holds what one run reads once however many records it expunges (the reference history).
  const c = { ...ctx, uid: ctx.uid ?? randomUUID, syncBucket: args.syncBucket ?? ctx.syncBucket, siteBucket: args.siteBucket ?? ctx.siteBucket, memo: {} };
  const apply = args.apply === true;
  switch (args.mode) {
    case "record":
      return expungeRecord(c, { cls: args.cls, handle: args.handle, path: args.path, replacement: args.replacement ?? "", apply, who, sweep: args.sweep === true });
    case "proposal":
      return expungeProposal(c, { id: args.proposal, apply, who });
    case "chat":
      return expungeChat(c, { ref: args.chat, apply, who });
    case "upload":
      return expungeUpload(c, { key: args.upload, apply, who });
    case "due":
      return expungeDue(c, { now: args.now === true, apply, who });
    default:
      throw new ExpungeError(`unknown mode ${args.mode}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
    } else {
      const env = process.env;
      const [{ DynamoDBClient }, lib, { S3Client, GetObjectCommand }, { createRemoteJWKSet }, { createGroupResolver }] = await Promise.all([
        import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb"), import("@aws-sdk/client-s3"), import("jose"), import("../src/policy.js"),
      ]);
      const ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), { marshallOptions: { removeUndefinedValues: true } });
      const cmds = { GetCommand: lib.GetCommand, PutCommand: lib.PutCommand, DeleteCommand: lib.DeleteCommand, QueryCommand: lib.QueryCommand, ScanCommand: lib.ScanCommand, TransactWriteCommand: lib.TransactWriteCommand };
      const s3 = new S3Client({ region: args.region });
      // The break-glass session for the rendered data prefixes of the site bucket, when io hands one in (see CREDENTIALS in the header).
      const siteS3 = createSiteClient(env, args.region, (config) => new S3Client(config));
      const ctx = { ddb, cmds, table: args.table, s3, ...(siteS3 ? { siteS3 } : {}), syncBucket: args.syncBucket ?? env.SYNC_BUCKET ?? DEFAULT_SYNC_BUCKET, siteBucket: args.siteBucket ?? env.SITE_BUCKET ?? DEFAULT_SITE_BUCKET, log: console.log, now: () => Date.now(), uid: randomUUID };
      if (args.apply) {
        const getGroups = createGroupResolver({
          load: async () => {
            const o = await s3.send(new GetObjectCommand({ Bucket: env.GROUPS_BUCKET ?? "harrisonfamily", Key: env.GROUPS_KEY ?? "config/groups.json" }));
            return JSON.parse(await o.Body.transformToString());
          },
        });
        const jwks = createRemoteJWKSet(new URL(env.SESSION_JWKS_URL ?? "https://harrisonfamily.us/auth/.well-known/jwks.json"), { timeoutDuration: 5000 });
        const authenticate = createSyncAuthenticator({ issuer: env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth", getJwks: async () => jwks, getGroups });
        ctx.stepUp = () => stepUpFrom(authenticate, env.EXPUNGE_ACCESS_TOKEN, Date.now());
        if (args.mode === "chat") ctx.hub = createHubClient({ url: env.CHAT_HUB_ADMIN_URL, token: env.CHAT_HUB_ADMIN_TOKEN });
      }
      await run(args, ctx);
    }
  } catch (e) {
    console.error(`expunge: ${e instanceof ExpungeError ? e.message : `${e?.name ?? "Error"}${e?.code ? ` (${e.code})` : ""}`}`);
    process.exitCode = 1;
  }
}
