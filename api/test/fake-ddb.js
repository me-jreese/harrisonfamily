// In-memory DynamoDB DocumentClient fake: Get/Put/Delete/Query(GSI1)/Scan/TransactWrite with the semantics the API relies on
// (condition checks, duplicate-target rejection, atomicity). Inject with the real lib-dynamodb command classes.
import { GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export const cmds = { GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, TransactWriteCommand };
const kk = (k) => `${k.PK}\u0000${k.SK}`;
const err = (name, message) => Object.assign(new Error(message), { name });

export function createFakeDdb() {
  const rows = new Map();
  const calls = [];
  const cond = (expr, existing) => {
    if (!expr) return true;
    if (expr === "attribute_not_exists(PK)") return !existing;
    if (expr === "attribute_exists(PK)") return !!existing;
    throw new Error(`fake: unsupported condition ${expr}`);
  };
  function query(i) {
    const v = i.ExpressionAttributeValues ?? {};
    let items;
    if (i.IndexName === "GSI1") {
      const m = /^GSI1PK = :pk(?: AND GSI1SK ([<>]) :after)?$/.exec(i.KeyConditionExpression);
      if (!m) throw new Error(`fake: unsupported key condition ${i.KeyConditionExpression}`);
      items = [...rows.values()].filter((r) => r.GSI1PK === v[":pk"] && (!m[1] || (m[1] === "<" ? r.GSI1SK < v[":after"] : r.GSI1SK > v[":after"])));
      items.sort((a, b) => (a.GSI1SK < b.GSI1SK ? -1 : a.GSI1SK > b.GSI1SK ? 1 : a.PK < b.PK ? -1 : 1));
    } else {
      const m = /^PK = :pk(?: AND (?:begins_with\(SK, :sk\)|SK BETWEEN :lo AND :hi))?$/.exec(i.KeyConditionExpression);
      if (!m) throw new Error(`fake: unsupported key condition ${i.KeyConditionExpression}`);
      items = [...rows.values()].filter((r) => r.PK === v[":pk"] && (v[":sk"] === undefined || r.SK.startsWith(v[":sk"])) && (v[":lo"] === undefined || (r.SK >= v[":lo"] && r.SK <= v[":hi"])));
      items.sort((a, b) => (a.SK < b.SK ? -1 : 1));
    }
    if (i.ScanIndexForward === false) items.reverse();
    if (i.ExclusiveStartKey) {
      const at = items.findIndex((r) => kk(r) === kk(i.ExclusiveStartKey));
      items = items.slice(at + 1);
    }
    const limit = i.Limit ?? Infinity;
    const page = items.slice(0, limit);
    const more = items.length > limit;
    return { Items: structuredClone(page), ...(more ? { LastEvaluatedKey: { PK: page.at(-1).PK, SK: page.at(-1).SK } } : {}) };
  }
  return {
    rows,
    calls,
    all: () => [...rows.values()].map((r) => structuredClone(r)),
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      calls.push(name);
      switch (name) {
        case "GetCommand":
          return { Item: rows.has(kk(i.Key)) ? structuredClone(rows.get(kk(i.Key))) : undefined };
        case "PutCommand":
          if (!cond(i.ConditionExpression, rows.get(kk(i.Item)))) throw err("ConditionalCheckFailedException", "condition failed");
          rows.set(kk(i.Item), structuredClone(i.Item));
          return {};
        case "DeleteCommand":
          rows.delete(kk(i.Key));
          return {};
        case "QueryCommand":
          return query(i);
        case "ScanCommand": {
          const p = i.ExpressionAttributeValues?.[":p"];
          const items = [...rows.values()].filter((r) => (p === undefined ? true : r.PK.startsWith(p)));
          return { Items: items.map((r) => ({ PK: r.PK })) };
        }
        case "TransactWriteCommand": {
          const seen = new Set();
          for (const t of i.TransactItems) {
            const key = t.Put ? kk(t.Put.Item) : kk(t.Delete.Key);
            if (seen.has(key)) throw err("ValidationException", "Transaction request cannot include multiple operations on one item");
            seen.add(key);
          }
          for (const t of i.TransactItems) if (t.Put && !cond(t.Put.ConditionExpression, rows.get(kk(t.Put.Item)))) throw err("TransactionCanceledException", "cancelled");
          for (const t of i.TransactItems) {
            if (t.Put) rows.set(kk(t.Put.Item), structuredClone(t.Put.Item));
            else rows.delete(kk(t.Delete.Key));
          }
          return {};
        }
        default:
          throw new Error(`fake: unsupported command ${name}`);
      }
    },
  };
}
