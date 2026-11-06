// HFY-TSK-191: lib/comments-ui.jsx finds three things in the @io-kit/comments Comment by markup and label text, because the kit has no
// moderation slot on a comment yet (kit backlog: Comment `renderModeration`): the unhide and edit buttons it presses for the one-tap controls,
// and the moderation <details> it closes. This test reads the installed kit's source and fails loudly the moment a class name or a label key
// the watchers rely on moves, instead of the controls silently going missing. When the kit ships the slot, delete the watchers and this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COPY } from "../src/lib/moderation.js";

const ui = readFileSync(new URL("../src/lib/comments-ui.jsx", import.meta.url), "utf8");
const kit = readFileSync(new URL("../node_modules/@io-kit/comments/dist/src/react.js", import.meta.url), "utf8");

test("the classes the moderation watchers query are still drawn by the kit's Comment", () => {
  for (const cls of ["io-comments-comment", "io-comments-moderated", "io-comments-moderation", "io-comments-banner", "io-comments-actions", "io-comments-control", "io-comments-badge"]) {
    assert.ok(kit.includes(`"${cls}"`) || kit.includes(`${cls} `) || kit.includes(` ${cls}"`), `kit no longer draws .${cls}: update watchModerationButtons / watchModerationSheets`);
  }
});

test("the buttons the watchers press are still drawn from the label keys the watchers match by text", () => {
  // the kit draws the menu's unhide and the comment's edit and delete from these label keys; the island's LABELS supplies the visible text
  for (const key of ["unhide", "edit", "delete"]) {
    assert.match(kit, new RegExp(`labels\\.${key}\\b`), `kit no longer reads labels.${key}`);
    assert.match(ui, new RegExp(`^  ${key}: `, "m"), `the island sets no label for ${key}`);
  }
  // the watchers match the visible text of those buttons, so the three texts must stay distinct
  assert.match(ui, /^  edit: "edit",$/m);
  assert.match(ui, /^  delete: "delete",$/m);
  assert.match(ui, /^  unhide: MOD_COPY\.unhide,$/m);
  assert.equal(new Set([COPY.unhide, "edit", "delete"]).size, 3);
});

test("the kit still has no Comment moderation slot (when it does, replace the watchers)", () => {
  assert.doesNotMatch(kit, /renderModeration/, "the kit now has renderModeration on Comment: raise the watchers' removal");
});
