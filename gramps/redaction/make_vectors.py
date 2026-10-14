#!/usr/bin/env python3
"""Generator of the golden vectors of redaction policy v1 (task redaction-policy-v1). Standard library only.

    python3 gramps/redaction/make_vectors.py           # rewrite gramps/redaction/vectors/*.json
    python3 gramps/redaction/make_vectors.py --check   # byte comparison, writes nothing

Every vector is {id, title, rules, context, input, expected}. ``input`` is a list of partial Gramps ``json_data`` objects
(every nested element carries its ``_class``; a missing key means the Gramps default). ``expected`` holds, written by hand
here and never produced by the code under test:

    projection  {handle: object or null}   what the cloud receives; null = excluded, or held and never synced
    excluded    [{handle, rule}]           objects the rules drop
    holds       [{handle, rule, scope, pointer}]   scope "object" or "field"; the preview says why
    server      {ok, violations: [{rule, handle, pointer}]}   the server validator's verdict on ``input`` as submitted
    birth_like  [handle]                   (optional) the events isBirthLike must accept; every other Event must be refused

``rules`` names the rule ids the vector exercises; the unit test checks that the oracle fires each of them on the input and
that every rule id is named at least once. The projection of an input must itself pass the server (``ok``), and projecting it
again must change nothing (sync.md 5.6).

Every value is fictional: phones are 555-01xx, mail is example.org, names are invented, dates are made up.
"""
import copy
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "vectors")

# ----------------------------------------------------------------------------------------------------------------------
# Constants (Gramps 6.0 enum values).

BIRTH, DEATH, ADULT_CHRISTEN, BAPTISM, BLESS, CHRISTEN, STILLBIRTH = 12, 13, 14, 15, 18, 22, 45
MARRIAGE, BURIAL, RESIDENCE, CUSTOM_EV = 1, 19, 29, 0
NAME_BIRTH, NAME_MARRIED = 2, 3
ATTR_CUSTOM, ATTR_ID, ATTR_SSN, ATTR_AGE, ATTR_FATHER_AGE, ATTR_MOTHER_AGE, ATTR_TIME = 0, 3, 6, 10, 11, 12, 14
PL_CUSTOM, PL_COUNTRY, PL_STATE, PL_COUNTY, PL_CITY, PL_PARISH, PL_LOCALITY, PL_STREET = 0, 1, 2, 3, 4, 5, 6, 7
PL_PROVINCE, PL_REGION, PL_DEPARTMENT, PL_TOWN, PL_VILLAGE, PL_FARM, PL_BUILDING, PL_NUMBER = 8, 9, 10, 15, 16, 18, 19, 20
URL_EMAIL, URL_WEB_HOME, URL_WEB_SEARCH = 1, 2, 3
NONE, BEFORE, AFTER, ABOUT, RANGE, SPAN, TEXTONLY = 0, 1, 2, 3, 4, 5, 6


def jdn_gregorian(y, m, d):
    """Julian day number of a Gregorian date, from the standard library (independent of the code under test)."""
    return datetime.date(y, m, d).toordinal() + 1721425


def jdn_julian(y, m, d):
    """Julian day number of a Julian-calendar date (Wikipedia's integer formula; independent of the code under test)."""
    def tdiv(a, b):
        q = abs(a) // abs(b)
        return q if (a >= 0) == (b > 0) else -q
    return 367 * y - tdiv(7 * (y + 5001 + tdiv(m - 9, 7)), 4) + tdiv(275 * m, 9) + d + 1729777


assert jdn_gregorian(2000, 1, 1) == 2451545 and jdn_julian(1900, 1, 1) == 2415033 and jdn_gregorian(1900, 1, 1) == 2415021


def sort_value(cal, y, m, d):
    if not (y or m or d):
        return 0
    y, m, d = y or 1, m or 1, d or 1
    if cal == 0:
        return jdn_gregorian(y, m, d)
    if cal == 1:
        return jdn_julian(y, m, d)
    return 2400000 + y  # another calendar: any non-zero number; the projection must replace it by 0


# ----------------------------------------------------------------------------------------------------------------------
# Builders. Every builder lists the keys the rules touch, so an unchanged object compares equal.


def DATE(d=0, m=0, y=0, mod=NONE, text="", cal=0, q=0, second=None, slash=False):
    dv = [d, m, y, slash]
    if second:
        dv += [second[0], second[1], second[2], False]
    first = sort_value(cal, y, m, d)
    return {"_class": "Date", "calendar": cal, "dateval": dv, "format": None, "modifier": mod, "newyear": 0,
            "quality": q, "sortval": first, "text": text}


def DY(y, mod=NONE, cal=0, q=0, second_year=None, slash=False, keep_zero_sort=False):
    """A reduced date: year only (and a second year), text empty, sortval = day number of January 1."""
    dv = [0, 0, y, slash]
    if second_year is not None:
        dv += [0, 0, second_year, False]
    sv = 0 if (not y or cal not in (0, 1)) else sort_value(cal, y, 1, 1)
    return {"_class": "Date", "calendar": cal, "dateval": dv, "format": None, "modifier": mod, "newyear": 0,
            "quality": q, "sortval": sv, "text": ""}


EMPTY = DATE()


def TYPE(cls, value, string=""):
    return {"_class": cls, "string": string, "value": value}


def ER(ref, role=1, private=False, attrs=(), cites=()):
    return {"_class": "EventRef", "attribute_list": list(attrs), "citation_list": list(cites), "note_list": [],
            "private": private, "ref": ref, "role": TYPE("EventRoleType", role)}


def MR(ref, rect=None, private=False, attrs=(), cites=()):
    return {"_class": "MediaRef", "attribute_list": list(attrs), "citation_list": list(cites), "note_list": [],
            "private": private, "ref": ref, "rect": rect}


def ATTR(t, value="", string="", private=False):
    return {"_class": "Attribute", "citation_list": [], "note_list": [], "private": private, "type": TYPE("AttributeType", t, string),
            "value": value}


def SATTR(string="Custom", value="", private=False):
    return {"_class": "SrcAttribute", "private": private, "type": TYPE("SrcAttributeType", 0, string), "value": value}


def NAME(first="Alder", sur="Testwood", t=NAME_BIRTH, date=None, private=False, **kw):
    n = {"_class": "Name", "call": "", "citation_list": [], "date": date or DATE(), "famnick": "", "first_name": first, "nick": "",
         "note_list": [], "private": private, "suffix": "", "surname_list": [{"_class": "Surname", "primary": True, "surname": sur}],
         "title": "", "type": TYPE("NameType", t)}
    n.update(kw)
    return n


def URL(path, t=URL_WEB_HOME, desc="", private=False):
    return {"_class": "Url", "desc": desc, "path": path, "private": private, "type": TYPE("UrlType", t)}


def ADDR(street="12 Fixture Lane", private=False):
    return {"_class": "Address", "city": "Fixtureland", "country": "", "county": "", "date": DATE(), "locality": "", "phone": "",
            "postal": "", "private": private, "state": "", "street": street}


def LDS(private=False):
    return {"_class": "LdsOrd", "date": DATE(), "private": private, "type": 0}


def PREF(ref, rel="friend", private=False):
    return {"_class": "PersonRef", "citation_list": [], "note_list": [], "private": private, "ref": ref, "rel": rel}


def PLREF(ref):
    return {"_class": "PlaceRef", "date": DATE(), "ref": ref}


def LOC(**kw):
    d = {"_class": "Location", "city": "", "country": "", "county": "", "locality": "", "parish": "", "phone": "", "postal": "",
         "state": "", "street": ""}
    d.update(kw)
    return d


def CHREF(ref, private=False):
    return {"_class": "ChildRef", "citation_list": [], "frel": TYPE("ChildRefType", 1), "mrel": TYPE("ChildRefType", 1),
            "note_list": [], "private": private, "ref": ref}


def REPOREF(ref, private=False):
    return {"_class": "RepoRef", "call_number": "", "media_type": TYPE("SourceMediaType", 0), "note_list": [], "private": private,
            "ref": ref}


def EV(h, t=BIRTH, date=None, s="", cit=(), media=(), desc="", place="", private=False, attrs=(), notes=()):
    return {"_class": "Event", "attribute_list": list(attrs), "citation_list": list(cit), "date": date or EMPTY, "description": desc,
            "handle": h, "media_list": [MR(m) if isinstance(m, str) else m for m in media], "note_list": list(notes), "place": place,
            "private": private, "type": TYPE("EventType", t, s)}


def PE(h, evs=(), birth=-1, death=-1, first="Alder", sur="Testwood", private=False, **kw):
    p = {"_class": "Person", "address_list": [], "alternate_names": [], "attribute_list": [], "birth_ref_index": birth,
         "citation_list": [], "death_ref_index": death, "event_ref_list": [ER(e) if isinstance(e, str) else e for e in evs],
         "family_list": [], "handle": h, "lds_ord_list": [], "media_list": [], "note_list": [], "parent_family_list": [],
         "person_ref_list": [], "primary_name": NAME(first, sur), "private": private, "urls": []}
    p.update(kw)
    return p


def FA(h, father=None, mother=None, children=(), evs=(), private=False, **kw):
    f = {"_class": "Family", "attribute_list": [], "child_ref_list": [CHREF(c) if isinstance(c, str) else c for c in children],
         "citation_list": [], "event_ref_list": [ER(e) if isinstance(e, str) else e for e in evs], "father_handle": father,
         "handle": h, "media_list": [], "mother_handle": mother, "note_list": [], "private": private}
    f.update(kw)
    return f


def PL(h, name="Fixtureland", t=PL_CITY, ts="", code="", lat="", long="", parent=None, private=False, **kw):
    p = {"_class": "Place", "alt_loc": [], "code": code, "citation_list": [], "handle": h, "lat": lat, "long": long, "media_list": [],
         "name": {"_class": "PlaceName", "lang": "", "value": name}, "note_list": [],
         "place_type": TYPE("PlaceType", t, ts), "placeref_list": [PLREF(parent)] if parent else [], "private": private,
         "title": "", "urls": []}
    p.update(kw)
    return p


def SRC(h, title="Fixture Source", private=False, **kw):
    s = {"_class": "Source", "abbrev": "", "attribute_list": [], "author": "", "handle": h, "media_list": [], "note_list": [],
         "private": private, "pubinfo": "", "reporef_list": [], "title": title}
    s.update(kw)
    return s


def CIT(h, source="s1", page="", date=None, private=False, **kw):
    c = {"_class": "Citation", "attribute_list": [], "date": date or EMPTY, "handle": h, "media_list": [], "note_list": [],
         "page": page, "private": private, "source_handle": source}
    c.update(kw)
    return c


