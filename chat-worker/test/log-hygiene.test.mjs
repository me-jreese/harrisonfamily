// HFY-TSK-276 (log-hygiene-suite, review PS-20): the Worker half of the captured-log test. The fixture date of birth, phone number and
// note text are api/test/vectors/log-hygiene-fixtures.json, the file the api suite (api/test/log-hygiene.test.js) and the renderer suite
// read too. They are planted into every frame, header, path and failing upstream the hub can meet, and no console line may hold them.
// Runs the committed dist/index.js on the kit's fake Durable Object state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, bundledHub, spyConsole } from "./helpers.mjs";

const FX = JSON.parse(readFileSync(join(root, "..", "api", "test", "vectors", "log-hygiene-fixtures.json"), "utf8"));
const { dob: DOB, phone: PHONE, note: NOTE, needles: NEEDLES } = FX;
const DM = "dm:I9001:I9002";
const squeeze = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const leaksIn = (text) => NEEDLES.filter((n) => text.toLowerCase().includes(n.toLowerCase()) || (squeeze(n).length >= 8 && squeeze(text).includes(squeeze(n))));

test("the detector finds each needle", () => {
  assert.ok(leaksIn(`born ${DOB}`).length);
  assert.ok(leaksIn("call 415 555 0199").length);
  assert.ok(leaksIn("ZQ7XMARKER").length);
  assert.deepEqual(leaksIn('{"event":"alarm","count":3}'), []);
});

test("no planted value reaches the console: frames, malformed frames, failing push, archive and directory", async () => {
  const spy = spyConsole();
  const rig = await bundledHub();
  const realNow = Date.now;
  try {
    const a = await rig.connect("I9001");
    const b = await rig.connect("I9002");
    await a.send({ t: "send", conv: DM, cmid: "c1", text: `${NOTE} ${PHONE} ${DOB}` });
    await a.send({ t: "send", conv: DM, cmid: "c2", text: NOTE });
    await a.send({ t: "send", conv: DM, cmid: "c3", text: `born ${DOB}` });
    // Not planted: a conversation id that is well-formed but unknown, typed by hand. The kit logs it as an identifier in chat.denied
    // (@io-kit/chat, outside this repository); only the id of the caller's own request, never another member's text. Raised in the report.
    await a.send({ t: "send", conv: "dm:I9001:I9099", cmid: "c4", text: PHONE });
    await a.send({ t: "send", conv: NOTE, cmid: DOB, text: PHONE });
    await a.send({ t: "typing", conv: NOTE, state: DOB });
    await a.send({ t: "hello", v: 1, sid: NOTE, vis: DOB });
    await a.send({ t: NOTE, conv: DM, text: PHONE });
    await a.send(`{ "t": "send", "text": "${NOTE} ${PHONE} ${DOB}`);
    await a.send(`${NOTE} ${PHONE} ${DOB}`);
    await b.send({ t: "read", conv: DM, seq: DOB });
    rig.api.modes.push = "fail";
    rig.api.modes.archive = "fail";
    Date.now = () => realNow() + 11 * 60 * 1000;
    await rig.hub.alarm();
    rig.api.modes.directory = "fail";
    Date.now = () => realNow() + 2 * 3600 * 1000;
    await rig.hub.alarm();
    await a.send({ t: "send", conv: DM, cmid: "c5", text: `${NOTE} ${PHONE}` });
    await rig.hub.webSocketError(a.ws, new Error(`${NOTE} ${PHONE} ${DOB}`));
    await rig.hub.webSocketClose(b.ws, 1011, `${NOTE} ${DOB}`, false);
  } finally {
    Date.now = realNow;
    rig.close();
    spy.restore();
  }
  assert.deepEqual(spy.lines.filter((l) => leaksIn(l).length), [], "console lines hold a planted value");
  for (const line of spy.lines.filter((l) => l.startsWith("{"))) assert.doesNotThrow(() => JSON.parse(line), `not a structured line: ${line.slice(0, 60)}`);
});
