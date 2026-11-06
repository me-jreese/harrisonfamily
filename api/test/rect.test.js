// api/src/rect.js against the shared conformance fixtures (tests/tagging/fixtures/tag-conformance.fixtures.json; ruling P4-R16), so the api, the kit and the Gramps side agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_TAG_UNITS, meetsMinSize, normalizeRect, validateNewRect } from "../src/rect.js";

const FX = JSON.parse(readFileSync(new URL("../../tests/tagging/fixtures/tag-conformance.fixtures.json", import.meta.url), "utf8"));
const revive = (v) => (Array.isArray(v) ? v.map(revive) : v && typeof v === "object" && typeof v.$num === "string" ? { NaN, Infinity, "-Infinity": -Infinity }[v.$num] : v);

describe("the shared fixtures", () => {
  it("name the minimum the module uses", () => expect(FX.minTagUnits).toBe(MIN_TAG_UNITS));
  it.each(FX.normalizeRect.rows.map((r) => [r.id, r]))("normalizeRect: %s", (_id, r) => {
    expect(normalizeRect(revive(r.in))).toEqual(r.out); // toEqual compares with Object.is: -0 would fail
    if (r.out !== null && r.ms2 !== undefined) expect(meetsMinSize(r.out, 2)).toBe(r.ms2);
  });
  it.each(FX.authoring.rows.map((r) => [r.id, r]))("validateNewRect: %s", (_id, r) => {
    const got = validateNewRect(revive(r.rect));
    expect(got).toEqual(r.ok ? { ok: true, rect: r.rect_out } : { ok: false, code: r.code });
  });
});

describe("shapes the fixtures do not list", () => {
  it.each([["x"], [[1, 2, 3]], [[1, 2, 3, "4"]], [[1, 2, 3, NaN]], [{}]])("normalizeRect(%j) throws RECT_INVALID", (input) => expect(() => normalizeRect(input)).toThrow(expect.objectContaining({ code: "RECT_INVALID" })));
  it.each([[null], [undefined], ["x"], [[1, 2, 3]], [[1, 2, 3, Infinity]]])("validateNewRect(%j) is RECT_INVALID", (input) => expect(validateNewRect(input)).toEqual({ ok: false, code: "RECT_INVALID" }));
});
