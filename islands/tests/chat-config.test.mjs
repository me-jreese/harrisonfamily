// HFY-TSK-142: the chat island's host configuration and wiring, pinned without a browser. The behaviour in a browser is
// tests/chat.spec.mjs; this file is the "config test" of the task: the Q2-16 defaults (BRD2, io's chat answers), the R-18 pre-check
// being the Worker's module, the page and flag registrations, the loader and service worker entries, and the exact kit pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PAGES } from "../heads.mjs";
import { COPY_EXTRA } from "../copy.mjs";
import {
  CLIENT_OPTIONS, CONVERSATION_OPTIONS, SHELL_OPTIONS, STORAGE_KEY, chatUrl, convFromSearch, copyFor, expSeconds, isMobileAgent, isPopout, noticeLine,
  outboxName, shellOptionsFor, signInHref, snapshotKey,
} from "../src/lib/chat-config.js";
import { contactGuard } from "../src/lib/chat-guard.js";
import { contactGuard as workerGuard } from "../../chat-worker/src/common.mjs";
import { CHAT_DEFAULT_OFF, catalogFor, withDefaultOff } from "../src/lib/notify-catalog.js";
import { DEFAULT_CLIENT_TIMINGS, TIMINGS } from "@io-kit/chat";
import { CHAT_COPY, SHELL_COPY, resolveShellOptions, renderBody } from "@io-kit/chat/react";

const here = dirname(fileURLToPath(import.meta.url));
const islandsDir = join(here, "..");
const repo = join(islandsDir, "..");
const read = (...p) => readFileSync(join(repo, ...p), "utf8");

// ------------------------------------------------------------------------------------------------------------ Q2-16 defaults

test("Q2-16 host options: the verified original behaviours are on; auto-open and post-creation policy changes are off", () => {
  const o = resolveShellOptions(shellOptionsFor({ narrow: false, medium: false, navigate() {} }));
  // ON: docked moles with pop-out; the title-bar flash and the tab-title flash; q to focus search
  assert.equal(o.dock, true);
  assert.equal(o.popOut, true);
  assert.equal(o.titleFlash, true);
  assert.equal(o.tabFlash, true);
  assert.equal(o.searchShortcut, true);
  // OFF: auto-open on an incoming message, and changing a group between private and open after creation
  assert.equal(o.autoOpen, false);
  assert.equal(o.changePolicy, false);
  // renameGroup is a CHAT-D10 reading, not a verified Gmail behaviour: it stays on until io's UAT keep-or-cut answer (hfy-chat-uat)
  assert.equal(o.renameGroup, true);
  // the keys the shell remembers, and the family list cap (Gmail's 40-contact cap)
  assert.equal(o.storageKey, "hfy:chat");
  assert.equal(STORAGE_KEY, "hfy:chat");
  assert.equal(o.rosterCap, 40);
  assert.deepEqual(Object.keys(SHELL_OPTIONS).sort(), ["autoOpen", "changePolicy", "dock", "popOut", "renameGroup", "rosterCap", "searchShortcut", "storageKey", "tabFlash", "titleFlash"]);
});

test("Q2-16 conversation options: typed emoticons, typing and 'has entered text', sparse 'sent at' lines are on", () => {
  const o = resolveShellOptions(shellOptionsFor({ narrow: false, medium: false, navigate() {} })).conversation;
  assert.deepEqual(o, { emoticons: true, typingLine: true, enteredText: true, sentAtLines: true, sentAtGapMs: 5 * 60 * 1000 });
  assert.deepEqual({ ...CONVERSATION_OPTIONS }, o);
  // a typed emoticon is shown as an emoji; the stored text is never changed (renderBody only draws)
  const drawn = renderBody("hi :)", true);
  assert.equal(drawn[0], "hi ");
  assert.equal(drawn[1].props.className, "io-chat-emoticon");
  assert.equal(drawn[1].props.children, "🙂");
  assert.deepEqual(renderBody("hi :)", false), ["hi :)"]);
});

test("Q2-16 client: the paused state is sent, idle is 15 minutes, and the host overrides no timing", () => {
  assert.equal(CLIENT_OPTIONS.sendPaused, true);
  assert.deepEqual(Object.keys(CLIENT_OPTIONS), ["sendPaused"], "no `timings` override: the kit's verified idle (15 minutes) and ping timings stand");
  assert.equal(DEFAULT_CLIENT_TIMINGS.idleMs, 15 * 60 * 1000);
  assert.equal(TIMINGS.idleMs, 900000);
});

