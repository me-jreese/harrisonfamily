// HFY-TSK-379 pass 1: every string the hourglass model and layout hand to a renderer, for every person of the invented fixture as the focus, is
// lower case wherever T-Copy says so (names keep their capitals) and contains none of the banned words (T-Copy, DIGEST section 4):
// node, graph, chart, pedigree, collapse, focus, re-centre, living, deceased, unknown, N/A. Rendered text and accessible names are both checked.
// The existing yearsLabel of lib/tree-data.js says "years unknown"; the new tree never uses it, and this test fails if a string ever does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, indexGraph } from "../src/lib/hourglass-model.js";
import { smallLayout } from "../src/lib/hourglass-layout.js";
import { BIG_COPY, bigLayout, bigModel as familyModel } from "../src/lib/hourglass-big.js";
import { TREE_COPY } from "../src/lib/tree-view.js";
import { GRAPH } from "./fixtures/hourglass-cases.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BANNED = /(^|[^a-z])(node|nodes|graph|graphs|chart|charts|pedigree|collapse|collapsed|focus|re-?centre|re-?center|living|deceased|unknown|n\/a)([^a-z]|$)/i;
const idx = indexGraph(GRAPH);

// The keys that hold text a person reads or hears. Everything else (ids, roles, kinds, numbers) is never shown.
const TEXT_KEYS = new Set(["name", "short", "first", "years", "word", "aria", "ariaBig", "text", "label", "caption", "moreText", "namesText", "moreAria", "button", "names", "openBig", "prefer", "outline", "table"]);
// Names (and the bits of them) are the one place capitals are allowed.
const NAME_KEYS = new Set(["name", "short", "first"]);

const nameWords = [...new Set(GRAPH.people.flatMap((p) => [p.name, p.given, p.surname].filter(Boolean).flatMap((n) => n.split(/\s+/))))].sort((a, b) => b.length - a.length);
const nameRe = new RegExp(`(^|[^\\p{L}-])(${nameWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}-])`, "gu");
const withoutNames = (s) => s.replace(nameRe, "$1").replace(nameRe, "$1");

function collect(value, out, key = "") {
  if (typeof value === "string") { if (TEXT_KEYS.has(key)) out.push([key, value]); return; }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const v of value) collect(v, out, key); return; }
  for (const [k, v] of Object.entries(value)) collect(v, out, k);
}

function strings(focus) {
  const m = familyModel(idx, focus);
  const out = [];
  collect(m, out);
  for (const W of [288, 343, 670, 710]) for (const open of [false, true]) collect(smallLayout(m, { width: W, kidsOpen: open, sibsOpen: open }), out);
  for (let lv = 0; lv <= 3; lv += 1) for (const open of [false, true]) collect(bigLayout(m, lv, { sibsOpen: open, ggp: open }), out);
  return out;
}

function check([key, s], label) {
  assert.doesNotMatch(s, BANNED, `${label}: ${key} says a banned word: ${JSON.stringify(s)}`);
  assert.doesNotMatch(s, /\b(null|undefined|NaN)\b/, `${label}: ${key} leaks a value: ${JSON.stringify(s)}`);
  if (NAME_KEYS.has(key)) return;
  // Strip the names, then what is left is the app's own words: lower case.
  const rest = withoutNames(s);
  assert.equal(rest, rest.toLowerCase(), `${label}: ${key} has capitals outside names: ${JSON.stringify(s)}`);
}

test("every string for every person of the fixture is lower case outside names and has no banned word", () => {
  let n = 0;
  for (const p of GRAPH.people) {
    for (const entry of strings(p.id)) { check(entry, p.id); n += 1; }
  }
  assert.ok(n > 5000, `only ${n} strings were checked`);
});

test("the strings include the ones the copy list names, built from the fixture's people", () => {
  const all = new Set(GRAPH.people.flatMap((p) => strings(p.id).map(([, s]) => s)));
  for (const s of [
    "father's side", "mother's side", "parents not known yet.", "father not known yet.", "her parents not known yet.", "his parents not known yet.", "not known yet.",
    "1 brother", "6 brothers and sisters", "+5 more children", "show fewer", "grandchildren: Ivy, Jory and Kit", "grandchildren: Arlo, Briar, Cyril, Dove, Ezra and 4 more",
    "see them in the big tree", "wife", "partner", "stepmother", "father's partner", "mother's partner", "half brother, father's side", "half sister, mother's side",
    "half sibling, mother's side", "great-grandfather", "great-grandmother", "grandchild", "4 more grandchildren. open the big tree", "hide brothers and sisters",
    "great-grandparents", "grandparents", "parents", "children", "grandchildren", "b. 1950", "1920–1990",
    "Delphine Eastlake, grandmother, father's side, on both sides of the family", "Tamsin Alder, this person. open the big tree", "Tamsin Alder, in the middle now", "Rowan Alder, father",
    "Kit Larkspur, grandchild, Orrin's child", "2 more of Olwen's children. put Olwen in the middle", "6 brothers and sisters. show them"
  ]) assert.ok(all.has(s), `no string reads ${JSON.stringify(s)}`);
});

