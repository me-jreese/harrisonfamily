// On this day: the pure builder and selector over invented people (HFY-PLN-002 surfaces section 4). No real names, dates or places.
import { describe, expect, it } from "vitest";
import { buildIndex, TYPE } from "../src/onthisday/build.js";
import { selectOnThisDay } from "../src/onthisday/select.js";
import { renderItem } from "../src/shared/onthisday-copy.mjs";

const person = (n, extra = {}) => ({ grampsId: `ITEST${n}`, displayName: `Test Person ${String.fromCharCode(64 + n)}`, lifeState: "deceased", private: false, ...extra });
const PERSONS = Array.from({ length: 16 }, (_, i) => person(i + 1));
const date = (year, month, day, extra = {}) => ({ year, month, day, modifier: 0, quality: 0, ...extra });
const ev = (handle, typeCode, d, who, extra = {}) => ({
  handle, typeCode, date: d, participants: who.map((w) => (typeof w === "string" ? { grampsId: w, role: "Primary" } : w)), place: "", description: "", private: false, ...extra,
});

describe("buildIndex", () => {
  it("is pure: the same source and options give the same index", () => {
    const source = { version: "v1", events: [ev("h1", TYPE.DEATH, date(1990, 10, 13), ["ITEST1"]), ev("h2", TYPE.DEATH, date(1980, 3, 2), ["ITEST2"])], persons: PERSONS };
    const a = buildIndex(source, { policyVersion: "r19-1" });
    const b = buildIndex({ ...source, events: [...source.events].reverse() }, { policyVersion: "r19-1" });
    expect(a).toEqual(b);
    expect(a.schema).toBe("hfy.onthisday.v1");
    expect(a.policyVersion).toBe("r19-1");
    expect(a.sourceVersion).toBe("v1");
    expect(a.day["10-13"].map((i) => i.id)).toEqual(["evt:h1"]);
    expect(a.month["03"].map((i) => i.id)).toEqual(["evt:h2"]);
    expect(a.year).toHaveLength(2);
  });

  it("drops birth month and day by assertion and counts each dropped birth", () => {
    const source = {
      persons: PERSONS,
      events: [
        ev("b1", TYPE.BIRTH, date(1950, 10, 13), ["ITEST1"]),
        ev("b2", TYPE.BIRTH, date(1960, 4, null), ["ITEST2"]),
        ev("b3", TYPE.BIRTH, date(1970, null, null), ["ITEST3"]),
      ],
    };
    const idx = buildIndex(source);
    expect(idx.report.droppedBirthPrecision).toBe(2);
    expect(idx.year.map((i) => i.id)).toEqual(["birth:ITEST1", "birth:ITEST2", "birth:ITEST3"]);
    for (const it of idx.year) { expect(it).not.toHaveProperty("month"); expect(it).not.toHaveProperty("day"); }
    expect(idx.day).toEqual({});
    expect(idx.month).toEqual({});
    expect(JSON.stringify(idx)).not.toMatch(/"(month|day)":\d/);
  });

  it("counts a dropped birth precision even for a private birth, and still never indexes it", () => {
    const idx = buildIndex({ persons: PERSONS, events: [ev("b1", TYPE.BIRTH, date(1950, 1, 2), ["ITEST1"], { private: true })] });
    expect(idx.report.droppedBirthPrecision).toBe(1);
    expect(idx.year).toEqual([]);
  });

  it("excludes divorce, private events, private people and unknown types", () => {
    const priv = person(9, { private: true });
    const idx = buildIndex({
      persons: [...PERSONS, priv],
      events: [
        ev("d1", 7, date(2000, 5, 5), [{ grampsId: "ITEST1", role: "Groom" }, { grampsId: "ITEST2", role: "Bride" }]),
        ev("p1", TYPE.DEATH, date(1990, 5, 5), ["ITEST3"], { private: true }),
        ev("p2", TYPE.DEATH, date(1990, 5, 5), ["ITEST9"]),
        ev("u1", 99, date(1990, 5, 5), ["ITEST4"]),
        ev("m1", TYPE.MARRIAGE, date(1990, 5, 5), [{ grampsId: "ITEST5", role: "Groom" }, { grampsId: "ITEST9", role: "Bride" }]),
        ev("ok", TYPE.DEATH, date(1990, 5, 5), ["ITEST6"]),
      ],
    });
    expect(idx.year.map((i) => i.id)).toEqual(["evt:ok"]);
  });

  it("joins Bride and Groom marriage participants into one item with two people", () => {
    const idx = buildIndex({
      persons: PERSONS,
      events: [ev("m1", TYPE.MARRIAGE, date(1975, 6, 20), [{ grampsId: "ITEST2", role: "Groom" }, { grampsId: "ITEST1", role: "Bride" }, { grampsId: "ITEST3", role: "Witness" }])],
    });
    const [m] = idx.year;
    expect(m).toMatchObject({ kind: "marriage", tone: "celebrate", month: 6, day: 20 });
    expect(m.people.map((p) => p.grampsId)).toEqual(["ITEST1", "ITEST2"]);
    expect(idx.day["06-20"]).toHaveLength(1);
  });

  it("skips a marriage with one spouse, and imprecise or invalid dates", () => {
    const idx = buildIndex({
      persons: PERSONS,
      events: [
        ev("m1", TYPE.MARRIAGE, date(1975, 6, 20), [{ grampsId: "ITEST1", role: "Bride" }]),
        ev("a1", TYPE.DEATH, date(1980, 1, 1, { modifier: 1 }), ["ITEST2"]),
        ev("a2", TYPE.DEATH, date(1980, 1, 1, { quality: 1 }), ["ITEST3"]),
        ev("a3", TYPE.DEATH, date(null, null, null), ["ITEST4"]),
        ev("f1", TYPE.DEATH, date(1980, 2, 30), ["ITEST5"]),
        ev("ok", TYPE.DEATH, date(1981, 2, 3, { modifier: 7 }), ["ITEST6"]),
      ],
    });
    expect(idx.year.map((i) => i.id)).toEqual(["evt:f1", "evt:ok"]);
  });

  it("sets tone by kind: celebrate, neutral and remember; burial only without a death event", () => {
    const idx = buildIndex({
      persons: [...PERSONS.slice(0, 5), person(6, { lifeState: "living" })],
      events: [
        ev("g", TYPE.GRADUATION, date(2000, 5, 1), ["ITEST1"], { description: "Testville College" }),
        ev("r", TYPE.RESIDENCE, date(2001, 5, 1), ["ITEST2"], { place: "Testville" }),
        ev("d", TYPE.DEATH, date(2002, 5, 1), ["ITEST3"]),
        ev("bu1", TYPE.BURIAL, date(2002, 5, 4), ["ITEST3"]),
        ev("bu2", TYPE.BURIAL, date(2003, 5, 4), ["ITEST4"]),
        ev("bl", TYPE.BIRTH, date(1990, null, null), ["ITEST6"]),
        ev("bd", TYPE.BIRTH, date(1900, null, null), ["ITEST5"]),
      ],
    });
    const tones = Object.fromEntries(idx.year.map((i) => [i.id, i.tone]));
    expect(tones).toEqual({ "evt:g": "celebrate", "evt:r": "neutral", "evt:d": "remember", "evt:bu2": "remember", "birth:ITEST6": "celebrate", "birth:ITEST5": "neutral" });
    expect(idx.year.find((i) => i.id === "evt:g").detail).toBe("Testville College");
  });
});

