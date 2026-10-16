// HFY-TSK-198 AC7 (review DL-33): shared/privacy-guard.mjs, as the Worker bundle packages it, against the shared vectors.
// shared/privacy-guard.test.mjs runs the same vectors on the module itself; this runs them on the bundled copy, and through
// the hub, so a packaging change (a copy, a different build target, a lost export) cannot drift from the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, loadBundle, bundledHub } from "./helpers.mjs";
import { scanText as sharedScanText } from "../../shared/privacy-guard.mjs";

const vectors = JSON.parse(readFileSync(join(root, "..", "shared", "privacy-guard.vectors.json"), "utf8"));
const bundleSource = readFileSync(join(root, "dist", "index.js"), "utf8");

/** Strips the ⟦kind/rule|text⟧ markers; offsets are UTF-16 units of the stripped text (as shared/privacy-guard.test.mjs). */
function parseCase(marked) {
  let text = "";
  const open = [];
  const spans = [];
  for (let i = 0; i < marked.length; i++) {
    const ch = marked[i];
    if (ch === "⟦") {
      const bar = marked.indexOf("|", i);
      const [kind] = marked.slice(i + 1, bar).split("/");
      open.push({ kind, start: text.length });
      i = bar;
    } else if (ch === "⟧") {
      const o = open.pop();
      spans.push([o.start, text.length, o.kind]);
    } else text += ch;
  }
  assert.equal(open.length, 0);
  return { text, spans: spans.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])) };
}
const cases = vectors.cases.map((c) => ({ id: c.id, ...parseCase(c.text) }));
const sortSpans = (s) => [...s].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));

test("the vector file is the shared one (130+ cases)", () => {
  assert.ok(cases.length >= 130, `${cases.length} cases`);
});

test("the bundled Worker entry carries the shared module's code, not a copy", () => {
  assert.match(bundleSource, /\/\/ \.\.\/shared\/privacy-guard\.mjs/);
  const body = readFileSync(join(root, "..", "shared", "privacy-guard.mjs"), "utf8");
  // the first exported function of the module appears verbatim in the bundle (esbuild keeps function bodies)
  const probe = body.split("\n").find((l) => l.startsWith("export function scanText"));
  assert.ok(probe && bundleSource.includes(probe.replace(/^export /, "")), "scanText was not bundled as written");
});

test("the bundled contactGuard returns the vectors' spans for every case [start, end, kind]", async () => {
  const { contactGuard } = await loadBundle();
  assert.equal(typeof contactGuard, "function");
  for (const c of cases) {
    const got = sortSpans(contactGuard(c.text));
    // a nested marker is one finding per kind and range in the module; compare as sets of "start:end:kind"
    const want = [...new Set(c.spans.map((s) => s.join(":")))].sort();
    assert.deepEqual([...new Set(got.map((s) => s.join(":")))].sort(), want, `${c.id}: ${c.text.slice(0, 60)}`);
  }
});

test("the bundled guard and the module agree on every vector, including offsets", async () => {
  const { contactGuard } = await loadBundle();
  for (const c of cases) {
    assert.deepEqual(contactGuard(c.text), sharedScanText(c.text).map((h) => [h.start, h.end, h.kind]), c.id);
  }
});

test("through the hub: a send with contact info is refused CONTACT_INFO with spans, a clean one is stored", async () => {
  const rig = await bundledHub();
  try {
    const a = await rig.connect("I9001");
    await rig.connect("I9002");
    const positives = cases.filter((c) => c.spans.some(([, , k]) => ["phone", "email", "street_address", "po_box", "contact_url"].includes(k)) && c.text.length <= 400 && !/[\n\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(c.text)).slice(0, 8);
    assert.ok(positives.length >= 6, "enough clean positive vectors to send");
    let n = 0;
    for (const c of positives) {
      const cmid = `p${++n}`;
      await a.send({ t: "send", conv: "dm:I9001:I9002", cmid, text: c.text });
      const err = a.frames().find((f) => f.t === "err" && f.cmid === cmid);
      const ack = a.frames().find((f) => f.t === "ack" && f.cmid === cmid);
      // the text policy trims and normalizes first, so a vector whose only hit is a bare link may be a media URL instead
      assert.ok(err || ack, `${c.id} got neither err nor ack`);
      if (err && err.code === "CONTACT_INFO") {
        assert.ok(Array.isArray(err.spans) && err.spans.length >= 1, `${c.id}: spans`);
        assert.ok(!JSON.stringify(err).includes(c.text), `${c.id}: the text was echoed`);
      }
    }
    const refused = a.frames().filter((f) => f.t === "err" && f.code === "CONTACT_INFO").length;
    assert.ok(refused >= Math.floor(positives.length / 2), `only ${refused} of ${positives.length} were refused CONTACT_INFO`);
    await a.send({ t: "send", conv: "dm:I9001:I9002", cmid: "clean1", text: "see you at the picnic on the lake" });
    assert.ok(a.frames().some((f) => f.t === "ack" && f.cmid === "clean1"));
  } finally {
    rig.close();
  }
});
