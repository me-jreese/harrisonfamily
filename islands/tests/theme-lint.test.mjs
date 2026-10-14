// HFY design-system pass: `no-literal-token-values` (ds/guide/03-kit-bridge.md "Lint", ds/guide/06-audit-rules.md rule 5).
// App CSS aliases tokens; it never writes a literal colour, font family, radius or px/rem/em length.
//
// Scope: islands/src/**/*.css (src/theme/ and src/auth-edge/ included), plus the inline style attributes and <style> elements of
// the repo-owned pages (11ty/posts/index.html, 11ty/me/index.html, 11ty/me/notifications/index.html, 11ty/me/links/index.html,
// 11ty/me/inbox/index.html, 11ty/tree/index.html, 11ty/edit/index.html, 11ty/offline.html).
// Outside var() a declaration value fails on: #hex; rgb()/rgba()/hsl()/hsla(); \d+(px|rem|em); a font-family or font value that
// names a family; and any var() read of a custom property that is not --io-* or --bs-* (except in src/theme/10-kit-aliases.css,
// which maps the kit's Enceladus short names, DVP-TSK-A73).
// Exempt: whole @font-face blocks (their descriptors define the names the tokens reference); url(...) contents (data-URI icon
// masks); at-rule preludes (@media/@supports/@container cannot use var()); comments; 0, %, vh/vw and unitless numbers; the 1px
// hairline (as ds/components/bundle.css); calc(100vw - 32px) (the audit's portal cap); and --io-bp-* declarations tagged
// `/* lint-allow: bp tokens pending */` on the same line.
//
// Every linted CSS file must also parse without esbuild warnings (a comment closed early by "**/" drops the rules after it).
//
// HFY_LINT_ONLY=<glob> lints only matching files (paths relative to islands/, e.g. 'src/theme/{30,40,45}-*.css'; several globs
// may be given separated by spaces). Run: npm run lint:css
import { test } from "node:test";
import assert from "node:assert/strict";
import { transform } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const REPO_PAGES = ["11ty/posts/index.html", "11ty/me/index.html", "11ty/me/notifications/index.html", "11ty/me/links/index.html", "11ty/me/inbox/index.html", "11ty/tree/index.html", "11ty/edit/index.html", "11ty/offline.html"];
const ALIAS_FILE = "src/theme/10-kit-aliases.css";
const ALLOW_BP = /lint-allow:\s*bp tokens pending/;

// ---------------------------------------------------------------------------------------------------------------- parser
// A small CSS walker that respects strings, comments and parentheses, and yields every declaration of every style rule
// (nested rules and @media/@supports/@container/@layer blocks included; @font-face blocks skipped).
export function declarations(css) {
  const allowLines = new Set();
  // Blank out comments (same length, newlines kept, so offsets and line numbers stay true) and note lint-allow lines.
  let text = "";
  for (let i = 0; i < css.length; ) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = skipString(css, i);
      text += css.slice(i, end);
      i = end;
    } else if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? css.length : close + 2;
      const body = css.slice(i, end);
      if (ALLOW_BP.test(body)) allowLines.add(lineAt(css, i));
      text += body.replace(/[^\n]/g, " ");
      i = end;
    } else {
      text += ch;
      i += 1;
    }
  }
  const out = [];
  walk(text, 0, false, out, css);
  for (const d of out) d.allowBp = allowLines.has(d.line);
  return out;
}

function skipString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, s.length);
}
function lineAt(s, i) {
  let n = 1;
  for (let k = 0; k < i; k += 1) if (s[k] === "\n") n += 1;
  return n;
}
// Read from i to the first top-level `{`, `;` or `}` (outside strings and parentheses).
function readHead(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"' || ch === "'") { j = skipString(s, j); continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === "{" || ch === ";" || ch === "}")) break;
    j += 1;
  }
  return j;
}
function skipBlock(s, i) { // i is just after `{`; returns the index after the matching `}`
  let depth = 1;
  let j = i;
  while (j < s.length && depth > 0) {
    const ch = s[j];
    if (ch === '"' || ch === "'") { j = skipString(s, j); continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    j += 1;
  }
  return j;
}
function walk(s, i, inStyle, out, original) {
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) return i;
    if (s[i] === "}") return i + 1;
    const end = readHead(s, i);
    const head = s.slice(i, end).trim();
    const term = s[end];
    if (term === "{") {
      if (/^@font-face\b/i.test(head)) { i = skipBlock(s, end + 1); continue; }
      const nestedStyle = head.startsWith("@") ? inStyle : true;
      i = walk(s, end + 1, nestedStyle, out, original);
      continue;
    }
    // `;`, `}` or end of input: a declaration (inside a style rule) or a statement at-rule (@import, @layer a, b;).
    if (inStyle && !head.startsWith("@")) {
      const colon = head.indexOf(":");
      if (colon > 0) {
        out.push({ prop: head.slice(0, colon).trim(), value: head.slice(colon + 1).trim(), line: lineAt(original, end === s.length ? end - 1 : end) });
      }
    }
    i = term === "}" ? end : end + 1;
    if (term === "}") return i + 1;
  }
  return i;
}

