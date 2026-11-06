#!/usr/bin/env node
// Post-photo graduation backfill (HFY-TSK-387-0G; BRD D-10, D-34, E2E-G). Photos of posts published before the HFY_POST_GRADUATE switch went on
// have no Gramps Media. This script counts them (dry run) and, after io's approval, graduates them through the same code the publish path uses
// (src/post-graduate.js: one Media per photo with the hfy-post Tag, a MediaRef on the author, idempotent per photo).
//
//   node scripts/post-graduate-backfill.mjs [--dry-run] [--table hfy-app] [--region us-west-2]
//   node scripts/post-graduate-backfill.mjs --apply --approval-ref DOC-<12 hex> [--table hfy-app] [--region us-west-2]
//
// --dry-run is the default and reads only: it prints counts, never ids, titles or text. --apply refuses to start unless --approval-ref names the
// document that records io's approval (D-10: dry-run count, io approval, apply), and it is a scripted write to the cloud store, so it runs only
// after io's go-ahead in the session, recorded with the dry-run counts (AGENTS.md). It needs HFY_ID_POLICY=mint, a seeded store and the media bucket.
// A second apply plans nothing new: the markers make each photo once.
import { pathToFileURL } from "node:url";
import { gsiPosts } from "../src/keys.js";
import { queryPartition } from "../src/txn.js";
import { markerKey, plan } from "../src/post-graduate.js";

export const APPROVAL_REF_RE = /^DOC-[0-9A-F]{12}$/;
const REASONS = ["unsupported_type", "moderated", "bad_upload_path"];

/** Counts what a run would do. Reads the post index and one marker per photo; writes nothing. */
export async function planBackfill({ ddb, cmds, table, mediaPublicBase }) {
  const posts = await queryPartition(ddb, cmds, table, { pk: gsiPosts, accept: (i) => i?.post !== undefined, want: Number.POSITIVE_INFINITY });
  const out = { posts: posts.length, publishedWithPhotos: 0, draftsWithPhotos: 0, photos: 0, alreadyGraduated: 0, wouldGraduate: 0, wouldSkip: { total: 0, reasons: Object.fromEntries(REASONS.map((r) => [r, 0])) }, todo: [] };
  for (const { post } of posts) {
    const items = plan(post, mediaPublicBase);
    if (items.length === 0) continue;
    if (post.visibility !== "published") { out.draftsWithPhotos += 1; continue; } // graduated when it is first published
    out.publishedWithPhotos += 1;
    for (const it of items) {
      out.photos += 1;
      if (it.skip) { out.wouldSkip.total += 1; out.wouldSkip.reasons[it.skip] += 1; continue; }
      const m = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: markerKey(post.id, it.uploadId), ConsistentRead: true }))).Item;
      if (m?.state === "done") out.alreadyGraduated += 1;
      else { out.wouldGraduate += 1; if (!out.todo.includes(post.id)) out.todo.push(post.id); }
    }
  }
  return out;
}

export function describePlan(p) {
  const reasons = Object.entries(p.wouldSkip.reasons).map(([k, v]) => `${k}: ${v}`).join(", ");
  return [
    `posts scanned: ${p.posts}`,
    `published posts with photos: ${p.publishedWithPhotos} (drafts with photos, graduated at first publish: ${p.draftsWithPhotos})`,
    `photos: ${p.photos}`,
    `already graduated: ${p.alreadyGraduated}`,
    `would graduate: ${p.wouldGraduate}`,
    `would skip: ${p.wouldSkip.total} (${reasons})`,
  ];
}

/**
 * The whole run. `graduate(post)` (apply only) is createPostGraduation(...).graduate. Dry run never calls it. Returns {plan, result?}.
 * `loadPost(id)` re-reads a post for apply, so a post deleted since the plan is skipped.
 */
