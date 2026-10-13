#!/usr/bin/env python3
"""Generate the Gramps semantics goldens (HFY-TSK-249, edit-gramps-semantics): what Gramps 6.0.6 itself computes.

Runs under the Gramps bundle shim (`gramps_shim.py`, the same environment as `pln2/alive/run_alive.py`) on a Mac that
has Gramps.app 6.0.6. It reads no tree and no family data: every input is a synthetic value made here from a fixed
seed, and the output is deterministic, so a regeneration is byte-identical.

It writes `api/test/records/fixtures/gramps-semantics.golden.json` with two sections:

* `dates`: for each synthetic Date, what `Date.set()` does with it under Gramps' own code: whether Gramps accepts it
  (it raises `DateError` for a day beyond the month, a month 13 and the like), the `sortval` it computes and the
  calendar it ends in (a slash date is moved to the Julian calendar). At least 200 are Gregorian and Julian.
* `birth_death`: for each synthetic Person and its Events, the `birth_ref_index` and `death_ref_index` that Gramps'
  own `DbWriteBase.set_birth_death_index` sets, before and after an event-list change and after an Event type
  change.

Other workers test against this file without Gramps: `check_gramps_goldens.py` verifies it with the standard library
alone, and `api/test/records/semantics.node-test.js` runs the JavaScript implementation against it.

Usage:
    python3 scripts/records/gen-gramps-semantics-goldens.py            # write the file
    python3 scripts/records/gen-gramps-semantics-goldens.py --check    # regenerate in memory, compare byte for byte
    python3 scripts/records/gen-gramps-semantics-goldens.py --out PATH
"""

import hashlib
import json
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gramps_shim  # noqa: E402

GRAMPS_VERSION = gramps_shim.activate()

from gramps.gen.db import DbWriteBase  # noqa: E402
from gramps.gen.errors import DateError  # noqa: E402
from gramps.gen.lib import Date, Event, EventRef, EventRoleType, EventType, Person  # noqa: E402

REPO = HERE.parents[1]
DEFAULT_OUT = REPO / "api" / "test" / "records" / "fixtures" / "gramps-semantics.golden.json"
GENERATOR = "scripts/records/gen-gramps-semantics-goldens.py"
FORMAT_VERSION = 1
SEED = 249

# --------------------------------------------------------------------------------------------------------------
# Dates
# --------------------------------------------------------------------------------------------------------------
GREGORIAN, JULIAN, HEBREW, FRENCH, PERSIAN, ISLAMIC, SWEDISH = range(7)
NONE, BEFORE, AFTER, ABOUT, RANGE, SPAN, TEXTONLY, FROM, TO = range(9)
CAL_NAMES = {GREGORIAN: "gregorian", JULIAN: "julian", HEBREW: "hebrew", FRENCH: "french", PERSIAN: "persian", ISLAMIC: "islamic", SWEDISH: "swedish"}


def leap(cal, y):
    if cal == JULIAN:
        return y % 4 == 0
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def month_len(cal, y, m):
    if m == 2:
        return 29 if leap(cal, y) else 28
    return 30 if m in (4, 6, 9, 11) else 31


def make_date(cal, mod, dateval, quality=0, newyear=0, text=""):
    return {
        "calendar": cal,
        "modifier": mod,
        "quality": quality,
        "dateval": list(dateval),
        "text": text,
        "newyear": newyear,
    }


def gramps_says(spec):
    """Run Gramps' own Date.set() on the spec and report what it does."""
    d = Date()
    if spec["modifier"] != TEXTONLY and not any(spec["dateval"][i] for i in (0, 1, 2)):
        # An empty date is never passed through set(): Gramps keeps the default Date, whose sortval is 0.
        d.set_calendar(spec["calendar"])
        return {"valid": True, "sortval": d.get_sort_value(), "calendar": d.get_calendar()}
    try:
        d.set(
            quality=spec["quality"],
            modifier=spec["modifier"],
            calendar=spec["calendar"],
            value=tuple(spec["dateval"]),
            text=spec["text"],
            newyear=spec["newyear"],
        )
    except DateError:
        return {"valid": False}
    return {"valid": True, "sortval": d.get_sort_value(), "calendar": d.get_calendar()}


