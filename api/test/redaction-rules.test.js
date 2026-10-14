// redaction-policy-v1: the JavaScript port of the pure predicates (shared/redaction-rules.mjs, reached through the src/shared
// packaging path) answers the golden vectors exactly like the Python original in gramps/hfygramps/rules.py. The vectors are
// gramps/redaction/vectors/*.json; the policy is gramps/redaction/redaction-v1.json. Both ports read the one file.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  attributeRule, birthCitationHandles, buildTree, coordinateIsFine, dateViolations, escapePointerToken, expandBraces, isBirthLike, matchPointers,
  placeCodeIsLocal, placeExclusionRule, pointerGet, rectProblem, reduceDate, reducedSortval, roundCoordinate, sdn, urlParts, urlRules,
} from "../src/shared/redaction-rules.mjs";
import { scanText } from "../src/shared/privacy-guard.mjs";

const redaction = new URL("../../gramps/redaction/", import.meta.url);
const policy = JSON.parse(readFileSync(new URL("redaction-v1.json", redaction), "utf8"));
const vectors = readdirSync(new URL("vectors/", redaction)).filter((f) => f.endsWith(".json")).sort()
  .flatMap((f) => JSON.parse(readFileSync(new URL(`vectors/${f}`, redaction), "utf8")).vectors);

const rulesOf = (id) => policy.rules.find((r) => r.id === id);

