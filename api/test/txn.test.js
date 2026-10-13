// HFY-TSK-235: transact() v2 (Update, ConditionCheck, ClientRequestToken, conflict retry), the cancellation mapper, the counter / merge /
// size helpers, the fake-ddb features they rely on, the 503 busy mapping and the log-safe errorResponse. Synthetic data only.
import { describe, it, expect } from "vitest";
import { createFakeDdb, cmds, makeApi, signToken } from "./world.js";
import { errorResponse, HttpError, logSafeError } from "../src/http.js";
import { TxnCancelled, assertTxnSize, counterUpdate, mapCancellationReasons, mergeUpdates, transact, MAX_TXN_ITEMS } from "../src/txn.js";

const T = "hfy-app";
const key = (n) => ({ PK: `CNT#${n}`, SK: "TOTAL" });
const noSleep = { sleep: async () => {} };
/** Spies the TransactWrite inputs that reach the store. */
function spied(ddb) {
  const inputs = [];
  return { inputs, send: (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") inputs.push(cmd.input); return ddb.send(cmd); } };
}

describe("transact(): item kinds and the command bag", () => {
  it("sends puts, deletes, updates and checks in one TransactWriteItems call with the given token", async () => {
    const ddb = createFakeDdb();
    await ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "A", SK: "1", n: 1 } }));
    await ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "B", SK: "1" } }));
    await ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "G", SK: "1", state: "pending" } }));
    const s = spied(ddb);
    const r = await transact(s, cmds, T, {
      puts: [{ item: { PK: "P", SK: "1" }, condition: "attribute_not_exists(PK)" }],
      deletes: [{ PK: "B", SK: "1" }],
      updates: [{ key: { PK: "A", SK: "1" }, update: "SET #s = :s ADD n :one", names: { "#s": "status" }, values: { ":s": "done", ":one": 1 } }],
      checks: [{ key: { PK: "G", SK: "1" }, condition: "#st = :p", names: { "#st": "state" }, values: { ":p": "pending" } }],
      clientRequestToken: "tok-0001",
    });
    expect(r).toEqual({ token: "tok-0001", attempts: 1 });
    expect(s.inputs).toHaveLength(1);
    expect(s.inputs[0].ClientRequestToken).toBe("tok-0001");
    expect(s.inputs[0].TransactItems.map((t) => Object.keys(t)[0])).toEqual(["Put", "Delete", "Update", "ConditionCheck"]);
    expect(s.inputs[0].TransactItems[3].ConditionCheck).toMatchObject({ TableName: T, Key: { PK: "G", SK: "1" }, ConditionExpression: "#st = :p" });
    const rows = Object.fromEntries(ddb.all().map((x) => [x.PK, x]));
    expect(rows.P).toBeDefined();
    expect(rows.B).toBeUndefined();
    expect(rows.A).toMatchObject({ status: "done", n: 2 });
    expect(rows.G.state).toBe("pending"); // a check writes nothing
  });

  it("keeps the old call shape: puts and deletes only, no empty expression maps, a fresh token per call", async () => {
    const ddb = createFakeDdb();
    const s = spied(ddb);
    await transact(s, cmds, T, { puts: [{ item: { PK: "A", SK: "1" } }], deletes: [{ key: { PK: "Z", SK: "1" } }, { PK: "Y", SK: "1" }] });
    await transact(s, cmds, T, { puts: [{ item: { PK: "A", SK: "2" } }] });
    expect(s.inputs[0].TransactItems[0]).toEqual({ Put: { TableName: T, Item: { PK: "A", SK: "1" } } });
    expect(s.inputs[0].TransactItems[2]).toEqual({ Delete: { TableName: T, Key: { PK: "Y", SK: "1" } } });
    expect(s.inputs[0].ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.inputs[1].ClientRequestToken).not.toBe(s.inputs[0].ClientRequestToken);
  });

  it("a failed check cancels the whole transaction: nothing is written", async () => {
    const ddb = createFakeDdb();
    await ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "G", SK: "1", state: "approved" } }));
    await expect(
      transact(ddb, cmds, T, {
        puts: [{ item: { PK: "P", SK: "1" } }],
        checks: [{ key: { PK: "G", SK: "1" }, condition: "#st = :p", names: { "#st": "state" }, values: { ":p": "pending" }, tag: "still-pending" }],
      }, noSleep),
    ).rejects.toMatchObject({ name: "TxnCancelled", kind: "condition", failedIndex: 1, reasons: ["None", "ConditionalCheckFailed"], failures: [{ index: 1, code: "ConditionalCheckFailed", tag: "still-pending" }] });
    expect(ddb.all().map((x) => x.PK)).toEqual(["G"]);
  });

  it("rejects a token longer than 36 characters before sending", async () => {
    const ddb = createFakeDdb();
    await expect(transact(ddb, cmds, T, { puts: [{ item: { PK: "A", SK: "1" } }], clientRequestToken: "x".repeat(37) })).rejects.toThrow(TypeError);
    expect(ddb.calls).toEqual([]);
  });

  it("the Lambda command bag carries UpdateCommand", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    expect(src).toMatch(/import \{[^}]*\bUpdateCommand\b[^}]*\} from "@aws-sdk\/lib-dynamodb"/);
    expect(src).toMatch(/const cmds = \{[^}]*\bUpdateCommand\b[^}]*\}/);
  });

  it("a replayed token whose first attempt committed applies once (the DynamoDB idempotency the retry relies on)", async () => {
    const ddb = createFakeDdb();
    const spec = { updates: [counterUpdate(key("a"), { n: 1 })], clientRequestToken: "same-token" };
    await transact(ddb, cmds, T, spec);
    await transact(ddb, cmds, T, spec);
    expect(ddb.all().find((x) => x.PK === "CNT#a").n).toBe(1);
  });
});

