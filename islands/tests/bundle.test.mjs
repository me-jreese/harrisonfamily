// HFY-R58: every islands/ build output is COMMITTED. The deploy syncs 11ty/ to S3 with --delete and never builds, so the outputs
// must be tracked by git, present, and byte-identical to a fresh build: the island bundles (js/islands/), the theme layer
// (css/hfy-theme.css), the sign-in stylesheet (css/auth-edge.css), the self-hosted faces (fonts/), the head blocks and the
// manifest colours. HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(repo, "11ty");
const out = join(site, "js", "islands");

test("island entry bundles, the theme layer, the sign-in stylesheet and the fonts are present", () => {
  for (const f of ["shell.js", "shell.css", "search.js", "search.css", "person.js", "my-posts.js", "timeline.js", "posts.js", "notifications.js", "settings.js", "settings.css", "tree.js", "tree.css", "inbox.js", "inbox.css", "inbox-page.js", "inbox-page.css", "edit-entry.js", "edit-entry.css", "editor.js", "editor.css", "family.js", "family.css", "family-entry.js", "family-entry.css", "review.js", "review.css", "access-requests.js", "access-requests.css", "admin-sync.js", "admin-sync.css", "join.js", "join.css", "join-entry.js", "join-entry.css", "notify-sw.js"]) {
    assert.ok(statSync(join(out, f)).size > 0, `js/islands/${f} is empty`);
  }
  for (const f of ["css/hfy-theme.css", "css/auth-edge.css"]) assert.ok(statSync(join(site, f)).size > 0, `${f} is empty`);
  const fonts = readdirSync(join(site, "fonts"));
  assert.equal(fonts.filter((f) => f.endsWith(".woff2")).length, 12, "fonts/ holds the 12 faces");
  assert.equal(fonts.filter((f) => /^LICENSE-.+\.txt$/.test(f)).length, 3, "fonts/ holds the 3 OFL licences");
});

test("the build outputs are not gitignored (they ship from the repo)", () => {
  for (const p of ["11ty/js/islands/shell.js", "11ty/css/hfy-theme.css", "11ty/css/auth-edge.css", "11ty/fonts/LICENSE-source-sans-3.txt"]) {
    const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: repo });
    assert.equal(r.status, 1, `.gitignore ignores ${p} (git check-ignore matched)`);
  }
  assert.doesNotMatch(readFileSync(join(repo, ".gitignore"), "utf8"), /^11ty\/(js\/islands|fonts|css)\/?\s*$/m);
});

test("committed outputs match a fresh build of islands/ (node build.mjs --check)", () => {
  const args = ["build.mjs", "--check", ...(process.env.HFY_SITE ? ["--site", site] : [])];
  const r = spawnSync(process.execPath, args, { cwd: islandsDir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("an island imports repo-root shared/ and the build bundles it (shared/validate.mjs -> js/islands)", () => {
  assert.match(readFileSync(join(islandsDir, "src", "lib", "people-corpus.js"), "utf8"), /from "\.\.\/\.\.\/\.\.\/shared\/validate\.mjs"/);
  // cleanText is inlined or chunked into the output of the island that loads people-corpus.js (search); its body is a stable marker.
  const bundles = readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const hit = bundles.some((f) => /typeof \w+ ?== ?"string" ?\? ?\w+\.trim\(\) ?: ?""/.test(readFileSync(join(out, String(f)), "utf8")));
  assert.ok(hit, "no bundle carries shared/validate.mjs cleanText");
});

// Every chunk an entry loads, itself included: static imports, re-exports and dynamic imports of relative .js files, transitively.
function reachable(entry) {
  const seen = new Set();
  const visit = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    for (const m of readFileSync(abs, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.js)"/g)) visit(resolve(dirname(abs), m[1]));
  };
  visit(join(out, entry));
  return [...seen];
}

test("HFY-TSK-315: the person and posts islands carry no Cloudscape code or styles (kit-content.mjs hfyNoDocumentEditor)", () => {
  // @io-kit/content 0.2.0+ re-exports DocumentEditor, whose Cloudscape barrel import put every Cloudscape component's stylesheet
  // (about 1.4 MB) into each posts island's CSS, although no island renders it. Only the search island uses Cloudscape.
  for (const name of ["person", "my-posts", "posts", "timeline"]) {
    for (const abs of reachable(`${name}.js`)) assert.doesNotMatch(readFileSync(abs, "utf8"), /awsui/, `${name}.js loads Cloudscape code (${abs.slice(out.length + 1)})`);
  }
  for (const f of ["my-posts.css", "posts.css", "timeline.css"]) {
    const css = readFileSync(join(out, f), "utf8");
    assert.doesNotMatch(css, /awsui/, `js/islands/${f} carries Cloudscape styles`);
    assert.ok(css.length < 64 * 1024, `js/islands/${f} is ${css.length} bytes: did a kit stylesheet get bundled in?`);
  }
  // The check can see Cloudscape: the search island does load it.
  assert.ok(reachable("search.js").some((abs) => /awsui/.test(readFileSync(abs, "utf8"))), "search.js no longer loads Cloudscape: is the marker still awsui?");
});

test("HFY-TSK-158: the family-section button is its own small bundle and the wizard loads only on /edit/family/ (the person page never loads it)", () => {
  // The entry reaches no wizard code (the screens, the model's copy) and no form kit; the wizard bundle carries no Cloudscape.
  for (const abs of reachable("family-entry.js")) {
    const code = readFileSync(abs, "utf8");
    assert.doesNotMatch(code, /data-hfy-wizard-ready|awsui/, `family-entry.js loads wizard or Cloudscape code (${abs.slice(out.length + 1)})`);
  }
  assert.ok(statSync(join(out, "family-entry.js")).size < 64 * 1024, "family-entry.js grew past 64 KB");
  assert.ok(reachable("family.js").some((abs) => /data-hfy-wizard-ready/.test(readFileSync(abs, "utf8"))), "family.js no longer carries the wizard: is the marker still data-hfy-wizard-ready?");
  for (const abs of reachable("family.js")) assert.doesNotMatch(readFileSync(abs, "utf8"), /awsui/, `family.js loads Cloudscape code (${abs.slice(out.length + 1)})`);
  // The shell and the person bundles do not reach the wizard either.
  for (const name of ["shell", "person"]) {
    for (const abs of reachable(`${name}.js`)) assert.doesNotMatch(readFileSync(abs, "utf8"), /data-hfy-wizard-ready/, `${name}.js loads the wizard (${abs.slice(out.length + 1)})`);
  }
});