test("the fixed strings of COPY pass the same two checks", () => {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") out.push([key, v]);
    else if (typeof v === "function") out.push([key, v(3, "ada")]);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const [k, v] of [...Object.entries(COPY), ...Object.entries(BIG_COPY)]) walk(v, k);
  assert.ok(out.length >= 8, "the shared strings");
  for (const [key, s] of out) {
    if (key === "thanks") { assert.match(s, /^thank you\. tell us in the comments on this page, or text [A-Z]\.$/); continue; }
    assert.doesNotMatch(s, BANNED, `${key}: ${s}`);
    assert.equal(withoutNames(s), withoutNames(s).toLowerCase(), `${key}: ${s}`);
  }
});

test("the years line never says unknown or living, and gives nothing for a person with no year", () => {
  for (const p of GRAPH.people) {
    const years = familyModel(idx, p.id).focus.years;
    assert.doesNotMatch(years, /unknown|living|deceased|n\/a/i);
    if (p.birthYear === null && p.deathYear === null) assert.equal(years, "");
    if (p.yearApprox && years) assert.match(years, /c\. \d{4}/);
  }
});

test("the banned-word check itself catches each banned word (and not 'graduated' or 'focused-on' lookalikes)", () => {
  for (const w of ["node", "graph", "chart", "pedigree", "collapse", "focus", "re-centre", "living", "deceased", "unknown", "N/A"]) assert.match(`the ${w} here`, BANNED, w);
  assert.doesNotMatch("grandparents and a brother", BANNED);
  assert.doesNotMatch("Wystan Dunmere, son with Alma", BANNED);
});

// The strings used in one place are literals in the source that uses them (the model's ghosts and notes, the renderers' labels), not entries of COPY. The model's reach
// the tests above through the layout and model output; the renderers' do not, so this reads every source file that holds copy and checks each multi-word literal the
// same two ways: no banned word, lower case. Class lists, selectors, media queries and the like are skipped by what they contain; a `${...}` stands for a name.
test("the string literals in the sources that hold copy are lower case and say no banned word", () => {
  const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib");
  const files = ["hourglass-model.js", "hourglass-big.js", "hourglass-layout.js", "hourglass-dom.js", "tree-hourglass.js", "tree-hourglass-big.js"];
  const SKIP = /hfy-|aria-|data-|\bpx\b|\bfr\b|min-width|prefers-|[()[\]<>=#{}|]|\/\w/;
  let n = 0;
  for (const f of files) {
    const src = readFileSync(join(lib, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "n");
      if (!/[a-z]{2,} [a-z]{2,}/i.test(s) || SKIP.test(s) || s === COPY.thanks) continue; // the thank-you names J. by initial: checked by its own pattern above
      n += 1;
      assert.doesNotMatch(s, BANNED, `${f}: ${JSON.stringify(s)} says a banned word`);
      assert.equal(withoutNames(s), withoutNames(s).toLowerCase(), `${f}: ${JSON.stringify(s)} has capitals`);
    }
  }
  assert.ok(n > 40, `only ${n} literals were checked`);
});

// HFY-TSK-379 pass 4: the words of the family page's tree tab, the "centred on" chip and the cards' link (lib/tree-view.js TREE_COPY), exactly as T-Copy has them.
test("the family page's strings (tab, new, centred on, change, the cards' link) are T-Copy's, lower case, and say no banned word", () => {
  assert.deepEqual({ ...TREE_COPY, see: TREE_COPY.see("Clarence") }, { tab: "tree", fresh: "new", centred: "centred on", change: "change", changeAria: "change who the tree is centred on", see: "see Clarence in the tree" });
  assert.equal(TREE_COPY.see(""), "see the tree", "a person with no first name reads as the plain wording, never a double space");
  for (const [k, v] of Object.entries(TREE_COPY)) {
    const s = typeof v === "function" ? v("Ada") : v;
    assert.doesNotMatch(s, BANNED, `${k}: ${s}`);
    assert.equal(withoutNames(s.replace("Ada", "")), withoutNames(s.replace("Ada", "")).toLowerCase(), `${k}: ${s}`);
  }
});