def date_cases():
    rnd = random.Random(SEED)
    cases = []

    def add(spec, *tags):
        cases.append({"date": spec, "tags": sorted(tags)})

    def rand_ymd(cal, lo=1000, hi=2025):
        y = rnd.randint(lo, hi)
        m = rnd.randint(1, 12)
        return y, m, rnd.randint(1, month_len(cal, y, m))

    # 1. plain full dates, both calendars
    for cal in (GREGORIAN, JULIAN):
        for _ in range(70):
            y, m, d = rand_ymd(cal)
            add(make_date(cal, NONE, (d, m, y, False)), "full")
    # 2. partial dates: year only, year and month, quality variants
    for cal in (GREGORIAN, JULIAN):
        for _ in range(12):
            y = rnd.randint(1000, 2025)
            add(make_date(cal, NONE, (0, 0, y, False)), "year-only")
        for _ in range(10):
            y, m, _d = rand_ymd(cal)
            add(make_date(cal, NONE, (0, m, y, False), quality=rnd.choice((0, 1, 2))), "year-month")
    # 3. month ends and leap days, both calendars
    for cal in (GREGORIAN, JULIAN):
        for y in (1000, 1500, 1600, 1700, 1800, 1900, 1904, 1996, 2000, 2004, 2024):
            for m, d in ((1, 1), (2, 28), (2, 29), (12, 31)):
                if d <= month_len(cal, y, m):
                    add(make_date(cal, NONE, (d, m, y, False)), "edge")
    # 4. the calendar cutover, and year 1
    for cal in (GREGORIAN, JULIAN):
        for d, m, y in ((4, 10, 1582), (5, 10, 1582), (14, 10, 1582), (15, 10, 1582), (1, 1, 1), (31, 12, 999), (25, 12, 800)):
            add(make_date(cal, NONE, (d, m, y, False)), "edge")
    # 5. modifiers: the first part decides the sortval; the second part of a range or span does not
    for cal in (GREGORIAN, JULIAN):
        for mod in (BEFORE, AFTER, ABOUT, FROM, TO):
            for _ in range(3):
                y, m, d = rand_ymd(cal)
                add(make_date(cal, mod, (d, m, y, False), quality=rnd.choice((0, 1, 2))), "modifier")
        for mod in (RANGE, SPAN):
            for _ in range(5):
                y, m, d = rand_ymd(cal, 1000, 2000)
                y2, m2, d2 = rand_ymd(cal, y, 2025)
                add(make_date(cal, mod, (d, m, y, False, d2, m2, y2, False)), "compound")
    # 6. dual-dated slash dates: Gramps moves a Gregorian slash date to the Julian calendar
    for cal in (GREGORIAN, JULIAN):
        for _ in range(6):
            y, m, d = rand_ymd(cal, 1500, 1752)
            add(make_date(cal, NONE, (d, m, y, True)), "slash")
    # 7. new-year offsets (Mar 1, Mar 25, Sep 1), on both sides of the split
    for cal in (GREGORIAN, JULIAN):
        for ny, (sm, sd) in ((1, (3, 1)), (2, (3, 25)), (3, (9, 1))):
            for (m, d) in ((sm, sd - 1 if sd > 1 else 28), (sm, sd), (sm, sd + 1 if sd < 28 else sd), (12, 31), (1, 1)):
                if m == 2 and d == 29:
                    continue
                add(make_date(cal, NONE, (d, m, 1700, False), newyear=ny), "newyear")
    # 8. text-only and empty dates
    add(make_date(GREGORIAN, TEXTONLY, (0, 0, 0, False), text="sometime in the spring"), "text")
    add(make_date(GREGORIAN, NONE, (0, 0, 0, False)), "empty")
    add(make_date(JULIAN, NONE, (0, 0, 0, False)), "empty")
    # 9. dates Gramps refuses, or accepts in an odd way. `strict` ones our member rules also refuse.
    for cal in (GREGORIAN, JULIAN):
        add(make_date(cal, NONE, (30, 2, 1950, False)), "invalid", "day-beyond-month")
        add(make_date(cal, NONE, (31, 4, 1950, False)), "invalid", "day-beyond-month")
        add(make_date(cal, NONE, (31, 6, 1950, False)), "invalid", "day-beyond-month")
        add(make_date(cal, NONE, (32, 1, 1950, False)), "invalid", "day-beyond-month")
        add(make_date(cal, NONE, (31, 9, 1700, False)), "invalid", "day-beyond-month")
        add(make_date(cal, NONE, (5, 13, 1950, False)), "invalid", "month-beyond-year")
        add(make_date(cal, NONE, (1, 14, 1950, False)), "invalid", "month-beyond-year")
        add(make_date(cal, NONE, (29, 2, 1953, False)), "invalid", "day-beyond-month")
    add(make_date(GREGORIAN, NONE, (29, 2, 1900, False)), "invalid", "day-beyond-month")
    add(make_date(JULIAN, NONE, (29, 2, 1900, False)), "leap-day")  # a leap year in the Julian calendar
    add(make_date(GREGORIAN, NONE, (29, 2, 1700, False)), "invalid", "day-beyond-month")
    add(make_date(JULIAN, NONE, (29, 2, 1700, False)), "leap-day")
    add(make_date(GREGORIAN, NONE, (29, 2, 2000, False)), "leap-day")
    # quirks: Gramps accepts these and fills the missing parts with 1; our member rules ask for a month and a year
    add(make_date(GREGORIAN, NONE, (5, 0, 1950, False)), "day-without-month")
    add(make_date(JULIAN, NONE, (5, 0, 1950, False)), "day-without-month")
    add(make_date(GREGORIAN, NONE, (0, 7, 0, False)), "month-without-year")
    add(make_date(GREGORIAN, NONE, (12, 7, 0, False)), "month-without-year")
    # 10. other calendars: admins only on the site; the sortval still has to match Gramps
    others = {
        HEBREW: [(1, 1, 5700), (15, 7, 5700), (29, 6, 5700), (30, 3, 5762), (5, 13, 5755), (1, 12, 5780), (22, 4, 5601), (9, 2, 5725), (10, 5, 5710), (3, 9, 5800)],
        FRENCH: [(1, 1, 1), (22, 9, 3), (30, 12, 6), (5, 13, 8), (15, 6, 10), (1, 4, 12), (29, 2, 4), (11, 11, 7)],
        PERSIAN: [(1, 1, 1300), (31, 1, 1350), (15, 7, 1380), (30, 12, 1399), (1, 8, 1250), (10, 10, 1200), (5, 3, 1100), (20, 6, 900)],
        ISLAMIC: [(1, 1, 1300), (10, 12, 1350), (15, 7, 1400), (29, 6, 1200), (1, 9, 1100), (29, 2, 1250), (12, 3, 800), (4, 10, 1000)],
        SWEDISH: [(1, 3, 1700), (30, 2, 1712), (28, 2, 1712), (1, 3, 1712), (25, 12, 1740), (17, 2, 1753), (1, 3, 1753), (15, 6, 1800), (1, 1, 1650)],
    }
    for cal, rows in others.items():
        for d, m, y in rows:
            add(make_date(cal, NONE, (d, m, y, False)), "other-calendar", CAL_NAMES[cal])
        add(make_date(cal, NONE, (0, 0, rows[0][2], False)), "other-calendar", CAL_NAMES[cal], "year-only")
        # a range starts before it ends: order the two sample dates by what Gramps computes for each
        pair = sorted(rows[1:3], key=lambda r: gramps_says(make_date(cal, NONE, (r[0], r[1], r[2], False)))["sortval"])
        add(make_date(cal, RANGE, (pair[0][0], pair[0][1], pair[0][2], False, pair[1][0], pair[1][1], pair[1][2], False)), "other-calendar", CAL_NAMES[cal], "compound")
    return cases


