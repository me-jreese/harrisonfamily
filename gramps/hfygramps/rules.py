"""Redaction policy v1: loader, the one birth-like predicate and the pure helpers (HFY-PLN-002 D2-32; task redaction-policy-v1).

``gramps/redaction/redaction-v1.json`` is the one source of the rules. This module reads it and gives the callers that
need a decision (the projection, the checker, the renderer, tests) the same answers:

    policy = load_policy()
    tree = Tree(objects)                        # Gramps json_data objects, one dict each
    is_birth_like(event, tree, policy)          # the only birth-like list anywhere

``shared/redaction-rules.mjs`` is the JavaScript port of the same predicates; both run the vectors in
``gramps/redaction/vectors/``. Standard library only, Python 3.12 and later (the core must run in Gramps' bundled Python and
in CI's stock python3). Nothing here logs or prints, and no function returns a matched value in an error.

Malformed input: a nested value of the wrong shape (an ``event_ref_list`` entry that is not an object, a ``type`` or a date that is
not an object, a ``citation_list`` that is not a list, a non-string path or text) is read as absent, never raised on, so a
predicate answers for the rest of the object. A date that is not an object is the one case the date helpers treat as a leak:
``date_violations`` reports it (pointer ``""``) and ``reduce_date`` replaces it by an empty date. A *top-level* argument that is
not an object at all (``is_birth_like(None, ...)``) is a caller error and may raise: a caller that gets an exception from a
record holds that record (fail closed) and never lets it through.
"""

import copy
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.path.join(_HERE, "..", "redaction", "redaction-v1.json")

_cache = {}


def _obj(value):
    """``value`` when it is an object, else an empty one: a nested value of the wrong shape reads as absent."""
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def load_policy(path=None):
    """The parsed policy. The default policy is cached; pass ``path`` to read another file (never cached)."""
    if path is not None:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    if "policy" not in _cache:
        _cache["policy"] = load_policy(POLICY_PATH)
    return _cache["policy"]


def compile_pattern(spec):
    """A policy ``{"pattern", "flags"}`` as a compiled regex with ASCII-only semantics (JavaScript without the u flag)."""
    flags = re.ASCII | (re.IGNORECASE if "i" in spec.get("flags", "") else 0)
    return re.compile(spec["pattern"], flags)


def rule_ids(policy=None):
    return [r["id"] for r in (policy or load_policy())["rules"]]


def rule(rule_id, policy=None):
    for r in (policy or load_policy())["rules"]:
        if r["id"] == rule_id:
            return r
    raise KeyError(rule_id)


def _values(named):
    return {x["value"] for x in named}


# --------------------------------------------------------------------------------------------------------------------
# The tree: the cross-object context every predicate needs.


class Tree:
    """Index over a list of Gramps ``json_data`` objects (primary objects carry ``handle`` and ``_class``)."""

    def __init__(self, objects):
        self.objects = [o for o in objects if isinstance(o, dict)]
        self.by_handle = {o["handle"]: o for o in self.objects if "handle" in o}
        self._birth_ref = None
        self._birth_citations = None

    def of_class(self, cls):
        return [o for o in self.objects if o.get("_class") == cls]

    @property
    def birth_ref_handles(self):
        """Handles of the events some person references at its ``birth_ref_index``."""
        if self._birth_ref is None:
            out = set()
            for p in self.of_class("Person"):
                idx = p.get("birth_ref_index")
                refs = _list(p.get("event_ref_list"))
                if _int(idx) and 0 <= idx < len(refs) and isinstance(refs[idx], dict):
                    out.add(refs[idx].get("ref"))
            self._birth_ref = out
        return self._birth_ref

    def birth_citation_handles(self, policy=None):
        """Handles of the citations referenced by a birth-like event or by an EventRef that points at one."""
        if self._birth_citations is None:
            out = set()
            for e in self.of_class("Event"):
                if is_birth_like(e, self, policy):
                    out.update(_list(e.get("citation_list")))
            for holder in self.of_class("Person") + self.of_class("Family"):
                for ref in _list(holder.get("event_ref_list")):
                    if not isinstance(ref, dict):
                        continue
                    ev = self.by_handle.get(ref.get("ref"))
                    if ev is not None and is_birth_like(ev, self, policy):
                        out.update(_list(ref.get("citation_list")))
            self._birth_citations = out
        return self._birth_citations


def as_tree(tree):
    return tree if isinstance(tree, Tree) else Tree(tree)


