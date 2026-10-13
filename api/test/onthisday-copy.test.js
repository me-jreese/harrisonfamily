// The on-this-day copy deck: every template renders, and the DS voice rules hold (HFY-PLN-002 surfaces section 4.2).
import { describe, expect, it } from "vitest";
import {
  HEADINGS, REMEMBERING_LABEL, TEMPLATES, dateLine, headingFor, renderItem, renderItemParts, renderPost, renderPrompt, templateFor, yearWord,
} from "../src/shared/onthisday-copy.mjs";

const A = { grampsId: "ITEST1", name: "Zed Tester", lifeState: "living" };
const B = { grampsId: "ITEST2", name: "Quin Sample", lifeState: "deceased" };
const NAMES = ["Zed Tester", "Quin Sample", "Testville High", "A Test Degree", "Testville", "Test Author"];
const PICTO = /\p{Extended_Pictographic}/u;

/** Every template id mapped to an input that makes it render. */
const CASES = {
  marriage: { kind: "marriage", tone: "celebrate", people: [A, B] },
  graduation: { kind: "graduation", tone: "celebrate", people: [A] },
  graduation_from: { kind: "graduation", tone: "celebrate", people: [A], detail: "Testville High" },
  degree: { kind: "degree", tone: "celebrate", people: [A] },
  degree_detail: { kind: "degree", tone: "celebrate", people: [A], detail: "A Test Degree" },
  education: { kind: "education", tone: "celebrate", people: [A], detail: "Testville High" },
  birth_living: { kind: "birth", tone: "celebrate", people: [A] },
  birth_other: { kind: "birth", tone: "neutral", people: [B] },
  residence: { kind: "residence", tone: "neutral", people: [A], place: "Testville" },
  death_day: { kind: "death", tone: "remember", people: [B], when: "day" },
  death_week: { kind: "death", tone: "remember", people: [B], when: "week" },
  death_year: { kind: "death", tone: "remember", people: [B], when: "year" },
  burial_day: { kind: "burial", tone: "remember", people: [B], when: "day" },
  burial_week: { kind: "burial", tone: "remember", people: [B], when: "week" },
  burial_year: { kind: "burial", tone: "remember", people: [B], when: "year" },
};
const POSTS = {
  post_text_one: { n: 1, author: { id: "ITEST1", label: "Test Author" } },
  post_text_many: { n: 3, author: { id: "ITEST1", label: "Test Author" } },
  post_photo_one: { n: 1, author: { id: "ITEST1", label: "Test Author" }, photo: { url: "x", alt: "y" } },
  post_photo_many: { n: 4, author: { id: "ITEST1", label: "Test Author" }, photo: { url: "x", alt: "y" } },
};
const PROMPTS = { prompt_targeted: { kind: "add_day", people: [A, B] }, prompt_generic: { kind: "generic" } };

const rendered = [];
for (const n of [1, 2, 25, 51]) {
  for (const [id, c] of Object.entries(CASES)) rendered.push([id, n, renderItem({ when: "day", year: 2026 - n, ...c, n })]);
  for (const [id, p] of Object.entries(POSTS)) rendered.push([id, n, renderPost({ ...p, n: id.endsWith("one") ? 1 : Math.max(n, 2) })]);
}
for (const [id, p] of Object.entries(PROMPTS)) rendered.push([id, 0, renderPrompt(p)]);
const lowered = (s) => NAMES.reduce((acc, name) => acc.split(name).join(""), s);

