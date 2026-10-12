// HFY-TSK-064: islands build. Every src/islands/*.jsx is an entry -> ../11ty/js/islands/<name>.js (+ <name>.css).
// Shared code (react, @io-kit/*) is split into chunks. Output is COMMITTED (HFY-R58): the deploy syncs 11ty/ as-is,
// so rebuild (scripts/ci/build-islands.sh or `npm run build`) and commit 11ty/js/islands/ with every islands/ change.
// `node build.mjs --check` rebuilds in memory and exits 1 if the committed output differs from the source (stale bundle).
import { build } from "esbuild";
import { copyFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "11ty", "js", "islands");
const notifySw = join(here, "node_modules", "@io-kit", "notify", "sw", "notify-sw.js");
const entries = readdirSync(join(here, "src", "islands")).filter((f) => /\.jsx?$/.test(f)).map((f) => join(here, "src", "islands", f));
const options = {
  entryPoints: entries,
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  target: ["es2020", "safari15"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "css" },
  logLevel: "info"
};

function listFiles(dir) {
  let files = [];
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      files = files.concat(d.isDirectory() ? listFiles(p) : [p]);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return files;
}

if (process.argv.includes("--check")) {
  const res = await build({ ...options, write: false, logLevel: "silent" });
  const expected = new Map(res.outputFiles.map((f) => [relative(out, f.path).split(sep).join("/"), Buffer.from(f.contents)]));
  expected.set("notify-sw.js", readFileSync(notifySw));
  const actual = new Map(listFiles(out).map((p) => [relative(out, p).split(sep).join("/"), p]));
  const problems = [];
  for (const [name, buf] of expected) {
    if (!actual.has(name)) problems.push(`missing ${name}`);
    else if (!readFileSync(actual.get(name)).equals(buf)) problems.push(`stale ${name}`);
  }
  for (const name of actual.keys()) if (!expected.has(name) && !name.endsWith(".DS_Store")) problems.push(`extra ${name}`);
  if (problems.length) {
    console.error(`11ty/js/islands is out of date with islands/src (run \`npm run build\` and commit):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`11ty/js/islands is up to date (${expected.size} files)`);
} else {
  rmSync(out, { recursive: true, force: true });
  await build(options);
  // HFY-TSK-068: the kit service-worker module that /sw.js importScripts (push + notificationclick deep links).
  copyFileSync(notifySw, join(out, "notify-sw.js"));
}
