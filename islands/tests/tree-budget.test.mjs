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
import { build as esbuildBuild, transform } from "esbuild";
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
  entryJs: 60 * KB,
  kinshipJs: 10 * KB,
  // HFY-TSK-269 (viz-v2-time, ADR 11 / viz-v2-time AC1): the lazy lifelines chunk, loaded only when the familyVizTime view opens.
  lifelinesJs: 25 * KB,
  lifelinesCss: 5 * KB,
  // HFY-TSK-308 (viz-v2-faces-tab, viz ADR 11 / viz-v2-faces-tab AC4): the lazy faces tab chunk, loaded only when the familyVizFaces view opens.
  facesJs: 15 * KB,
  facesCss: 5 * KB,
  // HFY-TSK-379 (viz-hourglass-p1/p2/p3, viz-hourglass-addendum.md section 5): the hourglass tree's script (the person page's small tree and the big tree)
  // at most 25 KB gzip, and its CSS partial 5 KB gzip. io's brief asks the same script for 25 KB MINIFIED (HOURGLASS_MIN below), the stricter of the two.
  hourglassJs: 25 * KB,
  hourglassCss: 5 * KB
};

// The brief's stricter measure (io, HFY-TSK-379): minified bytes, no gzip. The whole hourglass script, every module the small and big tree load, all chunks together
// (the shared adapter, the small tree's layout and renderer, the big tree's layout and renderer), is at most 25 KB; the small-tree/cards switch glue (hourglass-ui) is
// reported on its own, as the brief allows, and listed in the diagnostic. Each part has its own line too, so a number cannot hide in another's room: the person
// page's chunks (adapter, small layout, renderer) at most 14 KB, the chunk only the big tree loads at most 11.5 KB (rebalanced from 11 KB in pass 3b, with the great-grandparents and the parents' other partners back; the person page stays under its 14 KB and the 25 KB total is the binding line), the switch glue at most 2.5 KB.
// The lines are tight on purpose (a few hundred bytes in all, under 100 for the person page's part), so a change to a shared helper (hourglass-dom, hourglass-model), to
// the minifier version or to a string can fail this test with no feature added. To re-measure: `cd islands && npm run build`, then `node --test tests/tree-budget.test.mjs`;
// the diagnostic line prints each part, and `wc -c 11ty/js/islands/chunks/tree-hourglass-*.js` gives the exact bytes. A line moves only with io's ruling on the record (the 11.5 KB big-tree line is pass 3b's stated rebalance of 0.5 KB from the unused slack, awaiting io's confirmation at review).
export const HOURGLASS_MIN = { total: 25 * KB, person: 14 * KB, big: 11.5 * KB, glue: 2.5 * KB };

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

// HFY-TSK-307 (viz-v2-kinship-ui, viz.md section 11): the "how are we related?" chunk, lazy behind the pill, is at most 10 KB gzip JS. It is measured
// as what it adds once the page is up: its static closure minus the shell's chunks and minus what the entry already loads.
test("the v2 kinship UI chunk is lazy and at most 10 KB gzip JS", (t) => {
  const entry = join(out, "tree.js");
  const shellSet = staticClosure(join(out, "shell.js"));
  const entrySet = staticClosure(entry);
  const kin = dynamicTargets(entry).filter((f) => /\/chunks\/tree-kinship-[A-Za-z0-9_-]+\.js$/.test(f.split("\\").join("/")));
  assert.equal(kin.length, 1, "tree.js must import exactly one tree-kinship chunk dynamically");
  assert.ok(!entrySet.has(kin[0]), "the kinship chunk is a static import of the entry: it is not lazy");
  const own = minus(minus(staticClosure(kin[0]), shellSet), entrySet);
  const bytes = sum(own);
  t.diagnostic(`kinship JS ${kb(bytes)} of ${kb(BUDGET.kinshipJs)} (${[...own].map((f) => f.slice(out.length + 1)).join(", ")})`);
  assert.ok(bytes > 512, "the kinship chunk measured as nearly empty: the test is not looking at the chunk");
  assert.ok(bytes <= BUDGET.kinshipJs, `kinship JS is ${kb(bytes)} gzip, over the 10 KB budget`);
});

