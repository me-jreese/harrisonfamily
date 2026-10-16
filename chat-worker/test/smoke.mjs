// Smoke test for the chat Worker (chat chat.md section 19.4). Real sockets against a running Worker:
//
//   node test/smoke.mjs --local              starts `wrangler dev --env staging` (workerd, no network, no login), runs, stops it
//   node test/smoke.mjs --local-prod        the same checks on the PRODUCTION entry (the config and entry that dist/ is built from) in
//                                            workerd, with a local JWKS and a local stand-in API on 127.0.0.1 and the production Origin
//   node test/smoke.mjs --url https://<host> runs against a deployed staging Worker; needs .staging/keys.json (npm run staging:keys)
//   node test/smoke.mjs --url https://<site> --prod    anonymous checks only (health, passthrough, no cookie, wrong Origin)
//
// It checks: health is 200 with no-store and protocol 1; a non-upgrade request is NOT answered by the hub (staging: 404, the
// Worker's own no-origin answer; production: whatever CloudFront says, never 101); an upgrade with no cookie closes 4401; a wrong
// Origin closes 4403; a test-key cookie gets `welcome`; two testers exchange a direct message over the hub; a message with a
// phone number is refused CONTACT_INFO with no text echoed. Test data only: synthetic ids, synthetic keys, no production data.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { dmConvId } from "@io-kit/chat";
import { mintSession } from "@io-kit/chat/testing";
import { KEYS_FILE, makeStagingKeys } from "../scripts/staging-keys.mjs";
import { stagingApi } from "../src/staging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const localProd = flag("--local-prod");
const ORIGIN = opt("--origin", localProd ? "https://harrisonfamily.us" : "https://chat-staging.test");
const prod = flag("--prod");