def REPO(h, name="Fixture Archive", private=False, **kw):
    r = {"_class": "Repository", "address_list": [], "handle": h, "name": name, "note_list": [], "private": private, "urls": []}
    r.update(kw)
    return r


def MED(h, mime="image/jpeg", path="media/synthetic.jpg", checksum="0" * 32, desc="", private=False, **kw):
    m = {"_class": "Media", "attribute_list": [], "checksum": checksum, "date": EMPTY, "desc": desc, "handle": h, "mime": mime,
         "path": path, "private": private, "citation_list": [], "note_list": []}
    m.update(kw)
    return m


def NOTE(h, text="", tags=(), private=False):
    return {"_class": "Note", "handle": h, "private": private,
            "text": {"_class": "StyledText", "string": text, "tags": list(tags)}}


def TAG(h, name="Fixture"):
    return {"_class": "Tag", "handle": h, "name": name}


def RESEARCHER(h):
    return {"_class": "Researcher", "handle": h, "name": "Example Researcher", "email": "researcher@example.org", "phone": "555-0100"}


def C(o, **patch):
    """A copy of an object with top-level keys replaced (for expected values)."""
    d = copy.deepcopy(o)
    d.update(patch)
    return d


def V(rule, handle, pointer):
    return {"rule": rule, "handle": handle, "pointer": pointer}


def X(handle, rule):
    return {"handle": handle, "rule": rule}


def H(handle, rule, scope, pointer=""):
    return {"handle": handle, "rule": rule, "scope": scope, "pointer": pointer}


def SAME(*objs):
    return {o["handle"]: copy.deepcopy(o) for o in objs}


VECTORS = {}  # group -> [vector]


def vec(group, vid, title, rules, inp, projection, excluded=(), holds=(), server=(), context=None, birth_like=None):
    for g in VECTORS.values():
        assert all(v["id"] != vid for v in g), vid
    handles = [o["handle"] for o in inp]
    assert sorted(projection) == sorted(handles), (vid, sorted(projection), sorted(handles))
    exp = {"projection": projection, "excluded": sorted(excluded, key=lambda x: (x["handle"], x["rule"])),
           "holds": sorted(holds, key=lambda x: (x["handle"], x["rule"], x["pointer"], x["scope"])),
           "server": {"ok": not server, "violations": sorted(server, key=lambda v: (v["handle"], v["rule"], v["pointer"]))}}
    if birth_like is not None:
        exp["birth_like"] = sorted(birth_like)
    VECTORS.setdefault(group, []).append({"id": vid, "title": title, "rules": sorted(rules), "context": context or {},
                                          "input": copy.deepcopy(inp), "expected": exp})


# ======================================================================================================================
# BIRTH: the one predicate, for every type, living and deceased.


