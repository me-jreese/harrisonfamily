// HFY asset versioning: every same-origin script, stylesheet and manifest reference carries ?v=<first 8 hex of the sha256 of the
// referenced file>, so a deploy is picked up at once even though Cloudflare (and then the browser) caches static files for 4 h
// under the URL it was first fetched at (CloudFront invalidations never reach it). The HTML is the one thing the edge does not
// cache, so the versions are driven from it:
//
//   1. every page's <script src>, <link rel=stylesheet|manifest|modulepreload> (and preload as=script|style) pointing at a file
//      of this site is rewritten by versionHtml (idempotent: an existing ?v= is replaced, other query params are kept);
//   2. the dynamic references (the island loader in js/feature-flags.js, the /manifest.webmanifest link it injects, the service
//      worker registration in the shell island) read the same hashes from a generated block stamped between markers:
//        /* hfy-asset-versions:start ... */  const ASSET_V = {...};  /* hfy-asset-versions:end */
//      in js/feature-flags.js (islands, theme, manifest, sw) and in sw.js (theme, manifest, shell, notify; its own cache name
//      comes from the ?v= it is registered at). feature-flags.js is itself versioned by (1) because the stamp changes its bytes.
//
// build.mjs calls these on the final bytes of each file (stamped files first, HTML last), and `build.mjs --check` verifies them.
// Dependency order, which must stay acyclic: islands, theme, notify-sw, manifest -> sw.js -> feature-flags.js -> HTML.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const sha8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

/** The site's own origin: absolute URLs on it are same-origin references like the root-relative ones. */
export const SITE_ORIGIN = "https://harrisonfamily.us";

/** Top-level directories of the site that hold no pages. */
const SKIP_DIRS = new Set(["js", "css", "fonts", "images", "media", "uploads", "_data", "family", "event", "note", "place"]);

/** Every HTML page of the site (relative, posix, sorted), the same set theme-delivery.test.mjs requires to be registered. */
export function htmlPages(site) {
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      const rel = relative(site, p).split(sep).join("/");
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(rel.split("/")[0])) walk(p);
      } else if (d.name.endsWith(".html")) out.push(rel);
    }
  };
  walk(site);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------------------- HTML references
const TAG = /<(script|link)\b([^>]*)>/gi;
const ATTR = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrs(tag) {
  const out = new Map();
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, { value: m[2] ?? m[3] ?? m[4], text: m[0], index: m.index });
  }
  return out;
}

// Which attribute of a <script>/<link> tag references an asset that must be versioned (null: nothing to do). Fonts are not
// versioned: their file names carry the content hash. Icons, canonical and the like are not scripts or stylesheets.
function versionedAttr(name, a) {
  if (name === "script") return a.has("src") ? "src" : null;
  const rel = (a.get("rel")?.value || "").toLowerCase().split(/\s+/);
  if (rel.includes("stylesheet") || rel.includes("manifest") || rel.includes("modulepreload")) return "href";
  if (rel.includes("preload") && ["script", "style"].includes((a.get("as")?.value || "").toLowerCase())) return "href";
  return null;
}

/** Split a URL reference into { path, query, hash } (query and hash without their delimiters; null when absent). */
function splitRef(ref) {
  const h = ref.indexOf("#");
  const hash = h === -1 ? null : ref.slice(h + 1);
  const rest = h === -1 ? ref : ref.slice(0, h);
  const q = rest.indexOf("?");
  return { path: q === -1 ? rest : rest.slice(0, q), query: q === -1 ? null : rest.slice(q + 1), hash };
}

/** `ref` with its ?v= set to `v`: other query params stay, an existing v is replaced (idempotent). */
export function withVersion(ref, v) {
  const { path, query, hash } = splitRef(ref);
  const kept = (query ?? "").split(/&(?:amp;)?/).filter((p) => p !== "" && !/^v(=|$)/.test(p));
  return `${path}?${[...kept, `v=${v}`].join("&")}${hash === null ? "" : `#${hash}`}`;
}

/** The ?v= value of `ref`, or null. */
export function versionOf(ref) {
  const { query } = splitRef(ref);
  const hit = (query ?? "").split(/&(?:amp;)?/).find((p) => /^v=/.test(p));
  return hit ? hit.slice(2) : null;
}

/** Site-relative file ("js/auth.js") a same-origin reference points at from `page`, or null for another origin / a non-http URL. */
export function localFile(ref, page = "index.html") {
  let url;
  try {
    url = new URL(ref, `${SITE_ORIGIN}/${page}`);
  } catch {
    return null;
  }
  if (url.origin !== SITE_ORIGIN) return null;
  return decodeURIComponent(url.pathname).replace(/^\/+/, "");
}

