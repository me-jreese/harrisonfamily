// HFY-TSK-185 (AC5): the islands CATALOG (src/lib/notify-catalog.js, the /me/notifications toggles and lock-screen preview) and the API's
// TEMPLATE_REGISTRY (api/src/notify.js) are two copies of one contract, kept in sync by hand. This test fails when they drift: a type id
// in one and not the other, or a title / level 0 / level 1 string that differs. `chat_message` joined the catalog in HFY-TSK-164, so its strings are compared too. Pure data: no browser, no network. Run: node --test tests/notify-catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, CATALOG_EXEMPT, CHAT_DEFAULT_OFF, GROUP_MODERATORS, catalogFor, withDefaultOff, withoutHiddenDefaults } from "../src/lib/notify-catalog.js";
import { TEMPLATE_REGISTRY, notifyContract } from "../../api/src/notify.js";

const registry = TEMPLATE_REGISTRY.features;
const ids = Object.keys(CATALOG.types);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

test("the catalog holds every registry type except the pinned exceptions, and nothing the registry lacks", () => {
  assert.deepEqual(CATALOG_EXEMPT.filter((id) => !(id in registry)), [], "an exempt type the registry no longer has");
  assert.deepEqual(ids.filter((id) => CATALOG_EXEMPT.includes(id)), [], "a catalog type still on the exempt list");
  assert.deepEqual(ids.filter((id) => !(id in registry)), [], "a catalog type the registry lacks");
  assert.deepEqual(Object.keys(registry).filter((id) => !(id in CATALOG.types) && !CATALOG_EXEMPT.includes(id)), [], "a registry type the catalog lacks");
  assert.deepEqual([...ids].sort(), Object.keys(registry).filter((id) => !CATALOG_EXEMPT.includes(id)).sort());
});

test("every catalog entry says word for word what the server pushes: title, level 0 (generic) and level 1 (detailed)", () => {
  for (const id of ids) {
    const t = registry[id];
    assert.equal(CATALOG.types[id].title, t.title, `${id} title`);
    assert.equal(CATALOG.types[id].generic, t.level0, `${id} generic (level 0)`);
    assert.equal(CATALOG.types[id].detailed, t.level1, `${id} detailed (level 1)`);
  }
});

test("the same holds through notifyContract(), the source other surfaces compare against", () => {
  const contract = notifyContract();
  for (const id of ids) {
    assert.equal(CATALOG.types[id].generic, contract.types[id].level0, id);
    assert.equal(CATALOG.types[id].detailed, contract.types[id].level1, id);
  }
});

test("every placeholder is a whitelisted field and the preview sample fills each of them", () => {
  const whitelist = TEMPLATE_REGISTRY.whitelist;
  for (const id of ids) for (const k of [...placeholders(CATALOG.types[id].generic), ...placeholders(CATALOG.types[id].detailed)]) assert.ok(whitelist.includes(k), `${id} uses {${k}}, which the server drops`);
  for (const k of whitelist) assert.ok(String(CATALOG.sample[k] ?? "").trim() !== "", `the preview sample lacks ${k}`);
});

test("every type sits in a declared group, and the groups are about me, family and for moderators", () => {
  assert.deepEqual(CATALOG.groups.map((g) => g.label), ["about me", "family", "for moderators"]);
  const groupIds = new Set(CATALOG.groups.map((g) => g.id));
  for (const id of ids) assert.ok(groupIds.has(CATALOG.types[id].group), `${id} is in an undeclared group`);
  for (const g of CATALOG.groups) assert.ok(ids.some((id) => CATALOG.types[id].group === g.id), `group ${g.label} is empty`);
});

test("voice: lowercase labels and descriptions, 'page' and never 'record'", () => {
  for (const [id, t] of Object.entries(CATALOG.types)) {
    for (const f of ["label", "desc"]) {
      assert.equal(t[f], t[f].toLowerCase(), `${id} ${f} is not lowercase`);
      assert.doesNotMatch(t[f], /\brecords?\b/, `${id} ${f} says record`);
    }
  }
});