describe("transact(): TransactionConflict retry", () => {
  const spec = () => ({ updates: [counterUpdate(key("a"), { n: 1 })], puts: [{ item: { PK: "P", SK: "1" } }], clientRequestToken: "retry-token" });

  it("retries a conflict-only cancellation with the SAME token and succeeds", async () => {
    const ddb = createFakeDdb();
    ddb.failNext("TransactionConflict", 2);
    const waits = [];
    const r = await transact(ddb, cmds, T, spec(), { sleep: async (ms) => waits.push(ms), random: () => 1 });
    expect(r.attempts).toBe(3);
    expect(ddb.tokens).toEqual(["retry-token", "retry-token", "retry-token"]);
    expect(waits).toEqual([20, 60]); // jittered backoff 20, 60, 150 ms (random()=1 gives the full value)
    expect(ddb.all().find((x) => x.PK === "CNT#a").n).toBe(1);
  });

  it("retries at most 3 times (4 attempts), then throws a busy TxnCancelled", async () => {
    const ddb = createFakeDdb();
    ddb.failNext("TransactionConflict", 10);
    const waits = [];
    const e = await transact(ddb, cmds, T, spec(), { sleep: async (ms) => waits.push(ms), random: () => 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(TxnCancelled);
    expect(e).toMatchObject({ busy: true, conditionFailed: false, kind: "conflict", attempts: 4, code: "busy" });
    expect(ddb.tokens).toHaveLength(4);
    expect(new Set(ddb.tokens)).toEqual(new Set(["retry-token"]));
    expect(waits).toEqual([20, 60, 150]);
    expect(ddb.all()).toEqual([]);
  });

  it("jitters each wait between half and the full backoff", async () => {
    const ddb = createFakeDdb();
    ddb.failNext("TransactionConflict", 3);
    const waits = [];
    await transact(ddb, cmds, T, spec(), { sleep: async (ms) => waits.push(ms), random: () => 0 });
    expect(waits).toEqual([10, 30, 75]);
  });

  it("generates one token per logical transaction and reuses it on every retry", async () => {
    const ddb = createFakeDdb();
    ddb.failNext("TransactionConflict", 2);
    const { clientRequestToken, ...rest } = spec();
    const r = await transact(ddb, cmds, T, rest, noSleep);
    expect(new Set(ddb.tokens).size).toBe(1);
    expect(ddb.tokens[0]).toBe(r.token);
  });

  it("never retries ConditionalCheckFailed", async () => {
    const ddb = createFakeDdb();
    const waits = [];
    const e = await transact(ddb, cmds, T, { checks: [{ key: { PK: "nope", SK: "1" }, condition: "attribute_exists(PK)" }] }, { sleep: async (ms) => waits.push(ms) }).catch((x) => x);
    expect(e).toMatchObject({ kind: "condition", conditionFailed: true, busy: false, code: "conflict", attempts: 1 });
    expect(ddb.tokens).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a mix of TransactionConflict and ConditionalCheckFailed", async () => {
    const ddb = createFakeDdb();
    let n = 0;
    const mixed = { send: async () => { n += 1; throw Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "ConditionalCheckFailed" }] }); } };
    const e = await transact(mixed, cmds, T, { puts: [{ item: { PK: "A", SK: "1" } }, { item: { PK: "B", SK: "1" } }] }, noSleep).catch((x) => x);
    expect(n).toBe(1);
    expect(e).toMatchObject({ kind: "condition", conditionFailed: true, reasons: ["TransactionConflict", "ConditionalCheckFailed"], failedIndex: 0 });
  });

  it("does not retry throttling or other cancellation codes, and passes other errors through untouched", async () => {
    const ddb = createFakeDdb();
    ddb.failNext("ThrottlingError", 1);
    const e = await transact(ddb, cmds, T, spec(), noSleep).catch((x) => x);
    expect(e).toMatchObject({ kind: "other", busy: false, conditionFailed: false, attempts: 1, code: "unavailable" });
    const boom = Object.assign(new Error("net"), { name: "TimeoutError" });
    await expect(transact({ send: async () => { throw boom; } }, cmds, T, spec(), noSleep)).rejects.toBe(boom);
  });
});

