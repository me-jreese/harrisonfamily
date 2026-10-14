"""What the renderer never publishes (D-02, PS-06, R-19): private objects, sensitive attributes, and text with contact data.

Ported from the live ETL's ``publish_policy`` (HFY-TSK-114) with one deliberate change. The live ETL publishes a note,
a region note or a MediaRef attribute value only from an io-approved per-object allowlist, because nothing upstream of
it checks free text. The renderer sits behind the redaction projection, which already holds free text that trips the
R-18 scanner (BRD2 section 11.1, 5.4), so it publishes what the store view holds and keeps a second gate of its own:
``default_text_gate`` withholds any text that the R-18 detector (``hfygramps.scanner``) or the live ETL's own scanner flags.

The gate covers every free-text field the renderer publishes: notes, region notes, MediaRef attribute values, citation
titles, ``Event.description``, ``Media.desc`` (the media title; a blocked one falls back to the Gramps ID), the ``path``
and ``desc`` of a place URL (a blocked or contact URL is dropped), and the value of a note LINK tag (``note_tags``).

INTERIM RULE COPY (BRD2 D2-32): ``SENSITIVE_ATTRIBUTE_CODES`` and ``_SENSITIVE_ATTRIBUTE_NAMES`` here, and the place-type
lists in ``places.py``, are a local copy of rules whose one source is ``gramps/redaction/redaction-v1.json``
(``redaction-policy-v1``), which does not exist yet. ``test_render_rules.RuleSourceAgreement`` fails if that file appears
and disagrees.
TODO(render-lambda / projection-py): replace the local lists with an import of ``redaction-v1.json``.
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


def gated_text(value: Any, gate: TextGate) -> Optional[str]:
    """``value`` when it is non-empty text that passes ``gate``, else ``None`` (nothing is published for a blocked text)."""

    if not isinstance(value, str) or not value:
        return None
    return value if gate(value) else None


_URL_EMAIL_TYPE_CODE = 1  # Gramps UrlType.EMAIL


def _is_email_url_type(value: Any) -> bool:
    if isinstance(value, dict):
        code = value.get("value", value.get("code"))
        string = value.get("string")
        return code == _URL_EMAIL_TYPE_CODE or (isinstance(string, str) and string.strip().lower() in {"e-mail", "email"})
    return value == _URL_EMAIL_TYPE_CODE and not isinstance(value, bool)


def public_urls(urls: Optional[Iterable[Any]], gate: TextGate) -> List[Any]:
    """The URLs that may be published (sync.md 5.3, Q2-02 item 2): not private, not an e-mail type, and with a ``path`` and a
    ``desc`` that pass ``gate`` (the R-18 detector flags mailto:, tel: and messaging links, and contact data in the text)."""

    kept: List[Any] = []
    for url in public_items(urls):
        if not isinstance(url, dict) or _is_email_url_type(url.get("type")):
            continue
        if not all(gate(url[key]) for key in ("path", "desc") if isinstance(url.get(key), str) and url[key]):
            continue
        kept.append(url)
    return kept


def open_text_gate(text: str) -> bool:
    """Publishes any text. Only for a caller that has already scanned the store view (the parity run uses it)."""

    return True
