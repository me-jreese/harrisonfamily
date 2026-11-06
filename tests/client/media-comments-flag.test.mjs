// HFY-TSK-389-0A: mediaCommentsV1 shipped false (flipped true by HFY-TSK-396, G-prod P4-R6, io 2026-11-06), is not implied by another flag, and gates only the comments slot of the media detail (the island reads it itself).
// Run: node --test tests/client/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("flags.json has mediaCommentsV1 and mediaBrowserV1 true after the HFY-TSK-396 flip, and authV2 untouched", () => {
  const flags = JSON.parse(read("11ty/_data/flags.json"));
  assert.equal(flags.mediaCommentsV1, true);
  assert.equal(flags.mediaBrowserV1, true);
  assert.equal(flags.authV2, true);
});

test("the loader does not imply mediaCommentsV1 from another flag", () => {
  const src = read("11ty/js/feature-flags.js");
  assert.ok(!/merged\.mediaCommentsV1\s*=/.test(src));
});

test("the media-browser island fills the comments slot only through MediaCommentsHost, enabled by mediaCommentsV1", () => {
  const island = read("islands/src/islands/media-browser.jsx");
  assert.match(island, /f\.mediaCommentsV1 === true/);
  assert.match(island, /<MediaCommentsHost subject=\{p\.subject\} enabled=\{mediaComments\} \/>/);
  const host = read("islands/src/lib/media-comments-host.jsx");
  assert.match(host, /enabled === true/);
  assert.match(host, /\^media:/);
  assert.ok(!/gramps|sync/i.test(host.replace(/Gramps path|Gramps id|gramps_id|Gramps\)/gi, "")), "media comments never touch a Gramps path (D-36)");
});