describe("mapCancellationReasons: failure codes by item index", () => {
  it("maps each reason to its item index, in the order puts, deletes, updates, checks", () => {
    const err = { CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed", Message: "m" }, { Code: "None" }, { Code: "TransactionConflict" }] };
    expect(mapCancellationReasons(err, ["put-a", "del-b", "upd-c", "chk-d"])).toEqual({
      codes: ["None", "ConditionalCheckFailed", "None", "TransactionConflict"],
      failures: [{ index: 1, code: "ConditionalCheckFailed", tag: "del-b" }, { index: 3, code: "TransactionConflict", tag: "chk-d" }],
      failedIndex: 1,
      kind: "condition",
    });
  });

  it("classifies the kind: all-conflict is retryable, throttling is other, no reasons is a condition failure (legacy 409)", () => {
    expect(mapCancellationReasons({ CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "TransactionConflict" }] }).kind).toBe("conflict");
    expect(mapCancellationReasons({ CancellationReasons: [{ Code: "ThrottlingError" }] }).kind).toBe("other");
    expect(mapCancellationReasons({ CancellationReasons: [{ Code: "None" }] })).toMatchObject({ kind: "other", failedIndex: -1, failures: [] });
    expect(mapCancellationReasons({})).toMatchObject({ kind: "condition", codes: [] });
  });

  it("copies codes only: Message and the ALL_OLD Item never leave the reason", () => {
    const m = mapCancellationReasons({ CancellationReasons: [{ Code: "ConditionalCheckFailed", Message: "msg-secret", Item: { note: { S: "item-secret" } } }] });
    expect(JSON.stringify(m)).not.toMatch(/secret/);
  });

  it("ignores a malformed code instead of passing it on", () => {
    expect(mapCancellationReasons({ CancellationReasons: [{ Code: "bad code with spaces" }, { Code: 7 }, null] }).codes).toEqual(["None", "None", "None"]);
  });

  it("transact() fills tags from the item that carried them, by index", async () => {
    const ddb = createFakeDdb();
    await ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "X", SK: "1" } }));
    const e = await transact(ddb, cmds, T, {
      puts: [{ item: { PK: "X", SK: "1" }, condition: "attribute_not_exists(PK)", tag: "create-x" }, { item: { PK: "Y", SK: "1" }, tag: "create-y" }],
      updates: [{ key: { PK: "W", SK: "1" }, update: "SET a = :a", values: { ":a": 1 }, condition: "attribute_exists(PK)", tag: "bump-w" }],
    }, noSleep).catch((x) => x);
    expect(e.failures).toEqual([{ index: 0, code: "ConditionalCheckFailed", tag: "create-x" }, { index: 2, code: "ConditionalCheckFailed", tag: "bump-w" }]);
  });
});

