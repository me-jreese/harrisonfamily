// HFY-TSK-185: the pure parts of the inbox UI (src/lib/inbox-model.js), the bell's wiring rules and the loader's page route. No browser.
// Run: node --test tests/inbox-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_INBOX_LABELS, bellBadgeText } from "@io-kit/notify/react";
import { COPY, INBOX_LABELS, INBOX_ROUTE, SETTINGS_ROUTE, SITE_TITLE, leadWithBody, safeTarget } from "../src/lib/inbox-model.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("every string the kit's bell and inbox render is set in the family's voice (none falls back to a kit default by omission)", () => {
  assert.deepEqual(Object.keys(INBOX_LABELS).sort(), Object.keys(DEFAULT_INBOX_LABELS).sort());
  for (const [k, v] of Object.entries(INBOX_LABELS)) {
    assert.equal(typeof v, "string", k);
    assert.equal(v, v.toLowerCase().replace(/text j\./, "text J."), `${k} is not lowercase (the contact's initial excepted)`);
    assert.doesNotMatch(v, /\brecords?\b/, `${k} says record`);
  }
  // the DS copy of the spec: header, empty, load more, mark-all button
  assert.equal(INBOX_LABELS.notifications, "notifications");
  assert.equal(INBOX_LABELS.empty, "you're all caught up.");
  assert.equal(INBOX_LABELS.showOlder, "show older");
  assert.equal(INBOX_LABELS.markAllRead, "mark all read");
  assert.equal(INBOX_LABELS.failed, "that didn't work. try again, or text J.");
  // the placeholders the kit fills are kept
  assert.match(INBOX_LABELS.bellUnread, /\{label\}.*\{count\}/);
  assert.match(INBOX_LABELS.markRead, /\{title\}/);
  assert.match(INBOX_LABELS.count, /\{count\}/);
  assert.equal(COPY.signedOut, "this page is family-only. sign in to see it.");
  assert.equal(SETTINGS_ROUTE, "/me/notifications/");
  assert.equal(INBOX_ROUTE, "/me/inbox/");
});

test("the bell's badge shows 1 to 9, then 9+, and nothing for 0 or no answer (kit)", () => {
  assert.deepEqual([null, 0, 1, 9, 10, 250].map(bellBadgeText), ["", "", "1", "9", "9+", "9+"]);
});

test("safeTarget keeps a same-origin path and sends anything else to the inbox page", () => {
  for (const ok of ["/person/?id=I0001", "/posts/?id=01ABC#c1", "/me/inbox/", "/"]) assert.equal(safeTarget(ok), ok);
  for (const bad of ["//evil.example/x", "https://evil.example/", "javascript:alert(1)", "/\\evil", "person/", "", null, undefined, 3, "/a\nb"]) assert.equal(safeTarget(bad), INBOX_ROUTE, String(bad));
});

test("leadWithBody puts the sentence first when the title is only the site name, and leaves any other title alone", () => {
  const item = { id: "1", type: "mention", title: SITE_TITLE, body: "A mentioned you.", read: false, count: 1 };
  assert.deepEqual(leadWithBody(item), { ...item, title: "A mentioned you.", body: "" });
  const own = { ...item, title: "A moderator's note", body: "details" };
  assert.equal(leadWithBody(own), own);
  const noBody = { ...item, body: "" };
  assert.equal(leadWithBody(noBody), noBody);
});

test("the loader opens /me/inbox/ (and its index.html), nothing else, and loads the bell only behind inboxV1 for a signed-in session", () => {
  const src = read("../../11ty/js/feature-flags.js");
  const m = /HFY-TSK-185: inboxV1[\s\S]*?resolveFlags\(\)\.then\(\(flags\) => \{([\s\S]*?)\n  \}\);/.exec(src);
  assert.ok(m, "the inboxV1 loader block is in feature-flags.js");
  const block = m[1];
  assert.match(block, /flags\.inboxV1 !== true\) return;/);
  const found = /if \((\/\^\\\/me\\\/inbox[^\n]*?\$\/)\.test\(window\.location\.pathname\)\)/.exec(block);
  assert.ok(found, "the page route test is in the block");
  const re = new Function(`return ${found[1]}`)();
  for (const p of ["/me/inbox", "/me/inbox/", "/me/inbox/index.html"]) assert.ok(re.test(p), p);
  for (const p of ["/me/", "/me/inbox/x", "/me/notifications/", "/inbox/", "/me/inboxes/"]) assert.ok(!re.test(p), p);
  assert.match(block, /loadIsland\("inbox-page"/);
  assert.match(block, /flags\.shellV2 !== true\) return;/);
  assert.match(block, /session\.authenticated === true && session\.sub\) loadIsland\("inbox"/);
  assert.ok(block.indexOf("flags.inboxV1 !== true") < block.indexOf('loadIsland("inbox"'), "the flag check comes first");
});

test("shell discipline (review DL-13): the bell fills only its own slot, through the registry; the shell's slot order is not edited", () => {
  const bell = read("../src/islands/inbox.jsx");
  assert.deepEqual([...bell.matchAll(/\.fill\("(\w+)"/g)].map((x) => x[1]), ["bell"]);
  assert.doesNotMatch(bell, /querySelector(All)?\([^)]*hfy-bar__end/);
  assert.doesNotMatch(bell, /shell\.jsx/);
  const shell = read("../src/islands/shell.jsx");
  assert.doesNotMatch(shell, /inbox|NotificationBell|iok-notify/i, "the shell knows nothing of the inbox: it only renders whatever fills the slot");
  assert.match(shell, /import \{ SLOT_ORDER, barSlots \} from "\.\.\/lib\/bar-slots\.js";/);
});
