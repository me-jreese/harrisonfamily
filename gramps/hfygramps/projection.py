"""The redaction projection P, in pure Python (HFY-PLN-002 sync.md section 5 as amended by BRD2 section 11.1; task projection-py).

    projected, holds = project_tree(objects, base=..., files=..., released=..., sticky=...)
    result = project(objects, ...)          # the same run with the details the addon and the preview need

``objects`` are Gramps ``json_data`` dicts, one per primary object (every one with ``handle`` and ``_class``). ``projected`` maps
every input handle to the object the cloud receives, or ``None`` when the cloud must not have it (excluded, or held while the
cloud has no copy). ``holds`` lists what was held back and why, each ``{"handle", "rule", "scope", "pointer"}`` with ``scope``
``"object"`` (the cloud keeps its last copy, or none) or ``"field"`` (the cloud keeps the last synced value of that field).
``hold_reason(rule_id)`` gives the sentence the preview shows.

The rules are those of ``gramps/redaction/redaction-v1.json`` (``hfygramps.rules`` loads them and owns the one birth-like
predicate); this module is the desktop side that applies them. It imports nothing from Gramps and nothing outside the standard
library and this package, so it runs in Gramps' bundled Python and in CI's stock python3 (3.10 and later).

Context, all optional:

``base``      ``{handle: projected object the cloud has}``, the sidecar's last synced copies. A held field or object falls back to it.
``files``     ``{media handle: {"exif_gps": bool, "md5": str, "readable": bool}}``, what the addon learned from the bytes on disk
              (the projection reads no files).
``released``  media handles io released in the GUI; their holds are skipped.
``sticky``    the sidecar's ``birthlike_sticky`` set: event handles that were birth-like at a synced base, or whose date equals a
              local full birth date. Day and month stay local on them until io releases the handle. ``update_birthlike_sticky``
              returns the set to store after a run (``Projection.sticky`` is that set for the run just made); io's release is
              removing the handle from it.

Phases (the policy's order): classify, elements, fields, scan, orphans, references. A projected object never carries ``change``
(Gramps' last-changed stamp is derived, sync.md 6.1; the cloud object never has it), so ``P(lift(C, L)) == C`` can hold.
Beyond the bare rules, and only ever in the safe direction: a TEXTONLY or free-text Date whose text renders a local full birth
date is reduced; an event that is sticky counts as birth-like for the dates of its citations and for birth-linked media; the
free-text birth-date scan folds Unicode look-alikes and spacing before it matches (the scanner's own normalization).

Idempotent: ``P(P(x)) == P(x)`` with the same context. Pure: the inputs are never changed. A caller that gets an exception holds the
run (fail closed): an object of an unknown class, a duplicate handle or a missing handle raises ``ValueError``.
"""

import copy
import re

from . import rules as R
from . import scanner

PRIMARY = ("Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag", "Researcher")

MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
          "December")
#: Lower-case month forms the free-text scan accepts: the full name, the three-letter form and "sept".
_MONTH_FORMS = tuple((m.lower(), m[:3].lower()) + (("sept",) if m == "September" else ()) for m in MONTHS)

_MISSING = object()


def hold_reason(rule_id, policy=None):
    """The preview sentence for a hold: the summary of the rule that held it."""
    return R.rule(rule_id, policy)["summary"]


# --------------------------------------------------------------------------------------------------------------------
# Local full birth dates and the free-text scan against them (dob_exact).


def _ordinal(n):
    return "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def dob_renderings(year, month, day):
    """A full date in the forms the exact-DOB scan looks for (sync.md 5.2), in their usual case: ISO, ``M/D/YYYY``,
    ``MM/DD/YYYY``, ``D.M.YYYY``, ``YYYY/MM/DD``, ``Month D, YYYY``, ``D Month YYYY`` and the three-letter-month forms. The
    scan itself also takes zero-padded, comma-less, day-first and dotted variants and ordinals (see ``DobIndex``)."""
    mon = MONTHS[month - 1]
    return {"%04d-%02d-%02d" % (year, month, day), "%d/%d/%04d" % (month, day, year),
            "%02d/%02d/%04d" % (month, day, year), "%d.%d.%04d" % (day, month, year),
            "%04d/%02d/%02d" % (year, month, day), "%s %d, %04d" % (mon, day, year), "%d %s %04d" % (day, mon, year),
            "%s %d, %04d" % (mon[:3], day, year), "%d %s %04d" % (day, mon[:3], year)}