describe("counterUpdate, mergeUpdates and assertTxnSize", () => {
  it("counterUpdate builds ADD with a first-writer-wins ttl", () => {
    const u = counterUpdate(key("a"), { n: 1, unread: -2 }, { ttl: 1234 });
    expect(u.key).toEqual(key("a"));
    expect(u.update).toBe("SET #ttl = if_not_exists(#ttl, :ttl) ADD #cnt0 :cnt0, #cnt1 :cnt1");
    expect(u.names).toEqual({ "#cnt0": "n", "#cnt1": "unread", "#ttl": "ttl" });
    expect(u.values).toEqual({ ":cnt0": 1, ":cnt1": -2, ":ttl": 1234 });
  });

  it("counterUpdate carries if_not_exists values and a condition, and rejects bad deltas", () => {
    const u = counterUpdate(key("a"), { n: 1 }, { ifNotExists: { first_at: "T0" }, condition: "attribute_exists(PK)" });
    expect(u.update).toBe("SET #cs0 = if_not_exists(#cs0, :cs0) ADD #cnt0 :cnt0");
    expect(u.condition).toBe("attribute_exists(PK)");
    expect(() => counterUpdate(key("a"), {})).toThrow(/at least one delta/);
    expect(() => counterUpdate(key("a"), { n: "1" })).toThrow(TypeError);
    expect(() => counterUpdate(key("a"), { n: NaN })).toThrow(TypeError);
  });

  it("mergeUpdates sums ADD deltas on the same key and leaves other keys alone", () => {
    const merged = mergeUpdates([
      counterUpdate(key("a"), { n: 1, likes: 2 }, { ttl: 10, ifNotExists: { first_at: "T1" } }),
      counterUpdate(key("b"), { n: 5 }),
      counterUpdate(key("a"), { n: -1, likes: 3, extra: 4 }, { ttl: 99, ifNotExists: { first_at: "T2" } }),
      counterUpdate(key("a"), { n: 1 }),
    ]);
    expect(merged).toHaveLength(2);
    const a = merged.find((u) => u.key.PK === "CNT#a");
    expect(a.counter.adds).toEqual({ n: 1, likes: 5, extra: 4 }); // 1 - 1 + 1, 2 + 3, 4
    expect(a.counter.ifNotExists).toEqual({ first_at: "T1" });
    expect(a.counter.ttl).toBe(10);
    expect(merged.find((u) => u.key.PK === "CNT#b").counter.adds).toEqual({ n: 5 });
  });

  it("a merged update commits as ONE item and the fake adds the summed delta (including the SET if_not_exists ttl)", async () => {
    const ddb = createFakeDdb();
    const s = spied(ddb);
    const ups = [
      counterUpdate(key("a"), { n: 1 }, { ttl: 10, ifNotExists: { first_at: "T1" } }),
      counterUpdate(key("a"), { n: 1 }, { ttl: 99, ifNotExists: { first_at: "T2" } }),
      counterUpdate(key("a"), { n: 1 }),
    ];
    await expect(transact(ddb, cmds, T, { updates: ups })).rejects.toMatchObject({ name: "ValidationException" }); // one item twice is refused unmerged
    await transact(s, cmds, T, { updates: mergeUpdates(ups) });
    expect(s.inputs.at(-1).TransactItems).toHaveLength(1);
    expect(ddb.all().find((x) => x.PK === "CNT#a")).toMatchObject({ n: 3, ttl: 10, first_at: "T1" });
    // A later writer keeps the first ttl and first_at, and adds again.
    await transact(ddb, cmds, T, { updates: [counterUpdate(key("a"), { n: -2 }, { ttl: 500, ifNotExists: { first_at: "T9" } })] });
    expect(ddb.all().find((x) => x.PK === "CNT#a")).toMatchObject({ n: 1, ttl: 10, first_at: "T1" });
  });

  it("mergeUpdates refuses what it cannot fold", () => {
    const raw = { key: key("a"), update: "SET x = :x", values: { ":x": 1 } };
    expect(() => mergeUpdates([raw, { ...raw }])).toThrow(/non-counter/);
    expect(() => mergeUpdates([counterUpdate(key("a"), { n: 1 }, { condition: "attribute_exists(PK)" }), counterUpdate(key("a"), { n: 1 })])).toThrow(/different conditions/);
    expect(mergeUpdates([raw])).toEqual([raw]);
  });

  it("assertTxnSize passes 100 items and throws on 101", () => {
    const items = (n) => Array.from({ length: n }, (_, i) => ({ Put: { Item: { PK: String(i) } } }));
    expect(MAX_TXN_ITEMS).toBe(100);
    expect(assertTxnSize(items(100))).toBe(100);
    expect(() => assertTxnSize(items(101))).toThrow(/101 items/);
    expect(() => assertTxnSize(101)).toThrow(RangeError);
    expect(() => assertTxnSize({ puts: items(60), updates: items(30), checks: items(11) })).toThrow(expect.objectContaining({ code: "txn_too_large" }));
    expect(assertTxnSize({ puts: items(60), deletes: items(40) })).toBe(100);
  });

  it("transact() refuses an oversized call before it reaches the store", async () => {
    const ddb = createFakeDdb();
    const puts = Array.from({ length: 101 }, (_, i) => ({ item: { PK: `P${i}`, SK: "1" } }));
    await expect(transact(ddb, cmds, T, { puts })).rejects.toThrow(/101 items/);
    expect(ddb.calls).toEqual([]);
  });
});

