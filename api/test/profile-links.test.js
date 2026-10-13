// surf-links-validator: hfy-api loads the profile-links validator from src/shared/ (a symlink here, real files in the zip) and
// every case of shared/profile-links.cases.json holds there (surfaces.md 6.2; the API's 422 details.fields come from validateLinks).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateLink, validateLinks } from "../src/shared/profile-links.mjs";

const { cases } = JSON.parse(readFileSync(new URL("../../shared/profile-links.cases.json", import.meta.url), "utf8"));

describe("shared/profile-links.mjs from the hfy-api packaging path (src/shared/)", () => {
  it("holds at least 150 table cases", () => expect(cases.length).toBeGreaterThanOrEqual(150));

  it.each(cases.map((c, n) => [n, c.platform, c.input, c.expect]))("case %i: %s %j", (_n, platform, input, expected) => {
    expect(validateLink(platform, input)).toEqual(expected);
  });

  it("validateLinks gives the 422 field list", () => {
    expect(validateLinks({ website: "facebook.com/jane.example", instagram: "@jane.example" })).toEqual({
      ok: false, fields: [{ field: "website", code: "wrong_platform", suggest: "facebook" }],
    });
  });
});
