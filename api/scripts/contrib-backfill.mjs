#!/usr/bin/env node
// Contribution backfill (HFY-TSK-255; BRD2 D2-17; social.md 7.2). From deploy the API writes a ledger event and its counters with every
// comment and post. Content written before that has none, so this script credits it and then rebuilds every CSTAT# counter from the
// events, so the counts are true when contribV1 flips.
//
//   node scripts/contrib-backfill.mjs --dry-run [--table hfy-app] [--region us-west-2]
//   node scripts/contrib-backfill.mjs --apply   [--table hfy-app] [--region us-west-2]
//
// --dry-run prints the planned events and counter changes and writes nothing. --apply writes them, and is idempotent: a second run
// plans nothing and changes nothing. It is a scripted write to the app table, so it runs only after io's go-ahead in the session,
// recorded with the dry-run output (BRD2 10.2 rule 15), and with a single writer: no other process writing contributions while it runs.
//
// What it credits (kind, at):
//   comment   every comment without `comment.contrib`: its created_at.
//   post      every post that was ever published (published or withdrawn now, or a published entry in its AUDIT# history) and has no
//             `post.contrib`: the time of its first publish (the create or visibility audit entry, else created_at). A post that is
//             not published now gets a hidden event (a withdraw hides the feed entry and keeps the count).
// Event ids are derived from the time and the ref, so a rerun (or a crashed run) finds the same event instead of making another.
// The link (`contrib: { id }`) goes on the stored item(s) in the same transaction as the event. Counters are then set to the totals of
// ALL events (existing ones included), as absolute values. Events copy no body text, and the output names ids, kinds and counts only.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildEvent, dayOf, dayRowTtl, deltasOf, monthOf, personKeys, siteKeys, GSI_CONTRIBS } from "../src/contrib.js";
import { transact } from "../src/txn.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID with the time of `at` and 80 bits of randomness taken from sha256(seed): the same input always gives the same id. */
export function derivedUlid(at, seed) {
  let t = Date.parse(at);
  if (!Number.isFinite(t)) throw new TypeError("derivedUlid: at must be a timestamp");
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = createHash("sha256").update(seed).digest();
  let bits = 0n;
  for (let i = 0; i < 10; i += 1) bits = (bits << 8n) | BigInt(bytes[i]);
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}
export const eventIdFor = (at, kind, ref) => derivedUlid(at, `contrib|${kind}|${ref.type}|${ref.id}|${ref.thread ?? ""}`);

