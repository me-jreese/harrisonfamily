// The Durable Object half of the bundle (HFY-TSK-198 ACs 2 and 4): hibernation rules observed on a fake
// DurableObjectState with real SQLite, no timers, and no frame text on the console. Runs the committed dist/index.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundledHub, spyConsole } from "./helpers.mjs";

const DM = "dm:I9001:I9002";

test("the socket is accepted with the user's tag, and the ping auto-response is registered", async () => {
  const rig = await bundledHub();
  try {
    assert.ok(rig.state.autoResponse, "setWebSocketAutoResponse was called");
    assert.equal(rig.state.autoResponse.request, '{"t":"ping"}');
    assert.equal(rig.state.autoResponse.response, '{"t":"pong"}');
    const a = await rig.connect("I9001");
    assert.equal(rig.state.accepted.length, 1);
    assert.deepEqual(rig.state.accepted[0].tags, ["I9001"], "acceptWebSocket(ws, [uid])");
    assert.ok(a.frames().some((f) => f.t === "welcome"), "hello gets welcome");
    assert.ok(rig.state.maxAttachmentBytes > 0 && rig.state.maxAttachmentBytes < 16 * 1024, "state is a serialized attachment under 16 KiB");
  } finally {
    rig.close();
  }
});

test("the object sets no timer: setTimeout and setInterval are never called across connect, send, typing, close and the alarm", async () => {
  const rig = await bundledHub();
  const saved = { st: globalThis.setTimeout, si: globalThis.setInterval };
  const seen = [];
  globalThis.setTimeout = (...a) => { seen.push("setTimeout"); return saved.st(...a); };
  globalThis.setInterval = (...a) => { seen.push("setInterval"); return saved.si(...a); };
  const realNow = Date.now;
  try {
    const a = await rig.connect("I9001");
    const b = await rig.connect("I9002");
    await a.send({ t: "send", conv: DM, cmid: "c1", text: "hello there" });
    await a.send({ t: "typing", conv: DM, state: "on" });
    await b.send({ t: "read", conv: DM, seq: 1 });
    await rig.hub.webSocketClose(b.ws, 1000);
    // time passes: the grace, the push and the archive drain all run from the one storage alarm
    Date.now = () => realNow() + 11 * 60 * 1000;
    await rig.hub.alarm();
    Date.now = () => realNow() + 2 * 3600 * 1000;
    await rig.hub.alarm();
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = saved.st;
    globalThis.setInterval = saved.si;
    rig.close();
  }
  assert.deepEqual(seen, []);
});

test("a ping is the runtime's to answer, and a send is acked and relayed by the hub", async () => {
  const rig = await bundledHub();
  try {
    const a = await rig.connect("I9001");
    const b = await rig.connect("I9002");
    await a.send({ t: "send", conv: DM, cmid: "c1", text: "hi" });
    assert.ok(a.frames().some((f) => f.t === "ack" && f.cmid === "c1"));
    assert.ok(b.frames().some((f) => f.t === "msg" && f.cmid === "c1" && f.text === "hi"));
    assert.ok(rig.api.callsTo("/chat/directory").length >= 1, "the directory came from the API");
    assert.match(rig.api.callsTo("/chat/directory")[0].auth ?? "", /^Bearer /);
  } finally {
    rig.close();
  }
});

test("no frame text, header or service token reaches the console, including on failures", async () => {
  const spy = spyConsole();
  const rig = await bundledHub();
  const realNow = Date.now;
  try {
    const a = await rig.connect("I9001");
    const b = await rig.connect("I9002");
    await a.send({ t: "send", conv: DM, cmid: "c1", text: "ZEBRA-CRACKER-TEXT hello" });
    await a.send({ t: "send", conv: DM, cmid: "c2", text: "call me on 555 010 1234 ZEBRA-PHONE-TEXT" });
    await a.send("{ not json ZEBRA-RAW-FRAME");
    await b.send({ t: "typing", conv: DM, state: "on" });
    await b.send({ t: "send", conv: "dm:I9002:I9099", cmid: "c3", text: "ZEBRA-UNKNOWN-USER" });
    rig.api.modes.push = "fail";
    rig.api.modes.archive = "fail";
    Date.now = () => realNow() + 11 * 60 * 1000;
    await rig.hub.alarm();
    rig.api.modes.directory = "fail";
    Date.now = () => realNow() + 2 * 3600 * 1000;
    await rig.hub.alarm();
    await a.send({ t: "hello", v: 1, sid: "tab-again", vis: true });
    await rig.hub.webSocketError(a.ws);
  } finally {
    Date.now = realNow;
    rig.close();
    spy.restore();
  }
  const out = spy.text();
  for (const needle of ["ZEBRA", "555 010", "hello", "Bearer", "BEGIN PRIVATE", "authorization"]) {
    assert.ok(!out.includes(needle), `console output holds ${needle}`);
  }
  // what is logged is event names and counts: one JSON object per line
  for (const line of spy.lines) assert.doesNotThrow(() => JSON.parse(line), `not a structured line: ${line.slice(0, 60)}`);
});
