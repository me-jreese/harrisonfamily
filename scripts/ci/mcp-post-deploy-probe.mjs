#!/usr/bin/env node
// HFY-TSK-413 (AC3): the post-deploy MCP probe for https://harrisonfamily.us/mcp. It runs the fleet probe's checks that matter for this
// connector without the kit package (the repo's CI has no CodeArtifact read role): C01 and C02 discovery, C06 and C09 the 401 challenge,
// C13 registration refuses a foreign callback, C14 sign-in reaches the login page for every supported client (claude.ai and claude.com,
// both Cursor callbacks, loopback at any port) and refuses a foreign callback, C16 `x-io-kit-mcp` equals the pinned kit version.
// The kit's own `mcp-fleet probe --fleet scripts/ci/mcp-fleet.json --connector harrisonfamily --strict` is the authoritative run (operator shell).
// Usage: node scripts/ci/mcp-post-deploy-probe.mjs [--base https://harrisonfamily.us] [--expect-version 0.3.0] [--attempts 6] [--interval 30]
// Exit 0 = every check passed; 1 = a check failed after the last attempt; 2 = usage.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLIENT_ID = "mcp-harrisonfamily";
// The challenge is a fixed S256 challenge, as in the kit probe: no code is ever exchanged.
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
export const CLIENTS = {
  "claude.ai": "https://claude.ai/api/mcp/auth_callback",
  "claude.com": "https://claude.com/api/mcp/auth_callback",
  "cursor (web)": "https://www.cursor.com/agents/mcp/oauth/callback",
  "cursor (app)": "cursor://anysphere.cursor-mcp/oauth/callback",
  "loopback localhost": "http://localhost:8787/callback",
  "loopback 127.0.0.1": "http://127.0.0.1:53682/callback",
  "loopback [::1]": "http://[::1]:8080/callback",
};
export const REFUSED = {
  "foreign https": "https://evil.example/cb",
  "localhost lookalike": "http://localhost.evil.example:8787/callback",
  "localhost userinfo": "http://localhost@evil.example/callback",
  "https loopback": "https://localhost:8787/callback",
};

/** The pinned @io-kit/mcp version in api/package.json: what `x-io-kit-mcp` must equal. */
export const pinnedVersion = () => JSON.parse(readFileSync(fileURLToPath(new URL("../../api/package.json", import.meta.url)), "utf8")).dependencies["@io-kit/mcp"];

const asMetadataUrl = (issuer) => { const u = new URL(issuer); return `${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/$/, "")}`; };
const res = (ok, detail) => ({ ok, detail });

async function get(fetchFn, url, init = {}) {
  try {
    const r = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, json, text };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

/** Follows the authorize redirect chain by hand (the login page is at the end), up to 6 hops. Returns {final, status, bounced}. */
async function authorizeChain(fetchFn, endpoint, redirect) {
  let url = new URL(endpoint);
  url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirect, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "probe", scope: "mcp" }).toString();
  for (let hop = 0; hop <= 6; hop++) {
    const r = await get(fetchFn, url.toString());
    if (r.error) return { error: r.error };
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { error: "redirect without location" };
      let next;
      try { next = new URL(loc, url); } catch { return { error: `unparseable location ${loc}` }; }
      if (next.searchParams.get("error")) return { status: r.status, error: `error=${next.searchParams.get("error")}` };
      if (next.protocol !== url.protocol && next.protocol !== "https:" && next.protocol !== "http:") return { status: r.status, bounced: true };
      if (next.origin !== url.origin && next.origin === new URL(redirect).origin) return { status: r.status, bounced: true };
      url = next;
      continue;
    }
    return { status: r.status, final: url.toString() };
  }
  return { error: "more than 6 redirects" };
}

