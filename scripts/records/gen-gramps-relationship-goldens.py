#!/usr/bin/env python3
"""Generate the relationship goldens (HFY-TSK-251, relationship-compiler): what Gramps 6.0.6 itself leaves in the tree.

Runs under the Gramps bundle shim (`gramps_shim.py`, the same environment as `gen-gramps-semantics-goldens.py`) on a
Mac that has Gramps.app 6.0.6. It reads no family data. The tree is SYNTHETIC: placeholder names, handles made here,
ids I9001 and up. The output is deterministic (no clock value is kept, no random value is used), so a regeneration is
byte-identical.

For each scenario the generator builds the synthetic tree in a real Gramps database (SQLite, in a temporary
directory), then performs the steps that Gramps' own EditFamily and EditPerson editors perform for that relationship
through Gramps' DB API (`Family()`, `ChildRef()`, `Person.add_family_handle`, `Person.add_parent_family_handle`,
`DbTxn`, `commit_person`, `commit_family`, `set_birth_death_index`, ...), and reads every object back out of the
database. The file keeps:

* `tree`: the synthetic tree as Gramps serializes it (the `change` stamp is dropped: a clock value);
* `scenarios[]`: the relationship intent (editing design section 8.2), and what Gramps left behind: the objects it
  created (in the order the compiler creates them), the objects it changed, and each of those objects as Gramps
  stores it.

`api/src/records/relationships.js` compiles the same intents into EditOps; `api/test/records/relationships.node-test.js`
applies them to `tree` and compares the result with `scenarios[].gramps` object by object. Other workers test
against this file without Gramps: `check_relationship_goldens.py` verifies it with the standard library alone (a
second, independent check of the two-sided links, the cycle rule, the slot rule, the append order and the stub shape).

Usage:
    python3 scripts/records/gen-gramps-relationship-goldens.py            # write the file
    python3 scripts/records/gen-gramps-relationship-goldens.py --check    # regenerate in memory, compare byte for byte
    python3 scripts/records/gen-gramps-relationship-goldens.py --out PATH
"""

import hashlib
import json
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gramps_shim  # noqa: E402

GRAMPS_VERSION = gramps_shim.activate()

from gramps.gen.db import DbTxn  # noqa: E402
from gramps.gen.db.utils import make_database  # noqa: E402
from gramps.gen.lib import (  # noqa: E402
    ChildRef,
    ChildRefType,
    Date,
    Event,
    EventRef,
    EventRoleType,
    EventType,
    Family,
    FamilyRelType,
    Name,
    NameType,
    Person,
    Place,
    PlaceName,
    PlaceRef,
    PlaceType,
    Surname,
)
from gramps.gen.lib.json_utils import object_to_string  # noqa: E402

REPO = HERE.parents[1]
DEFAULT_OUT = REPO / "api" / "test" / "records" / "fixtures" / "gramps-relationships.golden.json"
GENERATOR = "scripts/records/gen-gramps-relationship-goldens.py"
FORMAT_VERSION = 1

FEMALE, MALE, UNKNOWN = Person.FEMALE, Person.MALE, Person.UNKNOWN
BIRTH, ADOPTED, STEPCHILD, SPONSORED, FOSTER, UNKNOWN_REL = (
    ChildRefType.BIRTH,
    ChildRefType.ADOPTED,
    ChildRefType.STEPCHILD,
    ChildRefType.SPONSORED,
    ChildRefType.FOSTER,
    ChildRefType.UNKNOWN,
)
MARRIED, UNMARRIED, CIVIL_UNION, FAMILY_UNKNOWN = (
    FamilyRelType.MARRIED,
    FamilyRelType.UNMARRIED,
    FamilyRelType.CIVIL_UNION,
    FamilyRelType.UNKNOWN,
)
GENDER = {"female": FEMALE, "male": MALE, "unknown": UNKNOWN}

# --------------------------------------------------------------------------------------------------------------
# Handles. Base objects: a class prefix and the id number. Objects the scenarios create: "9f" and a counter, in the
# order the compiler creates them (new:1, new:2, ...). All are hex-shaped like Gramps' own handles.
# --------------------------------------------------------------------------------------------------------------
PREFIX = {"Person": "9a", "Family": "9b", "Event": "9c", "Place": "9d"}
NEW_PREFIX = "9f"


