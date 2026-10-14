#!/usr/bin/env python3
"""Verify the relationship goldens without Gramps (HFY-TSK-251, review DL-14). Standard library only.

`api/test/records/fixtures/gramps-relationships.golden.json` holds what Gramps 6.0.6 left in a synthetic tree after the
steps its own editors perform for a relationship (`gen-gramps-relationship-goldens.py`, which needs Gramps.app). This
check lets any worker, and CI, trust the file without Gramps. It does not read Gramps' answer back as the truth: it
re-derives what the answer must satisfy, with its own code. It checks:

* the header: format, Gramps version, counts and the SHA-256 of the tree and scenarios (a hand edit or a partial
  regeneration fails here);
* the whole tree, before and after every scenario ("the overlay": the tree with the scenario's objects put over it):
  every handle names an object of the right class; family links are two-sided (`Family.father/mother = p` holds
  exactly when `p.family_list` has the Family; a ChildRef for `c` exists exactly when `c.parent_family_list` has it);
  no parent is its own child, father differs from mother, no child or family is listed twice; and nobody is their own
  ancestor;
* what a scenario may change: an existing Person changes only `family_list` and `parent_family_list`; an existing
  Family only its parents, children, type and events; lists grow by appending (the families already there keep their
  place), except for an unlink, which removes exactly the one entry;
* the slot rule on every new family: a man goes in `father_handle` and a woman in `mother_handle`, and otherwise the
  first person chosen is partner1 and the second partner2 (the order comes from the intent);
* the shape of every created object: an empty `gramps_id`, a stub's Birth Name primary name, a year-only Birth event
  whose `sortval` is computed here (the proleptic Gregorian ordinal plus the Julian day offset), `birth_ref_index` and
  `death_ref_index` re-derived from the event list, Marriage and Divorce events with role Family, and the family type;
* that the scenarios cover the cases the acceptance criteria name.

Usage:  python3 scripts/records/check_relationship_goldens.py [PATH]      exit 0 when the file is sound, 1 with the problems
"""

import datetime
import hashlib
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_PATH = REPO / "api" / "test" / "records" / "fixtures" / "gramps-relationships.golden.json"
EXPECTED_FORMAT = 1
EXPECTED_GRAMPS = "6.0.6"
FEMALE, MALE = 0, 1
EVENT_MARRIAGE, EVENT_DIVORCE, EVENT_BIRTH, EVENT_DEATH = 1, 7, 12, 13
ROLE_PRIMARY, ROLE_FAMILY = 1, 8
NAME_TYPE_BIRTH = 2
CHILD_REL = {"none": 0, "birth": 1, "adopted": 2, "step": 3, "sponsored": 4, "foster": 5, "unknown": 6}
PERSON_MAY_CHANGE = {"family_list", "parent_family_list"}
FAMILY_MAY_CHANGE = {"father_handle", "mother_handle", "child_ref_list", "type", "event_ref_list"}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def cls_of(k):
    return k.split(":", 1)[0]


def handle_of(k):
    return k.split(":", 1)[1]


def year_sortval(year):
    """Gramps' sortval of a year-only Gregorian date (January 1), computed without Gramps."""
    return datetime.date(year, 1, 1).toordinal() + 1721425


def expected_slots(chosen, genders):
    """The slot rule, written out independently: male to father, female to mother, otherwise selection order."""
    if len(chosen) == 1:
        return (None, chosen[0]) if genders[chosen[0]] == FEMALE else (chosen[0], None)
    a, b = chosen
    ga, gb = genders[a], genders[b]
    if ga == MALE and gb != MALE:
        return a, b
    if gb == MALE and ga != MALE:
        return b, a
    if ga == FEMALE and gb != FEMALE:
        return b, a
    if gb == FEMALE and ga != FEMALE:
        return a, b
    return a, b


