"""Committed English label tables for Gramps typed enums (D-02; copied from the live ETL, HFY-TSK-114).

The tables were generated once from Gramps 6.0.5 (`gramps.gen.lib.*Type._DATAMAP`, English) so the renderer never
depends on the runtime locale of the machine that runs it. They are the live ETL's tables, value for value: the
parity test compares rendered bytes, which depend on every label. Standard codes always render the table label; the CUSTOM code
(and any code the table does not know) renders the object's own `string`.

Gramps JSON stores a typed value as `{"_class": "EventType", "value": 12, "string": ""}`; the
older pickled path (`normalise_object`) stores `{"code": 12, "string": "Birth"}`. Both are accepted.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

EVENT_TYPE_LABELS: Dict[int, str] = {
    -1: "Unknown",
    1: "Marriage",
    2: "Marriage Settlement",
    3: "Marriage License",
    4: "Marriage Contract",
    5: "Marriage Banns",
    6: "Engagement",
    7: "Divorce",
    8: "Divorce Filing",
    9: "Annulment",
    10: "Alternate Marriage",
    11: "Adopted",
    12: "Birth",
    13: "Death",
    14: "Adult Christening",
    15: "Baptism",
    16: "Bar Mitzvah",
    17: "Bat Mitzvah",
    18: "Blessing",
    19: "Burial",
    20: "Cause Of Death",
    21: "Census",
    22: "Christening",
    23: "Confirmation",
    24: "Cremation",
    25: "Degree",
    26: "Education",
    27: "Elected",
    28: "Emigration",
    29: "First Communion",
    30: "Immigration",
    31: "Graduation",
    32: "Medical Information",
    33: "Military Service",
    34: "Naturalization",
    35: "Nobility Title",
    36: "Number of Marriages",
    37: "Occupation",
    38: "Ordination",
    39: "Probate",
    40: "Property",
    41: "Religion",
    42: "Residence",
    43: "Retirement",
    44: "Will",
    45: "Stillbirth",
}
EVENT_TYPE_CUSTOM = 0

PLACE_TYPE_LABELS: Dict[int, str] = {
    -1: "Unknown",
    1: "Country",
    2: "State",
    3: "County",
    4: "City",
    5: "Parish",
    6: "Locality",
    7: "Street",
    8: "Province",
    9: "Region",
    10: "Department",
    11: "Neighborhood",
    12: "District",
    13: "Borough",
    14: "Municipality",
    15: "Town",
    16: "Village",
    17: "Hamlet",
    18: "Farm",
    19: "Building",
    20: "Number",
}
PLACE_TYPE_CUSTOM = 0

FAMILY_TYPE_LABELS: Dict[int, str] = {
    0: "Married",
    1: "Unmarried",
    2: "Civil Union",
    3: "Unknown",
}
FAMILY_TYPE_CUSTOM = 4

CHILD_REF_LABELS: Dict[int, str] = {
    0: "None",
    1: "Birth",
    2: "Adopted",
    3: "Stepchild",
    4: "Sponsored",
    5: "Foster",
    6: "Unknown",
}
CHILD_REF_CUSTOM = 7

EVENT_ROLE_LABELS: Dict[int, str] = {
    -1: "Unknown",
    1: "Primary",
    2: "Clergy",
    3: "Celebrant",
    4: "Aide",
    5: "Bride",
    6: "Groom",
    7: "Witness",
    8: "Family",
    9: "Informant",
    10: "Godparent",
    11: "Father",
    12: "Mother",
    13: "Parent",
    14: "Child",
    15: "Multiple birth",
    16: "Friend",
    17: "Neighbor",
    18: "Officiator",
}
EVENT_ROLE_CUSTOM = 0

ATTRIBUTE_TYPE_LABELS: Dict[int, str] = {
    -1: "Unknown",
    1: "Caste",
    2: "Description",
    3: "Identification Number",
    4: "National Origin",
    5: "Number of Children",
    6: "Social Security Number",
    7: "Nickname",
    8: "Cause",
    9: "Agency",
    10: "Age",
    11: "Father's Age",
    12: "Mother's Age",
    13: "Witness",
    14: "Time",
    15: "Occupation",
}
ATTRIBUTE_TYPE_CUSTOM = 0

# StyledTextTagType codes (Gramps 6.0.5).
TAG_BOLD = 0
TAG_ITALIC = 1
TAG_UNDERLINE = 2
TAG_FONTFACE = 3
TAG_FONTSIZE = 4
TAG_FONTCOLOR = 5
TAG_HIGHLIGHT = 6
TAG_SUPERSCRIPT = 7
TAG_LINK = 8
TAG_STRIKETHROUGH = 9
TAG_SUBSCRIPT = 10

TAG_NAME_TO_CODE: Dict[str, int] = {
    "bold": TAG_BOLD,
    "italic": TAG_ITALIC,
    "underline": TAG_UNDERLINE,
    "fontface": TAG_FONTFACE,
    "fontsize": TAG_FONTSIZE,
    "fontcolor": TAG_FONTCOLOR,
    "highlight": TAG_HIGHLIGHT,
    "superscript": TAG_SUPERSCRIPT,
    "link": TAG_LINK,
    "strikethrough": TAG_STRIKETHROUGH,
    "subscript": TAG_SUBSCRIPT,
}


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _clean(value: Any) -> Optional[str]:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def labelled(
    raw: Any,
    labels: Dict[int, str],
    custom_code: int,
) -> Dict[str, Optional[Any]]:
    """Return `{"code": int|None, "string": str|None}` for a Gramps typed value.

    * a known standard code always yields the English table label;
    * the custom code (and an unknown code) yields the object's own string;
    * a bare string is reverse-looked-up so `"Birth"` and `{"value": 12}` agree;
    * nothing usable yields `{"code": None, "string": None}`.
    """

    code: Optional[int] = None
    text: Optional[str] = None

    if isinstance(raw, dict):
        code = _int_or_none(raw.get("value"))
        if code is None:
            code = _int_or_none(raw.get("code"))
        for key in ("string", "_string", "custom"):
            text = _clean(raw.get(key))
            if text:
                break
    elif isinstance(raw, bool):
        pass
    elif isinstance(raw, int):
        code = raw
    elif isinstance(raw, str):
        text = _clean(raw)

    if code is not None and code != custom_code and code in labels:
        return {"code": code, "string": labels[code]}

    if code is None and text:
        lowered = text.lower()
        for known_code, label in labels.items():
            if label.lower() == lowered:
                return {"code": known_code, "string": label}
        return {"code": custom_code, "string": text}

    return {"code": code, "string": text}


def event_type(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, EVENT_TYPE_LABELS, EVENT_TYPE_CUSTOM)


def place_type(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, PLACE_TYPE_LABELS, PLACE_TYPE_CUSTOM)


def family_type(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, FAMILY_TYPE_LABELS, FAMILY_TYPE_CUSTOM)


def child_ref_type(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, CHILD_REF_LABELS, CHILD_REF_CUSTOM)


def event_role(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, EVENT_ROLE_LABELS, EVENT_ROLE_CUSTOM)


def attribute_type(raw: Any) -> Dict[str, Optional[Any]]:
    return labelled(raw, ATTRIBUTE_TYPE_LABELS, ATTRIBUTE_TYPE_CUSTOM)
