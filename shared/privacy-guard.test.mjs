// privacy-guard-core: shared/privacy-guard.mjs against shared/privacy-guard.vectors.json, the cases gramps/hfygramps/scanner.py
// also passes (gramps/tests/unit/test_scanner.py). Runs under `node --test shared/` (shared.test.mjs imports it) and alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as guard from "./privacy-guard.mjs";

const {
  BIRTHDAY_KEYWORDS, CONTACT_HOSTS, CONTACT_PATHS, CONTACT_SCHEMES, COPY, DIGITS, DOB_WINDOW, DROP, FOLD, KINDS,
  isContactChannel, matchesDomain, rejectContactInfo, scanText,
} = guard;

const dir = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(dir, "privacy-guard.vectors.json"), "utf8"));
const RULES = new Set(["plus", "grouped", "run", "address", "spelled", "number-street", "rural-route", "box", "scheme", "host",
  "path", "month-day", "day-month", "numeric", "month-year"]);

/** Strips ⟦kind/rule|text⟧ markers (nestable); offsets are UTF-16 units of the stripped text, as scanText reports them. */
export function parseCase(marked) {
  let text = "";
  const open = [];
  const spans = [];
  for (let i = 0; i < marked.length; i++) {
    const ch = marked[i];
    if (ch === "⟦") {
      const bar = marked.indexOf("|", i);
      const [kind, rule] = marked.slice(i + 1, bar).split("/");
      open.push({ kind, rule, start: text.length });
      i = bar;
    } else if (ch === "⟧") {
      const o = open.pop();
      spans.push({ kind: o.kind, start: o.start, end: text.length, rule: o.rule });
    } else text += ch;
  }
  assert.equal(open.length, 0, `unclosed marker in ${marked}`);
  spans.sort((a, b) => a.start - b.start || a.end - b.end || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return { text, spans };
}

const cases = vectors.cases.map((c) => ({ ...c, ...parseCase(c.text) }));

test("the vector file holds at least 130 cases, 30 positive dob vectors and every negative family (AC2)", () => {
  assert.ok(cases.length >= 130, `${cases.length} cases`);
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length, "case ids are unique");
  const dobPositive = cases.filter((c) => c.spans.some((s) => s.kind === "dob_heuristic"));
  assert.ok(dobPositive.length >= 30, `${dobPositive.length} positive dob vectors`);
  for (const family of ["year", "year-range", "page", "gramps-id", "clock", "score", "plain-date"]) {
    const n = cases.filter((c) => c.group === `neg:${family}`).length;
    assert.ok(n >= 2, `neg:${family} has ${n} cases`);
  }
  for (const c of cases.filter((x) => x.group.startsWith("neg:"))) assert.deepEqual(c.spans, [], `${c.id} is a negative with a marker`);
  for (const kind of KINDS) assert.ok(cases.some((c) => c.spans.some((s) => s.kind === kind)), `no positive ${kind} vector`);
  for (const k of ["bday", "b-day", "birthdate", "date of birth", "d.o.b", "dob"]) {
    assert.ok(cases.some((c) => c.spans.some((s) => s.kind === "dob_heuristic") && c.text.toLowerCase().includes(k)), `no dob vector uses ${k}`);
  }
});

test("module constants equal the vector file's, so the Python port is pinned to the same tables", () => {
  const k = vectors.constants;
  assert.deepEqual([...KINDS], k.kinds);
  assert.equal(DOB_WINDOW, k.dob_window);
  assert.deepEqual([...BIRTHDAY_KEYWORDS].sort(), k.birthday_keywords);
  assert.deepEqual([...CONTACT_HOSTS], k.contact_hosts);
  assert.deepEqual(CONTACT_PATHS.map((p) => [...p]), k.contact_paths);
  assert.deepEqual([...CONTACT_SCHEMES], k.contact_schemes);
  assert.deepEqual(FOLD.map((r) => [...r]), k.fold);
  assert.deepEqual(DIGITS.map((r) => [...r]), k.digits);
  assert.deepEqual(DROP.map((r) => [...r]), k.drop);
  assert.deepEqual({ ...COPY }, k.copy);
});