def h(cls, n):
    return "%s%018d" % (PREFIX[cls], n)


def new_h(k):
    return "%s%018d" % (NEW_PREFIX, k)


def key(cls, handle):
    return "%s:%s" % (cls, handle)


def pk(n):
    return key("Person", h("Person", n))


def fk(n):
    return key("Family", h("Family", n))


def plk(n):
    return key("Place", h("Place", n))


# --------------------------------------------------------------------------------------------------------------
# World: one Gramps database in a temporary directory
# --------------------------------------------------------------------------------------------------------------
class World:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="hfy-rel-golden-")
        self.db = make_database("sqlite")
        self.db.load(self.dir, None, update=False)
        self.created = []  # keys, in creation order
        self.counter = 0

    def close(self):
        self.db.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def txn(self):
        return DbTxn("hfy", self.db)

    def new(self, cls):
        """Allocate the handle of an object this scenario creates (the compiler's new:1, new:2, ...)."""
        self.counter += 1
        handle = new_h(self.counter)
        self.created.append(key(cls, handle))
        return handle


def as_dict(obj):
    d = json.loads(object_to_string(obj))
    d.pop("change", None)
    return d


def snapshot(db):
    out = {}
    for cls, handles, getter in (
        ("Person", db.iter_person_handles, db.get_person_from_handle),
        ("Family", db.iter_family_handles, db.get_family_from_handle),
        ("Event", db.iter_event_handles, db.get_event_from_handle),
        ("Place", db.iter_place_handles, db.get_place_from_handle),
    ):
        for handle in handles():
            out[key(cls, handle)] = as_dict(getter(handle))
    return out


# --------------------------------------------------------------------------------------------------------------
# The steps Gramps' editors perform
# --------------------------------------------------------------------------------------------------------------
def year_date(year, about=False):
    d = Date()
    d.set(
        quality=Date.QUAL_NONE,
        modifier=Date.MOD_ABOUT if about else Date.MOD_NONE,
        calendar=Date.CAL_GREGORIAN,
        value=(0, 0, year, False),
    )
    return d


def put_event(w, t, handle, etype, year, about=False, place="", gramps_id=""):
    ev = Event()
    ev.set_handle(handle)
    ev.set_gramps_id(gramps_id)
    ev.set_type(EventType(etype))
    if year:
        ev.set_date_object(year_date(year, about))
    if place:
        ev.set_place_handle(place)
    w.db.commit_event(ev, t)


def put_person(w, t, handle, first, surname, gender, gramps_id="", events=(), families=(), parent_families=()):
    p = Person()
    p.set_handle(handle)
    p.set_gramps_id(gramps_id)
    name = Name()
    name.set_first_name(first)
    sn = Surname()
    sn.set_surname(surname)
    name.add_surname(sn)
    name.set_type(NameType(NameType.BIRTH))
    p.set_primary_name(name)
    p.set_gender(gender)
    for ev in events:
        ref = EventRef()
        ref.set_reference_handle(ev)
        ref.set_role(EventRoleType(EventRoleType.PRIMARY))
        p.add_event_ref(ref)
    for fh in families:
        p.add_family_handle(fh)
    for fh in parent_families:
        p.add_parent_family_handle(fh)
    w.db.set_birth_death_index(p)  # what EditPerson does before it saves
    w.db.commit_person(p, t)


def child_ref(handle, frel=BIRTH, mrel=BIRTH):
    ref = ChildRef()
    ref.set_reference_handle(handle)
    ref.set_father_relation(ChildRefType(frel))
    ref.set_mother_relation(ChildRefType(mrel))
    return ref


