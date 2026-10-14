"""What the renderer never publishes (D-02, PS-06, R-19): private objects, sensitive attributes, and text with contact data.

Ported from the live ETL's ``publish_policy`` (HFY-TSK-114) with one deliberate change. The live ETL publishes a note,
a region note or a MediaRef attribute value only from an io-approved per-object allowlist, because nothing upstream of
it checks free text. The renderer sits behind the redaction projection, which already holds free text that trips the
R-18 scanner (BRD2 section 11.1, 5.4), so it publishes what the store view holds and keeps a second gate of its own:
``default_text_gate`` withholds any text that the R-18 detector (``hfygramps.scanner``) or the live ETL's own scanner flags.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable, List, Mapping, Optional

from .. import scanner
from . import text_scan
from .labels import attribute_type

#: Gramps AttributeType codes that are never published: ID 3, SSN 6, AGE 10, FATHER_AGE 11, MOTHER_AGE 12, TIME 14.
SENSITIVE_ATTRIBUTE_CODES = frozenset({3, 6, 10, 11, 12, 14})
_SENSITIVE_ATTRIBUTE_NAMES = frozenset(
    {
        "age", "father_age", "fathers_age", "mother_age", "mothers_age", "time", "ssn", "id",
        "social_security_number", "identification_number",
    }
)

#: A text gate answers "may this free text be published?" (True = yes). It never receives or returns anything else.
TextGate = Callable[[str], bool]


def is_private(obj: Any) -> bool:
    """True when a Gramps object or secondary element carries the private flag."""

    return isinstance(obj, dict) and bool(obj.get("private"))


def public_items(items: Optional[Iterable[Any]]) -> List[Any]:
    """Drop private secondary elements (EventRef, ChildRef, MediaRef, attributes, ...)."""

    return [item for item in (items or []) if not is_private(item)]


def _normalise_attribute_name(value: str) -> str:
    cleaned = value.strip().lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", "_", cleaned).strip("_")


def is_sensitive_attribute(attribute: Mapping[str, Any]) -> bool:
    """AGE, FATHER_AGE, MOTHER_AGE, TIME, SSN and ID, by code or by a custom type's name."""

    labelled = attribute_type(attribute.get("type"))
    code = labelled.get("code")
    if isinstance(code, int) and code in SENSITIVE_ATTRIBUTE_CODES:
        return True
    name = labelled.get("string")
    if isinstance(name, str) and name:
        return _normalise_attribute_name(name) in _SENSITIVE_ATTRIBUTE_NAMES
    return False


def scrub_attributes(attributes: Optional[Iterable[Any]]) -> List[Any]:
    """Private attributes and the sensitive types above are removed entirely (value and type)."""

    return [
        attribute
        for attribute in public_items(attributes)
        if isinstance(attribute, dict) and not is_sensitive_attribute(attribute)
    ]


def default_text_gate(text: str) -> bool:
    """True when neither scanner finds anything in ``text``.

    The R-18 detector (``hfygramps.scanner``: phone, e-mail, street address, PO box, contact URL, DOB near a birth keyword)
    and the live ETL's generic scanner (``text_scan``: any day-precise date, phone, e-mail, street address)."""

    return not scanner.scan_text(text) and not text_scan.blocking_hits(text)


def open_text_gate(text: str) -> bool:
    """Publishes any text. Only for a caller that has already scanned the store view (the parity run uses it)."""

    return True
