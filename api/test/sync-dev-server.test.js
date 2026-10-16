// HFY-TSK-181 (sync-dev-harness-e2e): scripts/sync-dev-server.mjs, the local server the desktop addon and gramps/tests/e2e run against.
// The server is started in process on an ephemeral loopback port and driven with fetch. Synthetic subjects and objects only.
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeJwt } from "jose";
import { DEV_OWNER_SUB, HELP, OWNED_DIR, MEDIA_BUCKET, SYNC_BUCKET, createLocalS3, parseArgs, startDevServer } from "../scripts/sync-dev-server.mjs";
import { SYNC_CLIENT_ID } from "../src/sync/auth.js";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const b64u = (b) => Buffer.from(b).toString("base64url");
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const BIND = { dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef", tree_name_sha256: "a".repeat(64) };
const CALLBACK = "http://127.0.0.1:53682/callback";

const started = [];
const dirs = [];
async function server(opts) {
  const dev = await startDevServer(opts);
  started.push(dev);
  return dev;
}
afterEach(async () => {
  while (started.length) await started.pop().close();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** The PKCE sign-in the addon performs, minus the browser: authorize -> 302 -> code -> token. */
async function signIn(dev, { stepUp = false, resource = `${dev.origin}/api/sync`, redirect = CALLBACK } = {}) {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const state = b64u(randomBytes(12));
  const q = new URLSearchParams({
    response_type: "code", client_id: SYNC_CLIENT_ID, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256",
    state, resource, scope: "sync", ...(stepUp ? { prompt: "login", max_age: "300" } : {}),
  });
  const auth = await fetch(`${dev.origin}/auth/authorize?${q}`, { redirect: "manual" });
  return { auth, verifier, state, redirect, resource, location: auth.headers.get("location") };
}
const tokenPost = (dev, fields) => fetch(`${dev.origin}/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
async function login(dev, o = {}) {
  const s = await signIn(dev, o);
  const cb = new URL(s.location);
  const r = await tokenPost(dev, { grant_type: "authorization_code", code: cb.searchParams.get("code"), redirect_uri: s.redirect, code_verifier: s.verifier, client_id: SYNC_CLIENT_ID, resource: s.resource });
  return { ...(await r.json()), status: r.status };
}
const api = (dev, tok, method, path, { body, headers = {}, tree } = {}) =>
  fetch(`${dev.origin}/api${path}`, {
    method, headers: { ...HS, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(tree ? { "x-hfy-tree-id": tree } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
/** fetch() will not send a chosen Host header, so this one goes through node:http. */
const statusWithHost = (dev, host) => new Promise((ok, fail) => {
  http.get({ host: "127.0.0.1", port: dev.port, path: "/_dev/health", headers: { host } }, (res) => { res.resume(); ok(res.statusCode); }).on("error", fail);
});
const logLines = (dev) => readFileSync(dev.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("command line", () => {
  it("parses its options and refuses what it does not know", () => {
    expect(parseArgs(["--port", "18200", "--data-dir", "/x", "--access-ttl", "30", "--id-policy", "mint", "--keep"])).toEqual({ port: 18200, dataDir: "/x", accessTtlSeconds: 30, idPolicy: "mint", keep: true });
    for (const bad of [["--port", "x"], ["--port"], ["--id-policy", "off"], ["--access-ttl", "0"], ["--owner-sub", "a b"], ["--nope"]]) expect(() => parseArgs(bad), bad.join(" ")).toThrow();
    expect(HELP).toMatch(/usage: node api\/scripts\/sync-dev-server\.mjs/);
  });

  it("binds a loopback address only", async () => {
    await expect(startDevServer({ host: "0.0.0.0" })).rejects.toThrow(/loopback/);
    await expect(startDevServer({ host: "192.0.2.1" })).rejects.toThrow(/loopback/);
  });
});

describe("the process around the handler", () => {
  it("answers on 127.0.0.1 only to its own Host, and leaves no temp directory behind", async () => {
    const dev = await server();
    expect(dev.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${dev.origin}/_dev/health`)).status).toBe(200);
    expect(await statusWithHost(dev, "evil.example.test")).toBe(421); // a DNS-rebinding page names its own host
    expect(await statusWithHost(dev, `localhost:${dev.port}`)).toBe(200);
    const dir = dev.dataDir;
    expect(existsSync(dir)).toBe(true);
    await dev.close();
    started.pop();
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a caller-supplied data directory, uses only its own folder in it, and writes the log mode 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-test-"));
    dirs.push(dir);
    mkdirSync(join(dir, "s3"));
    writeFileSync(join(dir, "s3", "precious.txt"), "mine"); // the caller's own s3 folder and files are not the server's to touch
    writeFileSync(join(dir, "requests.jsonl"), "mine");
    const first = await server({ dataDir: dir });
    expect(first.dataDir).toBe(join(dir, OWNED_DIR));
    await first.s3.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: "media/x.jpg", Body: "x" }));
    expect(await first.s3.list(MEDIA_BUCKET)).toEqual(["media/x.jpg"]);
    expect(statSync(first.logFile).mode & 0o777).toBe(0o600);
    await first.close();
    started.pop();
    expect(existsSync(dir)).toBe(true);
    const second = await server({ dataDir: dir }); // its own store starts empty again
    expect(await second.s3.list(MEDIA_BUCKET)).toEqual([]);
    expect(readFileSync(join(dir, "s3", "precious.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "requests.jsonl"), "utf8")).toBe("mine");
  });

  it("refuses an hfy-sync-dev folder it did not make, and a log file that already holds something", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-test-"));
    dirs.push(dir);
    mkdirSync(join(dir, OWNED_DIR, "s3"), { recursive: true });
    writeFileSync(join(dir, OWNED_DIR, "s3", "precious.txt"), "mine");
    await expect(startDevServer({ dataDir: dir })).rejects.toThrow(/not a sync dev server folder/);
    expect(readFileSync(join(dir, OWNED_DIR, "s3", "precious.txt"), "utf8")).toBe("mine");

    const log = join(dir, "other.log");
    writeFileSync(log, "keep me");
    await expect(startDevServer({ logFile: log })).rejects.toThrow(/will not overwrite/);
    expect(readFileSync(log, "utf8")).toBe("keep me");
    await expect(startDevServer({ logFile: dir })).rejects.toThrow(/will not overwrite/); // a directory is not a log either
    writeFileSync(log, ""); // an empty file is fine
    const dev = await server({ logFile: log });
    await fetch(`${dev.origin}/_dev/health`);
    expect(logLines(dev)).toHaveLength(1);
  });

  it("a refused start leaves no temp directory and no flag behind", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("hfy-sync-dev-")).length;
    const flag = process.env.SYNC_API_ENABLED;
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "full.log"), "x");
    await expect(startDevServer({ logFile: join(dir, "full.log") })).rejects.toThrow();
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("hfy-sync-dev-")).length).toBe(before);
    expect(process.env.SYNC_API_ENABLED).toBe(flag);
  });

  it("SYNC_API_ENABLED is reference-counted: servers may close in any order and the original value comes back", async () => {
    const original = process.env.SYNC_API_ENABLED;
    const a = await server();
    const b = await server();
    expect(process.env.SYNC_API_ENABLED).toBe("1");
    await a.close(); // not the last one started
    started.splice(started.indexOf(a), 1);
    expect(process.env.SYNC_API_ENABLED).toBe("1"); // b is still running
    expect((await api(b, undefined, "GET", "/sync/meta")).status).toBe(401); // the gate is open: it reaches authentication, not a 404
    await b.close();
    started.splice(started.indexOf(b), 1);
    expect(process.env.SYNC_API_ENABLED).toBe(original);
    await a.close(); // closing twice changes nothing
    expect(process.env.SYNC_API_ENABLED).toBe(original);
  });

  it("refuses a declared oversize body before reading it, and drops the connection after answering", async () => {
    const dev = await server();
    const status = await new Promise((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port: dev.port, path: "/api/sync/bind", method: "POST", headers: { "content-length": String(40 * 1024 * 1024), "content-type": "application/json" } }, (res) => {
        res.resume();
        ok({ code: res.statusCode, close: res.headers.connection });
      });
      req.on("error", fail);
      req.write("{"); // one byte of a 40 MiB body: the answer must not wait for the rest
    });
    expect(status).toEqual({ code: 413, close: "close" });
    expect(logLines(dev).find((l) => l.path === "/api/sync/bind")).toMatchObject({ status: 413, error: "batch_too_large" });
  });

  it("closes a connection that stalls mid-body", async () => {
    const dev = await server({ requestTimeoutMs: 300 });
    const closed = await new Promise((ok) => {
      const sock = net.connect(dev.port, "127.0.0.1", () => {
        sock.write(`POST /api/sync/bind HTTP/1.1\r\nHost: 127.0.0.1:${dev.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
      });
      sock.resume(); // read the 408 so the close is seen
      sock.on("close", () => ok(true));
      sock.on("error", () => ok(true));
      setTimeout(() => ok(false), 3000);
    });
    expect(closed).toBe(true);
  });

  it("unknown routes are 404 and /api answers with the real handler's errors", async () => {
    const dev = await server();
    expect((await fetch(`${dev.origin}/nope`)).status).toBe(404);
    expect((await fetch(`${dev.origin}/_dev/nope`)).status).toBe(404);
    const noToken = await api(dev, undefined, "GET", "/sync/meta");
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
    expect((await api(dev, undefined, "GET", "/nothing")).status).toBe(404);
  });
});

describe("the dev authorization endpoints", () => {
  it("authorize -> code -> token gives a bearer the sync routes accept, with the dev owner and no step-up", async () => {
    const dev = await server();
    const s = await signIn(dev);
    expect(s.auth.status).toBe(302);
    const cb = new URL(s.location);
    expect(`${cb.origin}${cb.pathname}`).toBe(CALLBACK);
    expect(cb.searchParams.get("state")).toBe(s.state);
    expect(cb.searchParams.get("iss")).toBe(`${dev.origin}/auth`);
    const t = await tokenPost(dev, { grant_type: "authorization_code", code: cb.searchParams.get("code"), redirect_uri: CALLBACK, code_verifier: s.verifier, client_id: SYNC_CLIENT_ID, resource: s.resource });
    expect(t.status).toBe(200);
    const body = await t.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "sync" });
    expect(body.refresh_token).toMatch(/^hfyrt_[A-Za-z0-9_-]{43}$/);
    const claims = decodeJwt(body.access_token);
    expect(claims).toMatchObject({ iss: `${dev.origin}/auth`, aud: `${dev.origin}/api/sync`, client_id: SYNC_CLIENT_ID, token_use: "access", sub: DEV_OWNER_SUB, amr: ["pwd"] });
    const meta = await api(dev, body.access_token, "GET", "/sync/meta");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ api_version: 1, tree_id: null, bound: null, head_seq: 0, seeded: false, writes_enabled: true });
  });

  it("publishes the key that verifies its tokens", async () => {
    const dev = await server();
    const jwks = await (await fetch(`${dev.origin}/auth/.well-known/jwks.json`)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: "hfy-dev-1" });
    expect(jwks.keys[0].d).toBeUndefined();
  });

  it("prompt=login is a step-up: amr mfa and a fresh auth_time; a plain sign-in is not", async () => {
    const dev = await server();
    const plain = decodeJwt((await login(dev)).access_token);
    const up = decodeJwt((await login(dev, { stepUp: true })).access_token);
    expect(plain.amr).not.toContain("mfa");
    expect(up.amr).toContain("mfa");
    expect(Math.abs(up.auth_time - Math.floor(Date.now() / 1000))).toBeLessThan(10);
  });

  it("refuses a request it cannot trust: the redirect, the client, PKCE, state and the resource", async () => {
    const dev = await server();
    const bad = await signIn(dev, { redirect: "https://evil.example.test/callback" });
    expect(bad.auth.status).toBe(400); // never redirected to a non-loopback address
    const other = await signIn(dev, { redirect: "http://127.0.0.1:53682/elsewhere" });
    expect(other.auth.status).toBe(400);
    const wrongResource = await signIn(dev, { resource: "https://harrisonfamily.us/api/sync" });
    expect(new URL(wrongResource.location).searchParams.get("error")).toBe("invalid_target");
    const q = (extra) => new URLSearchParams({ response_type: "code", client_id: SYNC_CLIENT_ID, redirect_uri: CALLBACK, code_challenge: "A".repeat(43), code_challenge_method: "S256", state: "s", resource: `${dev.origin}/api/sync`, ...extra });
    for (const [extra, error] of [[{ client_id: "someone-else" }, "unauthorized_client"], [{ code_challenge_method: "plain" }, "invalid_request"], [{ state: "" }, "invalid_request"], [{ response_type: "token" }, "unsupported_response_type"], [{ scope: "admin" }, "invalid_scope"]]) {
      const r = await fetch(`${dev.origin}/auth/authorize?${q(extra)}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get("location")).searchParams.get("error"), JSON.stringify(extra)).toBe(error);
    }
  });

  it("a code works once, only with its verifier and redirect_uri, and only for this client", async () => {
    const dev = await server();
    const s = await signIn(dev);
    const code = new URL(s.location).searchParams.get("code");
    const ok = { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: s.verifier, client_id: SYNC_CLIENT_ID, resource: s.resource };
    const wrongVerifier = await tokenPost(dev, { ...ok, code_verifier: b64u(randomBytes(32)) });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");
    // The wrong attempt spent the code: even the right verifier fails now.
    expect((await tokenPost(dev, ok)).status).toBe(400);
    const s2 = await signIn(dev);
    const c2 = new URL(s2.location).searchParams.get("code");
    expect((await tokenPost(dev, { ...ok, code: c2, code_verifier: s2.verifier, redirect_uri: "http://127.0.0.1:1/callback" })).status).toBe(400);
    const s3 = await signIn(dev);
    const c3 = new URL(s3.location).searchParams.get("code");
    expect((await (await tokenPost(dev, { ...ok, code: c3, code_verifier: s3.verifier, client_id: "x" })).json()).error).toBe("invalid_client");
    const s4 = await signIn(dev);
    const good = await tokenPost(dev, { ...ok, code: new URL(s4.location).searchParams.get("code"), code_verifier: s4.verifier });
    expect(good.status).toBe(200);
    expect((await tokenPost(dev, { grant_type: "password", client_id: SYNC_CLIENT_ID })).status).toBe(400);
  });

  it("refresh tokens rotate; a rotated token shown again revokes the family", async () => {
    const dev = await server();
    const first = await login(dev);
    const second = await (await tokenPost(dev, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: SYNC_CLIENT_ID, resource: `${dev.origin}/api/sync` })).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(second.access_token).auth_time).toBe(decodeJwt(first.access_token).auth_time); // a refresh never renews the sign-in
    const reuse = await tokenPost(dev, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: SYNC_CLIENT_ID });
    expect((await reuse.json()).error).toBe("invalid_grant");
    // ...and the family is dead, the newest token included.
    expect((await tokenPost(dev, { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: SYNC_CLIENT_ID })).status).toBe(400);
    expect((await tokenPost(dev, { grant_type: "refresh_token", refresh_token: "hfyrt_unknown", client_id: SYNC_CLIENT_ID })).status).toBe(400);
  });

  it("an authorization code shown again is refused and revokes the family it produced", async () => {
    const dev = await server();
    const s = await signIn(dev);
    const code = new URL(s.location).searchParams.get("code");
    const fields = { grant_type: "authorization_code", code, redirect_uri: s.redirect, code_verifier: s.verifier, client_id: SYNC_CLIENT_ID, resource: s.resource };
    const first = await (await tokenPost(dev, fields)).json();
    expect(first.refresh_token).toBeTruthy();
    const again = await tokenPost(dev, fields);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
    // the refresh token the first redemption produced no longer works
    const refresh = await tokenPost(dev, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: SYNC_CLIENT_ID });
    expect(refresh.status).toBe(400);
    expect((await refresh.json()).error_description).toMatch(/revoked/);
    // a code that never produced anything (wrong verifier) revokes nothing
    const other = await login(dev);
    const s2 = await signIn(dev);
    const code2 = new URL(s2.location).searchParams.get("code");
    await tokenPost(dev, { ...fields, code: code2, code_verifier: "x".repeat(43) });
    await tokenPost(dev, { ...fields, code: code2, code_verifier: s2.verifier });
    expect((await tokenPost(dev, { grant_type: "refresh_token", refresh_token: other.refresh_token, client_id: SYNC_CLIENT_ID })).status).toBe(200);
  });

  it("the dev knobs set the access lifetime and revoke every family", async () => {
    const dev = await server({ accessTtlSeconds: 30 });
    const a = await login(dev);
    expect(a.expires_in).toBe(30);
    const patch = await fetch(`${dev.origin}/_dev/auth`, { method: "PATCH", body: JSON.stringify({ access_ttl_seconds: 120 }) });
    expect(await patch.json()).toEqual({ access_ttl_seconds: 120 });
    expect((await login(dev)).expires_in).toBe(120);
    expect((await fetch(`${dev.origin}/_dev/auth`, { method: "PATCH", body: JSON.stringify({ access_ttl_seconds: 0 }) })).status).toBe(400);
    await fetch(`${dev.origin}/_dev/auth`, { method: "PATCH", body: JSON.stringify({ revoke_all: true }) });
    expect((await tokenPost(dev, { grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: SYNC_CLIENT_ID })).status).toBe(400);
  });

  it("a token from another dev server (another key) is refused by this one", async () => {
    const one = await server();
    const two = await server();
    const foreign = (await login(two)).access_token;
    expect((await api(one, foreign, "GET", "/sync/meta")).status).toBe(401);
    expect((await api(one, await one.auth.mint(), "GET", "/sync/meta")).status).toBe(200);
  });

  it("a non-owner subject is 403 on the sync routes", async () => {
    const dev = await server();
    const r = await api(dev, await dev.auth.mint({ sub: "I9002" }), "GET", "/sync/meta");
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("not_owner");
  });
});