def put_family(w, t, handle, father=None, mother=None, rel=FAMILY_UNKNOWN, events=(), gramps_id=""):
    """EditFamily save for a new family: the Family, then each parent's family_list."""
    fam = Family()
    fam.set_handle(handle)
    fam.set_gramps_id(gramps_id)
    fam.set_relationship(FamilyRelType(rel))
    if father:
        fam.set_father_handle(father)
    if mother:
        fam.set_mother_handle(mother)
    for ev in events:
        ref = EventRef()
        ref.set_reference_handle(ev)
        ref.set_role(EventRoleType(EventRoleType.FAMILY))
        fam.add_event_ref(ref)
    w.db.commit_family(fam, t)
    for ph in (father, mother):
        if ph:
            link_parent(w, t, handle, ph)


def link_parent(w, t, fam_h, person_h):
    p = w.db.get_person_from_handle(person_h)
    p.add_family_handle(fam_h)
    w.db.commit_person(p, t)


def add_child(w, t, fam_h, child_h, frel=BIRTH, mrel=BIRTH):
    """EditFamily: a ChildRef in the family and the family in the child's parent_family_list."""
    fam = w.db.get_family_from_handle(fam_h)
    fam.add_child_ref(child_ref(child_h, frel, mrel))
    w.db.commit_family(fam, t)
    c = w.db.get_person_from_handle(child_h)
    c.add_parent_family_handle(fam_h)
    w.db.commit_person(c, t)


def fill_slot(w, t, fam_h, person_h, slot):
    fam = w.db.get_family_from_handle(fam_h)
    (fam.set_father_handle if slot == "father" else fam.set_mother_handle)(person_h)
    w.db.commit_family(fam, t)
    link_parent(w, t, fam_h, person_h)


def set_type(w, t, fam_h, rel):
    fam = w.db.get_family_from_handle(fam_h)
    fam.set_relationship(FamilyRelType(rel))
    w.db.commit_family(fam, t)


def unlink_child(w, t, fam_h, child_h):
    fam = w.db.get_family_from_handle(fam_h)
    fam.remove_child_handle(child_h)
    w.db.commit_family(fam, t)
    c = w.db.get_person_from_handle(child_h)
    c.remove_parent_family_handle(fam_h)
    w.db.commit_person(c, t)


def unlink_partner(w, t, fam_h, person_h):
    fam = w.db.get_family_from_handle(fam_h)
    if fam.get_father_handle() == person_h:
        fam.set_father_handle(None)
    else:
        fam.set_mother_handle(None)
    w.db.commit_family(fam, t)
    p = w.db.get_person_from_handle(person_h)
    p.remove_family_handle(fam_h)
    w.db.commit_person(p, t)


def put_place(w, t, handle, name, ptype, enclosed_by=None, gramps_id=""):
    pl = Place()
    pl.set_handle(handle)
    pl.set_gramps_id(gramps_id)
    pn = PlaceName()
    pn.set_value(name)
    pl.set_name(pn)
    pl.set_type(PlaceType(ptype))
    if enclosed_by:
        ref = PlaceRef()
        ref.set_reference_handle(enclosed_by)
        pl.add_placeref(ref)
    w.db.commit_place(pl, t)


def build_stubs(w, t, specs):
    """New people from stubs. Allocation order is the compiler's numbering: every Person first, then, stub by stub,
    its Birth event and its Death event. Returns the Person handles."""
    persons = [w.new("Person") for _ in specs]
    events = []
    for s in specs:
        birth = w.new("Event") if s.get("birthYear") else None
        death = w.new("Event") if (s.get("living") == "no" and s.get("deathYear")) else None
        events.append((birth, death))
    for s, ph, (birth, death) in zip(specs, persons, events):
        if birth:
            put_event(w, t, birth, EventType.BIRTH, s["birthYear"])
        if death:
            put_event(w, t, death, EventType.DEATH, s["deathYear"])
        put_person(w, t, ph, s["given"], s["surname"], GENDER[s["gender"]], events=[e for e in (birth, death) if e])
    return persons