describe("shared/redaction-rules.mjs against the golden vectors", () => {
  it("has the vectors to run", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(90);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
  });

  it("isBirthLike accepts exactly the expected events of every vector that lists them", () => {
    let checked = 0;
    for (const v of vectors) {
      if (!v.expected.birth_like) continue;
      const tree = buildTree(v.input);
      const got = v.input.filter((o) => o._class === "Event" && isBirthLike(o, tree, policy)).map((o) => o.handle).sort();
      expect(got, v.id).toEqual(v.expected.birth_like);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("accepts a tree as a list of objects and as a built tree alike", () => {
    const v = vectors.find((x) => x.id === "birth.ref.birth_ref_fallback");
    const ev = v.input.find((o) => o.handle === "ev1");
    expect(isBirthLike(ev, v.input, policy)).toBe(true);
    expect(isBirthLike(ev, buildTree(v.input), policy)).toBe(true);
    expect(isBirthLike(ev, [], policy)).toBe(false);
  });

  it("reduces the date of every birth-like event as the expected projection says", () => {
    let checked = 0;
    for (const v of vectors) {
      const tree = buildTree(v.input);
      for (const o of v.input) {
        if (o._class !== "Event" || !isBirthLike(o, tree, policy)) continue;
        const want = v.expected.projection[o.handle];
        if (!want || (v.context.sticky || []).length) continue;
        // a date that equals a local birth date is reduced by the desktop for other events; a birth-like event always is
        expect(reduceDate(o.date, policy), `${v.id} ${o.handle}`).toEqual(want.date);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  it("reduces citation and birth-name dates the same way", () => {
    let checked = 0;
    for (const v of vectors.filter((x) => x.rules.includes("birth.citation.date") || x.rules.includes("birth.name.date"))) {
      const tree = buildTree(v.input);
      const cites = birthCitationHandles(tree, policy);
      for (const o of v.input) {
        if (o._class === "Citation" && cites.has(o.handle)) {
          expect(reduceDate(o.date, policy), `${v.id} ${o.handle}`).toEqual(v.expected.projection[o.handle].date);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("reduction is idempotent and leaves nothing for the server check", () => {
    for (const v of vectors) {
      for (const o of v.input) {
        if (o._class !== "Event") continue;
        const once = reduceDate(o.date, policy);
        expect(reduceDate(once, policy), `${v.id} ${o.handle}`).toEqual(once);
        expect(dateViolations(once, policy), `${v.id} ${o.handle}`).toEqual([]);
      }
    }
  });

  it("flags a day, a month or non-year text on the input of the date vectors", () => {
    const v = vectors.find((x) => x.id === "birth.date.range");
    expect(dateViolations(v.input[0].date, policy)).toEqual(["/dateval/0", "/dateval/1", "/dateval/4", "/dateval/5"]);
    const t = vectors.find((x) => x.id === "birth.date.text_non_year");
    expect(dateViolations(t.input[0].date, policy)).toEqual(["/dateval/0", "/dateval/1", "/text"]);
    expect(dateViolations({ dateval: [0, 0, 1900, false], text: "1900" }, policy)).toEqual([]);
  });

  it("agrees with the vectors on which places are excluded, which codes stay and how coordinates round", () => {
    let places = 0;
    for (const v of vectors) {
      const excluded = new Map(v.expected.excluded.map((x) => [x.handle, x.rule]));
      for (const o of v.input) {
        if (o._class !== "Place" || o.private) continue;
        places += 1;
        const rule = placeExclusionRule(o, policy);
        expect(rule, `${v.id} ${o.handle}`).toBe(excluded.get(o.handle) && excluded.get(o.handle).startsWith("place.") ? excluded.get(o.handle) : null);
        const want = v.expected.projection[o.handle];
        if (!want) continue;
        expect(want.code, `${v.id} ${o.handle} code`).toBe(placeCodeIsLocal(o, policy) ? "" : o.code);
        // null means "blank it": the vector says "" for a value that is not a plain decimal, and null must not pass for ""
        for (const k of ["lat", "long"]) {
          const got = roundCoordinate(o[k], policy);
          if (got === null) expect(want[k], `${v.id} ${o.handle} ${k} blanked`).toBe("");
          else expect(got, `${v.id} ${o.handle} ${k}`).toBe(want[k]);
          expect(got === null || typeof got === "string", `${v.id} ${o.handle} ${k} type`).toBe(true);
        }
        for (const k of ["lat", "long"]) expect(coordinateIsFine(o[k], policy), `${v.id} ${o.handle} ${k}`).toBe(o[k] !== want[k]);
      }
    }
    expect(places).toBeGreaterThanOrEqual(30);
  });

  it("classifies attributes and rects as the vectors do", () => {
    for (const v of vectors) {
      const walk = (n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === "object") {
          if (n._class === "Attribute") {
            const types = n.type.value;
            const want = [10, 11, 12, 14].includes(types) ? "birth.attribute.age_time" : [6, 3].includes(types) ? "contact.attribute.government_id" : null;
            expect(attributeRule(n, policy), v.id).toBe(want);
          }
          Object.values(n).forEach(walk);
        }
      };
      walk(v.input);
    }
    expect(rectProblem([0, 0, 100, 100], policy)).toBe("full_frame");
    expect(rectProblem([0, 0, 100, 100.0], policy)).toBe("full_frame");
    expect(rectProblem(null, policy)).toBeNull();
    expect(rectProblem([10, 10, 50, 60], policy)).toBeNull();
    for (const bad of [[12.5, 10, 50, 60], [60, 10, 50, 70], [10, 10, 101, 60], [10, 10, 50], "x"]) expect(rectProblem(bad, policy)).toBe("degenerate_or_float");
  });

  it("computes day numbers like Gramps and rounds like the vectors", () => {
    expect(sdn(0, 2000, 1, 1)).toBe(2451545);
    expect(sdn(0, 1900, 1, 1)).toBe(2415021);
    expect(sdn(1, 1900, 1, 1)).toBe(2415033);
    expect(sdn(2, 1900, 1, 1)).toBeNull();
    expect(reducedSortval([0, 0, 0, false], 0, policy)).toBe(0);
    expect(reducedSortval([0, 0, 5660, false], 2, policy)).toBe(0);
    const cases = [["40.123456", "40.12"], ["-111.987654", "-111.99"], ["40.1", "40.1"], ["40.005", "40.01"], ["-0.004", "0.00"], ["12.995", "13.00"],
      ["179.999999", "180.00"], ["", ""], ["+40.126", "40.13"], ["-0.005", "-0.01"], ["40°7'24.4\"N", null], ["1e5", null]];
    for (const [input, out] of cases) expect(roundCoordinate(input, policy), input).toBe(out);
  });

  it("keeps the birth pattern ASCII-only, like Python's re.ASCII", () => {
    const tree = buildTree([]);
    const ev = (s) => ({ _class: "Event", handle: "e", type: { value: 0, string: s } });
    expect(isBirthLike(ev("Birth Registration"), tree, policy)).toBe(true);
    expect(isBirthLike(ev("BAPTISM"), tree, policy)).toBe(true);
    expect(isBirthLike(ev("Bırth"), tree, policy)).toBe(false); // dotless i
    expect(isBirthLike(ev("Kaptism"), tree, policy)).toBe(false); // Kelvin sign
    expect(isBirthLike(ev("Residence"), tree, policy)).toBe(false);
    // the whole non-ASCII path: any non-ASCII letter that folds to an ASCII one under Unicode rules stays out, in both ports
    for (const s of ["ＢＩＲＴＨ", "bırth", "BİRTH", "b\u0430ptism", "christ\u0435n", "naıssance", "Kaptism", "ge\u200bburt"]) {
      expect(isBirthLike(ev(s), tree, policy), s).toBe(false);
    }
    // a substring match over-matches on purpose and fails closed
    for (const s of ["Birthright", "Baptist visit", "Christendom"]) expect(isBirthLike(ev(s), tree, policy), s).toBe(true);
    for (const s of ["Chapter", "Charlotte", "Pilot", "Homestead District", "Farmland"]) {
      expect(placeExclusionRule({ place_type: { value: 0, string: s } }, policy), s).toBe("place.exclude.custom_home_like");
    }
    for (const s of ["Plantation", "Campground", "Courtyard", ""]) expect(placeExclusionRule({ place_type: { value: 0, string: s } }, policy), s).toBeNull();
  });

  it("reads a nested value of the wrong shape as absent and never throws; a date that is not an object is a leak", () => {
    const ev = { _class: "Event", handle: "e1", type: { value: 5 }, citation_list: "c1" };
    for (const refs of [["x"], [null], [5], [[]], "x", 7, { ref: "e1" }]) {
      const person = { _class: "Person", handle: "p1", birth_ref_index: 0, event_ref_list: refs };
      expect(isBirthLike(ev, [person, ev], policy), JSON.stringify(refs)).toBe(false);
      expect([...birthCitationHandles([person, ev], policy)], JSON.stringify(refs)).toEqual([]);
    }
    const fam = { _class: "Family", handle: "f1", event_ref_list: ["x", { ref: "e1", citation_list: "c9" }, { ref: "e1", citation_list: ["c2"] }] };
    const birth = { _class: "Event", handle: "e1", type: { value: 12 }, citation_list: 5 };
    expect([...birthCitationHandles([fam, birth], policy)]).toEqual(["c2"]);
    for (const t of ["Birth", 12, [12], null]) expect(isBirthLike({ handle: "e2", type: t }, [], policy), String(t)).toBe(false);
    expect(isBirthLike({ handle: "e2", type: { value: 0, string: 5 } }, [], policy)).toBe(false);
    for (const bad of [null, undefined, "1900", 1900, [], ["x"]]) {
      const red = reduceDate(bad, policy);
      expect([red.dateval, red.text, red.sortval], String(bad)).toEqual([[0, 0, 0, false], "", 0]);
      expect(dateViolations(red, policy)).toEqual([]);
    }
    expect(dateViolations(null, policy)).toEqual([]);
    expect(dateViolations(undefined, policy)).toEqual([]);
    for (const bad of ["1900", 1900, [], ["x"]]) expect(dateViolations(bad, policy), String(bad)).toEqual([""]);
    expect(dateViolations({ dateval: "x", text: 5 }, policy)).toEqual(["/text"]);
    expect(reduceDate({ dateval: ["a", "b", "c", false], text: 5, calendar: 0 }, policy).sortval).toBe(0);
    expect(reduceDate({ dateval: [1, 2, "1900", false], text: ["x"] }, policy).dateval).toEqual([0, 0, "1900", false]);
    expect(placeExclusionRule({ place_type: "Farm" }, policy)).toBeNull();
    expect(placeExclusionRule(null, policy)).toBeNull();
    expect(placeExclusionRule({ place_type: { value: 0, string: ["Home"] } }, policy)).toBeNull();
    expect(placeCodeIsLocal({ place_type: 4 }, policy)).toBe(true);
    expect(attributeRule({ _class: "Attribute", type: "Age" }, policy)).toBeNull();
    expect(attributeRule(null, policy)).toBeNull();
  });

  it("is driven by the policy file and names its rules", () => {
    expect(rulesOf("birth.date.daymonth").action).toBe("reduce_date");
    expect(policy.birthLike.eventTypes.map((t) => t.value)).toEqual([12, 14, 15, 18, 22, 45]);
  });

  it("urlRules agrees with the vectors on every Url of a Person, Place or Repository", () => {
    let urls = 0;
    for (const v of vectors) {
      for (const o of v.input) {
        if (!["Person", "Place", "Repository"].includes(o._class)) continue;
        (o.urls || []).forEach((u, i) => {
          const want = v.expected.server.violations.filter((x) => x.handle === o.handle && x.pointer === `/urls/${i}` && x.rule.startsWith("contact.url.")).map((x) => x.rule).sort();
          expect(urlRules(u, (t) => scanText(t), policy).sort(), `${v.id} ${o.handle} /urls/${i}`).toEqual(want);
          urls += 1;
        });
      }
    }
    expect(urls).toBeGreaterThanOrEqual(20);
  });

  it("urlParts reads a Url the way a browser does", () => {
    expect(urlParts("  HTTPS:///User@Wa.me./x?y")).toEqual(["https", "wa.me", "/x?y"]);
    expect(urlParts("http:\\\\host.example\\p")).toEqual(["http", "host.example", "/p"]);
    expect(urlParts("host:8080/x")).toEqual(["", "host", "/x"]); // a port, not a scheme
    expect(urlParts("mailto:a@b.example")).toEqual(["mailto", "", "a@b.example"]);
    expect(urlParts("\u00a0\u3000//t.me/x\u2003")).toEqual(["", "t.me", "/x"]); // Python's strip() whitespace
    expect(urlParts(null)).toEqual(["", "", ""]);
    expect(urlRules({ path: "https://notwa.me/x", type: { value: 0 } }, () => [], policy)).toEqual([]); // a suffix match is by label
    expect(urlRules({ path: "https://x.wa.me/x" }, () => [], policy)).toEqual(["contact.url.channel"]);
    expect(urlRules({ path: "https://www.instagram.com/M/abc" }, () => [], policy)).toEqual(["contact.url.channel"]);
    expect(urlRules({ path: "https://www.instagram.com/someone" }, () => [], policy)).toEqual([]);
    expect(urlRules(null, () => [], policy)).toEqual([]);
  });

  it("matchPointers and pointerGet follow rules.py: wildcards, ** and braces, numeric order, own keys only", () => {
    const o = { a: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }, { x: 5 }, { x: 6 }, { x: 7 }, { x: 8 }, { x: 9 }, { x: 10 }, { x: 11 }], b: { attribute_list: [1, 2], c: { attribute_list: [3] } }, "k/~": { v: 1 } };
    expect(matchPointers(o, "/a/*/x").slice(-3)).toEqual(["/a/8/x", "/a/9/x", "/a/10/x"]); // numeric, not lexical
    expect(matchPointers(o, "/**/attribute_list/*")).toEqual(["/b/attribute_list/0", "/b/attribute_list/1", "/b/c/attribute_list/0"]);
    expect(matchPointers(o, "/{b,a}/0")).toEqual(["/a/0"]);
    expect(matchPointers(o, "/")).toEqual([""]);
    expect(matchPointers(o, "/k~1~0")).toEqual([]); // patterns take plain keys; a key with a slash is reached with *
    expect(matchPointers(o, "/*/v")).toEqual(["/k~1~0/v"]);
    expect(matchPointers({ a: 1 }, "/constructor")).toEqual([]);
    expect(matchPointers({ a: [1] }, "/a/1")).toEqual([]);
    expect(pointerGet(o, "/k~1~0/v")).toBe(1);
    expect(pointerGet(o, "/a/10/x")).toBe(11);
    expect(pointerGet(o, "/a/11/x", "none")).toBe("none");
    expect(pointerGet(o, "/constructor")).toBeUndefined();
    expect(pointerGet(o, "")).toBe(o);
    expect(escapePointerToken("a/b~c")).toBe("a~1b~0c");
    expect(expandBraces("/a/{b,c/d}/e")).toEqual(["/a/b/e", "/a/c/d/e"]);
  });
});