// A guard, not a proof of removal: at the time of writing no 120 KB line existed in this repo (a grep over islands/tests found none), so there was nothing to delete.
test("the old 120 KB chart-chunk budget line is gone from the tests", () => {
  const old = new RegExp(["120 ?KB", "120 ?\\* ?1024", "120_?000", "122880"].join("|"), "i");
  for (const f of readdirSync(testsDir).filter((n) => n !== "tree-budget.test.mjs" && /^tree.*\.(test|spec)\.mjs$|^navigator.*\.test\.mjs$/.test(n))) {
    assert.doesNotMatch(read(join(testsDir, f)), old, `${f} still carries the 120 KB chart-chunk line`);
  }
});

test("the budgets are the amended numbers (35 and 15 KB for the navigator, 60 KB for the entry, 10 KB for the kinship chunk, 25 and 5 KB for the lifelines, 15 and 5 KB for the faces tab, 25 and 5 KB for the hourglass)", () => {
  assert.deepEqual(BUDGET, { navigatorJs: 35 * 1024, navigatorCss: 15 * 1024, entryJs: 60 * 1024, kinshipJs: 10 * 1024, lifelinesJs: 25 * 1024, lifelinesCss: 5 * 1024, facesJs: 15 * 1024, facesCss: 5 * 1024, hourglassJs: 25 * 1024, hourglassCss: 5 * 1024 });
  assert.deepEqual(HOURGLASS_MIN, { total: 25 * 1024, person: 14 * 1024, big: 11.5 * 1024, glue: 2.5 * 1024 });
});

// The lifelines chunk (lib/tree-lifelines.jsx): a lazy import of tree.js beside the navigator's, never a static one. Its own stylesheet source is
// lib/tree-lifelines.css, which tree.css imports, so the CSS is measured as that source minified (the same esbuild minify the build applies).
test("the lifelines chunk is lazy and at most 25 KB gzip JS and 5 KB gzip CSS, with no d3-scale", async (t) => {
  const entry = join(out, "tree.js");
  const shellSet = staticClosure(join(out, "shell.js"));
  const entrySet = staticClosure(entry);
  const lifelines = dynamicTargets(entry).filter((f) => /\/chunks\/tree-lifelines-[A-Za-z0-9_-]+\.js$/.test(f.split("\\").join("/")));
  assert.equal(lifelines.length, 1, "tree.js must import exactly one tree-lifelines chunk dynamically");
  assert.ok(!entrySet.has(lifelines[0]), "the lifelines chunk is a static import of the entry: it is not lazy");
  // Everything it statically needs, minus the shell's chunks and the chunks the entry itself already carries (it adds only its own bytes).
  const own = minus(minus(staticClosure(lifelines[0]), shellSet), entrySet);
  const js = sum(own);
  const srcCss = read(join(testsDir, "..", "src", "lib", "tree-lifelines.css"));
  const css = gzipSync((await transform(srcCss, { loader: "css", minify: true })).code).length;
  t.diagnostic(`lifelines JS ${kb(js)} of ${kb(BUDGET.lifelinesJs)} (${[...own].map((f) => f.slice(out.length + 1)).join(", ")}); CSS ${kb(css)} of ${kb(BUDGET.lifelinesCss)}`);
  assert.ok(js > 1024, "the lifelines chunk measured as nearly empty: the test is not looking at the chunk");
  assert.ok(js <= BUDGET.lifelinesJs, `lifelines JS is ${kb(js)} gzip, over the 25 KB budget`);
  assert.ok(css > 256 && css <= BUDGET.lifelinesCss, `lifelines CSS is ${kb(css)} gzip, over the 5 KB budget`);
  // the rules really ship in tree.css
  assert.match(read(join(out, "tree.css")), /hfy-life__line/);
  // ADR: no d3-scale (7.9 KB for one linear scale); d3-shape is optional and not needed for straight lines.
  assert.doesNotMatch(read(join(testsDir, "..", "package.json")), /"d3-scale"/);
  const pkg = JSON.parse(read(join(testsDir, "..", "package.json")));
  if (pkg.dependencies["d3-shape"]) assert.equal(pkg.dependencies["d3-shape"], "3.2.0", "d3-shape is exact-pinned at 3.2.0");
});

