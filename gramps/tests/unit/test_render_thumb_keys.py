"""Thumbnail object names must never read as a phone number (HFY-TSK-402, follow-up of HFY-TSK-393).

The first key scheme, ``media/thumb/<handle>-<sha8>-<size>.jpg``, put digit runs on both sides of a dash. The renderer's privacy gate scans
every string of media/index.json and media/<handle>.json (the R-18 detector ``hfygramps.scanner`` and the ``text_scan`` phone patterns), read
some keys as a phone number, and withheld the files. The scheme is now ``<handle>-<10 letters>-s<size>.jpg``. This module builds thousands of
synthetic handle/checksum pairs, with the digit-heavy cases on purpose, and asks the REAL detectors and the REAL gate. It also pins the
JavaScript key builder (graph/cloud/thumbs.mjs) to the Python one when node is on the path. Synthetic data only.
Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import os
import random
import re
import shutil
import subprocess
import unittest

import render_lambda_support as sup  # noqa: F401  (puts lambda/hfy-sync-render, gramps/ and the render fixtures on sys.path)
from hfy_render.privacy import PrivacyChecker
from hfygramps import scanner
from hfygramps.render import text_scan, thumbs

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
THUMBS_MJS = os.path.join(REPO, "graph", "cloud", "thumbs.mjs")

PAIRS = 6000
HEX = "0123456789abcdef"
ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789"
NEW_KEY = re.compile(r"^media/thumb/[a-p]{2,128}-[a-p]{10}-s(?:320|800)\.jpg\Z")


def legacy_key(handle, checksum, size):
    return f"media/thumb/{handle}-{checksum[:8]}-{size}.jpg"


def flagged(value):
    """True when either detector the privacy gate applies reads the string as something it withholds."""
    return bool(scanner.scan_text(value)) or bool(text_scan.blocking_hits(value))


def make_pairs(seed=402):
    """(handle, checksum) pairs: random handles of 20-30 chars (hex and lowercase alphanumeric), random checksums, plus the digit-heavy
    cases a phone detector likes: handles ending in digits, checksums that open with ten digits, and both together."""
    rnd = random.Random(seed)
    out = []
    for i in range(PAIRS):
        alphabet = HEX if i % 2 else ALNUM
        handle = "".join(rnd.choice(alphabet) for _ in range(rnd.randint(20, 30)))
        checksum = "".join(rnd.choice(HEX) for _ in range(64))
        if i % 5 == 0:  # digits at the end of the handle
            handle = handle[: -rnd.randint(3, 8)] + "".join(rnd.choice("0123456789") for _ in range(rnd.randint(3, 8)))
        if i % 7 == 0:  # digits at the start of the checksum
            checksum = "".join(rnd.choice("0123456789") for _ in range(10)) + checksum[10:]
        if i % 11 == 0:  # digits at the end of the handle and the start of the checksum
            handle = handle[:-4] + "1234"
            checksum = "5678" + checksum[4:]
        if i % 13 == 0:  # the whole character set the handle shape allows
            handle = "".join(rnd.choice(ALNUM + "ABCXYZ_-") for _ in range(rnd.randint(1, 64)))
        out.append((handle, checksum))
    return out


class KeysNeverReadAsPhoneNumbers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pairs = make_pairs()

    def test_every_key_has_the_letters_only_shape(self):
        for handle, checksum in self.pairs:
            for size in thumbs.SIZES:
                key = thumbs.thumb_key(handle, checksum, size)
                self.assertRegex(key, NEW_KEY)
                # no digit anywhere but the size after the "s", whatever the handle and the checksum hold
                self.assertEqual(re.sub(r"s(?:320|800)\.jpg$", "", key[len(thumbs.THUMB_PREFIX):]).translate({c: "!" for c in range(48, 58)}).count("!"), 0)
                # injective: the handle part decodes back to the handle
                part = key[len(thumbs.THUMB_PREFIX):].split("-")[0]
                self.assertEqual(bytes.fromhex("".join(HEX[ord(c) - 97] for c in part)).decode("utf-8"), handle)

    def test_the_real_detectors_find_nothing_in_any_key(self):
        bad = [(h, c) for h, c in self.pairs for size in thumbs.SIZES if flagged(thumbs.thumb_key(h, c, size))]
        self.assertEqual(bad, [])

    def test_the_real_gate_passes_index_and_media_documents_that_carry_the_thumb_field(self):
        gate = PrivacyChecker()
        for n, (handle, checksum) in enumerate(self.pairs):
            if not re.fullmatch(r"[0-9a-f]{19,40}", handle):
                continue  # the gate's own identifier shape: the handle of a media entry is lowercase hex
            record = {"checksum": checksum, "w": 100 + n % 9000, "h": 100 + (n * 7) % 9000}
            thumb = thumbs.thumb_field(handle, checksum, record)
            entry = {"handle": handle, "s3Key": f"media/{handle}.jpg", "checksum": checksum, "size": n, "missing": False, "thumb": thumb}
            index = json.dumps([entry], indent=2, sort_keys=True).encode("utf-8")
            media = json.dumps(entry, indent=2, sort_keys=True).encode("utf-8")
            self.assertEqual(gate.check(index), [], handle)
            self.assertEqual(gate.check(media), [], handle)

    def test_the_first_scheme_did_trip_the_detectors(self):
        # the property test has teeth: the same pairs under the first scheme are read as phone numbers
        bad = [(h, c) for h, c in self.pairs if flagged(legacy_key(h, c, 320)) or flagged(legacy_key(h, c, 800))]
        self.assertGreater(len(bad), PAIRS // 100)
        for h, c in bad[:50]:
            kinds = {hit["kind"] for k in (legacy_key(h, c, 320), legacy_key(h, c, 800)) for hit in scanner.scan_text(k)}
            kinds |= {name for k in (legacy_key(h, c, 320), legacy_key(h, c, 800)) for name in text_scan.blocking_hits(k)}
            self.assertTrue(kinds & {"phone"}, kinds)

    @unittest.skipUnless(shutil.which("node"), "node is not on the path")
    def test_the_javascript_key_builder_agrees_with_this_one(self):
        pairs = self.pairs[:800]
        script = (
            "import { thumbKey, SIZES } from %s;"
            "const pairs = JSON.parse(process.argv[1]);"
            "console.log(JSON.stringify(pairs.map(([h, c]) => SIZES.map((s) => thumbKey(h, c, s)))));"
        ) % json.dumps("file://" + THUMBS_MJS)
        res = subprocess.run(["node", "--input-type=module", "-e", script, json.dumps(pairs)], capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr[-400:])
        want = [[thumbs.thumb_key(h, c, s) for s in thumbs.SIZES] for h, c in pairs]
        self.assertEqual(json.loads(res.stdout), want)


if __name__ == "__main__":
    unittest.main()
