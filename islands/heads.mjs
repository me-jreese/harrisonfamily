// HFY design-system pass: the render-blocking theme head block on every page, written by islands/build.mjs.
//
// Why every page is edited: the legacy heads link only the Eleventy main.css (never edited), feature-flags.js runs at the end
// of <body> where nothing can be made render-blocking, and blocking=render only works before <body> exists. So each page
// carries two marker-delimited blocks, rewritten idempotently on every build (and verified by `build.mjs --check`):
//   block A, immediately BEFORE the main.css link (so the inline script never waits on a stylesheet):
//     color-scheme meta, a static theme-color meta (the resolved surface token), the shell early hint
//     (html.hfy-shell-v2 when localStorage "hfy:shell-hint" is "1"), and the preload of the UI face;
//   block B, immediately AFTER main.css: <link rel=stylesheet href=/css/hfy-theme.css?v=<sha8>>, so the cascade is
//     main.css first and the theme second. (Its ?v is the same sha8 of the file that assets.mjs writes on every other script,
//     stylesheet and manifest reference of the page, so the two stay consistent; the main.css anchor matches with or without it.)
// Pages without main.css (posts/, me/notifications/, offline.html) get A then B right after </title>.
// offline.html gets no early hint: it never loads feature-flags.js (so nothing would mount the shell or clear the class), and
// html.hfy-shell-v2 there would leave the shell's pre-mount placeholder bars (theme partial 60) painted on the offline page.
// After an Eleventy refresh rewrites a page, `cd islands && npm run build` puts the blocks back. Workspace port: partials/head.njk
// gets block A before the main.css link and block B after it (11ty/README.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The 13 pages that get the block: the 10 Eleventy pages plus the three repo-owned ones. */
export const PAGES = [
  "index.html",
  "about/index.html",
  "contact/index.html",
  "family-login/index.html",
  "logged-out/index.html",
  "person/index.html",
  "privacy/index.html",
  "private/index.html",
  "search/index.html",
  "terms/index.html",
  "posts/index.html",
  "me/notifications/index.html",
  "offline.html"
];

export const HINT_KEY = "hfy:shell-hint";
export const HINT_SCRIPT = `<script>try{localStorage.getItem("${HINT_KEY}")==="1"&&document.documentElement.classList.add("hfy-shell-v2")}catch(e){}</script>`;
// (the href may carry the ?v=<sha8> that islands/assets.mjs writes: the anchor is found whether or not the page is versioned yet)
const MAIN_CSS = /<link\b[^>]*\bhref=["']\/css\/main\.css(?:\?[^"']*)?["'][^>]*>/i;
const TITLE_END = /<\/title>/i;
const BLOCK = (id) => new RegExp(`[ \\t]*<!-- hfy-theme:start ${id} -->[\\s\\S]*?<!-- hfy-theme:end ${id} -->[ \\t]*\\r?\\n?`, "g");

/**
 * Resolve a custom property of the harrisonfamily theme's default (dark, :root) block to its literal value, following
 * var() aliases: resolveToken(themeCss, "--io-color-semantic-surface") -> "#141210".
 */
export function resolveToken(themeCss, name) {
  const css = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const root = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].split(",").some((s) => s.trim() === ":root"));
  if (!root) throw new Error("theme.css: no :root block");
  const decls = new Map();
  for (const m of root[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1], m[2].trim());
  let value = decls.get(name);
  for (let i = 0; value && i < 10; i += 1) {
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    if (!alias) return value;
    value = decls.get(alias[1]);
  }
  throw new Error(`theme.css: cannot resolve ${name}`);
}

/** Pages that never mount the shell (no feature-flags.js): block A carries no early hint there. */
export const NO_HINT = new Set(["offline.html"]);

/** The two blocks for a given build: { a, b } as single-line-per-tag strings without indentation. */
export function headBlocks({ themeColor, cssHref, preloadHref, hint = true }) {
  const a = [
    "<!-- hfy-theme:start A -->",
    '<meta name="color-scheme" content="dark" />',
    `<meta name="theme-color" content="${themeColor}" />`,
    ...(hint ? [HINT_SCRIPT] : []),
    `<link rel="preload" as="font" type="font/woff2" crossorigin href="${preloadHref}" />`,
    "<!-- hfy-theme:end A -->"
  ];
  const b = ["<!-- hfy-theme:start B -->", `<link rel="stylesheet" href="${cssHref}" />`, "<!-- hfy-theme:end B -->"];
  return { a, b };
}

const indentOf = (html, index) => {
  const lineStart = html.lastIndexOf("\n", index - 1) + 1;
  const lead = html.slice(lineStart, index);
  return /^[ \t]*$/.test(lead) ? lead : "";
};

/** Return `html` with both blocks (re)written. Idempotent: applying it twice gives the same text. */
export function applyHead(html, blocks, page = "page") {
  let out = html.replace(BLOCK("A"), "").replace(BLOCK("B"), "");
  const main = out.match(MAIN_CSS);
  if (main) {
    const at = main.index;
    const ind = indentOf(out, at);
    const a = blocks.a.join(`\n${ind}`);
    const b = blocks.b.join(`\n${ind}`);
    const end = at + main[0].length;
    return `${out.slice(0, at)}${a}\n${ind}${main[0]}\n${ind}${b}${out.slice(end)}`;
  }
  const title = out.match(TITLE_END);
  if (!title) throw new Error(`${page}: no main.css link and no </title> to anchor the theme head block`);
  const end = title.index + title[0].length;
  const ind = indentOf(out, out.lastIndexOf("<title", title.index)) || "";
  const body = [...blocks.a, ...blocks.b].join(`\n${ind}`);
  return `${out.slice(0, end)}\n${ind}${body}${out.slice(end).replace(/^[ \t]*(?=\r?\n)/, "")}`;
}

/** Expected text of every page and of manifest.webmanifest for this build: Map(relative path -> string). */
export function expectedHeads(site, { themeColor, cssHref, preloadHref }) {
  const out = new Map();
  for (const page of PAGES) {
    const html = readFileSync(join(site, page), "utf8");
    out.set(page, applyHead(html, headBlocks({ themeColor, cssHref, preloadHref, hint: !NO_HINT.has(page) }), page));
  }
  const manifestPath = join(site, "manifest.webmanifest");
  const raw = readFileSync(manifestPath, "utf8");
  JSON.parse(raw); // fail loudly on a broken manifest
  out.set("manifest.webmanifest", setManifestColours(raw, themeColor));
  return out;
}

// Rewrites the two colour members in place so the file's own formatting (one icon per line) survives.
function setManifestColours(raw, colour) {
  let text = raw;
  for (const key of ["background_color", "theme_color"]) {
    const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(text)) throw new Error(`manifest.webmanifest: no ${key}`);
    text = text.replace(re, `$1"${colour}"`);
  }
  return text;
}
