// HFY-TSK-078 AC2: Playwright + Chromium CDP virtual authenticator against the real edge app (createAuthEdge) on http://localhost.
// Test-only wiring: the rpID is localhost (manifest override), the password provider is a stub, stores are in memory, the allowlist is a mutable object.
// Run: npx playwright install chromium && npm run e2e
import http from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { buildResolver, loadPasskeyBrowserBundle } from "@io-kit/auth/edge/deploy";
import { createIdentityService, createPasskeyService, memoryChallengeStore, memoryLinkStore, memoryPasskeyStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";

const PORT = Number(process.env.E2E_PORT ?? 4173);
const ORIGIN = `http://localhost:${PORT}`;
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const PRINCIPAL = "I0111"; // expected test principal (gramps id); the allowlist below is synthetic
const allow = { "ana@example.com": PRINCIPAL };

const m = loadManifest(JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8")), ENV);
Object.assign(m, { site: "localhost", authOrigin: ORIGIN, returnOrigins: [ORIGIN] });
delete m.cookieDomain;
m.resolver.cacheSeconds = 0;
m.session.issuer = `${ORIGIN}/auth`;
const pkProv = m.providers.find((p) => p.kind === "passkey");
Object.assign(pkProv, { rpId: "localhost", origins: [ORIGIN] });

const s = await generateKeyPair("RS256", { extractable: true });
const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
const identity = createIdentityService({
  resolver: buildResolver(m.resolver, { readObject: async () => JSON.stringify(allow) }),
  links: memoryLinkStore(),
  passwordAuth: { authenticate: async (email, pw) => { if (pw !== "e2e-test-password") throw Object.assign(new Error("bad"), { code: "AUTH_INVALID" }); return { email, emailVerified: true, idpIssuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST", idpSub: "e2e-cog-1" }; } },
  sessions: { issuer: m.session.issuer, audience: m.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
});
const passkeys = createPasskeyService({ rpID: "localhost", rpName: pkProv.rpName, origin: [ORIGIN], store: memoryPasskeyStore(), challenges: memoryChallengeStore() });
const edge = createAuthEdge({ manifest: m, identity, publicJwk: pub, passkeys, passkeyClientScript: loadPasskeyBrowserBundle(), verify: { issuers: [m.session.issuer], audiences: [m.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) } });

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const u = new URL(req.url, ORIGIN);
  const r = await edge({ rawPath: u.pathname, queryStringParameters: Object.fromEntries(u.searchParams), requestContext: { http: { method: req.method } }, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined });
  const headers = { ...r.headers };
  if (r.cookies?.length) headers["set-cookie"] = r.cookies;
  res.writeHead(r.statusCode, headers);
  res.end(r.body ?? "");
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`); };
let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${ORIGIN}/auth/login`);
  await page.waitForFunction(() => window.SimpleWebAuthnBrowser);

  // runs in the page: same-origin fetch with the kit's CSRF header, real WebAuthn ceremony through the virtual authenticator
  const api = (method, path, body) => page.evaluate(async ([method, path, body]) => {
    const r = await fetch(path, { method, credentials: "same-origin", headers: { "x-requested-with": "io-kit", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [method, path, body]);
  const ceremony = (kind, optionsJSON) => page.evaluate(async ([kind, optionsJSON]) => {
    const lib = window.SimpleWebAuthnBrowser;
    return kind === "register" ? lib.startRegistration({ optionsJSON }) : lib.startAuthentication({ optionsJSON });
  }, [kind, optionsJSON]);
  const enrol = async () => {
    const { body } = await api("POST", "/auth/passkey/register/options", {});
    const v = await api("POST", "/auth/passkey/register/verify", { response: await ceremony("register", body.options), label: "e2e" });
    return v;
  };
  const passkeySignIn = async () => {
    const { body } = await api("POST", "/auth/passkey/login/options", {});
    let response;
    try { response = await ceremony("auth", body.options); } catch (e) { return { status: 0, body: { error: String(e).slice(0, 120) } }; }
    return api("POST", "/auth/passkey/login/verify", { response });
  };
  const session = async () => (await api("GET", "/auth/session")).body;
  const amr = async () => {
    const c = (await ctx.cookies()).find((x) => x.name === "io_id");
    return c ? JSON.parse(Buffer.from(c.value.split(".")[1], "base64url").toString("utf8")).amr : null;
  };

  check("login page offers a passkey path with conditional UI", /webauthn/.test(await page.content()) && /passkey/i.test(await page.content()));
  const pw = await api("POST", "/auth/password", { email: "ana@example.com", password: "e2e-test-password" });
  check("password sign-in (test provider) -> session for the test principal", pw.status === 200 && (await session()).sub === PRINCIPAL, JSON.stringify(pw));
  const reg = await enrol();
  check("enrol a passkey (virtual authenticator, UV)", reg.status === 200 && reg.body.ok === true, JSON.stringify(reg));
  const listed = (await api("GET", "/auth/passkey/list")).body.passkeys ?? [];
  const credId = listed[0]?.id ?? listed[0]?.credentialId;
  check("credential is listed for its owner", listed.length === 1 && !!credId);
  await api("POST", "/auth/logout", {});
  check("sign out clears the session", (await session()).authenticated === false);

  const login = await passkeySignIn();
  const who = await session();
  const claims = await amr();
  check("usernameless passkey sign-in -> session sub = expected principal", login.status === 200 && who.authenticated && who.sub === PRINCIPAL, JSON.stringify({ login, who }));
  check("session amr includes passkey and mfa (UV)", Array.isArray(claims) && claims.includes("passkey") && claims.includes("mfa"), JSON.stringify(claims));

  await api("POST", "/auth/logout", {});
  allow["ana@example.com"] = undefined; delete allow["ana@example.com"];
  const denied = await passkeySignIn();
  check("allowlist removal is denied on passkey login (403) and no session is created", denied.status === 403 && (await session()).authenticated === false, JSON.stringify(denied));
  allow["ana@example.com"] = PRINCIPAL;

  const again = await passkeySignIn();
  check("back on the allowlist, the same credential signs in again", again.status === 200 && (await session()).sub === PRINCIPAL, JSON.stringify(again));
  const del = await api("DELETE", `/auth/passkey/${encodeURIComponent(credId)}`);
  await api("POST", "/auth/logout", {});
  const afterRemove = await passkeySignIn();
  check("a removed credential is rejected (401) and no session is created", del.status === 200 && afterRemove.status === 401 && (await session()).authenticated === false, JSON.stringify({ del, afterRemove }));
} catch (e) {
  check("e2e run completed", false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser?.close();
  server.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
