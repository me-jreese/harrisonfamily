// privacy-guard-core AC4: hfy-api loads the R-18 detector from src/shared/ (a symlink here, real files in the zip, staged by
// scripts/ci/package-api.sh) and it runs unchanged. The offset-exact vector suite is shared/privacy-guard.test.mjs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BIRTHDAY_KEYWORDS, rejectContactInfo, scanText } from "../src/shared/privacy-guard.mjs";

const vectors = JSON.parse(readFileSync(new URL("../../shared/privacy-guard.vectors.json", import.meta.url), "utf8"));
const plain = (marked) => marked.replace(/⟦[^|]*\|/g, "").replace(/⟧/g, "");
const markedKinds = (marked) => [...marked.matchAll(/⟦([a-z_]+)\//g)].map((m) => m[1]).sort();

describe("shared/privacy-guard.mjs from the hfy-api packaging path (src/shared/)", () => {
  it("finds every vector's kinds", () => {
    for (const c of vectors.cases) expect(scanText(plain(c.text)).map((h) => h.kind).sort(), c.id).toEqual(markedKinds(c.text));
  });

  it("gives write paths a verdict with kinds and spans only", () => {
    expect(rejectContactInfo("call 555-0123")).toEqual({
      ok: false, code: "contact_info", message: vectors.constants.copy.contact_info, kinds: ["phone"], spans: [{ kind: "phone", start: 5, end: 13 }],
    });
    expect(rejectContactInfo("her birthday is May 5th").code).toBe("dob_not_allowed");
    expect(rejectContactInfo("see you at the reunion")).toEqual({ ok: true });
    expect(BIRTHDAY_KEYWORDS.has("bday")).toBe(true);
  });
});
