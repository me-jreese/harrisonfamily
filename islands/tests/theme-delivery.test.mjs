// HFY design-system pass: the theme reaches every page without JS. Each page carries the render-blocking head blocks written by
// islands/heads.mjs: block A (color-scheme, static theme-color, shell early hint, UI-face preload) immediately before the
// Eleventy main.css link, block B (<link rel=stylesheet href=/css/hfy-theme.css?v=<sha8>>) immediately after it. Fails when an
// Eleventy refresh (or a new page) drops the block: run `cd islands && npm run build` and commit.
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HINT_SCRIPT, NO_HINT, PAGES, applyHead, headBlocks, resolveToken } from "../heads.mjs";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(islandsDir, "..", "11ty");
const read = (p) => readFileSync(join(site, p), "utf8");
const surface = resolveToken(readFileSync(join(islandsDir, "node_modules/@io-kit/tokens/dist/harrisonfamily/theme.css"), "utf8"), "--io-color-semantic-surface");
const REPO_ONLY = new Set(["posts/index.html", "me/index.html", "me/notifications/index.html", "me/links/index.html", "me/inbox/index.html", "tree/index.html", "edit/index.html", "edit/family/index.html", "me/review/index.html", "me/requests/index.html", "join/index.html", "chat/index.html", "offline.html", "family-login/index.html"]);
const FONT_ORIGINS = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fonts\.bunny|fonts\.adobe/i;
const SKIP_DIRS = new Set(["js", "css", "fonts", "images", "media", "uploads", "_data", "family", "event", "note", "place"]);

function htmlPages(dir, base = dir) {
  let out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    const rel = relative(base, p).split(sep).join("/");
    if (d.isDirectory()) { if (!SKIP_DIRS.has(rel.split("/")[0])) out = out.concat(htmlPages(p, base)); }
    else if (d.name.endsWith(".html")) out.push(rel);
  }
  return out;
}

function blocks(html) {
  const a = html.match(/<!-- hfy-theme:start A -->([\s\S]*?)<!-- hfy-theme:end A -->/);
  const b = html.match(/<!-- hfy-theme:start B -->([\s\S]*?)<!-- hfy-theme:end B -->/);
  return { a, b };
}

const css = existsSync(join(site, "css/hfy-theme.css")) ? readFileSync(join(site, "css/hfy-theme.css")) : null;
const sha8 = css ? createHash("sha256").update(css).digest("hex").slice(0, 8) : null;

test("heads.mjs writes are idempotent and removable (an Eleventy page and a repo-owned page)", () => {
  const blocks = headBlocks({ themeColor: "#141210", cssHref: "/css/hfy-theme.css?v=0123abcd", preloadHref: "/fonts/x.0123abcd.woff2" });
  const eleventy = '<html>\n<head>\n  <title>t</title>\n  <link rel="stylesheet" href="/css/main.css" />\n</head>\n<body></body></html>\n';
  const owned = '<html>\n<head>\n  <meta charset="utf-8">\n  <title>t</title>\n  <meta name="robots" content="noindex">\n</head>\n<body></body></html>\n';
  for (const html of [eleventy, owned]) {
    const once = applyHead(html, blocks);
    assert.equal(applyHead(once, blocks), once, "applying twice changes nothing");
    const newer = headBlocks({ themeColor: "#141210", cssHref: "/css/hfy-theme.css?v=ffffffff", preloadHref: "/fonts/x.0123abcd.woff2" });
    const rebuilt = applyHead(once, newer);
    assert.equal((rebuilt.match(/hfy-theme:start/g) || []).length, 2, "a rebuild replaces the blocks instead of adding more");
    assert.ok(rebuilt.includes("?v=ffffffff") && !rebuilt.includes("?v=0123abcd"));
    const stripped = once.replace(/[ \t]*<!-- hfy-theme:start (A|B) -->[\s\S]*?<!-- hfy-theme:end \1 -->[ \t]*\n?/g, "");
    assert.equal(stripped, html, "removing the blocks restores the page byte for byte");
  }
  const once = applyHead(eleventy, blocks);
  assert.ok(once.indexOf("hfy-theme:end A") < once.indexOf("/css/main.css") && once.indexOf("/css/main.css") < once.indexOf("hfy-theme:start B"));
  assert.throws(() => applyHead("<html><head></head></html>", blocks, "x.html"), /no main\.css link and no <\/title>/);
});

