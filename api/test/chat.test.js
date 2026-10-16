// HFY-TSK-164 (hfy-chat-api-service-routes): the three chat service routes and the service-token authentication they sit on.
// Synthetic ids only (I9001...), keys generated per run. AC map: AC1 routes/errors/exclusions, AC2 service-only push, AC3 title+navigate, AC4 directory,
// AC5 registry, AC6 archive, AC7 empty ChatServicePublicKeys.
import { describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { ROUTES, buildCaps } from "../src/routes.js";
import { POLICY_ROWS } from "../src/policy.js";
import { TEMPLATE_REGISTRY } from "../src/notify.js";
import {
  CHAT_AUDIENCE, CHAT_ISSUER, CHAT_SUBJECT, assertShowsNotification, buildChatPush, chatPath, createServiceAuthenticator, parseArchive, parseServiceKeys,
} from "../src/chat.js";
import { cmds, makeApi, signToken, TABLE } from "./world.js";

const MEMBER = "I9001";
const PEER = "I9002";
const DM = "dm:I9001:I9002";
const GROUP = "g:01JC0000000000000000000000";
const b64 = async (key) => (await exportSPKI(key)).replace(/-----[A-Z ]+-----|\s/g, "");

async function keypair() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  return { publicKey, privateKey, spki: await b64(publicKey) };
}
const main = await keypair();
const other = await keypair();
const KEYS = JSON.stringify([{ kid: "hfy-chat-1", spki: main.spki }]);