describe("the sync routes through the in-memory table and the directory store", () => {
  it("bind, then an empty snapshot is a gzip file in the directory, its header and hash intact", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const bind = await api(dev, tok, "POST", "/sync/bind", { body: BIND });
    expect(bind.status).toBe(200);
    const { tree_id: tree } = await bind.json();
    expect(tree).toMatch(/^[0-9a-f-]{36}$/);
    expect((await (await api(dev, tok, "GET", "/sync/meta")).json()).bound).toEqual({ dbid: BIND.dbid, fingerprint: BIND.fingerprint });
    const snap = await api(dev, tok, "GET", "/sync/snapshot", { tree });
    expect(snap.status).toBe(200);
    const s = await snap.json();
    expect(s).toMatchObject({ seq: 0, count: 0 });
    expect(s.url.startsWith(`${dev.origin}/_s3/${SYNC_BUCKET}/`)).toBe(true);
    const file = await fetch(s.url); // no Authorization: the URL is the credential
    expect(file.status).toBe(200);
    const lines = gunzipSync(Buffer.from(await file.arrayBuffer())).toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header).toMatchObject({ type: "header", tree_id: tree, seq: 0, count: 0, body_sha256: s.body_sha256 });
    expect(createHash("sha256").update("").digest("hex")).toBe(s.body_sha256);
    expect(await dev.s3.list(SYNC_BUCKET)).toEqual(expect.arrayContaining([expect.stringMatching(/^snapshots\//)]));
    expect((await api(dev, tok, "POST", "/sync/bind", { body: BIND })).status).toBe(409); // already bound
    expect((await api(dev, tok, "GET", "/sync/snapshot", { tree: "00000000-0000-4000-8000-00000000dead" })).status).toBe(403); // tree_mismatch
  });

  it("a signed-in owner pushes a batch, and the snapshot then carries the object", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const { tree_id: tree } = await (await api(dev, tok, "POST", "/sync/bind", { body: BIND })).json();
    await fetch(`${dev.origin}/_dev/head`, { method: "PATCH", body: JSON.stringify({ seeded: true, writes_enabled: true }) });
    const handle = "a".repeat(28);
    const obj = {
      _class: "Note", handle, gramps_id: "N0001", private: false, change: 0, tag_list: [],
      text: { _class: "StyledText", string: "Synthetic dev-server note", tags: [] }, type: { _class: "NoteType", string: "", value: 1 }, format: 0,
    };
    const push = await api(dev, tok, "POST", "/sync/batches", { tree, headers: { "idempotency-key": "k-1" }, body: { ops: [{ op: "create", class: "Note", handle, base_version: null, obj }] } });
    expect(push.status, JSON.stringify(await push.clone().json())).toBe(200);
    const s = await (await api(dev, tok, "GET", "/sync/snapshot", { tree })).json();
    expect(s.count).toBe(1);
    const text = gunzipSync(Buffer.from(await (await fetch(s.url)).arrayBuffer())).toString("utf8");
    expect(text).toContain("Synthetic dev-server note");
    // The same key replays the stored result; nothing is written twice.
    const again = await api(dev, tok, "POST", "/sync/batches", { tree, headers: { "idempotency-key": "k-1" }, body: { ops: [{ op: "create", class: "Note", handle, base_version: null, obj }] } });
    expect(again.status).toBe(200);
    expect((await (await api(dev, tok, "GET", "/sync/meta")).json()).head_seq).toBe(1);
  });

  it("/_dev/scrub rewrites a head in place at the same version and seq and raises the expunge epoch, so the next snapshot differs", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const { tree_id: tree } = await (await api(dev, tok, "POST", "/sync/bind", { body: BIND })).json();
    await fetch(`${dev.origin}/_dev/head`, { method: "PATCH", body: JSON.stringify({ seeded: true, writes_enabled: true }) });
    const handle = "b".repeat(28);
    const obj = {
      _class: "Note", handle, gramps_id: "N0002", private: false, change: 0, tag_list: [],
      text: { _class: "StyledText", string: "Synthetic text to scrub", tags: [] }, type: { _class: "NoteType", string: "", value: 1 }, format: 0,
    };
    const push = await api(dev, tok, "POST", "/sync/batches", { tree, headers: { "idempotency-key": "k-2" }, body: { ops: [{ op: "create", class: "Note", handle, base_version: null, obj }] } });
    expect(push.status).toBe(200);
    const first = await (await api(dev, tok, "GET", "/sync/snapshot", { tree })).json();
    const scrub = (b) => fetch(`${dev.origin}/_dev/scrub`, { method: "POST", body: JSON.stringify(b) });
    for (const bad of [{}, { class: "Nope", handle, obj }, { class: "Note", handle: "c".repeat(28), obj }, { class: "Note", handle, obj: { ...obj, handle: "d".repeat(28) } }]) {
      expect((await scrub(bad)).status, JSON.stringify(bad).slice(0, 40)).toBeGreaterThanOrEqual(400);
    }
    const scrubbed = { ...obj, text: { ...obj.text, string: "[removed]" } };
    const done = await scrub({ class: "Note", handle, obj: scrubbed });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ version: 1, seq: 1, expunge_epoch: 1 });
    const second = await (await api(dev, tok, "GET", "/sync/snapshot", { tree })).json();
    expect(second.seq).toBe(first.seq);
    expect(second.body_sha256).not.toBe(first.body_sha256);
    const text = gunzipSync(Buffer.from(await (await fetch(second.url)).arrayBuffer())).toString("utf8");
    expect(text).toContain("[removed]");
    expect(text).not.toContain("Synthetic text to scrub");
    expect(JSON.stringify(logLines(dev))).toContain("[removed]"); // the dev log records the scrub request, as it records every request
  });

  it("the head switches pause and resume writes, and refuse what they do not know", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const patch = (b) => fetch(`${dev.origin}/_dev/head`, { method: "PATCH", body: JSON.stringify(b) });
    expect((await patch({ writes_enabled: false })).status).toBe(200);
    const paused = await api(dev, tok, "POST", "/sync/sessions", { body: {} });
    expect(paused.status).toBe(503);
    expect((await paused.json()).error).toBe("sync_paused");
    expect((await (await api(dev, tok, "GET", "/sync/meta")).json()).writes_enabled).toBe(false);
    expect((await patch({ writes_enabled: true })).status).toBe(200);
    for (const bad of [{}, { seq: 5 }, { tree_id: "x" }, { writes_enabled: "yes" }, { min_client: "1.0" }]) expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await (await fetch(`${dev.origin}/_dev/state`)).json()).head).toMatchObject({ writes_enabled: true });
    expect((await patch({ min_client: "9.0.0" })).status).toBe(200);
    expect((await api(dev, tok, "GET", "/sync/meta")).status).toBe(426); // the add-on is too old for this head
  });
});