/**
 * Every script / stylesheet / manifest reference of `html` that points at a file of this site:
 * [{ ref, file, version }] (version: the ?v= it carries now, or null).
 */
export function assetRefs(html, page = "index.html") {
  const out = [];
  for (const m of html.matchAll(TAG)) {
    const a = attrs(m[2]);
    const name = versionedAttr(m[1].toLowerCase(), a);
    if (!name) continue;
    const ref = a.get(name)?.value;
    const file = ref == null ? null : localFile(ref, page);
    if (file !== null) out.push({ ref, file, version: versionOf(ref) });
  }
  return out;
}

/**
 * Return `html` with every same-origin script / stylesheet / manifest reference carrying ?v=<hashOf(file)>.
 * `hashOf(file)` gets the site-relative path and returns the 8-hex hash, or null when the file does not exist: that is an error
 * (a reference nobody can version is a stale-file bug waiting to happen), unless the path is listed in `unversioned`.
 */
export function versionHtml(html, hashOf, page = "index.html", unversioned = []) {
  return html.replace(TAG, (tag, name, rest) => {
    const a = attrs(rest);
    const attr = versionedAttr(name.toLowerCase(), a);
    if (!attr) return tag;
    const found = a.get(attr);
    const file = localFile(found.value, page);
    if (file === null || unversioned.includes(file)) return tag;
    const v = hashOf(file);
    if (!v) throw new Error(`${page}: ${found.value} references ${file}, which is not part of the site (cannot version it)`);
    const text = found.text.replace(found.value, () => withVersion(found.value, v));
    // `rest` starts right after "<script"/"<link": splice the new attribute text in at the match offset
    return `<${name}${rest.slice(0, found.index)}${text}${rest.slice(found.index + found.text.length)}>`;
  });
}

// ---------------------------------------------------------------------------------------------------------- stamped blocks
const STAMP = /^([ \t]*)\/\* hfy-asset-versions:start[^\n]*\*\/\r?\n[\s\S]*?^[ \t]*\/\* hfy-asset-versions:end \*\//m;

/** The marker-delimited block for `versions` (indent applied to every line). */
export function stampBlock(versions, indent = "") {
  const json = JSON.stringify(versions, null, 2).split("\n").map((l, i) => (i ? `${indent}${l}` : l)).join("\n");
  return [
    `${indent}/* hfy-asset-versions:start (content hashes of the files this script loads: generated by islands/build.mjs, do not edit) */`,
    `${indent}const ASSET_V = ${json};`,
    `${indent}/* hfy-asset-versions:end */`
  ].join("\n");
}

/** `source` with its hfy-asset-versions block (re)written. Idempotent. */
export function applyStamp(source, versions, label = "script") {
  const m = source.match(STAMP);
  if (!m) throw new Error(`${label}: no "hfy-asset-versions:start ... hfy-asset-versions:end" marker block to stamp`);
  return `${source.slice(0, m.index)}${stampBlock(versions, m[1])}${source.slice(m.index + m[0].length)}`;
}

/** The versions object stamped into `source`, or null. */
export function readStamp(source) {
  const m = source.match(STAMP);
  if (!m) return null;
  const json = m[0].match(/const ASSET_V = ([\s\S]*?);\r?\n[ \t]*\/\* hfy-asset-versions:end/);
  return json ? JSON.parse(json[1]) : null;
}

/**
 * The version maps of a build. `files` is the build's Map(site-relative path -> Buffer | string) of generated outputs;
 * `site` the directory holding everything else (read from disk). Returns the hash lookup, the two stamped sources and the map.
 */
export function stampSources({ site, files, islandNames, hashOf }) {
  const read = (rel) => (existsSync(join(site, rel)) ? readFileSync(join(site, rel), "utf8") : null);
  const islands = {};
  for (const name of [...islandNames].sort()) {
    const js = hashOf(`js/islands/${name}.js`);
    const css = hashOf(`js/islands/${name}.css`);
    islands[name] = css ? { js, css } : { js };
  }
  const theme = hashOf("css/hfy-theme.css");
  const manifest = hashOf("manifest.webmanifest");
  const notify = hashOf("js/islands/notify-sw.js");

  const sw = read("sw.js");
  let swText = null;
  if (sw !== null) {
    swText = applyStamp(sw, { theme, manifest, shell: islands.shell, notify }, "sw.js");
    files.set("sw.js", swText);
  }
  const ff = read("js/feature-flags.js");
  let ffText = null;
  if (ff !== null) {
    ffText = applyStamp(ff, { islands, theme, manifest, sw: swText === null ? null : sha8(swText) }, "js/feature-flags.js");
    files.set("js/feature-flags.js", ffText);
  }
  return { islands, theme, manifest, notify };
}