// A fixture with a spread of items for the selector.
function fixture() {
  const events = [];
  const people = [...PERSONS];
  let h = 0;
  // day tier for 06-15: a death, a marriage, a graduation, another death
  events.push(ev(`e${h += 1}`, TYPE.DEATH, date(2001, 6, 15), ["ITEST1"]));
  events.push(ev(`e${h += 1}`, TYPE.DEATH, date(1991, 6, 15), ["ITEST2"]));
  events.push(ev(`e${h += 1}`, TYPE.MARRIAGE, date(1976, 6, 15), [{ grampsId: "ITEST3", role: "Groom" }, { grampsId: "ITEST4", role: "Bride" }]));
  events.push(ev(`e${h += 1}`, TYPE.GRADUATION, date(2006, 6, 15), ["ITEST5"], { description: "Testville High" }));
  // week tier neighbours of 08-10 (nothing on the day itself)
  events.push(ev(`e${h += 1}`, TYPE.MARRIAGE, date(1980, 8, 8), [{ grampsId: "ITEST6", role: "Groom" }, { grampsId: "ITEST7", role: "Bride" }]));
  // year-tier only items
  for (let i = 0; i < 12; i += 1) {
    events.push(ev(`y${i}`, i % 3 === 0 ? TYPE.DEATH : TYPE.GRADUATION, date(2026 - 10 - 5 * (i % 6), 1 + (i % 4), 1 + i), [`ITEST${8 + (i % 8)}`]));
  }
  events.push(ev("by", TYPE.BIRTH, date(1996, 3, 3), ["ITEST8"]));
  return { events, persons: people };
}
const INDEX = buildIndex(fixture());