def link_problems(objs, label):
    """Two-sided links, family sense, references and ancestry over a whole tree (a dict key -> object)."""
    out = []
    persons = {handle_of(k): o for k, o in objs.items() if cls_of(k) == "Person"}
    families = {handle_of(k): o for k, o in objs.items() if cls_of(k) == "Family"}
    events = {handle_of(k) for k in objs if cls_of(k) == "Event"}
    places = {handle_of(k) for k in objs if cls_of(k) == "Place"}
    for k, o in objs.items():
        if k != "%s:%s" % (o.get("_class"), o.get("handle")):
            out.append("%s: key %s does not match the object" % (label, k))
    for ph, p in persons.items():
        for field in ("family_list", "parent_family_list"):
            lst = p[field]
            if len(lst) != len(set(lst)):
                out.append("%s: Person %s lists a family twice in %s" % (label, ph[-4:], field))
        for fh in p["family_list"]:
            f = families.get(fh)
            if f is None:
                out.append("%s: Person %s lists a family that does not exist" % (label, ph[-4:]))
            elif ph not in (f["father_handle"], f["mother_handle"]):
                out.append("%s: Person %s lists Family %s but is not its parent" % (label, ph[-4:], fh[-4:]))
        for fh in p["parent_family_list"]:
            f = families.get(fh)
            if f is None:
                out.append("%s: Person %s lists a parent family that does not exist" % (label, ph[-4:]))
            elif not any(r["ref"] == ph for r in f["child_ref_list"]):
                out.append("%s: Person %s lists parent Family %s but is not its child" % (label, ph[-4:], fh[-4:]))
        for r in p["event_ref_list"]:
            if r["ref"] not in events:
                out.append("%s: Person %s has an event ref to nothing" % (label, ph[-4:]))
    for fh, f in families.items():
        fa, mo = f["father_handle"], f["mother_handle"]
        kids = [r["ref"] for r in f["child_ref_list"]]
        if fa and fa == mo:
            out.append("%s: Family %s has the same father and mother" % (label, fh[-4:]))
        if len(kids) != len(set(kids)):
            out.append("%s: Family %s lists a child twice" % (label, fh[-4:]))
        for parent in (fa, mo):
            if parent:
                if parent not in persons:
                    out.append("%s: Family %s has a parent that does not exist" % (label, fh[-4:]))
                elif fh not in persons[parent]["family_list"]:
                    out.append("%s: Family %s names a parent whose family_list lacks it" % (label, fh[-4:]))
                if parent in kids:
                    out.append("%s: Family %s has a parent who is also its child" % (label, fh[-4:]))
        for c in kids:
            if c not in persons:
                out.append("%s: Family %s has a child that does not exist" % (label, fh[-4:]))
            elif fh not in persons[c]["parent_family_list"]:
                out.append("%s: Family %s has a child whose parent_family_list lacks it" % (label, fh[-4:]))
        for r in f["event_ref_list"]:
            if r["ref"] not in events:
                out.append("%s: Family %s has an event ref to nothing" % (label, fh[-4:]))
    for k, o in objs.items():
        if cls_of(k) == "Event" and o["place"] and o["place"] not in places:
            out.append("%s: %s points to a place that does not exist" % (label, k[-8:]))
        if cls_of(k) == "Place":
            for r in o["placeref_list"]:
                if r["ref"] not in places:
                    out.append("%s: a place is enclosed by one that does not exist" % label)

    def parents(ph):
        res = []
        for fh in persons[ph]["parent_family_list"]:
            f = families.get(fh)
            if f:
                res += [x for x in (f["father_handle"], f["mother_handle"]) if x and x in persons]
        return res

    for start in persons:
        seen, stack = set(), list(parents(start))
        while stack:
            cur = stack.pop()
            if cur == start:
                out.append("%s: Person %s is their own ancestor" % (label, start[-4:]))
                break
            if cur in seen:
                continue
            seen.add(cur)
            stack += parents(cur)
    return out


def chosen_handles(intent, created_persons):
    """The people the intent chooses, in selection order, with each `new` person taken from the created list in turn."""
    stubs = iter(created_persons)

    def of(who):
        return handle_of(who["ref"]) if "ref" in who else handle_of(next(stubs))

    t = intent["type"]
    if t == "parents":
        return [of(p["who"]) for p in intent["parents"]]
    if t == "children":
        other = intent.get("otherParent") or {}
        chosen = [handle_of(intent["person"])]
        if "ref" in other or "new" in other:
            chosen.append(of(other))
        return chosen
    if t == "spouse":
        return [handle_of(intent["person"]), of(intent["spouse"])]
    return []


def stub_list(intent):
    t = intent["type"]
    whos = []
    if t == "parents":
        whos = [p["who"] for p in intent["parents"]]
    elif t == "children":
        other = intent.get("otherParent") or {}
        whos = ([other] if ("ref" in other or "new" in other) else []) + [c["who"] for c in intent["children"]]
    elif t == "spouse":
        whos = [intent["spouse"]]
    return [w["new"] for w in whos if "new" in w]


