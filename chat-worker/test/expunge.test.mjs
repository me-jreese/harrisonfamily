// POST /chat/v1/admin/expunge (HFY-TSK-337): the Worker front door, the hub route, each copy of the text the hub holds, the read
// that follows, and `api/scripts/expunge.mjs --chat --apply` end to end against the Worker over a local HTTP socket.
// Runs the committed dist/index.js. Synthetic ids, text and tokens only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { decodeServerFrame } from "@io-kit/chat";
import { fakeNamespace, bundledHub, installShims, loadBundle, spyConsole } from "./helpers.mjs";

const DM = "dm:I9001:I9002";
const TOKEN = randomBytes(24).toString("hex");
const SECRET_TEXT = "ZEBRA-EXPUNGE-ME";
const SITE = "https://harrisonfamily.test";
const URL_ADMIN = `${SITE}/chat/v1/admin/expunge`;

const post = (body, { token = TOKEN, url = URL_ADMIN, method = "POST" } = {}) =>
  new Request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
const hubPost = (rig, body, opts) => rig.hub.fetch(post(body, { url: "https://chat-hub.internal/admin/expunge", ...opts }));

/** Three messages in the DM, sent by alternating members while both are connected. Returns the two clients. */
async function talk(rig) {
  const a = await rig.connect("I9001");
  const b = await rig.connect("I9002");
  await a.send({ t: "send", conv: DM, cmid: "c1", text: "first message" });
  await b.send({ t: "send", conv: DM, cmid: "c2", text: `${SECRET_TEXT} second message` });
  await a.send({ t: "send", conv: DM, cmid: "c3", text: "third message" });
  return { a, b };
}

const rowsOf = (rig) => rig.state.storage.sql.exec("SELECT conv, seq, cmid, from_uid, kind, text, ts FROM msg ORDER BY seq").toArray();
const history = async (client, rid) => {
  const before = client.frames().length;
  await client.send({ t: "page", conv: DM, rid, limit: 50 });
  const batch = client.frames().slice(before).find((f) => f.t === "batch" && f.rid === rid);
  assert.ok(batch, "a batch came back");
  return batch.msgs;
};

// ---------------------------------------------------------------------------------------------------------------- the hub route

test("the hub nulls the text, keeps seq, sender, cmid and timestamp, and answers 200 {nulled:1}; again {nulled:0}", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    await talk(rig);
    const before = rowsOf(rig);
    const res = await hubPost(rig, { conv: DM, seq: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { nulled: 1 });
    assert.match(res.headers.get("cache-control"), /no-store/);
    const after = rowsOf(rig);
    assert.equal(after.length, 3);
    assert.equal(after[1].text, null);
    assert.deepEqual({ ...after[1], text: "x" }, { ...before[1], text: "x" }, "everything but the text is as it was");
    assert.deepEqual([after[0], after[2]], [before[0], before[2]], "the neighbours are untouched");
    const again = await hubPost(rig, { conv: DM, seq: 2 });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { nulled: 0 });
  } finally {
    rig.close();
  }
});

test("a message that does not exist answers 404; a row with no text (a system row) answers {nulled:0}", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    const { a } = await talk(rig);
    for (const ref of [{ conv: DM, seq: 99 }, { conv: "dm:I9001:I9003", seq: 1 }, { conv: "g:nosuchgroup", seq: 1 }]) {
      const res = await hubPost(rig, ref);
      assert.equal(res.status, 404, JSON.stringify(ref));
      assert.deepEqual(await res.json(), { error: "not_found" });
    }
    await a.send({ t: "create", cmid: "g1", members: ["I9002"], name: "table", policy: "private" });
    const sys = rowsOf(rig).find((r) => r.kind === "sys");
    assert.ok(sys, "creating a group wrote a system row");
    const res = await hubPost(rig, { conv: sys.conv, seq: sys.seq });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { nulled: 0 });
    assert.ok(rowsOf(rig).find((r) => r.kind === "sys" && r.seq === sys.seq).conv === sys.conv, "the row stays");
  } finally {
    rig.close();
  }
});