describe("selectOnThisDay", () => {
  it("is pure and deterministic for one date, and differs on the adjacent date", () => {
    const a = selectOnThisDay(INDEX, { date: "2026-02-20" });
    const b = selectOnThisDay(INDEX, { date: "2026-02-20" });
    const c = selectOnThisDay(INDEX, { date: "2026-02-21" });
    expect(a).toEqual(b);
    expect(a.tier).toBe("year");
    expect(a.items.map((i) => i.id)).not.toEqual(c.items.map((i) => i.id));
    expect(INDEX.report.droppedBirthPrecision).toBe(1);
  });

  it("uses the day tier first, composing 'today' items with distinct people", () => {
    const r = selectOnThisDay(INDEX, { date: "2026-06-15" });
    expect(r.tier).toBe("day");
    expect(r.items.length).toBeLessThanOrEqual(3);
    expect(r.items.every((i) => i.when === "day" && i.n >= 1)).toBe(true);
    const ids = r.items.flatMap((i) => i.people.map((p) => p.grampsId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls to the week tier (within the last 3 days) when the day is empty", () => {
    const r = selectOnThisDay(INDEX, { date: "2026-08-10" });
    expect(r.tier).toBe("week");
    expect(r.items.map((i) => i.id)).toEqual(["evt:e5"]);
    expect(r.items[0].when).toBe("week");
    expect(selectOnThisDay(INDEX, { date: "2026-08-16" }).tier).not.toBe("week");
  });

  it("measures the week across a year boundary", () => {
    const idx = buildIndex({ persons: PERSONS, events: [ev("ny", TYPE.DEATH, date(2000, 12, 30), ["ITEST1"])] });
    const r = selectOnThisDay(idx, { date: "2026-01-01" });
    expect(r.tier).toBe("week");
    // The last anniversary was 2025-12-30, so 25 years, not 26.
    expect(r.items[0].n).toBe(25);
    expect(renderItem(r.items[0])).toContain("25 years ago this week");
    expect(selectOnThisDay(idx, { date: "2026-01-04" }).tier).not.toBe("week");
  });

  it("never shows a week item whose anniversary is still ahead", () => {
    const idx = buildIndex({ persons: PERSONS, events: [ev("nz", TYPE.DEATH, date(2000, 1, 2), ["ITEST1"])] });
    expect(selectOnThisDay(idx, { date: "2025-12-31" }).tier).not.toBe("week");
    const r = selectOnThisDay(idx, { date: "2026-01-04" });
    expect(r.tier).toBe("week");
    expect(r.items[0].n).toBe(26);
    expect(renderItem(r.items[0])).toBe("remembering Test Person A. 26 years ago this week.");
  });

  it("applies tier precedence day, then week, then year", () => {
    const idx = buildIndex(fixture());
    expect(selectOnThisDay(idx, { date: "2026-06-15" }).tier).toBe("day");
    expect(selectOnThisDay(idx, { date: "2026-06-17" }).tier).toBe("week");
    expect(selectOnThisDay(idx, { date: "2026-11-11" }).tier).toBe("year");
  });

  it("year tier only offers milestone years, ranked 25s first", () => {
    const events = [10, 15, 20, 25, 30, 33, 50].map((n, i) => ev(`k${i}`, TYPE.GRADUATION, date(2026 - n, null, null), [`ITEST${i + 1}`]));
    const idx = buildIndex({ persons: PERSONS, events });
    const r = selectOnThisDay(idx, { date: "2026-11-11" });
    expect(r.tier).toBe("year");
    expect(r.items.every((i) => i.n % 5 === 0 && i.n >= 10)).toBe(true);
    expect(r.items.slice(0, 2).map((i) => i.n).sort((a, b) => a - b)).toEqual([25, 50]);
  });

  it("never shows a birth month or day, never divorce, never hidden items", () => {
    const idx = buildIndex({
      persons: PERSONS,
      events: [
        ev("b", TYPE.BIRTH, date(2006, 6, 15), ["ITEST1"]),
        ev("d", 7, date(1990, 6, 15), [{ grampsId: "ITEST2", role: "Groom" }, { grampsId: "ITEST3", role: "Bride" }]),
        ev("g", TYPE.GRADUATION, date(2000, 6, 15), ["ITEST4"], { description: "Testville High" }),
      ],
    });
    const r = selectOnThisDay(idx, { date: "2026-06-15" });
    expect(r.items.map((i) => i.id)).toEqual(["evt:g"]);
    expect(selectOnThisDay(idx, { date: "2026-06-15", hidden: ["evt:g"] }).items.map((i) => i.id)).not.toContain("evt:g");
    // Even a tampered index cannot make a birth a day or week item.
    const tampered = { ...idx, month: {}, year: [], day: { "06-15": [{ id: "birth:ITEST1", kind: "birth", tone: "celebrate", year: 2006, month: 6, day: 15, people: [{ grampsId: "ITEST1", name: "Test Person A", lifeState: "living" }] }] } };
    expect(selectOnThisDay(tampered, { date: "2026-06-15" }).items).toEqual([]);
  });

  it("shows at most 1 remember row (last) and at most 1 emoji, never on a remember row", () => {
    const events = [
      ev("d1", TYPE.DEATH, date(1950, 6, 15), ["ITEST1"]),
      ev("d2", TYPE.DEATH, date(1960, 6, 15), ["ITEST2"]),
      ev("m1", TYPE.MARRIAGE, date(1960, 6, 15), [{ grampsId: "ITEST3", role: "Groom" }, { grampsId: "ITEST4", role: "Bride" }]),
      ev("m2", TYPE.MARRIAGE, date(1970, 6, 15), [{ grampsId: "ITEST5", role: "Groom" }, { grampsId: "ITEST6", role: "Bride" }]),
      ev("g1", TYPE.GRADUATION, date(1965, 6, 15), ["ITEST7"], { description: "Testville High" }),
    ];
    const idx = buildIndex({ persons: PERSONS, events });
    for (const d of ["2026-06-15"]) {
      const r = selectOnThisDay(idx, { date: d });
      expect(r.items.filter((i) => i.tone === "remember").length).toBeLessThanOrEqual(1);
      expect(r.items.filter((i) => i.emoji).length).toBeLessThanOrEqual(1);
      expect(r.items.filter((i) => i.emoji).length).toBe(1);
      expect(r.items.filter((i) => i.tone === "remember" && i.emoji)).toEqual([]);
      const lastCelebrate = r.items.map((i) => i.tone).lastIndexOf("celebrate");
      const firstRemember = r.items.map((i) => i.tone).indexOf("remember");
      if (firstRemember >= 0) expect(firstRemember).toBeGreaterThan(lastCelebrate);
    }
  });

  it("lists each person once even when several events share them", () => {
    const events = [
      ev("a", TYPE.GRADUATION, date(2000, 6, 15), ["ITEST1"], { description: "Testville High" }),
      ev("b", TYPE.DEGREE, date(2004, 6, 15), ["ITEST1"], { description: "a test degree" }),
      ev("c", TYPE.MARRIAGE, date(2008, 6, 15), [{ grampsId: "ITEST1", role: "Groom" }, { grampsId: "ITEST2", role: "Bride" }]),
      ev("d", TYPE.DEATH, date(2009, 6, 15), ["ITEST2"]),
    ];
    const r = selectOnThisDay(buildIndex({ persons: PERSONS, events }), { date: "2026-06-15" });
    const ids = r.items.flatMap((i) => i.people.map((p) => p.grampsId));
    expect(r.items).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("birth rows: celebrate only for a living person up to 100, otherwise neutral", () => {
    const events = [ev("b1", TYPE.BIRTH, date(1996, null, null), ["ITEST1"]), ev("b2", TYPE.BIRTH, date(1916, null, null), ["ITEST2"])];
    const idx = buildIndex({ persons: [person(1, { lifeState: "living" }), person(2, { lifeState: "living" })], events });
    const r = selectOnThisDay(idx, { date: "2026-11-11" });
    expect(r.tier).toBe("year");
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["birth:ITEST1"].tone).toBe("celebrate");
    expect(byId["birth:ITEST2"].tone).toBe("neutral");
  });

  it("falls back to an archive card, then to a targeted or generic prompt", () => {
    const post = { id: "01POST", n: 1, author: { id: "ITEST1", label: "Test Person A" }, excerpt: "hello" };
    const empty = buildIndex({ persons: PERSONS, events: [] });
    expect(selectOnThisDay(empty, { date: "2026-11-11", posts: [post] })).toMatchObject({ tier: "archive", items: [], posts: [post] });
    expect(selectOnThisDay(empty, { date: "2026-11-11", posts: [post], hidden: ["01POST"] }).posts).toEqual([]);
    expect(selectOnThisDay(empty, { date: "2026-11-11" })).toMatchObject({ tier: "prompt", prompt: { kind: "generic" } });
    const undated = buildIndex({ persons: PERSONS, events: [ev("m", TYPE.MARRIAGE, date(1991, null, null), [{ grampsId: "ITEST1", role: "Groom" }, { grampsId: "ITEST2", role: "Bride" }])] });
    const r = selectOnThisDay(undated, { date: "2026-11-11" });
    expect(r.prompt).toEqual({ kind: "add_day", itemId: "evt:m", people: [{ grampsId: "ITEST2", name: "Test Person B" }, { grampsId: "ITEST1", name: "Test Person A" }] });
  });

  it("never prompts for a birth day, and adds no prompt once two items show", () => {
    const idx = buildIndex({ persons: PERSONS, events: [ev("b", TYPE.BIRTH, date(1996, null, null), ["ITEST1"])] });
    expect(selectOnThisDay(idx, { date: "2026-11-11" }).prompt).toEqual({ kind: "generic" });
    const r = selectOnThisDay(INDEX, { date: "2026-06-15" });
    if (r.items.length >= 2) expect(r.prompt).toBeNull();
  });

  it("rejects a malformed date and renders every selected item", () => {
    expect(() => selectOnThisDay(INDEX, { date: "2026-02-30" })).toThrow(TypeError);
    expect(() => selectOnThisDay(INDEX, { date: "yesterday" })).toThrow(TypeError);
    for (const d of ["2026-06-15", "2026-08-10", "2026-11-11"]) for (const it of selectOnThisDay(INDEX, { date: d }).items) expect(renderItem(it)).toEqual(expect.any(String));
  });
});

describe("hardening", () => {
  const one = (extra, personExtra = {}) => buildIndex({
    persons: [person(1, personExtra), ...PERSONS.slice(1)],
    events: [ev("x1", TYPE.DEATH, date(1990, 5, 5), ["ITEST1"], extra)],
  }).year.length;

  it("fails closed on private: only an explicit false is public", () => {
    expect(one({})).toBe(1);
    for (const v of ["true", "false", 1, 0, null, undefined]) expect(one({ private: v })).toBe(0);
    expect(one({}, { private: "true" })).toBe(0);
    expect(one({}, { private: 1 })).toBe(0);
    expect(one({}, { private: undefined })).toBe(0);
  });

  it("keeps only real calendar month-day pairs", () => {
    const idx = buildIndex({ persons: PERSONS, events: [
      ev("f1", TYPE.DEATH, date(1990, 2, 31), ["ITEST1"]),
      ev("f2", TYPE.DEATH, date(1992, 2, 29), ["ITEST2"]),
      ev("f3", TYPE.DEATH, date(1990, 4, 31), ["ITEST3"]),
    ] });
    const byId = Object.fromEntries(idx.year.map((i) => [i.id, i]));
    expect(byId["evt:f1"]).toMatchObject({ month: 2 });
    expect(byId["evt:f1"]).not.toHaveProperty("day");
    expect(byId["evt:f2"]).toMatchObject({ month: 2, day: 29 });
    expect(byId["evt:f3"]).not.toHaveProperty("day");
    expect(Object.keys(idx.day)).toEqual(["02-29"]);
  });

  it("keeps the earliest birth year for a person with two births, in any handle order", () => {
    for (const hs of [["a", "b"], ["b", "a"]]) {
      const idx = buildIndex({ persons: PERSONS, events: [ev(hs[0], TYPE.BIRTH, date(1950, null, null), ["ITEST1"]), ev(hs[1], TYPE.BIRTH, date(1940, null, null), ["ITEST1"])] });
      expect(idx.year.map((i) => i.year)).toEqual([1940]);
    }
  });

  it("drops a detail with a contact pattern or a full date, keeps a plain one", () => {
    const detail = (d) => buildIndex({ persons: PERSONS, events: [ev("g1", TYPE.GRADUATION, date(2000, 5, 5), ["ITEST1"], { description: d })] }).year[0].detail;
    expect(detail("Testville High")).toBe("Testville High");
    for (const bad of ["call 555-123-4567", "me@example.test", "https://example.test/x", "born 1980-02-03", "on 2/3/1980", "March 3rd", "3 March"]) expect(detail(bad)).toBeUndefined();
  });

  it("keeps a living person's residence out of the index", () => {
    const idx = buildIndex({ persons: [person(1, { lifeState: "living" }), person(2)], events: [
      ev("r1", TYPE.RESIDENCE, date(2000, 5, 5), ["ITEST1"], { place: "Testville" }),
      ev("r2", TYPE.RESIDENCE, date(2000, 5, 5), ["ITEST2"], { place: "Testville" }),
    ] });
    expect(idx.year.map((i) => i.id)).toEqual(["evt:r2"]);
  });

  it("bounds and types free text in the served item", () => {
    const bad = { schema: "hfy.onthisday.v1", sourceVersion: "v", day: { "05-05": [
      { id: "evt:z", kind: "death", tone: "remember", year: 2000, month: 5, day: 5, place: "x".repeat(500), people: [{ grampsId: "ITEST1", name: "N".repeat(500), lifeState: "<b>" }] },
      { id: "evt:y", kind: "death", tone: "remember", year: 2000, month: 5, day: 5, people: [{ grampsId: "ITEST2", name: { a: 1 } }] },
    ] }, month: {}, year: [] };
    const r = selectOnThisDay(bad, { date: "2026-05-05" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].people[0].name.length).toBe(120);
    expect(r.items[0].people[0].lifeState).toBe("unknown");
    expect(r.items[0].place.length).toBe(120);
  });

  it("offers the add-the-day prompt only for year-eligible marriages", () => {
    const m = (h, y, a, b) => ev(h, TYPE.MARRIAGE, date(y, null, null), [{ grampsId: a, role: "Groom" }, { grampsId: b, role: "Bride" }]);
    const young = buildIndex({ persons: PERSONS, events: [m("m1", 2024, "ITEST1", "ITEST2")] });
    expect(selectOnThisDay(young, { date: "2026-11-11" }).prompt).toEqual({ kind: "generic" });
    const ok = buildIndex({ persons: PERSONS, events: [m("m2", 2001, "ITEST1", "ITEST2")] });
    expect(selectOnThisDay(ok, { date: "2026-11-11" }).prompt).toMatchObject({ kind: "add_day", itemId: "evt:m2" });
  });
});
