import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { buildResolver, validateManifest } from "@io-kit/auth/edge/deploy";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { parseSigningSecret } from "../src/index.js";

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const ALLOW = { "ana@example.com": "I0111", "Bo@Example.com": { gramps_id: "I0222", label: "Bo" } };
const post = (rawPath, body) => ({
  rawPath, requestContext: { http: { method: "POST" } },
  headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});
const get = (rawPath, extra = {}) => ({ rawPath, requestContext: { http: { method: "GET" } }, headers: { accept: "text/html" }, ...extra });

let edge, manifest, sessionPub, googleKey, gToken;
beforeAll(async () => {
  manifest = loadManifest(raw, ENV);
  const g = await generateKeyPair("RS256", { extractable: true });
  const s = await generateKeyPair("RS256", { extractable: true });
  googleKey = g;
  gToken = (email, extra = {}) =>
    new SignJWT({ email, email_verified: true, ...extra }).setProtectedHeader({ alg: "RS256", kid: "g1" })
      .setSubject("google-sub-1").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
  sessionPub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  const gjwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] });
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async (bucket, key) => { expect([bucket, key]).toEqual(["harrisonfamily", "config/userGrampsID.json"]); return JSON.stringify(ALLOW); } }),
    links: memoryLinkStore(),
    google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: gjwks },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
  });
  edge = createAuthEdge({ manifest, identity, publicJwk: sessionPub, verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [sessionPub] }) }, nonce: () => "n0nce" });
});