def birth_type_vector(vid, title, etype, deceased=False, extra_rules=()):
    ev = EV("ev1", etype, DATE(5, 3, 1900))
    evs, death = [ev], None
    inp = [ev]
    if deceased:
        d = EV("ev2", DEATH, DATE(12, 11, 1970))
        evs.append(d)
        inp.append(d)
    p = PE("p1", [e["handle"] for e in evs], birth=0 if etype == BIRTH else -1, death=1 if deceased else -1)
    inp.append(p)
    out = {"ev1": C(ev, date=DY(1900))}
    if deceased:
        out["ev2"] = copy.deepcopy(inp[1])
    out["p1"] = copy.deepcopy(p)
    viol = [V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")]
    vec("birth", vid, title, ["birth.date.daymonth", "birth.date.sortval"] + list(extra_rules), inp, out, server=viol, birth_like=["ev1"])


birth_type_vector("birth.type.birth_12", "Birth with a full date, person alive: day and month removed", BIRTH)
birth_type_vector("birth.type.birth_12_deceased", "Birth with a full date, person deceased: the same (living or deceased)", BIRTH, deceased=True)
birth_type_vector("birth.type.adult_christening_14", "Adult Christening 14 is birth-like", ADULT_CHRISTEN)
birth_type_vector("birth.type.baptism_15_deceased", "Baptism 15 of a deceased person is birth-like", BAPTISM, deceased=True)
birth_type_vector("birth.type.bless_18", "Bless 18 is birth-like", BLESS)
birth_type_vector("birth.type.christen_22", "Christen 22 is birth-like", CHRISTEN)
birth_type_vector("birth.type.stillbirth_45", "Stillbirth 45 is birth-like", STILLBIRTH)

# custom types
custom = [("c1", "Birth Registration", True), ("c2", "Taufe und Geburt", True), ("c3", "NAISSANCE", True), ("c4", "Acta de Nacimiento", True),
          ("c5", "Baptism record", True), ("c6", "Christened at home", True), ("c7", "Residence", False), ("c8", "Census", False),
          ("c9", "Graduation", False), ("c10", "", False),
          ("c11", "Birthright Quaker", True), ("c12", "Baptist church visit", True)]  # a substring match over-matches: both are held back (fail closed)
evs = [EV(h, CUSTOM_EV, DATE(2, 6, 1880) if like else DATE(3, 7, 1881), s=s) for h, s, like in custom]
p = PE("p1", [e["handle"] for e in evs])
out = {e["handle"]: (C(e, date=DY(1880)) if like else copy.deepcopy(e)) for e, (_, _, like) in zip(evs, custom)}
out["p1"] = copy.deepcopy(p)
viol = []
for h, s, like in custom:
    if like:
        viol += [V("birth.date.daymonth", h, "/date/dateval/0"), V("birth.date.daymonth", h, "/date/dateval/1")]
vec("birth", "birth.type.custom_pattern", "Custom event types: the birth pattern is a case-insensitive substring match; other custom types keep their dates",
    ["birth.date.daymonth", "birth.date.sortval"], evs + [p], out, server=viol, birth_like=[h for h, _, like in custom if like])

# standard non-birth types keep everything
evs = [EV("n1", DEATH, DATE(1, 2, 1960)), EV("n2", MARRIAGE, DATE(3, 4, 1920)), EV("n3", BURIAL, DATE(5, 6, 1960)),
       EV("n4", RESIDENCE, DATE(7, 8, 1930))]
p = PE("p1", [e["handle"] for e in evs], death=0)
vec("birth", "birth.type.non_birth_kept", "Death, Marriage, Burial and Residence are not birth-like: their dates are stored whole",
    [], evs + [p], SAME(*evs, p), birth_like=[])

# birth_ref fallbacks
ev = EV("ev1", RESIDENCE, DATE(9, 10, 1905))
other = EV("ev2", RESIDENCE, DATE(1, 1, 1906))
p = PE("p1", ["ev1", "ev2"], birth=0)
vec("birth", "birth.ref.birth_ref_fallback", "An event at a person's birth_ref_index is birth-like whatever its type (a Birth retyped to Residence)",
    ["birth.date.daymonth", "birth.date.sortval"], [ev, other, p], {"ev1": C(ev, date=DY(1905)), "ev2": copy.deepcopy(other), "p1": copy.deepcopy(p)},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

ev = EV("ev1", RESIDENCE, DATE(9, 10, 1905))
p1 = PE("p1", ["ev1"], birth=7)
p2 = PE("p2", ["ev1"], birth=-1)
vec("birth", "birth.ref.index_out_of_range", "A birth_ref_index of -1 or beyond the list points at nothing: no event becomes birth-like",
    [], [ev, p1, p2], SAME(ev, p1, p2), birth_like=[])

ev = EV("ev1", RESIDENCE, DATE(9, 10, 1905))
pa = PE("p1", ["ev1"], birth=0, first="Alder")
pb = PE("p2", ["ev1"], birth=-1, first="Birch")
vec("birth", "birth.ref.any_person", "An event shared by two persons is birth-like when any person has it at birth_ref_index",
    ["birth.date.daymonth", "birth.date.sortval"], [ev, pa, pb], {"ev1": C(ev, date=DY(1905)), "p1": copy.deepcopy(pa), "p2": copy.deepcopy(pb)},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

ev = EV("ev1", BIRTH, DATE(9, 10, 1905))
p = PE("p1", ["ev1"], birth=0)
vec("birth", "birth.type.birth_without_person", "A Birth event no person references is still birth-like by its type",
    ["birth.date.daymonth", "birth.date.sortval"], [ev], {"ev1": C(ev, date=DY(1905))},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

# date shapes
def date_vector(vid, title, din, dout, viol_pointers, etype=BIRTH, rules=("birth.date.daymonth", "birth.date.sortval"), viol_rules=None):
    ev = EV("ev1", etype, din)
    p = PE("p1", ["ev1"], birth=0)
    viol = [V(viol_rules.get(ptr, "birth.date.daymonth") if viol_rules else "birth.date.daymonth", "ev1", ptr) for ptr in viol_pointers]
    vec("birth", vid, title, list(rules), [ev, p], {"ev1": C(ev, date=dout), "p1": copy.deepcopy(p)}, server=viol, birth_like=["ev1"])


date_vector("birth.date.range", "RANGE: the second day and month (dateval 4 and 5) go too",
            DATE(5, 3, 1900, mod=RANGE, second=(20, 4, 1901)), DY(1900, mod=RANGE, second_year=1901),
            ["/date/dateval/0", "/date/dateval/1", "/date/dateval/4", "/date/dateval/5"])
date_vector("birth.date.span", "SPAN: the second day and month go too, the modifier stays",
            DATE(0, 0, 1900, mod=SPAN, second=(20, 4, 1902)), DY(1900, mod=SPAN, second_year=1902),
            ["/date/dateval/4", "/date/dateval/5"], rules=("birth.date.daymonth",))
date_vector("birth.date.range_second_day_only", "RANGE with a day in the second half only is still refused",
            DATE(0, 0, 1900, mod=RANGE, second=(20, 0, 1901)), DY(1900, mod=RANGE, second_year=1901), ["/date/dateval/4"],
            rules=("birth.date.daymonth",))
date_vector("birth.date.textonly_year", "TEXTONLY: becomes a plain date with the first four-digit year of its text",
            DATE(0, 0, 0, mod=TEXTONLY, text="born March 5th 1900 at the farm"), DY(1900),
            ["/date/text", "/date/modifier"], rules=("birth.date.sortval", "birth.date.text", "birth.date.textonly"),
            viol_rules={"/date/text": "birth.date.text", "/date/modifier": "birth.date.textonly"})
date_vector("birth.date.textonly_no_year", "TEXTONLY with no four-digit year becomes an empty date",
            DATE(0, 0, 0, mod=TEXTONLY, text="in the spring"), DY(0), ["/date/text", "/date/modifier"], rules=("birth.date.text", "birth.date.textonly"),
            viol_rules={"/date/text": "birth.date.text", "/date/modifier": "birth.date.textonly"})
date_vector("birth.date.textonly_bare_year", "TEXTONLY whose text is a bare year passes the text check but is still refused as TEXTONLY",
            DATE(0, 0, 0, mod=TEXTONLY, text="1900"), DY(1900), ["/date/modifier"], rules=("birth.date.textonly",),
            viol_rules={"/date/modifier": "birth.date.textonly"})
date_vector("birth.date.text_non_year", "The text of a plain date is cleared; the server refuses any text other than a bare year",
            DATE(5, 3, 1900, text="5 March 1900"), DY(1900), ["/date/dateval/0", "/date/dateval/1", "/date/text"],
            rules=("birth.date.daymonth", "birth.date.sortval", "birth.date.text"), viol_rules={"/date/text": "birth.date.text"})
date_vector("birth.date.about_keeps_modifier", "ABOUT with a full date: the modifier and quality stay, day and month go",
            DATE(5, 3, 1900, mod=ABOUT, q=1), DY(1900, mod=ABOUT, q=1), ["/date/dateval/0", "/date/dateval/1"])
date_vector("birth.date.before_month_only", "BEFORE with a month and no day: the month goes",
            DATE(0, 3, 1900, mod=BEFORE), DY(1900, mod=BEFORE), ["/date/dateval/1"])
date_vector("birth.date.slash_flag", "A dual-year (slash) date keeps its flag",
            DATE(5, 3, 1900, slash=True), DY(1900, slash=True), ["/date/dateval/0", "/date/dateval/1"])
date_vector("birth.date.julian_calendar", "A Julian date is reduced with the Julian day number of January 1",
            DATE(5, 3, 1700, cal=1), DY(1700, cal=1), ["/date/dateval/0", "/date/dateval/1"])
date_vector("birth.date.other_calendar", "A date in another calendar gets sortval 0",
            DATE(5, 3, 5660, cal=2), DY(5660, cal=2), ["/date/dateval/0", "/date/dateval/1"])
date_vector("birth.date.year_zero", "Day and month with no year: reduced to an empty date",
            DATE(5, 3, 0), DY(0), ["/date/dateval/0", "/date/dateval/1"])
date_vector("birth.date.year_only_unchanged", "A year-only date is already reduced and does not change",
            DY(1900), DY(1900), [], rules=())

# ======================================================================================================================
# BIRTH: citations, names, exact DOB, sticky, attributes, LDS.

ev = EV("ev1", BIRTH, DATE(5, 3, 1900), cit=["c1"])
c1 = CIT("c1", page="p. 4", date=DATE(7, 4, 1900))
c2 = CIT("c2", page="p. 9", date=DATE(8, 5, 1960))
dv = EV("ev2", DEATH, DATE(1, 1, 1960), cit=["c2"])
p = PE("p1", ["ev1", "ev2"], birth=0, death=1)
s1 = SRC("s1")
vec("birth", "birth.citation.event_citation", "A citation of a birth-like event loses its day and month; a citation of a death keeps its date",
    ["birth.citation.date", "birth.date.daymonth", "birth.date.sortval"], [ev, dv, c1, c2, s1, p],
    {"ev1": C(ev, date=DY(1900)), "ev2": copy.deepcopy(dv), "c1": C(c1, date=DY(1900)), "c2": copy.deepcopy(c2),
     "s1": copy.deepcopy(s1), "p1": copy.deepcopy(p)},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1"),
            V("birth.citation.date", "c1", "/date/dateval/0"), V("birth.citation.date", "c1", "/date/dateval/1")],
    birth_like=["ev1"])
# the date of c1 is 1900-04-07 and not the birth date: only the citation rule reduces it

ev = EV("ev1", BAPTISM, DATE(0, 0, 1900))
c1 = CIT("c1", date=DATE(7, 4, 1900, text="7 April 1900"))
s1 = SRC("s1")
p = PE("p1", [ER("ev1", cites=["c1"])], birth=-1)
vec("birth", "birth.citation.eventref_citation", "A citation reached only through the EventRef of a birth-like event is reduced too, text included",
    ["birth.citation.date"], [ev, c1, s1, p],
    {"ev1": copy.deepcopy(ev), "c1": C(c1, date=DY(1900)), "s1": copy.deepcopy(s1), "p1": copy.deepcopy(p)},
    server=[V("birth.citation.date", "c1", "/date/dateval/0"), V("birth.citation.date", "c1", "/date/dateval/1"),
            V("birth.citation.date", "c1", "/date/text")],
    birth_like=["ev1"])

c1 = CIT("c1", date=DATE(7, 4, 1900))
s1 = SRC("s1")
ev = EV("ev1", MARRIAGE, DATE(7, 4, 1920), cit=["c1"])
f = FA("f1", evs=["ev1"])
vec("birth", "birth.citation.non_birth_kept", "A citation of a marriage keeps its date", [], [ev, c1, s1, f], SAME(ev, c1, s1, f), birth_like=[])

birth = EV("ev1", BIRTH, DATE(5, 3, 1900))
p = PE("p1", ["ev1"], birth=0, primary_name=NAME("Alder", "Testwood", NAME_BIRTH, DATE(5, 3, 1900, text="March 5")),
       alternate_names=[NAME("Alder", "Oakfield", NAME_BIRTH, DATE(6, 4, 1901)), NAME("Alder", "Marsh", NAME_MARRIED, DATE(1, 6, 1925)),
                        NAME("Alder", "Lane", 1, DATE(2, 7, 1930))])
pn = C(p, primary_name=NAME("Alder", "Testwood", NAME_BIRTH, DY(1900)),
       alternate_names=[NAME("Alder", "Oakfield", NAME_BIRTH, DY(1901)), p["alternate_names"][1], p["alternate_names"][2]])
vec("birth", "birth.name.date", "The date of a name of type Birth loses day, month and text; a married name or an AKA keeps its date",
    ["birth.name.date", "birth.date.daymonth", "birth.date.sortval"], [birth, p],
    {"ev1": C(birth, date=DY(1900)), "p1": pn},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1"),
            V("birth.name.date", "p1", "/primary_name/date/dateval/0"), V("birth.name.date", "p1", "/primary_name/date/dateval/1"),
            V("birth.name.date", "p1", "/primary_name/date/text"),
            V("birth.name.date", "p1", "/alternate_names/0/date/dateval/0"), V("birth.name.date", "p1", "/alternate_names/0/date/dateval/1")],
    birth_like=["ev1"])

# exact DOB: a non-birth date on the same day, of any class, is reduced as if birth-like
birth = EV("ev1", BIRTH, DATE(5, 3, 1900))
res = EV("ev2", RESIDENCE, DATE(5, 3, 1900), desc="lived in town")
res_other = EV("ev3", RESIDENCE, DATE(6, 3, 1900))
cit = CIT("c1", date=DATE(5, 3, 1900))
src = SRC("s1")
med = MED("m1", mime="image/png", date=DATE(5, 3, 1900))
mar = NAME("Alder", "Marsh", NAME_MARRIED, DATE(5, 3, 1900))
p = PE("p1", ["ev1", "ev2", "ev3"], birth=0, alternate_names=[mar], attribute_list=[ATTR(ATTR_CUSTOM, "Nickname", "Hobby")], media_list=[MR("m1")],
       citation_list=["c1"])
q = PE("p2", [ER("ev3")], first="Birch", attribute_list=[])
pn = C(p, alternate_names=[NAME("Alder", "Marsh", NAME_MARRIED, DY(1900))])
vec("birth", "birth.dob_exact.date", "Any Date of any class equal to a local full birth date is reduced: event, citation, media, married name; a date one day off is kept",
    ["birth.dob_exact.date"], [birth, res, res_other, cit, src, med, p, q],
    {"ev1": C(birth, date=DY(1900)), "ev2": C(res, date=DY(1900)), "ev3": copy.deepcopy(res_other), "c1": C(cit, date=DY(1900)),
     "s1": copy.deepcopy(src), "m1": C(med, date=DY(1900), path=""), "p1": pn, "p2": copy.deepcopy(q)},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

# a different person's birth date matches too
b1 = EV("ev1", BIRTH, DATE(5, 3, 1900))
other = EV("ev2", MARRIAGE, DATE(5, 3, 1900))
p1 = PE("p1", ["ev1"], birth=0)
f = FA("f1", evs=["ev2"])
vec("birth", "birth.dob_exact.other_person", "A family event on a date that is some person's birth date is reduced (other people's objects included)",
    ["birth.dob_exact.date"], [b1, other, p1, f],
    {"ev1": C(b1, date=DY(1900)), "ev2": C(other, date=DY(1900)), "p1": copy.deepcopy(p1), "f1": copy.deepcopy(f)},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

# sticky
res = EV("ev1", RESIDENCE, DATE(9, 10, 1905))
res2 = EV("ev2", RESIDENCE, DATE(1, 2, 1906))
p = PE("p1", ["ev1", "ev2"], birth=-1)
vec("birth", "birth.sticky", "An event that was birth-like at a synced base keeps day and month local after a retype, until io releases it",
    ["birth.sticky"], [res, res2, p], {"ev1": C(res, date=DY(1905)), "ev2": copy.deepcopy(res2), "p1": copy.deepcopy(p)},
    context={"sticky": ["ev1"]}, birth_like=[])

# attributes
ar = [ATTR(ATTR_AGE, "42"), ATTR(ATTR_FATHER_AGE, "40"), ATTR(ATTR_MOTHER_AGE, "30"), ATTR(ATTR_TIME, "08:30"), ATTR(ATTR_CUSTOM, "Hobby", "Pastime")]
keep = [ar[4]]
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), attrs=[ATTR(ATTR_AGE, "30"), ATTR(ATTR_CUSTOM, "Hobby", "Pastime")])
p = PE("p1", [ER("ev1", attrs=[ATTR(ATTR_TIME, "09:00"), ATTR(ATTR_CUSTOM, "Hobby", "Pastime")])], attribute_list=ar)
f = FA("f1", evs=[ER("ev1", attrs=[ATTR(ATTR_MOTHER_AGE, "28")])])
vec("birth", "birth.attribute.age_time", "AGE, FATHER_AGE, MOTHER_AGE and TIME attributes are local-only on persons, events and event references",
    ["birth.attribute.age_time"], [ev, p, f],
    {"ev1": C(ev, attribute_list=[ev["attribute_list"][1]]),
     "p1": C(p, attribute_list=keep, event_ref_list=[ER("ev1", attrs=[ATTR(ATTR_CUSTOM, "Hobby", "Pastime")])]),
     "f1": C(f, event_ref_list=[ER("ev1")])},
    server=[V("birth.attribute.age_time", "ev1", "/attribute_list/0"),
            V("birth.attribute.age_time", "p1", "/attribute_list/0"), V("birth.attribute.age_time", "p1", "/attribute_list/1"),
            V("birth.attribute.age_time", "p1", "/attribute_list/2"), V("birth.attribute.age_time", "p1", "/attribute_list/3"),
            V("birth.attribute.age_time", "p1", "/event_ref_list/0/attribute_list/0"),
            V("birth.attribute.age_time", "f1", "/event_ref_list/0/attribute_list/0")],
    birth_like=[])

p = PE("p1", lds_ord_list=[LDS(), LDS()])
vec("birth", "birth.lds_ord", "The whole LDS ordinance list is local-only", ["birth.lds_ord"], [p], {"p1": C(p, lds_ord_list=[])},
    server=[V("birth.lds_ord", "p1", "/lds_ord_list/0"), V("birth.lds_ord", "p1", "/lds_ord_list/1")])

# ======================================================================================================================
# CONTACT.

p = PE("p1", address_list=[ADDR("12 Fixture Lane"), ADDR("PO Box 5", private=True)])
r = REPO("r1", address_list=[ADDR("7 Example Road")])
vec("contact", "contact.address_list", "Every address of a person or a repository is local-only: the whole list",
    ["contact.address_list"], [p, r], {"p1": C(p, address_list=[]), "r1": C(r, address_list=[])},
    server=[V("contact.address_list", "p1", "/address_list/0"), V("contact.address_list", "p1", "/address_list/1"),
            V("contact.address_list", "r1", "/address_list/0"), V("private.element.address_list", "p1", "/address_list/1")])

keep_url = URL("https://example.org/search?q=testwood", URL_WEB_SEARCH, "Search")
p = PE("p1", urls=[URL("alder@example.org", URL_EMAIL), keep_url])
vec("contact", "contact.url.email_type", "A URL of type Email is local-only; a search URL stays",
    ["contact.url.email_type"], [p], {"p1": C(p, urls=[keep_url])},
    server=[V("contact.url.email_type", "p1", "/urls/0"), V("contact.url.scan_hit", "p1", "/urls/0"), V("scan.email", "p1", "/urls/0/path")])

urls = [URL("mailto:alder@example.org"), URL("tel:+1-555-555-0100"), URL("sms:+15555550101"), URL("https://wa.me/15555550102"),
        URL("https://chat.t.me/alder"), URL("https://www.instagram.com/m/alder"), URL("https://www.instagram.com/alder"),
        URL("https://example.org/profile/alder"), URL("https://notwa.me.example.org/x"), URL("https:\\\\wa.me\\15555550103")]
p = PE("p1", urls=urls)
vec("contact", "contact.url.channel", "Contact-channel schemes, hosts (and their subdomains) and Instagram message paths are local-only (a backslash reads as a slash); profile and look-alike hosts stay",
    ["contact.url.channel", "contact.url.scan_hit"], [p], {"p1": C(p, urls=[urls[6], urls[7], urls[8]])},
    server=[V("contact.url.channel", "p1", "/urls/%d" % i) for i in (0, 1, 2, 3, 4, 5, 9)] +
           [V("contact.url.scan_hit", "p1", "/urls/%d" % i) for i in (0, 1, 2, 3, 4, 5, 9)] +
           [V("scan.contact_url", "p1", "/urls/%d/path" % i) for i in (0, 1, 2, 3, 4, 5, 9)] +
           [V("scan.email", "p1", "/urls/0/path"), V("scan.phone", "p1", "/urls/1/path"), V("scan.phone", "p1", "/urls/2/path"),
            V("scan.phone", "p1", "/urls/9/path")])

u_keep = URL("https://example.org/about", URL_WEB_HOME, "Family page")
p = PE("p1", urls=[URL("https://example.org/about", URL_WEB_HOME, "Call me on 555-0123"), URL("https://example.org/call-555-0124", URL_WEB_HOME, ""), u_keep])
vec("contact", "contact.url.scan_hit", "A URL whose description or path has a phone number is local-only",
    ["contact.url.scan_hit"], [p], {"p1": C(p, urls=[u_keep])},
    server=[V("contact.url.scan_hit", "p1", "/urls/0"), V("contact.url.scan_hit", "p1", "/urls/1"),
            V("scan.phone", "p1", "/urls/0/desc"), V("scan.phone", "p1", "/urls/1/path")])

pl = PL("pl1", urls=[URL("alder@example.org", URL_EMAIL), URL("https://example.org/place", URL_WEB_HOME)])
r = REPO("r1", urls=[URL("mailto:archive@example.org", URL_EMAIL), URL("https://example.org/archive", URL_WEB_HOME)])
vec("contact", "contact.url.place_and_repository", "The URL rules apply to places and repositories as well",
    ["contact.url.email_type", "contact.url.channel"], [pl, r],
    {"pl1": C(pl, urls=[pl["urls"][1]]), "r1": C(r, urls=[r["urls"][1]])},
    server=[V("contact.url.email_type", "pl1", "/urls/0"), V("contact.url.scan_hit", "pl1", "/urls/0"), V("scan.email", "pl1", "/urls/0/path"),
            V("contact.url.email_type", "r1", "/urls/0"), V("contact.url.channel", "r1", "/urls/0"), V("contact.url.scan_hit", "r1", "/urls/0"),
            V("scan.contact_url", "r1", "/urls/0/path"), V("scan.email", "r1", "/urls/0/path")])

city = PL("pl2", name="Fixture City", t=PL_CITY,
          alt_loc=[LOC(street="12 Fixture Lane", locality="Old Quarter", postal="99999", phone="555-0110", city="Fixtureland"),
                   LOC(street="5 Example Road", phone="555-0111"), LOC(city="Elsewhere")])
vec("contact", "contact.alt_loc.fields", "Street, locality, postal and phone of an alternate location are blanked; an element left with nothing is removed",
    ["contact.alt_loc.fields", "contact.alt_loc.empty"], [city],
    {"pl2": C(city, alt_loc=[LOC(city="Fixtureland"), LOC(city="Elsewhere")])},
    server=[V("contact.alt_loc.fields", "pl2", "/alt_loc/0/street"), V("contact.alt_loc.fields", "pl2", "/alt_loc/0/locality"),
            V("contact.alt_loc.fields", "pl2", "/alt_loc/0/postal"), V("contact.alt_loc.fields", "pl2", "/alt_loc/0/phone"),
            V("contact.alt_loc.fields", "pl2", "/alt_loc/1/street"), V("contact.alt_loc.fields", "pl2", "/alt_loc/1/phone")])

p = PE("p1", attribute_list=[ATTR(ATTR_SSN, "SSN-FIXTURE-1"), ATTR(ATTR_ID, "FX-000"), ATTR(ATTR_CUSTOM, "Hobby", "Pastime")])
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), attrs=[ATTR(ATTR_ID, "FX-001")])
vec("contact", "contact.attribute.government_id", "SSN and ID attributes are local-only",
    ["contact.attribute.government_id"], [p, ev], {"p1": C(p, attribute_list=[p["attribute_list"][2]]), "ev1": C(ev, attribute_list=[])},
    server=[V("contact.attribute.government_id", "p1", "/attribute_list/0"), V("contact.attribute.government_id", "p1", "/attribute_list/1"),
            V("contact.attribute.government_id", "ev1", "/attribute_list/0")])