# --------------------------------------------------------------------------------------------------------------------
# The one birth-like predicate (D2-32).


def is_birth_like(event, tree, policy=None):
    """True for Birth 12, Adult Christening 14, Baptism 15, Bless 18, Christen 22, Stillbirth 45, a custom type whose name
    matches the birth pattern, and any event a person references at its ``birth_ref_index``. For everyone, living or deceased."""
    pol = (policy or load_policy())["birthLike"]
    etype = _obj(event.get("type"))
    value = etype.get("value")
    if _int(value):
        if value in _values(pol["eventTypes"]):
            return True
        string = etype.get("string")
        if value == pol["customType"]["value"] and isinstance(string, str) and compile_pattern(pol["customType"]).search(string):
            return True
    return event.get("handle") in as_tree(tree).birth_ref_handles


isBirthLike = is_birth_like  # the name the design uses (D2-32); the JavaScript port exports the same name

# --------------------------------------------------------------------------------------------------------------------
# Dates.

_GRG = (32045, 153, 1461, 146097)
_JLN = (32083, 153, 1461)


def sdn(calendar, year, month, day):
    """Gramps' day number (``gramps/gen/lib/gcalendar.py``) for the Gregorian (0) and Julian (1) calendars, else None."""
    y, m = (year + 4801 if year < 0 else year + 4800), month
    if m > 2:
        m -= 3
    else:
        m += 9
        y -= 1
    if calendar == 0:
        return ((y // 100) * _GRG[3]) // 4 + ((y % 100) * _GRG[2]) // 4 + (m * _GRG[1] + 2) // 5 + day - _GRG[0]
    if calendar == 1:
        return (y * _JLN[2]) // 4 + (m * _JLN[1] + 2) // 5 + day - _JLN[0]
    return None


def reduced_sortval(dateval, calendar, policy=None):
    """sdn(year, 1, 1) in the date's calendar; 0 when the year is 0 or the calendar is not Gregorian or Julian."""
    year = dateval[2] if len(dateval) > 2 else 0
    if not year or not _int(year) or calendar not in (policy or load_policy())["dates"]["sortvalCalendars"]:
        return 0
    return sdn(calendar, year, 1, 1)


def date_violations(date, policy=None):
    """Pointers (relative to the date) where a birth-like date still shows a day, a month or non-year text. A date that is present
    but not an object is one violation, the pointer ``""`` (the whole value); ``None`` has none."""
    pol = (policy or load_policy())["dates"]
    if date is None:
        return []
    if not isinstance(date, dict):
        return [""]
    out = []
    dv = _list(date.get("dateval"))
    for i in pol["dayMonthIndexes"]:
        if i < len(dv) and dv[i]:
            out.append("/dateval/%d" % i)
    text = date.get("text")
    if text is not None and not isinstance(text, str):
        out.append("/text")
    elif text and not re.fullmatch(pol["bareYearTextPattern"], text, re.ASCII):
        out.append("/text")
    return out


def reduce_date(date, policy=None):
    """The birth-like projection of one Gramps Date: no day or month in either half, empty text, TEXTONLY turned into its
    first four-digit year (or an empty date), sortval recomputed. Returns a new dict; ``P(P(x)) == P(x)``. A value that is not an
    object becomes an empty Date."""
    pol = policy or load_policy()
    cfg = pol["dates"]
    out = copy.deepcopy(date) if isinstance(date, dict) else {"_class": "Date", "calendar": 0, "format": None, "modifier": 0, "newyear": 0, "quality": 0}
    dv = list(_list(out.get("dateval")) or [0, 0, 0, False])
    for i in cfg["dayMonthIndexes"]:
        if i < len(dv):
            dv[i] = 0
    if out.get("modifier") == cfg["textOnlyModifier"]:
        m = re.search(cfg["textOnlyYearPattern"], out["text"] if isinstance(out.get("text"), str) else "", re.ASCII)
        dv = [0, 0, int(m.group(1)) if m else 0, False]
        out["modifier"] = 0
    out["dateval"] = dv
    out["text"] = ""
    out["sortval"] = reduced_sortval(dv, out.get("calendar", 0), pol)
    return out


def date_ymd(date, second=False):
    """(year, month, day) of the first (or second) half of a date, or None when it is not day-precise."""
    dv = _list(_obj(date).get("dateval"))
    base = 4 if second else 0
    if len(dv) >= base + 3 and dv[base] and dv[base + 1] and dv[base + 2]:
        return (dv[base + 2], dv[base + 1], dv[base])
    return None


# --------------------------------------------------------------------------------------------------------------------
# Places and coordinates.


def place_exclusion_rule(place, policy=None):
    """The rule id that excludes this place by its type, or None."""
    pol = (policy or load_policy())["places"]
    ptype = _obj(_obj(place).get("place_type"))
    value = ptype.get("value")
    if _int(value) and value in _values(pol["excludedTypes"]):
        return "place.exclude.type"
    string = ptype.get("string")
    if _int(value) and value == pol["customHomeLike"]["value"] and isinstance(string, str) and compile_pattern(pol["customHomeLike"]).search(string):
        return "place.exclude.custom_home_like"
    return None


def place_code_is_local(place, policy=None):
    """True when the place code stays local: every type below the administrative level."""
    admin = _values((policy or load_policy())["places"]["administrativeTypes"])
    return _obj(_obj(place).get("place_type")).get("value") not in admin


def round_coordinate(text, policy=None):
    """A latitude or longitude string rounded half away from zero to the policy's decimals, as a string.

    "" stays "". A value with no more decimals than the policy keeps its text. A value that is not a plain decimal
    (degrees-minutes-seconds, letters) returns None: the caller blanks it, because a finer value must never pass.
    """
    pol = (policy or load_policy())["places"]
    if text == "":
        return ""
    if not isinstance(text, str) or not re.fullmatch(pol["coordinatePattern"], text, re.ASCII):
        return None
    digits = pol["coordinateDecimals"]
    sign = "-" if text.startswith("-") else ""
    body = text.lstrip("+-")
    whole, _, frac = body.partition(".")
    if len(frac) <= digits:
        return text
    kept, dropped = frac[:digits], frac[digits]
    scaled = int(whole + kept) + (1 if dropped >= "5" else 0)
    s = str(scaled).rjust(digits + 1, "0")
    out = s[:-digits] + "." + s[-digits:] if digits else s
    return (sign if scaled else "") + out


def coordinate_is_fine(text, policy=None):
    """True when a coordinate string must be rounded or blanked before it leaves the machine."""
    return text != "" and round_coordinate(text, policy) != text


# --------------------------------------------------------------------------------------------------------------------
# URLs and attributes.


_SPECIAL_SCHEMES = ("http", "https", "ftp", "ws", "wss")


def _url_parts(raw):
    """(scheme, host, path) of a Gramps Url path: lower-case scheme and host, path with its leading slash."""
    s = (raw if isinstance(raw, str) else "").strip().replace("\\", "/")  # a browser reads a backslash as a slash
    m = re.match(r"([A-Za-z][A-Za-z0-9+.\-]*):(.*)$", s, re.S)
    scheme = ""
    rest = s
    if m and not re.match(r"[0-9]+(/|$)", m.group(2)):  # "host:8080/x" is a port, not a scheme
        scheme, rest = m.group(1).lower(), m.group(2)
    if scheme in _SPECIAL_SCHEMES:
        rest = rest.lstrip("/")  # a browser takes https:/host and https:///host as https://host
    elif rest.startswith("//"):
        rest = rest[2:]
    elif scheme:
        return scheme, "", rest
    cut = re.search(r"[/?#]", rest)
    authority, path = (rest[: cut.start()], rest[cut.start():]) if cut else (rest, "")
    host = authority.rsplit("@", 1)[-1].split(":", 1)[0].lower().rstrip(".")
    return scheme, host, path


def _host_matches(host, domain):
    return host == domain or host.endswith("." + domain)


def url_rules(url, scan_text, policy=None):
    """The contact rule ids that make this Gramps Url element local-only. ``scan_text`` is the shared detector's function."""
    pol = (policy or load_policy())["urls"]
    out = []
    url = _obj(url)
    if _obj(url.get("type")).get("value") == pol["emailType"]:
        out.append("contact.url.email_type")
    scheme, host, path = _url_parts(url.get("path"))
    channel = scheme in pol["schemes"] or any(_host_matches(host, h) for h in pol["hosts"])
    if not channel:
        channel = any(_host_matches(host, p["host"]) and path.lower().startswith(p["prefix"]) for p in pol["paths"])
    if channel:
        out.append("contact.url.channel")
    path_text, desc_text = url.get("path"), url.get("desc")
    if scan_text(path_text if isinstance(path_text, str) else "") or scan_text(desc_text if isinstance(desc_text, str) else ""):
        out.append("contact.url.scan_hit")
    return out


def attribute_rule(attr, policy=None):
    """``birth.attribute.age_time``, ``contact.attribute.government_id`` or None for one Gramps Attribute element."""
    if _obj(attr).get("_class") != "Attribute":
        return None
    pol = (policy or load_policy())["attributes"]
    value = _obj(attr.get("type")).get("value")
    if value in _values(pol["ageAndTime"]):
        return "birth.attribute.age_time"
    if value in _values(pol["governmentId"]):
        return "contact.attribute.government_id"
    return None


# --------------------------------------------------------------------------------------------------------------------
# Rects.


def rect_problem(rect, policy=None):
    """None for a usable rectangle; "full_frame" for [0,0,100,100]; "degenerate_or_float" for a rectangle to hold."""
    pol = (policy or load_policy())["media"]
    if rect is None:
        return None
    lo, hi = pol["rectRange"]
    if (not isinstance(rect, list) or len(rect) != 4 or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in rect)
            or any(isinstance(v, float) and not v.is_integer() for v in rect)  # a fractional value: the XML exporter floors them
            or any(v < lo or v > hi for v in rect) or rect[0] >= rect[2] or rect[1] >= rect[3]):
        return "degenerate_or_float"
    return "full_frame" if rect == pol["fullFrameRect"] else None


# --------------------------------------------------------------------------------------------------------------------
# JSON pointers and the path patterns of the rules.


def expand_braces(pattern):
    """``/a/{b,c/d}/e`` -> ``/a/b/e``, ``/a/c/d/e``."""
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    out = []
    for alt in m.group(1).split(","):
        out.extend(expand_braces(pattern[: m.start()] + alt + pattern[m.end():]))
    return out


def _children(node):
    if isinstance(node, dict):
        return [(k, v) for k, v in node.items()]
    if isinstance(node, list):
        return [(str(i), v) for i, v in enumerate(node)]
    return []


def _walk(node, segs, prefix, out):
    if not segs:
        out.append(prefix)
        return
    head, rest = segs[0], segs[1:]
    if head == "**":
        _walk(node, rest, prefix, out)
        for k, v in _children(node):
            _walk(v, segs, prefix + "/" + k, out)
    elif head == "*":
        for k, v in _children(node):
            _walk(v, rest, prefix + "/" + k, out)
    elif isinstance(node, dict) and head in node:
        _walk(node[head], rest, prefix + "/" + head, out)
    elif isinstance(node, list) and head.isdigit() and int(head) < len(node):
        _walk(node[int(head)], rest, prefix + "/" + head, out)


def _pointer_key(pointer):
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in pointer.split("/")[1:]]