# --------------------------------------------------------------------------------------------------------------
# The synthetic tree
# --------------------------------------------------------------------------------------------------------------
PEOPLE = [  # (n, given, surname, gender, birth year or None)
    (9001, "Ann", "Alpha", FEMALE, 1950),
    (9002, "Bob", "Alpha", MALE, 1948),
    (9003, "Cal", "Alpha", MALE, 1975),
    (9004, "Dee", "Alpha", FEMALE, 1978),
    (9005, "Eli", "Beta", MALE, 1960),
    (9006, "Fay", "Gamma", FEMALE, 1955),
    (9007, "Gus", "Gamma", MALE, 1980),
    (9008, "Hal", "Delta", MALE, 1962),
    (9009, "Ida", "Delta", FEMALE, 1964),
    (9010, "Joe", "Epsilon", MALE, 1970),
    (9011, "Kai", "Epsilon", MALE, 1972),
    (9012, "Max", "Zeta", UNKNOWN, 2000),
    (9013, "Una", "Theta", UNKNOWN, 1966),
    (9014, "Vic", "Young", MALE, 1990),
]


def build_tree(w):
    with w.txn() as t:
        put_place(w, t, h("Place", 9001), "Testland", PlaceType.COUNTRY, gramps_id="P9001")
        put_place(w, t, h("Place", 9002), "Exampleshire", PlaceType.STATE, enclosed_by=h("Place", 9001), gramps_id="P9002")
        for n, given, surname, gender, birth in PEOPLE:
            events = []
            if birth:
                eh = h("Event", n)
                put_event(w, t, eh, EventType.BIRTH, birth, gramps_id="E%d" % n)
                events.append(eh)
            put_person(w, t, h("Person", n), given, surname, gender, gramps_id="I%d" % n, events=events)
        # F9001: Bob and Ann, married in 1972, with Cal and Dee
        put_event(w, t, h("Event", 9100), EventType.MARRIAGE, 1972, gramps_id="E9100")
        put_family(w, t, h("Family", 9001), father=h("Person", 9002), mother=h("Person", 9001), rel=MARRIED, events=[h("Event", 9100)], gramps_id="F9001")
        add_child(w, t, h("Family", 9001), h("Person", 9003))
        add_child(w, t, h("Family", 9001), h("Person", 9004))
        # F9002: Eli alone, no children
        put_family(w, t, h("Family", 9002), father=h("Person", 9005), gramps_id="F9002")
        # F9003: Fay alone, with Gus
        put_family(w, t, h("Family", 9003), mother=h("Person", 9006), gramps_id="F9003")
        add_child(w, t, h("Family", 9003), h("Person", 9007))


# --------------------------------------------------------------------------------------------------------------
# Scenarios. Each has an intent (the client's request, editing design section 8.2) and a procedure that does what
# Gramps' editors do for it. `created` is filled in by w.new() as objects are allocated.
# --------------------------------------------------------------------------------------------------------------
SCENARIOS = []


def scenario(sid, title, tags, intent):
    def deco(fn):
        SCENARIOS.append({"id": sid, "title": title, "tags": sorted(tags), "intent": intent, "proc": fn})
        return fn

    return deco


def stub(given, surname, gender, birth=None, living="unknown", death=None):
    return {"given": given, "surname": surname, "gender": gender, "birthYear": birth, "living": living, "deathYear": death}


def ref(key_):
    return {"ref": key_}


def parent_intent(person_n, parents):
    return {"type": "parents", "person": pk(person_n), "parents": parents}


def p_(who, rel="birth"):
    return {"who": who, "rel": rel}


# ---- parents ---------------------------------------------------------------------------------------------------
@scenario("parents-001", "parents reuse an existing two-parent family", ["parents", "reuse"], parent_intent(9012, [p_(ref(pk(9002))), p_(ref(pk(9001)))]))
def _(w, t):
    add_child(w, t, h("Family", 9001), h("Person", 9012))


@scenario("parents-002", "parents reuse the family whichever parent is chosen first", ["parents", "reuse", "selection-order"], parent_intent(9012, [p_(ref(pk(9001))), p_(ref(pk(9002)))]))
def _(w, t):
    add_child(w, t, h("Family", 9001), h("Person", 9012))


@scenario("parents-003", "parents reuse a family, adoptive to both", ["parents", "reuse", "relation"], parent_intent(9012, [p_(ref(pk(9002)), "adopted"), p_(ref(pk(9001)), "adopted")]))
def _(w, t):
    add_child(w, t, h("Family", 9001), h("Person", 9012), ADOPTED, ADOPTED)