res = RESEARCHER("res1")
p = PE("p1")
vec("contact", "contact.researcher", "Researcher metadata is never read: it is not projected", ["contact.researcher"], [res, p],
    {"res1": None, "p1": copy.deepcopy(p)}, excluded=[X("res1", "contact.researcher")])

# ======================================================================================================================
# PLACES.

city = PL("pl1", name="Fixture City", t=PL_CITY)
st = PL("pl2", name="Example Road", t=PL_STREET, parent="pl1")
num = PL("pl3", name="12", t=PL_NUMBER, parent="pl2")
bld = PL("pl4", name="Fixture Hall", t=PL_BUILDING, parent="pl3")
e1 = EV("ev1", RESIDENCE, DATE(1, 1, 1930), place="pl4")
e2 = EV("ev2", RESIDENCE, DATE(1, 1, 1931), place="pl2")
vec("places", "place.exclude.type", "Street, Building and Number places are excluded; an event is re-pointed to the nearest kept ancestor",
    ["place.exclude.type", "place.repoint"], [city, st, num, bld, e1, e2],
    {"pl1": copy.deepcopy(city), "pl2": None, "pl3": None, "pl4": None, "ev1": C(e1, place="pl1"), "ev2": C(e2, place="pl1")},
    excluded=[X("pl2", "place.exclude.type"), X("pl3", "place.exclude.type"), X("pl4", "place.exclude.type")],
    server=[V("place.exclude.type", "pl2", "/place_type"), V("place.exclude.type", "pl3", "/place_type"), V("place.exclude.type", "pl4", "/place_type"),
            V("place.repoint", "ev1", "/place"), V("place.repoint", "ev2", "/place"),
            V("place.repoint", "pl3", "/placeref_list/0/ref"), V("place.repoint", "pl4", "/placeref_list/0/ref")])

county = PL("pl1", name="Fixture County", t=PL_COUNTY)
farm = PL("pl2", name="Hollow Farm", t=PL_FARM, parent="pl1")
field = PL("pl3", name="North Field", t=PL_LOCALITY, parent="pl2")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), place="pl2")
vec("places", "place.exclude.farm", "A Farm place (type 18) is excluded; a place under it is re-pointed to the county",
    ["place.exclude.type", "place.repoint"], [county, farm, field, ev],
    {"pl1": copy.deepcopy(county), "pl2": None, "pl3": C(field, placeref_list=[PLREF("pl1")]), "ev1": C(ev, place="pl1")},
    excluded=[X("pl2", "place.exclude.type")],
    server=[V("place.exclude.type", "pl2", "/place_type"), V("place.repoint", "pl3", "/placeref_list/0/ref"), V("place.repoint", "ev1", "/place")])

