// HFY-TSK-064: islands build. Every src/islands/*.jsx is an entry -> ../11ty/js/islands/<name>.js (+ <name>.css).
// Shared code (react, @io-kit/*) is split into chunks. Output is gitignored; CI runs scripts/ci/build-islands.sh.
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "11ty", "js", "islands");
const entries = readdirSync(join(here, "src", "islands")).filter((f) => /\.jsx?$/.test(f)).map((f) => join(here, "src", "islands", f));
rmSync(out, { recursive: true, force: true });
await build({
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
});
