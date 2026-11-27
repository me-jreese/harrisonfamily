// P5-R5 pin tests (HFY-TSK-425, HFY-ISS-031). The life-state rule (shared/life-state.mjs) is DISPLAY ONLY: the published `isLiving` flag
// still means "no death recorded", and every protection that reads it keeps its exact condition and never imports the new rule.
// These tests read the source of each protective code path and pin the key expression with a regexp, not a whole-file hash, so an
// unrelated edit passes and a change to the protection fails with the protection named. CodeArtifact-free: runs in the CI `tests` list.
// If a pin fails because the protection was changed ON PURPOSE, that is a new ruling: raise it on the HFY record, do not edit the pin alone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The rule's own unit tests live beside the other shared tests; importing them here puts them in the CI `tests` list (shared/ is not CI-gated).
import "../../../shared/life-state.test.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const PINS = [
  {
    protection: "graph projection: rule L (isLiving) and the living event dropping",
    file: "graph/src/project.mjs",
    expect: [
      [/export function isLiving\(person\) \{\s*return person\.death_ref_index === -1;\s*\}/, "isLiving(person) must stay `person.death_ref_index === -1`"],
      [/const living = isLiving\(p\);/, "the projection must derive `living` from isLiving(p)"],
      [/if \(person\.out\.living\) \{[\s\S]{0,200}type === 'death' \|\| type === 'burial'[\s\S]{0,200}LIVING_DEATH_EVENT_DROPPED/, "a living person's death or burial event must still be dropped"],
      [/!LIVING_EVENT_KEEP\.has\(type\)/, "a living person must still keep only the LIVING_EVENT_KEEP event types"],
    ],
  },
  {
    protection: "renderer: published isLiving (legacy living rule, SYNC-15 / D2-08)",
    file: "gramps/hfygramps/render/transform.py",
    expect: [
      [/is_living = person\.get\("death_ref_index", -1\) == -1/, "is_living must stay `death_ref_index == -1`"],
      [/"isLiving": is_living,/, "the published payload must carry is_living as isLiving"],
    ],
  },
  {
    protection: "renderer: person stub isLiving in the site index",
    file: "gramps/hfygramps/render/site.py",
    expect: [[/"isLiving": person\.get\("death_ref_index", -1\) == -1,/, "the stub's isLiving must stay `death_ref_index == -1`"]],
  },
  {
    protection: "renderer: search index isLiving passthrough",
    file: "gramps/hfygramps/render/search_index.py",
    expect: [[/"isLiving": person\.get\("isLiving"\),/, "the search index must pass the published isLiving through unchanged"]],
  },
  {
    protection: "edit-bundle living hint (110 years, display-only hint of the editor)",
    file: "api/src/records/edit-bundle.js",
    expect: [
      [/const LIVING_YEARS = 110;/, "LIVING_YEARS must stay 110"],
      [/const isLiving = !hasDeath && \(birth === 0 \|\| birth > nowYear - LIVING_YEARS\);/, "the edit-bundle isLiving hint expression must be unchanged"],
    ],
  },
  {
    protection: "access requests: only a living person can be linked (fail closed)",
    file: "api/src/access-requests.js",
    expect: [[/if \(facts\.isLiving !== true\) throw notLiving;/, "the request must still fail closed unless facts.isLiving === true"]],
  },
  {
    protection: "on this day: a residence place is shown only for a deceased person",
    file: "api/src/onthisday/build.js",
    expect: [[/kind === "residence" && personRef\(persons\.get\(chosen\[0\]\.grampsId\)\)\.lifeState !== "deceased"\) \{ report\.skipped\.living \+= 1; continue; \}/, "the residence skip for a person who is not deceased must be unchanged"]],
  },
];

describe("P5-R5: the life-state rule is display only", () => {
  it("the rule file exists", () => {
    assert.ok(existsSync(join(ROOT, "shared/life-state.mjs")), "shared/life-state.mjs is missing");
  });

  for (const pin of PINS) {
    it(`${pin.protection}: exact condition unchanged`, () => {
      const src = read(pin.file);
      for (const [re, why] of pin.expect) {
        assert.match(src, re, `P5-R5 violated in ${pin.file} (${pin.protection}): ${why}. isLiving and the protections that read it must not change for life state.`);
      }
    });

    it(`${pin.protection}: does not use shared/life-state.mjs`, () => {
      const src = read(pin.file);
      assert.doesNotMatch(src, /life-state|lifeState\(|evidenceActive|LIFE_STATE\b/,
        `P5-R5 violated in ${pin.file} (${pin.protection}): a protective path must not read the display-only life-state rule`);
    });
  }
});
