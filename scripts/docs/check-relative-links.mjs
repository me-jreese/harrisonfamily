#!/usr/bin/env node
// Check the relative links of Markdown pages (HFY-TSK-284, edit-docs).
//
//   node scripts/docs/check-relative-links.mjs [--root <dir>] [file.md ...]     default: every docs/**/*.md and AGENTS.md
//
// For each inline link `[text](target)` outside a code block, a relative target must name an existing file or directory, and a
// `#fragment` on a Markdown target must match a heading of that page (GitHub's slug rule). External links, mailto: and bare
// fragments of the same page are checked too (the page's own headings).
// Known limits: a target containing parentheses ends at the first ')', link text containing ']' is skipped, reference-style links and
// HTML anchors are not checked, and duplicate headings are not numbered the way GitHub does. Exit 1 and one line per broken link on any failure.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const slug = (h) =>
  h.trim().toLowerCase().replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function stripCode(text) {
  const lines = text.split("\n");
  let fence = null;
  return lines.map((l) => {
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return "";
    }
    return fence ? "" : l;
  });
}

const anchorCache = new Map();
export function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set();
  const seen = new Map();
  for (const l of stripCode(readFileSync(file, "utf8"))) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n ? `${base}-${n}` : base);
  }
  anchorCache.set(file, set);
  return set;
}

export function checkFile(file) {
  const problems = [];
  stripCode(readFileSync(file, "utf8")).forEach((raw, i) => {
    const line = raw.replace(/`[^`]*`/g, "``");
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [pathPart, frag] = target.split("#");
      const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
      if (!existsSync(dest)) {
        problems.push(`${file}:${i + 1}: ${target} does not exist`);
        continue;
      }
      if (frag && dest.endsWith(".md") && statSync(dest).isFile() && !anchors(dest).has(frag.toLowerCase())) problems.push(`${file}:${i + 1}: ${target} has no such heading`);
    }
  });
  return problems;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else files.push(argv[i]);
  }
  const list = files.length ? files.map((f) => resolve(root, f)) : [...walk(join(root, "docs")).filter((f) => !f.includes("/docs/design/") && !f.includes("/docs/drafts/")), join(root, "AGENTS.md")];
  const problems = list.flatMap(checkFile);
  for (const p of problems) console.error(relative(root, p.split(":")[0]) + p.slice(p.indexOf(":")));
  console.log(`${list.length - new Set(problems.map((p) => p.split(":")[0])).size} pages pass, ${new Set(problems.map((p) => p.split(":")[0])).size} fail`);
  return problems.length ? 1 : 0;
}

// Compare real paths: Node runs the main module from its real path, so a path through a symlink (macOS /var, /tmp) would
// otherwise never match, and the CLI would exit 0 having checked nothing.
const isMain = () => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