describe("blob uploads through a presigned URL", () => {
  async function presign(dev, tok, tree, bytes, over = {}) {
    const sha = createHash("sha256").update(bytes).digest();
    const r = await api(dev, tok, "POST", "/sync/media/presign", {
      tree, body: { handle: "b".repeat(28), content_type: "image/jpeg", size: bytes.length, sha256_b64: sha.toString("base64"), md5_hex: createHash("md5").update(bytes).digest("hex"), ...over },
    });
    return { r, sha: sha.toString("base64") };
  }
  async function bound(dev) {
    const tok = (await login(dev)).access_token;
    const { tree_id: tree } = await (await api(dev, tok, "POST", "/sync/bind", { body: BIND })).json();
    return { tok, tree };
  }

  it("a PUT with the signed type, length and checksum is stored under the staging key", async () => {
    const dev = await server();
    const { tok, tree } = await bound(dev);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const { r, sha } = await presign(dev, tok, tree, bytes);
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p.key).toBe(`media/.staging/${"b".repeat(28)}/${createHash("sha256").update(bytes).digest("hex")}`);
    const put = await fetch(p.upload_url, { method: "PUT", headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": sha }, body: bytes });
    expect(put.status).toBe(200);
    const head = await dev.s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: p.key, ChecksumMode: "ENABLED" }));
    expect(head).toMatchObject({ ContentLength: bytes.length, ContentType: "image/jpeg", ChecksumSHA256: sha });
    expect((await fetch(p.upload_url)).status).toBe(403); // the URL was signed for PUT, not GET
  });

  it("refuses what S3 would: a wrong type, a wrong checksum header, a body that does not hash to it, a tampered or expired URL", async () => {
    const dev = await server();
    const { tok, tree } = await bound(dev);
    const bytes = Buffer.from("not really a jpeg, but synthetic bytes");
    const { r, sha } = await presign(dev, tok, tree, bytes);
    const url = (await r.json()).upload_url;
    const good = { "content-type": "image/jpeg", "x-amz-checksum-sha256": sha };
    expect((await fetch(url, { method: "PUT", headers: { ...good, "content-type": "text/html" }, body: bytes })).status).toBe(403);
    expect((await fetch(url, { method: "PUT", headers: { ...good, "x-amz-checksum-sha256": createHash("sha256").update("other").digest("base64") }, body: bytes })).status).toBe(403);
    expect((await fetch(url, { method: "PUT", headers: good })).status).toBe(400); // an empty body is not the signed length
    const corrupt = Buffer.from(bytes);
    corrupt[0] ^= 1;
    const bad = await fetch(url, { method: "PUT", headers: good, body: corrupt });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("BadDigest");
    expect((await fetch(url.replace("size=", "size=1"), { method: "PUT", headers: good, body: bytes })).status).toBe(403);
    expect((await fetch(url.replace("/media/.staging/", "/media/.staging/x"), { method: "PUT", headers: good, body: bytes })).status).toBe(403);
    expect(await dev.s3.list(MEDIA_BUCKET)).toEqual([]);

    const clock = { t: Date.now() };
    const aged = await server({ now: () => clock.t });
    const ab = await bound(aged);
    const { r: r2, sha: sha2 } = await presign(aged, ab.tok, ab.tree, bytes);
    const u2 = (await r2.json()).upload_url;
    clock.t += 301_000; // PRESIGN_EXPIRES_SECONDS is 300
    expect((await fetch(u2, { method: "PUT", headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": sha2 }, body: bytes })).status).toBe(403);
  });
});

describe("the request log (AC3)", () => {
  it("holds every request body, grep-able as written, before the response is read", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const r = await api(dev, tok, "POST", "/sync/bind", { body: BIND });
    await r.text();
    const raw = readFileSync(dev.logFile, "utf8"); // read right after the response: the line is already there
    expect(raw).toContain('"dbid":"db-synthetic-1"');
    expect(raw).toContain(`"tree_name_sha256":"${"a".repeat(64)}"`);
    const lines = logLines(dev);
    const bind = lines.find((l) => l.path === "/api/sync/bind");
    expect(bind).toMatchObject({ method: "POST", status: 200, auth: "bearer", req_bytes: expect.any(Number), body: BIND });
    expect(bind.headers).toMatchObject({ "content-type": "application/json", "x-hfy-sync-client": "hfy_sync/0.1.0" });
    expect(bind.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
  });

  it("never holds a token, a code or a verifier; the token endpoint's body is logged as field names", async () => {
    const dev = await server();
    const s = await signIn(dev);
    const code = new URL(s.location).searchParams.get("code");
    const t = await (await tokenPost(dev, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: s.verifier, client_id: SYNC_CLIENT_ID })).json();
    await tokenPost(dev, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: SYNC_CLIENT_ID });
    await api(dev, t.access_token, "GET", "/sync/meta");
    const raw = readFileSync(dev.logFile, "utf8");
    for (const secret of [code, s.verifier, t.refresh_token, t.access_token, s.state.length ? "Bearer " : ""]) if (secret) expect(raw).not.toContain(secret);
    const tokenLine = logLines(dev).find((l) => l.path === "/auth/token");
    expect(tokenLine.body_fields).toEqual(["grant_type", "code", "redirect_uri", "code_verifier", "client_id"]);
    expect(tokenLine.body).toBeUndefined();
    expect(tokenLine.body_text).toBeUndefined();
    // The authorize request carries the PKCE challenge and state in its query, which is public by design; sig= is stripped from presigned URLs.
    expect(logLines(dev).find((l) => l.path === "/auth/authorize").query).toMatchObject({ client_id: SYNC_CLIENT_ID, code_challenge_method: "S256" });
  });

  it("holds a binary body as its size and hash only, and a refused request too", async () => {
    const dev = await server();
    const tok = (await login(dev)).access_token;
    const { tree_id: tree } = await (await api(dev, tok, "POST", "/sync/bind", { body: BIND })).json();
    const bytes = Buffer.from([0xff, 0xd8, 0, 1, 2, 3, 0xff, 0xd9]);
    const sha = createHash("sha256").update(bytes).digest("base64");
    const p = await (await api(dev, tok, "POST", "/sync/media/presign", { tree, body: { handle: "c".repeat(28), content_type: "image/jpeg", size: bytes.length, sha256_b64: sha, md5_hex: createHash("md5").update(bytes).digest("hex") } })).json();
    await fetch(p.upload_url, { method: "PUT", headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": sha }, body: bytes });
    await api(dev, tok, "POST", "/sync/bind", { body: { ...BIND, dbid: "db synthetic" } });
    const lines = logLines(dev);
    const put = lines.find((l) => l.method === "PUT");
    expect(put).toMatchObject({ status: 200, req_bytes: bytes.length, body_binary: true, body_sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(put.body).toBeUndefined();
    expect(put.query.sig).toBeUndefined();
    const refused = lines.filter((l) => l.path === "/api/sync/bind").pop();
    expect(refused).toMatchObject({ status: 400, error: "validation", body: { dbid: "db synthetic" } });
  });

  it("--log-file puts the log elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-log-"));
    dirs.push(dir);
    const dev = await server({ logFile: join(dir, "nested", "r.jsonl") });
    await fetch(`${dev.origin}/_dev/health`);
    expect(dev.logFile).toBe(join(dir, "nested", "r.jsonl"));
    expect(logLines(dev)).toHaveLength(1);
  });
});

describe("the directory standing in for S3", () => {
  it("keeps bytes, type, metadata and checksum; copies and deletes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-s3-"));
    dirs.push(dir);
    const s3 = createLocalS3(dir);
    await s3.send(new PutObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin", Body: Buffer.from([1, 2, 3]), ContentType: "application/x-test", Metadata: { n: "1" } }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin", ChecksumMode: "ENABLED" }));
    expect(head).toMatchObject({ ContentLength: 3, ContentType: "application/x-test", Metadata: { n: "1" }, ChecksumSHA256: createHash("sha256").update(Buffer.from([1, 2, 3])).digest("base64") });
    expect((await s3.send(new HeadObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin" }))).ChecksumSHA256).toBeUndefined();
    const got = await s3.send(new GetObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin", Range: "bytes=1-" }));
    expect(got.ContentRange).toBe("bytes 1-2/3");
    expect([...(await got.Body.transformToByteArray())]).toEqual([2, 3]);
    const copy = await s3.send(new CopyObjectCommand({ Bucket: "bkt.test", Key: "c.bin", CopySource: "bkt.test/a/b.bin" }));
    expect(copy.CopyObjectResult.ChecksumSHA256).toBe(head.ChecksumSHA256);
    expect(await s3.list("bkt.test")).toEqual(["a/b.bin", "c.bin"]);
    await s3.send(new DeleteObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin" }));
    await s3.send(new DeleteObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin" })); // deleting a missing key is not an error
    await expect(s3.send(new HeadObjectCommand({ Bucket: "bkt.test", Key: "a/b.bin" }))).rejects.toMatchObject({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    await expect(s3.send(new GetObjectCommand({ Bucket: "bkt.test", Key: "nope" }))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(s3.send(new CopyObjectCommand({ Bucket: "bkt.test", Key: "d", CopySource: "bkt.test/nope" }))).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("writes through <root>/tmp and renames, so listings and readers never see a partial file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-s3-"));
    dirs.push(dir);
    const s3 = createLocalS3(dir);
    await Promise.all(Array.from({ length: 8 }, (_, i) => s3.send(new PutObjectCommand({ Bucket: "bkt.test", Key: `k/${i}`, Body: Buffer.alloc(64 * 1024, i), ContentType: "application/x-test" }))));
    expect(await s3.list("bkt.test")).toEqual(Array.from({ length: 8 }, (_, i) => `k/${i}`));
    expect(readdirSync(join(dir, "tmp"))).toEqual([]); // every temporary file was renamed away
    expect((await s3.read("bkt.test", "k/3")).contentType).toBe("application/x-test");
  });

  it("refuses keys that would leave the bucket directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-dev-s3-"));
    dirs.push(dir);
    const s3 = createLocalS3(dir);
    for (const Key of ["../x", "a/../../x", "/abs", "a//b", "a/./b", "", "x\0y"]) {
      await expect(s3.send(new PutObjectCommand({ Bucket: "bkt.test", Key, Body: "x" })), JSON.stringify(Key)).rejects.toMatchObject({ name: "InvalidArgument" });
    }
    await expect(s3.send(new PutObjectCommand({ Bucket: "../escape", Key: "k", Body: "x" }))).rejects.toMatchObject({ name: "InvalidBucketName" });
    await expect(s3.send({ constructor: { name: "ListObjectsV2Command" }, input: {} })).rejects.toThrow(/unsupported/);
    expect(existsSync(join(dir, "..", "x"))).toBe(false);
  });
});
