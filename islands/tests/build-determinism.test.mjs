// HFY-TSK-382: the islands build is a pure function of its inputs. Before this task about 1 build in 8 named three shared chunks
// differently (and so changed every ?v= stamp that follows them), which made `node build.mjs --check` and bundle.test.mjs's "committed
// outputs match a fresh build" fail on an unchanged tree.
//
// CAUSE (evidence: 4 of 14 builds on the unfixed code differed, and they differ only in `__toESM(x,1)` against `__toESM(x)` for the
// `react/jsx-runtime` import of lib/hfy-markdown.jsx, in the big shared chunk; chunk file names hash their content). A plugin that
// resolves to a bare path (hfyContentSanitizePolicy, hfyCommentsSanitizePolicy) gives esbuild a file with no module type, while
// esbuild's own resolver gives the same file ESM, because islands/package.json says "type": "module". esbuild parses a file once,
// under the first import to reach it, and imports are resolved in parallel, so a file reached both ways got either module type.
// FIX: hfyRoutedModules (kit-content.mjs) resolves every import of a plugin-routed wrapper to the same bare path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { HFY_KIT_PLUGINS, hfyRoutedModules, routedModuleOf } from "../kit-content.mjs";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const srcIslands = join(islandsDir, "src", "islands");
const entries = readdirSync(srcIslands).filter((f) => /\.jsx?$/.test(f)).sort().map((f) => join(srcIslands, f));

// The two virtual stylesheets of build.mjs, stubbed: this suite is about the JS graph, and they need none of their content.
const stubVirtualCss = {
  name: "stub-virtual-css",
  setup(b) {
    b.onResolve({ filter: /^hfy:(fonts|cloudscape-theme)$/ }, (args) => ({ path: args.path, namespace: "stub-virtual-css" }));
    b.onLoad({ filter: /.*/, namespace: "stub-virtual-css" }, () => ({ contents: "", loader: "css" }));
  }
};

// An import of a routed wrapper that no plugin claimed reaches esbuild's own resolver, and so gets the package's module type.
function resolverImportsOfRouted(seen) {
  return {
    name: "spy-resolver-imports",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith(".") && args.resolveDir) {
          if (routedModuleOf(args.resolveDir, args.path)) seen.push(`${relative(repo, args.importer)} imports ${args.path}`);
        }
        return undefined;
      });
    }
  };
}

const bundle = (order, plugins) => build({
  entryPoints: order,
  outdir: join(tmpdir(), "hfy-determinism-unused"),
  bundle: true, splitting: true, format: "esm", target: ["es2020", "safari15"], jsx: "automatic", minify: true,
  chunkNames: "chunks/[name]-[hash]", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css" },
  plugins, write: false, logLevel: "silent"
});
const treeHash = (out) => createHash("sha256").update(out.outputFiles.map((f) => `${basename(f.path)} ${createHash("sha256").update(f.contents).digest("hex")}`).sort().join("\n")).digest("hex");

test("every import of a plugin-routed markdown wrapper is resolved by the routing plugins, none by esbuild's own resolver", async () => {
  const seen = [];
  await bundle(entries, [stubVirtualCss, ...HFY_KIT_PLUGINS, resolverImportsOfRouted(seen)]);
  assert.deepEqual(seen, [], "a routed wrapper is imported by a relative path that hfyRoutedModules does not claim");
});

test("control: without hfyRoutedModules the same graph does import a routed wrapper through esbuild's own resolver (the old behaviour)", async () => {
  const seen = [];
  await bundle(entries, [stubVirtualCss, ...HFY_KIT_PLUGINS.filter((p) => p !== hfyRoutedModules), resolverImportsOfRouted(seen)]);
  assert.ok(seen.length > 0, "the old failure mode is no longer reachable; this guard can be simplified");
});

// Probabilistic by nature (the old race failed about 1 build in 4 to 8): the structural guard above, with its control, is the
// authoritative check; this one catches a different source of nondeterminism if one appears.
test("repeated builds of the same sources name and write the island bundles identically", async () => {
  const hashes = new Set();
  for (let i = 0; i < 16; i++) hashes.add(treeHash(await bundle(entries, [stubVirtualCss, ...HFY_KIT_PLUGINS])));
  assert.equal(hashes.size, 1, "two builds of the same sources named or wrote the island bundles differently");
});

test("a build from a clean js/islands writes the committed tree, twice over, and a second build writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hfy-determinism-"));
  try {
    const listing = (site) => readdirSync(join(site, "js", "islands"), { recursive: true }).sort().join("\n");
    const run = (site, ...extra) => spawnSync(process.execPath, ["build.mjs", "--site", site, ...extra], { cwd: islandsDir, encoding: "utf8" });
    const want = listing(join(repo, "11ty"));
    for (let i = 0; i < 2; i++) {
      const site = join(dir, `site${i}`);
      cpSync(join(repo, "11ty"), site, { recursive: true });
      rmSync(join(site, "js", "islands"), { recursive: true });
      const first = run(site);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(listing(site), want, `build ${i}: the chunk set differs from the committed one`);
      assert.match(run(site).stdout, /\(0 written\)/, `build ${i}: a second build wrote files`);
      assert.equal(run(site, "--check").status, 0, `build ${i}: --check fails right after a build`);
      assert.equal(readFileSync(join(site, "js", "islands", "person.js"), "utf8"), readFileSync(join(repo, "11ty", "js", "islands", "person.js"), "utf8"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
