// HFY-TSK-388-0D: the pure helpers of the Life dates block (src/lib/life-dates-model.js). Synthetic years only.
import test from "node:test";
import assert from "node:assert/strict";
import { COPY, buildBody, errorText, lineText, readLife, readReply, validate, withPending } from "../src/lib/life-dates-model.js";

const NOW = new Date(2026, 5, 1);
const EMPTY = { birth: null, death: null };
const draft = (b = "", d = "", o = {}) => ({ birth: { year: b, about: o.bAbout === true }, death: { year: d, about: o.dAbout === true, unknown: o.unknown === true } });

test("the line reads in plain language", () => {
  assert.equal(lineText({ birth: { year: 1890, about: true }, death: { year: 1962 } }), "born about 1890 · died 1962");
  assert.equal(lineText({ birth: { year: 1925 }, death: null }), "born 1925 · date of death unknown");
  assert.equal(lineText(EMPTY), "birth year not recorded · no death recorded");
  assert.equal(lineText({ birth: { year: 1900 }, death: { year: null, unknown: true } }), "born 1900 · died, year unknown");
});

test("no line or message ever uses the archive's words", () => {
  const all = [...Object.values(COPY), lineText(EMPTY), errorText({ status: 500 }), errorText({ status: 0 })].join(" ");
  assert.doesNotMatch(all, /\bevents?\b|life event|\brole\b|mediaref|\bregion\b/i);
});

test("readLife: a precise date is flagged, a living person shows no death", () => {
  const p = { isLiving: false, lifespan: { birth: { year: 1890, month: 3 }, death: { year: 1962 } } };
  assert.deepEqual(readLife(p).birth, { year: 1890, about: false, precise: true });
  assert.equal(readLife({ isLiving: true, lifespan: { death: { year: 2000 } } }).death, null);
  assert.equal(readLife({ lifespan: { death: {} } }).death.unknown, true);
});

test("validation: 1600 to this year, died not before born, 120 years asks", () => {
  assert.ok(validate(draft("1599"), EMPTY, NOW).errors.birth);
  assert.ok(validate(draft("2027"), EMPTY, NOW).errors.birth);
  assert.ok(validate(draft("18"), EMPTY, NOW).errors.birth);
  assert.deepEqual(validate(draft("1890", "1962"), EMPTY, NOW).errors, {});
  assert.equal(validate(draft("1900", "1899"), EMPTY, NOW).errors.death, COPY.diedBeforeBorn);
  const v = validate(draft("1800", "1925"), EMPTY, NOW);
  assert.equal(v.needsSure, true);
  assert.equal(v.years, 125);
  assert.equal(validate(draft("1800", "1920"), EMPTY, NOW).needsSure, false);
  assert.equal(validate(draft("", "1950"), { birth: { year: 1960 }, death: null }, NOW).errors.death, COPY.diedBeforeBorn);
});

test("the body carries years only, changed rows only, and confirm when asked", () => {
  assert.deepEqual(buildBody("h1", draft("1890", "", { bAbout: true }), EMPTY), { target: "Person:h1", birth: { year: 1890, about: true } });
  assert.deepEqual(buildBody("h1", draft("1890", "1962"), { birth: { year: 1890, about: false }, death: null }, { confirm: true }), { target: "Person:h1", death: { year: 1962 }, confirm: true });
  assert.deepEqual(buildBody("h1", draft("", "", { unknown: true }), EMPTY).death, { unknown: true });
  assert.equal(buildBody("h1", draft("1890"), { birth: { year: 1890 }, death: null }), null);
  assert.equal(buildBody("h1", draft("1900"), { birth: { year: 1890, precise: true }, death: null }), null);
});

test("replies: proposed, precise_on_file, shared_event, unchanged and confirm_needed", () => {
  const body = { birth: { year: 1890, about: true }, death: { year: 1962 } };
  assert.deepEqual(readReply({ confirm_needed: true, reason: "lifespan_over_120", lifespan: 125 }, body), { confirm: true, years: 125 });
  const r = readReply({ rows: { birth: { status: "proposed" }, death: { status: "precise_on_file", current: { year: 1962 } } } }, body);
  assert.deepEqual(r.saved, { birth: { year: 1890, about: true } });
  assert.deepEqual(r.notes, [COPY.precise]);
  assert.deepEqual(readReply({ rows: { birth: { status: "shared_event" } } }, body).notes, [COPY.shared]);
  assert.deepEqual(readReply({ rows: { birth: { status: "unchanged" } } }, body).notes, [COPY.unchanged]);
});

test("a saved row lays over the line for the sender", () => {
  const shown = withPending({ birth: { year: 1890, about: false }, death: null }, { death: { year: 1962, about: false } });
  assert.equal(lineText(shown), "born 1890 · died 1962");
});

test("errors read in plain words", () => {
  assert.equal(errorText({ status: 401 }), COPY.signIn);
  assert.equal(errorText({ status: 409 }), COPY.conflict);
  assert.equal(errorText({ status: 400, code: "death_before_birth" }), COPY.diedBeforeBorn);
});