let jtiN = 0;
function serviceToken({ key = main.privateKey, kid = "hfy-chat-1", alg = "ES256", iss = CHAT_ISSUER, aud = CHAT_AUDIENCE, sub = CHAT_SUBJECT, iat = Math.floor(Date.now() / 1000), life = 60, exp, jti = `01JCTESTJTI${++jtiN}` } = {}) {
  const t = new SignJWT({}).setProtectedHeader({ alg, kid, typ: "JWT" }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt(iat).setExpirationTime(exp ?? iat + life);
  if (jti) t.setJti(jti);
  return t.sign(key);
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const ENTRIES = new Map([
  ["a@example.test", { sub: MEMBER }],
  ["b@example.test", { sub: PEER }],
  ["c@example.test", { sub: "I9003" }],
  ["d@example.test", { sub: "I9004" }],
  ["bad@example.test", { sub: "has space" }],
]);
const LABELS = { [MEMBER]: "Alex Example", [PEER]: "Blake Example", I9003: "a.person@example.test" }; // an email-shaped label must never come out

function world({ keys = KEYS, entries = ENTRIES, withPush = true, log, clock } = {}) {
  const authenticateService = createServiceAuthenticator({ getKeys: () => keys, log: { warn() {}, error() {} } });
  const w = makeApi({
    withPush, log, clock,
    extraDeps: {
      authenticateService, readEntries: async () => (typeof entries === "function" ? entries() : entries),
      resolveLabel: async ({ sub }) => LABELS[sub] ?? sub,
    },
  });
  const svc = async (method, path, { body, token, headers } = {}) => w.call(method, path, { body, headers: { ...(token === null ? {} : bearer(token ?? (await serviceToken()))), ...headers } });
  return { ...w, svc };
}

const subscribe = (w, principal, endpoint = `https://push.example.test/${principal}`) => w.subscriptions.put(principal, { endpoint, keys: { p256dh: "p", auth: "a" } });
const prefs = (w, principal, enabled, detail = 0) => w.preferences.put(principal, { features: { chat_message: { enabled, detail } } });

describe("routes: auth service, excluded from MCP and POLICY_ROWS, in caps (AC1)", () => {
  const chat = ROUTES.filter((r) => r.name.startsWith("chat."));
  it("registers the three routes as service routes with no mcp member and no policy row", () => {
    expect(chat.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /chat/directory", "POST /chat/push", "POST /chat/archive"]);
    for (const r of chat) {
      expect(r.auth).toBe("service");
      expect(r.mcp).toBeUndefined();
      expect(r.gate).toMatchObject({ type: "switch", name: "CHAT_SERVICE_AUTH" });
      expect(POLICY_ROWS.some((p) => JSON.stringify(p).includes(r.name))).toBe(false);
    }
  });
  it("caps.json lists them with auth service and documents the service scheme", () => {
    const caps = buildCaps();
    expect(caps.actions.filter((a) => a.name.startsWith("chat.")).map((a) => [a.name, a.auth, a.path])).toEqual([
      ["chat.directory", "service", "/api/chat/directory"], ["chat.push", "service", "/api/chat/push"], ["chat.archive", "service", "/api/chat/archive"],
    ]);
    expect(caps.service).toMatchObject({ alg: "ES256", audience: "hfy-api/chat", max_lifetime_seconds: 60 });
    expect(caps.mcp.tools.some((t) => /chat/.test(t.action))).toBe(false);
  });
});

describe("service authentication (AC1, AC7)", () => {
  it("accepts a valid token, and a wrong method on a chat path is a 404 (a session caller never sees a service route), not an auth bypass", async () => {
    const w = world();
    expect((await w.svc("GET", "/api/chat/directory")).status).toBe(200);
    expect((await w.svc("DELETE", "/api/chat/directory", { token: null })).status).toBe(404);
  });
  it.each([
    ["no token", { token: null }],
    ["a garbage token", { token: "not.a.jwt" }],
  ])("%s is 401 unauthenticated with a challenge on every route", async (_n, opt) => {
    const w = world();
    for (const [m, p, body] of [["GET", "/api/chat/directory"], ["POST", "/api/chat/push", { items: [] }], ["POST", "/api/chat/archive", {}]]) {
      const r = await w.svc(m, p, { body, ...opt });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthenticated");
      expect(r.headers["www-authenticate"]).toMatch(/^Bearer /);
    }
  });
  it("refuses a token signed by a key that is not configured, a wrong kid, aud, iss, sub, a missing jti and a lifetime over 60 s", async () => {
    const w = world();
    const cases = [
      await serviceToken({ key: other.privateKey }), await serviceToken({ kid: "hfy-chat-2" }), await serviceToken({ aud: "hfy-api/other" }),
      await serviceToken({ iss: "someone" }), await serviceToken({ sub: "chat-other" }), await serviceToken({ jti: null }), await serviceToken({ life: 61 }),
      await serviceToken({ iat: Math.floor(Date.now() / 1000) - 600, life: 60 }), // expired
    ];
    for (const token of cases) expect((await w.svc("GET", "/api/chat/directory", { token })).status).toBe(401);
    expect((await w.svc("GET", "/api/chat/directory", { token: await serviceToken({ life: 60 }) })).status).toBe(200);
  });
  it("refuses a non-ES256 algorithm (HS256, none) even with the right claims", async () => {
    const w = world();
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "hfy-chat-1" }).setIssuer(CHAT_ISSUER).setAudience(CHAT_AUDIENCE).setSubject(CHAT_SUBJECT).setIssuedAt().setExpirationTime("1m").setJti("x").sign(new TextEncoder().encode("0".repeat(32)));
    expect((await w.svc("GET", "/api/chat/directory", { token: hs })).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","kid":"hfy-chat-1"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: CHAT_ISSUER, aud: CHAT_AUDIENCE, sub: CHAT_SUBJECT, exp: 9999999999, iat: 1, jti: "x" })).toString("base64url")}.`;
    expect((await w.svc("GET", "/api/chat/directory", { token: none })).status).toBe(401);
  });
  it("ChatServicePublicKeys empty (RG-3): no token is 401, and a token signed by a key that is not configured is 401 too", async () => {
    for (const keys of ["", "  ", "[]", "not json", '[{"kid":"x"}]']) {
      const w = world({ keys });
      expect((await w.svc("GET", "/api/chat/directory", { token: null })).status).toBe(401);
      expect((await w.svc("GET", "/api/chat/directory", { token: await serviceToken() })).status).toBe(401);
      expect((await w.svc("POST", "/api/chat/push", { body: { items: [{ recipient: PEER, conv: DM, seq: 1, actor: MEMBER }] } })).status).toBe(401);
      expect((await w.svc("POST", "/api/chat/archive", { body: {} })).status).toBe(401);
    }
  });
  it("a future iat is refused, and a token is not single-use (replay is bounded by its 60 s life, as chat.md 14.2 has it)", async () => {
    const w = world();
    const token = await serviceToken();
    const push = () => w.svc("POST", "/api/chat/push", { token, body: { items: [{ recipient: PEER, conv: DM, seq: 1, actor: MEMBER }] } });
    expect((await push()).status).toBe(200);
    expect((await push()).status).toBe(200); // no replay cache: the hub retries safely and dedupes a push by (conv, seq)
    const future = await serviceToken({ iat: Math.floor(Date.now() / 1000) + 30 });
    expect((await w.svc("GET", "/api/chat/directory", { token: future })).status).toBe(401);
  });
  it("a malformed ChatServicePublicKeys value is a 401 and never a throw", async () => {
    for (const keys of ["not json", "{}", '[{"kid":"hfy-chat-1","spki":"AAAA"}]', '[{"kid":1}]']) {
      const w = world({ keys });
      expect((await w.svc("GET", "/api/chat/directory")).status).toBe(401);
    }
  });
  it("the directory fails closed when the ALLOW# scan hits its bound, and a strict reader throws on a table failure", async () => {
    const { scanAllowSubs } = await import("../src/chat.js");
    const { createCompositeMemberReader } = await import("../src/allowlist-store.js");
    const ddb = { send: async () => ({ Items: [], LastEvaluatedKey: { PK: "x" } }) };
    await expect(scanAllowSubs(ddb, { ScanCommand: class { constructor(i) { Object.assign(this, i); } } }, "t")).rejects.toThrow(/bound/);
    const down = { send: async () => { throw new Error("boom"); } };
    const cmds = { QueryCommand: class { constructor(i) { Object.assign(this, i); } } };
    const quiet = { error() {} };
    const read = async () => new Map([["a@example.test", { sub: MEMBER }]]);
    expect(await createCompositeMemberReader({ readEntries: read, ddb: down, cmds, table: "t", log: quiet })(MEMBER)).not.toBeNull();
    await expect(createCompositeMemberReader({ readEntries: read, ddb: down, cmds, table: "t", log: quiet, strict: true })(MEMBER)).rejects.toThrow("boom");
  });
  it("two keys allow rotation: either signs", async () => {
    const both = JSON.stringify([{ kid: "hfy-chat-1", spki: main.spki }, { kid: "hfy-chat-2", spki: other.spki }]);
    const w = world({ keys: both });
    expect((await w.svc("GET", "/api/chat/directory", { token: await serviceToken() })).status).toBe(200);
    expect((await w.svc("GET", "/api/chat/directory", { token: await serviceToken({ key: other.privateKey, kid: "hfy-chat-2" }) })).status).toBe(200);
  });
  it("a service token opens no session route, and a session cookie opens no service route", async () => {
    const w = world();
    expect((await w.svc("GET", "/api/me", {})).status).toBe(401);
    const session = await signToken(MEMBER);
    for (const [m, p, body] of [["GET", "/api/chat/directory"], ["POST", "/api/chat/push", { items: [{ recipient: PEER, conv: DM, seq: 1, actor: MEMBER }] }], ["POST", "/api/chat/archive", {}]]) {
      expect((await w.call(m, p, { token: session, body })).status).toBe(401);
    }
  });
  it("parseServiceKeys accepts base64 DER and PEM, and refuses a non-P-256 key", async () => {
    expect(parseServiceKeys(KEYS).map((k) => k.kid)).toEqual(["hfy-chat-1"]);
    expect(parseServiceKeys(JSON.stringify([{ kid: "k", spki: await exportSPKI(main.publicKey) }]))).toHaveLength(1);
    const { publicKey } = await generateKeyPair("ES384");
    expect(() => parseServiceKeys(JSON.stringify([{ kid: "k", spki: "x" }]))).toThrow();
    const p384 = await b64(publicKey);
    expect(() => parseServiceKeys(JSON.stringify([{ kid: "k", spki: p384 }]))).toThrow(/ES256/);
  });
});

describe("GET /api/chat/directory (AC4)", () => {
  it("lists the unique allowlist ids with resolveLabel labels, never an email, and drops ids that are not id-shaped", async () => {
    const w = world();
    const r = await w.svc("GET", "/api/chat/directory");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.version).toBe(1);
    expect(Number.isNaN(Date.parse(r.body.generated_at))).toBe(false);
    expect(r.body.members).toEqual([{ id: MEMBER, label: "Alex Example" }, { id: PEER, label: "Blake Example" }, { id: "I9003", label: "I9003" }, { id: "I9004", label: "I9004" }]);
    expect(JSON.stringify(r.body)).not.toMatch(/@/);
  });
  it("goes through the composite reader: a DynamoDB revoke removes a file member and a DynamoDB grant adds one", async () => {
    const w = world();
    const put = (Item) => w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item }));
    await put({ PK: "ALLOW#b@example.test", SK: "META", GSI1PK: `ALLOWSUB#${PEER}`, GSI1SK: "ALLOW#b@example.test", entity: "allow", sub: PEER, state: "revoked", source: "admin", at: "t", by: "x" });
    await put({ PK: "ALLOW#new@example.test", SK: "META", GSI1PK: "ALLOWSUB#I9004", GSI1SK: "ALLOW#new@example.test", entity: "allow", sub: "I9004", state: "active", source: "admin", at: "t", by: "x" });
    await put({ PK: "ALLOW#gone@example.test", SK: "META", GSI1PK: "ALLOWSUB#I9005", GSI1SK: "ALLOW#gone@example.test", entity: "allow", sub: "I9005", state: "revoked", source: "admin", at: "t", by: "x" });
    const ids = (await w.svc("GET", "/api/chat/directory")).body.members.map((m) => m.id);
    expect(ids).toEqual([MEMBER, "I9003", "I9004"]);
  });
  it("caches for 5 minutes in memory, then re-reads", async () => {
    let reads = 0;
    let t = 1_900_000_000_000;
    const w = world({ clock: () => t, entries: () => { reads += 1; return ENTRIES; } });
    await w.svc("GET", "/api/chat/directory");
    const first = reads;
    expect(first).toBeGreaterThan(0);
    t += 299_000;
    await w.svc("GET", "/api/chat/directory");
    expect(reads).toBe(first);
    t += 2_000; // past 5 minutes
    await w.svc("GET", "/api/chat/directory");
    expect(reads).toBeGreaterThan(first);
  });
  it("is 503 unavailable when the allowlist is unreadable (fail closed), and a later success recovers", async () => {
    let down = true;
    const w = world({ entries: () => { if (down) throw new Error("s3 down"); return ENTRIES; } });
    const r = await w.svc("GET", "/api/chat/directory");
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("unavailable");
    down = false;
    expect((await w.svc("GET", "/api/chat/directory")).status).toBe(200);
  });
});