test("only an admin sees the moderators' group; everyone else's catalog has none of its types", () => {
  const moderators = ids.filter((id) => CATALOG.types[id].group === GROUP_MODERATORS).sort();
  assert.deepEqual(moderators, ["moderation_resolved", "proposal_submitted"]);
  for (const viewer of [catalogFor(), catalogFor({ admin: false }), catalogFor({ admin: "yes" })]) {
    assert.deepEqual(Object.keys(viewer.types).filter((id) => moderators.includes(id)), []);
    assert.equal(viewer.groups.some((g) => g.id === GROUP_MODERATORS), false);
  }
  assert.equal(catalogFor({ admin: true, chat: true }), CATALOG);
});

test("an inbox type is also in the catalog, and the push-only types the server marks (inbox:false) are known to it", () => {
  const contract = notifyContract();
  const pushOnly = Object.keys(contract.types).filter((id) => !contract.types[id].inbox).sort();
  assert.deepEqual(pushOnly, ["chat_message", "new_family_post"]);
});

test("a type that coalesces (a group template in notifyContract) is a type the catalog or the pinned exceptions know", () => {
  for (const id of Object.keys(notifyContract().groups)) assert.ok(id in CATALOG.types || CATALOG_EXEMPT.includes(id), `${id} has a coalescing group but no catalog entry`);
});

test("chat_message is in the catalog with the registry's exact strings, and is no longer an exempt type (HFY-TSK-164)", () => {
  assert.ok("chat_message" in CATALOG.types);
  assert.equal(CATALOG_EXEMPT.includes("chat_message"), false);
  const t = CATALOG.types.chat_message;
  const r = registry.chat_message;
  assert.equal(r.inbox, false);
  assert.deepEqual([t.title, t.generic, t.detailed], [r.title, r.level0, r.level1]);
  assert.deepEqual([t.title, t.generic, t.detailed], ["Harrison Family", "you have a new chat message.", "{actor} sent you a chat message."]);
  assert.equal(t.group, "family");
  assert.equal(t.label, "someone sends me a chat message");
  assert.equal(t.desc, "a chat message while you're away from the site.");
  assert.ok(notifyContract().types.chat_message.inbox === false);
});

test("the chat toggle shows only while chatV1 is on, for admins and members alike", () => {
  assert.equal("chat_message" in catalogFor().types, false);
  assert.equal("chat_message" in catalogFor({ admin: true }).types, false);
  assert.equal("chat_message" in catalogFor({ chat: true }).types, true);
  assert.equal(catalogFor({ admin: true, chat: true }), CATALOG);
  assert.equal("proposal_submitted" in catalogFor({ chat: true }).types, false, "the chat flag does not open the moderators' group");
  assert.equal("chat_message" in catalogFor({ admin: true, chat: false }).types, false);
});

test("chat texts default OFF (CHAT-D12): the page shows chat_message off until the member saved a choice, and never overrides one", () => {
  assert.deepEqual(CHAT_DEFAULT_OFF, ["chat_message"]);
  assert.deepEqual(withDefaultOff({ enabled: true, types: {} }).types.chat_message, { enabled: false, level: 0 });
  assert.deepEqual(withDefaultOff(undefined).types.chat_message, { enabled: false, level: 0 });
  const saved = { enabled: true, types: { chat_message: { enabled: true, level: 1 }, mention: { enabled: false, level: 0 } } };
  assert.deepEqual(withDefaultOff(saved), saved);
});

test("a hidden, untouched default-off type is not saved; once the toggle is shown, or the member chose, it is", () => {
  const p = { enabled: true, types: { mention: { enabled: true, level: 0 }, chat_message: { enabled: false, level: 0 } } };
  assert.deepEqual(withoutHiddenDefaults(p, false).types, { mention: { enabled: true, level: 0 } });
  assert.equal(withoutHiddenDefaults(p, true), p);
  const chose = { enabled: true, types: { chat_message: { enabled: true, level: 0 } } };
  assert.equal(withoutHiddenDefaults(chose, false).types.chat_message.enabled, true);
  assert.equal(withoutHiddenDefaults(undefined, false), undefined);
});