test("css/hfy-theme.css exists, is generated, and holds the fonts, the theme, both bridges and the print block", () => {
  assert.ok(css, `${site}/css/hfy-theme.css is missing (run npm run build)`);
  const text = css.toString("utf8");
  assert.match(text.slice(0, 200), /generated, do not edit/);
  // (the minifier may drop the quotes of an all-identifier family name: font-family:Libre Caslon Text)
  for (const fam of ["Source Sans 3", "Libre Caslon Text", "Source Code Pro"]) assert.match(text, new RegExp(`@font-face\\{font-family:"?${fam}"?;`), `@font-face ${fam}`);
  assert.match(text, /--io-color-semantic-surface:/, "theme.css");
  assert.match(text, /--bs-body-bg:/, "bs-bridge.css");
  assert.match(text, /--io-shell-surface:/, "kit-bridge.css");
  assert.match(text, /@media print\{:root\{color-scheme:light;/, "print block");
  assert.doesNotMatch(text, /@import/, "no runtime @import");
  assert.doesNotMatch(text, FONT_ORIGINS, "no third-party font origin");
  assert.doesNotMatch(text, /\.\.\/|url\((?!\/fonts\/|["']?data:)/, "every url() is /fonts/* or a data: URI");
});

test("every page of the site is a registered head-block page", () => {
  const found = htmlPages(site).sort();
  const unregistered = found.filter((p) => !PAGES.includes(p));
  assert.deepEqual(unregistered, [], `pages without a head-block registration (add them to heads.mjs PAGES): ${unregistered.join(", ")}`);
});

for (const page of PAGES) {
  test(`head blocks: ${page}`, () => {
    assert.ok(existsSync(join(site, page)), `${page} is missing`);
    const html = read(page);
    const { a, b } = blocks(html);
    assert.ok(a, "block A (hfy-theme:start A) is missing: run `cd islands && npm run build`");
    assert.ok(b, "block B (hfy-theme:start B) is missing: run `cd islands && npm run build`");
    assert.equal(html.match(/hfy-theme:start A/g).length, 1, "one block A");
    assert.equal(html.match(/hfy-theme:start B/g).length, 1, "one block B");
    const head = html.slice(0, html.search(/<\/head>/i));
    assert.ok(b.index < head.length && a.index < head.length, "both blocks are inside <head>");

    const main = html.match(/<link\b[^>]*href=["']\/css\/main\.css(?:\?v=[0-9a-f]{8})?["'][^>]*>/i);
    if (REPO_ONLY.has(page)) {
      assert.equal(main, null, "repo-owned pages do not load main.css");
      const title = html.search(/<\/title>/i);
      assert.ok(title !== -1 && title < a.index && a.index < b.index, "A then B right after </title>");
      assert.match(html.slice(title, a.index), /^<\/title>\s*$/i, "block A follows </title> directly");
    } else {
      assert.ok(main, "main.css link present");
      assert.match(html.slice(a.index + a[0].length, main.index), /^\s*$/, "block A sits immediately before main.css");
      assert.match(html.slice(main.index + main[0].length, b.index), /^\s*$/, "block B sits immediately after main.css");
    }

    const blockA = a[1];
    assert.match(blockA, /<meta name="color-scheme" content="dark" \/>/);
    const tc = blockA.match(/<meta name="theme-color" content="([^"]+)" \/>/);
    assert.ok(tc, "static theme-color meta");
    assert.equal(tc[1], surface, "theme-color is the resolved surface token");
    if (NO_HINT.has(page)) {
      assert.ok(!blockA.includes("hfy:shell-hint"), "no shell hint on a page that never mounts the shell");
    } else {
      assert.ok(blockA.includes(HINT_SCRIPT), "shell early-hint script");
      assert.ok(blockA.indexOf(HINT_SCRIPT) < blockA.search(/<link/), "the hint script runs before any stylesheet or preload");
    }
    const pre = blockA.match(/<link rel="preload" as="font" type="font\/woff2" crossorigin href="(\/fonts\/source-sans-3-latin-wght-normal\.[0-9a-f]{8}\.woff2)" \/>/);
    assert.ok(pre, "UI-face preload (crossorigin, woff2)");
    assert.ok(existsSync(join(site, pre[1])), `preloaded ${pre[1]} exists in fonts/`);

    const link = b[1].match(/<link rel="stylesheet" href="\/css\/hfy-theme\.css\?v=([0-9a-f]{8})" \/>/);
    assert.ok(link, "block B links /css/hfy-theme.css?v=<sha8>");
    assert.equal(link[1], sha8, "?v matches the sha256 of css/hfy-theme.css");

    assert.equal((html.match(/<meta name="theme-color"/g) || []).length, 1, "exactly one theme-color meta");
    assert.doesNotMatch(html, FONT_ORIGINS, "no third-party font origin");
    assert.doesNotMatch(html, /@io-kit\/tokens\/tokens\.css|\/tokens\.css/, "the Enceladus tokens.css is not loaded");
  });
}

test("manifest.webmanifest theme_color and background_color are the surface token", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.theme_color, surface);
  assert.equal(m.background_color, surface);
});

test("fonts/: 12 content-hashed latin + latin-ext faces and the three OFL licences, all referenced by hfy-theme.css", () => {
  const files = readdirSync(join(site, "fonts")).filter((f) => f !== ".DS_Store").sort();
  const faces = files.filter((f) => f.endsWith(".woff2"));
  assert.equal(faces.length, 12, faces.join(", "));
  for (const f of faces) {
    assert.match(f, /^(source-sans-3|libre-caslon-text|source-code-pro)-latin(-ext)?-[\w-]+\.[0-9a-f]{8}\.woff2$/);
    const hash = createHash("sha256").update(readFileSync(join(site, "fonts", f))).digest("hex").slice(0, 8);
    assert.equal(f.split(".").at(-2), hash, `${f}: name hash matches the content`);
    assert.ok(css && css.toString("utf8").includes(`url(/fonts/${f})`), `${f} is referenced by hfy-theme.css`);
  }
  assert.deepEqual(files.filter((f) => f.startsWith("LICENSE-")), ["LICENSE-libre-caslon-text.txt", "LICENSE-source-code-pro.txt", "LICENSE-source-sans-3.txt"]);
});

test("the sign-in stylesheet is self-contained: no third-party fonts, no runtime @import", () => {
  const p = join(site, "css/auth-edge.css");
  assert.ok(existsSync(p), "css/auth-edge.css");
  const text = readFileSync(p, "utf8");
  assert.doesNotMatch(text, FONT_ORIGINS);
  assert.doesNotMatch(text, /@import\b/);
});