describe("fake-ddb features", () => {
  const seed = async (ddb, item) => ddb.send(new cmds.PutCommand({ TableName: T, Item: item }));

  it("UpdateCommand: SET, SET if_not_exists, ADD (creating the item), REMOVE, and a failed condition", async () => {
    const ddb = createFakeDdb();
    const up = (expr, extra = {}) => ddb.send(new cmds.UpdateCommand({ TableName: T, Key: { PK: "U", SK: "1" }, UpdateExpression: expr, ...extra }));
    await up("SET #a = :a, #b = if_not_exists(#b, :b) ADD #n :one", { ExpressionAttributeNames: { "#a": "a", "#b": "b", "#n": "n" }, ExpressionAttributeValues: { ":a": "x", ":b": "first", ":one": 1 } });
    await up("SET #a = :a2, #b = if_not_exists(#b, :b2) ADD #n :one", { ExpressionAttributeNames: { "#a": "a", "#b": "b", "#n": "n" }, ExpressionAttributeValues: { ":a2": "y", ":b2": "second", ":one": 1 } });
    expect(ddb.all()[0]).toEqual({ PK: "U", SK: "1", a: "y", b: "first", n: 2 });
    await up("SET n = n + :k", { ExpressionAttributeValues: { ":k": 5 } });
    await up("REMOVE a, b");
    expect(ddb.all()[0]).toEqual({ PK: "U", SK: "1", n: 7 });
    await expect(up("ADD n :one", { ConditionExpression: "attribute_not_exists(PK)", ExpressionAttributeValues: { ":one": 1 } })).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(ddb.all()[0].n).toBe(7);
    await expect(ddb.send(new cmds.UpdateCommand({ TableName: T, Key: { PK: "NEW", SK: "1" }, UpdateExpression: "SET a.b = :v", ExpressionAttributeValues: { ":v": 1 } }))).rejects.toMatchObject({ name: "ValidationException" });
  });

  it("UpdateCommand supports a nested path whose parent exists and ReturnValues ALL_NEW", async () => {
    const ddb = createFakeDdb();
    await seed(ddb, { PK: "U", SK: "1", stats: { posts: 1 } });
    const r = await ddb.send(new cmds.UpdateCommand({ TableName: T, Key: { PK: "U", SK: "1" }, UpdateExpression: "ADD stats.posts :one", ExpressionAttributeValues: { ":one": 2 }, ReturnValues: "ALL_NEW" }));
    expect(r.Attributes.stats.posts).toBe(3);
  });

  it("transactional Update creates a missing item, applies if_not_exists, and rolls back with the rest on a failed condition", async () => {
    const ddb = createFakeDdb();
    await transact(ddb, cmds, T, { updates: [counterUpdate(key("a"), { n: 1 }, { ttl: 7 })] });
    expect(ddb.all()).toEqual([{ PK: "CNT#a", SK: "TOTAL", n: 1, ttl: 7 }]);
    await expect(
      transact(ddb, cmds, T, { updates: [counterUpdate(key("a"), { n: 1 })], puts: [{ item: { PK: "P", SK: "1" }, condition: "attribute_exists(PK)" }] }, noSleep),
    ).rejects.toMatchObject({ failedIndex: 0 });
    expect(ddb.all()).toHaveLength(1);
    expect(ddb.all()[0].n).toBe(1);
  });

  it("CancellationReasons line up with the TransactItems by index", async () => {
    const ddb = createFakeDdb();
    await seed(ddb, { PK: "E", SK: "1", v: 2 });
    let caught;
    try {
      await ddb.send(new cmds.TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: T, Item: { PK: "N", SK: "1" } } },
          { ConditionCheck: { TableName: T, Key: { PK: "E", SK: "1" }, ConditionExpression: "v = :v", ExpressionAttributeValues: { ":v": 1 } } },
          { Update: { TableName: T, Key: { PK: "E2", SK: "1" }, UpdateExpression: "ADD n :one", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":one": 1 } } },
        ],
      }));
    } catch (e) { caught = e; }
    expect(caught.name).toBe("TransactionCanceledException");
    expect(caught.CancellationReasons.map((r) => r.Code)).toEqual(["None", "ConditionalCheckFailed", "ConditionalCheckFailed"]);
    expect(ddb.all().map((r) => r.PK)).toEqual(["E"]);
  });

  it("a ConditionCheck needs a ConditionExpression and one item cannot be targeted twice", async () => {
    const ddb = createFakeDdb();
    const run = (TransactItems) => ddb.send(new cmds.TransactWriteCommand({ TransactItems }));
    await expect(run([{ ConditionCheck: { TableName: T, Key: { PK: "A", SK: "1" } } }])).rejects.toMatchObject({ name: "ValidationException" });
    await expect(run([{ Put: { TableName: T, Item: { PK: "A", SK: "1" } } }, { ConditionCheck: { TableName: T, Key: { PK: "A", SK: "1" }, ConditionExpression: "attribute_exists(PK)" } }])).rejects.toMatchObject({ name: "ValidationException" });
  });

  it("condition operators: <>, <, <=, >, >= on numbers and strings", async () => {
    const ddb = createFakeDdb();
    await seed(ddb, { PK: "C", SK: "1", n: 5, s: "b" });
    const check = (expr, values) => ddb.send(new cmds.TransactWriteCommand({ TransactItems: [{ ConditionCheck: { TableName: T, Key: { PK: "C", SK: "1" }, ConditionExpression: expr, ExpressionAttributeValues: values } }] }));
    await check("n < :v", { ":v": 6 });
    await check("n >= :v AND s <> :x", { ":v": 5, ":x": "z" });
    await expect(check("n > :v", { ":v": 5 })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await expect(check("s <= :v", { ":v": "a" })).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("Query: SK < key conditions (and <=, >, >=), ScanIndexForward, Select COUNT with Limit", async () => {
    const ddb = createFakeDdb();
    for (const sk of ["2026-01", "2026-02", "2026-03", "2026-04"]) await seed(ddb, { PK: "S#1", SK: sk });
    await seed(ddb, { PK: "S#2", SK: "2026-01" });
    const q = (extra) => ddb.send(new cmds.QueryCommand({ TableName: T, ...extra }));
    const lt = await q({ KeyConditionExpression: "PK = :pk AND SK < :sk", ExpressionAttributeValues: { ":pk": "S#1", ":sk": "2026-03" } });
    expect(lt.Items.map((r) => r.SK)).toEqual(["2026-01", "2026-02"]);
    const le = await q({ KeyConditionExpression: "PK = :pk AND SK <= :sk", ExpressionAttributeValues: { ":pk": "S#1", ":sk": "2026-03" }, ScanIndexForward: false });
    expect(le.Items.map((r) => r.SK)).toEqual(["2026-03", "2026-02", "2026-01"]);
    const gt = await q({ KeyConditionExpression: "PK = :pk AND SK > :sk", ExpressionAttributeValues: { ":pk": "S#1", ":sk": "2026-03" } });
    expect(gt.Items.map((r) => r.SK)).toEqual(["2026-04"]);
    const ge = await q({ KeyConditionExpression: "PK = :pk AND SK >= :sk", ExpressionAttributeValues: { ":pk": "S#1", ":sk": "2026-03" } });
    expect(ge.Items).toHaveLength(2);
    const count = await q({ KeyConditionExpression: "PK = :pk AND SK < :sk", ExpressionAttributeValues: { ":pk": "S#1", ":sk": "2026-04" }, Select: "COUNT" });
    expect(count).toEqual({ Count: 3, ScannedCount: 3 });
    expect(count.Items).toBeUndefined();
    const limited = await q({ KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "S#1" }, Select: "COUNT", Limit: 2 });
    expect(limited.Count).toBe(2);
    expect(limited.LastEvaluatedKey).toBeDefined();
  });

  it("failNext: n transaction failures with a cancellation code (optionally on one index), or an arbitrary error name; writes nothing", async () => {
    const ddb = createFakeDdb();
    const put = () => ddb.send(new cmds.TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { PK: "A", SK: "1" } } }, { Put: { TableName: T, Item: { PK: "B", SK: "1" } } }] }));
    ddb.failNext("TransactionConflict", 2);
    const e1 = await put().catch((x) => x);
    expect(e1.CancellationReasons.map((r) => r.Code)).toEqual(["TransactionConflict", "TransactionConflict"]);
    await expect(put()).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(ddb.all()).toEqual([]);
    await put(); // the queue is empty again
    expect(ddb.all()).toHaveLength(2);
    const ddb2 = createFakeDdb();
    ddb2.failNext("TransactionConflict", 1, { index: 1 });
    const e2 = await ddb2.send(new cmds.TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { PK: "A", SK: "1" } } }, { Put: { TableName: T, Item: { PK: "B", SK: "1" } } }] })).catch((x) => x);
    expect(e2.CancellationReasons.map((r) => r.Code)).toEqual(["None", "TransactionConflict"]);
    ddb2.failNext("InternalServerError");
    await expect(ddb2.send(new cmds.TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { PK: "A", SK: "1" } } }] }))).rejects.toMatchObject({ name: "InternalServerError" });
  });
});

