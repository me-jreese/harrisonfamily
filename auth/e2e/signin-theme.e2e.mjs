// Design system SignIn (components/SignIn): the real edge pages (createAuthEdge, real CSP header) on http://localhost:$E2E_PORT, themed by
// the BUILT stylesheet. The manifest cssUrl is pointed at ${ORIGIN}/css/auth-edge.css and the same server serves /css and /fonts from
// $SITE, a scratch copy of the site built with islands/build.mjs (so this never tests a stale committed 11ty/css/auth-edge.css):
//   rsync -a --delete 11ty/ $SCRATCH/site-signin/ && (cd islands && node build.mjs --site $SCRATCH/site-signin)
//   cd auth && SITE=$SCRATCH/site-signin E2E_PORT=4175 npm run e2e:theme
// Chrome (channel chrome) at 375 and 1024: /auth/login, /auth/password/forgot, /auth/password/reset, /auth/link signed out (302 to login)
// and the denied page. Test-only wiring: password provider stub, in-memory stores, synthetic allowlist. Never talks to production.
// E2E_SHOTS=<dir> also writes a full-page screenshot per page and width. E2E_OFFLINE=1 blocks accounts.google.com (GIS) requests.
import http from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import { generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { AuthError } from "@io-kit/auth";
import { buildResolver, loadPasskeyBrowserBundle } from "@io-kit/auth/edge/deploy";
import { createIdentityService, createPasskeyService, memoryChallengeStore, memoryLinkStore, memoryPasskeyStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";

const PORT = Number(process.env.E2E_PORT ?? 4175);
const ORIGIN = `http://localhost:${PORT}`;
const SITE = process.env.SITE ? resolve(process.env.SITE) : "";
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : "";
try {
  if (!SITE || !statSync(join(SITE, "css", "auth-edge.css")).size) throw new Error("empty");
} catch {
  console.error("SITE must name a built site copy containing css/auth-edge.css (see the header of this file)");
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const PASSWORD = "e2e-test-password";
const allow = { "ana@example.com": "I0111" }; // synthetic; stranger@example.com is deliberately not on it

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const m = loadManifest(raw, ENV);
Object.assign(m, { site: "localhost", authOrigin: ORIGIN, returnOrigins: [ORIGIN] });
delete m.cookieDomain;
m.resolver.cacheSeconds = 0;
m.session.issuer = `${ORIGIN}/auth`;
m.theme = { ...m.theme, cssUrl: `${ORIGIN}/css/auth-edge.css` }; // after validation: the committed manifest stays https-only
const pkProv = m.providers.find((p) => p.kind === "passkey");
Object.assign(pkProv, { rpId: "localhost", origins: [ORIGIN] });

const s = await generateKeyPair("RS256", { extractable: true });
const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
const identity = createIdentityService({
  resolver: buildResolver(m.resolver, { readObject: async () => JSON.stringify(allow) }),
  links: memoryLinkStore(),
  passwordAuth: {
    authenticate: async (email, pw) => {
      if (pw !== PASSWORD) throw new AuthError("AUTH_FORBIDDEN", "invalid_credentials", { detail: "invalid_credentials", status: 401 });
      return { email, emailVerified: true, idpIssuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST", idpSub: `e2e-${email}` };
    },
  },
  sessions: { issuer: m.session.issuer, audience: m.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
});
const passkeys = createPasskeyService({ rpID: "localhost", rpName: pkProv.rpName, origin: [ORIGIN], store: memoryPasskeyStore(), challenges: memoryChallengeStore() });
const lifecycle = { forgot: async () => undefined, reset: async () => undefined, verify: async () => undefined };
const edge = createAuthEdge({
  manifest: m, identity, publicJwk: pub, passkeys, passkeyClientScript: loadPasskeyBrowserBundle(), lifecycle, log: { error: () => {} },
  verify: { issuers: [m.session.issuer], audiences: [m.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) },
});

const TYPES = { ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
function staticFile(pathname) {
  if (!/^\/(css|fonts)\//.test(pathname)) return null;
  const file = resolve(SITE, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(SITE + sep)) return null;
  try {
    return { status: 200, headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(file) };
  } catch {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const u = new URL(req.url, ORIGIN);
  const file = staticFile(u.pathname);
  if (file) {
    res.writeHead(file.status, file.headers);
    res.end(file.body);
    return;
  }
  let ev = { rawPath: u.pathname, queryStringParameters: Object.fromEntries(u.searchParams), requestContext: { http: { method: req.method } }, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined };
  if (u.pathname === "/__e2e/denied") {
    // Test-only: the kit renders its denied page for an HTML POST that the allowlist refuses; a browser navigation cannot send the
    // X-Requested-With guard, so this GET replays that POST server-side and returns the edge's response unchanged (real CSP).
    ev = { rawPath: "/auth/password", requestContext: { http: { method: "POST" } }, headers: { "x-requested-with": "io-kit", origin: ORIGIN, accept: "text/html", "content-type": "application/json" }, body: JSON.stringify({ email: "stranger@example.com", password: PASSWORD }) };
  }
  const r = await edge(ev);
  const headers = { ...r.headers };
  if (r.cookies?.length) headers["set-cookie"] = r.cookies;
  res.writeHead(r.statusCode, headers);
  res.end(r.body ?? "");
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

const PAGES = [
  { key: "login", path: "/auth/login" },
  { key: "forgot", path: "/auth/password/forgot" },
  { key: "reset", path: "/auth/password/reset" },
  { key: "link-signed-out", path: "/auth/link", expect: /\/auth\/login\?returnTo=%2Fauth%2Flink$/ },
  { key: "denied", path: "/__e2e/denied", status: 403 },
];
const WIDTHS = [
  { w: 375, h: 812 },
  { w: 1024, h: 768 },
];
const SURFACE = "rgb(20, 18, 16)"; // archive-950
const RAISED = "rgb(33, 30, 27)"; // archive-900
const ACCENT = "rgb(88, 182, 231)"; // columbia-400
const FOCUS = "rgb(255, 193, 7)"; // gold-400
const DANGER = "rgb(255, 138, 128)"; // signal danger-bright

/** Everything measured in the page, in one evaluate. */
const measure = () =>
  page.evaluate(() => {
    const cs = (el, pseudo) => getComputedStyle(el, pseudo);
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    const visible = (el) => el.getClientRects().length > 0 && cs(el).visibility !== "hidden" && el.getBoundingClientRect().width > 1;
    const main = document.querySelector("main");
    const mainCs = cs(main);
    const before = cs(main, "::before");
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      bodyBg: cs(document.body).backgroundColor,
      bodyColor: cs(document.body).color,
      bodyFont: cs(document.body).fontFamily,
      bodySize: cs(document.body).fontSize,
      main: { ...box(main), bg: mainCs.backgroundColor, borderTop: mainCs.borderTopWidth, radius: mainCs.borderTopLeftRadius, padLeft: mainCs.paddingLeft, shadow: mainCs.boxShadow },
      wordmark: { content: before.content, font: before.fontFamily, size: before.fontSize },
      h1: (() => {
        const h = document.querySelector("h1");
        return h && { text: h.textContent, font: cs(h).fontFamily, size: cs(h).fontSize, weight: cs(h).fontWeight };
      })(),
      inputs: [...document.querySelectorAll("input")].filter(visible).map((i) => ({ id: i.id, ac: i.autocomplete, h: Math.round(i.getBoundingClientRect().height), size: cs(i).fontSize, bg: cs(i).backgroundColor })),
      buttons: [...document.querySelectorAll("button, a.btn")].filter(visible).map((b) => ({ text: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width), bg: cs(b).backgroundColor, color: cs(b).color, size: cs(b).fontSize })),
      targets: [...document.querySelectorAll("a, button, input")].filter(visible).map((t) => ({ tag: t.tagName, text: (t.textContent || t.id).trim().slice(0, 30), h: Math.round(t.getBoundingClientRect().height) })),
      h2Visible: [...document.querySelectorAll("#path-google > h2, #path-password > h2, #path-passkey > h2")].map((h) => Math.round(h.getBoundingClientRect().width)),
      verifyLinkShown: [...document.querySelectorAll('a[href^="/auth/verify"]')].some(visible),
      subtitle: (() => {
        const p = document.querySelector("main > p");
        return p && { ...box(p), ws: cs(p).whiteSpace, color: cs(p).color };
      })(),
      lastPathBottom: (() => {
        const paths = [...document.querySelectorAll("main > .path")].filter(visible);
        return paths.length ? Math.round(Math.max(...paths.map((x) => x.getBoundingClientRect().bottom))) : null;
      })(),
      gis: (() => {
        const g = document.querySelector(".g_id_signin");
        return g && { theme: g.dataset.theme, width: g.dataset.width, rowH: Math.round(document.querySelector(".gsi").getBoundingClientRect().height) };
      })(),
      orLabel: (() => {
        const p = document.querySelector("#path-password");
        return p && visible(p) ? { content: cs(p, "::before").content, borderTop: cs(p).borderTopWidth, bg: cs(p, "::before").backgroundColor } : null;
      })(),
    };
  });

let page;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  for (const { w, h } of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    if (process.env.E2E_OFFLINE) await ctx.route(/^https:\/\/accounts\.google\.com\//, (r) => r.abort());
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page = await ctx.newPage();
    const consoleCsp = [];
    page.on("console", (msg) => {
      if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/i.test(msg.text())) consoleCsp.push(msg.text().slice(0, 200));
    });
    for (const pg of PAGES) {
      const tag = `${pg.key}@${w}`;
      consoleCsp.length = 0;
      const resp = await page.goto(`${ORIGIN}${pg.path}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const csp = resp.headers()["content-security-policy"] ?? "";
      check(`${tag}: status ${pg.status ?? 200}${pg.expect ? " after the redirect" : ""}`, resp.status() === (pg.status ?? 200) && (!pg.expect || pg.expect.test(page.url())), { status: resp.status(), url: page.url() });
      check(`${tag}: the edge CSP has exactly one font-src 'self' and keeps default-src 'none'`, (csp.match(/font-src/g) ?? []).length === 1 && /font-src 'self'/.test(csp) && /^default-src 'none'/.test(csp), csp);
      const faces = await page.evaluate(() => {
        const loaded = (fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fam && f.status === "loaded");
        return {
          ui: loaded("Source Sans 3") && document.fonts.check('18px "Source Sans 3"'),
          display: loaded("Libre Caslon Text") && document.fonts.check('36px "Libre Caslon Text"'),
        };
      });
      check(`${tag}: Source Sans 3 and Libre Caslon Text are loaded (self-hosted, same origin)`, faces.ui && faces.display, faces);
      const v = await measure();
      check(`${tag}: no horizontal scroll`, v.scrollW <= v.innerW, { scrollW: v.scrollW, innerW: v.innerW });
      check(`${tag}: body is the archive ground in the UI face at 18px`, v.bodyBg === SURFACE && /^"Source Sans 3"/.test(v.bodyFont) && v.bodySize === "18px", { bg: v.bodyBg, font: v.bodyFont, size: v.bodySize });
      check(`${tag}: wordmark "Harrison Family" in the display serif at 36px`, /Harrison Family/.test(v.wordmark.content) && /^"Libre Caslon Text"/.test(v.wordmark.font) && v.wordmark.size === "36px", v.wordmark);
      if (w >= 688) check(`${tag}: main is the 440 card (surface.raised, 1px border, radius 16, elevation 2)`, v.main.w === 440 && v.main.bg === RAISED && v.main.borderTop === "1px" && v.main.radius === "16px" && v.main.shadow !== "none", v.main);
      else check(`${tag}: main is edge to edge with a 16px gutter and no card border`, v.main.padLeft === "16px" && v.main.borderTop === "0px" && v.main.w === w, v.main);
      const badInputs = v.inputs.filter((i) => (i.ac === "one-time-code" ? i.h !== 56 || i.size !== "24px" : i.h !== 44 || i.size !== "16px"));
      check(`${tag}: inputs are 44 tall at 16px (the reset code 56 at 24px mono)`,v.inputs.length > 0 ? badInputs.length === 0 : pg.key !== "login" && pg.key !== "forgot" && pg.key !== "reset", v.inputs);
      const small = v.targets.filter((t) => t.h < 44);
      check(`${tag}: every visible link, button and input is at least 44 tall`, small.length === 0, small);
      const primary = v.buttons.find((b) => ["sign in", "continue"].includes(b.text) && b.bg === ACCENT);
      if (pg.key !== "denied") check(`${tag}: the primary button is 56 tall on Columbia (${primary?.text})`, !!primary && primary.h === 56 && primary.size === "18px", v.buttons);
      const secondary = v.buttons.filter((b) => b.bg !== ACCENT);
      check(`${tag}: secondary buttons are 56 tall on surface.raised`, secondary.every((b) => b.h === 56 && b.bg === RAISED), secondary);
      if (pg.key === "login" || pg.key === "link-signed-out") {
        check(`${tag}: login h1 is the greeting in the UI face at 18px`, v.h1?.text === "hi family. sign in to see the private pages." && /^"Source Sans 3"/.test(v.h1.font) && v.h1.size === "18px", v.h1);
        check(`${tag}: path headings are visually hidden, the verify link is not shown`, v.h2Visible.every((x) => x <= 1) && !v.verifyLinkShown, { h2: v.h2Visible, verify: v.verifyLinkShown });
        check(`${tag}: the step help keeps its line breaks and sits last`, v.subtitle?.ws === "pre-line" && v.subtitle.y >= v.lastPathBottom, { subtitle: v.subtitle, lastPathBottom: v.lastPathBottom });
        check(`${tag}: "or" hairline on the email path`, v.orLabel?.borderTop === "1px" && /"or"/.test(v.orLabel.content) && v.orLabel.bg === (w >= 688 ? RAISED : SURFACE), v.orLabel);
        check(`${tag}: Google button is filled_black at 343 in a 56 row`, v.gis?.theme === "filled_black" && v.gis.width === "343" && v.gis.rowH === 56, v.gis);
      } else {
        check(`${tag}: h1 in the display serif at 24px, regular`, /^"Libre Caslon Text"/.test(v.h1?.font) && v.h1.size === "24px" && v.h1.weight === "400", v.h1);
      }
      const firstInput = v.inputs[0]?.id;
      if (firstInput) await page.focus(`#${firstInput}`);
      else await page.keyboard.press("Tab"); // keyboard focus, so :focus-visible matches the link as it does for a keyboard user
      const ring = await page.evaluate(() => {
        const a = document.activeElement;
        const c = getComputedStyle(a);
        return { el: a.tagName, style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, offset: c.outlineOffset };
      });
      check(`${tag}: focus ring is 2px solid gold, offset 2`, ring.style === "solid" && ring.width === "2px" && ring.color === FOCUS && ring.offset === "2px", ring);
      if (pg.key === "login" || pg.key === "link-signed-out") {
        await page.fill("#email", "ana@example.com");
        await page.fill("#password", "not-the-password");
        await page.click('#pw button[type="submit"]');
        await page.waitForSelector("#msg-pw.show");
        const banner = await page.evaluate(() => {
          const b = document.querySelector("#msg-pw");
          const c = getComputedStyle(b);
          return { text: b.textContent, bottom: b.getBoundingClientRect().bottom, emailTop: document.querySelector("#email").getBoundingClientRect().top, labelTop: document.querySelector('label[for="email"]').getBoundingClientRect().top, color: c.color, border: `${c.borderTopWidth} ${c.borderTopColor}`, bg: c.backgroundColor };
        });
        check(`${tag}: a bad password shows the danger banner above the email field`, banner.text === "that email and password don't match. try again, or text J." && banner.bottom <= banner.labelTop && banner.color === DANGER && banner.border === `1px ${DANGER}` && banner.bg === RAISED, banner);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${pg.key}-error-${w}.png`), fullPage: true });
      }
      if (pg.key === "forgot") {
        await page.fill("#email", "ana@example.com");
        await page.click('#f button[type="submit"]');
        await page.waitForSelector("#msg.show.ok");
        const ok = await page.evaluate(() => {
          const c = getComputedStyle(document.querySelector("#msg"));
          return { text: document.querySelector("#msg").textContent, color: c.color, border: c.borderTopColor };
        });
        check(`${tag}: the done message is a neutral banner`, ok.text === "check your email. we sent a 6-digit code." && ok.color === "rgb(250, 246, 238)" && ok.border === "rgb(133, 118, 102)", ok);
        await page.waitForURL(/\/auth\/password\/reset$/, { timeout: 5000 });
        check(`${tag}: forgot hands over to /auth/password/reset`, /\/auth\/password\/reset$/.test(page.url()), page.url());
      }
      const violations = [...consoleCsp, ...(await page.evaluate(() => window.__csp))];
      check(`${tag}: no CSP violations`, violations.length === 0, violations);
      if (pg.key === "login") {
        // Keyboard focus on the Google button (auth/src/edge.js gisFocusRing): Google's iframe is cross-origin, so its focus cannot be
        // seen by a selector. The real GIS iframe here would hold a test client id, so a same-geometry stand-in iframe (363 x 44 at
        // margin -2px -10px, a button inside, like GIS) replaces it; the HFY script and CSS are what is under test.
        await page.goto(`${ORIGIN}${pg.path}`, { waitUntil: "load" });
        await page.evaluate(() => {
          const host = document.querySelector(".g_id_signin");
          host.replaceChildren();
          const f = document.createElement("iframe");
          f.title = "stand-in for the Google button";
          f.srcdoc = "<button>continue with google</button>";
          f.style.cssText = "display:block;width:363px;height:44px;margin:-2px -10px;border:0";
          host.append(f);
        });
        await page.waitForFunction(() => document.querySelector(".g_id_signin iframe")?.contentDocument?.querySelector("button"));
        await page.evaluate(() => document.activeElement?.blur());
        let inGis = false;
        for (let i = 0; i < 8 && !inGis; i += 1) {
          await page.keyboard.press("Tab");
          inGis = await page.evaluate(() => document.activeElement?.tagName === "IFRAME" && Boolean(document.activeElement.closest(".gsi")));
        }
        await page.waitForTimeout(50);
        const gis = await page.evaluate(() => {
          const g = document.querySelector(".gsi");
          const c = getComputedStyle(g);
          const b = g.getBoundingClientRect();
          return { marked: g.hasAttribute("data-gis-focus"), style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, offset: c.outlineOffset, overflow: c.overflowX, left: Math.round(b.left), right: Math.round(b.right), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
        });
        check(`${tag}: Tab into the Google button draws the 2px solid gold ring (offset 2) round its row, unclipped`, inGis && gis.marked && gis.style === "solid" && gis.width === "2px" && gis.color === FOCUS && gis.offset === "2px" && gis.overflow === "visible" && gis.left - 4 >= 0 && gis.right + 4 <= gis.innerW && gis.scrollW <= gis.innerW, { inGis, ...gis });
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `login-gis-focus-${w}.png`) });
        await page.keyboard.press("Tab"); // out of the iframe, on to the next control on the page
        await page.waitForTimeout(50);
        const cleared = await page.evaluate(() => ({ off: !document.querySelector(".gsi").hasAttribute("data-gis-focus"), now: document.activeElement?.tagName }));
        check(`${tag}: focus back on the page clears the Google ring`, cleared.off && cleared.now !== "IFRAME", cleared);
        await page.mouse.click(5, 5);
      }
      if (SHOTS) {
        await page.goto(`${ORIGIN}${pg.path}`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(SHOTS, `${pg.key}-${w}.png`), fullPage: true });
      }
    }

    // Signed in (last: the session cookie stays in this context): the add-a-passkey prompt, then the linked-methods page.
    {
      const tag = `signed-in@${w}`;
      consoleCsp.length = 0;
      await page.goto(`${ORIGIN}/auth/login?returnTo=%2Fauth%2Flink`, { waitUntil: "load" });
      await page.fill("#email", "ana@example.com");
      await page.fill("#password", PASSWORD);
      await page.click('#pw button[type="submit"]');
      const prompted = await page.waitForSelector("#pk-prompt:not([hidden])", { timeout: 5000 }).then(() => true, () => false);
      if (prompted) {
        await page.evaluate(() => document.fonts.ready);
        const p = await page.evaluate(() => {
          const c = (s) => getComputedStyle(document.querySelector(s));
          const r = (s) => document.querySelector(s).getBoundingClientRect();
          const paths = ["#path-google", "#path-password", "#path-passkey"].map((s) => document.querySelector(s).hidden);
          return { paths, h2: { font: c("#pk-prompt > h2").fontFamily, w: Math.round(r("#pk-prompt > h2").width) }, add: { h: Math.round(r("#pk-add").height), bg: c("#pk-add").backgroundColor }, later: { h: Math.round(r("#pk-later").height), bg: c("#pk-later").backgroundColor, border: c("#pk-later").borderTopColor, gap: Math.round(r("#pk-later").top - r("#pk-add").bottom) } };
        });
        check(`${tag}: the add-a-passkey prompt replaces the paths, its heading visible in the display serif`, p.paths.every(Boolean) && /^"Libre Caslon Text"/.test(p.h2.font) && p.h2.w > 1, p);
        check(`${tag}: "add" is the 56 primary, "not now" the 56 secondary (kit inline style overridden), 12 apart`, p.add.h === 56 && p.add.bg === ACCENT && p.later.h === 56 && p.later.bg === RAISED && p.later.border === "rgb(133, 118, 102)" && p.later.gap === 12, p);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `passkey-prompt-${w}.png`), fullPage: true });
        await page.click("#pk-later");
      } else check(`${tag}: the add-a-passkey prompt appears after a password sign-in`, false, "no prompt within 5 s");
      await page.waitForURL(/\/auth\/link$/, { timeout: 5000 });
      await page.waitForSelector("#pk-list", { state: "attached" });
      await page.evaluate(() => document.fonts.ready);
      const l = await page.evaluate(() => {
        const c = (el) => getComputedStyle(el);
        const h1 = document.querySelector("h1");
        const h2s = [...document.querySelectorAll("main h2")].map((h) => ({ text: h.textContent, font: c(h).fontFamily, w: Math.round(h.getBoundingClientRect().width) }));
        const li = document.querySelector("ul.linked li");
        return { h1: { text: h1.textContent, font: c(h1).fontFamily, size: c(h1).fontSize }, h2s, li: li && { text: li.textContent, border: c(li).borderBottomColor }, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
      });
      check(`${tag}: /auth/link renders the linked methods with visible serif section headings`, l.h1.text === "linked sign-in methods" && /^"Libre Caslon Text"/.test(l.h1.font) && l.h1.size === "24px" && l.h2s.length > 0 && l.h2s.every((h) => h.w > 1 && /^"Libre Caslon Text"/.test(h.font)) && /password \(ana@example\.com\)/.test(l.li?.text ?? ""), l);
      check(`${tag}: no horizontal scroll on /auth/link`, l.scrollW <= l.innerW, l);
      const violations = [...consoleCsp, ...(await page.evaluate(() => window.__csp))];
      check(`${tag}: no CSP violations`, violations.length === 0, violations);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `link-signed-in-${w}.png`), fullPage: true });
    }
    await ctx.close();
  }
} catch (e) {
  check("e2e run completed", false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser?.close();
  server.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
