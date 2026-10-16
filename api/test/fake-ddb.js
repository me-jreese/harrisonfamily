// In-memory DynamoDB DocumentClient fake: Get/Put/Delete/Update/Query(main table + GSI1)/Scan/TransactWrite with the semantics the API
// relies on (condition checks, duplicate-target rejection, atomicity, CancellationReasons by item index, ClientRequestToken replay).
// Inject with the real lib-dynamodb command classes.
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

export const cmds = { GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand, BatchGetCommand };
const kk = (k) => `${k.PK}\u0000${k.SK}`;
const err = (name, message) => Object.assign(new Error(message), { name });
const fail = (m) => { throw new Error(`fake: ${m}`); };
// Cancellation codes failNext() can inject into a transaction (anything else is thrown as an error with that name).
const CANCEL_CODES = new Set(["TransactionConflict", "ConditionalCheckFailed", "ThrottlingError", "ProvisionedThroughputExceeded", "ItemCollectionSizeLimitExceeded", "ValidationError"]);
// DynamoDB limits the fake enforces: an item is at most 400 KB and a transaction at most 4 MB (JSON text size stands in for DynamoDB's
// attribute-name-plus-value size, which is within a few percent of it for the plain items this API stores).
export const MAX_ITEM_BYTES = 400 * 1024;
export const MAX_TXN_BYTES = 4 * 1024 * 1024;
const itemBytes = (item) => Buffer.byteLength(JSON.stringify(item));
const cancelled = (codes) =>
  Object.assign(err("TransactionCanceledException", `Transaction cancelled, please refer cancellation reasons for specific reasons [${codes.join(", ")}]`), {
    CancellationReasons: codes.map((c) => ({ Code: c, ...(c === "None" ? {} : { Message: "fake" }) })),
  });