async function pages(ddb, cmds, input, limit = 500) {
  const out = [];
  let key;
  for (let i = 0; i < limit; i += 1) {
    const r = await ddb.send(new cmds.QueryCommand({ ...input, ...(key ? { ExclusiveStartKey: key } : {}) }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return out;
  }
  throw new Error("contrib-backfill: a listing did not end; stopping");
}
const byGsi = (ddb, cmds, table, pk) =>
  pages(ddb, cmds, { TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": pk } });
const byPk = (ddb, cmds, table, pk) => pages(ddb, cmds, { TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk } });

/** When the post was first published, from its audit trail (`create` with visibility published, or a `visibility` change to it). */
function firstPublish(post, audits) {
  const times = audits
    .filter((a) => (a.op === "create" || a.op === "visibility") && a.after?.visibility === "published" && typeof a.at === "string")
    .map((a) => a.at)
    .sort();
  return times[0] ?? (post.visibility === "draft" ? undefined : post.created_at);
}

/** The totals of a set of events, as the CSTAT# rows that should exist (keyed `PK|SK`). Day rows past their ttl are left out. */
export function expectedCounters(events, nowMs) {
  const rows = new Map();
  const row = (key, extra = {}) => {
    const id = `${key.PK}|${key.SK}`;
    if (!rows.has(id)) rows.set(id, { ...key, n: 0, ...extra });
    return rows.get(id);
  };
  for (const e of events) {
    const d = deltasOf(e, 1);
    const add = (r, attrs) => {
      for (const a of attrs) r[a] = (r[a] ?? 0) + d[a];
    };
    const all = Object.keys(d);
    for (const total of [row(siteKeys("TOTAL")), row(personKeys(e.actor.id, "TOTAL"))]) {
      add(total, all);
      if (total.first_at === undefined || e.at < total.first_at) total.first_at = e.at;
    }
    add(row(siteKeys(`M#${monthOf(e.at)}`)), ["n"]);
    add(row(personKeys(e.actor.id, `M#${monthOf(e.at)}`)), ["n"]);
    const ttl = dayRowTtl(e.at);
    if (ttl * 1000 > nowMs) add(row(siteKeys(`D#${dayOf(e.at)}`), { ttl }), ["n"]);
  }
  return rows;
}

// A counter row as it compares: `n` (absent is 0), the non-zero `n_<kind>` attributes (a revoke leaves a 0 behind that means the same as
// absent), `first_at` and `ttl`.
const counts = (r) => {
  const out = { n: r?.n ?? 0 };
  for (const k of Object.keys(r ?? {}).sort()) if ((k.startsWith("n_") && r[k] !== 0) || k === "first_at" || k === "ttl") out[k] = r[k];
  return out;
};
// `first_at` is the first credit ever: after a revoke of the earliest event the live row keeps the earlier time, which is not drift.
const sameRow = (have, want) => {
  const { first_at: haveFirst, ...h } = counts(have);
  const { first_at: wantFirst, ...w } = counts(want);
  return JSON.stringify(h) === JSON.stringify(w) && (wantFirst === undefined ? true : haveFirst !== undefined && haveFirst <= wantFirst);
};

/**
 * Reads the table and returns the plan: the events to create (with the stored items to link), and the counter rows to set. Writes nothing.
 *   events:     [{ event, links: [{ PK, SK, path }] }]   (path is the attribute holding the item: "post" or "comment")
 *   counters:   [{ row, have }]                         (row is the full item to Put)
 *   skipped:    { draftPosts, linked, orphanLinks }
 */
export async function planBackfill({ ddb, cmds, table, now = () => Date.now() }) {
  const existing = new Map((await byGsi(ddb, cmds, table, GSI_CONTRIBS)).map((e) => [`${e.PK}|${e.SK}`, e]));
  const events = [];
  const skipped = { draftPosts: 0, linked: 0, orphanLinks: 0 };
  const plan = (event, links) => {
    const key = `${event.PK}|${event.SK}`;
    if (existing.has(key) || events.some((p) => p.event.PK === event.PK && p.event.SK === event.SK)) return;
    events.push({ event, links });
  };

  for (const item of await byGsi(ddb, cmds, table, "POSTS")) {
    const post = item.post;
    if (!post?.id || !post.author?.id) continue;
    if (post.contrib?.id) {
      skipped.linked += 1;
      if (!existing.has(`CONTRIB#${post.author.id}|E#${post.contrib.id}`)) {
        // Linked but the event is gone (never revoked while the post exists): recreate it under the same id.
        skipped.orphanLinks += 1;
        const at = firstPublish(post, await byPk(ddb, cmds, table, `AUDIT#${post.id}`)) ?? post.created_at;
        plan(postEvent(post, at, post.contrib.id), postLinks(post));
      }
      continue;
    }
    const at = firstPublish(post, await byPk(ddb, cmds, table, `AUDIT#${post.id}`));
    if (!at) {
      skipped.draftPosts += 1; // never published: nothing to credit yet
      continue;
    }
    plan(postEvent(post, at), postLinks(post));
  }

  for (const item of await byGsi(ddb, cmds, table, "COMMENTS")) {
    const c = item.comment;
    if (!c?.id || !c.author?.id || !c.threadId) continue;
    if (c.contrib?.id) {
      skipped.linked += 1;
      continue;
    }
    const ref = { type: "comment", id: c.id, thread: c.threadId };
    const event = buildEvent({
      actor: c.author, kind: "comment", ref, subject: c.threadId, photos: Math.min(Array.isArray(c.attachments) ? c.attachments.length : 0, 10),
      at: c.created_at, via: "ui", id: eventIdFor(c.created_at, "comment", ref),
    });
    plan(event, [{ PK: item.PK, SK: item.SK, path: "comment" }]);
  }

  const all = [...existing.values(), ...events.map((p) => p.event)];
  const want = expectedCounters(all, now());
  const have = new Map();
  for (const r of await byPk(ddb, cmds, table, "CSTAT#site")) if (r.SK !== "LINE") have.set(`${r.PK}|${r.SK}`, r);
  const principals = new Set(all.map((e) => e.actor.id));
  let scanKey;
  for (let i = 0; i < 500; i += 1) {
    const scan = await ddb.send(new cmds.ScanCommand({
      TableName: table, FilterExpression: "begins_with(PK, :p)", ExpressionAttributeValues: { ":p": "CSTAT#person:" }, ProjectionExpression: "PK",
      ...(scanKey ? { ExclusiveStartKey: scanKey } : {}),
    }));
    for (const it of scan.Items ?? []) principals.add(String(it.PK).slice("CSTAT#person:".length));
    scanKey = scan.LastEvaluatedKey;
    if (!scanKey) break;
  }
  for (const p of principals) for (const r of await byPk(ddb, cmds, table, `CSTAT#person:${p}`)) have.set(`${r.PK}|${r.SK}`, r);

  const counters = [];
  for (const [id, row] of want) if (!sameRow(have.get(id), row)) counters.push({ row, have: have.get(id) });
  for (const [id, row] of have) {
    // A stored row nothing supports any more (every contribution gone, or a day past its ttl): set it to zero once.
    if (!want.has(id) && (row.n ?? 0) !== 0) counters.push({ row: { PK: row.PK, SK: row.SK, n: 0 }, have: row });
  }
  counters.sort((a, b) => (`${a.row.PK}|${a.row.SK}` < `${b.row.PK}|${b.row.SK}` ? -1 : 1));
  events.sort((a, b) => (a.event.id < b.event.id ? -1 : 1));
  return { events, counters, skipped, existingEvents: existing.size };

  function postEvent(post, at, id) {
    const ref = { type: "post", id: post.id };
    return buildEvent({
      actor: post.author, kind: "post", ref, ...(post.subject ? { subject: post.subject } : {}),
      photos: Math.min((post.attachments ?? []).filter((a) => a.kind === "image").length, 10), at, via: "ui",
      hidden: post.visibility !== "published", id: id ?? eventIdFor(at, "post", ref),
    });
  }
  function postLinks(post) {
    return [
      { PK: `POST#${post.id}`, SK: "META", path: "post" },
      { PK: `POST#${post.id}`, SK: "IDX#AUTHOR", path: "post" },
      ...(post.subject ? [{ PK: `POST#${post.id}`, SK: "IDX#SUBJECT", path: "post" }] : []),
    ];
  }
}

/** Writes a plan: one transaction per event (the event and the link on each stored copy), then the counter rows. Returns counts. */
export async function applyPlan({ ddb, cmds, table }, plan) {
  for (const { event, links } of plan.events) {
    await transact(ddb, cmds, table, {
      puts: [{ item: event, condition: "attribute_not_exists(PK)" }],
      updates: links.map((l) => ({
        key: { PK: l.PK, SK: l.SK }, update: "SET #doc.#contrib = :contrib", condition: "attribute_exists(PK)",
        names: { "#doc": l.path, "#contrib": "contrib" }, values: { ":contrib": { id: event.id } },
      })),
    });
  }
  for (let i = 0; i < plan.counters.length; i += 100) {
    await transact(ddb, cmds, table, { puts: plan.counters.slice(i, i + 100).map(({ row }) => ({ item: row })) });
  }
  return { events: plan.events.length, counters: plan.counters.length };
}

export function describePlan(plan) {
  const lines = [];
  for (const { event: e } of plan.events) {
    lines.push(`event  ${e.kind.padEnd(8)} ${e.id}  credit ${e.actor.id}  at ${e.at}  weight ${e.weight} (photos ${e.photos})${e.hidden ? "  hidden" : ""}  ref ${e.ref.type}:${e.ref.id}`);
  }
  for (const { row, have } of plan.counters) {
    const show = (r) => Object.entries(counts(r)).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(`count  ${row.PK} ${row.SK}  ${have ? `${show(have)} -> ` : "(new) -> "}${show(row)}`);
  }
  const kinds = {};
  for (const { event: e } of plan.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  lines.push(
    `plan: ${plan.events.length} event(s) to create (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}), ${plan.counters.length} counter row(s) to set; ` +
      `${plan.existingEvents} event(s) already in the ledger, ${plan.skipped.linked} item(s) already linked, ${plan.skipped.draftPosts} draft post(s) not credited` +
      (plan.skipped.orphanLinks ? `, ${plan.skipped.orphanLinks} linked item(s) whose event is missing (recreated)` : ""),
  );
  return lines;
}

/** The whole run: plan, print, and (apply) write. Exported so tests drive it against the fake store. */
export async function run({ ddb, cmds, table, apply, log = console.log, now }) {
  const plan = await planBackfill({ ddb, cmds, table, ...(now ? { now } : {}) });
  for (const line of describePlan(plan)) log(line);
  if (!apply) {
    log("dry run: nothing written");
    return { plan, written: { events: 0, counters: 0 } };
  }
  const written = await applyPlan({ ddb, cmds, table }, plan);
  log(`applied: ${written.events} event(s), ${written.counters} counter row(s)`);
  return { plan, written };
}

function parseArgs(argv) {
  const out = { apply: undefined, table: process.env.TABLE_NAME ?? "hfy-app", region: process.env.AWS_REGION ?? "us-west-2" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.apply = out.apply === true ? "both" : false;
    else if (a === "--apply") out.apply = out.apply === false ? "both" : true;
    else if (a === "--table") out.table = argv[(i += 1)];
    else if (a === "--region") out.region = argv[(i += 1)];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.apply === undefined || out.apply === "both") throw new Error("pass exactly one of --dry-run or --apply");
  if (!out.table || !out.region) throw new Error("--table and --region need a value");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const [{ DynamoDBClient }, lib] = await Promise.all([import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb")]);
    const ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), { marshallOptions: { removeUndefinedValues: true } });
    const cmds = { GetCommand: lib.GetCommand, QueryCommand: lib.QueryCommand, ScanCommand: lib.ScanCommand, TransactWriteCommand: lib.TransactWriteCommand };
    await run({ ddb, cmds, table: args.table, apply: args.apply });
  } catch (e) {
    console.error(`contrib-backfill: ${e.message}`);
    process.exitCode = 1;
  }
}
