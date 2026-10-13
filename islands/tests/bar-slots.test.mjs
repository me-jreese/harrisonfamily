// Unit tests for the bar-slot registry (HFY-TSK-138): order-independent fills, unknown names, replacement, pre-shell fills.
import test from "node:test";
import assert from "node:assert/strict";

const { barSlots, SLOT_ORDER, FILLABLE } = await import("../src/lib/bar-slots.js");

function fresh() { globalThis.window = {}; return barSlots(); }
function quiet(fn) { const w = console.warn; const calls = []; console.warn = (...a) => calls.push(a.join(" ")); try { fn(); } finally { console.warn = w; } return calls; }

test("the slot order is bell, chat, gear, account; only bell and chat are fillable", () => {
  assert.deepEqual(SLOT_ORDER, ["bell", "chat", "gear", "account"]);
  assert.deepEqual(FILLABLE, ["bell", "chat"]);
});

test("barSlots reuses one registry on window, so a fill made before the shell's call is kept", () => {
  const reg = fresh();
  const mount = () => {};
  reg.fill("chat", mount);
  assert.equal(barSlots(), reg);
  assert.equal(barSlots().get("chat").mount, mount);
});

test("unknown names and non-function mounts are rejected with a warning and a no-op withdraw", () => {
  const reg = fresh();
  const calls = quiet(() => {
    const off = reg.fill("chats", () => {});
    const off2 = reg.fill("gear", () => {});
    const off3 = reg.fill("bell", "nope");
    off(); off2(); off3();
  });
  assert.equal(calls.length, 3);
  assert.equal(reg.get("chats"), undefined);
  assert.equal(reg.get("gear"), undefined);
  assert.equal(reg.get("bell"), undefined);
});

test("a second fill replaces the first with a warning; the old withdraw is then a no-op", () => {
  const reg = fresh();
  const a = () => "a", b = () => "b";
  const offA = reg.fill("bell", a);
  let offB;
  const calls = quiet(() => { offB = reg.fill("bell", b); });
  assert.equal(calls.length, 1);
  assert.equal(reg.get("bell").mount, b);
  offA();
  assert.equal(reg.get("bell").mount, b, "the stale withdraw must not remove the new fill");
  offB();
  assert.equal(reg.get("bell"), undefined);
});

test("subscribers are notified on fill and withdraw, and the snapshot advances", () => {
  const reg = fresh();
  let n = 0;
  const unsub = reg.subscribe(() => { n += 1; });
  const v0 = reg.snapshot();
  const off = reg.fill("bell", () => {});
  off();
  assert.equal(n, 2);
  assert.ok(reg.snapshot() > v0);
  unsub();
  reg.fill("chat", () => {});
  assert.equal(n, 2);
});

test("a malformed window.HFYBarSlots is replaced with a warning", () => {
  globalThis.window = { HFYBarSlots: {} };
  const calls = quiet(() => { barSlots(); });
  assert.equal(calls.length, 1);
  assert.equal(typeof globalThis.window.HFYBarSlots.fill, "function");
});
