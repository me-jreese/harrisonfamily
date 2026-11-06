// HFY-TSK-388-0F: the review queue's batch, compare and deceased rules (src/lib/review-batch-model.js). Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_COPY as C, LIFE_DATES_FLAG, classOf, deathAdded, deceasedNames, lifeDatesOf, splitQueue, tagOf, thumbOf, yearsLine } from "../src/lib/review-batch-model.js";
import { ID, view } from "./fixtures/proposals.mjs";

const ld = (n, handle, gid, { birth, death, proposer = "I9001" } = {}) => view(n, {
  subject: { cls: "Person", handle, gramps_id: gid }, ops: [], proposer: { id: proposer, label: `Member ${proposer}` },
  intent: { type: "life_dates", target: `Person:${handle}`, ...(birth ? { birth } : {}), ...(death ? { death } : {}), marks_deceased: Boolean(death) },
  summary: [{ text: "years" }],
});
const tag = (n, ref, over = {}) => view(n, { ops: [{ id: "t", op: "add", obj: "Person:hsyn0002", path: "/media_list", value: { ref, rect: [10, 10, 40, 50] } }], summary: [{ text: "tag Tessa Example in this photo" }], ...over });

test("the flag name", () => assert.equal(LIFE_DATES_FLAG, "lifeDatesV1"));

test("classes: years, tag, media, other", () => {
  assert.equal(classOf(ld(1, "h1", "I9002", { birth: { year: 1890, about: true } })), "years");
  assert.equal(classOf(tag(2, "m1")), "tag");
  assert.equal(classOf(view(3, { subject: { cls: "Media", handle: "m9" } })), "media");
  assert.equal(classOf(view(4, { ops: [{ id: "p", op: "add", obj: "Person:h", path: "/media_list", value: { ref: "m2" } }] })), "media");
  assert.equal(classOf(view(5)), "other");
  assert.deepEqual(tagOf(tag(2, "m1")).rect, [10, 10, 40, 50]);
});

test("years line and the death marker", () => {
  const v = ld(1, "h1", "I9002", { birth: { year: 1890, about: true }, death: { year: 1962 } });
  assert.equal(yearsLine(v), "born about 1890 · died 1962");
  assert.equal(deathAdded(v), true);
  assert.equal(deathAdded(ld(2, "h2", "I9003", { birth: { year: 1900 } })), false);
  assert.equal(yearsLine(ld(3, "h3", "I9004", { death: { unknown: true } })), "died year unknown");
  assert.deepEqual(lifeDatesOf(ld(3, "h3", "I9004", { death: { unknown: true } })).death.unknown, true);
  assert.equal(deathAdded(view(6, { ops: [{ id: "e", op: "add", obj: "Event:e1", path: "", value: { type: "Death" } }] })), true);
});

test("batch: uncontested years and tags in, contested out, photos never batched", () => {
  const a = ld(1, "h1", "I9002", { birth: { year: 1890, about: true } });
  const b = ld(2, "h2", "I9003", { death: { year: 1962 } });
  const c = ld(3, "h4", "I9005", { death: { year: 1950 }, proposer: "I9001" });
  const d = ld(4, "h4", "I9005", { death: { year: 1951 }, proposer: "I9006" });
  const same1 = ld(7, "h5", "I9007", { birth: { year: 1900 } });
  const same2 = ld(8, "h5", "I9007", { birth: { year: 1900 }, proposer: "I9006" });
  const t = tag(5, "m1");
  const media = view(6, { subject: { cls: "Media", handle: "m9" } });
  const stale = ld(9, "h6", "I9008", { birth: { year: 1910 } });
  stale.stale = true;
  const out = splitQueue([a, b, c, d, t, media, stale, same1, same2]);
  assert.deepEqual(out.batch.map((v) => v.id), [a, b, t, same1, same2].map((v) => v.id));
  assert.deepEqual(out.contested.map((v) => v.id), [c.id, d.id]);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].field, "death");
  assert.deepEqual(out.deceased.map((v) => v.id), [b.id]);
});

test("two tags for the same person and photo are contested", () => {
  const out = splitQueue([tag(1, "m1"), tag(2, "m1"), tag(3, "m2")]);
  assert.deepEqual(out.batch.map((v) => v.id), [ID(3)]);
  assert.equal(out.contested.length, 2);
});

test("deceased names: one per person, 'someone' when unnamed", () => {
  const b = ld(2, "h2", "I9003", { death: { year: 1962 } });
  const names = new Map([["I9003", "Bea Example"]]);
  assert.deepEqual(deceasedNames([b, b, ld(3, "h3", "I9004", { death: { unknown: true } })], names), ["Bea Example", "someone"]);
});

test("thumbnails: same-origin paths only", () => {
  assert.equal(thumbOf(view(1, { intent: { thumb_url: "/uploads/t.jpg" } })), "/uploads/t.jpg");
  assert.equal(thumbOf(view(1, { intent: { thumb_url: "https://example.com/t.jpg" } })), "");
  assert.equal(thumbOf(view(1, { intent: { thumb_url: "//example.com/t.jpg" } })), "");
});

test("copy: board strings, lower-case, none of the banned words", () => {
  assert.equal(C.approveN(14), "approve 14");
  assert.equal(C.neither, "neither, ask them");
  assert.equal(C.deceasedH, "this will mark them as deceased");
  assert.equal(C.doneN(14), "approved 14. they reach Gramps on the next sync.");
  assert.equal(C.notThisOne, "not this one");
  const all = Object.values(C).flatMap((v) => (typeof v === "function" ? [v(3, 1), v(["a"]), v("a")].map(String) : [v]));
  for (const s of all) {
    assert.doesNotMatch(s, /\b(event|events|life event|role|MediaRef|region)\b/i, s);
    assert.equal(s.replace(/Gramps/g, "gramps"), s.replace(/Gramps/g, "gramps").toLowerCase(), `not lower-case: ${s}`);
  }
});
