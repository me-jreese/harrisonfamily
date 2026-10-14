// HFY-TSK-302 (viz-mvp-visual-perf) AC1 and AC3: the size budgets of the Family Card Navigator (viz.md section 11 as amended by Q2-13, io 2026-10-13;
// viz ADR section 5) and the proof that no person data is in a static file.
//
//   navigator chunk (the lazy chart chunk, <family-navigator>)     at most 35 KB gzip JS and 15 KB gzip CSS
//   island entry (tree.js and its static chunks, excluding the chunks the shell already loads, React among them)   at most 60 KB gzip
//   the old 120 KB chart-chunk line is gone
//
// The test reads the built site (the committed 11ty/, or HFY_SITE=<dir> for a scratch `node build.mjs --site <dir>` build), so run the build
// first. KB is 1,024 bytes and gzip is zlib's default level, the ADR's measure. A miss fails here; changing a number needs an amendment to the
// ADR that io approves, never an edit of this file alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testsDir, "..", "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(repo, "11ty");
const out = join(site, "js", "islands");
const KB = 1024;

export const BUDGET = {
  navigatorJs: 35 * KB,
  navigatorCss: 15 * KB,
  entryJs: 60 * KB
};

const read = (f) => readFileSync(f, "utf8");
const gz = (f) => gzipSync(readFileSync(f)).length;

// esbuild's output is minified ESM: `import{a as b}from"./chunks/x.js"`, `import"./chunks/x.js"` and `export{..}from"./x.js"` are static edges;
// `import("./chunks/x.js")` is a dynamic one and is not followed.
const STATIC_EDGE = /(?:\bimport|\bexport)\s*(?:[^"';()]*?\bfrom\s*)?"(\.\/[^"]+)"/g;
const DYNAMIC_EDGE = /\bimport\(\s*"(\.\/[^"]+)"\s*\)/g;

/** Every file reachable from `file` over static imports (itself included), as absolute paths. */
function staticClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of read(file).matchAll(STATIC_EDGE)) staticClosure(resolve(dirname(file), m[1]), seen);
  return seen;
}
const dynamicTargets = (file) => [...read(file).matchAll(DYNAMIC_EDGE)].map((m) => resolve(dirname(file), m[1]));
const kb = (n) => `${(n / KB).toFixed(1)} KB`;
const sum = (files) => [...files].reduce((n, f) => n + gz(f), 0);
const minus = (a, b) => new Set([...a].filter((f) => !b.has(f)));

function measure() {
  const entry = join(out, "tree.js");
  const shell = join(out, "shell.js");
  assert.ok(existsSync(entry) && existsSync(shell), `${out} has no tree.js or shell.js; did you run npm run build?`);
  const shellSet = staticClosure(shell);
  const entrySet = staticClosure(entry);
  const charts = dynamicTargets(entry).filter((f) => /\/chunks\/tree-chart-[A-Za-z0-9_-]+\.js$/.test(f.split("\\").join("/")));
  assert.equal(charts.length, 1, "tree.js must import exactly one tree-chart chunk dynamically");
  const chart = charts[0];
  assert.ok(!entrySet.has(chart), "the navigator chunk is a static import of the entry: it is not lazy");
  // The navigator chunk with every chunk it statically needs, minus what the shell already loads (React and the kit shell). Chunks it shares with
  // the entry count here and in the entry: the sums over-count rather than under-count.
  const chartSet = minus(staticClosure(chart), shellSet);
  const entryOwn = minus(entrySet, shellSet);
  const css = join(out, "tree.css");
  assert.ok(existsSync(css), "no tree.css");
  return { entry, chart, entryOwn, chartSet, entryJs: sum(entryOwn), navigatorJs: sum(chartSet), navigatorCss: gz(css) };
}

test("the navigator chunk is at most 35 KB gzip JS and 15 KB gzip CSS", (t) => {
  const m = measure();
  t.diagnostic(`navigator JS ${kb(m.navigatorJs)} of ${kb(BUDGET.navigatorJs)} (${[...m.chartSet].map((f) => f.slice(out.length + 1)).join(", ")}); CSS ${kb(m.navigatorCss)} of ${kb(BUDGET.navigatorCss)}`);
  assert.ok(m.navigatorJs > 1024, "the navigator chunk measured as nearly empty: the test is not looking at the chunk");
  assert.ok(m.navigatorJs <= BUDGET.navigatorJs, `navigator JS is ${kb(m.navigatorJs)} gzip, over the 35 KB budget`);
  // tree.css is the page's one stylesheet: the navigator's rules plus the kit and page rules, so it bounds the navigator's CSS from above.
  assert.ok(m.navigatorCss > 512, "tree.css measured as nearly empty");
  assert.ok(m.navigatorCss <= BUDGET.navigatorCss, `the CSS is ${kb(m.navigatorCss)} gzip, over the 15 KB budget`);
});

test("the island entry and its own chunks are at most 60 KB gzip, excluding the chunks the shell already loads", (t) => {
  const m = measure();
  t.diagnostic(`entry JS ${kb(m.entryJs)} of ${kb(BUDGET.entryJs)} (${[...m.entryOwn].map((f) => f.slice(out.length + 1)).join(", ")})`);
  assert.ok(m.entryJs > 512, "the entry measured as nearly empty");
  assert.ok(m.entryJs <= BUDGET.entryJs, `the entry is ${kb(m.entryJs)} gzip, over the 60 KB budget`);
  // the shared React chunk is the shell's, not the entry's: it must not be counted (a regression here would mean the subtraction broke)
  const shellSet = staticClosure(join(out, "shell.js"));
  for (const f of m.entryOwn) assert.ok(!shellSet.has(f), `${f} is loaded by the shell but counted in the entry`);
});

test("the old 120 KB chart-chunk budget line is gone from the tests", () => {
  const old = new RegExp(["120 ?KB", "120 ?\\* ?1024", "120_?000", "122880"].join("|"), "i");
  for (const f of readdirSync(testsDir).filter((n) => n !== "tree-budget.test.mjs" && /^tree.*\.(test|spec)\.mjs$|^navigator.*\.test\.mjs$/.test(n))) {
    assert.doesNotMatch(read(join(testsDir, f)), old, `${f} still carries the 120 KB chart-chunk line`);
  }
});

test("the budgets are the amended numbers (35 and 15 KB for the navigator, 60 KB for the entry)", () => {
  assert.deepEqual(BUDGET, { navigatorJs: 35 * 1024, navigatorCss: 15 * 1024, entryJs: 60 * 1024 });
});
