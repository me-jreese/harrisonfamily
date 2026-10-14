#!/usr/bin/env python3
"""Verify the Gramps semantics goldens without Gramps (HFY-TSK-249, review DL-14). Standard library only.

`api/test/records/fixtures/gramps-semantics.golden.json` holds values that Gramps 6.0.6 computed
(`gen-gramps-semantics-goldens.py`, which needs Gramps.app). This check lets any worker, and CI, trust the file
without Gramps. It checks:

* the header: format, Gramps version, counts, and the SHA-256 of the cases (a hand edit or a partial regeneration
  fails here);
* every Gregorian and Julian Date, against a second, independent computation: Python's own proleptic Gregorian
  ordinal for the Gregorian calendar and the textbook Julian-day formula for the Julian calendar. That covers the
  `sortval`, the slash-date move to the Julian calendar, the new-year offsets, the text-only and empty cases, and
  whether the date is valid (a day beyond its month is not);
* every other calendar's Date: shape only (Gramps is the only oracle for Hebrew, French, Persian, Islamic and
  Swedish);
* every birth/death case: the `birth_ref_index` and `death_ref_index` re-derived from the rule of
  `DbWriteBase.set_birth_death_index` (first primary-role Birth event and first primary-role Death event);
* that there are at least 200 valid Gregorian and Julian dates (acceptance criterion).

Usage:  python3 scripts/records/check_gramps_goldens.py [PATH]      exit 0 when the file is sound, 1 with the problems
"""

import calendar as _calendar
import datetime
import hashlib
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_PATH = REPO / "api" / "test" / "records" / "fixtures" / "gramps-semantics.golden.json"
EXPECTED_FORMAT = 1
EXPECTED_GRAMPS = "6.0.6"
GREGORIAN, JULIAN = 0, 1
TEXTONLY, RANGE, SPAN = 6, 4, 5
EVENT_BIRTH, EVENT_DEATH, ROLE_PRIMARY = 12, 13, 1  # EventType.BIRTH, EventType.DEATH, EventRoleType.PRIMARY
NEWYEAR_SPLIT = {1: (3, 1), 2: (3, 25), 3: (9, 1)}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def leap(cal, y):
    if cal == JULIAN:
        return y % 4 == 0
    return _calendar.isleap(y)


def month_len(cal, y, m):
    if m == 2:
        return 29 if leap(cal, y) else 28
    return 30 if m in (4, 6, 9, 11) else 31


def jdn(cal, y, m, d):
    """Julian day number, computed without the Gramps formulas."""
    if cal == GREGORIAN:
        if not 1 <= y <= 9999:
            return None
        return datetime.date(y, m, 1).toordinal() + 1721425 + (d - 1)
    # Julian calendar (Meeus / Richards): valid for the years used here, including negative ones
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    return d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - 32083


def split_parts(dv):
    return [tuple(dv[0:3])] + ([tuple(dv[4:7])] if len(dv) == 8 else [])


def expected_sortval(date):
    """Independent sortval of a Gregorian or Julian Date (None when it cannot be computed)."""
    if date["modifier"] == TEXTONLY:
        return 0
    cal = date["calendar"]
    d, m, y, slash = date["dateval"][0:4]
    if d == m == y == 0:
        return 0
    if slash and cal != JULIAN:
        cal = JULIAN
    ny = date["newyear"]
    if ny in NEWYEAR_SPLIT and (m, d) >= NEWYEAR_SPLIT[ny]:
        y -= 1  # the year starts later than January 1: a date past the split is sorted in the previous year
    y1, m1, d1 = (y if y != 0 else 1), max(m, 1), max(d, 1)
    return jdn(cal, y1, m1, d1)


def expected_valid(date):
    """Would Gramps' Date.set() accept the date? Day inside the month, month 1 to 12; zero parts are tolerated."""
    if date["modifier"] == TEXTONLY:
        return True
    cal = date["calendar"]
    for d, m, y in split_parts(date["dateval"]):
        if d == m == y == 0:
            continue
        if not 0 <= m <= 12 or d < 0:
            return False
        yy = y if y != 0 else 1
        if d > month_len(cal, yy, max(m, 1)):
            return False
    return True


