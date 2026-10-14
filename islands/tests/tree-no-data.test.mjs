// HFY-TSK-302 (viz-mvp-visual-perf) AC3: the card renders from the fetched, gated graph, so no person data is in a static file and the service
// worker holds no /person/ route (viz.md section 11; viz ADR section 6, "no service-worker cache": gated data is private, no-store).
//
// The test reads the built site (the committed 11ty/, or HFY_SITE=<dir>). Its data is synthetic: every id and name of the graph-synth.mjs graphs
// and of the tree fixtures must be absent from the built page, which is the only way a build step that inlined a graph could be caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { synthGraph, synthTokens } from "./fixtures/graph-synth.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(testsDir, "..", "..", "11ty");
const page = readFileSync(join(site, "tree", "index.html"), "utf8");
const sw = readFileSync(join(site, "sw.js"), "utf8");

// Only tokens that site copy cannot contain by chance: the generated ids (I7xxx) and the full "Given Surname" names. The bare given names and
// surnames are left out on purpose: a short word of the invented pools ("Alder", "Sparrow") could one day appear in page copy and fail this test
// with no data leaked. A graph inlined into the page carries the ids and the full names, so these are the tokens that prove it.
function tokensOf(graph) {
  return graph.people.flatMap((p) => [p.id, p.name]);
}

test("the built /tree/ page holds no synthetic id or name from the 231 or 2,000 person graphs", () => {
  const tokens = new Set([...tokensOf(synthGraph(231)), ...tokensOf(synthGraph(2000)), ...synthTokens(synthGraph(231))]);
  assert.ok(tokens.size > 500, "the token list is too small to prove anything");
  // The page is static, so this passes unless a build step inlined a graph, and that is all it claims. The island mount keeps it from being a scan of an empty file.
  assert.match(page, /data-island="tree"/, "the built /tree/ page is the island's page");
  const hits = [...tokens].filter((t) => new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`).test(page));
  assert.deepEqual(hits.slice(0, 5), []);
});

test("the built /tree/ page holds no synthetic id or name from the tree fixtures", () => {
  const dir = join(testsDir, "fixtures");
  const files = readdirSync(dir).filter((f) => /^tree-graph-.*\.json$/.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const p of g.people) {
      assert.ok(!page.includes(p.id), `${f}: ${p.id} is in the page`);
      assert.ok(!page.includes(p.name), `${f}: ${p.name} is in the page`);
    }
  }
});

test("the built /tree/ page inlines no graph: no JSON script block, no graph keys, no data attribute that carries the people", () => {
  assert.doesNotMatch(page, /<script[^>]*type=["']application\/(ld\+)?json["']/i);
  assert.doesNotMatch(page, /schemaVersion|"people"\s*:|"unions"\s*:|"generations"\s*:|__HFY_GRAPH__|window\.__[A-Z_]*GRAPH/);
  assert.doesNotMatch(page, /\bdata-(graph|people|tree-data)\s*=/);
  // the page may name the endpoint nowhere: the island fetches it
  assert.doesNotMatch(page, /graph\.json/);
});

test("sw.js has no /person/ route and does not touch the graph", () => {
  assert.doesNotMatch(sw, /\/person\//);
  assert.doesNotMatch(sw, /person\/graph|graph\.json|\/media\/faces/);
  // not even as a pattern: nothing in the worker matches a person path
  assert.doesNotMatch(sw, /["'`/]person["'`/]/);
});
