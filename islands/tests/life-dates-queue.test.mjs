// HFY-TSK-388-0E: the pure helpers of the Life dates queue (src/lib/life-dates-queue-model.js). Synthetic people only.
// Run: node --test tests/life-dates-queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, STATS_WINDOW, addPending, createTimingRecorder, debugOn, medianSeconds, addedText, alreadySent, ask, candidatesFrom, cardBody, checkCard, cutoffYear, eligible, knownLine, progressText, readPending, sentText } from "../src/lib/life-dates-queue-model.js";

const NOW = new Date(2026, 5, 1);
const P = (grampsId, displayName, lifespanSummary, extra = {}) => ({ grampsId, displayName, lifespanSummary, ...extra });
const MANIFEST = { people: [
  P("I0001", "Ada Example", "1850 – 1920"), P("I0002", "Bram Example", "b. 1860"), P("I0003", "Cora Example", "b. 1840"), P("I0004", "Dev Example", "b. 1950"),
  P("I0005", "Eli Example", ""), P("I0006", "Fay Example", "d. 1900"), P("I0007", "Gus Example", "b. 1830"), P("I0007", "Gus Again", "b. 1700"), P("bad", "Nobody", ""), P("I0008", "", "")
] };

test("the cutoff is now minus 100 years and rolls", () => {
  assert.equal(cutoffYear(NOW), 1926);
  assert.equal(cutoffYear(new Date(2027, 0, 1)), 1927);
});

test("candidates: born before the cutoff with no death, oldest first, then the no-birth-year row type; living-age and finished people are left out", () => {
  const rows = candidatesFrom(MANIFEST, NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.bornYear]), [["I0007", "death", 1830], ["I0003", "death", 1840], ["I0002", "death", 1860], ["I0005", "birth", null], ["I0006", "birth", null]]);
  assert.deepEqual(candidatesFrom({ people: [P("I0009", "Ines Example", "b. 1926"), P("I0010", "Ivo Example", "b. 1925")] }, NOW).map((r) => r.id), ["I0010"]);
  assert.deepEqual(candidatesFrom({ people: [P("I0011", "Jo Example", "", { birthYear: 1800 })] }, NOW).map((r) => [r.kind, r.bornYear]), [["death", 1800]]);
  assert.deepEqual(candidatesFrom(null, NOW), []);
});

test("eligible: only an empty, unshared date asked about; precise, shared or already-given years skip the person", () => {
  const cls = (c, shared = false) => ({ cls: c, year: c === "none" ? null : 1900, shared });
  const death = { id: "I1", kind: "death", bornYear: 1800 };
  const birth = { id: "I2", kind: "birth", bornYear: null };
  assert.equal(eligible(death, { birth: cls("year"), death: cls("none") }), true);
  assert.equal(eligible(death, { birth: cls("year"), death: cls("precise") }), false);
  assert.equal(eligible(death, { birth: cls("year"), death: cls("none", true) }), false);
  assert.equal(eligible(death, { birth: cls("year"), death: cls("year") }), false);
  assert.equal(eligible(birth, { birth: cls("none"), death: cls("year") }), true);
  assert.equal(eligible(birth, { birth: cls("about"), death: cls("none") }), false);
  assert.equal(eligible(birth, null), false);
});

test("checkCard: range, died before born, 120 years asks", () => {
  const death = { id: "I1", kind: "death", bornYear: 1830 };
  const birth = { id: "I2", kind: "birth", bornYear: null };
  assert.match(checkCard(birth, "19", NOW).error, /4 digits/);
  assert.match(checkCard(birth, "1500", NOW).error, /1600/);
  assert.match(checkCard(birth, "2027", NOW).error, /2026/);
  assert.deepEqual(checkCard(birth, "1890", NOW), { years: null, needsSure: false });
  assert.equal(checkCard(death, "1800", NOW).error, "died can't be before born.");
  assert.deepEqual(checkCard(death, "1900", NOW), { years: 70, needsSure: false });
  assert.deepEqual(checkCard(death, "1960", NOW), { years: 130, needsSure: true });
});