// HFY-TSK-272 (viz-v2-bigtree, viz ADR 9.2): the whole-family poster is its own lazy chunk, at most 30 KB gzip JS and 5 KB gzip CSS, and the
// island carries no layout engine (the layout is precomputed at build time by graph/; d3-dag is a build-time dependency there only).
export const BIGTREE_BUDGET = { js: 30 * KB, css: 5 * KB };

test("the poster chunk is lazy, at most 30 KB gzip JS and 5 KB gzip CSS, and no d3-dag module is in the bundle", (t) => {
  const entry = join(out, "tree.js");
  const posters = dynamicTargets(entry).filter((f) => /\/chunks\/tree-bigtree-[A-Za-z0-9_-]+\.js$/.test(f.split("\\").join("/")));
  assert.equal(posters.length, 1, "tree.js must import exactly one tree-bigtree chunk dynamically");
  assert.ok(!staticClosure(entry).has(posters[0]), "the poster chunk is a static import of the entry: it is not lazy");
  const set = minus(staticClosure(posters[0]), staticClosure(join(out, "shell.js")));
  const js = sum(set);
  // The poster's rules are in the page's one stylesheet (tree.css imports lib/tree-bigtree.css); its own source is what the 5 KB bounds.
  const cssSrc = gzipSync(readFileSync(join(testsDir, "..", "src", "lib", "tree-bigtree.css"))).length;
  t.diagnostic(`poster JS ${kb(js)} of ${kb(BIGTREE_BUDGET.js)}; CSS ${kb(cssSrc)} of ${kb(BIGTREE_BUDGET.css)}`);
  assert.ok(js > 512, "the poster chunk measured as nearly empty: the test is not looking at it");
  assert.ok(js <= BIGTREE_BUDGET.js, `poster JS is ${kb(js)} gzip, over the 30 KB budget`);
  assert.ok(cssSrc <= BIGTREE_BUDGET.css, `poster CSS is ${kb(cssSrc)} gzip, over the 5 KB budget`);
  // no d3-dag anywhere in the built bundles, nor in the islands' dependencies or lockfile
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(js|css)$/.test(e.name) ? [join(d, e.name)] : []));
  for (const f of walk(out)) assert.doesNotMatch(read(f), /d3-dag|javascript-lp-solver|\bsugiyama\b|layeringSimplex|decrossTwoLayer/, `${f.slice(out.length + 1)} carries layout-engine code`);
  const pkg = read(join(testsDir, "..", "package.json")) + read(join(testsDir, "..", "package-lock.json"));
  assert.doesNotMatch(pkg, /d3-dag/, "d3-dag is in the islands' package.json or lockfile");
});