farm = PL("pl1", name="Lone Farm", t=PL_FARM)
child = PL("pl2", name="Back Lot", t=PL_LOCALITY, parent="pl1")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), place="pl1")
vec("places", "place.repoint.no_ancestor", "A top-level excluded place leaves no ancestor: the event place becomes empty and the child place loses its parent",
    ["place.exclude.type", "place.repoint"], [farm, child, ev],
    {"pl1": None, "pl2": C(child, placeref_list=[]), "ev1": C(ev, place="")}, excluded=[X("pl1", "place.exclude.type")],
    server=[V("place.exclude.type", "pl1", "/place_type"), V("place.repoint", "pl2", "/placeref_list/0/ref"), V("place.repoint", "ev1", "/place")])

hs = [("pl%d" % (i + 1), s) for i, s in enumerate(["Home", "My residence", "Apartment 4", "APT", "Lot 9", "farmstead", "Chapter House", "Address book", "House of Oak",
                                                                                                     "Chapter", "Charlotte", "Pilot", "Homestead District"])]
nots = [("pl%d" % (i + 20), s) for i, s in enumerate(["Plantation", "Campground", "Courtyard"])]
places = [PL(h, name=s, t=PL_CUSTOM, ts=s) for h, s in hs + nots]
places.append(PL("pl30", name="Homeville", t=PL_CITY, ts="Home"))
places.append(PL("pl31", name="Typed Home", t=PL_CUSTOM, ts=""))
out = {p["handle"]: (None if p["handle"] in {h for h, _ in hs} else copy.deepcopy(p)) for p in places}
vec("places", "place.exclude.custom_home_like", "Custom place types matching house|home|residence|address|apartment|apt|lot|farm are excluded (a substring match, so Chapter, Charlotte, Pilot and Homestead District are excluded too: it over-matches on purpose and fails closed); other types and non-custom types keep their place",
    ["place.exclude.custom_home_like"], places, out,
    excluded=[X(h, "place.exclude.custom_home_like") for h, _ in hs],
    server=[V("place.exclude.custom_home_like", h, "/place_type") for h, _ in hs])

city = PL("pl1", name="Fixture City", t=PL_CITY)
st = PL("pl2", name="Example Road", t=PL_STREET, parent="pl1")
priv = PL("pl3", name="Hidden Park", t=PL_LOCALITY, parent="pl1", private=True)
bld = PL("pl4", name="Fixture Hall", t=PL_BUILDING, parent="pl3")
unit = PL("pl5", name="Unit A", t=PL_LOCALITY, parent="pl4")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), place="pl5")
vec("places", "place.repoint.skips_private_ancestor", "Re-pointing climbs past an excluded building and a private place to the first kept ancestor",
    ["place.repoint", "place.exclude.type", "private.object.exclude"], [city, st, priv, bld, unit, ev],
    {"pl1": copy.deepcopy(city), "pl2": None, "pl3": None, "pl4": None, "pl5": C(unit, placeref_list=[PLREF("pl1")]), "ev1": C(ev, place="pl5")},
    excluded=[X("pl2", "place.exclude.type"), X("pl3", "private.object.exclude"), X("pl4", "place.exclude.type")],
    server=[V("place.exclude.type", "pl2", "/place_type"), V("private.object.exclude", "pl3", "/private"), V("place.exclude.type", "pl4", "/place_type"),
            V("place.repoint", "pl5", "/placeref_list/0/ref")])

codes = [(PL_COUNTRY, "US", True), (PL_STATE, "UT", True), (PL_COUNTY, "049", True), (PL_PROVINCE, "ON", True), (PL_REGION, "R1", True),
         (PL_DEPARTMENT, "75", True), (PL_CITY, "99999", False), (PL_TOWN, "99998", False), (PL_VILLAGE, "99997", False),
         (PL_LOCALITY, "99996", False), (PL_PARISH, "99995", False), (PL_CUSTOM, "99994", False)]
places = [PL("pl%d" % i, name="Place %d" % i, t=t, ts="Misc" if t == PL_CUSTOM else "", code=c) for i, (t, c, _) in enumerate(codes)]
out = {p["handle"]: (copy.deepcopy(p) if keep else C(p, code="")) for p, (_, _, keep) in zip(places, codes)}
vec("places", "place.code.local_only", "A place code stays only for Country, State, County, Province, Region and Department; below that it is local-only",
    ["place.code.local_only"], places, out,
    server=[V("place.code.local_only", p["handle"], "/code") for p, (_, _, keep) in zip(places, codes) if not keep])

coords = [("40.123456", "-111.987654", "40.12", "-111.99"), ("40.1", "-111.9", "40.1", "-111.9"), ("40.005", "-0.004", "40.01", "0.00"),
          ("12.995", "179.999999", "13.00", "180.00"), ("40°7'24.4\"N", "111W", "", ""), ("", "", "", ""), ("+40.126", "-0.005", "40.13", "-0.01")]
places = [PL("pl%d" % i, name="Place %d" % i, lat=a, long=b) for i, (a, b, _, _) in enumerate(coords)]
out = {p["handle"]: C(p, lat=c[2], long=c[3]) for p, c in zip(places, coords)}
viol = []
for p, c in zip(places, coords):
    if p["lat"] != c[2]:
        viol.append(V("place.coordinates.round", p["handle"], "/lat"))
    if p["long"] != c[3]:
        viol.append(V("place.coordinates.round", p["handle"], "/long"))
vec("places", "place.coordinates.round", "Latitude and longitude are rounded to 2 decimals, half away from zero; a value that is not a plain decimal is blanked",
    ["place.coordinates.round"], places, out, server=viol)

# ======================================================================================================================
# PRIVATE.

# objects, one class at a time
priv_p = PE("p1", private=True, first="Hazel")
fam = FA("f1", father="p1", mother="p2", children=["p3"])
mum = PE("p2", family_list=["f1"], first="Birch")
kid = PE("p3", parent_family_list=["f1"], first="Cedar")
mum["family_list"] = ["f1"]
priv_p["family_list"] = ["f1"]
vec("private", "private.object.person", "A private person is excluded; the family keeps its other parent and its children, and the father handle becomes null",
    ["private.object.exclude", "private.reference.parent_handles"], [priv_p, fam, mum, kid],
    {"p1": None, "f1": C(fam, father_handle=None), "p2": copy.deepcopy(mum), "p3": copy.deepcopy(kid)},
    excluded=[X("p1", "private.object.exclude")], server=[V("private.object.exclude", "p1", "/private")])

priv_f = FA("f1", father="p1", mother="p2", children=["p3"], private=True)
dad = PE("p1", family_list=["f1"])
mum = PE("p2", family_list=["f1"], first="Birch")
kid = PE("p3", parent_family_list=["f1"], first="Cedar")
vec("private", "private.object.family", "A private family is excluded; the persons stay and lose their family references",
    ["private.object.exclude", "private.reference.handle_lists"], [priv_f, dad, mum, kid],
    {"f1": None, "p1": C(dad, family_list=[]), "p2": C(mum, family_list=[]), "p3": C(kid, parent_family_list=[])},
    excluded=[X("f1", "private.object.exclude")], server=[V("private.object.exclude", "f1", "/private")])

ev_priv = EV("ev1", RESIDENCE, DATE(1, 1, 1930), private=True)
ev_pub = EV("ev2", RESIDENCE, DATE(1, 1, 1931))
p = PE("p1", ["ev1", "ev2"])
vec("private", "private.object.event", "A private event is excluded and its reference is removed from the person",
    ["private.object.exclude", "private.reference.element_refs"], [ev_priv, ev_pub, p],
    {"ev1": None, "ev2": copy.deepcopy(ev_pub), "p1": C(p, event_ref_list=[ER("ev2")])},
    excluded=[X("ev1", "private.object.exclude")], server=[V("private.object.exclude", "ev1", "/private")])

n_priv = NOTE("n1", "A private remark", private=True)
n_pub = NOTE("n2", "A public remark")
p = PE("p1", note_list=["n1", "n2"])
vec("private", "private.object.note", "A private note is excluded and removed from note_list", ["private.object.exclude", "private.reference.handle_lists"],
    [n_priv, n_pub, p], {"n1": None, "n2": copy.deepcopy(n_pub), "p1": C(p, note_list=["n2"])},
    excluded=[X("n1", "private.object.exclude")], server=[V("private.object.exclude", "n1", "/private")])

c_priv = CIT("c1", private=True)
c_pub = CIT("c2")
s = SRC("s1")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), cit=["c1", "c2"])
p = PE("p1", [ER("ev1", cites=["c1", "c2"])], citation_list=["c1", "c2"])
vec("private", "private.object.citation", "A private citation is excluded and removed from every citation_list, event references included",
    ["private.object.exclude", "private.reference.handle_lists"], [c_priv, c_pub, s, ev, p],
    {"c1": None, "c2": copy.deepcopy(c_pub), "s1": copy.deepcopy(s), "ev1": C(ev, citation_list=["c2"]),
     "p1": C(p, event_ref_list=[ER("ev1", cites=["c2"])], citation_list=["c2"])},
    excluded=[X("c1", "private.object.exclude")], server=[V("private.object.exclude", "c1", "/private")])

m_priv = MED("m1", private=True)
m_pub = MED("m2", path="media/synthetic-2.jpg")
p = PE("p1", media_list=[MR("m1"), MR("m2", [10, 10, 50, 50])])
vec("private", "private.object.media", "A private media object is excluded and its reference is removed",
    ["private.object.exclude", "private.reference.element_refs"], [m_priv, m_pub, p],
    {"m1": None, "m2": C(m_pub, path=""), "p1": C(p, media_list=[MR("m2", [10, 10, 50, 50])])},
    excluded=[X("m1", "private.object.exclude")], server=[V("private.object.exclude", "m1", "/private")])

repo_priv = REPO("r1", private=True)
repo_pub = REPO("r2")
s = SRC("s1", reporef_list=[REPOREF("r1"), REPOREF("r2")])
vec("private", "private.object.repository", "A private repository is excluded and the source loses that repository reference",
    ["private.object.exclude", "private.reference.element_refs"], [repo_priv, repo_pub, s],
    {"r1": None, "r2": copy.deepcopy(repo_pub), "s1": C(s, reporef_list=[REPOREF("r2")])},
    excluded=[X("r1", "private.object.exclude")], server=[V("private.object.exclude", "r1", "/private")])