describe("comments and content commits: 409 for a condition failure, 503 busy for exhausted conflicts", () => {
  const subject = "person:I0001";
  async function setup() {
    const w = makeApi();
    const [ann, olive] = await Promise.all(["I0001", "I0002"].map((s) => signToken(s)));
    return { w, ann, olive };
  }

  it("a comment create that hits a TransactionConflict is retried transparently with the same token", async () => {
    const { w, olive } = await setup();
    w.ddb.failNext("TransactionConflict", 2);
    const r = await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "hello" } });
    expect(r.status).toBe(201);
    expect(w.ddb.tokens).toHaveLength(3);
    expect(new Set(w.ddb.tokens).size).toBe(1);
    expect(w.ddb.all().filter((x) => x.entity === "comment")).toHaveLength(1);
  });

  it("a comment create whose retries are exhausted is 503 busy, nothing is written, and the same 4 attempts used one token", async () => {
    const { w, olive } = await setup();
    w.ddb.failNext("TransactionConflict", 10);
    const r = await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "hello" } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("busy");
    expect(w.ddb.tokens).toHaveLength(4);
    expect(new Set(w.ddb.tokens).size).toBe(1);
    expect(w.ddb.all()).toEqual([]);
  });

  it("a post publish whose retries are exhausted is 503 busy; a condition failure is still 409", async () => {
    const { w, ann } = await setup();
    w.ddb.failNext("TransactionConflict", 10);
    const busy = await w.call("POST", "/api/posts", { token: ann, body: { body: "news", visibility: "published" } });
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe("busy");
    expect(w.ddb.all()).toEqual([]);

    const w2 = makeApi();
    const made = await w2.call("POST", "/api/posts", { token: ann, body: { body: "news", visibility: "published" } });
    expect(made.status).toBe(201);
    // Make the stored version differ from the one the handler reads: a stale-version write is a plain 409.
    const raced = makeApi({
      intercept: async (cmd) => {
        if (cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((t) => t.Put?.ConditionExpression)) throw Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
      },
    });
    const p = await raced.call("POST", "/api/posts", { token: ann, body: { body: "n" } });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe("conflict");
    expect(raced.ddb.tokens).toHaveLength(0);
  });

  it("a throttled transaction is the store failing (503 unavailable), not a 409", async () => {
    const { w, ann } = await setup();
    w.ddb.failNext("ThrottlingError", 1);
    const r = await w.call("POST", "/api/posts", { token: ann, body: { body: "news", visibility: "published" } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("unavailable");
  });

  it("a comment edit race stays 409 (condition failure), without retry", async () => {
    const { w, olive } = await setup();
    const c = (await w.call("POST", "/api/comments", { token: olive, body: { subject, body: "v1" } })).body;
    const before = w.ddb.tokens.length;
    // concurrent edit: bump edited_at behind the handler's back, between its read and its write
    const row = [...w.ddb.rows.values()].find((x) => x.entity === "comment");
    const real = w.ddb.send.bind(w.ddb);
    w.ddb.send = async (cmd) => {
      if (cmd.constructor.name === "TransactWriteCommand") row.comment.edited_at = "2099-01-01T00:00:00.000Z";
      return real(cmd);
    };
    const r = await w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject, body: "v2" } });
    expect(r.status).toBe(409);
    expect(w.ddb.tokens.length - before).toBe(1);
  });
});