test("the hub checks the token itself: none, a wrong one, a short secret, and no secret at all", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  const bare = await bundledHub();
  const short = await bundledHub({ env: { CHAT_ADMIN_TOKEN: "short" } });
  try {
    await talk(rig);
    for (const token of [null, "", "wrong-token-value", TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const res = await hubPost(rig, { conv: DM, seq: 2 }, { token });
      assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
      assert.deepEqual(await res.json(), { error: "unauthorized" });
    }
    const basic = await rig.hub.fetch(new Request("https://chat-hub.internal/admin/expunge", { method: "POST", headers: { authorization: `Basic ${TOKEN}` }, body: JSON.stringify({ conv: DM, seq: 2 }) }));
    assert.equal(basic.status, 401);
    assert.equal(rowsOf(rig)[1].text.includes(SECRET_TEXT), true, "nothing was nulled by a refused call");
    // the member session is not an admin credential
    assert.equal((await hubPost(rig, { conv: DM, seq: 2 }, { token: "io_id-session-value-that-is-long-enough" })).status, 401);
    assert.equal((await hubPost(bare, { conv: DM, seq: 1 })).status, 404, "no secret: the route does not exist");
    assert.equal((await hubPost(short, { conv: DM, seq: 1 }, { token: "short" })).status, 404, "a secret under 32 characters is a misconfiguration: closed");
  } finally {
    short.close(); // in reverse order: each one restores the fetch it found
    bare.close();
    rig.close();
  }
});

test("the hub refuses a malformed body, another method and an oversized body", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    await talk(rig);
    const bad = ["", "not json", "[]", "null", "{}", JSON.stringify({ conv: DM }), JSON.stringify({ seq: 2 }),
      JSON.stringify({ conv: DM, seq: 0 }), JSON.stringify({ conv: DM, seq: -1 }), JSON.stringify({ conv: DM, seq: 1.5 }),
      JSON.stringify({ conv: DM, seq: "2" }), JSON.stringify({ conv: DM, seq: 3e10 }), JSON.stringify({ conv: "x:1", seq: 1 }),
      JSON.stringify({ conv: `${DM}'; DROP TABLE msg;--`, seq: 1 }), JSON.stringify({ conv: DM, seq: 2, extra: 1 })];
    for (const body of bad) {
      const res = await hubPost(rig, body);
      assert.equal(res.status, 400, `body ${body.slice(0, 40)}`);
    }
    assert.equal((await hubPost(rig, "x".repeat(2000))).status, 413);
    assert.equal((await hubPost(rig, undefined, { method: "GET" })).status, 405);
    assert.equal(rowsOf(rig).filter((r) => r.text === null).length, 0, "no refused call nulled anything");
  } finally {
    rig.close();
  }
});

test("a drain that will not settle: the route answers 503 {archive_busy} with Retry-After, nulls nothing, and the caller can retry", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    await talk(rig);
    // every wait ends and another drain is already running: the loop is bounded by a count (the bundle has no timer)
    let reads = 0;
    Object.defineProperty(rig.hub.server, "archiving", { configurable: true, get: () => { reads++; return Promise.resolve(); } });
    const res = await hubPost(rig, { conv: DM, seq: 2 });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "archive_busy" });
    assert.equal(res.headers.get("retry-after"), "5");
    assert.ok(reads > 1 && reads < 100, `bounded wait (${reads} reads)`);
    assert.ok(rowsOf(rig)[1].text.includes(SECRET_TEXT), "nothing was nulled, so nothing was reported as nulled");
    // the same call once the drain is gone
    delete rig.hub.server.archiving;
    rig.hub.server.archiving = null;
    assert.deepEqual(await (await hubPost(rig, { conv: DM, seq: 2 })).json(), { nulled: 1 });
  } finally {
    rig.close();
  }
});

test("a drain that starts between the last wait and the update still stops the expunge (the check is inside the step)", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    await talk(rig);
    // quiet for every read in the wait loop, busy at the one inside the synchronous step
    let n = 0;
    Object.defineProperty(rig.hub.server, "archiving", { configurable: true, get: () => (++n >= 3 ? Promise.resolve() : null) });
    const res = await hubPost(rig, { conv: DM, seq: 2 });
    assert.equal(res.status, 503);
    assert.ok(rowsOf(rig)[1].text.includes(SECRET_TEXT));
  } finally {
    rig.close();
  }
});