src_priv = SRC("s1", private=True, title="Hidden Ledger")
c = CIT("c1", source="s1", page="p. 1")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), cit=["c1"])
p = PE("p1", ["ev1"])
vec("private", "private.source.cascade", "A citation of a private source is excluded with it (it cannot exist without its source), and its references are filtered",
    ["private.object.exclude", "private.citation.source_excluded", "private.reference.handle_lists"], [src_priv, c, ev, p],
    {"s1": None, "c1": None, "ev1": C(ev, citation_list=[]), "p1": copy.deepcopy(p)},
    excluded=[X("s1", "private.object.exclude"), X("c1", "private.citation.source_excluded")], server=[V("private.object.exclude", "s1", "/private")])

city = PL("pl1", name="Fixture City", t=PL_CITY)
priv_pl = PL("pl2", name="Hidden Park", t=PL_LOCALITY, parent="pl1", private=True)
under = PL("pl3", name="Back Gate", t=PL_LOCALITY, parent="pl2")
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), place="pl2")
vec("private", "private.object.place", "A private place is excluded; an event naming it gets no place and a place under it loses its parent link",
    ["private.object.exclude", "private.reference.event_place", "private.reference.placeref_list"], [city, priv_pl, under, ev],
    {"pl1": copy.deepcopy(city), "pl2": None, "pl3": C(under, placeref_list=[]), "ev1": C(ev, place="")},
    excluded=[X("pl2", "private.object.exclude")], server=[V("private.object.exclude", "pl2", "/private")])

# held persons
held = PE("p1", first="Hazel", primary_name=NAME("Hazel", "Testwood", NAME_BIRTH, private=True))
fam = FA("f1", father="p1", mother="p2", children=["p1"])
held["parent_family_list"] = ["f1"]
held["family_list"] = ["f1"]
mum = PE("p2", family_list=["f1"], first="Birch")
vec("private", "private.name.hold_person", "A new person whose primary name is private is held whole; the family forgets that parent and child",
    ["private.name.hold_person", "private.reference.parent_handles", "private.reference.element_refs"], [held, fam, mum],
    {"p1": None, "f1": C(fam, father_handle=None, child_ref_list=[]), "p2": copy.deepcopy(mum)},
    holds=[H("p1", "private.name.hold_person", "object")], server=[V("private.name.hold_person", "p1", "/primary_name/private")])

held = PE("p1", first="Hazel", primary_name=NAME("Hazel", "Testwood", NAME_BIRTH, private=True))
base = PE("p1", first="Hazel", primary_name=NAME("Hazel", "Testwood", NAME_BIRTH))
vec("private", "private.name.hold_person_synced", "A synced person who later gets a private primary name is held: the cloud keeps the last synced version",
    ["private.name.hold_person"], [held], {"p1": copy.deepcopy(base)}, holds=[H("p1", "private.name.hold_person", "object")],
    context={"base": {"p1": base}}, server=[V("private.name.hold_person", "p1", "/primary_name/private")])

# private elements
m_shared = MED("m1", path="media/s1.jpg")
m_other = MED("m2", path="media/s2.jpg")
kept_name = NAME("Alder", "Marsh", NAME_MARRIED)
p = PE("p1", alternate_names=[NAME("Alder", "Hidden", 1, private=True), kept_name],
       media_list=[MR("m1", private=True), MR("m2")],
       attribute_list=[ATTR(ATTR_CUSTOM, "Hobby", "Pastime", private=True), ATTR(ATTR_CUSTOM, "Pet", "Animal")],
       urls=[URL("https://example.org/a", private=True), URL("https://example.org/b")],
       address_list=[ADDR("1 Example Road", private=True), ADDR("2 Example Road")],
       lds_ord_list=[LDS(private=True), LDS()],
       person_ref_list=[PREF("p2", private=True), PREF("p2", "neighbor")])
q = PE("p2", media_list=[MR("m1")], first="Birch")
pn = C(p, alternate_names=[kept_name], media_list=[MR("m2")], attribute_list=[p["attribute_list"][1]], urls=[p["urls"][1]],
       address_list=[], lds_ord_list=[], person_ref_list=[PREF("p2", "neighbor")])
vec("private", "private.element.person_lists", "Private secondary elements of a person are removed: alternate name, media reference, attribute, URL, address, LDS ordinance and association",
    ["private.element.alternate_names", "private.element.media_list", "private.element.attribute_list", "private.element.urls",
     "private.element.address_list", "private.element.lds_ord_list", "private.element.person_ref_list", "contact.address_list", "birth.lds_ord"],
    [m_shared, m_other, p, q],
    {"m1": C(m_shared, path=""), "m2": C(m_other, path=""), "p1": pn, "p2": copy.deepcopy(q)},
    server=[V("private.element.alternate_names", "p1", "/alternate_names/0"), V("private.element.media_list", "p1", "/media_list/0"),
            V("private.element.attribute_list", "p1", "/attribute_list/0"), V("private.element.urls", "p1", "/urls/0"),
            V("private.element.address_list", "p1", "/address_list/0"), V("private.element.lds_ord_list", "p1", "/lds_ord_list/0"),
            V("private.element.person_ref_list", "p1", "/person_ref_list/0"),
            V("contact.address_list", "p1", "/address_list/0"), V("contact.address_list", "p1", "/address_list/1"),
            V("birth.lds_ord", "p1", "/lds_ord_list/0"), V("birth.lds_ord", "p1", "/lds_ord_list/1")])

ev_only = EV("ev1", RESIDENCE, DATE(1, 1, 1930), desc="moved")
ev_keep = EV("ev2", RESIDENCE, DATE(2, 2, 1931))
kid = PE("p3", first="Cedar")
dad = PE("p1", first="Alder")
f = FA("f1", father="p1", children=[CHREF("p3", private=True), "p4"], evs=[ER("ev1", private=True), "ev2"])
kid4 = PE("p4", first="Dahlia")
kid["parent_family_list"] = ["f1"]
kid4["parent_family_list"] = ["f1"]
dad["family_list"] = ["f1"]
fn = C(f, child_ref_list=[CHREF("p4")], event_ref_list=[ER("ev2")])
vec("private", "private.element.family_lists", "A private event reference and a private child reference of a family are removed; an event reached only through a private reference is then excluded",
    ["private.element.event_ref_list", "private.element.child_ref_list", "private.orphan.exclude"], [ev_only, ev_keep, kid, kid4, dad, f],
    {"ev1": None, "ev2": copy.deepcopy(ev_keep), "p3": copy.deepcopy(kid), "p4": copy.deepcopy(kid4), "p1": copy.deepcopy(dad), "f1": fn},
    excluded=[X("ev1", "private.orphan.exclude")],
    server=[V("private.element.event_ref_list", "f1", "/event_ref_list/0"), V("private.element.child_ref_list", "f1", "/child_ref_list/0")])

pl = PL("pl1", media_list=[MR("m1", private=True), MR("m2")])
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), media=[MR("m1", private=True), MR("m2")])
c = CIT("c1", media_list=[MR("m1", private=True)])
s = SRC("s1", media_list=[MR("m1", private=True)], attribute_list=[SATTR("Shelf", "B2", private=True), SATTR("Box", "4")],
        reporef_list=[REPOREF("r1", private=True), REPOREF("r2")])
fa = FA("f1", media_list=[MR("m1", private=True)])
r1 = REPO("r1")
r2 = REPO("r2", name="Second Archive")
m1 = MED("m1", path="media/a.jpg")
m2 = MED("m2", path="media/b.jpg")
c.update(attribute_list=[SATTR("Folio", "7", private=True)])
p = PE("p1", ["ev1"], media_list=[MR("m1")], family_list=["f1"], citation_list=["c1"])
fa["father_handle"] = "p1"
pn = {"pl1": C(pl, media_list=[MR("m2")]), "ev1": C(ev, media_list=[MR("m2")]), "c1": C(c, media_list=[], attribute_list=[]),
      "s1": C(s, media_list=[], attribute_list=[s["attribute_list"][1]], reporef_list=[REPOREF("r2")]), "f1": C(fa, media_list=[]),
      "r1": copy.deepcopy(r1), "r2": copy.deepcopy(r2), "m1": C(m1, path=""), "m2": C(m2, path=""), "p1": copy.deepcopy(p)}
vec("private", "private.element.object_lists", "Private media references (on events, places, sources, citations, families), private source attributes and a private repository reference are removed; the repository stays",
    ["private.element.media_list", "private.element.src_attribute_list", "private.element.reporef_list"], [pl, ev, c, s, fa, r1, r2, m1, m2, p], pn,
    server=[V("private.element.media_list", "pl1", "/media_list/0"), V("private.element.media_list", "ev1", "/media_list/0"),
            V("private.element.media_list", "c1", "/media_list/0"), V("private.element.media_list", "s1", "/media_list/0"),
            V("private.element.media_list", "f1", "/media_list/0"),
            V("private.element.src_attribute_list", "s1", "/attribute_list/0"), V("private.element.src_attribute_list", "c1", "/attribute_list/0"),
            V("private.element.reporef_list", "s1", "/reporef_list/0")])

ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930))
p = PE("p1", [ER("ev1", attrs=[ATTR(ATTR_CUSTOM, "Hobby", "Pastime", private=True), ATTR(ATTR_CUSTOM, "Pet", "Animal")])],
       media_list=[MR("m1", attrs=[ATTR(ATTR_CUSTOM, "Hobby", "Pastime", private=True)])])
m = MED("m1", path="media/a.jpg")
vec("private", "private.element.nested_attributes", "A private attribute on an EventRef or a MediaRef is removed",
    ["private.element.attribute_list"], [ev, p, m],
    {"ev1": copy.deepcopy(ev), "m1": C(m, path=""),
     "p1": C(p, event_ref_list=[ER("ev1", attrs=[ATTR(ATTR_CUSTOM, "Pet", "Animal")])], media_list=[MR("m1")])},
    server=[V("private.element.attribute_list", "p1", "/event_ref_list/0/attribute_list/0"),
            V("private.element.attribute_list", "p1", "/media_list/0/attribute_list/0")])

