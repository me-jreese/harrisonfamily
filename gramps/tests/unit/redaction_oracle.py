"""Reference oracle for the redaction vectors (task redaction-policy-v1). Test code only.

This is the executable reading of ``gramps/redaction/redaction-v1.json`` that the golden vectors are checked against:

    project(objects, context)  ->  {"projection", "excluded", "holds"}      the desktop side, P(tree)
    check(objects)             ->  {"ok", "violations"}                      the server side, detection only

It is NOT the projection (``projection-py``) and NOT the server validator (``validator-js``): those later tasks implement
the same rules for production and must pass the same vectors. The oracle exists so that a vector is never a guess: every
vector's expected values are written by hand in ``gramps/redaction/make_vectors.py`` and this code must reproduce them from
the rules, so a mistake in either shows up as a failing test. It also runs the whole synthetic fixture tree (section 5.6
invariants).

Context keys (all optional): ``base`` {handle: last synced projected object}, ``files`` {media handle: {"exif_gps": bool,
"md5": str, "readable": bool}}, ``released`` [media handles io released], ``sticky`` [event handles that were ever birth-like].
"""
import copy
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "gramps"))
sys.path.insert(0, os.path.join(REPO, "gramps", "tests", "fixtures"))

from hfygramps import rules as R  # noqa: E402
from hfygramps import scanner  # noqa: E402
import census  # noqa: E402

PRIMARY = ("Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag", "Researcher")
MONTHS = census.MONTHS
ORDINAL = r"(?:st|nd|rd|th)?"


def _esc(k):
    return str(k).replace("~", "~0").replace("/", "~1")


