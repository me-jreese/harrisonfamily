// The one site time format (DS Voice "Time"): just now · 5 min ago · 3 hr ago · yesterday · oct 3 · oct 3, 2024.
// Dates are built in local time, so the assertions hold in any TZ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTime, fullTime, watchTimeTitles } from "../src/lib/time.js";

const NOW = new Date(2026, 9, 12, 15, 30).getTime(); // oct 12, 2026, 3:30 pm local
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60e3, HR = 60 * MIN, DAY = 24 * HR;

test("relative under a day", () => {
  assert.equal(formatTime(ago(0), NOW), "just now");
  assert.equal(formatTime(ago(59e3), NOW), "just now");
  assert.equal(formatTime(ago(-30e3), NOW), "just now", "a little clock skew is still just now");
  assert.equal(formatTime(ago(MIN), NOW), "1 min ago");
  assert.equal(formatTime(ago(5 * MIN + 10e3), NOW), "5 min ago");
  assert.equal(formatTime(ago(59 * MIN), NOW), "59 min ago");
  assert.equal(formatTime(ago(HR), NOW), "1 hr ago");
  assert.equal(formatTime(ago(3 * HR + 20 * MIN), NOW), "3 hr ago");
  assert.equal(formatTime(ago(23 * HR + 59 * MIN), NOW), "23 hr ago");
});

test("yesterday, then days, under 7 days", () => {
  assert.equal(formatTime(ago(DAY), NOW), "yesterday");
  assert.equal(formatTime(ago(47 * HR), NOW), "yesterday");
  assert.equal(formatTime(ago(2 * DAY), NOW), "2 days ago");
  assert.equal(formatTime(ago(6 * DAY + 23 * HR), NOW), "6 days ago");
});

test("mon d in the same year, mon d, yyyy otherwise; lowercase", () => {
  assert.equal(formatTime(new Date(2026, 9, 3, 9, 0).toISOString(), NOW), "oct 3");
  assert.equal(formatTime(new Date(2026, 0, 1, 0, 1).toISOString(), NOW), "jan 1");
  assert.equal(formatTime(new Date(2024, 9, 3, 12, 0).toISOString(), NOW), "oct 3, 2024");
  assert.equal(formatTime(new Date(2025, 11, 31, 23, 0).toISOString(), NOW), "dec 31, 2025");
  assert.equal(formatTime(new Date(2026, 9, 3).getTime(), NOW), "oct 3", "epoch ms works too");
  for (const s of [formatTime(ago(5 * MIN), NOW), formatTime(new Date(2024, 4, 9).toISOString(), NOW)]) assert.equal(s, s.toLowerCase());
});

test("bad input renders nothing instead of 'Invalid Date'", () => {
  assert.equal(formatTime("not a date", NOW), "");
  assert.equal(formatTime(undefined, NOW), "");
  assert.equal(fullTime("nope"), "");
});

test("fullTime: the full local date and time for the title attribute", () => {
  assert.equal(fullTime(new Date(2024, 9, 3, 16, 5).toISOString()), "october 3, 2024, 4:05 pm");
  assert.equal(fullTime(new Date(2026, 0, 1, 0, 7).toISOString()), "january 1, 2026, 12:07 am");
  assert.equal(fullTime(new Date(2026, 5, 9, 12, 0).toISOString()), "june 9, 2026, 12:00 pm");
});

test("watchTimeTitles: sets a full-date title on every time[datetime] (no DOM: a null root is a no-op)", () => {
  const iso = new Date(2024, 9, 3, 16, 5).toISOString();
  const attrs = new Map([["datetime", iso]]);
  const el = { getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v) };
  const root = { querySelectorAll: (sel) => (sel === "time[datetime]" ? [el] : []) };
  const stop = watchTimeTitles(root);
  assert.equal(attrs.get("title"), "october 3, 2024, 4:05 pm");
  assert.equal(typeof stop, "function");
  stop();
  assert.equal(typeof watchTimeTitles(null), "function");
});
