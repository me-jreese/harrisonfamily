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