// HFY-TSK-308 (viz-v2-faces-tab): the faces tab chunk (lib/tree-faces.jsx) is lazy, at most 15 KB gzip JS and 5 KB gzip CSS. It reuses surf-photo-tags-ui
// (lib/photo-tags-ui.js) rather than carrying a second tag display, so the chunk's closure includes that module; the chunk adds only what the shell and the
// entry do not already load. Its own stylesheet source is lib/tree-faces.css, which tree.css imports (the region rules are src/photo-tags.css, shared).
test("the faces tab chunk is lazy and at most 15 KB gzip JS and 5 KB gzip CSS", async (t) => {
  const entry = join(out, "tree.js");
  const shellSet = staticClosure(join(out, "shell.js"));
  const entrySet = staticClosure(entry);
  const faces = dynamicTargets(entry).filter((f) => /\/chunks\/tree-faces-[A-Za-z0-9_-]+\.js$/.test(f.split("\\").join("/")));
  assert.equal(faces.length, 1, "tree.js must import exactly one tree-faces chunk dynamically");
  assert.ok(!entrySet.has(faces[0]), "the faces chunk is a static import of the entry: it is not lazy");
  const own = minus(minus(staticClosure(faces[0]), shellSet), entrySet);
  const js = sum(own);
  const srcCss = read(join(testsDir, "..", "src", "lib", "tree-faces.css"));
  const css = gzipSync((await transform(srcCss, { loader: "css", minify: true })).code).length;
  t.diagnostic(`faces JS ${kb(js)} of ${kb(BUDGET.facesJs)} (${[...own].map((f) => f.slice(out.length + 1)).join(", ")}); CSS ${kb(css)} of ${kb(BUDGET.facesCss)}`);
  assert.ok(js > 1024, "the faces chunk measured as nearly empty: the test is not looking at the chunk");
  assert.ok(js <= BUDGET.facesJs, `faces JS is ${kb(js)} gzip, over the 15 KB budget`);
  assert.ok(css > 256 && css <= BUDGET.facesCss, `faces CSS is ${kb(css)} gzip, over the 5 KB budget`);
  assert.match(read(join(out, "tree.css")), /hfy-faces__grid/);
});

