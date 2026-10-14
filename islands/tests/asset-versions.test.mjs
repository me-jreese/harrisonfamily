// HFY asset versioning (islands/assets.mjs): Cloudflare caches static files for 4 h under the URL they were fetched at, so every
// same-origin script / stylesheet / manifest reference carries ?v=<sha8 of the referenced file>, driven from the uncached HTML;
// the runtime references (island loader, manifest link, service worker registration) read the same hashes from a block stamped
// into js/feature-flags.js, and sw.js takes its cache name from the ?v it is registered at.
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyStamp, assetRefs, htmlPages, localFile, readStamp, sha8, stampBlock, stampSources, versionHtml, versionManifestCss, versionOf, withVersion } from "../assets.mjs";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(islandsDir, "..", "11ty");
const read = (rel) => readFileSync(join(site, rel), "utf8");
const hashOnDisk = (rel) => (existsSync(join(site, rel)) ? sha8(readFileSync(join(site, rel))) : null);

// ------------------------------------------------------------------------------------------------------------- the rewrite
const FILES = { "js/a.js": "AAA", "js/b.js": "BBB", "css/main.css": "body{}", "manifest.webmanifest": "{}", "js/islands/x.js": "X", "css/other.css": "o{}" };
const hashOf = (rel) => (rel in FILES ? sha8(FILES[rel]) : null);
const PAGE = `<!doctype html>
<html><head>
  <title>t</title>
  <link rel="stylesheet" href="/css/main.css" />
  <link rel="stylesheet" href='/css/other.css?v=00000000'>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="canonical" href="https://harrisonfamily.us/about/" />
  <link rel="icon" href="/images/favicon.png">
  <link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/source-sans-3-latin-wght-normal.7a19a702.woff2" />
  <link rel="modulepreload" href="/js/islands/x.js">
</head><body>
  <script>window.inline = "<b>";</script>
  <script src="/js/a.js" defer></script>
  <script src="/js/b.js?foo=1#top"></script>
  <script src="https://third-party.example/lib.js" async defer></script>
  <script type="module" src="https://harrisonfamily.us/js/a.js"></script>
  <script src="//cdn.example.com/x.js"></script>
</body></html>
`;

test("versionHtml: every same-origin script / stylesheet / manifest / modulepreload gets ?v=<sha8 of the file>", () => {
  const out = versionHtml(PAGE, hashOf, "about/index.html");
  const refs = assetRefs(out, "about/index.html");
  assert.deepEqual(refs.map((r) => r.file), ["css/main.css", "css/other.css", "manifest.webmanifest", "js/islands/x.js", "js/a.js", "js/b.js", "js/a.js"]);
  for (const r of refs) assert.equal(r.version, hashOf(r.file), `${r.ref} carries the hash of ${r.file}`);
  assert.match(out, /href="\/css\/main\.css\?v=[0-9a-f]{8}"/);
  assert.match(out, /href='\/css\/other\.css\?v=[0-9a-f]{8}'>/, "an existing ?v is replaced (and the quote style kept)");
  assert.match(out, /src="\/js\/b\.js\?foo=1&v=[0-9a-f]{8}#top"/, "other query params and the fragment survive");
  assert.match(out, /src="https:\/\/harrisonfamily\.us\/js\/a\.js\?v=[0-9a-f]{8}"/, "an absolute URL on the site origin is same-origin");
  // untouched: external scripts, protocol-relative, fonts (content-hashed names), icons, canonical, inline scripts
  assert.match(out, /src="https:\/\/third-party\.example\/lib\.js" async defer/);
  assert.match(out, /src="\/\/cdn\.example\.com\/x\.js"/);
  assert.match(out, /href="\/fonts\/source-sans-3-latin-wght-normal\.7a19a702\.woff2" \/>/);
  assert.match(out, /rel="icon" href="\/images\/favicon\.png">/);
  assert.match(out, /rel="canonical" href="https:\/\/harrisonfamily\.us\/about\/" \/>/);
  assert.match(out, /<script>window\.inline = "<b>";<\/script>/);
});

