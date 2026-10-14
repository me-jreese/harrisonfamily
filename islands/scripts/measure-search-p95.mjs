#!/usr/bin/env node
// HFY-TSK-318: Search 1.0 (@io-kit/search 1.0.1 local tier, searchV2) keystroke-to-paint p95 at 375 px.
//
//   cd islands && PW_PORT=18322 node scripts/measure-search-p95.mjs [--runs 3] [--json]
//
// Synthetic corpus only: CORPUS_SIZE generated people (the live index holds 231 people; only that count is used, no live name, date or id).
// The corpus requests are stubbed, the committed site (../11ty) is served by http-server, the viewport is 375 x 812.
//
// What one sample is. A capture-phase keydown on the window stamps t0. A MutationObserver on #hfy-search-v2 sees every change the key
// causes; after the LAST change, two requestAnimationFrame callbacks fire (the first runs before the next paint, the second after the
// frame that painted the change). That second callback's time minus t0 is the keystroke-to-paint latency. The script waits QUIET_MS
// after the last change before it reads the sample, so a debounce in the engine shows up in the number rather than hiding behind it.
// A keystroke with no mutation after QUIET_MS is re-read after LATE_MS more: a paint that lands then is kept in the percentile and
// counted as `late`; one that never changes anything is reported as `unchanged` and excluded, never counted as zero.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const CORPUS_SIZE = 231;
const KEYS_MIN = 30;
const QUIET_MS = 150;
const LATE_MS = 800;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const RUNS = Number(arg("runs", 3));
const port = Number(process.env.PW_PORT || 18322);
const origin = `http://127.0.0.1:${port}`;
const site = resolve(process.env.HFY_SITE || "../11ty");

// Synthetic people: 21 surnames x 11 forenames = 231. Every name is invented.
const SURNAMES = ["Quillfeather", "Brambleton", "Thistlewick", "Marrowby", "Ashgrove", "Pennywhistle", "Larkspur", "Holloway", "Fernsby", "Cobblestone", "Wrenfield", "Dunmore", "Elderwick", "Foxglove", "Gablethorpe", "Hazelmere", "Ironbridge", "Juniper", "Kestrel", "Lindenhall", "Mossbank"];
const FORENAMES = ["Mary", "Tomas", "Ada", "Felix", "Nora", "Hugo", "Ivy", "Otto", "Edith", "Silas", "Wren"];
const people = SURNAMES.flatMap((s, i) => FORENAMES.map((f, j) => ({
  grampsId: `I${String(i * FORENAMES.length + j + 1).padStart(4, "0")}`,
  displayName: `${f} ${s}`,
  isLiving: (i + j) % 5 === 0,
  lifespanSummary: (i + j) % 5 === 0 ? `b. ${1960 + ((i * 7 + j) % 40)}` : `${1850 + ((i * 3 + j) % 60)} – ${1920 + ((i * 5 + j) % 70)}`,
  primaryPhoto: null,
})));
if (people.length !== CORPUS_SIZE) throw new Error(`corpus is ${people.length}, expected ${CORPUS_SIZE}`);
const MANIFEST = { people };
const INDEX = { documents: people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };

// 3 words x ~11 chars typed one character at a time, cleared between: well over KEYS_MIN keystrokes per run.
const QUERIES = ["quillfeather", "thistlewick", "mary ashgrove", "pennywhistle"];

const percentile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const round = (n) => Math.round(n * 10) / 10;

async function serve() {
  const child = spawn("npx", ["http-server", site, "-p", String(port), "-a", "127.0.0.1", "-s", "-c-1"], { stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${origin}/`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("site server did not start");
}

async function oneRun(browser, runNo) {
  const ctx = await browser.newContext({ baseURL: origin, viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "test-token", grampsId: null, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); } catch {}
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: MANIFEST }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: INDEX }));
  await page.goto("/search/?hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  const input = root.getByRole("textbox").first();
  await input.waitFor();
  await page.locator(".io-search-header__count").filter({ hasText: /people|person/ }).first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => {
    const root = document.querySelector("#hfy-search-v2");
    const s = (window.__ks = { t0: 0, paint: 0, mutated: false, pending: 0 });
    window.addEventListener("keydown", () => { s.t0 = performance.now(); s.paint = 0; s.mutated = false; }, true);
    new MutationObserver(() => {
      s.mutated = true;
      const id = ++s.pending;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (id === s.pending) s.paint = performance.now(); }));
    }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  });

  const samples = []; let unchanged = 0; let late = 0; let keys = 0;
  for (const q of QUERIES) {
    await input.click();
    for (const ch of q) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(QUIET_MS + 50);
      let r = await page.evaluate(() => ({ ...window.__ks }));
      keys += 1;
      if (!r.mutated || !r.paint) {
        // Not seen within QUIET_MS: wait much longer before calling it a no-op. A paint that lands here is a slow one and stays in the percentile.
        await page.waitForTimeout(LATE_MS);
        r = await page.evaluate(() => ({ ...window.__ks }));
        if (!r.mutated || !r.paint) { unchanged += 1; continue; }
        late += 1;
      }
      samples.push(r.paint - r.t0);
    }
    await input.fill("");
    await page.waitForTimeout(QUIET_MS + 50);
  }
  const rows = await root.getByRole("link").count();
  await ctx.close();
  return { run: runNo, keystrokes: keys, measured: samples.length, unchanged, late, rowsAtEnd: rows, samples };
}

const server = await serve();
let out;
try {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
  const runs = [];
  for (let i = 1; i <= RUNS; i += 1) runs.push(await oneRun(browser, i));
  const browserVersion = browser.version();
  await browser.close();
  const all = runs.flatMap((r) => r.samples);
  for (const r of runs) if (r.measured < KEYS_MIN) throw new Error(`run ${r.run}: only ${r.measured} measured keystrokes, need ${KEYS_MIN}`);
  const per = runs.map((r) => ({ run: r.run, keystrokes: r.keystrokes, measured: r.measured, unchanged: r.unchanged, late: r.late, p50: round(percentile(r.samples, 50)), p95: round(percentile(r.samples, 95)), max: round(Math.max(...r.samples)) }));
  out = {
    measure: "search 1.0 keystroke-to-paint",
    package: "@io-kit/search 1.0.1 + @io-kit/search-ui 1.0.10 (local tier, searchV2)",
    viewport: "375x812 @2x",
    browser: `chrome (${browserVersion})`,
    corpusPeople: CORPUS_SIZE,
    runs: per,
    pooled: { n: all.length, p50: round(percentile(all, 50)), p95: round(percentile(all, 95)), p99: round(percentile(all, 99)), max: round(Math.max(...all)) },
    budget: "none in the design; recorded as the baseline",
  };
} finally {
  server.kill();
}
console.log(JSON.stringify(out, null, 2));