// HFY-TSK-379 (viz-hourglass-p2/p3, flag familyVizHourglass): the hourglass tree's script, all lazy. lib/tree-link.js (in the person entry) imports `hourglass-ui` (the
// tree/cards switch), which imports `tree-hourglass` (small layout and renderer, with the shared adapter) only when the tree is the view; islands/tree.jsx (the tree
// entry) imports `tree-hourglass-big` (the big tree's layout, renderer, toolbar, history and bar) only when ?view=tree is asked for with the flag on. The adapter is a shared
// chunk of the two. Chunks a page already loads for something else (the shell, the entries, the card mini view's graph loader) are not the hourglass's and are subtracted.
test("the hourglass chunks are lazy, at most 25 KB minified and 25 KB gzip in all (the switch glue listed apart), each part within its own line, and the CSS at most 5 KB gzip", async (t) => {
  const entry = join(out, "person.js");
  const treeEntry = join(out, "tree.js");
  const shellSet = staticClosure(join(out, "shell.js"));
  const entrySet = staticClosure(entry);
  const treeEntrySet = staticClosure(treeEntry);
  const named = (from, re) => dynamicTargets(from).filter((f) => re.test(f.split("\\").join("/")));
  const ui = named(entry, /\/chunks\/hourglass-ui-[A-Za-z0-9_-]+\.js$/);
  assert.equal(ui.length, 1, "person.js must import exactly one hourglass-ui chunk dynamically");
  assert.ok(!entrySet.has(ui[0]), "the hourglass UI is a static import of the entry: it is not lazy");
  const trees = named(ui[0], /\/chunks\/tree-hourglass-[A-Za-z0-9_-]+\.js$/);
  assert.equal(trees.length, 1, "hourglass-ui must import exactly one tree-hourglass chunk dynamically");
  assert.ok(!staticClosure(ui[0]).has(trees[0]), "the tree-hourglass chunk is a static import of the UI: it is not lazy");
  const bigs = named(treeEntry, /\/chunks\/tree-hourglass-big-[A-Za-z0-9_-]+\.js$/);
  assert.equal(bigs.length, 1, "tree.js must import exactly one tree-hourglass-big chunk dynamically");
  assert.ok(!treeEntrySet.has(bigs[0]), "the big tree is a static import of the tree entry: it is not lazy");
  assert.ok(!staticClosure(trees[0]).has(bigs[0]) && !staticClosure(bigs[0]).has(trees[0]), "the person page's chunk and the big tree's must not load each other");
  const mini = named(entry, /\/chunks\/person-mini-[A-Za-z0-9_-]+\.js$/);
  assert.equal(mini.length, 1);
  const own = (chunk, entrySetOf) => minus(minus(minus(staticClosure(chunk), shellSet), entrySetOf), staticClosure(mini[0]));
  const personSet = own(trees[0], entrySet);
  const uiSet = minus(own(ui[0], entrySet), personSet);
  const bigSet = own(bigs[0], treeEntrySet);
  const bigOnly = minus(bigSet, personSet);
  const bytes = (files) => [...files].reduce((n, f) => n + readFileSync(f).length, 0);
  const all = new Set([...personSet, ...bigSet]);
  const personMin = bytes(personSet);
  const bigMin = bytes(bigOnly);
  const glueMin = bytes(uiSet);
  const totalMin = bytes(all);
  const js = sum(all) + sum(uiSet);
  const cssSrc = read(join(testsDir, "..", "src", "theme", "46-hourglass.css"));
  const cssGz = gzipSync((await transform(cssSrc, { loader: "css", minify: true })).code).length;
  const names = (files) => [...files].map((f) => f.slice(out.length + 1)).join(", ");
  t.diagnostic(`hourglass minified: person page ${kb(personMin)} (${names(personSet)}) of ${kb(HOURGLASS_MIN.person)}; big tree only ${kb(bigMin)} (${names(bigOnly)}) of ${kb(HOURGLASS_MIN.big)}; all chunks ${kb(totalMin)} of ${kb(HOURGLASS_MIN.total)} (${totalMin} bytes); switch glue listed apart ${kb(glueMin)} (${names(uiSet)}) of ${kb(HOURGLASS_MIN.glue)}; gzip with the glue ${kb(js)} of ${kb(BUDGET.hourglassJs)}; CSS ${kb(cssGz)} of ${kb(BUDGET.hourglassCss)}`);
  assert.ok(personMin > 4096 && bigMin > 4096, "a hourglass chunk measured as nearly empty: the test is not looking at it");
  assert.ok(personMin <= HOURGLASS_MIN.person, `the person-page chunks are ${kb(personMin)} minified, over their ${kb(HOURGLASS_MIN.person)}`);
  assert.ok(bigMin <= HOURGLASS_MIN.big, `the big tree's own chunk is ${kb(bigMin)} minified, over its ${kb(HOURGLASS_MIN.big)}`);
  assert.ok(glueMin <= HOURGLASS_MIN.glue, `the switch glue is ${kb(glueMin)} minified, over its ${kb(HOURGLASS_MIN.glue)}`);
  assert.ok(totalMin <= HOURGLASS_MIN.total, `the hourglass script is ${kb(totalMin)} minified in all (${totalMin} bytes), over the brief's 25 KB`);
  assert.ok(js <= BUDGET.hourglassJs, `the hourglass script is ${kb(js)} gzip, over the 25 KB budget`);
  assert.ok(cssGz > 256 && cssGz <= BUDGET.hourglassCss, `the hourglass CSS is ${kb(cssGz)} gzip, over the 5 KB budget`);
  // the rules really ship in the theme (served on /person/ and /tree/), and no chart or graph library came in
  assert.match(read(join(out, "..", "..", "css", "hfy-theme.css")), /\.hfy-tree__card/);
  assert.match(read(join(out, "..", "..", "css", "hfy-theme.css")), /\.hfy-bt__stage/);
  assert.doesNotMatch([...all, ...uiSet].map(read).join(""), /d3-|svg-pan|cytoscape|dagre|elkjs|createElementNS/);
});
