// Test helper (not a test file): the hfy-app key schema read from the CloudFormation template, and an in-memory table that enforces it,
// including DynamoDB's sparse-index rule (an item is in a GSI only if it carries every index key attribute). Used by the link and passkey
// store tests (HFY-R58 ruling 6, HFY-R67).
export const TEMPLATE = new URL("../../infrastructure/cloudformation/app-stack.yaml", import.meta.url);

/** Table + GSI key schema and attribute types of the hfy-app table, parsed from app-stack.yaml (flow-style entries). */
export function tableSchema(yaml) {
  const table = yaml.slice(yaml.indexOf("Type: AWS::DynamoDB::Table"));
  const types = Object.fromEntries([...table.matchAll(/\{\s*AttributeName:\s*(\w+),\s*AttributeType:\s*(\w+)\s*\}/g)].map((m) => [m[1], m[2]]));
  const keys = (block) => Object.fromEntries([...block.matchAll(/\{\s*AttributeName:\s*(\w+),\s*KeyType:\s*(HASH|RANGE)\s*\}/g)].map((m) => [m[2], m[1]]));
  const gsiBlock = table.slice(table.indexOf("GlobalSecondaryIndexes:"));
  const indexes = {};
  for (const m of gsiBlock.matchAll(/- IndexName:\s*(\w+)\s*\n([\s\S]*?)Projection:/g)) indexes[m[1]] = keys(m[2]);
  const base = keys(table.slice(table.indexOf("KeySchema:"), table.indexOf("GlobalSecondaryIndexes:")));
  return { types, base, indexes };
}

const typeOk = (v, t) => (t === "S" ? typeof v === "string" && v.length > 0 : t === "N" ? typeof v === "number" : t === "B" ? v instanceof Uint8Array : false);
const ddbError = (name, message) => Object.assign(new Error(message), { name });

/** The kit's `{get, put, query, update, delete}` client over an in-memory table that enforces the given key schema. */
export function fakeTable(schema) {
  const items = new Map();
  const keyOf = (k) => JSON.stringify([k[schema.base.HASH], k[schema.base.RANGE]]);
  const evalCond = (expr, existing) =>
    expr.split(/\s+AND\s+/).every((c) => {
      const m = /^attribute_(exists|not_exists)\((\w+)\)$/.exec(c.trim());
      if (!m) throw new Error(`fake table: unsupported condition ${c}`);
      const has = existing !== undefined && existing[m[2]] !== undefined;
      return m[1] === "exists" ? has : !has;
    });
  const validate = (Item) => {
    for (const k of [schema.base.HASH, schema.base.RANGE]) if (!typeOk(Item[k], schema.types[k])) throw ddbError("ValidationException", `missing key ${k}`);
    // DynamoDB rejects a GSI key attribute of the wrong type (or an empty string)
    for (const [name, t] of Object.entries(schema.types)) if (Item[name] !== undefined && !typeOk(Item[name], t)) throw ddbError("ValidationException", `bad type for ${name}`);
  };
  return {
    items,
    async get({ Key }) {
      const it = items.get(keyOf(Key));
      return it ? { Item: structuredClone(it) } : {};
    },
    async put({ Item, ConditionExpression }) {
      validate(Item);
      const k = keyOf(Item);
      if (ConditionExpression && !evalCond(ConditionExpression, items.get(k))) throw ddbError("ConditionalCheckFailedException", "conditional request failed");
      items.set(k, structuredClone(Item));
      return {};
    },
    /** `SET a = :x, b.#c = :y` only (what the kit and the stores use). */
    async update({ Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames = {}, ExpressionAttributeValues = {} }) {
      const k = keyOf(Key);
      const existing = items.get(k);
      if (ConditionExpression && !evalCond(ConditionExpression, existing)) throw ddbError("ConditionalCheckFailedException", "conditional request failed");
      const m = /^SET\s+(.+)$/.exec(UpdateExpression.trim());
      if (!m) throw new Error(`fake table: unsupported update ${UpdateExpression}`);
      const next = structuredClone(existing ?? Key);
      for (const clause of m[1].split(",")) {
        const [lhs, rhs] = clause.split("=").map((x) => x.trim());
        if (!(rhs in ExpressionAttributeValues)) throw new Error(`fake table: no value for ${rhs}`);
        const path = lhs.split(".").map((p) => (p.startsWith("#") ? ExpressionAttributeNames[p] : p));
        let o = next;
        for (const p of path.slice(0, -1)) {
          if (typeof o[p] !== "object" || o[p] === null) throw ddbError("ValidationException", "the document path provided in the update expression is invalid");
          o = o[p];
        }
        o[path.at(-1)] = structuredClone(ExpressionAttributeValues[rhs]);
      }
      validate(next);
      items.set(k, next);
      return {};
    },
    async delete({ Key, ReturnValues }) {
      const k = keyOf(Key);
      const old = items.get(k);
      items.delete(k);
      return ReturnValues === "ALL_OLD" && old ? { Attributes: structuredClone(old) } : {};
    },
    async query({ IndexName, KeyConditionExpression, ExpressionAttributeValues }) {
      const ks = schema.indexes[IndexName];
      if (!ks) throw ddbError("ValidationException", `no index ${IndexName}`);
      const m = /^(\w+) = (:\w+)$/.exec(KeyConditionExpression);
      if (!m || m[1] !== ks.HASH) throw ddbError("ValidationException", "key condition must name the index hash key");
      const indexed = [...items.values()].filter((it) => [ks.HASH, ks.RANGE].filter(Boolean).every((a) => typeOk(it[a], schema.types[a]))); // sparse index
      const hits = indexed.filter((it) => it[ks.HASH] === ExpressionAttributeValues[m[2]]).sort((a, b) => (ks.RANGE ? String(a[ks.RANGE]).localeCompare(String(b[ks.RANGE])) : 0));
      return { Items: structuredClone(hits) };
    },
  };
}