test("the normalization tables never overlap, so the order they apply in cannot matter", () => {
  const ranges = [...FOLD, ...DIGITS, ...DROP].map(([lo, hi]) => [lo, hi]).sort((a, b) => a[0] - b[0]);
  for (const [lo, hi] of ranges) assert.ok(lo <= hi && lo > 0x7f, `${lo.toString(16)}-${hi.toString(16)}`);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1], `overlap at ${ranges[i][0].toString(16)}`);
});

for (const c of cases) {
  test(`vector ${c.id}${c.note ? ` (${c.note})` : ""}`, () => {
    assert.deepEqual(scanText(c.text), c.spans);
    const verdict = rejectContactInfo(c.text);
    if (c.spans.length === 0) return assert.deepEqual(verdict, { ok: true });
    const kinds = KINDS.filter((kind) => c.spans.some((s) => s.kind === kind));
    const code = kinds.every((kind) => kind === "dob_heuristic") ? "dob_not_allowed" : "contact_info";
    assert.deepEqual(verdict, { ok: false, code, message: COPY[code], kinds, spans: c.spans.map(({ kind, start, end }) => ({ kind, start, end })) });
  });
}

test("findings and verdicts carry kinds and spans only, never the matched text, and nothing is logged (AC5)", () => {
  const calls = [];
  const saved = {};
  for (const m of ["log", "info", "warn", "error", "debug", "trace"]) {
    saved[m] = console[m];
    console[m] = (...a) => calls.push([m, a.length]);
  }
  try {
    for (const c of cases) {
      const hits = scanText(c.text);
      const verdict = rejectContactInfo(c.text);
      for (const h of hits) {
        assert.deepEqual(Object.keys(h).sort(), ["end", "kind", "rule", "start"]);
        assert.ok(KINDS.includes(h.kind) && RULES.has(h.rule) && Number.isInteger(h.start) && Number.isInteger(h.end));
      }
      for (const s of verdict.spans || []) assert.deepEqual(Object.keys(s).sort(), ["end", "kind", "start"]);
      const out = JSON.stringify({ hits, verdict });
      for (const s of c.spans) assert.ok(!out.includes(c.text.slice(s.start, s.end)), `${c.id}: matched text in the output`);
    }
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(calls, []);
  const src = readFileSync(join(dir, "privacy-guard.mjs"), "utf8");
  assert.doesNotMatch(src, /\bconsole\s*\./);
});

test("zero dependencies: no import at all and no host API, so it runs in Lambda, the edge, the browser and a Worker (AC4)", () => {
  const src = readFileSync(join(dir, "privacy-guard.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  assert.doesNotMatch(src, /\bimport\b|\brequire\s*\(/);
  assert.doesNotMatch(src, /\b(?:process|Buffer|globalThis|window|document|self|fetch|setTimeout|setInterval|crypto|TextEncoder)\b/);
  assert.doesNotMatch(src, /\(\?<[=!]/, "no lookbehind: the islands bundle targets safari15");
});

test("contact hosts match by registrable-domain suffix, never by substring: ig.com is not Instagram (AC3)", () => {
  assert.equal(matchesDomain("ig.com", "ig.me"), false);
  assert.equal(matchesDomain("ig.com", "instagram.com"), false);
  assert.equal(isContactChannel("ig.com", "/m/example"), false);
  assert.equal(isContactChannel("instagram.com", "/m/example"), true);
  assert.equal(isContactChannel("www.instagram.com", "/direct/t/1"), true);
  assert.equal(isContactChannel("instagram.com", "/example"), false);
  assert.equal(isContactChannel("ig.me", "/m/example"), true);
  assert.equal(isContactChannel("film.me"), false);
  assert.equal(isContactChannel("evil-wa.me"), false);
  assert.equal(isContactChannel("wa.me.example.org"), false);
  assert.equal(isContactChannel("WWW.Messenger.COM."), true);
  assert.equal(isContactChannel("api.whatsapp.com"), true);
  assert.equal(isContactChannel("whatsapp.com"), false);
  assert.deepEqual(scanText("see ig.com/example"), []);
  assert.deepEqual(scanText("see ig.com/m/example"), []);
  assert.deepEqual(scanText("see ig.me/example").map((h) => h.kind), ["contact_url"]);
});

test("rejectContactInfo: dob-only is dob_not_allowed with its copy; anything else is contact_info (AC1, AC6)", () => {
  assert.deepEqual(rejectContactInfo("her birthday is May 5th"), {
    ok: false, code: "dob_not_allowed", message: "we only keep the birth year on the site.", kinds: ["dob_heuristic"],
    spans: [{ kind: "dob_heuristic", start: 16, end: 23 }],
  });
  const mixed = rejectContactInfo("born May 5, call 555-0123");
  assert.equal(mixed.code, "contact_info");
  assert.deepEqual(mixed.kinds, ["phone", "dob_heuristic"]);
  assert.equal(mixed.message, COPY.contact_info);
  assert.deepEqual(rejectContactInfo("see you at the reunion"), { ok: true });
  assert.deepEqual(rejectContactInfo("born May 5, call 555-0123", { kinds: ["phone", "email"] }).kinds, ["phone"]);
  assert.deepEqual(rejectContactInfo("born May 5", { kinds: ["phone"] }), { ok: true }, "a caller can leave the dob kind off");
});

test("BIRTHDAY_KEYWORDS is the exported set on-this-day reuses (AC6)", () => {
  assert.ok(BIRTHDAY_KEYWORDS instanceof Set);
  for (const k of ["birthday", "bday", "b-day", "birthdate", "date of birth", "d.o.b", "dob", "born"]) assert.ok(BIRTHDAY_KEYWORDS.has(k), k);
  for (const k of BIRTHDAY_KEYWORDS) assert.equal(k, k.toLowerCase());
});

test("scanText input handling and the kinds filter", () => {
  assert.deepEqual(scanText(null), []);
  assert.deepEqual(scanText(undefined), []);
  assert.deepEqual(scanText(""), []);
  assert.throws(() => scanText(5550123), TypeError);
  assert.throws(() => scanText({ text: "555-0123" }), TypeError);
  assert.deepEqual(scanText("call 555-0123", { kinds: [] }), []);
  assert.deepEqual(scanText("call 555-0123, ann@example.org", { kinds: ["email"] }).map((h) => h.kind), ["email"]);
});

test("adversarial inputs stay fast (no catastrophic backtracking)", () => {
  const inputs = [
    "a.".repeat(5000) + "@", "a".repeat(20000) + "@x", "1 ".repeat(5000), "1-".repeat(5000) + "x", "May 5 ".repeat(2000) + "born",
    "born ".repeat(3000) + "5/12", "12 Main ".repeat(2000), "(".repeat(5000) + "5", "x@".repeat(5000), "[at] ".repeat(4000),
    "https://" + "a.".repeat(4000), "1.".repeat(5000), " ".repeat(20000) + "x", "01-".repeat(5000) + "01", "a ".repeat(10000),
    "-".repeat(20000), "1".repeat(20000), "May ".repeat(5000), "12 a ".repeat(4000) + "Street",
  ];
  for (const s of inputs) {
    const t0 = Date.now();
    scanText(s);
    assert.ok(Date.now() - t0 < 2000, `${s.slice(0, 12)}… took ${Date.now() - t0} ms`);
  }
});

test("100k-character inputs finish in under 1 s (linear URL, keyword and box scans)", () => {
  const N = 100000;
  const fill = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = [
    "x.org/?" + fill("a=1234567&amp;"), fill("#1234567"), fill("born 5/12 "), fill("d. 5 May born "), fill("😀 born 5 May "),
    fill("\u200b1"), fill("01 23 45 67 89 "), fill("in 1850 Main Street "), fill("RR 2 Box 15 "), "p" + " ".repeat(N) + "x",
    "pmb" + " ".repeat(N) + "x", "01-".repeat(N / 3) + "01",
  ];
  for (const s of inputs) {
    const t0 = Date.now();
    scanText(s);
    assert.ok(Date.now() - t0 < 1000, `${JSON.stringify(s.slice(0, 16))}… took ${Date.now() - t0} ms`);
  }
});