def _full_forms(year, month, day):
    """Every full rendering the scan matches, lower case (see ``dob_renderings`` for the core nine)."""
    out = {r.lower() for r in dob_renderings(year, month, day)}
    y = "%04d" % year
    d2, m2 = "%02d" % day, "%02d" % month
    out.update(["%s.%s.%s" % (y, m2, d2), "%d/%d/%s" % (day, month, y), "%s/%s/%s" % (d2, m2, y), "%s.%s.%s" % (d2, m2, y),
                "%d.%d.%s" % (day, month, y), "%s-%s-%s" % (y, m2, d2), "%s-%d-%d" % (y, month, day)])
    for mon in _MONTH_FORMS[month - 1]:
        for m in (mon, mon + "."):
            for dd in (str(day), d2, str(day) + _ordinal(day)):
                out.update(["%s %s, %s" % (m, dd, y), "%s %s %s" % (m, dd, y), "%s %s %s" % (dd, m, y), "%s %s, %s" % (dd, m, y),
                            "%s of %s %s" % (dd, m, y), "%s of %s, %s" % (dd, m, y)])
    return out


def _fold(text):
    """The text the exact-DOB scan matches against: the scanner's normalization (look-alike digits, spaces and dashes folded,
    invisible characters dropped), lower case, runs of whitespace as one space."""
    t = scanner._normalize(text)[0]
    return re.sub(r"[ \t\r\n\f\v]+", " ", t.lower())


_KEYWORDS = sorted(set(w.replace(" ", " ") for w in scanner.BIRTHDAY_KEYWORDS), key=lambda w: (-len(w), w))
_KEYWORD_RE = re.compile(r"(?<![a-z])(?:%s)(?![a-z])|(?<![a-z])(?:b|bap|bapt|chr)\." % "|".join(re.escape(w) for w in _KEYWORDS), re.ASCII)
_YEAR_RE = re.compile(r"(?=([0-9]{4}))", re.ASCII)


class _Dob:
    __slots__ = ("person", "names", "year", "month", "day", "calendar", "_forms")

    def __init__(self, person, names, year, month, day, calendar):
        self.person, self.names, self.year, self.month, self.day, self.calendar = person, names, year, month, day, calendar
        self._forms = None

    @property
    def forms(self):
        if self._forms is None:
            self._forms = _full_forms(self.year, self.month, self.day)
        return self._forms


class DobIndex:
    """Every local full birth date, and the questions the projection asks of it.

    ``date_hit(date)``  a Date (any class) shows the same calendar day as some local full birth date, in either half.
    ``text_hit(text)``  free text holds a full rendering of one, or the day and month alone within ``window`` characters of a
                        birth keyword or of that person's given name (also the call name and the nickname).
    """

    def __init__(self, dobs, window):
        self.window = window
        self.dobs = dobs
        self._days = {(d.calendar, (d.year, d.month, d.day)) for d in dobs}
        self._by_year = {}
        self._by_day = {}
        for d in dobs:
            self._by_year.setdefault(d.year, []).append(d)
            self._by_day.setdefault((d.month, d.day), []).append(d)
        self._day_re = {}

    def __bool__(self):
        return bool(self.dobs)

    def date_hit(self, date):
        if not self.dobs or not isinstance(date, dict):
            return False
        cal = date.get("calendar", 0)
        for second in (False, True):
            ymd = R.date_ymd(date, second)
            if ymd and (cal, ymd) in self._days:
                return True
        return False

    def _partial(self, month, day):
        if (month, day) not in self._day_re:
            names = "(?:%s)" % "|".join(re.escape(m) + r"\.?" for m in sorted(_MONTH_FORMS[month - 1], key=len, reverse=True))
            d = "0?%d" % day
            ordn = "(?:st|nd|rd|th)?"
            forms = [
                r"(?<![a-z0-9])%s %s%s(?![0-9a-z])" % (names, d, ordn),
                r"(?<![a-z0-9])%s%s (?:of )?%s(?![a-z])" % (d, ordn, names),
                r"(?<![0-9/])0?%d/0?%d(?![0-9/])" % (month, day),
                r"(?<![0-9/])0?%d/0?%d(?![0-9/])" % (day, month),
                r"(?<![0-9.])0?%d\.0?%d\.(?![0-9])" % (day, month),
                r"(?<![0-9.])0?%d\.0?%d\.(?![0-9])" % (month, day),
            ]
            self._day_re[(month, day)] = re.compile("|".join(forms), re.ASCII)
        return self._day_re[(month, day)]

    def text_hit(self, text):
        if not self.dobs or not isinstance(text, str) or not text:
            return False
        t = _fold(text)
        if not re.search("[0-9]", t):
            return False
        for m in _YEAR_RE.finditer(t):
            for dob in self._by_year.get(int(m.group(1)), ()):
                if any(f in t for f in dob.forms):
                    return True
        keywords = [(k.start(), k.end()) for k in _KEYWORD_RE.finditer(t)]
        for (month, day), group in self._by_day.items():
            hits = [(h.start(), h.end()) for h in self._partial(month, day).finditer(t)]
            if not hits:
                continue
            if keywords and any(self._near(h, keywords) for h in hits):
                return True
            for dob in group:
                anchors = [(k.start(), k.end()) for name in dob.names for k in re.finditer(re.escape(name), t)]
                if anchors and any(self._near(h, anchors) for h in hits):
                    return True
        return False

    def _near(self, hit, anchors):
        return any(max(0, a - hit[1], hit[0] - b) <= self.window for a, b in anchors)