describe("POST /api/chat/push (AC2, AC3)", () => {
  const item = (o = {}) => ({ recipient: PEER, conv: DM, seq: 7, actor: MEMBER, ...o });

  it("sends the push in-process to a recipient who turned chat texts on: title, navigate, conv and seq only for dedupe, never message text", async () => {
    const w = world();
    await subscribe(w, PEER);
    await prefs(w, PEER, true, 0);
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: 1, skipped: 0 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload).toEqual({
      web_push: 8030,
      notification: { title: "Harrison Family", body: "you have a new chat message.", navigate: "/chat/?c=dm%3AI9001%3AI9002", data: { conv: DM, seq: 7 } },
    });
    expect(JSON.stringify(w.sent[0].payload)).not.toMatch(/Alex|Example/); // level 0 names nobody
    expect(w.sent[0].payload.notification.app_badge).toBeUndefined(); // no badge: the notifications domain owns it
    expect(r.headers["cache-control"]).toBe("no-store");
  });
  it("de-duplicates (recipient, conv, seq) within a batch so a hub retry cannot double-notify", async () => {
    const w = world();
    await subscribe(w, PEER);
    await prefs(w, PEER, true);
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item(), item(), item({ seq: 8 })] } });
    expect(r.body.sent).toBe(2);
    expect(w.sent).toHaveLength(2);
  });
  it("contract: the settings page's PUT shape (types/level) reaches the server check (features/detail)", async () => {
    const w = world();
    const token = await signToken(PEER);
    await subscribe(w, PEER);
    await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
    expect(w.sent).toHaveLength(0); // default off
    const put = await w.call("PUT", "/api/notifications/preferences", { token, body: { enabled: true, types: { chat_message: { enabled: true, level: 1 } } } });
    expect(put.status).toBe(200);
    const stored = await w.preferences.get(PEER);
    expect(stored.features.chat_message).toMatchObject({ enabled: true, detail: 1 });
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
    expect(r.body.sent).toBe(1);
    expect(w.sent[0].payload.notification.body).toBe("Alex Example sent you a chat message.");
  });
  it("level 1 names the actor by label, still no message text", async () => {
    const w = world();
    await subscribe(w, PEER);
    await prefs(w, PEER, true, 1);
    await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
    expect(w.sent[0].payload.notification.body).toBe("Alex Example sent you a chat message.");
  });
  it("chat texts default OFF (CHAT-D12): no preference, a disabled one, or no device sends nothing", async () => {
    const w = world();
    await subscribe(w, PEER);
    await subscribe(w, "I9003");
    await prefs(w, "I9003", false);
    await subscribe(w, "I9004");
    await prefs(w, "I9004", true);
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item(), item({ recipient: "I9003" }), item({ recipient: "I9005" })] } });
    expect(r.body).toEqual({ sent: 0, skipped: 3 });
    expect(w.sent).toEqual([]);
    expect((await w.svc("POST", "/api/chat/push", { body: { items: [item({ recipient: "I9004" })] } })).body.sent).toBe(1);
  });
  it("skips a recipient the allowlist no longer counts, even with chat texts on", async () => {
    const w = world({ entries: new Map([["a@example.test", { sub: MEMBER }]]) });
    await subscribe(w, PEER);
    await prefs(w, PEER, true);
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
    expect(r.body).toEqual({ sent: 0, skipped: 1 });
    expect(w.sent).toEqual([]);
  });
  it("never writes an inbox item (inbox:false) and skips an item whose recipient is its own actor", async () => {
    const w = world();
    await subscribe(w, PEER);
    await prefs(w, PEER, true);
    await subscribe(w, MEMBER);
    await prefs(w, MEMBER, true);
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item({ recipient: MEMBER }), item()] } });
    expect(r.body).toEqual({ sent: 1, skipped: 1 });
    expect(w.ddb.all().some((x) => x.PK.startsWith("INBOX#"))).toBe(false);
  });
  it("answers {sent:0, disabled:true} without VAPID", async () => {
    const w = world({ withPush: false });
    const r = await w.svc("POST", "/api/chat/push", { body: { items: [item(), item({ seq: 8 })] } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: 0, skipped: 2, disabled: true });
  });
  it("is 400 validation for a bad shape, a non-id recipient or actor, a bad conv or seq, and more than 50 items", async () => {
    const w = world();
    const bad = [
      {}, { items: [] }, { items: "x" }, { items: [item({ recipient: "a b" })] }, { items: [item({ actor: "x@example.test" })] }, { items: [item({ conv: "dm:I9001" })] },
      { items: [item({ conv: "x:I9001:I9002" })] }, { items: [item({ seq: 1.5 })] }, { items: [item({ seq: 0 })] }, { items: [item({ seq: "7" })] }, { items: [null] },
      { items: Array.from({ length: 51 }, (_, i) => item({ seq: i + 1 })) },
    ];
    for (const body of bad) {
      const r = await w.svc("POST", "/api/chat/push", { body });
      expect([r.status, r.body.error]).toEqual([400, "validation"]);
    }
    expect((await w.svc("POST", "/api/chat/push", { body: { items: Array.from({ length: 50 }, (_, i) => item({ seq: i + 1 })) } })).status).toBe(200);
  });
  it("415 for a non-JSON content type, after the service token passes", async () => {
    const w = world();
    expect((await w.call("POST", "/api/chat/push", { ct: "text/plain", headers: bearer(await serviceToken()), body: {} })).status).toBe(415);
  });
  it("a session cookie alone is refused on the push route, even for an admin", async () => {
    const w = world();
    await subscribe(w, PEER);
    await prefs(w, PEER, true);
    const r = await w.call("POST", "/api/chat/push", { token: await signToken("I0099"), body: { items: [item()] } });
    expect(r.status).toBe(401);
    expect(w.sent).toEqual([]);
  });

  describe("every chat_message push shows a notification (iOS revokes silent pushes)", () => {
    it("assertShowsNotification rejects a payload without a title, without navigate, a silent one, or one carrying text", () => {
      const ok = { web_push: 8030, notification: { title: "Harrison Family", body: "x", navigate: "/chat/?c=a" } };
      expect(assertShowsNotification(ok)).toBe(ok);
      for (const n of [{ body: "x", navigate: "/chat/" }, { title: "", navigate: "/chat/" }, { title: "  ", navigate: "/chat/" }, { title: "t" }, { title: "t", navigate: "//evil.example" }, { title: "t", navigate: "/chat/", silent: true }, { title: "t", navigate: "/chat/", data: { text: "hi" } }]) {
        expect(() => assertShowsNotification({ web_push: 8030, notification: n })).toThrow();
      }
      expect(() => assertShowsNotification({ notification: ok.notification })).toThrow();
      expect(() => assertShowsNotification(undefined)).toThrow();
    });
    it("the registry entry has a title, and buildChatPush output always passes the check", () => {
      expect(TEMPLATE_REGISTRY.features.chat_message.title).toBeTruthy();
      expect(TEMPLATE_REGISTRY.features.chat_message.inbox).toBe(false);
      const p = buildChatPush({ prefs: { features: { chat_message: { enabled: true, detail: 0 } } }, conv: GROUP, seq: 3 });
      expect(p.notification.title).toBe("Harrison Family");
      expect(p.notification.navigate).toBe(chatPath(GROUP));
      expect(buildChatPush({ prefs: { features: {} }, conv: GROUP, seq: 3 })).toBeNull();
      expect(buildChatPush({ prefs: { features: { chat_message: { enabled: false, detail: 0 } } }, conv: GROUP, seq: 3 })).toBeNull();
    });
    it("a registry entry whose title is blanked sends nothing", async () => {
      const f = TEMPLATE_REGISTRY.features.chat_message;
      const title = f.title;
      f.title = "";
      try {
        const w = world();
        await subscribe(w, PEER);
        await prefs(w, PEER, true);
        const r = await w.svc("POST", "/api/chat/push", { body: { items: [item()] } });
        expect(r.status).toBe(200);
        expect(r.body.sent).toBe(0);
        expect(w.sent).toEqual([]);
      } finally {
        f.title = title;
      }
    });
  });
});