describe("manifest", () => {
  it("committed manifest validates and carries the HFY-R31/R38 values", () => {
    const m = validateManifest(raw);
    expect(m).toMatchObject({ site: "harrisonfamily.us", authOrigin: "https://harrisonfamily.us", session: { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web", profile: "installed", signingKeySecretName: "harrisonfamily/auth-edge/session-signing-key" }, resolver: { kind: "s3_allowlist", bucket: "harrisonfamily", key: "config/userGrampsID.json" }, store: { kind: "dynamodb", tableEnv: "AUTH_TABLE" } });
    expect(m.providers.map((p) => p.kind)).toEqual(["google", "password", "passkey"]);
    expect(JSON.stringify(raw)).not.toMatch(/PRIVATE KEY/);
  });
  it("loadManifest injects ids from the environment and fails closed when one is missing", () => {
    expect(manifest.idp).toMatchObject({ userPoolId: "us-west-2_TEST", clientId: "client123" });
    expect(manifest.providers[0].clientId).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(() => loadManifest(raw, { ...ENV, GOOGLE_CLIENT_ID: "" })).toThrow(/GOOGLE_CLIENT_ID/);
  });
  it("parseSigningSecret reads the JSON secret and a bare PEM", () => {
    expect(parseSigningSecret(JSON.stringify({ privateKeyPem: "PEM", kid: "k9" }), "d")).toEqual({ pem: "PEM", kid: "k9" });
    expect(parseSigningSecret("-----BEGIN-----", "d")).toEqual({ pem: "-----BEGIN-----", kid: "d" });
  });
});

describe("resolver (S3 allowlist, email -> gramps_id)", () => {
  it("hit returns the gramps_id as sub (case-insensitive), miss returns null", async () => {
    const r = buildResolver(manifest.resolver, { readObject: async () => JSON.stringify(ALLOW) });
    expect(await r("ana@example.com", { kind: "google" })).toMatchObject({ sub: "I0111" });
    expect(await r("bo@example.com", { kind: "password" })).toMatchObject({ sub: "I0222", label: "Bo" });
    expect(await r("stranger@example.com", { kind: "google" })).toBeNull();
  });
});

describe("GIS sign-in at /auth/google", () => {
  it("allowlisted email -> 200, host-only io_id cookie, session sub = gramps_id", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies ?? [];
    const id = cookies.find((c) => c.startsWith("io_id="));
    expect(id).toBeTruthy();
    expect(cookies.join("\n")).not.toMatch(/Domain=/i);
    expect(id).toMatch(/HttpOnly/i);
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const s = await edge(get("/auth/session", { headers: { cookie } }));
    expect(JSON.parse(s.body)).toMatchObject({ authenticated: true, sub: "I0111" });
    // the API verifies this exact token through the published JWKS
    const jwks = createLocalJWKSet(JSON.parse((await edge(get("/auth/.well-known/jwks.json"))).body));
    const { payload } = await jwtVerify(id.split(";")[0].slice(6), jwks, { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" });
    expect(payload.sub).toBe("I0111");
  });
  it("email not on the allowlist -> 403 not_allowlisted and no cookie", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("stranger@example.com") }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/not_allowlisted/);
    expect(res.cookies ?? []).toEqual([]);
  });
  it("wrong audience, missing header guard and bad origin are refused", async () => {
    const bad = await new SignJWT({ email: "ana@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("x").setIssuer("https://accounts.google.com").setAudience("other").setExpirationTime("10m").sign(googleKey.privateKey);
    expect((await edge(post("/auth/google", { credential: bad }))).statusCode).toBeGreaterThanOrEqual(401);
    const noHdr = post("/auth/google", { credential: "x" }); delete noHdr.headers["x-requested-with"];
    expect((await edge(noHdr)).statusCode).toBe(403);
    expect((await edge({ ...post("/auth/google", { credential: "x" }), headers: { ...post("/", {}).headers, origin: "https://evil.example" } })).statusCode).toBe(403);
  });
});

describe("session + JWKS endpoints", () => {
  it("GET /auth/.well-known/jwks.json is a public RSA key set", async () => {
    const res = await edge(get("/auth/.well-known/jwks.json"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public/);
    const { keys } = JSON.parse(res.body);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", kid: "hfy-session-1", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
    expect((await edge({ ...get("/auth/.well-known/jwks.json"), requestContext: { http: { method: "POST" } } })).statusCode).toBe(405);
  });
  it("/auth/session without a (valid) cookie is unauthenticated and uncacheable", async () => {
    for (const headers of [{}, { cookie: "io_id=garbage" }]) {
      const res = await edge(get("/auth/session", { headers }));
      expect(JSON.parse(res.body)).toEqual({ authenticated: false });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
  it("paths outside /auth are 404", async () => {
    expect((await edge(get("/login"))).statusCode).toBe(404);
  });
});

describe("session continuity under authV2 (HFY-R66): /auth/session exp + POST /auth/refresh at the /auth mount", () => {
  const pick = (res, name) => (res.cookies ?? []).find((c) => c.startsWith(`${name}=`));
  const value = (c) => c.split(";")[0];
  const refresh = (cookie, headers = {}) => edge({ ...post("/auth/refresh", {}), headers: { ...post("/", {}).headers, ...(cookie ? { cookie } : {}), ...headers } });

  it("/auth/session reports when io_id expires (the cookie is HttpOnly, so this is how a page knows to refresh early)", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    const id = value(pick(res, "io_id"));
    const { exp } = (await jwtVerify(id.slice(6), createLocalJWKSet({ keys: [sessionPub] }), { issuer: "https://harrisonfamily.us/auth" })).payload;
    const s = JSON.parse((await edge(get("/auth/session", { headers: { cookie: id } }))).body);
    expect(s).toEqual({ authenticated: true, sub: "I0111", grampsId: "I0111", label: "ana@example.com", exp });
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500); // accessTtlSeconds 3600
  });

  it("with io_id gone (the browser drops it after 1 h) the io_rt cookie alone gets a new host-only io_id and rotates io_rt", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    const rt = pick(res, "io_rt");
    expect(rt).toMatch(/Path=\/auth(;|$)/); // sent only to /auth/*, which is where /auth/refresh lives
    expect(rt).toMatch(/HttpOnly/i);
    const r = await refresh(value(rt));
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(r.body);
    expect(Number.isInteger(body.exp)).toBe(true);
    expect((r.cookies ?? []).join("\n")).not.toMatch(/Domain=/i);
    const id = pick(r, "io_id");
    expect(id).toMatch(/HttpOnly/i);
    expect(value(pick(r, "io_rt"))).not.toBe(value(rt));
    const s = JSON.parse((await edge(get("/auth/session", { headers: { cookie: value(id) } }))).body);
    expect(s).toMatchObject({ authenticated: true, sub: "I0111", exp: body.exp });
    expect((await refresh(value(rt))).statusCode).toBe(401); // the rotated token is spent (reuse also revokes its family)
  });

  it("refresh is 401 without a refresh cookie and 403 without the X-Requested-With guard (so a page can tell 'sign in again' apart)", async () => {
    expect((await refresh(undefined)).statusCode).toBe(401);
    expect((await refresh("io_rt=ios_not-a-real-token")).statusCode).toBe(401);
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    expect((await refresh(value(pick(res, "io_rt")), { "x-requested-with": "" })).statusCode).toBe(403);
  });
});

describe("login page under the /auth mount", () => {
  it("serves both paths, rewrites root-relative links to /auth/*, with no payload-hash workaround", async () => {
    const res = await edge(get("/auth/login"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toMatch(/accounts\.google\.com/);
    expect(res.body).toContain('id="pw"');
    expect(res.body).toContain("/auth/password");
    expect(res.body).toMatch(/href="\/auth\/password\/forgot"/);
    expect(res.body).not.toMatch(/(href|action)="\/(password|verify|link|login)/);
    expect(res.body).not.toContain("x-amz-content-sha256");
  });

  // @io-kit/auth 2.1.2: no-referrer made Google Identity Services reject the page origin ("origin is not allowed for the given client ID").
  it("sends Referrer-Policy strict-origin-when-cross-origin (header and meta), never no-referrer, so Google sign-in works", async () => {
    const res = await edge(get("/auth/login"));
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.body).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">');
    expect(res.body).not.toContain("no-referrer");
  });
});

// ---- design system: sign-in pages (components/SignIn; HFY overrides of @io-kit/auth 2.1.2 in adapt()) ----
import { DEFAULT_COPY } from "@io-kit/auth/edge/deploy";
import { FONT_SRC, GIS_FOCUS_SCRIPT, cspWithFontSrc, gisButtonDark, gisFocusRing } from "../src/edge.js";

const cspOf = (res) => Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "content-security-policy")?.[1];
const fontSrcCount = (csp) => (String(csp).match(/(^|;)\s*font-src\s/g) ?? []).length;

describe("sign-in pages: self-hosted fonts are allowed by the CSP (kit cspFor emits no font-src)", () => {
  const signedInCookie = async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    return (res.cookies ?? []).map((c) => c.split(";")[0]).join("; ");
  };
  const deniedHtml = async () => {
    const ev = post("/auth/google", { credential: await gToken("stranger@example.com") });
    return edge({ ...ev, headers: { ...ev.headers, accept: "text/html" } });
  };

  it("font-src 'self' appears exactly once on /auth/login, the password pages, /auth/link and the denied page", async () => {
    const pages = {
      "/auth/login": await edge(get("/auth/login")),
      "/auth/password/forgot": await edge(get("/auth/password/forgot")),
      "/auth/password/reset": await edge(get("/auth/password/reset")),
      "/auth/link (signed in)": await edge(get("/auth/link", { headers: { accept: "text/html", cookie: await signedInCookie() } })),
      denied: await deniedHtml(),
    };
    expect(pages.denied.statusCode).toBe(403);
    expect(pages.denied.body).toContain("<h1>not on the list yet</h1><p>that email isn&#39;t on the list yet. text J and we&#39;ll add you.</p>");
    expect(pages["/auth/link (signed in)"].statusCode).toBe(200);
    for (const [name, res] of Object.entries(pages)) {
      expect(res.headers["content-type"], name).toMatch(/text\/html/);
      const csp = cspOf(res);
      expect(fontSrcCount(csp), `${name}: ${csp}`).toBe(1);
      expect(csp, name).toMatch(/(^|; )font-src 'self'(;|$)/); // @io-kit/auth >= 2.2.0 emits it from theme.fontOrigins
      expect(csp, name).toMatch(/^default-src 'none'; /); // the kit policy is kept, only extended
      expect(csp, name).toContain("style-src 'unsafe-inline' https://harrisonfamily.us");
    }
  });

  it("JSON responses are untouched: no CSP is added and the body is the kit's", async () => {
    const jsonRes = [
      await edge(get("/auth/session")),
      await edge(get("/auth/.well-known/jwks.json")),
      await edge(post("/auth/google", { credential: await gToken("ana@example.com") })),
      await edge(post("/auth/google", { credential: await gToken("stranger@example.com") })),
    ];
    for (const res of jsonRes) {
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(cspOf(res)).toBeUndefined();
      expect(() => JSON.parse(res.body)).not.toThrow();
      expect(res.body).not.toContain("filled_black");
    }
  });

  it("cspWithFontSrc appends font-src only when the policy has none (a kit font-src wins; idempotent)", () => {
    expect(FONT_SRC).toBe("font-src 'self'");
    expect(cspWithFontSrc("default-src 'none'; img-src https:")).toBe("default-src 'none'; img-src https:; font-src 'self'");
    expect(cspWithFontSrc("default-src 'none'; ")).toBe("default-src 'none'; font-src 'self'");
    const kit = "default-src 'none'; font-src https://fonts.example";
    expect(cspWithFontSrc(kit)).toBe(kit);
    expect(cspWithFontSrc(cspWithFontSrc("default-src 'none'"))).toBe("default-src 'none'; font-src 'self'");
    for (const v of [undefined, "", 7]) expect(cspWithFontSrc(v)).toBe(v);
  });
});

describe("sign-in pages: Google button and signed-out /auth/link (kit loginPage / link redirect)", () => {
  it("the GIS button is drawn dark (filled_black) at the 343px sign-in width; the One Tap config is left alone", async () => {
    const res = await edge(get("/auth/login"));
    const tag = /<div class="g_id_signin"[^>]*>/.exec(res.body)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).toContain('data-theme="filled_black"');
    expect(tag).toContain('data-width="343"');
    expect(res.body).not.toContain('data-theme="outline"');
    expect(res.body).not.toContain('data-width="280"');
    expect(res.body).toMatch(/<div id="g_id_onload" data-client_id="gis-client\.apps\.googleusercontent\.com"/);
    const other = '<div class="x" data-theme="outline" data-width="280"></div>';
    expect(gisButtonDark(other)).toBe(other);
  });

  it("the login page carries the GIS keyboard-focus script under the page's own script nonce, once", async () => {
    const res = await edge(get("/auth/login"));
    const nonces = [...res.body.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces.length).toBeGreaterThan(1);
    expect(new Set(nonces).size).toBe(1); // the injected tag reuses the kit's nonce, so script-src 'nonce-…' allows it
    expect(cspOf(res)).toContain(`'nonce-${nonces[0]}'`);
    expect(res.body.split("data-hfy-gis-focus").length - 1).toBe(1);
    expect(res.body).toContain(GIS_FOCUS_SCRIPT);
    expect(res.body.indexOf("data-hfy-gis-focus")).toBeLessThan(res.body.lastIndexOf("</body>"));
    expect(gisFocusRing(res.body)).toBe(res.body); // idempotent
  });

  it("gisFocusRing leaves pages without a Google row, or without a nonce, alone", async () => {
    const forgot = await edge(get("/auth/password/forgot"));
    expect(forgot.body).not.toContain("data-hfy-gis-focus");
    const noNonce = '<html><body><div class="gsi"></div><script>x</script></body></html>';
    expect(gisFocusRing(noNonce)).toBe(noNonce);
    for (const v of [undefined, "", 7]) expect(gisFocusRing(v)).toBe(v);
    const ok = gisFocusRing('<html><body><div class="gsi"></div><script nonce="n1">x</script></body></html>');
    expect(ok).toContain(`<script nonce="n1" data-hfy-gis-focus>${GIS_FOCUS_SCRIPT}</script></body>`);
  });

  it("GET /auth/link signed out is a 302 to /auth/login?returnTo=%2Fauth%2Flink, which comes back to /auth/link after sign-in", async () => {
    const res = await edge(get("/auth/link"));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/login?returnTo=%2Fauth%2Flink");
    const login = await edge(get("/auth/login", { queryStringParameters: { returnTo: decodeURIComponent(res.headers.location.split("returnTo=")[1]) } }));
    expect(ioReturnOf(login.body)).toBe("/auth/link");
  });
});

describe("sign-in pages: manifest theme and copy (design system SignIn + Voice)", () => {
  it("theme has no vars (the stylesheet themes the page) and keeps the same-origin cssUrl; the manifest validates", () => {
    expect(raw.theme).toEqual({ cssUrl: "https://harrisonfamily.us/css/auth-edge.css", fontOrigins: ["self"] });
    expect(raw.theme.vars).toBeUndefined();
    expect(() => validateManifest(structuredClone(raw))).not.toThrow();
  });
  it("the rendered page carries no theme.vars :root block after BASE_CSS", async () => {
    const res = await edge(get("/auth/login"));
    const style = /<style>([\s\S]*?)<\/style>/.exec(res.body)[1];
    expect((style.match(/:root\{/g) ?? []).length).toBeLessThanOrEqual(1); // BASE_CSS's own defaults at most (2.2.0 reads --io-auth-* with fallbacks)
    expect(style).not.toMatch(/--io-accent:\s*#/); // no literal theme.vars block
    expect(res.body.indexOf('<link rel="stylesheet" href="https://harrisonfamily.us/css/auth-edge.css">')).toBeLessThan(res.body.indexOf("<style>"));
  });
  it("every kit copy key is set, in the voice: lowercase, no exclamation marks, errors say who to text", () => {
    expect(Object.keys(raw.copy).sort()).toEqual(Object.keys(DEFAULT_COPY).sort());
    for (const [k, v] of Object.entries(raw.copy)) {
      expect(v, k).toBe(v.replace(/\bJ\b/g, "j").toLowerCase().replace(/\bj\b/g, "J")); // lowercase except "J"
      expect(v, k).not.toMatch(/!/);
    }
    expect(raw.copy.title).toBe("hi family. sign in to see the private pages.");
    expect(raw.copy.subtitle.split("\n").length).toBeGreaterThan(1);
    expect(raw.copy.subtitle.endsWith("if neither works, text J.")).toBe(true);
    expect(raw.copy.subtitle).not.toMatch(/family password/); // accounts are per member: the open help line is io's call
    for (const k of ["invalid_credentials", "denied_body", "generic_error"]) expect(raw.copy[k], k).toMatch(/text J/);
  });
});

// ---- HFY-R58 review fixes ----
import { safeReturnTo } from "../src/edge.js";
import { FORGOT_LIMITS, clientIp, ddbRateLimiter, memoryRateLimiter, rateKey } from "../src/ratelimit.js";

const SITE = "https://harrisonfamily.us";
const ioReturnOf = (html) => JSON.parse(/var ioReturn=("(?:[^"\\]|\\.)*");/.exec(html)[1]);
const landsOn = (target) => new URL(target, `${SITE}/auth/login`);

describe("returnTo / next cannot leave the site (login-returnto-tab-open-redirect)", () => {
  const EVIL = [
    "/\t/evil.example/phish", "/\n/evil.example", "/\r/evil.example", "\t//evil.example", "/\u0000/evil.example", "/\\evil.example",
    "//evil.example", "https://evil.example/x", "http://harrisonfamily.us/x", "javascript:alert(1)", "/.//evil.example", "/a/..//evil.example",
    `${SITE}//evil.example/x`, " //evil.example",
  ];
  it("safeReturnTo maps every off-site or protocol-relative shape to /", () => {
    for (const v of EVIL) {
      const out = safeReturnTo(v, SITE);
      expect(out, JSON.stringify(v)).toBe("/");
    }
    for (const v of [undefined, null, 7, "", "x".repeat(3000)]) expect(safeReturnTo(v, SITE)).toBe("/");
  });
  it("safeReturnTo keeps same-site paths (canonicalized) and allow-listed origins", () => {
    expect(safeReturnTo("/people/?id=I0111#tree", SITE)).toBe("/people/?id=I0111#tree");
    expect(safeReturnTo(`${SITE}/posts/?id=1`, SITE)).toBe("/posts/?id=1");
    expect(safeReturnTo("/a/../b", SITE)).toBe("/b");
    expect(safeReturnTo("/%09/evil.example", SITE)).toBe("/%09/evil.example"); // encoded tab stays a path segment
    expect(safeReturnTo("https://other.example/x", SITE, ["https://other.example"])).toBe("https://other.example/x");
  });
  it("GET /auth/login?returnTo=/<TAB>/evil.example renders an on-site ioReturn (the reported repro)", async () => {
    for (const v of EVIL) {
      const res = await edge(get("/auth/login", { queryStringParameters: { returnTo: v } }));
      expect(res.statusCode).toBe(200);
      const target = ioReturnOf(res.body);
      expect(landsOn(target).origin, JSON.stringify(v)).toBe(SITE);
      expect(target).toBe("/");
    }
  });
  it("legitimate returnTo values and the /auth/authorize next hop still work", async () => {
    const ok = await edge(get("/auth/login", { queryStringParameters: { returnTo: "/people/?id=I0111" } }));
    expect(ioReturnOf(ok.body)).toBe("/people/?id=I0111");
    const next = "/auth/authorize?client_id=mcp-harrisonfamily&response_type=code&state=s1";
    const viaNext = await edge(get("/auth/login", { queryStringParameters: { next } }));
    expect(ioReturnOf(viaNext.body)).toBe(next);
    for (const bad of ["/auth/authorize?\t//evil.example", "//evil.example/auth/authorize?x", "/people/"]) {
      const r = await edge(get("/auth/login", { queryStringParameters: { next: bad } }));
      expect(landsOn(ioReturnOf(r.body)).origin).toBe(SITE);
      expect(ioReturnOf(r.body)).toBe("/");
    }
  });
});

/** An edge wired with fakes for the password authenticator, the Cognito lifecycle and the rate limiter. */
async function fakeEdge({ limiter, forgotLimits } = {}) {
  const s = await generateKeyPair("RS256", { extractable: true });
  const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  const calls = { forgot: [], verify: [], reset: [] };
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async () => JSON.stringify(ALLOW) }),
    links: memoryLinkStore(),
    passwordAuth: { authenticate: async (email) => ({ email, emailVerified: true, idpIssuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST", idpSub: "cog-1" }) },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
  });
  const lifecycle = {
    forgot: async (email) => { calls.forgot.push(email); },
    verify: async (i) => { calls.verify.push(i); },
    reset: async (i) => { calls.reset.push(i); },
  };
  const e = createAuthEdge({
    manifest, identity, publicJwk: pub, lifecycle, nonce: () => "n0nce", log: { error: () => {} },
    verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) },
    ...(limiter ? { limiter } : {}), ...(forgotLimits ? { forgotLimits } : {}),
  });
  return { edge: e, calls };
}

describe("/auth/password response returnTo is re-checked", () => {
  it("a tab-smuggled returnTo in the sign-in body comes back as /", async () => {
    const { edge: e } = await fakeEdge();
    const res = await e(post("/auth/password", { email: "ana@example.com", password: "pw-123456789", returnTo: "/\t/evil.example/phish" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, returnTo: "/" });
    const good = await e(post("/auth/password", { email: "ana@example.com", password: "pw-123456789", returnTo: "/people/" }));
    expect(JSON.parse(good.body).returnTo).toBe("/people/");
  });
});

describe("self-service sign-up confirmation is closed (cognito-self-signup-enabled)", () => {
  it("POST /auth/verify is 410 and never reaches ConfirmSignUp", async () => {
    const { edge: e, calls } = await fakeEdge();
    const res = await e(post("/auth/verify", { email: "ana@example.com", code: "123456" }));
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body)).toEqual({ code: "AUTH_FORBIDDEN", detail: "signup_disabled" });
    expect(calls.verify).toEqual([]);
  });
});

describe("forgot-password rate limit (cognito-default-email-quota)", () => {
  const from = (ip, email, extra = {}) => {
    const ev = post("/auth/password/forgot", { email });
    return { ...ev, headers: { ...ev.headers, "cloudfront-viewer-address": `${ip}:51234`, ...extra } };
  };
  it("allows 3 per email+IP per hour, then 429 with Retry-After and no Cognito call", async () => {
    let t = Date.UTC(2026, 9, 12, 10, 0, 0);
    const { edge: e, calls } = await fakeEdge({ limiter: memoryRateLimiter({ now: () => t }) });
    for (let i = 0; i < 3; i++) expect((await e(from("203.0.113.5", "ana@example.com"))).statusCode).toBe(200);
    const res = await e(from("203.0.113.5", " Ana@Example.com "));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ code: "AUTH_FORBIDDEN", detail: "rate_limited" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(calls.forgot).toHaveLength(3);
    // same email from another IP, and another email from the same IP, are separate email+IP buckets
    expect((await e(from("198.51.100.7", "ana@example.com"))).statusCode).toBe(200);
    expect((await e(from("203.0.113.5", "bo@example.com"))).statusCode).toBe(200);
    // the hourly window rolls over
    t += 3600 * 1000;
    expect((await e(from("203.0.113.5", "ana@example.com"))).statusCode).toBe(200);
  });
  it("caps one IP cycling through many emails at 10 a day", async () => {
    const { edge: e, calls } = await fakeEdge({ limiter: memoryRateLimiter() });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await e(from("203.0.113.9", `member${i}@example.com`))).statusCode);
    expect(codes).toEqual([...Array(10).fill(200), 429, 429]);
    expect(calls.forgot).toHaveLength(10);
  });
  it("requests the kit refuses (no X-Requested-With, foreign Origin) are not counted", async () => {
    const { edge: e, calls } = await fakeEdge({ limiter: memoryRateLimiter() });
    for (let i = 0; i < 5; i++) {
      const noHdr = from("203.0.113.5", "ana@example.com"); delete noHdr.headers["x-requested-with"];
      expect((await e(noHdr)).statusCode).toBe(403);
      expect((await e(from("203.0.113.5", "ana@example.com", { origin: "https://evil.example" }))).statusCode).toBe(403);
    }
    expect((await e(from("203.0.113.5", "ana@example.com"))).statusCode).toBe(200);
    expect(calls.forgot).toHaveLength(1);
  });
  it("fails closed (503, no email) when the counter store is unavailable", async () => {
    const { edge: e, calls } = await fakeEdge({ limiter: { hit: async () => { throw new Error("ddb down"); } } });
    const res = await e(from("203.0.113.5", "ana@example.com"));
    expect(res.statusCode).toBe(503);
    expect(calls.forgot).toEqual([]);
  });
  it("the default limits are the ruled email+IP key plus a per-IP cap", () => {
    expect(FORGOT_LIMITS.map((r) => r.scope)).toEqual(["email+ip", "ip"]);
    const a = rateKey("forgot", "email+ip", { email: "ana@example.com", ip: "203.0.113.5" });
    expect(a).not.toMatch(/ana|203\.0/); // hashed: no email or IP at rest
    expect(a).not.toBe(rateKey("forgot", "email+ip", { email: "ana@example.com", ip: "203.0.113.6" }));
    expect(rateKey("forgot", "ip", { email: "a@x", ip: "1.2.3.4" })).toBe(rateKey("forgot", "ip", { email: "b@x", ip: "1.2.3.4" }));
  });
  it("clientIp prefers CloudFront-Viewer-Address, else the CloudFront-appended X-Forwarded-For entry", () => {
    const ev = (headers, sourceIp = "130.176.0.1") => ({ headers, requestContext: { http: { sourceIp } } });
    expect(clientIp(ev({ "CloudFront-Viewer-Address": "203.0.113.5:443", "x-forwarded-for": "6.6.6.6" }))).toBe("203.0.113.5");
    expect(clientIp(ev({ "cloudfront-viewer-address": "2001:db8::1:51234" }))).toBe("2001:db8::1");
    expect(clientIp(ev({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 130.176.0.1" }))).toBe("203.0.113.5"); // spoofed left entry ignored
    expect(clientIp(ev({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(ev({}))).toBe("130.176.0.1");
  });
  it("ddbRateLimiter is one atomic ADD per hit on a TTL'd window item", async () => {
    const sent = [];
    const store = new Map();
    class UpdateCommand { constructor(input) { this.input = input; } }
    const doc = { send: async (c) => {
      sent.push(c.input);
      const k = `${c.input.Key.PK}|${c.input.Key.SK}`;
      const n = (store.get(k) ?? 0) + c.input.ExpressionAttributeValues[":one"];
      store.set(k, n);
      return { Attributes: { n } };
    } };
    const t = Date.UTC(2026, 9, 12, 10, 30, 0);
    const lim = ddbRateLimiter({ doc, cmds: { UpdateCommand }, table: "hfy-app", now: () => t });
    const rule = { limit: 2, windowSeconds: 3600 };
    expect((await lim.hit("forgot:ip#k", rule)).allowed).toBe(true);
    expect((await lim.hit("forgot:ip#k", rule)).allowed).toBe(true);
    const third = await lim.hit("forgot:ip#k", rule);
    expect(third).toMatchObject({ allowed: false, count: 3, retryAfter: 1800 });
    const start = Math.floor(t / 1000) - 1800;
    expect(sent[0]).toMatchObject({
      TableName: "hfy-app", Key: { PK: "RATE#forgot:ip#k", SK: `W#3600#${start}` },
      UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#n": "n", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":ttl": start + 3600 + 300 },
    });
  });
});