def check(path):
    """Return the list of problems found in the golden file at `path`; empty when it is sound."""
    problems = []
    raw = pathlib.Path(path).read_bytes()
    try:
        doc = json.loads(raw)
    except ValueError as e:
        return ["not valid JSON: %s" % e]

    if doc.get("format") != EXPECTED_FORMAT:
        problems.append("format is %r, expected %d" % (doc.get("format"), EXPECTED_FORMAT))
    if doc.get("gramps_version") != EXPECTED_GRAMPS:
        problems.append("gramps_version is %r, expected %s" % (doc.get("gramps_version"), EXPECTED_GRAMPS))
    dates, bd = doc.get("dates", []), doc.get("birth_death", [])
    digest = hashlib.sha256(canonical({"dates": dates, "birth_death": bd}).encode("utf-8")).hexdigest()
    if doc.get("sha256") != digest:
        problems.append("sha256 does not match the cases (edited by hand, or regenerated in part)")
    counts = doc.get("counts", {})
    if counts.get("dates") != len(dates) or counts.get("birth_death") != len(bd):
        problems.append("counts do not match the cases")

    ids = [c.get("id") for c in dates] + [c.get("id") for c in bd]
    if len(ids) != len(set(ids)):
        problems.append("duplicate case ids")

    valid_gj = 0
    for c in dates:
        cid, date, g = c["id"], c["date"], c["gramps"]
        if set(date) != {"calendar", "modifier", "quality", "dateval", "text", "newyear"}:
            problems.append("%s: unexpected Date keys %s" % (cid, sorted(date)))
            continue
        if g["valid"] and not isinstance(g.get("sortval"), int):
            problems.append("%s: valid date without an integer sortval" % cid)
            continue
        if date["calendar"] not in (GREGORIAN, JULIAN):
            continue  # no independent oracle for the other calendars
        if g["valid"]:
            valid_gj += 1
        want_valid = expected_valid(date)
        empty = all(v == 0 for v in date["dateval"][0:3]) and date["modifier"] != TEXTONLY
        if g["valid"] != want_valid:
            problems.append("%s: Gramps says valid=%s, the independent rule says %s" % (cid, g["valid"], want_valid))
            continue
        if not g["valid"]:
            continue
        want_cal = JULIAN if (date["dateval"][3] and not empty and date["modifier"] != TEXTONLY) else date["calendar"]
        if g["calendar"] != want_cal:
            problems.append("%s: calendar %s, expected %s" % (cid, g["calendar"], want_cal))
        want = expected_sortval(date)
        if want is not None and g["sortval"] != want:
            problems.append("%s: sortval %s, the independent computation gives %s" % (cid, g["sortval"], want))
    if valid_gj < 200:
        problems.append("only %d valid Gregorian/Julian dates, 200 are required" % valid_gj)
    if counts.get("dates_gregorian_julian_valid") != valid_gj:
        problems.append("counts.dates_gregorian_julian_valid is %s, found %d" % (counts.get("dates_gregorian_julian_valid"), valid_gj))

    def indexes(st):
        birth = death = -1
        for i, ref in enumerate(st["event_ref_list"]):
            t = st["events"][ref["ref"]]
            if t == EVENT_BIRTH and ref["role"] == ROLE_PRIMARY and birth == -1:
                birth = i
            elif t == EVENT_DEATH and ref["role"] == ROLE_PRIMARY and death == -1:
                death = i
        return {"birth_ref_index": birth, "death_ref_index": death}

    kinds = {"state", "event_ref_list_change", "event_type_change"}
    for c in bd:
        if c.get("kind") not in kinds:
            problems.append("%s: unknown kind %r" % (c.get("id"), c.get("kind")))
            continue
        for side in ("before", "after"):
            st = c.get(side)
            if st is None:
                if side == "after" or c["kind"] != "state":
                    problems.append("%s: missing %s" % (c["id"], side))
                continue
            if indexes(st) != st["gramps"]:
                problems.append("%s (%s): indexes %s, the rule gives %s" % (c["id"], side, st["gramps"], indexes(st)))
        if c["kind"] == "event_type_change":
            b, a = c["before"], c["after"]
            if b["event_ref_list"] != a["event_ref_list"] or b["events"].keys() != a["events"].keys():
                problems.append("%s: an event type change must keep the event list" % c["id"])
        if c["kind"] == "event_ref_list_change" and c["before"]["event_ref_list"] == c["after"]["event_ref_list"]:
            problems.append("%s: an event list change must change the list" % c["id"])
    return problems


def main(argv):
    path = pathlib.Path(argv[0]) if argv else DEFAULT_PATH
    problems = check(path)
    if problems:
        for p in problems[:50]:
            print("FAIL %s" % p)
        print("%d problem(s) in %s" % (len(problems), path))
        return 1
    print("ok: %s is sound (standard library only, no Gramps)" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
