#!/usr/bin/env node
// One-off, read-only R-18 scan of the posts and comments already in the app table (HFY-PLN-002 task
// privacy-guard-existing-paths AC4). It reads with Query only (GSI1 partitions POSTS and COMMENTS; the index projects ALL), runs
// every kind of shared/privacy-guard.mjs (the dob heuristic included, whatever HFY_GUARD_DOB says) over each post's body, title
// and attachment alts and each comment's body, and prints counts per kind. It never prints or keeps any text, id, key, handle or
// offset, and it writes nothing: no Put, Update, Delete or TransactWrite is ever built here.
//
//   AWS_PROFILE=<read-only profile> node api/scripts/scan-contact-info.mjs [--table hfy-app] [--region us-west-2]
//
// Needs api/node_modules (npm ci in api/). Output: one JSON object, counts only.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { KINDS, scanText } from "../src/shared/privacy-guard.mjs";

const PARTITIONS = { posts: { pk: "POSTS", attr: "post" }, comments: { pk: "COMMENTS", attr: "comment" } };

/** The free text of one stored post or comment, as strings (the same fields the write paths guard). */
export function textsOf(surface, doc) {
  if (!doc || typeof doc !== "object") return [];
  const out = [doc.body];
  if (surface === "posts") {
    out.push(doc.title);
    for (const a of Array.isArray(doc.attachments) ? doc.attachments : []) out.push(a?.alt);
  }
  return out.filter((t) => typeof t === "string" && t !== "");
}

const zeroKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));

/**
 * Query each GSI1 partition to the end and count: items scanned, items with at least one hit, and hits per kind.
 * `cmds.QueryCommand` is the only command used. Returns `{ posts: {scanned, withHit, kinds}, comments: {...} }`.
 */
export async function scanExisting({ ddb, cmds, table, pageSize = 500, maxPages = 10_000 }) {
  const result = {};
  for (const [surface, { pk, attr }] of Object.entries(PARTITIONS)) {
    const counts = { scanned: 0, withHit: 0, kinds: zeroKinds() };
    let start;
    for (let page = 0; page < maxPages; page += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "#d", ExpressionAttributeNames: { "#d": attr }, Limit: pageSize, ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      for (const item of r.Items ?? []) {
        const doc = item[attr];
        if (!doc) continue;
        counts.scanned += 1;
        let hit = false;
        for (const text of textsOf(surface, doc)) {
          for (const h of scanText(text)) {
            counts.kinds[h.kind] += 1;
            hit = true;
          }
        }
        if (hit) counts.withHit += 1;
      }
      start = r.LastEvaluatedKey;
      if (!start) break;
    }
    result[surface] = counts;
  }
  return result;
}

/** The report: counts only. Anything that is not a non-negative integer is dropped, so no text can ride along. */
export function formatReport(result, { table, at = new Date().toISOString() } = {}) {
  const clean = {};
  for (const [surface, c] of Object.entries(result)) {
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    clean[surface] = { scanned: n(c.scanned), withHit: n(c.withHit), kinds: Object.fromEntries(KINDS.map((k) => [k, n(c.kinds?.[k])])) };
  }
  return JSON.stringify({ scan: "contact-info", readOnly: true, table: String(table), at, ...clean }, null, 2);
}

const usage = () => Object.assign(new Error("usage: scan-contact-info.mjs [--table <name>] [--region <region>]"), { code: "usage" });
function args(argv) {
  const out = { table: "hfy-app", region: "us-west-2" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--table") out.table = argv[++i];
    else if (argv[i] === "--region") out.region = argv[++i];
    else throw usage();
  }
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(out.table ?? "") || !/^[a-z0-9-]{4,32}$/.test(out.region ?? "")) throw usage();
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const { table, region } = args(process.argv.slice(2));
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const result = await scanExisting({ ddb, cmds: { QueryCommand }, table });
    console.log(formatReport(result, { table }));
  } catch (e) {
    // The error name only: an SDK message can quote a request, and nothing from the table may reach the terminal.
    console.error(e?.code === "usage" ? e.message : `scan failed: ${e?.name ?? "Error"}`);
    process.exitCode = 1;
  }
}