test("kit pin: server.archiving is falsy at rest and a thenable while a drain runs (what the expunge waits on)", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  const realNow = Date.now;
  try {
    await talk(rig);
    assert.ok(!rig.hub.server.archiving, "falsy at rest");
    rig.api.modes.archive = "hold";
    Date.now = () => realNow() + 11 * 60 * 1000;
    const alarm = rig.hub.alarm();
    for (let i = 0; i < 50 && rig.api.callsTo("/chat/archive").length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(typeof rig.hub.server.archiving?.then, "function", "a promise while the drain is in flight");
    rig.api.release();
    await alarm;
    assert.ok(!rig.hub.server.archiving, "falsy again once it settled");
  } finally {
    Date.now = realNow;
    rig.close();
  }
});

test("kit pin: @io-kit/chat 0.1.6 rejects text:null in a history batch (the follow-up the runbook names). When this fails the kit accepts a removed message: delete the 'chat must be dark' warnings and make the client show 'message removed'", () => {
  const msg = { t: "batch", conv: DM, rid: "r1", more: false, msgs: [{ conv: DM, seq: 2, cmid: "c2", from: "I9002", ts: 1, kind: "msg", text: null, expunged: true }] };
  const res = decodeServerFrame(JSON.stringify(msg));
  assert.equal(res.ok, false, "the pinned client decoder refuses text:null, so an expunge needs chat dark (chatV1 false) until the kit release");
  assert.match(res.reason, /text/);
  msg.msgs[0].text = "";
  assert.equal(decodeServerFrame(JSON.stringify(msg)).ok, true, "the empty string is the only shape the 0.1.6 decoder takes");
});

// ------------------------------------------------------------------------------------------------------------ every copy, the read

test("the nulled text is in none of the hub's storage: every table, the archive batches, the archive post and the object itself", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  const realNow = Date.now;
  try {
    await talk(rig);
    // before the expunge the text is in the table and in the next archive batch (the test would be empty otherwise)
    assert.ok(JSON.stringify(rig.hub.core.archiveTake(realNow())).includes(SECRET_TEXT), "the archive batch carries the text before");
    assert.ok(JSON.stringify(dump(rig)).includes(SECRET_TEXT));
    assert.equal((await hubPost(rig, { conv: DM, seq: 2 })).status, 200);

    // (1) the durable object storage: every table
    assert.ok(!JSON.stringify(dump(rig)).includes(SECRET_TEXT), "SQLite holds no copy");
    // (2) the archive batch a drain would post, and the post itself
    const batches = rig.hub.core.archiveTake(realNow());
    assert.ok(!JSON.stringify(batches).includes(SECRET_TEXT));
    const m = batches.flatMap((b) => b.msgs).find((x) => x.seq === 2);
    assert.deepEqual({ seq: m.seq, from: m.from, kind: m.kind, expunged: m.expunged }, { seq: 2, from: "I9002", kind: "msg", expunged: true });
    rig.api.calls.length = 0;
    Date.now = () => realNow() + 11 * 60 * 1000;
    await rig.hub.alarm();
    const posted = rig.api.callsTo("/chat/archive");
    assert.ok(posted.length >= 1, "the archive was posted");
    assert.ok(!JSON.stringify(posted).includes(SECRET_TEXT), "the archive post holds no copy");
    assert.deepEqual(posted[0].body.msgs.map((x) => x.seq), [1, 2, 3], "the expunged row still goes, at its seq, with no text");
    assert.equal(posted[0].body.msgs[1].text, "");
    // (3) in memory: nothing reachable from the hub object (the core, the server, the store) holds the text
    assert.equal(findText({ ring: [{ nested: new Map([["k", `x ${SECRET_TEXT}`]]) }] }, SECRET_TEXT, new Set()).length, 1, "control: the walk finds a copy in a buffer, a map and a string");
    assert.deepEqual(findText(rig.hub, SECRET_TEXT, new Set([rig.state, rig.hub.table])), [], "no in-memory copy (ring buffer, cache or batch)");
  } finally {
    Date.now = realNow;
    rig.close();
  }
});