/** Runs every check once. Returns { checks: { C01: {ok, detail}, ... }, ok }. */
export async function probeOnce({ base = "https://harrisonfamily.us", expectVersion = pinnedVersion(), fetch: fetchFn = fetch } = {}) {
  base = base.replace(/\/$/, "");
  const mcpUrl = `${base}/mcp`;
  const out = {};
  // C01: PRM on both paths names the resource
  const bad = [];
  let prm = null, prmHeaders = null;
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await get(fetchFn, base + p);
    if (r.error) { bad.push(`${p}: ${r.error}`); continue; }
    if (r.status !== 200 || !r.json) { bad.push(`${p}: ${r.status}`); continue; }
    prm ??= r.json; prmHeaders ??= r.headers;
    if (String(r.json.resource).replace(/\/$/, "") !== mcpUrl) bad.push(`${p}: resource=${r.json.resource}`);
  }
  out.C01 = res(!bad.length, bad.join("; ") || "ok");
  // C02: the authorization server it names
  const as0 = prm?.authorization_servers?.[0];
  const a = as0 ? await get(fetchFn, asMetadataUrl(as0)) : { error: "PRM names no authorization server" };
  const s256 = a.json?.code_challenge_methods_supported?.includes("S256");
  const scopes = Array.isArray(a.json?.scopes_supported) && a.json.scopes_supported.length > 0;
  out.C02 = a.error ? res(false, a.error) : res(a.status === 200 && !!s256 && scopes, `${a.status} s256=${!!s256} scopes=${scopes}`);
  const asm = a.json ?? {};
  // C06 + C09: the 401 challenge, and the version header (C16)
  const p = await get(fetchFn, mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  if (p.error) { out.C06 = res(false, p.error); out.C09 = res(false, p.error); }
  else {
    out.C06 = res(p.status === 401 && !!p.json, `${p.status} json=${!!p.json}`);
    const wa = p.headers.get("www-authenticate") ?? "";
    out.C09 = res(/resource_metadata=/.test(wa), wa ? "www-authenticate carries resource_metadata" : "no www-authenticate header");
  }
  const seen = [prmHeaders?.get("x-io-kit-mcp"), p.headers?.get("x-io-kit-mcp")];
  out.C16 = res(seen.every((v) => v === expectVersion), `x-io-kit-mcp prm=${seen[0] ?? "absent"} 401=${seen[1] ?? "absent"} want ${expectVersion}`);
  // C13: registration refuses a callback that is not allowed
  if (!asm.registration_endpoint) out.C13 = res(false, "no registration_endpoint advertised");
  else {
    const g = await get(fetchFn, asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "fleet-probe", redirect_uris: ["https://example.invalid/cb"] }) });
    out.C13 = g.error ? res(false, g.error) : res(g.status === 400, `register -> ${g.status}`);
  }
  // C14: sign-in reaches the login page for every supported client; a foreign callback is refused with a 400 and no redirect
  if (!asm.authorization_endpoint) out.C14 = res(false, "no authorization_endpoint advertised");
  else {
    const failed = [];
    for (const [name, cb] of Object.entries(CLIENTS)) {
      const r = await authorizeChain(fetchFn, asm.authorization_endpoint, cb);
      if (r.error) failed.push(`${name}: ${r.error}`);
      else if (r.bounced) failed.push(`${name}: bounced to the client callback`);
      else if (r.status !== 200) failed.push(`${name}: final ${r.status}`);
    }
    for (const [name, cb] of Object.entries(REFUSED)) {
      const u = new URL(asm.authorization_endpoint);
      u.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: cb, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "probe" }).toString();
      const r = await get(fetchFn, u.toString());
      if (r.error) failed.push(`refuse ${name}: ${r.error}`);
      else if (r.status !== 400 || r.headers.get("location")) failed.push(`refuse ${name}: ${r.status}${r.headers.get("location") ? " with a redirect" : ""}, want 400`);
    }
    out.C14 = res(!failed.length, failed.join("; ") || `${Object.keys(CLIENTS).length} clients reach the login page, ${Object.keys(REFUSED).length} foreign callbacks refused`);
  }
  return { checks: out, ok: Object.values(out).every((c) => c.ok) };
}

export async function run(argv = process.argv.slice(2), { log = console.log, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), fetch: fetchFn = fetch } = {}) {
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const attempts = Number(opt("--attempts", 6)), interval = Number(opt("--interval", 30));
  if (!(attempts >= 1) || !(interval >= 0)) { log("usage: --attempts <n>=1.. --interval <seconds>"); return 2; }
  const cfg = { base: opt("--base", "https://harrisonfamily.us"), expectVersion: opt("--expect-version", pinnedVersion()), fetch: fetchFn };
  let last;
  for (let i = 1; i <= attempts; i++) {
    last = await probeOnce(cfg);
    for (const [id, c] of Object.entries(last.checks)) log(`[mcp-probe] attempt ${i}/${attempts} ${id} ${c.ok ? "pass" : "FAIL"}: ${c.detail}`);
    if (last.ok) return 0;
    if (i < attempts) await sleep(interval);
  }
  log(`[mcp-probe] giving up: ${Object.entries(last.checks).filter(([, c]) => !c.ok).map(([id]) => id).join(", ")} failed`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await run());
