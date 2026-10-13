"""privacy-guard-core: gramps/hfygramps/scanner.py against shared/privacy-guard.vectors.json, the cases
shared/privacy-guard.mjs also passes (shared/privacy-guard.test.mjs). Standard library only.

Run: python3 -m unittest discover gramps/tests/unit
"""

import ast
import contextlib
import io
import json
import logging
import pathlib
import sys
import time
import unittest

GRAMPS = pathlib.Path(__file__).resolve().parents[2]
REPO = GRAMPS.parent
if str(GRAMPS) not in sys.path:
    sys.path.insert(0, str(GRAMPS))

from hfygramps import scanner  # noqa: E402

VECTORS = json.loads((REPO / "shared" / "privacy-guard.vectors.json").read_text(encoding="utf-8"))
RULES = {"plus", "grouped", "run", "address", "spelled", "number-street", "rural-route", "box", "scheme", "host", "path",
         "month-day", "day-month", "numeric", "month-year"}
OPEN, CLOSE = "⟦", "⟧"


def parse_case(marked):
    """Strips the nestable markers; offsets are code points of the stripped text, as scan_text reports them."""
    text, stack, spans = [], [], []
    i = 0
    while i < len(marked):
        ch = marked[i]
        if ch == OPEN:
            bar = marked.index("|", i)
            kind, rule = marked[i + 1:bar].split("/")
            stack.append((kind, rule, len(text)))
            i = bar
        elif ch == CLOSE:
            kind, rule, start = stack.pop()
            spans.append({"kind": kind, "start": start, "end": len(text), "rule": rule})
        else:
            text.append(ch)
        i += 1
    assert not stack, "unclosed marker in " + marked
    spans.sort(key=lambda s: (s["start"], s["end"], scanner.KINDS.index(s["kind"])))
    return "".join(text), spans


CASES = [dict(c, parsed=parse_case(c["text"])) for c in VECTORS["cases"]]


class VectorFileTest(unittest.TestCase):
    def test_size_and_coverage(self):
        """AC2: at least 130 cases, 30 positive dob vectors and every negative family."""
        self.assertGreaterEqual(len(CASES), 130)
        self.assertEqual(len({c["id"] for c in CASES}), len(CASES))
        dob = [c for c in CASES if any(s["kind"] == "dob_heuristic" for s in c["parsed"][1])]
        self.assertGreaterEqual(len(dob), 30)
        for family in ("year", "year-range", "page", "gramps-id", "clock", "score", "plain-date"):
            self.assertGreaterEqual(sum(1 for c in CASES if c["group"] == "neg:" + family), 2, family)
        for c in CASES:
            if c["group"].startswith("neg:"):
                self.assertEqual(c["parsed"][1], [], c["id"])

    def test_constants_match_the_js_module(self):
        k = VECTORS["constants"]
        self.assertEqual(list(scanner.KINDS), k["kinds"])
        self.assertEqual(scanner.DOB_WINDOW, k["dob_window"])
        self.assertEqual(sorted(scanner.BIRTHDAY_KEYWORDS), k["birthday_keywords"])
        self.assertEqual(list(scanner.CONTACT_HOSTS), k["contact_hosts"])
        self.assertEqual([list(p) for p in scanner.CONTACT_PATHS], k["contact_paths"])
        self.assertEqual(list(scanner.CONTACT_SCHEMES), k["contact_schemes"])
        self.assertEqual([list(r) for r in scanner.FOLD], k["fold"])
        self.assertEqual([list(r) for r in scanner.DIGITS], k["digits"])
        self.assertEqual([list(r) for r in scanner.DROP], k["drop"])

    def test_normalization_tables_never_overlap(self):
        ranges = sorted((r[0], r[1]) for r in scanner.FOLD + scanner.DIGITS + scanner.DROP)
        for lo, hi in ranges:
            self.assertTrue(0x7F < lo <= hi, (hex(lo), hex(hi)))
        for a, b in zip(ranges, ranges[1:]):
            self.assertGreater(b[0], a[1], hex(b[0]))


class VectorCasesTest(unittest.TestCase):
    def test_every_vector(self):
        for c in CASES:
            text, spans = c["parsed"]
            with self.subTest(id=c["id"], note=c.get("note", "")):
                self.assertEqual(scanner.scan_text(text), spans)


