"""The renderer's privacy re-check of every output file (sync.md 5.7, BRD2 D2-05, R-18, R-19, HFY-R76).

``render_site`` already withholds what its text gate flags. This is the second, independent gate that runs on the bytes about to
be written, so a rule that regressed in the transforms, or a store value in a field the transforms publish unscanned, still cannot
reach the site: a file that fails is not written (fail closed) and the pass raises ``RenderPrivacyBlock``.

It returns *rule ids only*, never offsets or text. Checks:

* no ``sortValue`` / ``sortval`` key anywhere (the exact Julian day of a full date),
* no ``sourcePath`` key anywhere (a local path),
* no day or month in any ``date.text`` (only the year is published),
* the shape of every identifier field (``handle``, ``grampsId``, ``s3Key``, ``checksum``, ``mime``, ``generatedAt``), so a store value
  placed in one of them is not published unscanned,
* the R-18 detector (``hfygramps.scanner``: phone, e-mail, street address, PO box, contact URL, a date of birth near a birth
  keyword) and the live ETL's generic scanner (``text_scan``: any day-precise date, phone, e-mail, street address) over every string
  value, except hash-like values under other keys.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Set

from . import errors

try:  # the packaged layout puts hfygramps beside this package; the repo layout is put on sys.path by the tests
    from hfygramps import scanner
    from hfygramps.render import text_scan
except ImportError as exc:  # pragma: no cover - a packaging fault, caught by package-render.sh's import check
    raise ImportError("hfygramps is not packaged with the renderer") from exc

#: Values under these keys are identifiers or machine fields, never free text. They are not skipped: each must have its shape, and a
#: value that does not is a violation (``privacy.identifier_shape``), because these fields reach the published JSON and the S3 key names.
_S3_KEY = re.compile(r"^media/[0-9a-f]{19,40}\.[a-z0-9]{2,4}\Z")
_SHAPES = {
    #: A Gramps handle is hex; a letter-led slug (an imported or placeholder handle) is accepted too and is scanned like text.
    "handle": re.compile(r"^(?:[0-9a-f]{16,64}|[A-Za-z][A-Za-z0-9_-]{15,63})\Z"),
    "grampsId": re.compile(r"^[A-Z]{1,3}[0-9]{1,6}\Z"),
    "s3Key": _S3_KEY,
    "checksum": re.compile(r"^[0-9a-f]{64}\Z"),
    "mime": re.compile(r"^[a-z]+/[a-z0-9][a-z0-9.+-]{0,60}\Z"),
    "generatedAt": re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z"),
}
#: Coordinates are decimal strings; they are skipped only while they are one (a phone number in a latitude is still scanned).
_COORDINATE_KEYS = frozenset({"latitude", "longitude"})
_DECIMAL = re.compile(r"^-?\d{1,3}(?:\.\d+)?$")
#: Any other key may hold a handle or hash too; it is skipped only when it has a hex letter (a digits-only run could be a phone number).
_IDENTIFIER = re.compile(r"^[0-9a-f]{16,64}$")
_MONTH_WORD = re.compile(
    r"(?i)\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
    r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b"
)
_NUMERIC_DAY = re.compile(r"(?<!\d)\d{1,2}\s?[-/.]\s?\d{1,2}(?!\d)")
_NUMERIC_MONTH = re.compile(r"(?<!\d)\d{4}\s?[-/.]\s?(?:0?[1-9]|1[0-2])(?!\d)")

_SORT_KEYS = frozenset({"sortvalue", "sortval"})
_CACHE_LIMIT = 50_000


def _date_text_has_day_or_month(text: str) -> bool:
    return bool(_MONTH_WORD.search(text) or _NUMERIC_DAY.search(text) or _NUMERIC_MONTH.search(text) or text_scan.blocking_hits(text))


class PrivacyChecker:
    """Holds a per-instance cache of string verdicts, because names and places repeat across thousands of files."""

    def __init__(self) -> None:
        self._verdicts: Dict[str, frozenset] = {}

    def _scan(self, value: str) -> frozenset:
        cached = self._verdicts.get(value)
        if cached is not None:
            return cached
        rules: Set[str] = set()
        for hit in scanner.scan_text(value):
            rules.add(errors.RULE_DETECTOR_PREFIX + hit["kind"])
        for cls in text_scan.blocking_hits(value):
            rules.add(errors.RULE_TEXT_PREFIX + cls)
        verdict = frozenset(rules)
        if len(self._verdicts) >= _CACHE_LIMIT:
            self._verdicts.clear()
        self._verdicts[value] = verdict
        return verdict

    def check(self, body: bytes) -> List[str]:
        """The sorted rule ids a rendered file violates (empty when it is clean)."""

        try:
            doc = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return [errors.RULE_NOT_JSON]
        rules: Set[str] = set()
        self._walk(doc, None, rules)
        return sorted(rules)

    def _walk(self, value: Any, key: Any, rules: Set[str]) -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                if isinstance(k, str):
                    low = k.lower()
                    if low in _SORT_KEYS:
                        rules.add(errors.RULE_SORT_VALUE)
                    elif k == "sourcePath":
                        rules.add(errors.RULE_SOURCE_PATH)
                    elif k == "date" and isinstance(v, dict) and isinstance(v.get("text"), str) and v["text"]:
                        if _date_text_has_day_or_month(v["text"]):
                            rules.add(errors.RULE_DATE_TEXT)
                self._walk(v, k, rules)
        elif isinstance(value, list):
            for item in value:
                self._walk(item, key, rules)
        elif isinstance(value, str) and value:
            shape = _SHAPES.get(key) if isinstance(key, str) else None
            if shape is not None:
                if not shape.match(value):
                    rules.add(errors.RULE_IDENTIFIER_SHAPE)
                elif key == "handle" and (value.isdigit() or not _IDENTIFIER.match(value)):
                    rules.update(self._scan(value))  # a digits-only run could be a number and a slug could embed one: scan it
                return
            if (_IDENTIFIER.match(value) and not value.isdigit()) or _S3_KEY.match(value):
                return
            if key in _COORDINATE_KEYS and _DECIMAL.match(value):
                return
            rules.update(self._scan(value))