describe("errorResponse logs name, code, route and requestId only (PS-20)", () => {
  const NOTE = "NOTE-TEXT-7f3a: synthetic note body that must never be logged";
  const capture = () => {
    const lines = [];
    return { lines, error: (...a) => lines.push(a), warn: (...a) => lines.push(a) };
  };
  const dump = (log) => JSON.stringify(log.lines);

  it("a JSON.parse failure that quotes the note text logs neither message nor stack", () => {
    let parseError;
    try { JSON.parse(`{"note": ${NOTE}}`); } catch (e) { parseError = e; }
    expect(String(parseError.message + parseError.stack)).toContain("NOTE-TEXT"); // the planted text really is in the error (on this runtime)
    const log = capture();
    const res = errorResponse(parseError, log, { route: "records.get", requestId: "req-1" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "internal", message: "internal error" });
    expect(log.lines).toEqual([["unhandled", { name: "SyntaxError", code: undefined, route: "records.get", requestId: "req-1" }]]);
    expect(dump(log)).not.toContain("NOTE-TEXT");
  });

  it("a cancellation with an ALL_OLD Item is logged as name and code only", () => {
    const e = Object.assign(new Error(`Transaction cancelled [${NOTE}]`), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed", Message: NOTE, Item: { note: { S: NOTE } } }],
    });
    const log = capture();
    errorResponse(e, log, { route: "posts.update", requestId: "req-2" });
    expect(log.lines).toEqual([["unhandled", { name: "TransactionCanceledException", code: undefined, route: "posts.update", requestId: "req-2" }]]);
    expect(dump(log)).not.toContain("NOTE-TEXT");
    expect(dump(log)).not.toContain("CancellationReasons");
  });

  it("a TxnCancelled that escapes logs its fixed name and code, never its reasons", () => {
    const log = capture();
    errorResponse(new TxnCancelled(mapCancellationReasons({ CancellationReasons: [{ Code: "TransactionConflict", Message: NOTE }] }), 4), log, {});
    expect(log.lines).toEqual([["unhandled", { name: "TxnCancelled", code: "busy", route: undefined, requestId: undefined }]]);
    expect(dump(log)).not.toContain("NOTE-TEXT");
  });

  it("a name or code that is not a plain word is dropped, so error text cannot ride in either field", () => {
    const e = Object.assign(new Error("m"), { name: `Err ${NOTE}`, code: NOTE });
    expect(logSafeError(e, { route: NOTE, requestId: NOTE })).toEqual({ name: "NonError", code: undefined, route: undefined, requestId: undefined });
    expect(logSafeError("a thrown string with note text")).toEqual({ name: "NonError", code: undefined, route: undefined, requestId: undefined });
  });

  it("HttpError and typed errors still answer as before and log nothing", () => {
    const log = capture();
    expect(errorResponse(new HttpError(503, "busy", "busy, try again"), log).statusCode).toBe(503);
    expect(log.lines).toEqual([]);
  });

  it("through the handler: an unexpected store error carrying note text answers 500 and logs the safe fields with the route and request id", async () => {
    const log = capture();
    const w = makeApi({
      log,
      intercept: async (cmd) => {
        if (cmd.constructor.name === "QueryCommand") JSON.parse(`{"note": ${NOTE}}`);
      },
    });
    const ann = await signToken("I0001");
    const r = await w.handler({ requestContext: { http: { method: "GET" }, requestId: "req-9" }, rawPath: "/api/posts", headers: {}, cookies: [`io_id=${ann}`] });
    expect(r.statusCode).toBe(500);
    expect(log.lines).toEqual([["unhandled", { name: "SyntaxError", code: undefined, route: "posts.list", requestId: "req-9" }]]);
    expect(dump(log)).not.toContain("NOTE-TEXT");
    expect(r.body).not.toContain("NOTE-TEXT");
  });

  it("post-commit failures log name and code only", async () => {
    const log = capture();
    const w = makeApi({
      log,
      intercept: async (cmd) => { if (cmd.constructor.name === "ScanCommand") throw Object.assign(new Error(NOTE), { name: "ProvisionedThroughputExceededException" }); },
    });
    const ann = await signToken("I0001");
    const r = await w.call("POST", "/api/posts", { token: ann, body: { body: "hello", visibility: "published" } });
    expect(r.status).toBe(201);
    expect(log.lines.length).toBeGreaterThan(0);
    expect(dump(log)).not.toContain("NOTE-TEXT");
    expect(log.lines[0][1]).toMatchObject({ name: "ProvisionedThroughputExceededException" });
  });
});
