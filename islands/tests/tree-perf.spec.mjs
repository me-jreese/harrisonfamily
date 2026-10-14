// HFY-TSK-302 (viz-mvp-visual-perf) AC2: the performance budgets of /tree/ (viz.md section 11; viz ADR section 5; io approved them with Q2-13 on
// 2026-10-13) on synthetic graphs of 231 and 2,000 people (fixtures/graph-synth.mjs, invented names), cold, with the CPU slowed 4x and the network at
// the Lighthouse "slow 4G" class (about 1.6 Mbps down, 150 ms round trip):
//
//                                       231 people   2,000 people
//   a visible focus card               <= 2.5 s     <= 3.5 s
//   a re-centre's longest task         <= 100 ms    <= 200 ms
//   CLS on load                        <= 0.05      <= 0.05
//   face requests in the first view    <= 24, each <= 8 KB
//
// How it is measured. Chromium against the built site served by http-server (HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-perf.spec.mjs).
// CDP Emulation.setCPUThrottlingRate(4) slows the page; CDP Network.emulateNetworkConditions slows everything the real network stack serves (the
// scripts, styles and fonts). The built site is served by a small static server in this file that gzips text the way CloudFront does in production
// (http-server, which the other specs use, does not compress, and would throttle the 200 KB React chunk at its raw size). The route stubs (flags,
// session, graph, faces) bypass the network stack, so each one waits what the same bytes would take on that link instead: one round trip plus the
// gzip size (the gated responses are compressed in production; the ADR's graph budget is a gzip size) at 1.6 Mbps. The graph is `no-store` in
// production (HFY-R65), so nothing here is served from a cache: every test runs in a fresh browser context.
//
// Best effort under load. These are wall-clock budgets on a shared machine (the 231-person case has about 0.4 s of margin, and one run under heavy
// load took 2.49 s), so each test may retry ONCE (RETRIES below): a real regression misses on both attempts, a one-off stall of the machine does
// not. One retry, not more: a regression that misses two attempts in three would still go green with two. Every attempt prints its measured value
// ("[perf] ...", also a test annotation with the attempt number), so a run that passed only on the retry shows in the output and a trend is visible.
// CI should run this file with workers=1 (`--workers=1`) so the specs do not compete for the CPU they are measuring.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { synthFocus, synthGraph } from "./fixtures/graph-synth.mjs";

const RETRIES = 1;
const RTT_MS = 150;
const DOWN_BYTES_PER_S = (1.6 * 1024 * 1024) / 8;
const UP_BYTES_PER_S = (0.75 * 1024 * 1024) / 8;
const CPU_RATE = 4;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const wire = (bytes) => RTT_MS + (bytes / DOWN_BYTES_PER_S) * 1000;

// A real WebP of about 6 KB: the 1x1 lossy image, then a RIFF JUNK chunk of padding (a face crop is at most 8 KB, viz.md 5.4).
function faceBody(size = 6000) {
  const base = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  const junk = Buffer.alloc(8 + size);
  junk.write("JUNK", 0, "ascii");
  junk.writeUInt32LE(size, 4);
  const body = Buffer.concat([base, junk]);
  body.writeUInt32LE(body.length - 8, 4);
  return body;
}
const FACE = faceBody();

const SITE = resolve(process.env.HFY_SITE || "../11ty");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
const COMPRESSIBLE = /^(text\/|application\/(json|manifest)|image\/svg)/;
const gzCache = new Map();

