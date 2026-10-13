// surf-legacy-form-schema: the auth edge loads the Legacy Form schema from src/shared/ (a symlink here, real files in the zip,
// staged by scripts/ci/package-auth.sh). The full suite is shared/legacy-form.test.mjs; this is the golden mapping at the edge.
import { describe, expect, it } from "vitest";
import { FIELDS, mapToGramps, validateForm } from "../src/shared/legacy-form.mjs";

const form = {
  email: "requester@example.test", givenNames: "Sam Alex", maidenSurname: "Sample", gender: "male", birthPlace: "Springfield, IL",
  birthYear: "1990", currentPlace: "Madison, WI", movedYear: "2015", university: "Example State University", graduationYear: "2012",
  otherDegrees: "MBA", otherDegreeYears: "2016", forSelf: true, company: "",
};
const opts = { year: 2026 };

describe("shared/legacy-form.mjs from the auth edge packaging path (src/shared/)", () => {
  it("exports FIELDS with the required flags", () => {
    expect(FIELDS.filter((f) => f.required).map((f) => f.key)).toContain("birthYear");
    expect(FIELDS.find((f) => f.key === "gender").options).toEqual(["male", "female"]);
  });

  it("validates and reports {field, code} only", () => {
    expect(validateForm(form, opts).ok).toBe(true);
    expect(validateForm({ ...form, gender: "other", birthYear: "1890" }, opts)).toEqual({
      ok: false, fields: [{ field: "gender", code: "invalid" }, { field: "birthYear", code: "year_format" }],
    });
  });

  it("maps the golden form: gender 1, exact first name, primary surname, Birth 12, Residence 42 FROM, Graduation 31, Degree 25", () => {
    const m = mapToGramps(form, opts);
    expect(m.person.gender).toBe(1);
    expect(m.person.primary_name.first_name).toBe("Sam Alex");
    expect(m.person.primary_name.surname_list[0]).toEqual({ _class: "Surname", surname: "Sample", primary: true });
    const byType = Object.fromEntries(m.events.map((e) => [e.type.value, e]));
    expect(byType[12].date.dateval).toEqual([0, 0, 1990, false]);
    expect(byType[42].date.modifier).toBe(7);
    expect(byType[42].date.dateval).toEqual([0, 0, 2015, false]);
    expect(byType[31].description).toBe("Example State University");
    expect(byType[25].date.dateval).toEqual([0, 0, 2016, false]);
    expect(m.person.birth_ref_index).toBe(0);
    expect(JSON.stringify(m)).not.toContain("@");
  });

  it("female is 0, and Residence is dropped when Q2-11(a) is no", () => {
    const m = mapToGramps({ ...form, gender: "female" }, { ...opts, storeCurrentCity: false });
    expect(m.person.gender).toBe(0);
    expect(m.events.some((e) => e.type.value === 42)).toBe(false);
  });
});
