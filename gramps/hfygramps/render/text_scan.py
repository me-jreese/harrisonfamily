"""The live ETL's generic text scanner, ported for the renderer's second text gate (HFY-TSK-114 / R-19 / PS-17).

It answers one question about a free-text string: does it carry a day-precise date, a phone number, an e-mail address or
a street address? It never returns the matched text, only per-class counts.

It is deliberately conservative (false positives are cheap, false negatives are the exposure) and it is stricter than the
R-18 detector in ``hfygramps.scanner`` on one point: any day-precise date blocks, not only one near a birth keyword. The
live ETL's DOB-rendering classes need the local full dates of birth, which the cloud never holds, so they are not ported.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

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
    # 19010203
    re.compile(r"(?<!\d)(?:1[0-9]{3}|20[0-9]{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?!\d)"),
    # March 3, March 3rd 1901, Mar. 3, Mar3 (separator optional)
    re.compile(rf"(?i)\b(?:{_MONTH_ALT})\.?\s*(?:the\s+)?\d{{1,2}}{_ORD}(?!\d)"),
    # 3 March, 3rd of March, 3-Mar-1901, 3Mar1901 (separator optional; a letter after the month ends the match)
    re.compile(rf"(?i)(?<!\d)\d{{1,2}}{_ORD}(?:\s*of)?[\s-]*(?:the\s+)?(?:{_MONTH_ALT})(?![A-Za-z])"),
    # Mar-03
    re.compile(rf"(?i)\b(?:{_MONTH_ALT})\.?-\d{{1,2}}(?!\d)"),
]

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


def _count(patterns: Iterable[re.Pattern[str]], text: str) -> int:
    """Count distinct hits: spans that overlap (two patterns matching one date) count once."""

    spans: List[Tuple[int, int]] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            spans.append((match.start(), match.end()))
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


def scan_text(text: Optional[str]) -> Dict[str, int]:
    """Return a `{class: count}` map (non-zero classes only). Never returns matched text."""

    if not isinstance(text, str) or not text.strip():
        return {}
    hits: Counter = Counter()
    day_hits = _count(_DATE_PATTERNS, text)
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


def blocking_hits(text: Optional[str]) -> Dict[str, int]:
    """The hits that withhold a text from the site."""

    return {k: v for k, v in scan_text(text).items() if k in BLOCKING_CLASSES}
