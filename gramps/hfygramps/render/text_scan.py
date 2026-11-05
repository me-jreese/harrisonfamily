"""The live ETL's generic text scanner, ported for the renderer's second text gate (HFY-TSK-114 / R-19 / PS-17).

It answers one question about a free-text string: does it carry a day-precise date, a phone number, an e-mail address or
a street address? It never returns the matched text, only per-class counts.

It is deliberately conservative (false positives are cheap, false negatives are the exposure) and it is stricter than the
R-18 detector in ``hfygramps.scanner`` on one point: any day-precise date blocks, not only one near a birth keyword. The
live ETL's DOB-rendering classes need the local full dates of birth, which the cloud never holds, so they are not ported.

One exception to "any day-precise date blocks" (HFY-TSK-375): a camera timestamp is not a birth date. A calendar-valid
unseparated YYYYMMDD directly followed by exactly one of ``_``, ``-``, ``T`` or a space and a valid six-digit HHMMSS
(20130519_172413) is not a ``date_day``, unless a birth keyword of the R-18 detector is within its window on either side.
A bare YYYYMMDD, a four-digit time, an impossible date or time and every separated date still block. ``strict=True`` (the
renderer's ``date.text`` check, where any day is a leak) turns the exception off.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .. import scanner

DATE_DAY = "date_day"
PHONE = "phone"
EMAIL = "email"
ADDRESS = "address"

# Classes that withhold a text from the site.
BLOCKING_CLASSES: Tuple[str, ...] = (DATE_DAY, PHONE, EMAIL, ADDRESS)

_MONTH_FULL = [
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
]
_MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]
_MONTH_ALT = "|".join(sorted(set(_MONTH_FULL + _MONTH_ABBR), key=len, reverse=True))
_ORD = r"(?:st|nd|rd|th)?"

_DATE_PATTERNS: List[re.Pattern[str]] = [
    # 1901-02-03, 1901/2/3, 1901.02.03
    re.compile(r"(?<!\d)\d{4}\s?[-/.]\s?\d{1,2}\s?[-/.]\s?\d{1,2}(?!\d)"),
    # 2/3/1901, 02-03-01, 3.2.1901
    re.compile(r"(?<!\d)\d{1,2}\s?[-/.]\s?\d{1,2}\s?[-/.]\s?(?:\d{4}|\d{2})(?!\d)"),
    # March 3, March 3rd 1901, Mar. 3, Mar3 (separator optional)
    re.compile(rf"(?i)\b(?:{_MONTH_ALT})\.?\s*(?:the\s+)?\d{{1,2}}{_ORD}(?!\d)"),
    # 3 March, 3rd of March, 3-Mar-1901, 3Mar1901 (separator optional; a letter after the month ends the match)
    re.compile(rf"(?i)(?<!\d)\d{{1,2}}{_ORD}(?:\s*of)?[\s-]*(?:the\s+)?(?:{_MONTH_ALT})(?![A-Za-z])"),
    # Mar-03
    re.compile(rf"(?i)\b(?:{_MONTH_ALT})\.?-\d{{1,2}}(?!\d)"),
]

# 19010203 (counted by scan_text, which can read a camera timestamp as a time and not a date)
_DATE8 = re.compile(r"(?<!\d)(?:1[0-9]{3}|20[0-9]{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?!\d)")
# the time of a camera timestamp: exactly one separator and exactly six digits
_STAMP_TAIL = re.compile(r"[_\-T ]([0-9]{6})(?!\d)")

_PHONE_PATTERNS: List[re.Pattern[str]] = [
    re.compile(r"(?<![\d.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)"),
    re.compile(r"(?<![\d.-])\d{3}[-.]\d{4}(?![\d-])"),
    re.compile(r"(?<!\w)\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d(?!\d)"),
]

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")

_STREET_SUFFIX_ANY = (
    r"(?i:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|"
    r"terrace|ter|circle|cir|highway|hwy|parkway|pkwy|trail|trl|square|sq)"
)
_STREET_SUFFIX_SAFE = r"(?i:street|avenue|boulevard|highway|parkway|road)"
_ADDRESS_PATTERNS: List[re.Pattern[str]] = [
    # 100 Example Street, 12 N. Sample Ave
    re.compile(
        r"(?<![\w$])\d{1,6}\s+(?:[NSEWnsew]\.?\s+)?(?:[A-Z0-9][A-Za-z0-9'.-]*\s+){1,3}"
        + _STREET_SUFFIX_ANY
        + r"\b"
    ),
    # lowercase typing: 100 example street
    re.compile(r"(?<![\w$])\d{1,6}\s+(?:[A-Za-z0-9'.-]+\s+){1,2}" + _STREET_SUFFIX_SAFE + r"\b"),
    re.compile(r"(?i)\bP\.?\s?O\.?\s+Box\s+\d+"),
]


def _count_spans(spans: List[Tuple[int, int]]) -> int:
    """Count distinct hits: spans that overlap (two patterns matching one date) count once."""

    spans.sort()
    total = 0
    last_end = -1
    for start, end in spans:
        if start >= last_end:
            total += 1
            last_end = end
        else:
            last_end = max(last_end, end)
    return total


def _count(patterns: Iterable[re.Pattern[str]], text: str) -> int:
    return _count_spans([(m.start(), m.end()) for pattern in patterns for m in pattern.finditer(text)])


def _first_ge(sorted_values: Sequence[int], x: int) -> int:
    """Index of the first value >= x in a sorted sequence (bisect_left; the render package imports no more than it needs)."""

    lo, hi = 0, len(sorted_values)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_values[mid] < x:
            lo = mid + 1
        else:
            hi = mid
    return lo


class _BirthWords:
    """The birth keywords of the R-18 detector in one text, found once; ``near`` asks about one span in O(log n)."""

    def __init__(self, text: str) -> None:
        t, frm, _ = scanner._normalize(text)
        self._frm = frm
        words = [(s, e) for s, e, birth in scanner._keywords(t) if birth]
        self._starts = [s for s, _ in words]
        self._ends = [e for _, e in words]

    def near(self, start: int, end: int) -> bool:
        """True when a birth keyword ends within the DOB window before ``start`` or starts within it after ``end``
        (offsets of the raw text; the window is counted in the detector's normalised text)."""

        if self._frm is not None:
            start, end = _first_ge(self._frm, start), _first_ge(self._frm, end)
        i = _first_ge(self._ends, start + 1) - 1
        if i >= 0 and start - self._ends[i] <= scanner.DOB_WINDOW:
            return True
        j = _first_ge(self._starts, end)
        return j < len(self._starts) and self._starts[j] - end <= scanner.DOB_WINDOW


def _date8_spans(text: str, strict: bool) -> List[Tuple[int, int]]:
    """The YYYYMMDD hits, leaving out the dates that are the first half of a camera timestamp."""

    spans: List[Tuple[int, int]] = []
    birth: Optional[_BirthWords] = None
    for m in _DATE8.finditer(text):
        if not strict and scanner._is_date8(m.group(0)):
            tail = _STAMP_TAIL.match(text, m.end())
            if tail is not None and scanner._is_time6(tail.group(1)):
                if birth is None:
                    birth = _BirthWords(text)
                if not birth.near(m.start(), tail.end()):
                    continue
        spans.append((m.start(), m.end()))
    return spans


def scan_text(text: Optional[str], strict: bool = False) -> Dict[str, int]:
    """Return a `{class: count}` map (non-zero classes only). Never returns matched text.

    ``strict`` counts every day-precise date, a camera timestamp included (the renderer's ``date.text`` check)."""

    if not isinstance(text, str) or not text.strip():
        return {}
    hits: Counter = Counter()
    day_hits = _count_spans([(m.start(), m.end()) for pattern in _DATE_PATTERNS for m in pattern.finditer(text)]
                            + _date8_spans(text, strict))
    if day_hits:
        hits[DATE_DAY] = day_hits
    phone_hits = _count(_PHONE_PATTERNS, text)
    if phone_hits:
        hits[PHONE] = phone_hits
    email_hits = len(_EMAIL.findall(text))
    if email_hits:
        hits[EMAIL] = email_hits
    address_hits = _count(_ADDRESS_PATTERNS, text)
    if address_hits:
        hits[ADDRESS] = address_hits
    return dict(hits)


def blocking_hits(text: Optional[str], strict: bool = False) -> Dict[str, int]:
    """The hits that withhold a text from the site."""

    return {k: v for k, v in scan_text(text, strict).items() if k in BLOCKING_CLASSES}