test("an archive drain in flight settles before the expunge answers, so the text cannot be posted after it", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  const realNow = Date.now;
  try {
    await talk(rig);
    rig.api.modes.archive = "hold";
    Date.now = () => realNow() + 11 * 60 * 1000;
    const alarm = rig.hub.alarm();
    for (let i = 0; i < 50 && rig.api.callsTo("/chat/archive").length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(rig.api.callsTo("/chat/archive").length, 1, "a batch holding the text is in flight");
    let answered = false;
    const expunge = hubPost(rig, { conv: DM, seq: 2 }).then((r) => { answered = true; return r; });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(answered, false, "the expunge waits for the drain");
    assert.ok(rowsOf(rig)[1].text.includes(SECRET_TEXT), "and has not nulled yet");
    rig.api.release();
    await alarm;
    const res = await expunge;
    assert.deepEqual(await res.json(), { nulled: 1 });
    assert.equal(rowsOf(rig)[1].text, null);
    // the drain that was in flight is the last one that could carry the text: the next one is built from the table
    rig.api.calls.length = 0;
    rig.api.modes.archive = "ok";
    await hubPost(rig, { conv: DM, seq: 1 });
    Date.now = () => realNow() + 30 * 60 * 1000;
    await rig.hub.alarm();
    assert.ok(!JSON.stringify(rig.api.calls).includes(SECRET_TEXT));
  } finally {
    Date.now = realNow;
    rig.close();
  }
});

test("a connected client's next history read shows the message as removed (text null, expunged true), order unchanged", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    const { a, b } = await talk(rig);
    const before = await history(a, "r0");
    assert.deepEqual(before.map((m) => m.seq), [1, 2, 3]);
    assert.equal(before[1].text.includes(SECRET_TEXT), true);
    await hubPost(rig, { conv: DM, seq: 2 });
    for (const [client, rid] of [[a, "r1"], [b, "r2"]]) {
      const msgs = await history(client, rid);
      assert.deepEqual(msgs.map((m) => m.seq), [1, 2, 3], "ordering is unchanged");
      assert.deepEqual(msgs.map((m) => m.from), ["I9001", "I9002", "I9001"], "senders are unchanged");
      assert.deepEqual(msgs.map((m) => m.ts), before.map((m) => m.ts), "timestamps are unchanged");
      assert.equal(msgs[1].text, null);
      assert.equal(msgs[1].expunged, true);
      assert.equal(msgs[1].kind, "msg");
      assert.equal(msgs[0].expunged, undefined);
      assert.equal(msgs[2].expunged, undefined);
      assert.equal(msgs[0].text, "first message");
      assert.equal(msgs[2].text, "third message");
    }
    // the other read path: a reconnect resumes with a batch after the client's last seq
    const c = await rig.connect("I9002", { hello: false });
    await c.send({ t: "hello", v: 1, sid: "tab-resume", vis: true, resume: { [DM]: 1 } });
    const resumed = c.frames().find((f) => f.t === "batch" && f.conv === DM);
    assert.deepEqual(resumed.msgs.map((m) => m.seq), [2, 3]);
    assert.equal(resumed.msgs[0].text, null);
    assert.equal(resumed.msgs[0].expunged, true);
    // a retried send of the same cmid is still acked at its seq (the row is there, only the text is gone)
    await b.send({ t: "send", conv: DM, cmid: "c2", text: "anything" });
    assert.deepEqual(rowsOf(rig).map((r) => r.seq), [1, 2, 3], "no new row");
    assert.ok(b.frames().some((f) => f.t === "ack" && f.cmid === "c2" && f.seq === 2));
  } finally {
    rig.close();
  }
});

test("a message sent after an expunge gets the next seq, and the removed one stays between its neighbours", async () => {
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    const { a, b } = await talk(rig);
    await hubPost(rig, { conv: DM, seq: 3 });
    await b.send({ t: "send", conv: DM, cmid: "c4", text: "fourth message" });
    const msgs = await history(a, "r1");
    assert.deepEqual(msgs.map((m) => [m.seq, m.expunged === true]), [[1, false], [2, false], [3, true], [4, false]]);
  } finally {
    rig.close();
  }
});