def build_dates():
    out = []
    for i, c in enumerate(date_cases(), 1):
        out.append({"id": "date-%03d" % i, "date": c["date"], "tags": c["tags"], "gramps": gramps_says(c["date"])})
    return out


# --------------------------------------------------------------------------------------------------------------
# Birth and death index
# --------------------------------------------------------------------------------------------------------------
EVENT_TYPES = [
    EventType.BIRTH, EventType.DEATH, EventType.BAPTISM, EventType.BURIAL, EventType.CHRISTEN, EventType.CREMATION,
    EventType.MARRIAGE, EventType.RESIDENCE, EventType.OCCUPATION, EventType.STILLBIRTH, EventType.CUSTOM, EventType.UNKNOWN,
    EventType.BIRTH, EventType.DEATH,
]
ROLE_NAMES = ("PRIMARY", "CLERGY", "CELEBRANT", "AIDE", "BRIDE", "GROOM", "WITNESS", "FAMILY", "INFORMANT", "UNKNOWN", "CUSTOM")
ROLES = sorted({getattr(EventRoleType, n) for n in ROLE_NAMES if hasattr(EventRoleType, n)})


class _Db:
    """Just enough of a database for set_birth_death_index, which calls only get_event_from_handle."""

    def __init__(self, events):
        self.events = events

    def get_event_from_handle(self, handle):
        return self.events[handle]