class GuaranteesTest(unittest.TestCase):
    def test_kinds_and_spans_only_and_nothing_logged(self):
        """AC5: a finding is {kind, start, end, rule}; the matched text is never returned, printed or logged."""
        records = []

        class Catch(logging.Handler):
            def emit(self, record):
                records.append(record.levelname)

        root = logging.getLogger()
        handler = Catch(level=logging.DEBUG)
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                for c in CASES:
                    text, spans = c["parsed"]
                    hits = scanner.scan_text(text)
                    for h in hits:
                        self.assertEqual(sorted(h), ["end", "kind", "rule", "start"])
                        self.assertIn(h["kind"], scanner.KINDS)
                        self.assertIn(h["rule"], RULES)
                        self.assertIsInstance(h["start"], int)
                        self.assertIsInstance(h["end"], int)
                    dumped = json.dumps(hits)
                    for s in spans:
                        self.assertNotIn(text[s["start"]:s["end"]], dumped, c["id"])
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        self.assertEqual(records, [])
        self.assertEqual(out.getvalue() + err.getvalue(), "")
        src = pathlib.Path(scanner.__file__).read_text(encoding="utf-8")
        self.assertNotIn("print(", src)
        self.assertNotIn("logging", src)

    def test_zero_dependencies(self):
        """AC4: the standard library's re, nothing else."""
        tree = ast.parse(pathlib.Path(scanner.__file__).read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"re"})

    def test_scan_text_is_exported_under_both_names(self):
        self.assertIs(scanner.scanText, scanner.scan_text)

    def test_suffix_match_not_substring(self):
        """AC3: ig.com is not Instagram; film.me is not m.me."""
        self.assertFalse(scanner.matches_domain("ig.com", "ig.me"))
        self.assertFalse(scanner.matches_domain("ig.com", "instagram.com"))
        self.assertFalse(scanner.is_contact_channel("ig.com", "/m/example"))
        self.assertTrue(scanner.is_contact_channel("instagram.com", "/m/example"))
        self.assertFalse(scanner.is_contact_channel("film.me"))
        self.assertFalse(scanner.is_contact_channel("evil-wa.me"))
        self.assertFalse(scanner.is_contact_channel("wa.me.example.org"))
        self.assertTrue(scanner.is_contact_channel("WWW.Messenger.COM."))
        self.assertEqual(scanner.scan_text("see ig.com/m/example"), [])
        self.assertEqual([h["kind"] for h in scanner.scan_text("see ig.me/example")], ["contact_url"])

    def test_input_handling_and_kinds_filter(self):
        self.assertEqual(scanner.scan_text(None), [])
        self.assertEqual(scanner.scan_text(""), [])
        with self.assertRaises(TypeError):
            scanner.scan_text(5550123)
        self.assertEqual(scanner.scan_text("call 555-0123", kinds=[]), [])
        self.assertEqual([h["kind"] for h in scanner.scan_text("call 555-0123, ann@example.org", kinds=["email"])], ["email"])

    def test_adversarial_inputs_stay_fast(self):
        inputs = [
            "a." * 5000 + "@", "a" * 20000 + "@x", "1 " * 5000, "1-" * 5000 + "x", "May 5 " * 2000 + "born",
            "born " * 3000 + "5/12", "12 Main " * 2000, "(" * 5000 + "5", "x@" * 5000, "[at] " * 4000,
            "https://" + "a." * 4000, "1." * 5000, " " * 20000 + "x", "01-" * 5000 + "01", "a " * 10000,
            "-" * 20000, "1" * 20000, "May " * 5000, "12 a " * 4000 + "Street",
        ]
        for s in inputs:
            t0 = time.monotonic()
            scanner.scan_text(s)
            self.assertLess(time.monotonic() - t0, 2.0, s[:12])

    def test_100k_character_inputs_finish_in_under_1s(self):
        """Linear URL, keyword and box scans (the shared/privacy-guard.test.mjs inputs)."""
        n = 100000

        def fill(s):
            return (s * (n // len(s) + 1))[:n]

        inputs = [
            "x.org/?" + fill("a=1234567&amp;"), fill("#1234567"), fill("born 5/12 "), fill("d. 5 May born "),
            fill("😀 born 5 May "), fill("\u200b1"), fill("01 23 45 67 89 "), fill("in 1850 Main Street "), fill("RR 2 Box 15 "),
            "p" + " " * n + "x", "pmb" + " " * n + "x", "01-" * (n // 3) + "01",
        ]
        for s in inputs:
            t0 = time.monotonic()
            scanner.scan_text(s)
            self.assertLess(time.monotonic() - t0, 1.0, ascii(s[:16]))


if __name__ == "__main__":
    unittest.main()