@scenario("parents-004", "one chosen parent with a single-parent family that has no children reuses it", ["parents", "single-parent", "reuse"], parent_intent(9012, [p_(ref(pk(9005)))]))
def _(w, t):
    add_child(w, t, h("Family", 9002), h("Person", 9012))


@scenario("parents-005", "one chosen parent with a single-parent family that has children adds a sibling", ["parents", "single-parent", "reuse"], parent_intent(9012, [p_(ref(pk(9006)), "foster")]))
def _(w, t):
    add_child(w, t, h("Family", 9003), h("Person", 9012), BIRTH, FOSTER)


@scenario("parents-006", "two chosen parents fill the empty slot of a single-parent family with no children", ["parents", "single-parent", "fill"], parent_intent(9012, [p_(ref(pk(9005))), p_(ref(pk(9009)))]))
def _(w, t):
    fill_slot(w, t, h("Family", 9002), h("Person", 9009), "mother")
    add_child(w, t, h("Family", 9002), h("Person", 9012))


@scenario("parents-007", "two chosen parents never fill the empty slot of a single-parent family that has children", ["parents", "single-parent", "never-fill", "warning"], parent_intent(9012, [p_(ref(pk(9006))), p_(ref(pk(9008)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=h("Person", 9006))
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-008", "two parents with no family together get a new family", ["parents", "new-family"], parent_intent(9012, [p_(ref(pk(9008))), p_(ref(pk(9009)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=h("Person", 9009))
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-009", "a new birth family is appended after the existing parent family", ["parents", "new-family", "append", "warning"], parent_intent(9004, [p_(ref(pk(9008))), p_(ref(pk(9009)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=h("Person", 9009))
    add_child(w, t, fam, h("Person", 9004))


@scenario("parents-010", "an adoptive family is appended after the existing parent family", ["parents", "new-family", "append", "relation"], parent_intent(9004, [p_(ref(pk(9008)), "adopted"), p_(ref(pk(9009)), "adopted")]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=h("Person", 9009))
    add_child(w, t, fam, h("Person", 9004), ADOPTED, ADOPTED)


@scenario("parents-011", "two men: the first chosen takes partner1, the second partner2", ["parents", "slots", "same-sex", "selection-order"], parent_intent(9012, [p_(ref(pk(9011))), p_(ref(pk(9010)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9011), mother=h("Person", 9010))
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-012", "a parent of unknown gender takes the slot the woman leaves", ["parents", "slots"], parent_intent(9012, [p_(ref(pk(9013))), p_(ref(pk(9009)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9013), mother=h("Person", 9009))
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-013", "one man with no family gets a single-parent family in the father slot", ["parents", "slots", "single-parent", "new-family"], parent_intent(9012, [p_(ref(pk(9008)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008))
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-014", "one woman with no family gets a single-parent family in the mother slot", ["parents", "slots", "single-parent", "new-family"], parent_intent(9012, [p_(ref(pk(9009)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, mother=h("Person", 9009))
    add_child(w, t, fam, h("Person", 9012))


_STUB_FATHER = stub("Stubfather", "Stubsurname", "male", 1950, "no", 2010)
_STUB_MOTHER = stub("Stubmother", "Stubsurname", "female", 1952, "yes")


@scenario("parents-015", "two new people (stubs) as parents", ["parents", "stub", "new-family"], parent_intent(9012, [p_({"new": _STUB_FATHER}), p_({"new": _STUB_MOTHER})]))
def _(w, t):
    father, mother = build_stubs(w, t, [_STUB_FATHER, _STUB_MOTHER])
    fam = w.new("Family")
    put_family(w, t, fam, father=father, mother=mother)
    add_child(w, t, fam, h("Person", 9012))


_STUB_NOYEAR = stub("Stubmother", "Stubsurname", "female")


@scenario("parents-016", "one existing parent and one stub with no birth year", ["parents", "stub", "new-family"], parent_intent(9012, [p_(ref(pk(9008))), p_({"new": _STUB_NOYEAR})]))
def _(w, t):
    (mother,) = build_stubs(w, t, [_STUB_NOYEAR])
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=mother)
    add_child(w, t, fam, h("Person", 9012))


@scenario("parents-017", "parents already recorded change nothing", ["parents", "already-recorded"], parent_intent(9003, [p_(ref(pk(9002))), p_(ref(pk(9001)))]))
def _(w, t):
    pass


# ---- children --------------------------------------------------------------------------------------------------
def children_intent(me_n, other, kids):
    return {"type": "children", "person": pk(me_n), "otherParent": other, "children": kids}


def kid(who, to_me="birth", to_other="birth"):
    return {"who": who, "relToMe": to_me, "relToOther": to_other}


UNKNOWN_OTHER = {"unknown": True}


@scenario("children-001", "children with an unknown other parent: a new single-parent family", ["children", "unknown-parent", "new-family"], children_intent(9008, UNKNOWN_OTHER, [kid(ref(pk(9012)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008))
    add_child(w, t, fam, h("Person", 9012))


@scenario("children-002", "children with an unknown other parent reuse the person's single-parent family", ["children", "unknown-parent", "reuse", "relation"], children_intent(9006, UNKNOWN_OTHER, [kid(ref(pk(9012)), "adopted")]))
def _(w, t):
    add_child(w, t, h("Family", 9003), h("Person", 9012), BIRTH, ADOPTED)


@scenario("children-003", "children with a known other parent reuse their family", ["children", "reuse", "selection-order"], children_intent(9001, ref(pk(9002)), [kid(ref(pk(9012)))]))
def _(w, t):
    add_child(w, t, h("Family", 9001), h("Person", 9012))


_STUB_KID = stub("Stubchild", "Stubsurname", "female", 2005, "yes")


@scenario("children-004", "a new child (stub) with a known other parent: a new family", ["children", "stub", "new-family"], children_intent(9008, ref(pk(9009)), [kid({"new": _STUB_KID}, "birth", "adopted")]))
def _(w, t):
    (child,) = build_stubs(w, t, [_STUB_KID])
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008), mother=h("Person", 9009))
    add_child(w, t, fam, child, BIRTH, ADOPTED)


_STUB_OTHER = stub("Stubother", "Stubsurname", "female", 1966, "yes")
_STUB_KID2 = stub("Stubchild", "Stubsurname", "male", 1995, "yes")


@scenario("children-005", "a new other parent (stub), an existing child and a new child", ["children", "stub", "new-family"], children_intent(9010, {"new": _STUB_OTHER}, [kid(ref(pk(9012))), kid({"new": _STUB_KID2})]))
def _(w, t):
    other, child = build_stubs(w, t, [_STUB_OTHER, _STUB_KID2])
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9010), mother=other)
    add_child(w, t, fam, h("Person", 9012))
    add_child(w, t, fam, child)


@scenario("children-006", "a child who already has birth parents gets a second family", ["children", "new-family", "append", "warning"], children_intent(9008, UNKNOWN_OTHER, [kid(ref(pk(9003)))]))
def _(w, t):
    fam = w.new("Family")
    put_family(w, t, fam, father=h("Person", 9008))
    add_child(w, t, fam, h("Person", 9003))


@scenario("children-007", "children already recorded change nothing", ["children", "already-recorded"], children_intent(9002, ref(pk(9001)), [kid(ref(pk(9003)))]))
def _(w, t):
    pass


# ---- spouse ----------------------------------------------------------------------------------------------------
def spouse_intent(me_n, spouse, rel_type, married=None, ended=None):
    return {"type": "spouse", "person": pk(me_n), "spouse": spouse, "relType": rel_type, "married": married, "ended": ended}


def spouse_family(w, t, father, mother, rel, marriage=None, divorce=None, place=None):
    """Allocate in the compiler's order (place, Marriage, Divorce, Family), then save as EditFamily does."""
    ph = w.new("Place") if place and "new" in place else None
    mh = w.new("Event") if marriage else None
    dh = w.new("Event") if divorce else None
    fam = w.new("Family")
    place_h = ph
    if ph:
        put_place(w, t, ph, place["new"]["name"], PlaceType.CITY, enclosed_by=h("Place", 9002))
    elif place:
        place_h = place["handle"]
    if mh:
        put_event(w, t, mh, EventType.MARRIAGE, marriage["year"], marriage.get("about", False), place_h or "")
    if dh:
        put_event(w, t, dh, EventType.DIVORCE, divorce)
    put_family(w, t, fam, father=father, mother=mother, rel=rel, events=[e for e in (mh, dh) if e])


@scenario(
    "spouse-001",
    "spouse married, then divorced",
    ["spouse", "married", "divorced", "new-family"],
    spouse_intent(9008, ref(pk(9009)), "married", {"year": 1990, "about": False, "place": None}, {"how": "divorced", "year": 2001}),
)
def _(w, t):
    spouse_family(w, t, h("Person", 9008), h("Person", 9009), MARRIED, {"year": 1990}, 2001)


@scenario(
    "spouse-002",
    "spouse married about a year",
    ["spouse", "married", "new-family", "about"],
    spouse_intent(9009, ref(pk(9008)), "married", {"year": 1985, "about": True, "place": None}),
)
def _(w, t):
    spouse_family(w, t, h("Person", 9008), h("Person", 9009), MARRIED, {"year": 1985, "about": True})


@scenario("spouse-003", "spouse unmarried, no dates", ["spouse", "unmarried", "new-family", "slots"], spouse_intent(9010, ref(pk(9013)), "unmarried"))
def _(w, t):
    spouse_family(w, t, h("Person", 9010), h("Person", 9013), UNMARRIED)


@scenario("spouse-004", "spouse: an existing family with another type is updated, not duplicated", ["spouse", "reuse", "type"], spouse_intent(9002, ref(pk(9001)), "civil_union"))
def _(w, t):
    set_type(w, t, h("Family", 9001), CIVIL_UNION)


@scenario(
    "spouse-005",
    "spouse already recorded, marriage already on the family",
    ["spouse", "already-recorded", "warning"],
    spouse_intent(9002, ref(pk(9001)), "married", {"year": 1972, "about": False, "place": None}),
)
def _(w, t):
    pass


@scenario(
    "spouse-006",
    "spouse married in a place that is new",
    ["spouse", "married", "new-family", "place"],
    spouse_intent(
        9008,
        ref(pk(9009)),
        "married",
        {"year": 1991, "about": False, "place": {"new": {"name": "Sampleville", "type": "City", "enclosedBy": plk(9002)}}},
    ),
)
def _(w, t):
    spouse_family(w, t, h("Person", 9008), h("Person", 9009), MARRIED, {"year": 1991}, None, {"new": {"name": "Sampleville"}})


@scenario(
    "spouse-007",
    "spouse married in a place that exists",
    ["spouse", "married", "new-family", "place"],
    spouse_intent(9008, ref(pk(9009)), "married", {"year": 1991, "about": False, "place": {"ref": plk(9002)}}),
)
def _(w, t):
    spouse_family(w, t, h("Person", 9008), h("Person", 9009), MARRIED, {"year": 1991}, None, {"handle": h("Place", 9002)})


_STUB_SPOUSE = stub("Stubspouse", "Stubsurname", "male", 1960, "no")


@scenario(
    "spouse-008",
    "a new spouse (stub), widowed",
    ["spouse", "stub", "widowed", "new-family"],
    spouse_intent(9009, {"new": _STUB_SPOUSE}, "married", {"year": 1985, "about": False, "place": None}, {"how": "widowed", "year": 1999}),
)
def _(w, t):
    (spouse,) = build_stubs(w, t, [_STUB_SPOUSE])
    spouse_family(w, t, spouse, h("Person", 9009), MARRIED, {"year": 1985})


# ---- unlink ----------------------------------------------------------------------------------------------------
def unlink_intent(fam_n, person_n, as_):
    return {"type": "unlink", "family": fk(fam_n), "person": pk(person_n), "as": as_}


@scenario("unlink-001", "unlink a child", ["unlink", "child"], unlink_intent(9001, 9003, "child"))
def _(w, t):
    unlink_child(w, t, h("Family", 9001), h("Person", 9003))


@scenario("unlink-002", "unlink a partner", ["unlink", "partner"], unlink_intent(9001, 9001, "partner"))
def _(w, t):
    unlink_partner(w, t, h("Family", 9001), h("Person", 9001))


@scenario("unlink-003", "unlink the only partner of a family with no children", ["unlink", "partner", "warning"], unlink_intent(9002, 9005, "partner"))
def _(w, t):
    unlink_partner(w, t, h("Family", 9002), h("Person", 9005))


@scenario("unlink-004", "unlink a child who is not linked changes nothing", ["unlink", "child", "already-recorded"], unlink_intent(9001, 9012, "child"))
def _(w, t):
    pass


# --------------------------------------------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------------------------------------------
def run_scenario(sc, base):
    w = World()
    try:
        build_tree(w)
        w.created = []
        w.counter = 0
        if snapshot(w.db) != base:
            raise SystemExit("generator: the synthetic tree is not deterministic")
        with w.txn() as t:
            sc["proc"](w, t)
        after = snapshot(w.db)
        touched = sorted(k for k in after if k in base and after[k] != base[k])
        created = list(w.created)
        for k in created:
            if k not in after:
                raise SystemExit("generator: %s allocated %s and never created it" % (sc["id"], k))
        extra = sorted(k for k in after if k not in base and k not in created)
        if extra:
            raise SystemExit("generator: %s created objects it did not allocate: %s" % (sc["id"], extra))
        gone = sorted(k for k in base if k not in after)
        if gone:
            raise SystemExit("generator: %s deleted %s" % (sc["id"], gone))
        return {
            "id": sc["id"],
            "title": sc["title"],
            "tags": sc["tags"],
            "intent": sc["intent"],
            "gramps": {
                "created": created,
                "touched": touched,
                "objects": {k: after[k] for k in sorted(set(created) | set(touched))},
            },
        }
    finally:
        w.close()


def build():
    w = World()
    try:
        build_tree(w)
        base = snapshot(w.db)
    finally:
        w.close()
    return base, [run_scenario(sc, base) for sc in SCENARIOS]


def dumps_case(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render():
    base, scenarios = build()
    ids = [s["id"] for s in scenarios]
    if len(ids) != len(set(ids)):
        raise SystemExit("generator: duplicate scenario ids")
    body = {"tree": base, "scenarios": scenarios}
    digest = hashlib.sha256(dumps_case(body).encode("utf-8")).hexdigest()
    head = {
        "format": FORMAT_VERSION,
        "generator": GENERATOR,
        "gramps_version": GRAMPS_VERSION,
        "note": "Synthetic values only (placeholder names, ids I9001 and up). Every object under gramps was read back from a Gramps "
        "6.0.6 database after the steps Gramps' own editors perform. Regenerate with the generator (--check compares byte for byte). "
        "check_relationship_goldens.py verifies this file without Gramps.",
        "sha256": digest,
        "counts": {"tree_objects": len(base), "scenarios": len(scenarios)},
    }
    lines = ["{"]
    for k in head:
        lines.append("%s:%s," % (json.dumps(k), dumps_case(head[k])))
    lines.append('"tree":{')
    keys = sorted(base)
    for i, k in enumerate(keys):
        lines.append("%s:%s%s" % (json.dumps(k), dumps_case(base[k]), "," if i < len(keys) - 1 else ""))
    lines.append("},")
    lines.append('"scenarios":[')
    for i, row in enumerate(scenarios):
        lines.append(dumps_case(row) + ("," if i < len(scenarios) - 1 else ""))
    lines.append("]")
    lines.append("}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def main(argv):
    out = DEFAULT_OUT
    check = False
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--check":
            check = True
        elif a == "--out" and args:
            out = pathlib.Path(args.pop(0))
        else:
            raise SystemExit(__doc__)
    data = render()
    if check:
        if not out.exists():
            print("MISSING %s" % out)
            return 1
        if out.read_bytes() != data:
            print("DRIFT: %s differs from a fresh Gramps %s regeneration" % (out, GRAMPS_VERSION))
            return 1
        print("ok: %s matches a fresh Gramps %s regeneration byte for byte (%d bytes)" % (out, GRAMPS_VERSION, len(data)))
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print("wrote %s (%d bytes, Gramps %s)" % (out, len(data), GRAMPS_VERSION))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