def gramps_indexes(event_types, refs):
    """Run Gramps' own DbWriteBase.set_birth_death_index on a Person built from refs [(event handle, role value)]."""
    events = {}
    for handle, tv in event_types.items():
        ev = Event()
        ev.set_handle(handle)
        ev.set_type(EventType(tv))
        events[handle] = ev
    person = Person()
    ref_list = []
    for handle, role in refs:
        er = EventRef()
        er.ref = handle
        er.set_role(EventRoleType(role))
        ref_list.append(er)
    # set_event_ref_list, not add_event_ref: add_event_ref drops a ref equal to one already there, and a stored
    # Person can carry such a list.
    person.set_event_ref_list(ref_list)
    DbWriteBase.set_birth_death_index(_Db(events), person)
    return {"birth_ref_index": person.birth_ref_index, "death_ref_index": person.death_ref_index}


def state(event_types, refs):
    return {
        "events": dict(sorted(event_types.items())),
        "event_ref_list": [{"ref": h, "role": r} for h, r in refs],
        "gramps": gramps_indexes(event_types, refs),
    }


def birth_death_cases():
    rnd = random.Random(SEED + 1)
    cases = []

    def rand_state(n_events):
        handles = ["E%d" % i for i in range(1, n_events + 1)]
        types = {h: rnd.choice(EVENT_TYPES) for h in handles}
        refs = []
        for h in handles:
            refs.append((h, 1 if rnd.random() < 0.7 else rnd.choice(ROLES)))
            if rnd.random() < 0.08:
                refs.append((h, rnd.choice(ROLES)))  # the same event referenced twice
        rnd.shuffle(refs)
        return types, refs

    # fixed, readable scenarios first
    fixed = [
        ("no events", {}, []),
        ("birth only", {"E1": EventType.BIRTH}, [("E1", 1)]),
        ("death only", {"E1": EventType.DEATH}, [("E1", 1)]),
        ("birth and death", {"E1": EventType.BIRTH, "E2": EventType.DEATH}, [("E1", 1), ("E2", 1)]),
        ("death listed before birth", {"E1": EventType.DEATH, "E2": EventType.BIRTH}, [("E1", 1), ("E2", 1)]),
        ("two births, the first wins", {"E1": EventType.BIRTH, "E2": EventType.BIRTH}, [("E1", 1), ("E2", 1)]),
        ("two deaths, the first wins", {"E1": EventType.DEATH, "E2": EventType.DEATH}, [("E1", 1), ("E2", 1)]),
        ("a non-primary birth does not count", {"E1": EventType.BIRTH, "E2": EventType.BIRTH}, [("E1", EventRoleType.WITNESS), ("E2", 1)]),
        ("baptism is not a birth", {"E1": EventType.BAPTISM, "E2": EventType.BURIAL}, [("E1", 1), ("E2", 1)]),
        ("stillbirth is neither", {"E1": EventType.STILLBIRTH}, [("E1", 1)]),
        ("same birth event referenced twice", {"E1": EventType.BIRTH}, [("E1", EventRoleType.WITNESS), ("E1", 1)]),
        ("custom type is neither", {"E1": EventType.CUSTOM, "E2": EventType.UNKNOWN}, [("E1", 1), ("E2", 1)]),
    ]
    for title, types, refs in fixed:
        cases.append({"title": title, "kind": "state", "after": state(types, refs)})

    # random states
    for _ in range(60):
        types, refs = rand_state(rnd.randint(1, 7))
        cases.append({"title": "random state", "kind": "state", "after": state(types, refs)})

    # event_ref_list changes: the same Person before and after an add, remove, reorder or role change
    for _ in range(50):
        types, refs = rand_state(rnd.randint(2, 7))
        before = state(types, refs)
        refs2 = list(refs)
        how = rnd.choice(("remove", "reorder", "role", "add"))
        types2 = dict(types)
        if how == "remove" and refs2:
            refs2.pop(rnd.randrange(len(refs2)))
        elif how == "reorder":
            rnd.shuffle(refs2)
        elif how == "role" and refs2:
            i = rnd.randrange(len(refs2))
            refs2[i] = (refs2[i][0], rnd.choice(ROLES))
        else:
            h = "E%d" % (len(types) + 1)
            types2[h] = rnd.choice(EVENT_TYPES)
            refs2.insert(rnd.randint(0, len(refs2)), (h, 1))
            how = "add"
        if refs2 == refs:
            continue
        cases.append({"title": "event_ref_list change (%s)" % how, "kind": "event_ref_list_change", "before": before, "after": state(types2, refs2)})

    # Event type changes: the Person is untouched, one or two of its Events change type
    for _ in range(50):
        types, refs = rand_state(rnd.randint(1, 6))
        before = state(types, refs)
        types2 = dict(types)
        for h in rnd.sample(sorted(types2), k=min(len(types2), rnd.choice((1, 1, 2)))):
            types2[h] = rnd.choice([t for t in [EventType.BIRTH, EventType.DEATH] * 3 + EVENT_TYPES if t != types2[h]])
        cases.append({"title": "event type change", "kind": "event_type_change", "before": before, "after": state(types2, refs)})

    for i, c in enumerate(cases, 1):
        c["id"] = "bd-%03d" % i
    return cases