test("the admin route logs nothing: no token, conversation, seq or text reaches the console", async () => {
  const spy = spyConsole();
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  try {
    await talk(rig);
    await hubPost(rig, { conv: DM, seq: 2 });
    await hubPost(rig, { conv: DM, seq: 2 }, { token: "wrong-token-value" });
    await hubPost(rig, "{ broken");
  } finally {
    rig.close();
    spy.restore();
  }
  const out = spy.text();
  for (const needle of [TOKEN, "wrong-token-value", SECRET_TEXT, "Bearer", "/admin/expunge"]) assert.ok(!out.includes(needle), `console output holds ${needle}`);
});

// ------------------------------------------------------------------------------------------------------------------ the Worker

const baseEnv = (ns, extra = {}) => ({
  CHAT_HUB: ns, SITE_ORIGIN: SITE, SESSION_ISSUER: `${SITE}/auth`, SESSION_AUDIENCE: "family-web", SESSION_JWKS_URL: `${SITE}/auth/.well-known/jwks.json`,
  SESSION_COOKIE: "io_id", CHAT_ENABLED: "1", CHAT_OPEN_TO: "all", CHAT_WORKER_VERSION: "abc1234", ...extra,
});

test("the Worker checks the bearer token before the hub is reached, and forwards only the token and the body", async () => {
  const bundle = await loadBundle();
  const ns = fakeNamespace(() => new Response('{"nulled":1}', { status: 200, headers: { "content-type": "application/json" } }));
  const env = baseEnv(ns, { CHAT_ADMIN_TOKEN: TOKEN });
  for (const req of [post({ conv: DM, seq: 2 }, { token: null }), post({ conv: DM, seq: 2 }, { token: "wrong-token-value" }), post({ conv: DM, seq: 2 }, { token: `${TOKEN}0` })]) {
    const res = await bundle.default.fetch(req, env, {});
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
  assert.equal(ns.calls.get.length, 0, "an unauthenticated call never wakes the hub");
  const res = await bundle.default.fetch(new Request(URL_ADMIN, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", cookie: "io_id=SESSION-VALUE", origin: SITE, "x-forwarded-for": "203.0.113.5" }, body: JSON.stringify({ conv: DM, seq: 2 }) }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { nulled: 1 });
  assert.deepEqual(ns.calls.idFromName, ["family"]);
  assert.deepEqual(ns.calls.get[0].options, { locationHint: "wnam" });
  const forwarded = ns.calls.requests[0];
  assert.equal(new URL(forwarded.url).pathname, "/admin/expunge");
  assert.equal(forwarded.method, "POST");
  assert.deepEqual([...forwarded.headers.keys()].sort(), ["authorization", "content-type"]);
  assert.deepEqual(JSON.parse(await forwarded.text()), { conv: DM, seq: 2 });
  const big = await bundle.default.fetch(post("x".repeat(5000)), env, {});
  assert.equal(big.status, 413);
  assert.equal(ns.calls.get.length, 1);
});

test("the Worker cuts a chunked body (no content-length) off at the cap instead of reading it whole", async () => {
  const bundle = await loadBundle();
  const ns = fakeNamespace(() => new Response('{"nulled":1}'));
  const env = baseEnv(ns, { CHAT_ADMIN_TOKEN: TOKEN });
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1000));
  const body = new ReadableStream({ pull(c) { pulled++; if (pulled > 1000) c.close(); else c.enqueue(chunk); }, cancel() { cancelled = true; } });
  const req = new Request(URL_ADMIN, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body, duplex: "half" });
  assert.equal(req.headers.get("content-length"), null);
  const res = await bundle.default.fetch(req, env, {});
  assert.equal(res.status, 413);
  assert.ok(pulled < 20, `stopped after ${pulled} chunks of 1000 bytes`);
  assert.equal(cancelled, true);
  assert.equal(ns.calls.get.length, 0);
});