# private by association
priv = PE("p1", ["ev1"], birth=-1, note_list=["n1"], media_list=[MR("m1")], citation_list=["c2"], private=True)
ev = EV("ev1", RESIDENCE, DATE(5, 3, 1900), cit=["c1"], place="pl1", notes=["n2"])
c1 = CIT("c1", source="s1", note_list=["n3"], media_list=[MR("m2")])
c2 = CIT("c2", source="s1")
n1 = NOTE("n1", "about the private person")
n2 = NOTE("n2", "about the event")
n3 = NOTE("n3", "about the citation")
m1 = MED("m1", path="media/p.jpg")
m2 = MED("m2", path="media/c.jpg")
s = SRC("s1")
pl = PL("pl1")
vec("private", "private.orphan.cascade", "Objects only a private person reaches are dropped, level by level: its event, notes, photos and citations; places and sources stay (exempt)",
    ["private.object.exclude", "private.orphan.exclude"], [priv, ev, c1, c2, n1, n2, n3, m1, m2, s, pl],
    {"p1": None, "ev1": None, "c1": None, "c2": None, "n1": None, "n2": None, "n3": None, "m1": None, "m2": None,
     "s1": copy.deepcopy(s), "pl1": copy.deepcopy(pl)},
    excluded=[X("p1", "private.object.exclude")] + [X(h, "private.orphan.exclude") for h in ("ev1", "c1", "c2", "n1", "n2", "n3", "m1", "m2")],
    server=[V("private.object.exclude", "p1", "/private")], birth_like=[])

shared_ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930))
shared_note = NOTE("n1", "shared remark")
loose_note = NOTE("n2", "nobody refers to this")
priv = PE("p1", ["ev1"], note_list=["n1"], private=True)
pub = PE("p2", ["ev1"], note_list=["n1"], first="Birch")
pn = C(pub)
vec("private", "private.orphan.shared_stays", "An event or note that a public person also references stays; an unreferenced note stays too",
    ["private.object.exclude"], [shared_ev, shared_note, loose_note, priv, pub],
    {"ev1": copy.deepcopy(shared_ev), "n1": copy.deepcopy(shared_note), "n2": copy.deepcopy(loose_note), "p1": None, "p2": copy.deepcopy(pub)},
    excluded=[X("p1", "private.object.exclude")], server=[V("private.object.exclude", "p1", "/private")])

f_kids = FA("f1", father="p1", mother="p2", children=["p3"], private=False)
f_none = FA("f2", father="p1", mother="p2")
dad = PE("p1", family_list=["f1", "f2"], private=True)
mum = PE("p2", family_list=["f1", "f2"], first="Birch", private=True)
kid = PE("p3", parent_family_list=["f1"], first="Cedar")
vec("private", "private.orphan.family", "A childless family of two private parents is dropped; a family with a public child stays, with null parents",
    ["private.object.exclude", "private.orphan.exclude", "private.reference.parent_handles"], [f_kids, f_none, dad, mum, kid],
    {"f1": C(f_kids, father_handle=None, mother_handle=None), "f2": None, "p1": None, "p2": None, "p3": copy.deepcopy(kid)},
    excluded=[X("p1", "private.object.exclude"), X("p2", "private.object.exclude"), X("f2", "private.orphan.exclude")],
    server=[V("private.object.exclude", "p1", "/private"), V("private.object.exclude", "p2", "/private")])

held = PE("p1", ["ev1"], first="Hazel", primary_name=NAME("Hazel", "Testwood", NAME_BIRTH, private=True), media_list=[MR("m1")])
ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930))
m = MED("m1", path="media/h.jpg")
vec("private", "private.orphan.held_referrer", "Objects only a held person references are dropped too",
    ["private.name.hold_person", "private.orphan.exclude"], [held, ev, m], {"p1": None, "ev1": None, "m1": None},
    holds=[H("p1", "private.name.hold_person", "object")], excluded=[X("ev1", "private.orphan.exclude"), X("m1", "private.orphan.exclude")],
    server=[V("private.name.hold_person", "p1", "/primary_name/private")])

priv_ev = EV("ev1", RESIDENCE, DATE(1, 1, 1930), private=True, place="pl1", cit=["c1"])
pl = PL("pl1")
c = CIT("c1", source="s1")
s = SRC("s1", reporef_list=[REPOREF("r1")])
r = REPO("r1")
tag = TAG("t1")
vec("private", "private.orphan.exempt_classes", "Places, sources and repositories only a private object reaches stay (exempt); the citation goes",
    ["private.object.exclude", "private.orphan.exclude"], [priv_ev, pl, c, s, r, tag],
    {"ev1": None, "pl1": copy.deepcopy(pl), "c1": None, "s1": copy.deepcopy(s), "r1": copy.deepcopy(r), "t1": copy.deepcopy(tag)},
    excluded=[X("ev1", "private.object.exclude"), X("c1", "private.orphan.exclude")], server=[V("private.object.exclude", "ev1", "/private")])

# ======================================================================================================================
# SCAN.

def scan_vec(vid, title, rule, kind_text, field_key, ptr, make, server_rule=None, proj=lambda o: o):
    """One new object with a hit (held, never synced) and the same object synced before (field kept at its base)."""
    clean, dirty = make("A plain remark"), make(kind_text)
    vec("scan", vid + ".new_object", title + " (a new object is held whole)", [rule], [dirty], {dirty["handle"]: None},
        holds=[H(dirty["handle"], rule, "object", ptr)], server=[V(server_rule or rule, dirty["handle"], ptr)])
    vec("scan", vid + ".synced_object", title + " (a synced object keeps its last synced field)", [rule], [dirty],
        {dirty["handle"]: proj(clean)}, holds=[H(dirty["handle"], rule, "field", ptr)], context={"base": {dirty["handle"]: proj(clean)}},
        server=[V(server_rule or rule, dirty["handle"], ptr)])


scan_vec("scan.phone", "A phone number in a note holds the field", "scan.phone", "Call her on 555-0123 tonight", None, "/text/string",
         lambda t: NOTE("n1", t))
scan_vec("scan.email", "An e-mail address in an event description holds the field", "scan.email", "Write to alder@example.org", None, "/description",
         lambda t: EV("ev1", RESIDENCE, DATE(0, 0, 1930), desc=t))
scan_vec("scan.street_address", "A street address in a media description holds the field", "scan.street_address", "Taken outside 12 Fixture Lane", None, "/desc",
         lambda t: MED("m1", desc=t), proj=lambda o: C(o, path=""))
scan_vec("scan.po_box", "A PO box in a citation page holds the field", "scan.po_box", "Write to P.O. Box 12", None, "/page",
         lambda t: CIT("c1", page=t))
scan_vec("scan.contact_url", "A contact-channel link in a note holds the field", "scan.contact_url", "Message https://wa.me/15555550100", None, "/text/string",
         lambda t: NOTE("n1", t))
scan_vec("scan.dob_heuristic", "A day-precise date near a birth keyword in a note holds the field", "scan.dob_heuristic", "She was born on 5 May 1900", None,
         "/text/string", lambda t: NOTE("n1", t))

# styled note: holding keeps the base tags too
tags = [{"_class": "StyledTextTag", "name": 0, "value": None, "ranges": [[0, 5]]}]
base = NOTE("n1", "A plain remark", tags)
dirty = NOTE("n1", "Call 555-0123 now", [{"_class": "StyledTextTag", "name": 1, "value": None, "ranges": [[0, 4]]}])
vec("scan", "scan.styled_note_atomic", "A styled note is one atomic field: holding it keeps the base tags with the base text", ["scan.phone"], [dirty],
    {"n1": copy.deepcopy(base)}, holds=[H("n1", "scan.phone", "field", "/text/string")], context={"base": {"n1": base}},
    server=[V("scan.phone", "n1", "/text/string")])

# exact DOB (desktop only)
birth = EV("ev1", BIRTH, DATE(5, 3, 1900))
p = PE("p1", ["ev1"], birth=0, first="Alder")
forms = [("n1", "Registered 1900-03-05 in the book"), ("n2", "Entry dated 3/5/1900"), ("n3", "On March 5, 1900 the family"), ("n4", "5 Mar 1900"),
         ("n5", "Alder's birthday is March 5th"), ("n6", "Alder was a good sport on 5 March at the fair"), ("n7", "Moved in March 1900"),
         ("n8", "The 5th of March was cold." + " wait" * 16 + " until Alder came")]
notes = [NOTE(h, t) for h, t in forms]
hit = ["n1", "n2", "n3", "n4", "n5", "n6"]
hold_rules = {"n1": ["scan.dob_exact"], "n2": ["scan.dob_exact"], "n3": ["scan.dob_exact"],
              "n4": ["scan.dob_exact"], "n5": ["scan.dob_exact", "scan.dob_heuristic"], "n6": ["scan.dob_exact"]}
out = {"ev1": C(birth, date=DY(1900)), "p1": copy.deepcopy(p)}
holds = []
for h, rs in hold_rules.items():
    out[h] = None
    for r in rs:
        holds.append(H(h, r, "object", "/text/string"))
out["n7"] = copy.deepcopy(notes[6])
out["n8"] = copy.deepcopy(notes[7])
vec("scan", "scan.dob_exact", "A full local birth date in a listed form, or its day and month near a birth keyword or the person's name, holds the note (desktop only: the server cannot know the dates)",
    ["scan.dob_exact", "scan.dob_heuristic", "birth.date.daymonth"], [birth, p] + notes, out, holds=holds,
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1"),
            V("scan.dob_heuristic", "n5", "/text/string")], birth_like=["ev1"])

# fields
mk = lambda cls, h, **kw: dict({"_class": cls, "handle": h, "private": False}, **kw)
fields = [
    (SRC("s1", author="Reach me at alder@example.org"), "/author"),
    (SRC("s2", pubinfo="Printed at 12 Example Road"), "/pubinfo"),
    (SRC("s3", title="Call 555-0123", abbrev=""), "/title"),
    (SRC("s4", abbrev="P.O. Box 7"), "/abbrev"),
    (REPO("r1", name="Archive, 12 Example Road"), "/name"),
    (TAG("t1", name="call 555-0125"), "/name"),
    (PL("pl1", name="Fixtureland", title="Write to P.O. Box 9"), "/title"),
    (PL("pl2", name="Call 555-0126"), "/name/value"),
    (PE("p1", first="Alder", primary_name=NAME("Alder", "Testwood", nick="alder@example.org")), "/primary_name/nick"),
    (PE("p2", first="Birch", primary_name=NAME("Birch", "555-0127")), "/primary_name/surname_list/0/surname"),
    (PE("p3", first="Cedar", person_ref_list=[PREF("p2", "call 555-0128")]), "/person_ref_list/0/rel"),
    (PE("p4", first="Dahlia", attribute_list=[ATTR(ATTR_CUSTOM, "reach alder@example.org", "Contact")]), "/attribute_list/0/value"),
    (SRC("s5", attribute_list=[SATTR("Folio", "555-0129")]), "/attribute_list/0/value"),
    (PE("p5", first="Elm", urls=[URL("https://example.org/x", URL_WEB_HOME, "see 12 Example Road")]), "/urls/0/desc"),
]
objs, out, holds, viol = [], {}, [], []
kind_of = {"/author": "scan.email", "/pubinfo": "scan.street_address", "/title": None, "/abbrev": "scan.po_box", "/name": None, "/rel": None}
expect = {
    "s1": ("scan.email", "/author"), "s2": ("scan.street_address", "/pubinfo"), "s3": ("scan.phone", "/title"), "s4": ("scan.po_box", "/abbrev"),
    "r1": ("scan.street_address", "/name"), "t1": ("scan.phone", "/name"), "pl1": ("scan.po_box", "/title"), "pl2": ("scan.phone", "/name/value"),
    "p1": ("scan.email", "/primary_name/nick"), "p2": ("scan.phone", "/primary_name/surname_list/0/surname"),
    "p3": ("scan.phone", "/person_ref_list/0/rel"), "p4": ("scan.email", "/attribute_list/0/value"),
    "s5": ("scan.phone", "/attribute_list/0/value"), "p5": ("scan.street_address", "/urls/0/desc"),
}
for o, _ in fields:
    objs.append(o)
    out[o["handle"]] = None
    r, ptr = expect[o["handle"]]
    holds.append(H(o["handle"], r, "object", ptr))
    viol.append(V(r, o["handle"], ptr))