test("cardBody sends only the asked year, or the unknown death, with confirm when asked, never a day or month", () => {
  const death = { id: "I1", kind: "death", bornYear: 1830 };
  const birth = { id: "I2", kind: "birth", bornYear: null };
  assert.deepEqual(cardBody("hA", birth, " 1890 "), { target: "Person:hA", birth: { year: 1890 } });
  assert.deepEqual(cardBody("hB", death, "1900"), { target: "Person:hB", death: { year: 1900 } });
  assert.deepEqual(cardBody("hB", death, "", { unknown: true }), { target: "Person:hB", death: { unknown: true } });
  assert.deepEqual(cardBody("hB", death, "1960", { confirm: true }), { target: "Person:hB", death: { year: 1960 }, confirm: true });
  assert.equal(cardBody("hA", birth, "", { unknown: true }), null); // 'died, year unknown' is never sent for a birth card
});

test("copy is lower-case, plain and free of the archive's words", () => {
  const text = [...Object.values(COPY), ask({ kind: "death", name: "Gus Example" }), ask({ kind: "birth", name: "Eli Example" }), knownLine({ kind: "death", bornYear: 1830 }), knownLine({ kind: "birth" }), progressText(1, 5), addedText(2), sentText("X"), sentText("")].join(" | ");
  assert.doesNotMatch(text, /\b(event|life event|role|mediaref|region)\b/i);
  assert.equal(COPY.save, "save and next");
  assert.equal(COPY.skip, "skip");
  assert.equal(COPY.dontKnow, "i don't know");
  assert.equal(progressText(12, 140), "12 of 140 people in this branch");
  assert.equal(addedText(11), "you've added 11");
  assert.equal(sentText("Henry Bellamy"), "sent for review. next: Henry Bellamy.");
});

test("pending marks only what was saved; nothing else writes", () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const row = { id: "I1", kind: "death" };
  assert.equal(alreadySent(storage, row), false);
  assert.equal(mem.size, 0);
  addPending(storage, "I1", { death: { year: 1900, about: false } });
  assert.deepEqual(readPending(storage, "I1"), { death: { year: 1900, about: false } });
  assert.equal(alreadySent(storage, row), true);
  assert.equal(alreadySent(storage, { id: "I1", kind: "birth" }), false);
  assert.doesNotThrow(() => addPending({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }, "I2", { birth: {} }));
});

// HFY-TSK-400 (O-9): per-card timing, in memory only.
test("medianSeconds: odd, even, empty, unsorted, and junk ignored", () => {
  assert.equal(medianSeconds([]), null);
  assert.equal(medianSeconds(undefined), null);
  assert.equal(medianSeconds([4]), 4);
  assert.equal(medianSeconds([9, 1, 5]), 5);
  assert.equal(medianSeconds([1, 2, 3, 10]), 2.5);
  assert.equal(medianSeconds([3, NaN, "x", -1, Infinity, 7, null]), 5);
  assert.equal(medianSeconds(["a", NaN]), null);
});

test("debugOn: only ?hfy_debug=1", () => {
  assert.equal(debugOn("?hfy_debug=1"), true);
  assert.equal(debugOn("?a=b&hfy_debug=1"), true);
  for (const s of ["", "?hfy_debug=0", "?hfy_debug=true", "?hfy_debug", "?x=1", undefined, null]) assert.equal(debugOn(s), false, String(s));
});

test("recorder: start to stop in seconds, a stop with no card open is null, stats round to a tenth", () => {
  let t = 1000;
  const r = createTimingRecorder({ now: () => t });
  assert.equal(r.stop(), null);
  assert.deepEqual(r.stats(), { cards: 0, medianSeconds: null });
  r.start(); t += 4200;
  assert.equal(r.stop(), 4.2);
  assert.equal(r.stop(), null, "one stop per card");
  r.start(); t += 8000;
  r.stop();
  assert.deepEqual(r.stats(), { cards: 2, medianSeconds: 6.1 });
  r.start(); t += 1000; r.start(); t += 2000; // a card re-shown restarts the timer
  assert.equal(r.stop(), 2);
});

test("recorder keeps the last 50 durations only", () => {
  assert.equal(STATS_WINDOW, 50);
  let t = 0;
  const r = createTimingRecorder({ now: () => t });
  for (let i = 1; i <= 60; i += 1) { r.start(); t += i * 1000; r.stop(); }
  const kept = r.durations();
  assert.equal(kept.length, 50);
  assert.equal(kept[0], 11);
  assert.equal(kept[49], 60);
  assert.deepEqual(r.stats(), { cards: 50, medianSeconds: 35.5 });
});