export async function run({ ddb, cmds, table, apply = false, approvalRef, graduate, mediaPublicBase, log = console.log }) {
  if (apply && !APPROVAL_REF_RE.test(approvalRef ?? "")) throw new Error("--apply needs --approval-ref DOC-<12 hex>: the document that records io's approval");
  const p = await planBackfill({ ddb, cmds, table, mediaPublicBase });
  for (const line of describePlan(p)) log(line);
  if (!apply) {
    log("dry run: nothing written");
    return { plan: p };
  }
  if (typeof graduate !== "function") throw new Error("apply needs a graduate function");
  const result = { done: 0, skipped: 0, pending: 0, reasons: {} };
  for (const id of p.todo) {
    const item = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: { PK: `POST#${id}`, SK: "META" }, ConsistentRead: true }))).Item;
    if (!item?.post) continue; // deleted since the plan
    const r = await graduate(item.post);
    for (const ph of r.photos) {
      if (ph.state === "done" && !ph.already) result.done += 1;
      else if (ph.state === "skipped") { result.skipped += 1; result.reasons[ph.reason] = (result.reasons[ph.reason] ?? 0) + 1; }
      else if (ph.state === "pending") result.pending += 1;
    }
  }
  log(`applied: ${result.done} graduated, ${result.skipped} skipped (${Object.entries(result.reasons).map(([k, v]) => `${k}: ${v}`).join(", ")}), ${result.pending} pending`);
  return { plan: p, result };
}

export function parseArgs(argv, env = process.env) {
  const out = { apply: undefined, approvalRef: undefined, table: env.TABLE_NAME ?? "hfy-app", region: env.AWS_REGION ?? "us-west-2" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.apply = out.apply === true ? "both" : false;
    else if (a === "--apply") out.apply = out.apply === false ? "both" : true;
    else if (a === "--approval-ref") out.approvalRef = argv[(i += 1)];
    else if (a === "--table") out.table = argv[(i += 1)];
    else if (a === "--region") out.region = argv[(i += 1)];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.apply === "both") throw new Error("pass --dry-run or --apply, not both");
  out.apply = out.apply === true;
  if (!out.apply && out.approvalRef !== undefined) throw new Error("--approval-ref is for --apply");
  if (out.apply && !APPROVAL_REF_RE.test(out.approvalRef ?? "")) throw new Error("--apply needs --approval-ref DOC-<12 hex>: the document that records io's approval");
  if (!out.table || !out.region) throw new Error("--table and --region need a value");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2)); // refuses an --apply without an approval before anything is opened
    const [{ DynamoDBClient }, lib] = await Promise.all([import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb")]);
    const ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), { marshallOptions: { removeUndefinedValues: true } });
    const cmds = { GetCommand: lib.GetCommand, QueryCommand: lib.QueryCommand, TransactWriteCommand: lib.TransactWriteCommand };
    const mediaPublicBase = process.env.MEDIA_PUBLIC_BASE ?? "https://harrisonfamily.us";
    let graduate;
    if (args.apply) {
      const [{ S3Client }, { createPostGraduation }, { idPolicyFromEnv }, { registerRecordContributor }, { randomUUID }] = await Promise.all([
        import("@aws-sdk/client-s3"), import("../src/post-graduate.js"), import("../src/sync/id-policy.js"), import("../src/record-contributor.js"), import("node:crypto"),
      ]);
      registerRecordContributor({ ddb, cmds, table: args.table });
      const store = { ddb, cmds, table: args.table, now: () => Date.now(), uid: () => randomUUID(), log: console, idPolicy: idPolicyFromEnv(process.env) };
      graduate = createPostGraduation({ ddb, cmds, table: args.table, store, s3: new S3Client({ region: args.region }), bucket: process.env.MEDIA_BUCKET ?? "harrisonfamily-frontend", mediaPublicBase, enabled: () => true }).graduate;
    }
    await run({ ddb, cmds, table: args.table, apply: args.apply, approvalRef: args.approvalRef, graduate, mediaPublicBase });
  } catch (e) {
    console.error(`post-graduate-backfill: ${e.message}`);
    process.exitCode = 1;
  }
}
