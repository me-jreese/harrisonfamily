// HFY-TSK-145 (viz-mvp-visual) AC1: the navigator chunk holds only our own modules. <family-navigator> is framework-free and has no
// third-party runtime module; family-chart, Topola, Olli and d3 are not in it (viz ADR 4.1, client-license-gate). The kit Sheet and React
// belong to ChartView, the island's wrapper, and are the only packages it may pull in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(repo, "11ty");

async function inputsOf(entry) {
  const r = await build({
    entryPoints: [join(islandsDir, entry)],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "css" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent"
  });
  // Modules that put code in the output: a file esbuild read and then tree-shook away (a barrel's unused re-exports) is not in the chunk.
  const used = new Set();
  for (const out of Object.values(r.metafile.outputs)) for (const [p, v] of Object.entries(out.inputs)) if (v.bytesInOutput > 0) used.add(p.split(sep).join("/"));
  return [...used];
}

const BANNED = /family-chart|topola|olli|(^|\/)d3([-/]|$)|data-navigator|elkjs|d3-dag/i;

test("<family-navigator> and its model import only our own modules (no package at all)", async () => {
  const inputs = await inputsOf("src/lib/family-navigator.js");
  assert.ok(inputs.length >= 3, inputs.join(", "));
  const own = inputs.filter((p) => p.startsWith("src/lib/"));
  assert.deepEqual(inputs.filter((p) => !p.startsWith("src/lib/")), [], "a module outside src/lib is in the element's bundle");
  assert.ok(own.includes("src/lib/family-navigator.js") && own.includes("src/lib/navigator-model.js"));
  assert.ok(!inputs.some((p) => /node_modules|react/.test(p)), "the element must not pull in React or any package");
});

test("the element's source holds no React, no shadow root and no import from a package", () => {
  for (const f of ["family-navigator.js", "navigator-model.js"]) {
    const src = readFileSync(join(islandsDir, "src", "lib", f), "utf8");
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /attachShadow|from "react|from 'react|createRoot|useState/, f);
    for (const m of src.matchAll(/^import .* from "([^"]+)"/gm)) assert.match(m[1], /^\.\//, `${f} imports ${m[1]}`);
  }
});

test("the navigator chunk (ChartView) pulls in React and the kit Sheet only, and no tree-library module", async () => {
  const inputs = await inputsOf("src/lib/tree-chart.jsx");
  assert.ok(inputs.includes("src/lib/family-navigator.js"));
  for (const p of inputs) {
    assert.doesNotMatch(p, BANNED, `${p} is a banned tree-library module`);
    if (!p.startsWith("src/") && !p.startsWith("../shared/")) assert.match(p, /^(\.\.\/)*(node_modules\/)?(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler|@io-kit\/shell)(\/|$)/, `${p}: not ours, not React and not the kit shell`);
  }
});

test("the built island loads the chart as a lazy chunk that holds <family-navigator>", () => {
  const out = join(site, "js", "islands");
  const tree = readFileSync(join(out, "tree.js"), "utf8");
  const chunks = readdirSync(join(out, "chunks")).filter((f) => f.endsWith(".js"));
  const hit = chunks.filter((f) => readFileSync(join(out, "chunks", f), "utf8").includes("hfy-focus"));
  assert.equal(hit.length, 1, `exactly one chunk holds the element (found ${hit.join(", ") || "none"}); did you run npm run build?`);
  assert.ok(tree.includes(`chunks/${hit[0]}`) || /import\("\.\/chunks\//.test(tree), "tree.js does not import the chunk dynamically");
  assert.ok(!tree.includes("hfy-focus"), "the element is in the entry, not in a lazy chunk");
  assert.doesNotMatch(readFileSync(join(out, "chunks", hit[0]), "utf8"), /family-chart|topola|\bolli\b|d3-dag/i);
  assert.ok(relative(out, join(out, "chunks", hit[0])).startsWith("chunks"));
});

// HFY-TSK-300 (viz-mvp-visual-nav) AC6: the navigation model (six buttons, arrow keys, touch, motion) is our own code, so data-navigator@3.0.0 is
// not adopted and Olli is not added. If a later task adopts data-navigator it adds its client-license-gate override in the same PR and replaces
// this test with one that lists it.
test("data-navigator and Olli are in no manifest, no lockfile entry and no navigator bundle", async () => {
  const pkg = JSON.parse(readFileSync(join(islandsDir, "package.json"), "utf8"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.overrides });
  assert.deepEqual(names.filter((n) => /data-navigator|olli|ua-parser-js/i.test(n)), []);
  const lock = JSON.parse(readFileSync(join(islandsDir, "package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.packages || {}).filter((n) => /node_modules\/(data-navigator|@?olli|ua-parser-js)/i.test(n)), []);
  for (const entry of ["src/lib/family-navigator.js", "src/lib/tree-chart.jsx"]) {
    const inputs = await inputsOf(entry);
    assert.deepEqual(inputs.filter((p) => /data-navigator|olli|ua-parser-js/i.test(p)), [], entry);
  }
  const out = join(site, "js", "islands");
  for (const f of [join(out, "tree.js"), ...readdirSync(join(out, "chunks")).filter((f) => f.endsWith(".js")).map((f) => join(out, "chunks", f))]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /data-navigator|ua-parser|@olli|\bolli\b/i, f);
  }
});

test("the navigation is the element's own code: no touch, pointer or wheel listener, no live region, and no single-character shortcut", () => {
  const src = readFileSync(join(islandsDir, "src", "lib", "family-navigator.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /touchstart|touchmove|touchend|pointerdown|pointermove|setPointerCapture|["']wheel["']/);
  assert.doesNotMatch(src, /aria-live|role["']?:\s*["'](status|alert|log)/);
  // the handler reads e.key only through two lookup tables, and every key those name is an arrow, Home or End
  const reads = [...src.matchAll(/\{([^{}]*)\}\[e\.key\]/g)];
  assert.equal(reads.length, 2, "e.key is read outside the two lookup tables");
  assert.equal([...src.matchAll(/e\.key/g)].length, 2);
  for (const r of reads) for (const k of r[1].split(",").map((x) => x.split(":")[0].trim())) assert.match(k, /^(Arrow(Up|Down|Left|Right)|Home|End)$/, `unexpected key ${k}`);
});