/** Serves SITE on a free loopback port: gzip for text (cached, so only the first request of a run pays for it), no-store, directories to index.html. */
function serveSite() {
  const server = createServer(async (req, res) => {
    try {
      let rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
      let file = join(SITE, rel);
      if (file !== SITE && !file.startsWith(SITE + sep)) { res.writeHead(403).end(); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
      const type = TYPES[extname(file)] || "application/octet-stream";
      let body = await readFile(file);
      const headers = { "Content-Type": type, "Cache-Control": "no-store" };
      if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
        if (!gzCache.has(file)) gzCache.set(file, gzipSync(body));
        body = gzCache.get(file);
        headers["Content-Encoding"] = "gzip";
      }
      headers["Content-Length"] = body.length;
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const CASES = [
  { people: 231, focusMs: 2500, longTaskMs: 100 },
  { people: 2000, focusMs: 3500, longTaskMs: 200 }
];

/** Starts the in-page probes before any script runs: the time the focus card is first visible, layout shifts, and long tasks. */
const probes = (page) => page.addInitScript(() => {
  window.__cls = 0;
  window.__long = [];
  window.__focusAt = null;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask", buffered: true });
  } catch { /* the observers are Chromium-only; the spec runs on Chromium */ }
  // "A visible focus card": the cards view's focus card has a box and sits in the first screen. Polled every frame, so the time is accurate to one frame.
  const tick = () => {
    const el = document.querySelector("family-navigator .hfy-nav__card--focus");
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0) { window.__focusAt = performance.now(); return; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: RTT_MS, downloadThroughput: DOWN_BYTES_PER_S, uploadThroughput: UP_BYTES_PER_S });
  return cdp;
}

async function stub(page, graphBody, sub) {
  const gzBytes = gzipSync(graphBody).length;
  const faces = [];
  const badFaces = [];
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", async (r) => { await sleep(wire(60)); return r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }); });
  await page.route("**/auth/session", async (r) => { await sleep(wire(80)); return r.fulfill({ json: { authenticated: true, sub, label: "Test Viewer" } }); });
  await page.route("**/person/graph.json", async (r) => { await sleep(wire(gzBytes)); return r.fulfill({ status: 200, contentType: "application/json", body: graphBody }); });
  await page.route("**/media/faces/**", async (r) => {
    // The app asks for `/media/faces/<token>.webp` and nothing else: no query, no size or variant path. A different path or a resize parameter
    // is answered 404 and recorded, so a change that asked for oversized or non-conforming crops fails the test. The body size below is fixed by
    // this stub (the 8 KB cap of a crop is a property of the published file, viz.md 5.4, not of the request), so the URL is what is asserted.
    const { pathname, search } = new URL(r.request().url());
    faces.push({ url: r.request().url(), pathname, search, bytes: FACE.length });
    if (!/^\/media\/faces\/[A-Za-z0-9_-]+\.webp$/.test(pathname) || search) {
      badFaces.push(r.request().url());
      return r.fulfill({ status: 404, body: "" });
    }
    await sleep(wire(FACE.length));
    return r.fulfill({ status: 200, contentType: "image/webp", body: FACE });
  });
  return { faces, badFaces, gzBytes };
}

for (const { people, focusMs, longTaskMs } of CASES) {
  test.describe(`${people} people, 4x CPU, slow 4G`, () => {
    // One retry (see the header): the budgets are wall-clock times on a shared machine.
    test.describe.configure({ mode: "serial", retries: RETRIES });
    test.setTimeout(90_000);
    const graph = synthGraph(people);
    const body = JSON.stringify(graph);
    const focus = synthFocus(graph);
    let served;
    test.beforeAll(async () => { served = await serveSite(); });
    test.afterAll(() => served?.server.close());

    test(`a visible focus card within ${focusMs / 1000} s, CLS at most 0.05, at most 24 faces in the first view of at most 8 KB each`, async ({ page }, info) => {
      await probes(page);
      const seen = await stub(page, body, focus);
      await throttle(page);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${served.origin}/tree/?focus=${focus}`, { waitUntil: "commit" });
      await page.waitForFunction(() => window.__focusAt !== null, null, { timeout: 60_000, polling: 50 });
      const focusAt = await page.evaluate(() => window.__focusAt);
      // the first view has settled: the load event is in, and every face that view asked for has come back
      await page.waitForLoadState("load", { timeout: 60_000 });
      await page.waitForTimeout(2000 + RTT_MS * 4);
      const cls = await page.evaluate(() => window.__cls);
      const faces = seen.faces.filter((f) => f.url.includes("/media/faces/"));
      const line = `${people} people (attempt ${info.retry + 1} of ${RETRIES + 1}): graph ${(seen.gzBytes / 1024).toFixed(1)} KB gzip, focus card at ${Math.round(focusAt)} ms of ${focusMs}, CLS ${cls.toFixed(4)}, ${faces.length} face requests`;
      info.annotations.push({ type: "perf", description: line });
      console.log(`[perf] ${line}`);
      expect(await page.locator("family-navigator .hfy-nav__card--focus .hfy-nav__name").innerText()).toBe(graph.people.find((p) => p.id === focus).name);
      expect(focusAt, "the focus card became visible").toBeGreaterThan(0);
      expect(focusAt).toBeLessThanOrEqual(focusMs);
      expect(cls).toBeLessThanOrEqual(0.05);
      expect(faces.length, "the first view asks for at least one face (the test is not vacuous)").toBeGreaterThan(0);
      expect(faces.length).toBeLessThanOrEqual(24);
      expect(seen.badFaces, "every face request is /media/faces/<token>.webp with no query").toEqual([]);
      for (const f of faces) expect(f.bytes).toBeLessThanOrEqual(8 * 1024); // the stub's fixed 6 KB body: the 8 KB cap of a crop, not a measure of the app
      // the images are drawn as 160 px crops (the card face is 160 x 160 at most), never a larger size
      const sizes = await page.locator("family-navigator img.hfy-nav__face").evaluateAll((els) => els.map((e) => [e.getAttribute("width"), e.getAttribute("height")].join("x")));
      expect([...new Set(sizes)]).toEqual(["160x160"]);
      // Lazy loading: a card scrolled out of view asks for nothing until it is near. The count above is the first view alone.
      const eager = await page.locator("family-navigator img.hfy-nav__face:not([loading='lazy'])").count();
      expect(eager, "every face image is loading=lazy").toBe(0);
    });

    test(`a re-centre's longest main-thread task is at most ${longTaskMs} ms`, async ({ page }, info) => {
      await probes(page);
      await stub(page, body, focus);
      await throttle(page);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${served.origin}/tree/?focus=${focus}`, { waitUntil: "commit" });
      await page.waitForFunction(() => window.__focusAt !== null, null, { timeout: 60_000, polling: 50 });
      await page.waitForLoadState("load", { timeout: 60_000 });
      await page.waitForTimeout(1500);
      // The probe itself works: a 150 ms busy loop in a timer task (not in the evaluate call itself) must show up as a long task, or "0 ms" below would mean nothing.
      await page.evaluate(() => { setTimeout(() => { const end = Date.now() + 150; while (Date.now() < end); }, 0); });
      await expect.poll(() => page.evaluate(() => Math.max(0, ...window.__long)), { timeout: 5000 }).toBeGreaterThanOrEqual(100);
      const nav = page.locator("family-navigator");
      const worst = [];
      // Walk the family: to a child, back to a parent, to a sibling, a partner and a child again. Each click is a re-centre of the cards, the outline
      // and the panel. synthFocus() gives a person who has all four roles, so the exact walk is asserted: a missing card is a failure, not a skip.
      const WALK = ["child", "parent", "sibling", "partner", "child"];
      const present = await nav.locator("button.hfy-nav__card[data-role]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-role")))]);
      for (const role of new Set(WALK)) expect(present, `the first view has a ${role} card to re-centre on`).toContain(role);
      for (const role of WALK) {
        const card = nav.locator(`button.hfy-nav__card[data-role="${role}"]`).first();
        if (!(await card.count())) continue; // after a re-centre the next role may sit behind "+N more"; the presence check above covers the first view
        const before = await nav.locator(".hfy-nav__card--focus").getAttribute("data-person");
        await page.evaluate(() => { window.__long = []; });
        await card.click();
        await expect(nav.locator(".hfy-nav__card--focus")).not.toHaveAttribute("data-person", before, { timeout: 10_000 });
        await page.waitForTimeout(700); // the 250 ms transition and the work after it
        worst.push(Math.max(0, ...(await page.evaluate(() => window.__long))));
      }
      const line = `${people} people (attempt ${info.retry + 1} of ${RETRIES + 1}): re-centre longest tasks ${worst.map((w) => Math.round(w)).join(", ")} ms of ${longTaskMs} (the long-task observer reports tasks of 50 ms or more)`;
      info.annotations.push({ type: "perf", description: line });
      console.log(`[perf] ${line}`);
      expect(worst.length, "the test re-centred at least four times").toBeGreaterThanOrEqual(4);
      for (const w of worst) expect(w).toBeLessThanOrEqual(longTaskMs);
    });
  });
}