# the URL element p5 is local-only before it is scanned: its description never leaves, so p5 is not held
out["p5"] = C(objs[-1], urls=[])
holds = [x for x in holds if x["handle"] != "p5"]
vec("scan", "scan.fields_covered", "Hits in the other listed fields (source, repository, tag, place title and name, person names, associations, attributes) hold the new object; a URL element with a hit is local-only first",
    ["scan.email", "scan.street_address", "scan.phone", "scan.po_box", "contact.url.scan_hit"], objs, out, holds=holds,
    server=viol + [V("contact.url.scan_hit", "p5", "/urls/0")])

# local-only text is never scanned, and clean text passes
p = PE("p1", address_list=[ADDR("12 Fixture Lane")], lds_ord_list=[], first="Alder")
n = NOTE("n1", "Went to the reunion; 2024 was a great year.")
vec("scan", "scan.clean_and_local_only", "Clean text passes, and a street address inside a local-only address list is not a hit",
    ["contact.address_list"], [p, n], {"p1": C(p, address_list=[]), "n1": copy.deepcopy(n)},
    server=[V("contact.address_list", "p1", "/address_list/0")])

# a held new note is filtered out of the references
n = NOTE("n1", "Phone 555-0123")
p = PE("p1", note_list=["n1"])
vec("scan", "scan.held_reference_filtered", "A held new note is removed from the note_list of the object that cited it", ["scan.phone", "private.reference.handle_lists"],
    [n, p], {"n1": None, "p1": C(p, note_list=[])}, holds=[H("n1", "scan.phone", "object", "/text/string")],
    server=[V("scan.phone", "n1", "/text/string")])

# ======================================================================================================================
# MEDIA.

m_ok = MED("m1", path="media/a.jpg", checksum="a" * 32)
m_ph = MED("m2", path="media/b.jpg", checksum="b" * 32)
vec("media", "media.path_and_checksum", "The media path is empty in the cloud; the checksum is the MD5 of the bytes when the file is readable, else the stored value",
    ["media.path.local_only", "media.checksum.derive"], [m_ok, m_ph], {"m1": C(m_ok, path="", checksum="c" * 32), "m2": C(m_ph, path="")},
    context={"files": {"m1": {"readable": True, "md5": "c" * 32}, "m2": {"readable": False, "md5": ""}}})

gps = MED("m1", mime="image/jpeg", path="media/gps.jpg")
png = MED("m2", mime="image/png", path="media/gps.png")
tif = MED("m3", mime="image/tiff", path="media/gps.tif")
txt = MED("m4", mime="text/plain", path="media/notes.txt")
plain = MED("m5", mime="image/jpeg", path="media/plain.jpg")
files = {"m1": {"exif_gps": True}, "m2": {"exif_gps": True}, "m3": {"exif_gps": True}, "m4": {"exif_gps": True}, "m5": {"exif_gps": False}}
vec("media", "media.exif_gps.new", "A JPEG, PNG or TIFF with EXIF GPS is held (never synced); a file of another type or with no GPS goes",
    ["media.exif_gps.hold", "media.path.local_only"], [gps, png, tif, txt, plain],
    {"m1": None, "m2": None, "m3": None, "m4": C(txt, path=""), "m5": C(plain, path="")},
    holds=[H("m1", "media.exif_gps.hold", "object"), H("m2", "media.exif_gps.hold", "object"), H("m3", "media.exif_gps.hold", "object")],
    context={"files": files})
base_gps = C(gps, path="", desc="older description")
vec("media", "media.exif_gps.synced", "A synced photo that gains EXIF GPS is held: the cloud keeps the last synced version", ["media.exif_gps.hold"], [gps],
    {"m1": copy.deepcopy(base_gps)}, holds=[H("m1", "media.exif_gps.hold", "object")],
    context={"files": {"m1": {"exif_gps": True}}, "base": {"m1": base_gps}})
vec("media", "media.exif_gps.released", "A held photo that io released goes", ["media.path.local_only"], [gps], {"m1": C(gps, path="")},
    context={"files": {"m1": {"exif_gps": True}}, "released": ["m1"]})

m_ev = MED("m1", path="media/ev.jpg")
m_cit = MED("m2", path="media/cit.jpg")
m_death = MED("m3", path="media/death.jpg")
m_rel = MED("m4", path="media/released.jpg")
cit = CIT("c1", media_list=[MR("m2")])
src = SRC("s1")
birth = EV("ev1", BIRTH, DATE(5, 3, 1900), media=["m1", "m4"], cit=["c1"])
death = EV("ev2", DEATH, DATE(1, 2, 1970), media=["m3"])
p = PE("p1", ["ev1", "ev2"], birth=0, death=1)
vec("media", "media.birth_linked", "A photo of a birth-like event, or of its citation, is held until io releases it; a death photo and a released photo go",
    ["media.birth_linked.hold", "birth.date.daymonth"], [m_ev, m_cit, m_death, m_rel, cit, src, birth, death, p],
    {"m1": None, "m2": None, "m3": C(m_death, path=""), "m4": C(m_rel, path=""), "c1": C(cit, media_list=[]), "s1": copy.deepcopy(src),
     "ev1": C(birth, date=DY(1900), media_list=[MR("m4")]), "ev2": C(death, media_list=[MR("m3")]), "p1": copy.deepcopy(p)},
    holds=[H("m1", "media.birth_linked.hold", "object"), H("m2", "media.birth_linked.hold", "object")],
    context={"released": ["m4"]},
    server=[V("birth.date.daymonth", "ev1", "/date/dateval/0"), V("birth.date.daymonth", "ev1", "/date/dateval/1")], birth_like=["ev1"])

pdf = MED("m1", mime="application/pdf", path="media/cert.pdf", desc="Certificate scan")
img = MED("m2", mime="image/jpeg", path="media/ok.jpg")
vec("media", "media.pdf", "A PDF is held until io releases it; an image goes", ["media.pdf.hold"], [pdf, img], {"m1": None, "m2": C(img, path="")},
    holds=[H("m1", "media.pdf.hold", "object")])
vec("media", "media.pdf_released", "A released PDF goes", ["media.path.local_only"], [pdf], {"m1": C(pdf, path="")}, context={"released": ["m1"]})

m1 = MED("m1", path="media/a.jpg")
refs = [MR("m1", [0, 0, 100, 100]), MR("m1", [10, 10, 50, 60]), MR("m1", None)]
p = PE("p1", media_list=refs)
vec("media", "media.rect.full_frame", "A [0,0,100,100] rectangle becomes null in the cloud; other rectangles and null stay", ["media.rect.full_frame"], [m1, p],
    {"m1": C(m1, path=""), "p1": C(p, media_list=[MR("m1", None), MR("m1", [10, 10, 50, 60]), MR("m1", None)])})

bad = [MR("m1", [10, 10, 50, 60]), MR("m1", [12.5, 10, 50, 60]), MR("m1", [60, 10, 50, 70]), MR("m1", [10, 10, 101, 60]), MR("m1", [10, 10, 50])]
base_p = PE("p1", media_list=[MR("m1", [10, 10, 50, 60]), MR("m1", [1, 2, 3, 4]), MR("m1", [5, 5, 40, 40]), MR("m1", [6, 6, 41, 41]), MR("m1", [7, 7, 42, 42])])
p = PE("p1", media_list=bad)
vec("media", "media.rect.degenerate_or_float.synced", "A fractional, inverted, out-of-range or short rectangle is held: the cloud keeps the last synced rectangle",
    ["media.rect.degenerate_or_float"], [m1, p], {"m1": C(m1, path=""), "p1": C(p, media_list=base_p["media_list"])},
    holds=[H("p1", "media.rect.degenerate_or_float", "field", "/media_list/%d/rect" % i) for i in (1, 2, 3, 4)],
    context={"base": {"p1": base_p}})
p_new = PE("p1", media_list=[MR("m1", [10, 10, 50, 60]), MR("m1", [12.5, 10, 50, 60])])
vec("media", "media.rect.degenerate_or_float.new", "A held rectangle of a new reference is null in the cloud", ["media.rect.degenerate_or_float"], [m1, p_new],
    {"m1": C(m1, path=""), "p1": C(p_new, media_list=[MR("m1", [10, 10, 50, 60]), MR("m1", None)])},
    holds=[H("p1", "media.rect.degenerate_or_float", "field", "/media_list/1/rect")])


# ======================================================================================================================


def render(group):
    lines = [json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":")) for v in VECTORS[group]]
    return '{"policy":"redaction-v1","group":%s,"vectors":[\n%s\n]}\n' % (json.dumps(group), ",\n".join(lines))


def main(argv):
    check = "--check" in argv
    bad = []
    os.makedirs(OUT, exist_ok=True)
    for group in sorted(VECTORS):
        path = os.path.join(OUT, group + ".json")
        text = render(group)
        if check:
            have = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if have != text:
                bad.append(path)
        else:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
    if check:
        known = {g + ".json" for g in VECTORS}
        extra = [f for f in os.listdir(OUT) if f.endswith(".json") and f not in known] if os.path.isdir(OUT) else []
        bad += [os.path.join(OUT, f) for f in extra]
        if bad:
            print("stale or extra vector files:\n  " + "\n  ".join(bad), file=sys.stderr)
            return 1
        return 0
    print("wrote %d vectors in %d files under %s" % (sum(len(v) for v in VECTORS.values()), len(VECTORS), OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