test("Q2-16: Enter sends and there is no Send button, because the kit has no string for one", () => {
  const strings = Object.keys({ ...CHAT_COPY, ...SHELL_COPY });
  assert.deepEqual(strings.filter((k) => /^send/i.test(k)), [], "a Send button would need a copy string; the composer says 'press enter to send.' instead");
  assert.match(CHAT_COPY.placeholder, /press enter to send/);
  assert.equal(copyFor({ narrow: true }).placeholder, "type a message", "the phone's placeholder has no keyboard hint (chat.md 15.5)");
  assert.deepEqual(copyFor({ narrow: false }), {});
});

test("Q2-16: chat web push is a per-user setting that starts off, and appears only while chatV1 is on", () => {
  assert.deepEqual(CHAT_DEFAULT_OFF, ["chat_message"]);
  assert.deepEqual(withDefaultOff({}).types.chat_message, { enabled: false, level: 0 });
  assert.equal(catalogFor({ admin: true, chat: false }).types.chat_message, undefined);
  assert.ok(catalogFor({ admin: false, chat: true }).types.chat_message);
});

test("the pop-out is /chat/?c=<id>&popout=1 and the page reads the same URL back", () => {
  const o = resolveShellOptions(shellOptionsFor({ narrow: false, medium: false, navigate() {} }));
  const url = o.popOutUrl("dm:I9001:I9002");
  assert.equal(url, "/chat/?c=dm%3AI9001%3AI9002&popout=1");
  const search = url.slice(url.indexOf("?"));
  assert.equal(convFromSearch(search), "dm:I9001:I9002");
  assert.equal(isPopout(search), true);
  assert.equal(isPopout("?c=x"), false);
  assert.equal(chatUrl("dm:I9001:I9002"), "/chat/?c=dm%3AI9001%3AI9002");
  assert.equal(chatUrl(null), "/chat/");
  assert.equal(convFromSearch(""), null);
  assert.equal(convFromSearch("?c=" + "x".repeat(201)), null);
});

test("the panel starts open from 64rem, collapsed between 43rem and 64rem, and nothing docks under 43rem (chat.md 15.1, 15.3, 15.4)", () => {
  const wide = shellOptionsFor({ narrow: false, medium: false, navigate() {} });
  const medium = shellOptionsFor({ narrow: false, medium: true, navigate() {} });
  const phone = shellOptionsFor({ narrow: true, medium: true, navigate() {} });
  assert.equal(wide.defaultPanelOpen, true);
  assert.equal(medium.defaultPanelOpen, false);
  assert.equal(phone.defaultPanelOpen, false);
  assert.equal(wide.dock, true);
  assert.equal(phone.dock, false);
  const seen = [];
  phone.onOpen("dm:I9001:I9002");
  const nav = shellOptionsFor({ narrow: true, medium: true, navigate: (u) => seen.push(u) });
  nav.onOpen("dm:I9001:I9002");
  assert.deepEqual(seen, ["/chat/?c=dm%3AI9001%3AI9002"], "with docking off, opening a chat goes to the page");
});

