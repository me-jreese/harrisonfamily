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
  for (const f of ["shell.js", "shell.css", "search.js", "search.css", "person.js", "my-posts.js", "timeline.js", "posts.js", "notifications.js", "notify-sw.js"]) {
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