def _given_names(person):
    out = []
    name = person.get("primary_name") if isinstance(person, dict) else None
    if isinstance(name, dict):
        for key in ("first_name", "call", "nick"):
            v = name.get(key)
            if isinstance(v, str):
                for token in re.split(r"[ \t]+", _fold(v)):
                    if len(token) >= 2 and token not in out:
                        out.append(token)
    return tuple(out)


def local_dobs(tree, sticky=(), policy=None):
    """``[_Dob]``: every day-precise date (either half) of a birth-like event or of a sticky event, once for each person who
    references the event (the person's given names are its free-text anchors; an event nobody references has none)."""
    pol = policy or R.load_policy()
    owners = {}
    for p in tree.of_class("Person"):
        for ref in R._list(p.get("event_ref_list")):
            if isinstance(ref, dict):
                owners.setdefault(ref.get("ref"), []).append(p)
    out = []
    for e in tree.of_class("Event"):
        h = e.get("handle")
        if not (h in sticky or R.is_birth_like(e, tree, pol)):
            continue
        date = e.get("date")
        for second in (False, True):
            ymd = R.date_ymd(date, second)
            if not ymd:
                continue
            for p in owners.get(h) or [None]:
                out.append(_Dob(p.get("handle") if p else None, _given_names(p), ymd[0], ymd[1], ymd[2],
                                date.get("calendar", 0)))
    return out


def _tree_of(objects):
    return objects if isinstance(objects, R.Tree) else R.Tree(list(objects))


def _sticky_core(tree, base, pol):
    """Events birth-like now and events birth-like in the synced base."""
    out = {e["handle"] for e in tree.of_class("Event") if "handle" in e and R.is_birth_like(e, tree, pol)}
    if base:
        base_tree = R.Tree([o for o in base.values() if isinstance(o, dict)])
        out.update(e["handle"] for e in base_tree.of_class("Event") if "handle" in e and R.is_birth_like(e, base_tree, pol))
    return out


def _sticky_by_date(tree, index):
    return {e["handle"] for e in tree.of_class("Event") if "handle" in e and index.date_hit(e.get("date"))}


def birthlike_sticky_additions(objects, base=None, policy=None):
    """The event handles that must be in ``birthlike_sticky`` after this run: events birth-like now, events birth-like in the
    synced ``base`` (so a Birth retyped to Residence stays sticky), and events whose date shows the same calendar day as a
    local full birth date. Looking at the local tree as well as at the base also covers an event retyped before its first sync."""
    pol = policy or R.load_policy()
    tree = _tree_of(objects)
    out = _sticky_core(tree, base, pol)
    return out | _sticky_by_date(tree, DobIndex(local_dobs(tree, out, pol), pol["scan"]["dobWindow"]))


def update_birthlike_sticky(sticky, objects, base=None, released=(), policy=None):
    """The ``birthlike_sticky`` set to store after a run: the stored set plus the additions, minus the handles io released."""
    return (set(sticky) | birthlike_sticky_additions(objects, base, policy)) - set(released)


# --------------------------------------------------------------------------------------------------------------------
# Lift helpers for the two fields whose projection loses precision (the full lift is merge-engine-py's).