describe("POST /api/chat/archive (AC1, AC6)", () => {
  const body = (o = {}) => ({
    conv: { id: GROUP, kind: "group", name: "cousins", creator: MEMBER, policy: "private", created_at: 1760000000000, last_seq: 3, ...(o.conv ?? {}) },
    members: o.members ?? [
      { uid: MEMBER, epoch: 1, join_seq: 1, left_seq: null, invited_by: null },
      { uid: PEER, epoch: 1, join_seq: 1, left_seq: 3, invited_by: MEMBER },
      { uid: PEER, epoch: 2, join_seq: 5, left_seq: null, invited_by: MEMBER },
    ],
    msgs: o.msgs ?? [
      { seq: 1, cmid: "01JCCMID01", from: MEMBER, kind: "sys", sys: { op: "created", members: [PEER] }, ts: 1760000000001 },
      { seq: 2, cmid: "01JCCMID02", from: MEMBER, kind: "msg", text: "synthetic hello", ts: 1760000000002 },
      { seq: 3, cmid: "01JCCMID03", from: PEER, kind: "msg", text: "synthetic reply", ts: 1760000000003 },
    ],
  });
  const rowsOf = (w) => w.ddb.all().filter((r) => r.PK.startsWith("CHAT#"));

  it("stores META, E# and M# items with the documented keys, no ttl and no GSI1 attributes", async () => {
    const w = world();
    const r = await w.svc("POST", "/api/chat/archive", { body: body() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stored: 3, through_seq: 3 });
    const rows = rowsOf(w);
    expect(rows.map((x) => x.SK).sort()).toEqual([`E#${MEMBER}#0001`, `E#${PEER}#0001`, `E#${PEER}#0002`, "M#0000000001", "M#0000000002", "M#0000000003", "META"].sort());
    expect(new Set(rows.map((x) => x.PK))).toEqual(new Set([`CHAT#${GROUP}`]));
    for (const row of rows) {
      expect(Object.keys(row).filter((k) => k === "ttl" || k.startsWith("GSI"))).toEqual([]);
    }
    const meta = rows.find((x) => x.SK === "META");
    expect(meta).toMatchObject({ entity: "chat_conv", kind: "group", name: "cousins", creator: MEMBER, policy: "private", created_at: 1760000000000, last_seq: 3 });
    expect(typeof meta.archived_at).toBe("number");
    expect(rows.find((x) => x.SK === `E#${PEER}#0001`)).toMatchObject({ entity: "chat_member", join_seq: 1, left_seq: 3, invited_by: MEMBER });
    expect(rows.find((x) => x.SK === `E#${MEMBER}#0001`).left_seq).toBeUndefined();
    expect(rows.find((x) => x.SK === "M#0000000002")).toMatchObject({ entity: "chat_msg", seq: 2, cmid: "01JCCMID02", from: MEMBER, kind: "msg", text: "synthetic hello", ts: 1760000000002 });
    expect(rows.find((x) => x.SK === "M#0000000001").sys).toEqual({ op: "created", members: [PEER] });
  });
  it("is idempotent: a replay changes nothing, an older replay never regresses META, a closed epoch is never reopened", async () => {
    const w = world();
    await w.svc("POST", "/api/chat/archive", { body: body() });
    const before = JSON.stringify(rowsOf(w).map((x) => ({ ...x, archived_at: 0 })).sort((a, b) => a.SK.localeCompare(b.SK)));
    const again = await w.svc("POST", "/api/chat/archive", { body: body() });
    expect(again.body).toEqual({ stored: 0, through_seq: 3 }); // M# is write-once: the count is what was written
    expect(JSON.stringify(rowsOf(w).map((x) => ({ ...x, archived_at: 0 })).sort((a, b) => a.SK.localeCompare(b.SK)))).toBe(before);
    // a stale retry from before the member left
    await w.svc("POST", "/api/chat/archive", { body: body({ conv: { last_seq: 1, name: "old name" }, members: [{ uid: PEER, epoch: 1, join_seq: 1, left_seq: null, invited_by: MEMBER }], msgs: [] }) });
    const rows = rowsOf(w);
    expect(rows.find((x) => x.SK === "META")).toMatchObject({ last_seq: 3, name: "cousins" });
    expect(rows.find((x) => x.SK === `E#${PEER}#0001`).left_seq).toBe(3);
    // a message keeps its first write
    await w.svc("POST", "/api/chat/archive", { body: body({ msgs: [{ seq: 2, cmid: "01JCCMID02", from: MEMBER, kind: "msg", text: "changed", ts: 1 }] }) });
    expect(rowsOf(w).find((x) => x.SK === "M#0000000002").text).toBe("synthetic hello");
  });
  it("a newer batch advances META and closes an epoch", async () => {
    const w = world();
    await w.svc("POST", "/api/chat/archive", { body: body() });
    await w.svc("POST", "/api/chat/archive", { body: body({ conv: { last_seq: 4, name: "cousins 2" }, members: [{ uid: MEMBER, epoch: 1, join_seq: 1, left_seq: 4, invited_by: null }], msgs: [{ seq: 4, cmid: "01JCCMID04", from: MEMBER, kind: "sys", sys: { op: "left" }, ts: 5 }] }) });
    const rows = rowsOf(w);
    expect(rows.find((x) => x.SK === "META")).toMatchObject({ last_seq: 4, name: "cousins 2" });
    expect(rows.find((x) => x.SK === `E#${MEMBER}#0001`).left_seq).toBe(4);
    expect(rows.filter((x) => x.SK.startsWith("M#"))).toHaveLength(4);
  });
  it("a DM archives under its canonical id, and a batch with no messages reports through_seq 0", async () => {
    const w = world();
    const r = await w.svc("POST", "/api/chat/archive", { body: { conv: { id: DM, kind: "dm", name: null, creator: MEMBER, policy: null, created_at: 1760000000000, last_seq: 0 }, members: [], msgs: [] } });
    expect(r.body).toEqual({ stored: 0, through_seq: 0 });
    expect(rowsOf(w).map((x) => x.PK)).toEqual([`CHAT#${DM}`]);
  });
  it("is 400 for a member whose left_seq is below join_seq", async () => {
    const w = world();
    const r = await w.svc("POST", "/api/chat/archive", { body: body({ members: [{ uid: PEER, epoch: 1, join_seq: 5, left_seq: 2, invited_by: null }] }) });
    expect(r.status).toBe(400);
  });
  it("writes META last, so a failure part-way never leaves last_seq ahead of the messages", async () => {
    const w = world();
    const real = w.ddb.send.bind(w.ddb);
    const order = [];
    w.ddb.send = async (c) => { if (c.input?.Item) order.push(c.input.Item.SK); return real(c); };
    expect((await w.svc("POST", "/api/chat/archive", { body: body() })).status).toBe(200);
    expect(order[order.length - 1]).toBe("META");
  });
  it("is 400 for a message seq above conv.last_seq", async () => {
    const w = world();
    const r = await w.svc("POST", "/api/chat/archive", { body: body({ conv: { last_seq: 2 } }) });
    expect(r.status).toBe(400);
  });
  it("is 400 validation for an id not shaped dm:/g:, a kind that disagrees, text over 4,000 bytes, a non-integer seq and more than 100 messages", async () => {
    const w = world();
    const msg = (o = {}) => ({ seq: 1, cmid: "01JCCMID01", from: MEMBER, kind: "msg", text: "x", ts: 1, ...o });
    const bad = [
      body({ conv: { id: "room:1" } }), body({ conv: { id: "dm:I9001" } }), body({ conv: { id: DM, kind: "group" } }), body({ conv: { kind: "dm" } }), body({ conv: { policy: "secret" } }),
      body({ conv: { last_seq: "3" } }), body({ conv: { created_at: -1 } }),
      body({ msgs: [msg({ text: "é".repeat(2001) })] }), body({ msgs: [msg({ seq: 1.5 })] }), body({ msgs: [msg({ seq: "1" })] }), body({ msgs: [msg({ seq: 0 })] }),
      body({ msgs: [msg({ kind: "other" })] }), body({ msgs: [msg({ from: "x@example.test" })] }), body({ msgs: [msg({ cmid: "a b" })] }), body({ msgs: [msg({ sys: [] })] }),
      body({ msgs: Array.from({ length: 101 }, (_, i) => msg({ seq: i + 1, cmid: `c${i}` })) }),
      body({ members: [{ uid: "a b", epoch: 1, join_seq: 1 }] }), body({ members: [{ uid: MEMBER, epoch: 0, join_seq: 1 }] }), body({ members: [{ uid: MEMBER, epoch: 1, join_seq: 1, left_seq: 1.5 }] }),
      { conv: body().conv, members: "x", msgs: [] }, { conv: body().conv, members: [], msgs: {} }, {},
    ];
    for (const b of bad) {
      const r = await w.svc("POST", "/api/chat/archive", { body: b });
      expect([r.status, r.body.error]).toEqual([400, "validation"]);
    }
    expect(rowsOf(w)).toEqual([]);
    const full = body({ msgs: Array.from({ length: 100 }, (_, i) => msg({ seq: i + 1, cmid: `c${i}` })) });
    full.conv.last_seq = 100;
    const ok = await w.svc("POST", "/api/chat/archive", { body: full });
    expect(ok.body).toEqual({ stored: 100, through_seq: 100 });
    expect(parseArchive(body()).msgs).toHaveLength(3);
  });
  it("a partial batch: META.last_seq is the conversation head, through_seq is the archived-through mark", async () => {
    const w = world();
    const msg = (o) => ({ seq: 1, cmid: "01JCCMID01", from: MEMBER, kind: "msg", text: "x", ts: 1, ...o });
    const part = body({ msgs: [msg({ seq: 1, cmid: "c1" }), msg({ seq: 2, cmid: "c2" })] });
    part.conv.last_seq = 500;
    const r = await w.svc("POST", "/api/chat/archive", { body: part });
    expect(r.body).toEqual({ stored: 2, through_seq: 2 });
    expect(rowsOf(w).find((x) => x.SK === "META").last_seq).toBe(500);
  });
  it("accepts text of exactly 4,000 bytes", async () => {
    const w = world();
    const r = await w.svc("POST", "/api/chat/archive", { body: body({ msgs: [{ seq: 1, cmid: "c1", from: MEMBER, kind: "msg", text: "a".repeat(4000), ts: 1 }] }) });
    expect(r.status).toBe(200);
  });
  it("is 503 unavailable when the table write fails, with nothing about the cause in the body", async () => {
    let fail = false;
    const w = makeApi({
      intercept: async (cmd) => { if (fail && cmd.constructor.name === "PutCommand") throw Object.assign(new Error("secret table detail"), { name: "ProvisionedThroughputExceededException" }); },
      extraDeps: { authenticateService: createServiceAuthenticator({ getKeys: () => KEYS }), readEntries: async () => ENTRIES },
    });
    fail = true;
    const r = await w.call("POST", "/api/chat/archive", { headers: bearer(await serviceToken()), body: body() });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toMatch(/secret/);
  });
});