def _dicts(node, ptr=""):
    """(pointer, dict) for every dict in the value, root first."""
    if isinstance(node, dict):
        yield ptr, node
        for k, v in node.items():
            yield from _dicts(v, ptr + "/" + _esc(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _dicts(v, ptr + "/" + str(i))


def _strings(node, ptr=""):
    if isinstance(node, str):
        yield ptr, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(v, ptr + "/" + _esc(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _strings(v, ptr + "/" + str(i))


def scan_fields(obj, policy):
    """(pointer, text) of every outgoing free-text field of one object (sync.md 5.4)."""
    table = {}
    for f in policy["scan"]["fields"]:
        table.setdefault(f["class"], []).append(f["path"])
    for ptr, node in _dicts(obj):
        for path in table.get(node.get("_class"), []):
            v = R.pointer_get(node, path)
            if isinstance(v, str) and v:
                yield ptr + path, v


def _scan_kinds(text, policy):
    kinds = []
    for f in scanner.scan_text(text):
        if f["kind"] in policy["scan"]["kinds"] and f["kind"] not in kinds:
            kinds.append(f["kind"])
    return kinds


def local_dobs(tree, policy):
    """[{"person", "name", "ymd", "calendar"}]: every day-precise date of a birth-like event of a person, local tree."""
    out = []
    for p in tree.of_class("Person"):
        first = (p.get("primary_name") or {}).get("first_name") or ""
        for ref in p.get("event_ref_list") or []:
            ev = tree.by_handle.get(ref.get("ref"))
            if ev is None or not R.is_birth_like(ev, tree, policy):
                continue
            d = ev.get("date") or {}
            for second in (False, True):
                ymd = R.date_ymd(d, second)
                if ymd:
                    out.append({"person": p["handle"], "name": first, "ymd": ymd, "calendar": d.get("calendar", 0)})
    return out


def _partial_forms(ymd):
    y, m, d = ymd
    mon = MONTHS[m - 1]
    names = "(?:%s|%s)" % (mon, mon[:3])
    return [
        r"(?<![A-Za-z0-9])%s\.? 0?%d%s(?![0-9A-Za-z])" % (names, d, ORDINAL),
        r"(?<![A-Za-z0-9])0?%d%s (?:of )?%s(?![A-Za-z])" % (d, ORDINAL, names),
        r"(?<![0-9/])0?%d/0?%d(?![0-9/])" % (m, d),
        r"(?<![0-9.])0?%d\.0?%d\.(?![0-9])" % (d, m),
    ]


def dob_exact_hit(text, dobs, policy):
    """True when the text holds a full local birth date in a listed form, or a day-and-month form near a birth keyword or name."""
    window = policy["scan"]["dobWindow"]
    for dob in dobs:
        y, m, d = dob["ymd"]
        if any(r in text for r in census.dob_renderings(y, m, d)):
            return True
        anchors = [(k.start(), k.end()) for k in re.finditer(
            r"(?<![a-z])(?:%s)(?![a-z])" % "|".join(re.escape(w) for w in sorted(scanner.BIRTHDAY_KEYWORDS, key=len, reverse=True)),
            text, re.I)]
        if dob["name"]:
            anchors += [(k.start(), k.end()) for k in re.finditer(re.escape(dob["name"]), text, re.I)]
        for form in _partial_forms(dob["ymd"]):
            for hit in re.finditer(form, text):
                if any(max(0, a - hit.end(), hit.start() - b) <= window for a, b in anchors):
                    return True
    return False


# ---------------------------------------------------------------------------------------------------------------------
# The desktop side.


def _remove_private_elements(obj, policy, removed, fired):
    for r in policy["rules"]:
        if r["phase"] != "elements" or obj.get("_class") not in r["objectClass"]:
            continue
        want = r.get("params", {}).get("elementClass")
        for ptr in R.match_pointers(obj, r["path"]):
            node = R.pointer_get(obj, ptr)
            if isinstance(node, dict) and node.get("private") is True and (want is None or node.get("_class") == want):
                removed.append(ptr)
                fired.add(r["id"])
    R.pointer_remove(obj, removed)


def _edges(original, removed_by_handle, handles):
    """target handle -> [(source handle, dead)] over the original objects. An edge is dead when it sits in a removed element."""
    edges = {}
    for o in original:
        h = o.get("handle")
        dead_roots = removed_by_handle.get(h, [])
        for ptr, s in _strings(o):
            if s in handles and s != h:
                dead = any(ptr == d or ptr.startswith(d + "/") for d in dead_roots)
                edges.setdefault(s, []).append((h, dead))
    return edges


def project(objects, context=None, policy=None):
    pol = policy or R.load_policy()
    ctx = context or {}
    base = ctx.get("base") or {}
    files = ctx.get("files") or {}
    released = set(ctx.get("released") or [])
    sticky = set(ctx.get("sticky") or [])
    tree = R.Tree(objects)
    original = tree.objects
    handles = {h for h, o in tree.by_handle.items() if o.get("_class") in PRIMARY}
    dobs = local_dobs(tree, pol)
    dob_set = {(d["calendar"], d["ymd"]) for d in dobs}

    excluded = {}  # handle -> rule id
    fired = set()  # every rule id that changed or withheld something
    holds = []     # {"handle", "rule", "scope", "pointer"}
    held_whole = {}  # handle -> [rule ids]

    # 1. classify
    for o in original:
        h, cls = o.get("handle"), o.get("_class")
        if cls == "Researcher":
            excluded[h] = "contact.researcher"
        elif o.get("private") is True and cls in PRIMARY:
            excluded[h] = "private.object.exclude"
        elif cls == "Place" and R.place_exclusion_rule(o, pol):
            excluded[h] = R.place_exclusion_rule(o, pol)
    for p in tree.of_class("Person"):
        if p["handle"] not in excluded and (p.get("primary_name") or {}).get("private") is True:
            held_whole.setdefault(p["handle"], []).append("private.name.hold_person")
    birth_media = set()
    for e in tree.of_class("Event"):
        if R.is_birth_like(e, tree, pol):
            birth_media.update(r.get("ref") for r in e.get("media_list") or [])
    for c in tree.of_class("Citation"):
        if c["handle"] in tree.birth_citation_handles(pol):
            birth_media.update(r.get("ref") for r in c.get("media_list") or [])
    for m in tree.of_class("Media"):
        h = m["handle"]
        if h in excluded or h in released:
            continue
        f = files.get(h) or {}
        if f.get("exif_gps") and m.get("mime") in pol["media"]["exifGpsMime"]:
            held_whole.setdefault(h, []).append("media.exif_gps.hold")
        if h in birth_media:
            held_whole.setdefault(h, []).append("media.birth_linked.hold")
        if m.get("mime") in pol["media"]["heldMime"]:
            held_whole.setdefault(h, []).append("media.pdf.hold")

    # 2/3. elements and fields, on a copy of every kept object
    proj, removed_by_handle = {}, {}
    for o in original:
        h = o.get("handle")
        if h in excluded:
            continue
        obj = copy.deepcopy(o)
        removed = []
        _remove_private_elements(obj, pol, removed, fired)
        removed_by_handle[h] = removed
        _fields(obj, tree, pol, ctx, dob_set, sticky, files, base.get(h), holds, fired)
        proj[h] = obj

    # 4. scan
    new_holds = {}
    for h, obj in list(proj.items()):
        if obj.get("_class") == "Researcher" or h in held_whole:
            continue
        hits = []
        for ptr, text in scan_fields(obj, pol):
            for kind in _scan_kinds(text, pol):
                hits.append(("scan." + kind, ptr))
            if dob_exact_hit(text, dobs, pol):
                hits.append(("scan.dob_exact", ptr))
        if not hits:
            continue
        b = base.get(h)
        if b is not None and all(R.pointer_get(b, _revert_pointer(p), _MISSING) is not _MISSING for _, p in hits):
            for rule_id, ptr in hits:
                R.pointer_set(obj, _revert_pointer(ptr), copy.deepcopy(R.pointer_get(b, _revert_pointer(ptr))))
                holds.append({"handle": h, "rule": rule_id, "scope": "field", "pointer": ptr})
        else:
            for rule_id, ptr in hits:
                holds.append({"handle": h, "rule": rule_id, "scope": "object", "pointer": ptr})
            new_holds[h] = True

    # whole-object holds: the cloud keeps the base object, or has none
    for h, rule_ids in held_whole.items():
        for rid in rule_ids:
            holds.append({"handle": h, "rule": rid, "scope": "object", "pointer": ""})
    absent = set(excluded)
    for h in list(held_whole) + list(new_holds):
        if h not in base:
            absent.add(h)

    # 5. private by association, repeated until nothing changes
    orphan_classes = set(next(r for r in pol["rules"] if r["id"] == "private.orphan.exclude")["objectClass"])
    edges = _edges(original, removed_by_handle, handles)
    changed = True
    while changed:
        changed = False
        for t in sorted(handles):
            o = tree.by_handle[t]
            if t in absent or (o.get("_class") not in orphan_classes and o.get("_class") != "Citation"):
                continue
            es = edges.get(t, [])
            if o.get("_class") == "Citation" and o.get("source_handle") in absent:
                excluded[t] = "private.citation.source_excluded"
                absent.add(t)
                changed = True
            elif es and all(dead or src in absent for src, dead in es):
                excluded[t] = "private.orphan.exclude"
                absent.add(t)
                changed = True

    # 6. references
    for h, obj in proj.items():
        if h in absent:
            continue
        _references(obj, tree, absent, excluded, pol, fired)

    projection = {}
    for o in original:
        h = o.get("handle")
        if h in excluded or (h in absent):
            projection[h] = None
        elif h in held_whole or h in new_holds:
            projection[h] = copy.deepcopy(base[h])
        else:
            projection[h] = proj[h]
    # a held object's holds are meaningless when the object was also excluded afterwards
    holds = [x for x in holds if x["handle"] not in excluded]
    holds.sort(key=lambda x: (x["handle"], x["rule"], x["pointer"], x["scope"]))
    for x in holds:
        fired.add(x["rule"])
    fired.update(excluded.values())
    return {
        "projection": projection,
        "excluded": [{"handle": h, "rule": r} for h, r in sorted(excluded.items())],
        "holds": holds,
        "fired": sorted(fired),
    }


_MISSING = object()


def _revert_pointer(pointer):
    """A Note's text is one atomic field: holding it keeps the base tags too."""
    return "/text" if pointer == "/text/string" else pointer


def _reduce_in_place(node, pol, rule_ids, fired):
    """Reduce one Date in place; a rule fires only when it changed something."""
    before = copy.deepcopy(node)
    node.update(R.reduce_date(node, pol))
    dv0 = before.get("dateval") or []
    day_month = any(i < len(dv0) and dv0[i] for i in pol["dates"]["dayMonthIndexes"])
    if rule_ids[0] == "birth.date.daymonth":
        if day_month:
            fired.add(rule_ids[0])
    elif node != before:
        fired.add(rule_ids[0])
    if before.get("sortval") != node.get("sortval") and rule_ids[0] == "birth.date.daymonth":
        fired.add("birth.date.sortval")


def _fields(obj, tree, pol, ctx, dob_set, sticky, files, base_obj, holds, fired):
    cls = obj.get("_class")
    h = obj.get("handle")
    # dates
    if cls == "Event" and obj.get("date"):
        if R.is_birth_like(obj, tree, pol):
            had_text = obj["date"].get("text") or ""
            was_textonly = obj["date"].get("modifier") == pol["dates"]["textOnlyModifier"]
            _reduce_in_place(obj["date"], pol, ["birth.date.daymonth"], fired)
            if had_text:
                fired.add("birth.date.text")
            if was_textonly:
                fired.add("birth.date.textonly")
        elif h in sticky:
            _reduce_in_place(obj["date"], pol, ["birth.sticky"], fired)
    if cls == "Citation" and h in tree.birth_citation_handles(pol) and obj.get("date"):
        _reduce_in_place(obj["date"], pol, ["birth.citation.date"], fired)
    if cls == "Person":
        names = [obj["primary_name"]] if obj.get("primary_name") else []
        names += obj.get("alternate_names") or []
        for n in names:
            if (n.get("type") or {}).get("value") == pol["dates"]["nameTypeBirth"] and n.get("date"):
                _reduce_in_place(n["date"], pol, ["birth.name.date"], fired)
    for _, node in _dicts(obj):
        if node.get("_class") == "Date":
            for second in (False, True):
                ymd = R.date_ymd(node, second)
                if ymd and (node.get("calendar", 0), ymd) in dob_set:
                    _reduce_in_place(node, pol, ["birth.dob_exact.date"], fired)
                    break
    # attributes, lists
    drop = []
    for ptr in R.match_pointers(obj, "/**/attribute_list/*"):
        el = R.pointer_get(obj, ptr)
        rid = R.attribute_rule(el, pol) if isinstance(el, dict) else None
        if rid:
            drop.append(ptr)
            fired.add(rid)
    R.pointer_remove(obj, drop)
    if cls == "Person":
        if obj.get("lds_ord_list"):
            fired.add("birth.lds_ord")
        obj["lds_ord_list"] = []
    if cls in ("Person", "Repository"):
        if obj.get("address_list"):
            fired.add("contact.address_list")
        obj["address_list"] = []
    if cls in ("Person", "Place", "Repository"):
        keep = []
        for u in obj.get("urls") or []:
            hit = R.url_rules(u, _scan_any, pol)
            if hit:
                fired.update(hit)
            else:
                keep.append(u)
        obj["urls"] = keep
    if cls == "Place":
        fields = pol["places"]["locationFields"]
        locs = []
        for loc in obj.get("alt_loc") or []:
            for f in fields:
                if loc.get(f):
                    loc[f] = ""
                    fired.add("contact.alt_loc.fields")
            if any(isinstance(v, str) and v for k, v in loc.items() if not k.startswith("_")):
                locs.append(loc)
            else:
                fired.add("contact.alt_loc.empty")
        obj["alt_loc"] = locs
        if obj.get("code") and R.place_code_is_local(obj, pol):
            fired.add("place.code.local_only")
        if R.place_code_is_local(obj, pol):
            obj["code"] = ""
        for k in ("lat", "long"):
            if k in obj:
                rounded = R.round_coordinate(obj[k], pol)
                if rounded != obj[k]:
                    fired.add("place.coordinates.round")
                obj[k] = rounded or ""
    if cls == "Media":
        if obj.get("path"):
            fired.add("media.path.local_only")
        obj["path"] = ""
        f = files.get(h) or {}
        if f.get("readable") and f.get("md5"):
            if obj.get("checksum") != f["md5"]:
                fired.add("media.checksum.derive")
            obj["checksum"] = f["md5"]
    # rects
    for ptr in R.match_pointers(obj, "/media_list/*"):
        el = R.pointer_get(obj, ptr)
        if not isinstance(el, dict) or "rect" not in el:
            continue
        problem = R.rect_problem(el["rect"], pol)
        if problem == "full_frame":
            el["rect"] = None
            fired.add("media.rect.full_frame")
        elif problem == "degenerate_or_float":
            b = R.pointer_get(base_obj, ptr + "/rect", None) if base_obj is not None else None
            el["rect"] = copy.deepcopy(b)
            holds.append({"handle": h, "rule": "media.rect.degenerate_or_float", "scope": "field", "pointer": ptr + "/rect"})


def _scan_any(text):
    return scanner.scan_text(text)


def _chain_up(place_handle, tree, absent):
    """The nearest ancestor of a place that is not absent, following placeref_list[0]; None when there is none."""
    seen = set()
    cur = tree.by_handle.get(place_handle)
    while cur is not None and cur["handle"] not in seen:
        seen.add(cur["handle"])
        refs = cur.get("placeref_list") or []
        if not refs:
            return None
        nxt = refs[0].get("ref")
        if nxt not in absent and nxt in tree.by_handle:
            return nxt
        cur = tree.by_handle.get(nxt)
    return None


def _references(obj, tree, absent, excluded, pol, fired):
    cls = obj.get("_class")
    type_excluded = {h for h, r in excluded.items() if r.startswith("place.exclude.")}
    drop = []
    for ptr in R.match_pointers(obj, "/**/{family_list,parent_family_list,note_list,citation_list}/*"):
        if R.pointer_get(obj, ptr) in absent:
            drop.append(ptr)
            fired.add("private.reference.handle_lists")
    for ptr in R.match_pointers(obj, "/{event_ref_list,media_list,child_ref_list,person_ref_list,reporef_list}/*"):
        el = R.pointer_get(obj, ptr)
        if isinstance(el, dict) and el.get("ref") in absent:
            drop.append(ptr)
            fired.add("private.reference.element_refs")
    if cls == "Family":
        for k in ("father_handle", "mother_handle"):
            if obj.get(k) in absent:
                obj[k] = None
                fired.add("private.reference.parent_handles")
    if cls == "Event" and obj.get("place"):
        pl = obj["place"]
        if pl in type_excluded:
            obj["place"] = _chain_up(pl, tree, absent) or ""
            fired.add("place.repoint")
        elif pl in absent:
            obj["place"] = ""
            fired.add("private.reference.event_place")
    if cls == "Place":
        for ptr in R.match_pointers(obj, "/placeref_list/*"):
            el = R.pointer_get(obj, ptr)
            if el.get("ref") in type_excluded:
                fired.add("place.repoint")
                up = _chain_up(el["ref"], tree, absent)
                if up:
                    el["ref"] = up
                else:
                    drop.append(ptr)
            elif el.get("ref") in absent:
                drop.append(ptr)
                fired.add("private.reference.placeref_list")
    R.pointer_remove(obj, drop)


# ---------------------------------------------------------------------------------------------------------------------
# The server side.


def check(objects, policy=None):
    pol = policy or R.load_policy()
    tree = R.Tree(objects)
    out = []

    def add(rule_id, handle, pointer):
        out.append({"rule": rule_id, "handle": handle, "pointer": pointer})

    type_excluded = {o["handle"] for o in tree.of_class("Place") if R.place_exclusion_rule(o, pol)}
    for o in tree.objects:
        h, cls = o.get("handle"), o.get("_class")
        if o.get("private") is True and cls in PRIMARY:
            add("private.object.exclude", h, "/private")
        if cls == "Person" and (o.get("primary_name") or {}).get("private") is True:
            add("private.name.hold_person", h, "/primary_name/private")
        for r in pol["rules"]:
            if r["server"] != "detect" or r["phase"] != "elements" or cls not in r["objectClass"]:
                continue
            want = r.get("params", {}).get("elementClass")
            for ptr in R.match_pointers(o, r["path"]):
                node = R.pointer_get(o, ptr)
                if isinstance(node, dict) and node.get("private") is True and (want is None or node.get("_class") == want):
                    add(r["id"], h, ptr)
        # birth-like dates
        if cls == "Event" and o.get("date"):
            if R.is_birth_like(o, tree, pol):
                _date_checks(o["date"], "/date", "birth.date.daymonth", "birth.date.text", h, add)
                if o["date"].get("modifier") == pol["dates"]["textOnlyModifier"]:
                    add("birth.date.textonly", h, "/date/modifier")
        if cls == "Citation" and h in tree.birth_citation_handles(pol) and o.get("date"):
            _date_checks(o["date"], "/date", "birth.citation.date", "birth.citation.date", h, add)
        if cls == "Person":
            names = [("/primary_name", o.get("primary_name"))] + [("/alternate_names/%d" % i, n) for i, n in enumerate(o.get("alternate_names") or [])]
            for ptr, n in names:
                if n and (n.get("type") or {}).get("value") == pol["dates"]["nameTypeBirth"] and n.get("date"):
                    _date_checks(n["date"], ptr + "/date", "birth.name.date", "birth.name.date", h, add)
            for i, _ in enumerate(o.get("lds_ord_list") or []):
                add("birth.lds_ord", h, "/lds_ord_list/%d" % i)
        for ptr in R.match_pointers(o, "/**/attribute_list/*"):
            el = R.pointer_get(o, ptr)
            rid = R.attribute_rule(el, pol) if isinstance(el, dict) else None
            if rid:
                add(rid, h, ptr)
        if cls in ("Person", "Repository"):
            for i, _ in enumerate(o.get("address_list") or []):
                add("contact.address_list", h, "/address_list/%d" % i)
        if cls in ("Person", "Place", "Repository"):
            for i, u in enumerate(o.get("urls") or []):
                for rid in R.url_rules(u, _scan_any, pol):
                    add(rid, h, "/urls/%d" % i)
        if cls == "Place":
            rid = R.place_exclusion_rule(o, pol)
            if rid:
                add(rid, h, "/place_type")
            for i, loc in enumerate(o.get("alt_loc") or []):
                for f in pol["places"]["locationFields"]:
                    if loc.get(f):
                        add("contact.alt_loc.fields", h, "/alt_loc/%d/%s" % (i, f))
            if o.get("code") and R.place_code_is_local(o, pol):
                add("place.code.local_only", h, "/code")
            for k in ("lat", "long"):
                if R.coordinate_is_fine(o.get(k) or "", pol):
                    add("place.coordinates.round", h, "/" + k)
            for i, ref in enumerate(o.get("placeref_list") or []):
                if ref.get("ref") in type_excluded:
                    add("place.repoint", h, "/placeref_list/%d/ref" % i)
        if cls == "Event" and o.get("place") in type_excluded:
            add("place.repoint", h, "/place")
        # free text
        for ptr, text in scan_fields(o, pol):
            for kind in _scan_kinds(text, pol):
                add("scan." + kind, h, ptr)
    seen, uniq = set(), []
    for v in out:
        k = (v["handle"], v["rule"], v["pointer"])
        if k not in seen:
            seen.add(k)
            uniq.append(v)
    uniq.sort(key=lambda v: (v["handle"], v["rule"], v["pointer"]))
    return {"ok": not uniq, "violations": uniq}


def _date_checks(date, prefix, rule_dm, rule_text, handle, add):
    for rel in R.date_violations(date):
        add(rule_text if rel == "/text" else rule_dm, handle, prefix + rel)
