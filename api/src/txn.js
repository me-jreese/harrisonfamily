// DynamoDB helpers. `cmds` is the lib-dynamodb command-class bag (injected so tests never touch the network).
import { auditKeys, gsiAudit } from "./keys.js";

/** Builds the D-15 AUDIT# item {op, id, principal, at, before, after}. */
export function auditItem(entry, uid, table) {
  const sk = `${entry.at}#${uid}`;
  return {
    ...auditKeys(entry.id ?? entry.commentId, sk),
    GSI1PK: gsiAudit,
    GSI1SK: sk,
    entity: "audit",
    op: entry.op,
    id: entry.id ?? entry.commentId,
    principal: entry.principalId,
    at: entry.at,
    before: entry.before,
    after: entry.after,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

const conditionOf = (c) => ({
  ...(c.condition ? { ConditionExpression: c.condition } : {}),
  ...(c.names ? { ExpressionAttributeNames: c.names } : {}),
  ...(c.values ? { ExpressionAttributeValues: c.values } : {}),
});

/**
 * Atomic write: puts and deletes in one TransactWriteItems call (audit item rides in the same call).
 * puts: `{ item, condition?, names?, values? }`; deletes: a bare key `{PK, SK}` or `{ key, condition?, names?, values? }`.
 */
export async function transact(ddb, cmds, table, { puts = [], deletes = [] }) {
  const TransactItems = [
    ...puts.map((p) => ({ Put: { TableName: table, Item: p.item, ...conditionOf(p) } })),
    ...deletes.map((d) => (d.key ? { Delete: { TableName: table, Key: d.key, ...conditionOf(d) } } : { Delete: { TableName: table, Key: d } })),
  ];
  await ddb.send(new cmds.TransactWriteCommand({ TransactItems }));
}

/**
 * Optimistic-concurrency guard on a stored record's version field (`<doc>.<field>` inside the item).
 * `prev` undefined => the field must still be absent (e.g. a never-edited comment). Combined with attribute_exists(PK).
 */
export function versionGuard(doc, field, prev) {
  const names = { "#doc": doc, "#ver": field };
  return prev === undefined
    ? { condition: "attribute_exists(PK) AND attribute_not_exists(#doc.#ver)", names }
    : { condition: "attribute_exists(PK) AND #doc.#ver = :prev", names, values: { ":prev": prev } };
}

/** Pages a Query newest-first (or oldest-first) until `want` rows pass `accept`, or the partition is exhausted. */
export async function queryPartition(ddb, cmds, table, { pk, after, forward = false, accept, want }) {
  const out = [];
  let lastKey;
  for (let i = 0; i < 50; i += 1) {
    const r = await ddb.send(
      new cmds.QueryCommand({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: after ? `GSI1PK = :pk AND GSI1SK ${forward ? ">" : "<"} :after` : "GSI1PK = :pk",
        ExpressionAttributeValues: after ? { ":pk": pk, ":after": after } : { ":pk": pk },
        ScanIndexForward: forward,
        Limit: 100,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      if (accept(item)) out.push(item);
      if (out.length >= want) return out;
    }
    lastKey = r.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return out;
}