test("with no CHAT_ADMIN_TOKEN (or a short one) the route does not exist: the request goes on to the origin; other methods always do", async () => {
  const bundle = await loadBundle();
  const realFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (input, init) => { outbound.push(input instanceof Request ? input : new Request(input, init)); return new Response("from the origin"); };
  try {
    const ns = fakeNamespace();
    for (const env of [baseEnv(ns), baseEnv(ns, { CHAT_ADMIN_TOKEN: "short" }), baseEnv(ns, { CHAT_ADMIN_TOKEN: "" })]) {
      outbound.length = 0;
      const req = post({ conv: DM, seq: 2 });
      const res = await bundle.default.fetch(req, env, {});
      assert.equal(await res.text(), "from the origin");
      assert.equal(outbound[0], req);
    }
    for (const method of ["GET", "PUT", "DELETE"]) {
      outbound.length = 0;
      const req = new Request(URL_ADMIN, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      await bundle.default.fetch(req, baseEnv(ns, { CHAT_ADMIN_TOKEN: TOKEN }), {});
      assert.equal(outbound[0], req, `${method} goes on to the origin`);
    }
    assert.equal(ns.calls.get.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------------------------- privacy-expunge.mjs --chat --apply, end to end

/** A local HTTP front for the bundled Worker, with the real hub (on a fake Durable Object state) behind it. */
async function serve(rig) {
  const bundle = await loadBundle();
  const ns = fakeNamespace((req) => rig.hub.fetch(req));
  const env = baseEnv(ns, { CHAT_ADMIN_TOKEN: TOKEN });
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`${SITE}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    seen.push(`${req.method} ${req.url}`);
    const out = await bundle.default.fetch(request, env, {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/chat/v1`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The slice of DynamoDB the script's chat mode uses: Get, Put and Delete on a map. */
function fakeTable(items) {
  const rows = new Map(items.map((i) => [`${i.PK}\u0000${i.SK}`, i]));
  const cmd = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  return {
    rows,
    cmds: { GetCommand: cmd("get"), PutCommand: cmd("put"), DeleteCommand: cmd("delete"), QueryCommand: cmd("query"), ScanCommand: cmd("scan"), TransactWriteCommand: cmd("txn") },
    ddb: {
      async send(c) {
        const k = (key) => `${key.PK}\u0000${key.SK}`;
        if (c.name === "get") return { Item: rows.get(k(c.input.Key)) };
        if (c.name === "put") { rows.set(k(c.input.Item), c.input.Item); return {}; }
        if (c.name === "delete") { rows.delete(k(c.input.Key)); return {}; }
        throw new Error(`unexpected ${c.name}`);
      },
    },
  };
}

test("privacy-expunge.mjs --chat --apply nulls the hub message through the Worker, then deletes the mirror row; a second run nulls nothing", async () => {
  const { run, parseArgs, createHubClient, CHAT_CLIENT_WARNING } = await import("../../api/scripts/expunge.mjs");
  const realFetch = globalThis.fetch;
  const rig = await bundledHub({ env: { CHAT_ADMIN_TOKEN: TOKEN } });
  const front = await serve(rig);
  try {
    await talk(rig);
    const mirrorKey = (seq) => ({ PK: `CHAT#${DM}`, SK: `M#${String(seq).padStart(10, "0")}` });
    const table = fakeTable([2, 3].map((seq) => ({ ...mirrorKey(seq), entity: "chat_msg", seq, text: seq === 2 ? `${SECRET_TEXT} second message` : "third message" })));
    const lines = [];
    const ctx = (hub) => ({
      ddb: table.ddb, cmds: table.cmds, table: "hfy-test", log: (l) => lines.push(l), now: () => Date.UTC(2026, 9, 14), uid: (() => { let n = 0; return () => `u${++n}`; })(),
      stepUp: async () => ({ sub: "I0099" }), hub,
    });
    const hub = createHubClient({ url: front.url, token: TOKEN, fetchImpl: (u, i) => realFetch(u, i) });
    const args = parseArgs(["--chat", `${DM}:2`, "--apply"], {});

    // the dry run reads the mirror and calls nothing
    await run(parseArgs(["--chat", `${DM}:2`], {}), ctx(hub));
    assert.deepEqual(front.seen, []);
    assert.ok(rowsOf(rig)[1].text.includes(SECRET_TEXT));

    const r1 = await run(args, ctx(hub));
    assert.deepEqual(r1.counts, { mirror_rows: 1, hub_messages: 1 });
    assert.deepEqual(front.seen, ["POST /chat/v1/admin/expunge"]);
    assert.equal(rowsOf(rig)[1].text, null);
    assert.equal(table.rows.has(`${mirrorKey(2).PK}\u0000${mirrorKey(2).SK}`), false, "the mirror row is gone");
    assert.equal(table.rows.has(`${mirrorKey(3).PK}\u0000${mirrorKey(3).SK}`), true, "another message's mirror row is not");
    const audit = [...table.rows.values()].find((r) => r.PK.startsWith("AUDIT#expunge:"));
    assert.deepEqual(audit.after, { mode: "chat", counts: { mirror_rows: 1, hub_messages: 1 } });
    assert.ok(!JSON.stringify([...table.rows.values()]).includes(SECRET_TEXT));

    // history as a member sees it
    const reader = await rig.connect("I9001");
    const msgs = await history(reader, "rx");
    assert.deepEqual(msgs.map((m) => [m.seq, m.from, m.expunged === true, m.text === null]), [[1, "I9001", false, false], [2, "I9002", true, true], [3, "I9001", false, false]]);

    // a second run: the hub has nothing left to null (200 {nulled:0}), the audit says so
    const r2 = await run(args, ctx(hub));
    assert.deepEqual(r2.counts, { mirror_rows: 0, hub_messages: 0 });

    // a message the hub does not hold: 404, which the script reads as nothing to null
    const r3 = await run(parseArgs(["--chat", `${DM}:77`, "--apply"], {}), ctx(hub));
    assert.equal(r3.counts.hub_messages, 0);

    // a wrong token stops the run before any mirror row is deleted
    const bad = createHubClient({ url: front.url, token: `${TOKEN}0`, fetchImpl: (u, i) => realFetch(u, i) });
    table.rows.set(`${mirrorKey(3).PK}\u0000${mirrorKey(3).SK}`, { ...mirrorKey(3), entity: "chat_msg", seq: 3, text: "third message" });
    await assert.rejects(run(parseArgs(["--chat", `${DM}:3`, "--apply"], {}), ctx(bad)), /401/);
    assert.equal(table.rows.has(`${mirrorKey(3).PK}\u0000${mirrorKey(3).SK}`), true);
    assert.equal(rowsOf(rig)[2].text, "third message");
    assert.ok(!lines.join("\n").includes(SECRET_TEXT));
    // every chat run (dry or applied) prints the client warning: 0.1.6 clients cannot load a history with a removed message
    assert.ok(lines.some((l) => l === CHAT_CLIENT_WARNING && /dark/.test(l)));
    // a busy hub (503) is a retry, not a success: the script stops before the mirror row is deleted
    const busy = createHubClient({ url: "http://127.0.0.1:1/chat/v1", token: TOKEN, fetchImpl: async () => new Response('{"error":"archive_busy"}', { status: 503 }) });
    await assert.rejects(busy.nullMessage({ conv: DM, seq: 2 }), /run the same command again/);
  } finally {
    globalThis.fetch = realFetch;
    await front.close();
    rig.close();
  }
});

// ------------------------------------------------------------------------------------------------------------------------ helpers

/** Every row of every table the hub's storage holds. */
function dump(rig) {
  const sql = rig.state.storage.sql;
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => String(r.name));
  return Object.fromEntries(tables.map((t) => [t, sql.exec(`SELECT * FROM "${t}"`).toArray()]));
}

/** Paths in the object graph (strings, Map and Set entries included) that hold `needle`; `skip` objects are not entered. */
function findText(root, needle, skip, path = "hub", seen = new WeakSet(), out = [], depth = 0) {
  if (typeof root === "string") {
    if (root.includes(needle)) out.push(path);
    return out;
  }
  if (root === null || typeof root !== "object" && typeof root !== "function") return out;
  if (seen.has(root) || skip.has(root) || depth > 12) return out;
  seen.add(root);
  if (root instanceof Map) for (const [k, v] of root) { findText(k, needle, skip, `${path}.<key>`, seen, out, depth + 1); findText(v, needle, skip, `${path}.<${String(k)}>`, seen, out, depth + 1); }
  else if (root instanceof Set) for (const v of root) findText(v, needle, skip, `${path}.<item>`, seen, out, depth + 1);
  for (const k of Reflect.ownKeys(root)) {
    let v;
    try { v = root[k]; } catch { continue; }
    findText(v, needle, skip, `${path}.${String(k)}`, seen, out, depth + 1);
  }
  return out;
}