const results = [];
let failed = 0;
function ok(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` (${detail})` : ""}`);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

async function rsaKey(keys) {
  const privateKey = await webcrypto.subtle.importKey("jwk", keys.sessionPrivateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return { kid: keys.kid, privateKey, jwk: keys.jwks.keys[0] };
}

/** An io_id cookie header for a synthetic tester. */
async function cookieFor(keys, key, sub) {
  const token = await mintSession(key, { iss: keys.issuer, aud: keys.audience, nowMs: Date.now(), claims: { sub } });
  return `${keys.cookie}=${token}`;
}

/** Open a socket and collect its frames and its close. */
function openSocket(base, { origin = ORIGIN, cookie } = {}) {
  const url = `${base.replace(/^http/, "ws")}/chat/ws`;
  const headers = { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) };
  const ws = new WebSocket(url, { headers });
  const frames = [];
  const waiters = [];
  const sock = { ws, frames, closeCode: null, closed: null };
  sock.closed = new Promise((res) => {
    ws.addEventListener("close", (e) => {
      sock.closeCode = e.code;
      res(e.code);
      for (const w of waiters.splice(0)) w();
    });
    ws.addEventListener("error", () => {});
  });
  ws.addEventListener("message", (e) => {
    try { frames.push(JSON.parse(String(e.data))); } catch { /* not JSON */ }
    for (const w of waiters.splice(0)) w();
  });
  sock.opened = new Promise((res) => ws.addEventListener("open", () => res(true)));
  sock.send = (f) => ws.send(JSON.stringify(f));
  sock.next = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0];
      if (sock.closeCode !== null || Date.now() > end) return null;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
    }
  };
  return sock;
}

async function closeCodeOf(base, o) {
  const s = openSocket(base, o);
  const code = await Promise.race([s.closed, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
  try { s.ws.close(); } catch { /* already closed */ }
  return code;
}

async function run(base, keys) {
  // 1. health
  const h = await fetch(`${base}/chat/v1/health`);
  const hb = await h.json().catch(() => ({}));
  ok("health is 200", h.status === 200, `${h.status}`);
  ok("health is {ok, version, protocol: 1} and no-store", hb.ok === true && typeof hb.version === "string" && hb.protocol === 1 && /no-store/.test(h.headers.get("cache-control") ?? ""), JSON.stringify(Object.keys(hb)));
  ok("health lists nothing else", Object.keys(hb).sort().join() === "ok,protocol,version");

  // 2. a non-upgrade request is not the hub's
  const plain = await fetch(`${base}/chat/ws`, { redirect: "manual" });
  ok("a non-upgrade /chat/ws passes through (never 101, never 426)", plain.status !== 101 && plain.status !== 426 && (prod ? plain.status < 500 : plain.status === 404), `${plain.status}`);
  const other = await fetch(`${base}/chat/v1/other`, { redirect: "manual" });
  ok("another /chat/v1/ path passes through", prod ? other.status < 500 : other.status === 404, `${other.status}`);

  // 3. no cookie -> 4401; wrong Origin -> 4403
  ok("an upgrade with no cookie closes 4401", (await closeCodeOf(base, {})) === 4401);
  ok("a wrong Origin closes 4403", (await closeCodeOf(base, { origin: "https://evil.test", cookie: "io_id=x" })) === 4403);
  ok("a missing Origin closes 4403", (await closeCodeOf(base, { origin: null })) === 4403);
  if (prod) return;

  // 4. a test-key cookie gets welcome
  const key = await rsaKey(keys);
  const a = openSocket(base, { cookie: await cookieFor(keys, key, "I9001") });
  await a.opened;
  a.send({ t: "hello", v: 1, sid: "smoke-a", vis: true });
  const wa = await a.next((f) => f.t === "welcome");
  ok("a test-key cookie gets welcome", wa && wa.me === "I9001" && Array.isArray(wa.people) && wa.people.length > 1, wa ? `me=${wa.me}` : "no welcome");
  ok("a tampered cookie is refused", (await closeCodeOf(base, { cookie: `${keys.cookie}=${(await cookieFor(keys, key, "I9001")).slice(0, -6)}AAAAAA` })) === 4401);

  // 5. a direct message from I9001 to I9002 reaches I9002
  const b = openSocket(base, { cookie: await cookieFor(keys, key, "I9002") });
  await b.opened;
  b.send({ t: "hello", v: 1, sid: "smoke-b", vis: true });
  await b.next((f) => f.t === "welcome");
  const conv = dmConvId("I9001", "I9002");
  const cmid = `smoke${Date.now().toString(36)}`;
  a.send({ t: "send", conv, cmid, text: "smoke test message" });
  const ack = await a.next((f) => f.t === "ack" && f.cmid === cmid);
  const got = await b.next((f) => f.t === "msg" && f.cmid === cmid);
  ok("the sender gets an ack", !!ack && ack.seq >= 1);
  ok("the other member gets the message", !!got && got.text === "smoke test message" && got.from === "I9001");

  // 6. contact info is refused, and its text is not echoed
  const cm = `${cmid}x`;
  a.send({ t: "send", conv, cmid: cm, text: "call me on 555 010 1234" });
  const err = await a.next((f) => f.t === "err" && f.cmid === cm);
  ok("a phone number is refused CONTACT_INFO", !!err && err.code === "CONTACT_INFO", err ? err.code : "no err");
  ok("the refusal does not echo the text", !!err && !JSON.stringify(err).includes("555 010 1234"));

  a.ws.close(1000);
  b.ws.close(1000);
}

/** A local JWKS and a stand-in for hfy-api's chat routes, for the production entry (which fetches both over HTTP). */
async function sideServer(keys) {
  const api = stagingApi({ STAGING_MEMBERS: "40" });
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(keys.jwks));
    }
    const r = await api(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => server.close() };
}

async function localWorker(keys) {
  const port = await freePort();
  const persist = mkdtempSync(join(tmpdir(), "hfy-chat-smoke-"));
  const side = localProd ? await sideServer(keys) : null;
  const mode = localProd
    ? ["--var", `SESSION_ISSUER:${keys.issuer}`, "--var", `SESSION_AUDIENCE:${keys.audience}`,
      "--var", `SESSION_JWKS_URL:http://127.0.0.1:${side.port}/jwks.json`, "--var", `API_BASE:http://127.0.0.1:${side.port}/api`,
      "--var", "CHAT_OPEN_TO:all", "--var", "CHAT_PASSTHROUGH:off"]
    : ["--env", "staging", "--var", `TEST_JWKS:${JSON.stringify(keys.jwks)}`, "--var", `SESSION_ISSUER:${keys.issuer}`, "--var", `SESSION_AUDIENCE:${keys.audience}`];
  const child = spawn(
    join(root, "node_modules", ".bin", "wrangler"),
    ["dev", ...mode, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist,
      "--var", `CHAT_SERVICE_PRIVATE_KEY:${keys.servicePrivatePem}`,
      "--var", "CHAT_WORKER_VERSION:smoke-local"],
    { cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", WRANGLER_LOG_PATH: join(persist, "logs") }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } side?.close(); rmSync(persist, { recursive: true, force: true }); };
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/chat/v1/health`)).status === 200) return { base, stop }; } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`wrangler dev did not come up:\n${log.slice(-1500)}`);
}

let stop = () => {};
try {
  let keys;
  if (flag("--local") || localProd) keys = makeStagingKeys(localProd ? { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" } : {});
  else if (existsSync(KEYS_FILE)) keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  else if (!prod) throw new Error(`no ${KEYS_FILE}: run npm run staging:keys, or pass --local`);
  let base = opt("--url", "");
  if (flag("--local") || localProd) ({ base, stop } = await localWorker(keys));
  if (!base) throw new Error("pass --local, --local-prod or --url https://<host>");
  console.log(`smoke against ${localProd ? "wrangler dev, production entry (workerd, local)" : flag("--local") ? "wrangler dev --env staging (workerd, local)" : base}`);
  await run(base.replace(/\/+$/, ""), keys);
} catch (e) {
  failed++;
  console.error(`FAIL ${e.message}`);
} finally {
  stop();
}
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
