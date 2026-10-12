// HFY-R58: 11ty/js/islands is COMMITTED build output. The deploy syncs 11ty/ to S3 with --delete and never builds islands,
// so the bundle must be tracked by git, present, and byte-identical to a fresh build of islands/src.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(islandsDir, "..");
const out = join(repo, "11ty", "js", "islands");

test("island entry bundles the loader and /sw.js reference are present", () => {
  for (const f of ["shell.js", "shell.css", "search.js", "search.css", "person.js", "my-posts.js", "timeline.js", "posts.js", "notifications.js", "notify-sw.js"]) {
    assert.ok(statSync(join(out, f)).size > 0, `11ty/js/islands/${f} is empty`);
  }
});

test("11ty/js/islands is not gitignored (it ships from the repo)", () => {
  const r = spawnSync("git", ["check-ignore", "-q", "11ty/js/islands/shell.js"], { cwd: repo });
  assert.equal(r.status, 1, ".gitignore still ignores 11ty/js/islands/ (git check-ignore matched)");
  assert.doesNotMatch(readFileSync(join(repo, ".gitignore"), "utf8"), /^11ty\/js\/islands\/?\s*$/m);
});

test("committed bundle matches a fresh build of islands/src (node build.mjs --check)", () => {
  const r = spawnSync(process.execPath, ["build.mjs", "--check"], { cwd: islandsDir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