def project_coordinate(local, policy=None):
    """What the cloud gets for a latitude or longitude string: rounded to 2 decimals, "" when it is not a plain decimal."""
    rounded = R.round_coordinate(local, policy)
    return "" if rounded is None else rounded


def lift_coordinate(cloud, local, policy=None):
    """The value a lifted object takes: the local one (full precision) while its projection is the cloud value, else the cloud's."""
    return local if isinstance(local, str) and project_coordinate(local, policy) == cloud else cloud


def project_rect(local, base_rect=None, policy=None):
    """``(cloud value, held)`` for one MediaRef rectangle: ``[0,0,100,100]`` becomes ``None``; a degenerate or fractional rectangle
    is held (the cloud keeps ``base_rect``, ``None`` for a new reference)."""
    problem = R.rect_problem(local, policy)
    if problem == "full_frame":
        return None, False
    if problem == "degenerate_or_float":
        return copy.deepcopy(base_rect), True
    return copy.deepcopy(local), False


def lift_rect(cloud, local, base_rect=None, policy=None):
    """The rectangle a lifted MediaRef takes: the local one while its projection is the cloud value (the full frame and held
    rectangles come back), else the cloud's."""
    return copy.deepcopy(local) if project_rect(local, base_rect, policy)[0] == cloud else copy.deepcopy(cloud)


# --------------------------------------------------------------------------------------------------------------------
# The result.


class Projection:
    """One run of P. ``project_tree`` returns ``(projected, holds)``; the rest is for the addon's plan and preview.

    projected   ``{handle: object or None}``
    holds       ``[{"handle", "rule", "scope", "pointer"}]`` sorted by handle, rule, pointer, scope
    excluded    ``[{"handle", "rule"}]`` objects the rules keep local for good (private, home-like place, researcher, orphans)
    withdrawn   handles in ``base`` that are now excluded: the push sends a withdraw for each
    fired       the rule ids that changed or withheld something
    sticky      the ``birthlike_sticky`` set in force for this run (store it; io releases a handle by removing it)
    """

    def __init__(self, projected, holds, excluded, withdrawn, fired, sticky):
        self.projected, self.holds, self.excluded = projected, holds, excluded
        self.withdrawn, self.fired, self.sticky = withdrawn, fired, sticky

    def as_tuple(self):
        return self.projected, self.holds

    def __iter__(self):
        return iter(self.as_tuple())


def project_tree(objects, base=None, files=None, released=(), sticky=(), policy=None):
    """``(projected, holds)``: P over the whole tree (see the module docstring)."""
    return project(objects, base, files, released, sticky, policy).as_tuple()


def project(objects, base=None, files=None, released=(), sticky=(), policy=None):
    return _Run(objects, base, files, released, sticky, policy or R.load_policy()).run()


def _walk_dicts(node, pointer=""):
    """``(pointer, dict)`` for every dict in a JSON value, parents before children."""
    if isinstance(node, dict):
        yield pointer, node
        for k, v in node.items():
            yield from _walk_dicts(v, pointer + "/" + str(k).replace("~", "~0").replace("/", "~1"))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk_dicts(v, pointer + "/" + str(i))


def _walk_strings(node, pointer=""):
    if isinstance(node, str):
        yield pointer, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _walk_strings(v, pointer + "/" + str(k).replace("~", "~0").replace("/", "~1"))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk_strings(v, pointer + "/" + str(i))


def _is_date(node):
    return node.get("_class") == "Date" or "dateval" in node