test("storage names carry the user id, and a refused or halted connection has its line", () => {
  assert.equal(snapshotKey("I9001"), "hfy:chat:v1:I9001");
  assert.equal(outboxName("I9001"), "hfy:chat:outbox:I9001");
  assert.equal(noticeLine("sign_in"), "signedOut");
  assert.equal(noticeLine("reload"), "newVersion");
  for (const n of ["forbidden", "unavailable", "protocol"]) assert.equal(noticeLine(n), "unavailable");
  assert.equal(noticeLine(null), null);
  for (const k of ["signedOut", "newVersion", "unavailable"]) assert.ok(CHAT_COPY[k], `CHAT_COPY.${k}`);
  assert.equal(CHAT_COPY.signedOut, "sign in to chat.");
  assert.equal(CHAT_COPY.unavailable, "chat isn't available right now.");
  assert.equal(isMobileAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isMobileAgent("Mozilla/5.0 (Linux; Android 14)"), true);
  assert.equal(isMobileAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
  assert.equal(expSeconds({ exp: 1800000000 }), 1800000000);
  assert.equal(expSeconds({ exp: 1800000000000 }), 1800000000);
  assert.equal(expSeconds({}), undefined);
  assert.equal(expSeconds(null), undefined);
});

test("the signed-out gate returns to a same-origin path: ?c= kept, ?popout= dropped, always encoded", () => {
  assert.equal(signInHref({ pathname: "/chat/", search: "" }), "/auth/login?returnTo=%2Fchat%2F");
  assert.equal(signInHref({ pathname: "/chat/", search: "?c=dm%3AI9001%3AI9002" }), "/auth/login?returnTo=%2Fchat%2F%3Fc%3Ddm%253AI9001%253AI9002");
  assert.equal(signInHref({ pathname: "/chat/", search: "?popout=1&c=g1" }), "/auth/login?returnTo=%2Fchat%2F%3Fc%3Dg1");
  assert.equal(signInHref({ pathname: "/chat/", search: "?popout=1" }), "/auth/login?returnTo=%2Fchat%2F");
  // nothing here can build an absolute or protocol-relative target: the value always starts with the page's own path
  assert.match(signInHref({ pathname: "/chat/", search: "?c=//evil.example" }), /^\/auth\/login\?returnTo=%2Fchat%2F/);
});

test("sign-out erases a session's chat state: forgetEdgeSession purges hfy:chat:* storage and the outbox, and the island erases its client", () => {
  const js = read("11ty", "js", "feature-flags.js");
  assert.match(js, /featureAPI\.purgeChatState = purgeChatState;/);
  assert.match(js, /forgetEdgeSession\(\) \{\s*purgeChatState\(\);/);
  assert.match(js, /const CHAT_KEY_PREFIX = "hfy:chat:";/);
  assert.match(js, /const CHAT_OUTBOX_PREFIX = "hfy:chat:outbox:";/);
  assert.ok(js.includes('new Event("hfy:signout")'));
  // the prefixes are the island's own names
  assert.ok(snapshotKey("U").startsWith("hfy:chat:") && outboxName("U").startsWith("hfy:chat:outbox:") && `${STORAGE_KEY}:panel`.startsWith("hfy:chat:"));
  const isl = readFileSync(join(islandsDir, "src", "islands", "chat.jsx"), "utf8");
  assert.match(isl, /addEventListener\("hfy:signout"[^]*client\.signOut\(\)/);
  assert.match(isl, /flags\.purgeChatState\?\.\(\)/);
});

test("the island keeps /chat/'s placeholder until the client is built, and says so when it cannot start", () => {
  const isl = readFileSync(join(islandsDir, "src", "islands", "chat.jsx"), "utf8");
  const start = isl.slice(isl.indexOf("async function start()"));
  assert.ok(start.indexOf("buildClient(") < start.lastIndexOf("offLine()?.remove()"), "on the signed-in path the placeholder goes only after the client is built");
  assert.match(start, /catch \(err\) \{[^}]*showUnavailable\(\)/);
  assert.match(isl, /resolveCopy\(\)\.unavailable/);
});

// --------------------------------------------------------------------------------------------------- R-18, one detector

test("the composer's R-18 pre-check is shared/privacy-guard.mjs, the module the Worker bundles: same spans on every vector", () => {
  assert.match(read("islands", "src", "lib", "chat-guard.js"), /from "\.\.\/\.\.\/\.\.\/shared\/privacy-guard\.mjs"/);
  assert.match(read("chat-worker", "src", "common.mjs"), /from "\.\.\/\.\.\/shared\/privacy-guard\.mjs"/);
  const vectors = JSON.parse(read("shared", "privacy-guard.vectors.json"));
  const plain = (marked) => marked.replace(/⟦[^|]*\|/g, "").replace(/⟧/g, "");
  let hits = 0;
  for (const c of vectors.cases) {
    const text = plain(c.text);
    const client = contactGuard(text);
    assert.deepEqual(client, workerGuard(text), c.id);
    hits += client.length;
    for (const [start, end, kind] of client) assert.ok(Number.isInteger(start) && end > start && typeof kind === "string", c.id);
  }
  assert.ok(hits > 20, "the vectors exercise real hits");
  assert.deepEqual(contactGuard("call me at (555) 010-0199").map(([s, e]) => [s, e]), [[11, 25]]);
  assert.deepEqual(contactGuard("see you at noon"), []);
});

test("the guard bundles for the islands' browser target and runs from the bundle, with the same spans", async () => {
  const out = await build({
    stdin: { contents: 'export { contactGuard } from "./src/lib/chat-guard.js";', resolveDir: islandsDir, loader: "js" },
    bundle: true, format: "esm", platform: "browser", target: ["es2020", "safari15"], minify: true, write: false, logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /\(\?<[=!]/, "a lookbehind would not run in safari15");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  for (const text of ["call me at (555) 010-0199 tonight", "write to someone@example.com", "see you at noon"]) assert.deepEqual(mod.contactGuard(text), workerGuard(text));
});

// ---------------------------------------------------------------------------------------------- flags, pages, loader, worker

test("chatV1 is false in 11ty/_data/flags.json (the other copy is the Eleventy source's, mirrored by scripts/orchestration/mirror_sync.sh)", () => {
  const flags = JSON.parse(read("11ty", "_data", "flags.json"));
  assert.equal(flags.chatV1, false);
  assert.match(read("scripts", "orchestration", "mirror_sync.sh"), /_data\/flags\\\.json/);
});

test("/chat/ is registered: PAGES, COPY_EXTRA, the README's repo-owned list, the rsync excludes, the mirror script; the page holds its fallback text and host", () => {
  assert.ok(PAGES.includes("chat/index.html"));
  assert.ok(COPY_EXTRA.includes("chat/index.html"));
  const readme = read("11ty", "README.md");
  assert.match(readme, /^\| `chat\/` \|/m, "the README's repo-owned table lists chat/");
  assert.match(readme, /--exclude chat\//, "the README's refresh rsync leaves chat/ alone");
  assert.match(read("scripts", "check-deployment-sync.sh"), /--exclude 'chat\/'/, "the sync check excludes chat/ too");
  assert.match(read("scripts", "orchestration", "mirror_sync.sh"), /chat\/index\\\.html/, "the mirror script carries the page into the Eleventy source");
  const page = read("11ty", "chat", "index.html");
  assert.match(page, /<title>chat · Harrison Family<\/title>/);
  assert.match(page, /data-chat-off>chat isn't turned on yet\.<\/p>/);
  assert.match(page, /<div data-island="chat"><\/div>/);
  assert.match(page, /<noscript>/);
  assert.match(page, /hfy-theme:start A/, "the build wrote the head blocks");
});

test("feature-flags.js loads the chat island with chatV1 only (every page signed in, /chat/ always) and exposes the page's refresh", () => {
  const js = read("11ty", "js", "feature-flags.js");
  assert.match(js, /featureAPI\.refreshSession = function/);
  const block = js.slice(js.indexOf("HFY-TSK-142: chatV1"));
  assert.match(block, /if \(flags\.chatV1 !== true\) return;/);
  assert.match(block, /\^\\\/chat\\\/\?\(index\\\.html\)\?\$/);
  assert.match(block, /loadIsland\("chat"/);
  assert.match(block, /session\.authenticated === true && session\.sub/);
  // with the flag off the loader makes no request: the island entry is named only inside the flag check
  assert.equal(js.split('loadIsland("chat"').length - 1, 2);
});

test("the service worker leaves /chat/ws and /chat/v1/ alone (network only), and still handles the /chat/ page", () => {
  const sw = read("11ty", "sw.js");
  const m = sw.match(/\/\^\\\/chat\\\/\(ws\|v1\)\(\\\/\|\$\)\/\.test\(url\.pathname\)/);
  assert.ok(m, "sw.js returns early for /chat/ws and /chat/v1/");
  const re = /^\/chat\/(ws|v1)(\/|$)/;
  for (const p of ["/chat/ws", "/chat/v1/health", "/chat/v1/"]) assert.ok(re.test(p), p);
  for (const p of ["/chat/", "/chat/index.html", "/chat/wsx", "/chat/v10"]) assert.ok(!re.test(p), p);
});

test("the island ships: the entry bundle and its stylesheet are built, and the bundle carries the guard, the client and the shell", () => {
  const js = read("11ty", "js", "islands", "chat.js");
  const css = read("11ty", "js", "islands", "chat.css");
  assert.ok(js.length > 10000);
  assert.match(js, /\/chat\/ws/, "the socket URL");
  assert.match(js, /hfy:chat:outbox:|outboxName|hfy:chat/, "the storage names");
  assert.match(css, /--io-chat-bar:/);
  assert.match(css, /--io-chat-presence-active:/);
  assert.doesNotMatch(css, /--io-chat-(bar|flash)(-fg)?:\s*#/, "the title bar and the flash are theme aliases, not literals");
});

test("islands/package.json pins @io-kit/chat exactly at 0.2.0 and the lockfile agrees (install discipline: no range, no lowered pin)", () => {
  const pkg = JSON.parse(read("islands", "package.json"));
  assert.equal(pkg.dependencies["@io-kit/chat"], "0.2.0");
  const lock = JSON.parse(read("islands", "package-lock.json"));
  assert.equal(lock.packages["node_modules/@io-kit/chat"].version, "0.2.0");
  assert.equal(lock.packages[""].dependencies["@io-kit/chat"], "0.2.0");
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is an exact pin`);
  const installed = JSON.parse(readFileSync(join(islandsDir, "node_modules", "@io-kit", "chat", "package.json"), "utf8"));
  assert.equal(installed.version, "0.2.0");
});