test("versionHtml is idempotent and removable", () => {
  const once = versionHtml(PAGE, hashOf, "about/index.html");
  assert.equal(versionHtml(once, hashOf, "about/index.html"), once, "applying it twice changes nothing");
  const strip = (t) => t.replace(/[?&]v=[0-9a-f]{8}/g, "");
  assert.equal(strip(once), strip(PAGE), "dropping the ?v values restores the page");
  assert.equal((once.match(/[?&]v=/g) || []).length, 7, "one v per reference");
});

test("the hash follows the content of the referenced file", () => {
  const before = versionHtml(PAGE, hashOf, "p.html");
  const changed = { ...FILES, "js/a.js": "AAA2" };
  const after = versionHtml(before, (rel) => (rel in changed ? sha8(changed[rel]) : null), "p.html");
  assert.notEqual(after, before);
  assert.match(after, new RegExp(`src="/js/a\\.js\\?v=${sha8("AAA2")}"`));
  assert.match(after, new RegExp(`src="/js/b\\.js\\?foo=1&v=${sha8("BBB")}#top"`), "files that did not change keep their ?v");
  assert.doesNotMatch(after, new RegExp(sha8("AAA")), "the old hash is gone, not appended");
  assert.equal(withVersion("/x.js?v=1&v=2&a=b", "ffffffff"), "/x.js?a=b&v=ffffffff");
  assert.equal(versionOf("/x.js?a=b&v=ffffffff"), "ffffffff");
  assert.equal(versionOf("/x.js"), null);
});

test("versionHtml refuses a same-origin reference to a file that is not in the site (unless listed)", () => {
  const html = '<script src="/js/missing.js"></script>';
  assert.throws(() => versionHtml(html, hashOf, "p.html"), /\/js\/missing\.js references js\/missing\.js, which is not part of the site/);
  assert.equal(versionHtml(html, hashOf, "p.html", ["js/missing.js"]), html);
  assert.equal(localFile("../js/a.js", "about/index.html"), "js/a.js", "a page-relative reference resolves against the page");
  assert.equal(localFile("https://example.com/js/a.js"), null);
});

// ------------------------------------------------------------------------------------- the sign-in stylesheet (edge manifest)
const MANIFEST = '{\n  "site": "harrisonfamily.us",\n  "theme": {\n    "cssUrl": "https://harrisonfamily.us/css/auth-edge.css",\n    "fontOrigins": [\n      "self"\n    ]\n  },\n  "copy": { "a": "b" }\n}\n';
const cssHash = (rel) => (rel === "css/auth-edge.css" ? sha8("auth-edge") : null);

test("versionManifestCss: theme.cssUrl gets ?v=<sha8 of auth-edge.css> by a one-line textual edit, idempotently", () => {
  const once = versionManifestCss(MANIFEST, cssHash);
  const want = `https://harrisonfamily.us/css/auth-edge.css?v=${sha8("auth-edge")}`;
  assert.equal(JSON.parse(once).theme.cssUrl, want);
  assert.equal(once, MANIFEST.replace("css/auth-edge.css\"", `css/auth-edge.css?v=${sha8("auth-edge")}"`), "only the cssUrl value changed: formatting and key order are untouched");
  const diff = once.split("\n").filter((l, i) => l !== MANIFEST.split("\n")[i]);
  assert.equal(diff.length, 1, "a one-line diff");
  assert.equal(versionManifestCss(once, cssHash), once, "applying it twice changes nothing");
  const changed = versionManifestCss(once, (rel) => (rel === "css/auth-edge.css" ? sha8("auth-edge v2") : null));
  assert.equal(JSON.parse(changed).theme.cssUrl, `https://harrisonfamily.us/css/auth-edge.css?v=${sha8("auth-edge v2")}`, "the ?v follows the content and is replaced, not appended");
  assert.throws(() => versionManifestCss(MANIFEST, () => null), /references css\/auth-edge\.css, which is not part of the site/);
  assert.throws(() => versionManifestCss(MANIFEST.replace("https://harrisonfamily.us", "https://example.com"), cssHash), /is not on https:\/\/harrisonfamily\.us/);
  assert.throws(() => versionManifestCss('{"theme":{}}', cssHash), /found 0/);
});