class _Run:
    def __init__(self, objects, base, files, released, sticky, pol):
        self.pol = pol
        self.base = {h: o for h, o in (base or {}).items() if isinstance(o, dict)}
        self.files = files or {}
        self.released = set(released or ())
        self.objs = []
        seen = set()
        for o in objects:
            if not isinstance(o, dict):
                raise ValueError("an object is not a dict")
            cls = o.get("_class")
            if cls not in PRIMARY:
                raise ValueError("unknown class %r" % (cls,))
            if "handle" not in o:
                if cls == "Researcher":
                    continue
                raise ValueError("an object has no handle")
            if o["handle"] in seen:
                raise ValueError("duplicate handle")
            seen.add(o["handle"])
            self.objs.append(o)
        self.tree = R.Tree(self.objs)
        # the events whose day and month stay local on their own account; an event that only shares a local birth date is reduced
        # by the exact-date rule and joins the stored set (``sticky_out``) for the runs after this one
        self.sticky = set(sticky or ()) | _sticky_core(self.tree, self.base, pol)
        self.index = DobIndex(local_dobs(self.tree, self.sticky, pol), pol["scan"]["dobWindow"])
        self.sticky_out = self.sticky | _sticky_by_date(self.tree, self.index)
        self.excluded = {}      # handle -> rule id
        self.held_whole = {}    # handle -> [rule ids]
        self.holds = []
        self.fired = set()
        self.proj = {}          # handle -> projected copy
        self.removed = {}       # handle -> pointers of removed private elements (for the orphan edges)
        self.birth_ctx = {}     # person handle -> (copy, event element of birth_ref_index, of death_ref_index)
        self.absent = set()

    # ---------------------------------------------------------------- classify
    def _birth_events(self):
        out = {e["handle"] for e in self.tree.of_class("Event") if "handle" in e and R.is_birth_like(e, self.tree, self.pol)}
        return out | self.sticky

    def _birth_citations(self, events):
        out = set()
        for e in self.tree.of_class("Event"):
            if e.get("handle") in events:
                out.update(c for c in R._list(e.get("citation_list")) if isinstance(c, str))
        for holder in self.tree.of_class("Person") + self.tree.of_class("Family"):
            for ref in R._list(holder.get("event_ref_list")):
                if isinstance(ref, dict) and ref.get("ref") in events:
                    out.update(c for c in R._list(ref.get("citation_list")) if isinstance(c, str))
        return out

    @staticmethod
    def _media_refs(o):
        return {r.get("ref") for r in R._list(o.get("media_list")) if isinstance(r, dict)}

    def _classify(self):
        pol = self.pol
        for o in self.objs:
            h, cls = o["handle"], o["_class"]
            if cls == "Researcher":
                self.excluded[h] = "contact.researcher"
            elif o.get("private") is True:
                self.excluded[h] = "private.object.exclude"
            elif cls == "Place" and R.place_exclusion_rule(o, pol):
                self.excluded[h] = R.place_exclusion_rule(o, pol)
        for p in self.tree.of_class("Person"):
            if p["handle"] not in self.excluded and R._obj(p.get("primary_name")).get("private") is True:
                self.held_whole.setdefault(p["handle"], []).append("private.name.hold_person")
        events = self._birth_events()
        citations = self._birth_citations(events)
        linked = set()
        for e in self.tree.of_class("Event"):
            if e["handle"] in events:
                linked |= self._media_refs(e)
        for c in self.tree.of_class("Citation"):
            if c["handle"] in citations:
                linked |= self._media_refs(c)
        self.birth_citations = citations
        for m in self.tree.of_class("Media"):
            h = m["handle"]
            if h in self.excluded or h in self.released:
                continue
            f = R._obj(self.files.get(h))
            if f.get("exif_gps") and m.get("mime") in pol["media"]["exifGpsMime"]:
                self.held_whole.setdefault(h, []).append("media.exif_gps.hold")
            if h in linked:
                self.held_whole.setdefault(h, []).append("media.birth_linked.hold")
            if m.get("mime") in pol["media"]["heldMime"]:
                self.held_whole.setdefault(h, []).append("media.pdf.hold")

    # ---------------------------------------------------------------- elements and fields
    def _private_elements(self, obj):
        removed = []
        for r in self.pol["rules"]:
            if r["phase"] != "elements" or obj["_class"] not in r["objectClass"]:
                continue
            want = r.get("params", {}).get("elementClass")
            for ptr in R.match_pointers(obj, r["path"]):
                node = R.pointer_get(obj, ptr)
                if isinstance(node, dict) and node.get("private") is True and (want is None or node.get("_class") == want):
                    removed.append(ptr)
                    self.fired.add(r["id"])
        R.pointer_remove(obj, removed)
        return removed

    def _reduce(self, date, rule_id):
        """Reduce one Date in place; the rule fires only when it changed something."""
        pol = self.pol
        before = copy.deepcopy(date)
        date.update(R.reduce_date(date, pol))
        dv0 = R._list(before.get("dateval"))
        day_month = any(i < len(dv0) and dv0[i] for i in pol["dates"]["dayMonthIndexes"])
        if rule_id == "birth.date.daymonth":
            if day_month:
                self.fired.add(rule_id)
        elif date != before:
            self.fired.add(rule_id)
        if before.get("sortval") != date.get("sortval") and rule_id == "birth.date.daymonth":
            self.fired.add("birth.date.sortval")

    def _dates(self, obj):
        pol, h, cls = self.pol, obj["handle"], obj["_class"]
        date = obj.get("date")
        if cls == "Event" and isinstance(date, dict):
            if R.is_birth_like(obj, self.tree, pol):
                had_text = date.get("text") or ""
                textonly = date.get("modifier") == pol["dates"]["textOnlyModifier"]
                self._reduce(date, "birth.date.daymonth")
                if had_text:
                    self.fired.add("birth.date.text")
                if textonly:
                    self.fired.add("birth.date.textonly")
            elif h in self.sticky:
                self._reduce(date, "birth.sticky")
        if cls == "Citation" and h in self.birth_citations and isinstance(date, dict):
            self._reduce(date, "birth.citation.date")
        if cls == "Person":
            names = [obj.get("primary_name")] + R._list(obj.get("alternate_names"))
            for n in names:
                if isinstance(n, dict) and R._obj(n.get("type")).get("value") == pol["dates"]["nameTypeBirth"] \
                        and isinstance(n.get("date"), dict):
                    self._reduce(n["date"], "birth.name.date")
        if self.index:
            for _, node in _walk_dicts(obj):
                if _is_date(node) and (self.index.date_hit(node) or self.index.text_hit(node.get("text"))):
                    self._reduce(node, "birth.dob_exact.date")

    def _fields(self, obj, base_obj):
        pol, h, cls = self.pol, obj["handle"], obj["_class"]
        self._dates(obj)
        drop = []
        for ptr in R.match_pointers(obj, "/**/attribute_list/*"):
            el = R.pointer_get(obj, ptr)
            rid = R.attribute_rule(el, pol) if isinstance(el, dict) else None
            if rid:
                drop.append(ptr)
                self.fired.add(rid)
        R.pointer_remove(obj, drop)
        if cls == "Person":
            if obj.get("lds_ord_list"):
                self.fired.add("birth.lds_ord")
            obj["lds_ord_list"] = []
        if cls in ("Person", "Repository"):
            if obj.get("address_list"):
                self.fired.add("contact.address_list")
            obj["address_list"] = []
        if cls in ("Person", "Place", "Repository"):
            keep = []
            for u in R._list(obj.get("urls")):
                hit = R.url_rules(u, scanner.scan_text, pol)
                if hit:
                    self.fired.update(hit)
                else:
                    keep.append(u)
            obj["urls"] = keep
        if cls == "Place":
            self._place_fields(obj)
        if cls == "Media":
            if obj.get("path"):
                self.fired.add("media.path.local_only")
            obj["path"] = ""
            f = R._obj(self.files.get(h))
            if f.get("readable") and f.get("md5"):
                if obj.get("checksum") != f["md5"]:
                    self.fired.add("media.checksum.derive")
                obj["checksum"] = f["md5"]
        self._rects(obj, base_obj)

    def _place_fields(self, obj):
        pol = self.pol
        locs = []
        for loc in R._list(obj.get("alt_loc")):
            if not isinstance(loc, dict):
                continue
            for f in pol["places"]["locationFields"]:
                if loc.get(f):
                    loc[f] = ""
                    self.fired.add("contact.alt_loc.fields")
            if any(isinstance(v, str) and v for k, v in loc.items() if not k.startswith("_")):
                locs.append(loc)
            else:
                self.fired.add("contact.alt_loc.empty")
        obj["alt_loc"] = locs
        if R.place_code_is_local(obj, pol):
            if obj.get("code"):
                self.fired.add("place.code.local_only")
            obj["code"] = ""
        for k in ("lat", "long"):
            if k in obj:
                rounded = project_coordinate(obj[k], pol)
                if rounded != obj[k]:
                    self.fired.add("place.coordinates.round")
                obj[k] = rounded

    @staticmethod
    def _rect_key(refs):
        """Per element of a media_list: ``ref#n`` with n the occurrence among equal refs (the merge model's key)."""
        seen, out = {}, []
        for el in refs:
            ref = el.get("ref") if isinstance(el, dict) else None
            n = seen.get(ref, 0)
            seen[ref] = n + 1
            out.append((ref, n))
        return out

    def _rects(self, obj, base_obj):
        refs = obj.get("media_list")
        if not isinstance(refs, list):
            return
        base_refs = R._list(base_obj.get("media_list")) if isinstance(base_obj, dict) else []
        base_by_key = {k: el for k, el in zip(self._rect_key(base_refs), base_refs) if isinstance(el, dict)}
        for i, (key, el) in enumerate(zip(self._rect_key(refs), refs)):
            if not isinstance(el, dict) or "rect" not in el:
                continue
            problem = R.rect_problem(el["rect"], self.pol)
            if problem == "full_frame":
                el["rect"] = None
                self.fired.add("media.rect.full_frame")
            elif problem == "degenerate_or_float":
                el["rect"] = copy.deepcopy(R._obj(base_by_key.get(key)).get("rect"))
                self.holds.append({"handle": obj["handle"], "rule": "media.rect.degenerate_or_float", "scope": "field",
                                   "pointer": "/media_list/%d/rect" % i})

    # ---------------------------------------------------------------- scan
    def _scan_fields(self, obj):
        table = {}
        for f in self.pol["scan"]["fields"]:
            table.setdefault(f["class"], []).append(f["path"])
        for ptr, node in _walk_dicts(obj):
            for path in table.get(node.get("_class"), ()):
                v = R.pointer_get(node, path)
                if isinstance(v, str) and v:
                    yield ptr + path, v

    def _scan(self):
        kinds = self.pol["scan"]["kinds"]
        self.new_holds = set()
        for h, obj in self.proj.items():
            if h in self.held_whole:
                continue
            hits = []
            for ptr, text in self._scan_fields(obj):
                seen = []
                for f in scanner.scan_text(text):
                    if f["kind"] in kinds and f["kind"] not in seen:
                        seen.append(f["kind"])
                hits.extend(("scan." + k, ptr) for k in seen)
                if self.index.text_hit(text):
                    hits.append(("scan.dob_exact", ptr))
            if not hits:
                continue
            b = self.base.get(h)
            if b is not None and all(R.pointer_get(b, _revert_pointer(p), _MISSING) is not _MISSING for _, p in hits):
                for rule_id, ptr in hits:
                    R.pointer_set(obj, _revert_pointer(ptr), copy.deepcopy(R.pointer_get(b, _revert_pointer(ptr))))
                    self.holds.append({"handle": h, "rule": rule_id, "scope": "field", "pointer": ptr})
            else:
                for rule_id, ptr in hits:
                    self.holds.append({"handle": h, "rule": rule_id, "scope": "object", "pointer": ptr})
                self.new_holds.add(h)

    # ---------------------------------------------------------------- orphans
    def _edges(self):
        """target handle -> [(source handle, dead)] over the input objects; an edge is dead inside a removed private element."""
        handles = set(self.tree.by_handle)
        edges = {}
        for o in self.objs:
            h = o["handle"]
            dead_roots = self.removed.get(h, ())
            for ptr, s in _walk_strings(o):
                if s in handles and s != h:
                    dead = any(ptr == d or ptr.startswith(d + "/") for d in dead_roots)
                    edges.setdefault(s, []).append((h, dead))
        return edges

    def _orphans(self):
        classes = set(R.rule("private.orphan.exclude", self.pol)["objectClass"]) | {"Citation"}
        edges = self._edges()
        changed = True
        while changed:
            changed = False
            for t in sorted(self.tree.by_handle):
                o = self.tree.by_handle[t]
                if t in self.absent or o.get("_class") not in classes:
                    continue
                es = edges.get(t, [])
                if o.get("_class") == "Citation" and o.get("source_handle") in self.absent:
                    self.excluded[t] = "private.citation.source_excluded"
                elif es and all(dead or src in self.absent for src, dead in es):
                    self.excluded[t] = "private.orphan.exclude"
                else:
                    continue
                self.absent.add(t)
                changed = True

    # ---------------------------------------------------------------- references
    def _chain_up(self, place_handle):
        """The nearest ancestor of a place that is kept, following placeref_list[0]; None when there is none."""
        seen = set()
        cur = self.tree.by_handle.get(place_handle)
        while cur is not None and cur["handle"] not in seen:
            seen.add(cur["handle"])
            refs = R._list(cur.get("placeref_list"))
            if not refs or not isinstance(refs[0], dict):
                return None
            nxt = refs[0].get("ref")
            if nxt not in self.absent and nxt in self.tree.by_handle:
                return nxt
            cur = self.tree.by_handle.get(nxt)
        return None

    def _references(self, obj):
        cls = obj["_class"]
        type_excluded = {h for h, r in self.excluded.items() if r.startswith("place.exclude.")}
        drop = []
        for ptr in R.match_pointers(obj, "/**/{family_list,parent_family_list,note_list,citation_list}/*"):
            if R.pointer_get(obj, ptr) in self.absent:
                drop.append(ptr)
                self.fired.add("private.reference.handle_lists")
        for ptr in R.match_pointers(obj, "/{event_ref_list,media_list,child_ref_list,person_ref_list,reporef_list}/*"):
            el = R.pointer_get(obj, ptr)
            if isinstance(el, dict) and el.get("ref") in self.absent:
                drop.append(ptr)
                self.fired.add("private.reference.element_refs")
        if cls == "Family":
            for k in ("father_handle", "mother_handle"):
                if obj.get(k) in self.absent:
                    obj[k] = None
                    self.fired.add("private.reference.parent_handles")
        if cls == "Event" and obj.get("place"):
            pl = obj["place"]
            if pl in type_excluded:
                obj["place"] = self._chain_up(pl) or ""
                self.fired.add("place.repoint")
            elif pl in self.absent:
                obj["place"] = ""
                self.fired.add("private.reference.event_place")
        if cls == "Place":
            for ptr in R.match_pointers(obj, "/placeref_list/*"):
                el = R.pointer_get(obj, ptr)
                if not isinstance(el, dict):
                    continue
                if el.get("ref") in type_excluded:
                    self.fired.add("place.repoint")
                    up = self._chain_up(el["ref"])
                    if up:
                        el["ref"] = up
                    else:
                        drop.append(ptr)
                elif el.get("ref") in self.absent:
                    drop.append(ptr)
                    self.fired.add("private.reference.placeref_list")
        R.pointer_remove(obj, drop)

    def _ref_indexes(self, obj):
        """birth_ref_index and death_ref_index point at the same EventRef in the filtered event_ref_list, or -1 when it is gone."""
        ctx = self.birth_ctx.get(obj["handle"])
        if ctx is None:
            return
        refs = obj.get("event_ref_list")
        for key, element in zip(("birth_ref_index", "death_ref_index"), ctx):
            if element is None:
                continue
            idx = next((i for i, e in enumerate(R._list(refs)) if e is element), -1)
            obj[key] = idx

    # ---------------------------------------------------------------- run
    def run(self):
        pol = self.pol
        self._classify()
        for o in self.objs:
            h = o["handle"]
            if h in self.excluded:
                continue
            obj = copy.deepcopy(o)
            for k in ("change",):
                obj.pop(k, None)
            if obj["_class"] == "Person":
                refs = R._list(obj.get("event_ref_list"))
                els = []
                for key in ("birth_ref_index", "death_ref_index"):
                    i = obj.get(key)
                    els.append(refs[i] if R._int(i) and 0 <= i < len(refs) else None)
                self.birth_ctx[h] = tuple(els)
            self.removed[h] = self._private_elements(obj)
            self._fields(obj, self.base.get(h))
            self.proj[h] = obj
        self._scan()
        self.absent = set(self.excluded)
        for h in list(self.held_whole) + sorted(self.new_holds):
            if h not in self.base:
                self.absent.add(h)
        for h, rule_ids in self.held_whole.items():
            for rid in rule_ids:
                self.holds.append({"handle": h, "rule": rid, "scope": "object", "pointer": ""})
        self._orphans()
        for h, obj in self.proj.items():
            if h not in self.absent:
                self._references(obj)
                if obj["_class"] == "Person":
                    self._ref_indexes(obj)

        projected = {}
        for o in self.objs:
            h = o["handle"]
            if h in self.excluded or h in self.absent:
                projected[h] = None
            elif h in self.held_whole or h in self.new_holds:
                projected[h] = copy.deepcopy(self.base[h])
            else:
                projected[h] = self.proj[h]
        holds = [x for x in self.holds if x["handle"] not in self.excluded]
        holds.sort(key=lambda x: (x["handle"], x["rule"], x["pointer"], x["scope"]))
        self.fired.update(x["rule"] for x in holds)
        self.fired.update(self.excluded.values())
        excluded = [{"handle": h, "rule": r} for h, r in sorted(self.excluded.items())]
        withdrawn = sorted(h for h in self.excluded if h in self.base)
        return Projection(projected, holds, excluded, withdrawn, sorted(self.fired), frozenset(self.sticky_out))


def _revert_pointer(pointer):
    """A Note's text is one atomic field: holding it keeps the base tags too."""
    return "/text" if pointer == "/text/string" else pointer