# --------------------------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------------------------
def dumps_case(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render():
    dates = build_dates()
    bd = birth_death_cases()
    greg_julian_valid = [c for c in dates if c["date"]["calendar"] in (GREGORIAN, JULIAN) and c["gramps"]["valid"]]
    if len(greg_julian_valid) < 200:
        raise SystemExit("generator: only %d valid Gregorian/Julian dates, the acceptance criterion asks for 200" % len(greg_julian_valid))
    body = {"dates": dates, "birth_death": bd}
    digest = hashlib.sha256(dumps_case(body).encode("utf-8")).hexdigest()
    head = {
        "format": FORMAT_VERSION,
        "generator": GENERATOR,
        "gramps_version": GRAMPS_VERSION,
        "seed": SEED,
        "note": "Synthetic values only. Every expected value was computed by Gramps itself under the bundle shim. "
        "Regenerate with the generator (--check compares byte for byte). check_gramps_goldens.py verifies this file without Gramps.",
        "sha256": digest,
        "counts": {
            "dates": len(dates),
            "dates_gregorian_julian_valid": len(greg_julian_valid),
            "birth_death": len(bd),
        },
    }
    lines = ["{"]
    for k in head:
        lines.append("%s:%s," % (json.dumps(k), dumps_case(head[k])))
    for section in ("dates", "birth_death"):
        lines.append("%s:[" % json.dumps(section))
        rows = body[section]
        for i, row in enumerate(rows):
            lines.append(dumps_case(row) + ("," if i < len(rows) - 1 else ""))
        lines.append("]" + ("," if section == "dates" else ""))
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