def date_problems(ev, year, label, modifier=0):
    out = []
    d = ev["date"]
    if d["dateval"] != [0, 0, year, False] or d["calendar"] != 0 or d["quality"] != 0 or d["text"] != "" or d["modifier"] != modifier:
        out.append("%s: the event date is not a year-only Gregorian date with the modifier chosen" % label)
    if d["sortval"] != year_sortval(year):
        out.append("%s: sortval %s, the independent computation gives %s" % (label, d["sortval"], year_sortval(year)))
    return out


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
    tree, scenarios = doc.get("tree", {}), doc.get("scenarios", [])
    digest = hashlib.sha256(canonical({"tree": tree, "scenarios": scenarios}).encode("utf-8")).hexdigest()
    if doc.get("sha256") != digest:
        problems.append("sha256 does not match the tree and scenarios (edited by hand, or regenerated in part)")
    counts = doc.get("counts", {})
    if counts.get("tree_objects") != len(tree) or counts.get("scenarios") != len(scenarios):
        problems.append("counts do not match the file")
    ids = [s.get("id") for s in scenarios]
    if len(ids) != len(set(ids)):
        problems.append("duplicate scenario ids")

    problems += link_problems(tree, "tree")
    for k, o in tree.items():
        if "change" in o:
            problems.append("tree: %s still carries a change stamp (a clock value)" % k[-8:])

    seen_tags = set()
    for sc in scenarios:
        sid = sc.get("id", "?")
        seen_tags.update(sc.get("tags", []))
        g = sc.get("gramps", {})
        created, touched, objects = g.get("created", []), g.get("touched", []), g.get("objects", {})
        if sorted(objects) != sorted(set(created) | set(touched)):
            problems.append("%s: objects are not exactly the created and touched keys" % sid)
            continue
        if len(created) != len(set(created)):
            problems.append("%s: a created key twice" % sid)
        for k in created:
            if k in tree:
                problems.append("%s: %s is created but already in the tree" % (sid, k[-8:]))
        for k in touched:
            if k not in tree:
                problems.append("%s: %s is touched but not in the tree" % (sid, k[-8:]))
            elif objects[k] == tree[k]:
                problems.append("%s: %s is listed as touched and did not change" % (sid, k[-8:]))
        if "already-recorded" in sc.get("tags", []) and (created or touched):
            problems.append("%s: an already-recorded scenario changed something" % sid)

        overlay = dict(tree)
        overlay.update(objects)
        problems += link_problems(overlay, sid)

        # what an existing object may change, and how its lists change
        intent = sc["intent"]
        for k in touched:
            before, after = tree[k], objects[k]
            diff = {f for f in set(before) | set(after) if before.get(f) != after.get(f)}
            allowed = PERSON_MAY_CHANGE if cls_of(k) == "Person" else FAMILY_MAY_CHANGE if cls_of(k) == "Family" else set()
            if diff - allowed:
                problems.append("%s: %s changed fields it should not: %s" % (sid, k[-8:], sorted(diff - allowed)))
            for field in ("family_list", "parent_family_list", "child_ref_list", "event_ref_list"):
                b, a = before.get(field, []), after.get(field, [])
                if b == a:
                    continue
                if intent["type"] == "unlink":
                    if len(b) - len(a) != 1 or [x for x in b if x not in a] == []:
                        problems.append("%s: %s.%s should lose exactly one entry" % (sid, k[-8:], field))
                elif a[: len(b)] != b:
                    problems.append("%s: %s.%s did not grow by appending" % (sid, k[-8:], field))

        # genders, for the slot rule
        genders = {handle_of(k): o["gender"] for k, o in overlay.items() if cls_of(k) == "Person"}
        created_persons = [k for k in created if cls_of(k) == "Person"]
        stubs = stub_list(intent)
        if len(stubs) != len(created_persons):
            problems.append("%s: %d stubs in the intent, %d people created" % (sid, len(stubs), len(created_persons)))
            continue
        chosen = chosen_handles(intent, created_persons)
        # the stubs, each in the shape the design asks for
        new_events = [k for k in created if cls_of(k) == "Event"]
        for spec, pk in zip(stubs, created_persons):
            p = objects[pk]
            nm = p["primary_name"]
            if p["gramps_id"] != "":
                problems.append("%s: a stub has a gramps_id" % sid)
            if nm["type"]["value"] != NAME_TYPE_BIRTH or nm["first_name"] != spec["given"]:
                problems.append("%s: a stub's primary name is not a Birth Name with the given name" % sid)
            if [s["surname"] for s in nm["surname_list"]] != ([spec["surname"]] if spec["surname"] else []) or any(not s["primary"] for s in nm["surname_list"]):
                problems.append("%s: a stub's surname is wrong" % sid)
            want_gender = {"female": FEMALE, "male": MALE, "unknown": 2}[spec.get("gender") or "unknown"]
            if p["gender"] != want_gender:
                problems.append("%s: a stub's gender is wrong" % sid)
            want = []
            if spec.get("birthYear"):
                want.append((EVENT_BIRTH, spec["birthYear"]))
            if spec.get("living") == "no" and spec.get("deathYear"):
                want.append((EVENT_DEATH, spec["deathYear"]))
            refs = p["event_ref_list"]
            if len(refs) != len(want):
                problems.append("%s: a stub has %d events, expected %d" % (sid, len(refs), len(want)))
            else:
                for r, (etype, year) in zip(refs, want):
                    ev = objects.get("Event:" + r["ref"])
                    if ev is None or ev["type"]["value"] != etype or r["role"]["value"] != ROLE_PRIMARY:
                        problems.append("%s: a stub's event is not a primary-role event of the expected type" % sid)
                    else:
                        problems += date_problems(ev, year, sid)
            birth_idx = next((i for i, (t, _y) in enumerate(want) if t == EVENT_BIRTH), -1)
            death_idx = next((i for i, (t, _y) in enumerate(want) if t == EVENT_DEATH), -1)
            if (p["birth_ref_index"], p["death_ref_index"]) != (birth_idx, death_idx):
                problems.append("%s: a stub's birth/death indexes are wrong" % sid)
        for k in created:
            o = objects[k]
            if o["gramps_id"] != "" or "change" in o:
                problems.append("%s: %s is not created with an empty gramps_id and no change stamp" % (sid, k[-8:]))

        # the slot rule on every new family, and the type
        for k in created:
            if cls_of(k) != "Family":
                continue
            f = objects[k]
            parents = [x for x in (f["father_handle"], f["mother_handle"]) if x]
            if sorted(parents) != sorted(chosen):
                problems.append("%s: the new family's parents are not the people chosen" % sid)
                continue
            want_f, want_m = expected_slots(chosen, genders)
            if (f["father_handle"] or None, f["mother_handle"] or None) != (want_f, want_m):
                problems.append("%s: the new family breaks the slot rule" % sid)
            if intent["type"] in ("parents", "children") and f["type"]["value"] != 3:
                problems.append("%s: a new parent family should have type Unknown (3)" % sid)
            if intent["type"] == "spouse":
                want_t = {"married": 0, "unmarried": 1, "civil_union": 2, "unknown": 3}[intent["relType"]]
                if f["type"]["value"] != want_t:
                    problems.append("%s: the new family's type is not the one chosen" % sid)
                kinds = []
                for r in f["event_ref_list"]:
                    ev = objects.get("Event:" + r["ref"])
                    if ev is None or r["role"]["value"] != ROLE_FAMILY:
                        problems.append("%s: a family event is missing or does not have the role Family" % sid)
                        continue
                    kinds.append(ev["type"]["value"])
                    if ev["type"]["value"] == EVENT_MARRIAGE:
                        married = intent.get("married") or {}
                        problems += date_problems(ev, married.get("year"), sid, 3 if married.get("about") else 0)
                    elif (intent.get("ended") or {}).get("year"):
                        problems += date_problems(ev, intent["ended"]["year"], sid)
                want_kinds = ([EVENT_MARRIAGE] if intent.get("married") else []) + ([EVENT_DIVORCE] if (intent.get("ended") or {}).get("how") == "divorced" else [])
                if kinds != want_kinds:
                    problems.append("%s: the family's events are %s, expected %s" % (sid, kinds, want_kinds))
            # ChildRef relations: the slot of each chosen parent takes that parent's relation
            if intent["type"] == "parents":
                rels = [CHILD_REL[p.get("rel", "birth")] for p in intent["parents"]]
                child_ref = next((c for c in f["child_ref_list"] if c["ref"] == handle_of(intent["person"])), None)
                if child_ref is None:
                    problems.append("%s: the new family has no ChildRef for the person" % sid)
                    continue
                for h, r in zip(chosen, rels):
                    got = child_ref["frel"]["value"] if f["father_handle"] == h else child_ref["mrel"]["value"]
                    if got != r:
                        problems.append("%s: a ChildRef relation does not match the one chosen" % sid)

    # the cases the acceptance criteria name
    def has(*tags):
        return any(all(t in sc.get("tags", []) for t in tags) for sc in scenarios)

    for need in (
        ("parents", "reuse"),
        ("parents", "single-parent", "reuse"),
        ("parents", "never-fill"),
        ("parents", "append"),
        ("parents", "stub"),
        ("children", "unknown-parent"),
        ("children", "stub"),
        ("spouse", "married", "divorced"),
        ("unlink", "child"),
        ("unlink", "partner"),
        ("already-recorded",),
    ):
        if not has(*need):
            problems.append("no scenario covers %s" % "+".join(need))
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