export function createFakeDdb() {
  const rows = new Map();
  const calls = [];
  const tokens = []; // ClientRequestToken of every TransactWrite attempt, in order
  const injected = []; // failNext() queue
  const batchGets = []; // the number of keys in every BatchGet, in order (DynamoDB allows 100; the API sends at most 20)
  const unprocessed = []; // leaveUnprocessed() queue: how many keys of the next BatchGet to hand back unprocessed
  const applied = new Map(); // ClientRequestToken -> serialized TransactItems of a committed transaction (idempotent replay)

  // Condition subset the API uses: clauses joined by AND (alternatives joined by OR), each attribute_exists(path), attribute_not_exists(path) or
  // `path <op> :value` (= <> < <= > >=), where path is dotted plain names or #placeholders (ExpressionAttributeNames).
  const resolve = (item, path, names = {}) =>
    path.split(".").reduce((o, part) => (o == null ? undefined : o[part.startsWith("#") ? names[part] ?? fail(`unknown name ${part}`) : part]), item);
  const compare = (op, a, b) => {
    if (op === "=") return JSON.stringify(a) === JSON.stringify(b);
    if (op === "<>") return JSON.stringify(a) !== JSON.stringify(b);
    if (a === undefined || a === null || typeof a !== typeof b) return false;
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  };
  const cond = (expr, existing, names, values = {}) => {
    if (!expr) return true;
    // OR binds looser than AND (DynamoDB precedence); parentheses are not modelled.
    return expr.split(/\s+OR\s+/).some((alt) => alt.split(/\s+AND\s+/).every((clause) => {
      let m;
      if ((m = /^attribute_exists\(([#\w.]+)\)$/.exec(clause))) return resolve(existing, m[1], names) !== undefined;
      if ((m = /^attribute_not_exists\(([#\w.]+)\)$/.exec(clause))) return resolve(existing, m[1], names) === undefined;
      if ((m = /^([#\w.]+) (=|<>|<=|>=|<|>) (:\w+)$/.exec(clause))) {
        if (!(m[3] in values)) fail(`unknown value ${m[3]}`);
        const v = resolve(existing, m[1], names);
        return m[2] === "<>" ? v === undefined || compare(m[2], v, values[m[3]]) : v !== undefined && compare(m[2], v, values[m[3]]);
      }
      return fail(`unsupported condition ${expr}`);
    }));
  };
  const condOf = (op, existing) => cond(op.ConditionExpression, existing, op.ExpressionAttributeNames, op.ExpressionAttributeValues);

  // UpdateExpression subset: SET a = <operand> [+|- <operand>], ...  /  ADD a :n, ...  /  REMOVE a, ...  (any order, once each).
  // operand: :value | path | if_not_exists(path, operand). ADD adds to a number (absent => 0). A nested path needs its parent to exist.
  const splitTop = (s) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const parentOf = (item, path, names) => {
    const parts = path.split(".").map((p) => (p.startsWith("#") ? names[p] ?? fail(`unknown name ${p}`) : p));
    const last = parts.pop();
    const parent = parts.reduce((o, p) => (o == null ? undefined : o[p]), item);
    if (parent === undefined || parent === null || typeof parent !== "object") throw err("ValidationException", "The document path provided in the update expression is invalid for update");
    return [parent, last];
  };
  function applyUpdate(item, expr, names = {}, values = {}) {
    const val = (t) => { if (!(t in values)) fail(`unknown value ${t}`); return values[t]; };
    const operand = (t) => {
      let m;
      if ((m = /^if_not_exists\(\s*([#\w.]+)\s*,\s*(.+)\)$/.exec(t))) { const cur = resolve(item, m[1], names); return cur !== undefined ? cur : operand(m[2].trim()); }
      if (t.startsWith(":")) return val(t);
      return resolve(item, t, names);
    };
    const clauses = [...expr.matchAll(/\b(SET|ADD|REMOVE|DELETE)\b\s+([\s\S]*?)(?=\s+\b(?:SET|ADD|REMOVE|DELETE)\b\s|$)/g)];
    if (!clauses.length || clauses.map((c) => c[0]).join(" ").replace(/\s+/g, "") !== expr.replace(/\s+/g, "")) fail(`unsupported update expression ${expr}`);
    const seen = new Set();
    for (const [, kind, body] of clauses) {
      if (seen.has(kind)) throw err("ValidationException", `Invalid UpdateExpression: The "${kind}" section can only be used once`);
      seen.add(kind);
      if (kind === "DELETE") fail("DELETE (set) clauses are not supported");
      for (const part of splitTop(body)) {
        if (kind === "SET") {
          const [lhs, rhs] = part.split(/\s=\s/).map((x) => x.trim());
          if (!rhs) fail(`bad SET ${part}`);
          // split `a + b` / `a - b` outside parentheses
          const m = /^(if_not_exists\([^)]*\)|[:#\w.]+)(?:\s*([+-])\s*(if_not_exists\([^)]*\)|[:#\w.]+))?$/.exec(rhs);
          if (!m) fail(`bad SET value ${rhs}`);
          let v = operand(m[1]);
          if (m[2]) v = m[2] === "+" ? v + operand(m[3]) : v - operand(m[3]);
          const [parent, last] = parentOf(item, lhs, names);
          parent[last] = structuredClone(v);
        } else if (kind === "ADD") {
          const [path, valueRef] = part.split(/\s+/);
          const [parent, last] = parentOf(item, path, names);
          const d = val(valueRef);
          if (typeof d !== "number") fail("ADD supports numbers only");
          if (parent[last] !== undefined && typeof parent[last] !== "number") throw err("ValidationException", "An operand in the update expression has an incorrect data type");
          parent[last] = (parent[last] ?? 0) + d;
        } else {
          const [parent, last] = parentOf(item, part, names);
          delete parent[last];
        }
      }
    }
  }
  const keyOfOp = (t) => (t.Put ? t.Put.Item : (t.Delete ?? t.Update ?? t.ConditionCheck).Key);
  const updated = (op) => {
    const next = structuredClone(rows.get(kk(op.Key)) ?? { PK: op.Key.PK, SK: op.Key.SK });
    applyUpdate(next, op.UpdateExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
    return next;
  };

  const sortKeyMatch = (m, v, sk) => {
    if (!m) return true;
    if (m.begins) return sk.startsWith(v[":sk"]);
    if (m.between) return sk >= v[":lo"] && sk <= v[":hi"];
    const b = v[":sk"];
    return m.op === "<" ? sk < b : m.op === "<=" ? sk <= b : m.op === ">" ? sk > b : sk >= b;
  };
  function query(i) {
    const v = i.ExpressionAttributeValues ?? {};
    let items;
    if (i.IndexName === "GSI1") {
      const m = /^GSI1PK = :pk(?: AND GSI1SK (<=|>=|<|>) :after)?$/.exec(i.KeyConditionExpression);
      if (!m) throw new Error(`fake: unsupported key condition ${i.KeyConditionExpression}`);
      items = [...rows.values()].filter((r) => r.GSI1PK === v[":pk"] && (!m[1] || compare(m[1], r.GSI1SK, v[":after"])));
      items.sort((a, b) => (a.GSI1SK < b.GSI1SK ? -1 : a.GSI1SK > b.GSI1SK ? 1 : a.PK < b.PK ? -1 : 1));
    } else {
      const m = /^PK = :pk(?: AND (?:(begins)_with\(SK, :sk\)|SK (BETWEEN) :lo AND :hi|SK (<=|>=|<|>) :sk))?$/.exec(i.KeyConditionExpression);
      if (!m) throw new Error(`fake: unsupported key condition ${i.KeyConditionExpression}`);
      const sk = m[1] ? { begins: true } : m[2] ? { between: true } : m[3] ? { op: m[3] } : undefined;
      items = [...rows.values()].filter((r) => r.PK === v[":pk"] && sortKeyMatch(sk, v, r.SK));
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
    const lek = more ? { LastEvaluatedKey: { PK: page.at(-1).PK, SK: page.at(-1).SK } } : {};
    // Select COUNT returns the number of items in the page, never the items.
    if (i.Select === "COUNT") return { Count: page.length, ScannedCount: page.length, ...lek };
    return { Items: structuredClone(page), Count: page.length, ...lek };
  }

  function transactWrite(i) {
    const items = i.TransactItems ?? [];
    tokens.push(i.ClientRequestToken);
    if (items.length === 0 || items.length > 100) throw err("ValidationException", "Member must have length less than or equal to 100");
    const payload = JSON.stringify(items);
    if (items.some((t) => t.Put && itemBytes(t.Put.Item) > MAX_ITEM_BYTES)) throw err("ValidationException", "Item size has exceeded the maximum allowed size");
    if (Buffer.byteLength(payload) > MAX_TXN_BYTES) throw err("ValidationException", "Member must have length less than or equal to 4 MB: transaction size has exceeded the maximum allowed size");
    if (i.ClientRequestToken !== undefined && applied.has(i.ClientRequestToken)) {
      if (applied.get(i.ClientRequestToken) !== payload) throw err("IdempotentParameterMismatchException", "token reused with different parameters");
      return {}; // replay of a committed transaction: nothing is applied twice
    }
    const seen = new Set();
    for (const t of items) {
      if (t.ConditionCheck && !t.ConditionCheck.ConditionExpression) throw err("ValidationException", "ConditionCheck requires a ConditionExpression");
      const key = kk(keyOfOp(t));
      if (seen.has(key)) throw err("ValidationException", "Transaction request cannot include multiple operations on one item");
      seen.add(key);
    }
    const inj = injected.shift();
    if (inj) {
      if (!CANCEL_CODES.has(inj.code)) throw err(inj.code, "injected failure");
      throw cancelled(items.map((_, n) => (inj.index === undefined || inj.index === n ? inj.code : "None")));
    }
    const codes = items.map((t) => {
      const op = t.Put ?? t.Delete ?? t.Update ?? t.ConditionCheck;
      return condOf(op, rows.get(kk(keyOfOp(t)))) ? "None" : "ConditionalCheckFailed";
    });
    if (codes.some((c) => c !== "None")) throw cancelled(codes);
    for (const t of items) {
      if (t.Put) rows.set(kk(t.Put.Item), structuredClone(t.Put.Item));
      else if (t.Delete) rows.delete(kk(t.Delete.Key));
      else if (t.Update) rows.set(kk(t.Update.Key), updated(t.Update));
    }
    if (i.ClientRequestToken !== undefined) applied.set(i.ClientRequestToken, payload);
    return {};
  }

  return {
    rows,
    calls,
    tokens,
    batchGets,
    /** The next `n` BatchGets leave their last `count` keys unprocessed (every key by default), as DynamoDB does under throttling. */
    leaveUnprocessed(n = 1, count = Infinity) {
      for (let k = 0; k < n; k += 1) unprocessed.push(count);
    },
    /**
     * The next `n` TransactWrite calls are cancelled with `code` on every item (or only on item `index`, the others "None") when
     * `code` is a cancellation code (TransactionConflict, ConditionalCheckFailed, ThrottlingError, ...); any other `code` is thrown
     * as an error with that name. Nothing is written by a failed call.
     */
    failNext(code, n = 1, { index } = {}) {
      for (let k = 0; k < n; k += 1) injected.push({ code, index });
    },
    all: () => [...rows.values()].map((r) => structuredClone(r)),
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      calls.push(name);
      switch (name) {
        case "GetCommand":
          return { Item: rows.has(kk(i.Key)) ? structuredClone(rows.get(kk(i.Key))) : undefined };
        case "PutCommand":
          if (itemBytes(i.Item) > MAX_ITEM_BYTES) throw err("ValidationException", "Item size has exceeded the maximum allowed size");
          if (!condOf(i, rows.get(kk(i.Item)))) throw err("ConditionalCheckFailedException", "condition failed");
          rows.set(kk(i.Item), structuredClone(i.Item));
          return {};
        case "DeleteCommand":
          if (!condOf(i, rows.get(kk(i.Key)))) throw err("ConditionalCheckFailedException", "condition failed");
          rows.delete(kk(i.Key));
          return {};
        case "UpdateCommand": {
          if (!condOf(i, rows.get(kk(i.Key)))) throw err("ConditionalCheckFailedException", "condition failed");
          const next = updated(i);
          rows.set(kk(i.Key), next);
          return i.ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(next) } : {};
        }
        case "QueryCommand":
          return query(i);
        case "ScanCommand": {
          const allow = i.ExpressionAttributeValues?.[":allow"]; // the chat directory's ALLOW# scan: whole items (the real call projects PK and sub)
          if (allow !== undefined) return { Items: [...rows.values()].filter((r) => r.PK.startsWith(allow)).map((r) => structuredClone(r)) };
          const p = i.ExpressionAttributeValues?.[":p"];
          const items = [...rows.values()].filter((r) => (p === undefined ? true : r.PK.startsWith(p)));
          return { Items: items.map((r) => ({ PK: r.PK })) };
        }
        case "BatchGetCommand": {
          const [[tbl, spec], ...extra] = Object.entries(i.RequestItems ?? {});
          if (extra.length > 0 || !spec) fail("BatchGet over one table only");
          const keys = spec.Keys ?? [];
          batchGets.push(keys.length);
          if (keys.length === 0 || keys.length > 100) throw err("ValidationException", "Member must have length between 1 and 100");
          if (new Set(keys.map(kk)).size !== keys.length) throw err("ValidationException", "Provided list of item keys contains duplicates");
          const drop = Math.min(unprocessed.shift() ?? 0, keys.length);
          const done = keys.slice(0, keys.length - drop);
          return {
            Responses: { [tbl]: done.filter((k) => rows.has(kk(k))).map((k) => structuredClone(rows.get(kk(k)))) },
            UnprocessedKeys: drop > 0 ? { [tbl]: { Keys: keys.slice(keys.length - drop) } } : {},
          };
        }
        case "TransactWriteCommand":
          return transactWrite(i);
        default:
          throw new Error(`fake: unsupported command ${name}`);
      }
    },
  };
}