// Replace every `name(...)` (balanced) with `name()`.
function stripCalls(value, names) {
  const re = new RegExp(`\\b(${names.join("|")})\\(`, "gi");
  let out = "";
  let i = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(value))) {
    out += value.slice(i, m.index) + m[1] + "(";
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < value.length && depth > 0) {
      const ch = value[j];
      if (ch === '"' || ch === "'") { j = skipString(value, j); continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      j += 1;
    }
    out += ")";
    i = j;
    re.lastIndex = j;
  }
  return out + value.slice(i);
}

const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const FONT_KEYWORDS = new Set([...CSS_WIDE, "normal", "italic", "oblique", "bold", "bolder", "lighter", "small-caps",
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded",
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar", "var", "calc", "max", "min", "clamp"]);

/** Findings for one declaration list. `file` is the islands/-relative (or repo-relative) path. */
export function lintDeclarations(decls, file) {
  const findings = [];
  const aliasFile = file === ALIAS_FILE;
  for (const d of decls) {
    const at = `${file}:${d.line} ${d.prop}: ${d.value}`;
    const value = d.value.replace(/!\s*important\s*$/i, "").trim();
    if (d.prop.startsWith("--io-bp-") && d.allowBp) continue;
    if (!aliasFile) {
      for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!/^--(io|bs)-/.test(m[1])) findings.push(`${at}  <- reads ${m[1]} (only --io-* / --bs-* may be read)`);
      }
    }
    const bare = stripCalls(stripCalls(value, ["url"]), ["var"]).replace(/calc\(\s*100vw\s*-\s*32px\s*\)/g, "calc()");
    if (/#[0-9a-f]{3,8}\b/i.test(bare)) findings.push(`${at}  <- literal hex colour`);
    if (/\b(rgba?|hsla?)\(/i.test(bare)) findings.push(`${at}  <- literal rgb/hsl colour`);
    for (const m of bare.matchAll(/(?<![\w.-])-?(\d*\.?\d+)(px|rem|em)\b/gi)) {
      const n = Number(m[1]);
      const hairline = n === 1 && m[2].toLowerCase() === "px";
      if (n !== 0 && !hairline) findings.push(`${at}  <- literal length ${m[0]}`);
    }
    const prop = d.prop.toLowerCase();
    if (prop === "font-family" || prop === "font") {
      const rest = bare.replace(/var\(\)/g, " ").replace(/\b(calc|max|min|clamp)\(\)/g, " ");
      const named = /["']/.test(rest) ||
        rest.split(/[\s,/]+/).filter(Boolean).some((tok) => !/^[\d.]+(%|[a-z]+)?$/i.test(tok) && !FONT_KEYWORDS.has(tok.toLowerCase()));
      if (named) findings.push(`${at}  <- names a font family (alias --io-typography-font-*)`);
    }
  }
  return findings;
}

/** Findings for a CSS source. */
export function lintCss(css, file) {
  return lintDeclarations(declarations(css), file);
}

/** Findings for the inline styles of an HTML page (style="" attributes and <style> elements). */
export function lintHtml(html, file) {
  const findings = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) findings.push(...lintCss(m[1], `${file} <style>`));
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const body = m[2] ?? m[3];
    const line = html.slice(0, m.index).split("\n").length;
    const decls = declarations(`x{${body}}`).map((d) => ({ ...d, line }));
    findings.push(...lintDeclarations(decls, `${file} style=""`));
  }
  return findings;
}

// ----------------------------------------------------------------------------------------------------------- file scope
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i += 1; if (glob[i + 1] === "/") i += 1; } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const close = glob.indexOf("}", i);
      re += `(${glob.slice(i + 1, close).split(",").map((p) => p.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = close;
    } else if (ch === "[") {
      const close = glob.indexOf("]", i);
      re += glob.slice(i, close + 1);
      i = close;
    } else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function listCss(dir) {
  let out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out = out.concat(listCss(p));
    else if (d.name.endsWith(".css")) out.push(p);
  }
  return out;
}
const posix = (p) => p.split(sep).join("/");

const only = (process.env.HFY_LINT_ONLY || "").trim().split(/\s+/).filter(Boolean).map(globToRegExp);
const keep = (rel, repoRel) => !only.length || only.some((re) => re.test(rel) || re.test(repoRel));
const targets = [
  ...listCss(join(islandsDir, "src")).map((abs) => ({ abs, rel: posix(relative(islandsDir, abs)), kind: "css" })),
  ...REPO_PAGES.map((p) => ({ abs: join(repo, p), rel: posix(relative(islandsDir, join(repo, p))), kind: "html" }))
].filter((t) => keep(t.rel, posix(relative(repo, t.abs))));

// ------------------------------------------------------------------------------------------------------------ the tests
test("the linter catches literals and honours its exemptions", () => {
  const css = `
    @font-face { font-family: "Source Sans 3"; src: url(/fonts/a.woff2) format("woff2"); font-weight: 200 900; }
    @media (min-width: 43rem) { .a { padding: var(--io-space-4); } }
    :root { --io-bp-medium-min: 43rem; /* lint-allow: bp tokens pending */ }
    .ok { border: 1px solid var(--io-color-semantic-border); margin: 0; width: 100%; height: 50vh; z-index: 3; line-height: 1.6;
          max-width: calc(100vw - 32px); mask: url("data:image/svg+xml;utf8,<svg fill='%23fff' width='24px'/>"); font: inherit;
          font-family: var(--io-typography-font-ui); color: var(--io-color-semantic-text, #fff); top: env(safe-area-inset-top, 0px); }
    .bad1 { color: #fff; }
    .bad2 { background: rgba(0, 0, 0, .5); }
    .bad3 { padding: 12px; }
    .bad4 { margin: .5rem; }
    .bad5 { font-family: Inter, sans-serif; }
    .bad6 { font: 600 16px/1.2 system-ui; }
    .bad7 { color: var(--fg); }
    .bad8 { outline-offset: -2px; }
    :root { --io-bp-wide-min: 64rem; }
    .nest { & .bad9 { gap: 2em; } }
  `;
  const f = lintCss(css, "src/theme/99-selftest.css").map((s) => s.split("  <- ")[0].replace(/^.*?:\d+ /, ""));
  assert.deepEqual(f, [
    "color: #fff",
    "background: rgba(0, 0, 0, .5)",
    "padding: 12px",
    "margin: .5rem",
    "font-family: Inter, sans-serif",
    "font: 600 16px/1.2 system-ui",
    "font: 600 16px/1.2 system-ui",
    "color: var(--fg)",
    "outline-offset: -2px",
    "--io-bp-wide-min: 64rem",
    "gap: 2em"
  ]);
  assert.deepEqual(lintCss(".x { color: var(--fg); }", ALIAS_FILE), [], "the kit-alias file may read the short names");
  assert.equal(lintHtml('<main style="padding:16px;font-family:system-ui,sans-serif"></main>', "p.html").length, 2);
  assert.ok(globToRegExp("src/theme/{30,40,45}-*.css").test("src/theme/40-legacy-type.css"));
  assert.ok(!globToRegExp("src/theme/{30,40,45}-*.css").test("src/theme/60-shell-static.css"));
  assert.ok(globToRegExp("src/**/*.css").test("src/theme/20-base.css"));
});

test("HFY_LINT_ONLY matches at least one file", () => {
  assert.ok(targets.length > 0, `HFY_LINT_ONLY=${process.env.HFY_LINT_ONLY} matched no file`);
});

for (const t of targets) {
  test(`no-literal-token-values: ${t.rel}`, () => {
    const src = readFileSync(t.abs, "utf8");
    const findings = t.kind === "css" ? lintCss(src, t.rel) : lintHtml(src, posix(relative(repo, t.abs)));
    assert.deepEqual(findings, [], `\n  ${findings.join("\n  ")}`);
  });
  // A syntax slip drops rules silently (e.g. "11ty/**/*.html" inside a comment closes it at "**/"), so every file must parse clean.
  if (t.kind === "css") {
    test(`parses without warnings: ${t.rel}`, async () => {
      const { warnings } = await transform(readFileSync(t.abs, "utf8"), { loader: "css", sourcefile: t.rel, logLevel: "silent" });
      const msgs = warnings.map((w) => `${t.rel}:${w.location ? w.location.line : "?"} ${w.text}`);
      assert.deepEqual(msgs, [], `\n  ${msgs.join("\n  ")}`);
    });
  }
}
