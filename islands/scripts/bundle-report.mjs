// Bundle-size report (HFY-TSK-191 AC4): for each island entry, the JS it loads (the entry and every chunk it imports, statically or lazily),
// its stylesheet, and whether any of it is Cloudscape (the `awsui` marker). The person, posts, timeline and my-posts islands must carry none after
// the @io-kit/content 0.3.x bump (its DocumentEditor re-export would otherwise pull Cloudscape in; kit-content.mjs hfyNoDocumentEditor stops that).
//   npm run report:bundles            prints the table and exits 1 when a listed island carries Cloudscape code or styles
//   HFY_SITE=<dir> npm run report:bundles   reads a scratch build (node build.mjs --site <dir>) instead of ../11ty
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
/** Islands that must stay free of Cloudscape; `search` is the one that legitimately loads it (the control row of the report). */
export const CLEAN = ["person", "posts", "timeline", "my-posts"];
export const CONTROL = "search";
const MARKER = /awsui/;
// `from"./x.js"` and `import"./x.js"` are static; `import("./x.js")` is lazy (the esbuild output is minified, so no spaces are assumed).
const STATIC = /(?:from|import)\s*"(\.{1,2}\/[^"]+\.js)"/g;
const ANY = /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.js)"/g;

/** `{ all, static }`: the absolute paths an entry loads, with and without lazy (dynamic import) chunks. */
export function reachable(entry) {
  const walk = (re) => {
    const seen = new Set();
    const visit = (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      for (const m of readFileSync(abs, "utf8").matchAll(re)) visit(resolve(dirname(abs), m[1]));
    };
    visit(entry);
    return [...seen];
  };
  return { all: walk(ANY), static: walk(STATIC) };
}

const bytes = (files) => files.reduce((n, f) => n + readFileSync(f).length, 0);
const gz = (files) => files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);

/** One row per island: js bytes (all, static), gzip of all, css bytes, and the Cloudscape finding for the js and the css. */
export function bundleReport(out, names = [...CLEAN, CONTROL]) {
  return names.map((name) => {
    const entry = join(out, `${name}.js`);
    const cssFile = join(out, `${name}.css`);
    const r = reachable(entry);
    const css = existsSync(cssFile) ? readFileSync(cssFile, "utf8") : "";
    return {
      island: name,
      jsFiles: r.all.length,
      jsBytes: bytes(r.all),
      staticJsBytes: bytes(r.static),
      gzipBytes: gz(r.all),
      cssBytes: Buffer.byteLength(css),
      cloudscapeJs: r.all.filter((f) => MARKER.test(readFileSync(f, "utf8"))).map((f) => f.slice(out.length + 1)),
      cloudscapeCss: MARKER.test(css),
    };
  });
}

export const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

export function formatReport(rows) {
  const head = ["island", "js files", "js (all)", "js (static)", "js gzip", "css", "cloudscape"];
  const lines = rows.map((r) => [r.island, String(r.jsFiles), kb(r.jsBytes), kb(r.staticJsBytes), kb(r.gzipBytes), kb(r.cssBytes), r.cloudscapeJs.length || r.cloudscapeCss ? `YES (${r.cloudscapeJs.length} js${r.cloudscapeCss ? ", css" : ""})` : "none"]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [fmt(head), fmt(w.map((n) => "-".repeat(n))), ...lines.map(fmt)].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(here, "..", "..", "11ty");
  const rows = bundleReport(join(site, "js", "islands"));
  console.log(formatReport(rows));
  const bad = rows.filter((r) => CLEAN.includes(r.island) && (r.cloudscapeJs.length || r.cloudscapeCss));
  if (bad.length) {
    console.error(`\nCloudscape code or styles in: ${bad.map((r) => r.island).join(", ")}`);
    process.exit(1);
  }
  console.log(`\nno Cloudscape code or styles in ${CLEAN.join(", ")}; ${CONTROL} (the control) does carry it.`);
}