def match_pointers(obj, pattern):
    """Sorted RFC 6901 pointers of the existing nodes of ``obj`` that match a rule path pattern.

    Segments: a literal key or list index, ``*`` for one key or index, ``**`` for any depth (including none), and
    ``{a,b}`` for alternatives. ``/`` is the object itself (the empty pointer).
    """
    out = []
    for pat in expand_braces(pattern):
        segs = [s for s in pat.split("/")[1:] if s != ""]
        _walk(obj, segs, "", out)
    return sorted(set(out), key=_pointer_key)


def _tokens(pointer):
    return [t.replace("~1", "/").replace("~0", "~") for t in pointer.split("/")[1:]]


def pointer_get(obj, pointer, default=None):
    node = obj
    for t in _tokens(pointer):
        if isinstance(node, dict) and t in node:
            node = node[t]
        elif isinstance(node, list) and t.isdigit() and int(t) < len(node):
            node = node[int(t)]
        else:
            return default
    return node


def pointer_set(obj, pointer, value):
    toks = _tokens(pointer)
    node = obj
    for t in toks[:-1]:
        node = node[int(t)] if isinstance(node, list) else node[t]
    if isinstance(node, list):
        node[int(toks[-1])] = value
    else:
        node[toks[-1]] = value


def pointer_remove(obj, pointers):
    """Remove every listed pointer (list elements from the highest index down, so indexes stay valid)."""
    for p in sorted(set(pointers), key=_pointer_key, reverse=True):
        toks = _tokens(p)
        node = obj
        for t in toks[:-1]:
            node = node[int(t)] if isinstance(node, list) else node[t]
        if isinstance(node, list):
            del node[int(toks[-1])]
        else:
            node.pop(toks[-1], None)
