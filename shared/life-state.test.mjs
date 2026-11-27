import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, LIFE_STATE, evidenceActive, lifeState } from "./life-state.mjs";

const NOW = new Date("2026-06-15T12:00:00Z");
const Y = NOW.getUTCFullYear();
const ls = (o) => lifeState({ now: NOW, ...o });

test("the defaults and the states", () => {
  assert.deepEqual({ ...DEFAULTS }, { thresholdYears: 85, evidenceMonths: 24 });
  assert.deepEqual({ ...LIFE_STATE }, { deceased: "deceased", living: "living", unknown: "unknown" });
});

test("a recorded death is deceased, by flag or by year", () => {
  assert.equal(ls({ hasDeath: true }), "deceased");
  assert.equal(ls({ deathYear: 1990 }), "deceased");
  assert.equal(ls({ deathYear: "1990" }), "deceased");
  assert.equal(ls({ hasDeath: false, birthYear: Y - 10 }), "living");
});

test("a death overrides evidence", () => {
  assert.equal(ls({ hasDeath: true, evidenceAt: "2026-06-01", confirmedLivingAt: "2026-06-01", birthYear: Y - 10 }), "deceased");
  assert.equal(ls({ deathYear: 2001, evidenceAt: NOW }), "deceased");
});

test("age boundary: exactly the threshold is living, one more is unknown", () => {
  assert.equal(ls({ birthYear: Y - 85 }), "living");
  assert.equal(ls({ birthYear: Y - 86 }), "unknown");
  assert.equal(ls({ birthYear: Y }), "living");
  assert.equal(ls({ birthYear: Y - 90, thresholdYears: 90 }), "living");
  assert.equal(ls({ birthYear: Y - 91, thresholdYears: 90 }), "unknown");
});

test("no birth year and no evidence is unknown", () => {
  assert.equal(ls({}), "unknown");
  assert.equal(ls({ birthYear: null }), "unknown");
  assert.equal(ls({ birthYear: 0 }), "unknown");
  assert.equal(ls({ birthYear: "" }), "unknown");
  assert.equal(ls({ birthYear: "abc" }), "unknown");
  assert.equal(lifeState({ now: NOW, hasDeath: false }), "unknown");
});

test("a numeric string birth year works like an integer", () => {
  assert.equal(ls({ birthYear: String(Y - 85) }), "living");
  assert.equal(ls({ birthYear: String(Y - 86) }), "unknown");
  assert.equal(ls({ birthYear: ` ${Y - 20} ` }), "living");
  assert.equal(ls({ birthYear: "19.5" }), "unknown");
});

test("evidence keeps an old or undated person living", () => {
  assert.equal(ls({ birthYear: Y - 120, evidenceAt: "2026-01-01T00:00:00Z" }), "living");
  assert.equal(ls({ evidenceAt: "2025-06-15T12:00:00Z" }), "living");
  assert.equal(ls({ birthYear: Y - 120, confirmedLivingAt: NOW.getTime() }), "living");
  assert.equal(ls({ confirmedLivingAt: new Date("2025-01-01T00:00:00Z") }), "living");
});

test("evidence expires: 24 months is in, 25 months is out", () => {
  assert.equal(ls({ evidenceAt: "2024-06-15T12:00:00Z" }), "living");
  assert.equal(ls({ evidenceAt: "2024-06-15T11:59:59Z" }), "unknown");
  assert.equal(ls({ evidenceAt: "2024-05-15T12:00:00Z" }), "unknown");
  assert.equal(ls({ birthYear: Y - 100, confirmedLivingAt: "2024-05-01" }), "unknown");
  assert.equal(ls({ evidenceAt: "2024-05-15T12:00:00Z", evidenceMonths: 36 }), "living");
});

test("a future evidence date is ignored", () => {
  assert.equal(ls({ evidenceAt: "2026-06-16T12:00:00Z" }), "unknown");
  assert.equal(ls({ birthYear: Y - 120, confirmedLivingAt: "2030-01-01" }), "unknown");
  assert.equal(evidenceActive("2099-01-01", null, NOW, 24), false);
});

test("invalid dates are no evidence, and the other source still counts", () => {
  for (const bad of ["not a date", "", null, undefined, NaN, {}, true, new Date("x")]) {
    assert.equal(evidenceActive(bad, bad, NOW, 24), false, String(bad));
  }
  assert.equal(evidenceActive("junk", "2026-05-01", NOW, 24), true);
  assert.equal(ls({ evidenceAt: "junk" }), "unknown");
});

test("invalid options fall back to the defaults and the call never throws", () => {
  assert.equal(ls({ birthYear: Y - 85, thresholdYears: "x" }), "living");
  assert.equal(ls({ birthYear: Y - 86, thresholdYears: -1 }), "unknown");
  assert.equal(ls({ evidenceAt: "2025-01-01", evidenceMonths: NaN }), "living");
  assert.equal(lifeState(), "unknown");
  assert.equal(lifeState(undefined), "unknown");
  assert.ok(["living", "unknown"].includes(lifeState({ birthYear: Y - 5 })), "now defaults to the clock");
});

test("evidenceActive is pure over its arguments", () => {
  assert.equal(evidenceActive("2026-06-15T12:00:00Z", null, NOW, 0), true);
  assert.equal(evidenceActive(null, null, NOW, 24), false);
  assert.equal(evidenceActive("2026-01-31T00:00:00Z", null, new Date("2026-03-31T00:00:00Z"), 2), true);
});