describe("copy deck", () => {
  it("has a case for every template, and every case renders", () => {
    const covered = new Set([...Object.keys(CASES), ...Object.keys(POSTS), ...Object.keys(PROMPTS)]);
    expect([...covered].sort()).toEqual(Object.keys(TEMPLATES).sort());
    for (const [id, , text] of rendered) {
      expect(text, id).toEqual(expect.any(String));
      expect(text.length, id).toBeGreaterThan(0);
      expect(text, id).not.toMatch(/[{}]/);
      expect(text, id).not.toMatch(/undefined|null|NaN/);
    }
  });

  it("voice: lowercase except placeholders, no '!', no 'record', no emoji in a rendered row", () => {
    for (const [id, , text] of rendered) {
      expect(lowered(text), id).toBe(lowered(text).toLowerCase());
      expect(text, id).not.toContain("!");
      expect(text.toLowerCase(), id).not.toContain("record");
      expect(text, id).not.toMatch(PICTO);
    }
    for (const [id, t] of Object.entries(TEMPLATES)) {
      const bare = t.replace(/\{\w+\}/g, "");
      expect(bare, id).toBe(bare.toLowerCase());
      expect(t, id).not.toContain("!");
      expect(t.toLowerCase(), id).not.toContain("record");
    }
    for (const s of [...Object.values(HEADINGS), REMEMBERING_LABEL]) expect(s).toBe(s.toLowerCase());
  });

  it("remember rows never carry an emoji, even when an item asks for one, and celebrate rows may end with one", () => {
    const remember = renderItem({ ...CASES.death_day, n: 60, year: 1966, emoji: "❤️" });
    expect(remember).not.toMatch(PICTO);
    expect(remember).toBe("remembering Quin Sample, who died 60 years ago today.");
    const celebrate = renderItem({ ...CASES.marriage, when: "day", n: 60, year: 1966, emoji: "❤️" });
    expect(celebrate).toBe("Zed Tester and Quin Sample got married 60 years ago today. ❤️");
    expect(celebrate.endsWith("❤️")).toBe(true);
  });

  it("remember copy avoids happy, celebrate and anniversary", () => {
    for (const [id, , text] of rendered.filter(([id]) => /^(death|burial)_/.test(id))) expect(text, id).not.toMatch(/happy|celebrat|anniversary/);
  });

  it("plurals are correct: 1 year, 2 years", () => {
    expect(yearWord(1)).toBe("year");
    expect(yearWord(0)).toBe("years");
    expect(yearWord(2)).toBe("years");
    expect(renderItem({ ...CASES.marriage, when: "day", n: 1, year: 2025 })).toBe("Zed Tester and Quin Sample got married 1 year ago today.");
    expect(renderItem({ ...CASES.marriage, when: "day", n: 2, year: 2024 })).toBe("Zed Tester and Quin Sample got married 2 years ago today.");
    expect(renderItem({ ...CASES.death_year, n: 1, year: 2025 })).toBe("it's been 1 year since we lost Quin Sample.");
    expect(renderItem({ ...CASES.birth_other, n: 1, year: 2025 })).toBe("Quin Sample was born 1 year ago, in 2025.");
    expect(renderPost({ ...POSTS.post_text_one })).toBe("a year ago today, Test Author posted:");
    expect(renderPost({ ...POSTS.post_photo_many })).toBe("4 years ago today, Test Author shared a photo.");
    for (const [, n, text] of rendered) {
      if (n === 1) expect(text).not.toMatch(/\b1 years\b/);
      if (n > 1) expect(text).not.toMatch(/\b\d+ year\b(?! old)/);
    }
  });

  it("the deck's worded cases, with 'when' mapped to today, this week and this year", () => {
    expect(renderItem({ ...CASES.graduation_from, when: "week", n: 20, year: 2006 })).toBe("Zed Tester graduated from Testville High 20 years ago this week.");
    expect(renderItem({ ...CASES.degree, when: "year", n: 10, year: 2016 })).toBe("Zed Tester earned a degree 10 years ago this year.");
    expect(renderItem({ ...CASES.degree_detail, when: "day", n: 10, year: 2016 })).toBe("Zed Tester earned A Test Degree 10 years ago today.");
    expect(renderItem({ ...CASES.education, when: "day", n: 10, year: 2016 })).toBe("10 years ago today: Zed Tester, Testville High.");
    expect(renderItem({ ...CASES.birth_living, n: 30, year: 1996 })).toBe("Zed Tester turns 30 this year.");
    expect(renderItem({ ...CASES.residence, when: "year", n: 15, year: 2011 })).toBe("Zed Tester moved to Testville 15 years ago this year.");
    expect(renderItem({ ...CASES.death_week, n: 5, year: 2021 })).toBe("remembering Quin Sample. 5 years ago this week.");
    expect(renderPrompt(PROMPTS.prompt_targeted)).toBe("know the day Zed Tester and Quin Sample got married? add it to their page.");
    expect(renderPrompt({ kind: "add_day", people: [A] })).toBe(TEMPLATES.prompt_generic);
  });

  it("an item that cannot be worded yields null (no place, no detail, one spouse)", () => {
    expect(templateFor({ kind: "residence", people: [A] })).toBeNull();
    expect(templateFor({ kind: "education", people: [A] })).toBeNull();
    expect(templateFor({ kind: "marriage", people: [A] })).toBeNull();
    expect(templateFor({ kind: "divorce", people: [A, B] })).toBeNull();
    expect(renderItem({ kind: "residence", people: [A], n: 5 })).toBeNull();
    expect(renderItemParts({ ...CASES.marriage, n: 1.5 })).toBeNull();
  });

  it("names come back as linkable parts", () => {
    const parts = renderItemParts({ ...CASES.marriage, when: "day", n: 5, year: 2021 });
    expect(parts.filter((p) => p.name)).toEqual([{ name: "Zed Tester", grampsId: "ITEST1" }, { name: "Quin Sample", grampsId: "ITEST2" }]);
  });

  it("headings and the date line", () => {
    expect(headingFor("day")).toBe("on this day");
    expect(headingFor("week")).toBe("this week in family history");
    expect(headingFor("year")).toBe("this year in family history");
    expect(headingFor("archive")).toBeNull();
    expect(dateLine("2026-10-13")).toBe("oct 13");
    expect(dateLine("2026-01-05")).toBe("jan 5");
    expect(dateLine("nope")).toBe("");
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });
});