test("auth/edge.manifest.json theme.cssUrl carries the hash of css/auth-edge.css (the repo's own site only)", { skip: process.env.HFY_SITE ? "scratch --site copies do not own the auth manifest" : false }, () => {
  const raw = readFileSync(join(islandsDir, "..", "auth", "edge.manifest.json"), "utf8");
  assert.equal(JSON.parse(raw).theme.cssUrl, `https://harrisonfamily.us/css/auth-edge.css?v=${hashOnDisk("css/auth-edge.css")}`);
  assert.equal(versionManifestCss(raw, hashOnDisk), raw, "a fresh stamp changes nothing");
});

// ------------------------------------------------------------------------------------------------------- the stamped blocks
const FF = "(function () {\n  /* hfy-asset-versions:start (x) */\n  const ASSET_V = {};\n  /* hfy-asset-versions:end */\n  const other = 1;\n})();\n";
const SW = "/* sw */\n/* hfy-asset-versions:start (x) */\nconst ASSET_V = {};\n/* hfy-asset-versions:end */\nconst VERSION = 1;\n";

test("applyStamp is idempotent, keeps the indentation, and round-trips through readStamp", () => {
  const v = { theme: "0123abcd", islands: { shell: { js: "11111111", css: "22222222" } } };
  const once = applyStamp(FF, v, "ff");
  assert.equal(applyStamp(once, v, "ff"), once);
  assert.deepEqual(readStamp(once), v);
  assert.ok(once.includes("\n  const ASSET_V = {\n    \"theme\""), "indented to the marker");
  assert.ok(once.endsWith("  const other = 1;\n})();\n"), "nothing outside the markers changes");
  const newer = applyStamp(once, { ...v, theme: "ffffffff" }, "ff");
  assert.equal((newer.match(/hfy-asset-versions:start/g) || []).length, 1, "a rebuild replaces the block");
  assert.equal(readStamp(newer).theme, "ffffffff");
  assert.throws(() => applyStamp("no markers", v, "x.js"), /x\.js: no "hfy-asset-versions:start/);
  assert.ok(stampBlock({}).startsWith("/* hfy-asset-versions:start"));
});

test("stampSources: sw.js carries theme / manifest / shell / notify, feature-flags.js carries the islands and the hash of the stamped sw.js", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hfy-assetv-"));
  const mk = (extra) => {
    const files = new Map(Object.entries({
      "js/islands/shell.js": "shell-js", "js/islands/shell.css": "shell-css", "js/islands/person.js": "person-js", "js/islands/notify-sw.js": "notify",
      "css/hfy-theme.css": "theme", "manifest.webmanifest": "manifest", ...extra
    }));
    const hash = (rel) => (files.has(rel) ? sha8(files.get(rel)) : null);
    return { files, hash };
  };
  const dir = join(tmp, "js");
  // the sources are read from the site dir: use a throwaway one
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(tmp, "sw.js"), SW);
  writeFileSync(join(dir, "feature-flags.js"), FF);
  try {
    const a = mk({});
    stampSources({ site: tmp, files: a.files, islandNames: ["shell", "person"], hashOf: a.hash });
    const sw = readStamp(a.files.get("sw.js"));
    assert.deepEqual(sw, { theme: sha8("theme"), manifest: sha8("manifest"), shell: { js: sha8("shell-js"), css: sha8("shell-css") }, notify: sha8("notify") });
    const ff = readStamp(a.files.get("js/feature-flags.js"));
    assert.deepEqual(Object.keys(ff.islands), ["person", "shell"]);
    assert.deepEqual(ff.islands.person, { js: sha8("person-js") }, "an island without a stylesheet has no css hash");
    assert.equal(ff.sw, sha8(a.files.get("sw.js")), "feature-flags.js carries the hash sw.js is registered at");
    assert.equal(ff.theme, sw.theme);
    assert.equal(ff.manifest, sw.manifest);

    // a changed island entry changes feature-flags.js (so its own ?v) but not sw.js; a changed shell changes sw.js too, and with it ff.sw
    const b = mk({ "js/islands/person.js": "person-js-2" });
    stampSources({ site: tmp, files: b.files, islandNames: ["shell", "person"], hashOf: b.hash });
    assert.equal(b.files.get("sw.js"), a.files.get("sw.js"));
    assert.notEqual(b.files.get("js/feature-flags.js"), a.files.get("js/feature-flags.js"));
    const c = mk({ "js/islands/shell.js": "shell-js-2" });
    stampSources({ site: tmp, files: c.files, islandNames: ["shell", "person"], hashOf: c.hash });
    assert.notEqual(c.files.get("sw.js"), a.files.get("sw.js"));
    assert.notEqual(readStamp(c.files.get("js/feature-flags.js")).sw, ff.sw);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------------------------------------------- the site
test("every page of the site: every same-origin script / stylesheet / manifest reference is versioned with the hash of the file on disk", () => {
  const pages = htmlPages(site);
  assert.ok(pages.length >= 13, `found ${pages.length} pages`);
  let total = 0;
  for (const page of pages) {
    const refs = assetRefs(read(page), page);
    assert.ok(refs.length >= 1, `${page} references at least the theme`);
    for (const r of refs) {
      total += 1;
      assert.ok(r.version, `${page}: ${r.ref} has no ?v=`);
      assert.equal(r.version, hashOnDisk(r.file), `${page}: ${r.ref} ?v does not match the sha256 of ${r.file} (run \`cd islands && npm run build\`)`);
    }
  }
  assert.ok(total >= 40, `${total} references checked`);
  // the references that exist today are all covered (a new kind of reference would show up here first)
  const all = new Set(pages.flatMap((p) => assetRefs(read(p), p).map((r) => r.file)));
  for (const f of ["css/main.css", "css/hfy-theme.css", "js/feature-flags.js", "js/auth-v2.js", "js/bootstrap.bundle.min.js", "js/person-page.js"]) {
    assert.ok(all.has(f), `${f} is referenced and versioned somewhere`);
  }
  const raw = pages.flatMap((p) => [...read(p).matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["'](\/[^"'/][^"']*\.(?:js|css|webmanifest)[^"']*)["']/gi)].map((m) => `${p} ${m[1]}`));
  assert.deepEqual(raw.filter((s) => !/\?v=[0-9a-f]{8}(["']|$)/.test(s) && !/\?v=[0-9a-f]{8}$/.test(s)), [], "no unversioned js/css/manifest reference is left in any page");
});

test("js/feature-flags.js and sw.js carry the hashes of the files on disk", () => {
  const ff = readStamp(read("js/feature-flags.js"));
  const sw = readStamp(read("sw.js"));
  assert.ok(ff && sw, "both files have a stamped hfy-asset-versions block (run `cd islands && npm run build`)");
  const entries = readdirSync(join(site, "js/islands")).filter((f) => /^[^/]+\.js$/.test(f) && f !== "notify-sw.js").map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(Object.keys(ff.islands).sort(), entries, "every island entry has a version");
  for (const name of entries) {
    assert.equal(ff.islands[name].js, hashOnDisk(`js/islands/${name}.js`), `${name}.js`);
    assert.equal(ff.islands[name].css ?? null, hashOnDisk(`js/islands/${name}.css`), `${name}.css`);
  }
  assert.equal(ff.theme, hashOnDisk("css/hfy-theme.css"));
  assert.equal(ff.manifest, hashOnDisk("manifest.webmanifest"));
  assert.equal(ff.sw, hashOnDisk("sw.js"), "the shell registers /sw.js?v=<sha8 of sw.js>");
  assert.deepEqual(sw, { theme: ff.theme, manifest: ff.manifest, shell: ff.islands.shell, notify: hashOnDisk("js/islands/notify-sw.js") });
  // no cycle: the service worker must not embed anything that depends on it
  assert.doesNotMatch(read("sw.js"), /feature-flags/);
  assert.doesNotMatch(readFileSync(join(site, "js/islands/shell.js"), "utf8"), new RegExp(ff.sw), "shell.js reads the sw hash from HFYFeatureFlags.assetVersions, it does not embed it");
});

test("island entries import their chunks by relative, content-hashed names that exist (so the entry's ?v is the only version needed)", () => {
  const dir = join(site, "js/islands");
  const chunks = new Set(readdirSync(join(dir, "chunks")));
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "notify-sw.js"), ...[...chunks].map((c) => `chunks/${c}`)];
  let imports = 0;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+\.js)["']/g)].map((m) => m[1]);
    for (const s of specs) {
      imports += 1;
      assert.match(s, /^\.\.?\/(?:chunks\/)?[\w-]*-[A-Z0-9]{8}\.js$/, `${f}: ${s} is a relative content-hashed chunk`);
      const target = join(dirname(join(dir, f)), s);
      assert.ok(existsSync(target), `${f}: ${s} exists`);
    }
  }
  assert.ok(imports > 10, `${imports} chunk imports checked`);
});

// ------------------------------------------------------------------------------------------------- the island loader (vm)
function loader() {
  const created = [];
  const appended = [];
  const makeEl = (tag) => {
    const el = { tag, attrs: {}, setAttribute(k, v) { el.attrs[k] = v; }, remove() {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} };
    created.push(el);
    return el;
  };
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const sandbox = {
    console: { ...console, debug() {}, warn() {}, error() {} }, URL, URLSearchParams, Promise, setTimeout, clearTimeout,
    sessionStorage: store(), localStorage: store(),
    document: {
      readyState: "complete", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
      head: { appendChild(el) { appended.push(el); if (el.tag === "link" && el.onload) Promise.resolve().then(() => el.onload()); } },
      body: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {} } }, createElement: makeEl
    },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  sandbox.window = sandbox;
  sandbox.location = sandbox.window.location = { hostname: "localhost", pathname: "/about/", search: "", hash: "", href: "http://localhost/about/", replace() {} };
  vm.runInNewContext(read("js/feature-flags.js"), sandbox);
  return { w: sandbox, appended, created };
}

test("loadIsland requests <name>.js and <name>.css with ?v=<sha8 of the entry>; an unknown island falls back to the bare URL", async () => {
  const { w, appended } = loader();
  const ff = readStamp(read("js/feature-flags.js"));
  assert.deepEqual(JSON.parse(JSON.stringify(w.HFYFeatureFlags.assetVersions)), ff, "HFYFeatureFlags.assetVersions is the stamped map (the shell registers /sw.js?v=<assetVersions.sw>)");
  for (const name of Object.keys(ff.islands)) {
    appended.length = 0;
    const script = w.HFYFeatureFlags.loadIsland(name);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(script.src, `/js/islands/${name}.js?v=${ff.islands[name].js}`);
    const css = appended.find((el) => el.tag === "link");
    assert.equal(css.href, `/js/islands/${name}.css?v=${ff.islands[name].css}`);
    assert.ok(appended.includes(script), `${name}: the module is appended once its stylesheet applied`);
  }
  const unknown = w.HFYFeatureFlags.loadIsland("not-built");
  assert.equal(unknown.src, "/js/islands/not-built.js");
});

// --------------------------------------------------------------------------------------------------------- the worker (vm)
function worker(registeredAt) {
  const handlers = {};
  const imported = [];
  const cacheAdds = [];
  const deleted = [];
  let skipped = 0;
  let claimed = 0;
  const sandbox = {
    URL, Response, Promise, console,
    Request: class { constructor(u, init) { this.url = new URL(u, "https://harrisonfamily.us/").href; this.cache = init && init.cache; } },
    importScripts: (u) => imported.push(u),
    caches: {
      open: async () => ({ add: async (req) => { assert.equal(req.cache, "reload", "precache bypasses the HTTP cache"); cacheAdds.push(new URL(req.url).pathname + new URL(req.url).search); } }),
      keys: async () => ["hfy-shell-v1", "hfy-shell-v3", "hfy-shell-0badc0de", "hfy-shell-current-placeholder"],
      delete: async (k) => { deleted.push(k); return true; }
    },
    fetch: async () => new Response("x"),
    skipWaiting: () => { skipped += 1; },
    clients: { claim: async () => { claimed += 1; } },
    addEventListener: (type, fn) => { handlers[type] = fn; }
  };
  sandbox.self = sandbox;
  sandbox.location = { href: registeredAt, origin: "https://harrisonfamily.us" };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("sw.js"), ctx);
  return { ctx, handlers, imported, cacheAdds, deleted, get skipped() { return skipped; }, get claimed() { return claimed; } };
}

test("sw.js: cache name from the registered ?v, versioned precache + notify-sw import, old caches dropped on activate, skipWaiting on install", async () => {
  const sw = readStamp(read("sw.js"));
  const w = worker("https://harrisonfamily.us/sw.js?v=1234abcd");
  assert.equal(vm.runInContext("VERSION", w.ctx), "hfy-shell-1234abcd");
  assert.deepEqual(w.imported, [`/js/islands/notify-sw.js?v=${sw.notify}`]);
  const precache = vm.runInContext("PRECACHE", w.ctx);
  assert.deepEqual([...precache], [
    "/offline.html", `/css/hfy-theme.css?v=${sw.theme}`, `/js/islands/shell.js?v=${sw.shell.js}`, `/js/islands/shell.css?v=${sw.shell.css}`,
    `/manifest.webmanifest?v=${sw.manifest}`, "/images/pwa-192.png"
  ]);

  let installed = false;
  w.handlers.install({ waitUntil: (p) => { installed = p.then(() => true); } });
  assert.equal(await installed, true);
  assert.deepEqual(w.cacheAdds, [...precache], "the versioned URLs are what gets precached");
  assert.equal(w.skipped, 1, "a new worker does not wait for the old one's last tab to close");

  let activated;
  w.handlers.activate({ waitUntil: (p) => { activated = p; } });
  await activated;
  assert.deepEqual(w.deleted.sort(), ["hfy-shell-0badc0de", "hfy-shell-current-placeholder", "hfy-shell-v1", "hfy-shell-v3"], "every cache that is not the current one is deleted");
  assert.equal(w.claimed, 1);

  // a different registration is a different cache; a bare or malformed ?v lands in "dev", never in a versioned name
  assert.equal(vm.runInContext("VERSION", worker("https://harrisonfamily.us/sw.js?v=ffffffff").ctx), "hfy-shell-ffffffff");
  assert.equal(vm.runInContext("VERSION", worker("https://harrisonfamily.us/sw.js").ctx), "hfy-shell-dev");
  assert.equal(vm.runInContext("VERSION", worker("https://harrisonfamily.us/sw.js?v=../../x").ctx), "hfy-shell-dev");
});

test("sw.js: the stable-name routes include every versioned precache path, chunks and fonts stay cache-first", () => {
  const w = worker("https://harrisonfamily.us/sw.js?v=1234abcd");
  assert.deepEqual([...vm.runInContext("STABLE", w.ctx)].sort(), ["/css/hfy-theme.css", "/images/pwa-192.png", "/js/islands/shell.css", "/js/islands/shell.js", "/manifest.webmanifest", "/offline.html"]);
  const src = read("sw.js");
  assert.match(src, /url\.pathname\.startsWith\(CHUNKS\) \|\| url\.pathname\.startsWith\(FONTS\)/);
  assert.match(src, /caches\.match\(req, \{ ignoreSearch: true \}\)/, "offline falls back to the newest copy of the path under any ?v");
});
