"""Carrying out a person's decisions on conflicts, in the same run (sync.md 13.1, BRD2 11.1 6.5; review SI-09).

The Gramps window lists each conflict with its choices. The command line never decides one. A decision is carried out by planning the
pull a second time over inputs that already contain the answer, so the merge engine's own rules (lift, projection, the push) produce
the result and nothing here re-implements them:

    keep mine       the pin's base becomes the website's value, so the desktop value reads as a desktop-only change: it is pushed
                    (the projection of the raw value; the local-only part stays in Gramps and never leaves)
    take website    the desktop object gets the website's value at the path (``merge.set_local_value``), and the pin's base becomes that
                    value too, so the two sides converge
    skip            nothing changes; the conflict stays open and pinned
    date            a composite date conflict offers three: keep mine; take the website year and keep my day and month (the default);
                    take the website value and clear my day and month (needs an extra confirmation). ``merge.resolve_date`` says what the
                    desktop and the website hold afterwards
    delete vs edit  the website deleted an object the desktop holds data for: keep mine drops the base so the object is created again on
                    the website; take website removes it from Gramps (a confirmed delete). Other object-level conflicts (identity,
                    integrity, no common base) can only be skipped: they are fixed in Gramps, then the next sync decides.

``second_pass`` is called by ``plan.build``. The plan it returns is the second pass: ``reviewed_hash`` is the first pass's plan hash (what
was previewed), ``decided`` lists what was carried out (ids, handles and paths, never values) and ``undecided`` what was not, and why.
Standard library only; Python 3.9 compatible.
"""
import json

from .. import merge as M

KEEP_MINE, TAKE_WEBSITE, SKIP = "keep_mine", "take_website", "skip"
KIND_FIELD, KIND_DATE, KIND_DELETE, KIND_FIXED = "field", "date", "delete_edit", "fixed"


def is_date_value(value):
    return isinstance(value, dict) and (value.get("_class") == "Date" or "dateval" in value)


def conflict_type(c):
    """How a conflict is decided: a date (three choices), a field (keep mine or take website), a website delete of an object the desktop
    still has (keep mine or take website), or fixed (only skip: it is repaired in Gramps)."""
    if c.get("path"):
        if c.get("kind") in ("field", "composite", "list"):
            return KIND_DATE if any(is_date_value(c.get(k)) for k in ("cloud", "local", "base")) else KIND_FIELD
        return KIND_FIXED
    if c.get("kind") == "delete_edit" and c.get("cloud") == M.TOMBSTONE:
        return KIND_DELETE
    return KIND_FIXED


def choices(c):
    """The offers for one conflict, in the order the window shows them: ``[{id, label, default, needs_confirmation, detail}]``."""
    kind = conflict_type(c)
    skip = {"id": SKIP, "label": "Skip for now", "default": False, "needs_confirmation": False, "detail": "Nothing changes; the conflict stays open."}
    if kind == KIND_DATE:
        out = []
        for ch in M.date_choices():
            out.append(dict(ch, detail={
                "keep_mine": "Your date stays and goes to the website as a year only.",
                "take_year_keep_daymonth": "The website's year replaces yours. Your day and month stay on this computer.",
                "clear_daymonth": "The website's date replaces yours. Your day and month are removed from Gramps.",
            }[ch["id"]]))
        return out + [skip]
    if kind == KIND_FIELD:
        take_loses = c.get("kind") == "composite"
        return [
            {"id": KEEP_MINE, "label": "Keep mine", "default": True, "needs_confirmation": False,
             "detail": "Your value stays and goes to the website."},
            {"id": TAKE_WEBSITE, "label": "Take website", "default": False, "needs_confirmation": take_loses,
             "detail": "The website's value replaces yours." + (" Details that stay only on this computer are removed too." if take_loses else "")},
            skip]
    if kind == KIND_DELETE:
        return [
            {"id": KEEP_MINE, "label": "Keep mine", "default": True, "needs_confirmation": False,
             "detail": "The object stays in Gramps and is created again on the website."},
            {"id": TAKE_WEBSITE, "label": "Take website (delete here)", "default": False, "needs_confirmation": True,
             "detail": "The object is deleted from Gramps, with everything only this computer holds for it."},
            skip]
    return [dict(skip, default=True, detail="Fix this in Gramps, then sync again.")]


def _normal(decision):
    if isinstance(decision, str):
        return decision, False
    return str((decision or {}).get("choice") or SKIP), bool((decision or {}).get("confirmed"))


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def second_pass(first, decisions, local, base_rows, pins, again, policy, heads):
    """The plan made again with `decisions` carried out. `again(local, base_rows, pins)` plans one pass over those inputs."""
    from . import plan as plan_mod

    by_id = {c["id"]: c for c in first.conflicts}
    local2, base2 = dict(local), dict(base_rows)
    pins2 = {h: [dict(p) for p in ps] for h, ps in (pins or {}).items()}
    base_objs = first.base_objs
    edits, removals, drops, decided, undecided, rows = {}, [], [], [], [], []

    def note(cid, why):
        undecided.append({"id": cid, "reason": why})

    for cid in sorted(decisions):
        c = by_id.get(cid)
        choice, confirmed = _normal(decisions[cid])
        if c is None:
            note(cid, "no such open conflict now")
            continue
        if choice == SKIP:
            continue
        kind = conflict_type(c)
        offered = {x["id"]: x for x in choices(c)}
        if kind == KIND_FIXED or choice not in offered:
            note(cid, "this conflict can only be skipped")
            continue
        if offered[choice]["needs_confirmation"] and not confirmed:
            note(cid, "needs a confirmation")
            continue
        h, path = c["handle"], c.get("path") or ""
        if kind == KIND_DELETE:
            pins2.pop(h, None)
            if choice == KEEP_MINE:
                base2.pop(h, None)
                drops.append((c["class"], h))
            else:
                local2.pop(h, None)
                removals.append(h)
            decided.append({"id": cid, "handle": h, "path": path, "choice": choice})
            rows.append(c)
            continue
        lp = first.projected.get(h)
        base_obj = base_objs.get(h)
        if lp is None or h not in local:
            note(cid, "the object is not in the tree")
            continue
        current = edits.get(h, local[h])
        try:
            raw = M.local_value(c, local[h], lp, base_obj)
            if kind == KIND_DATE:
                res = M.resolve_date(c.get("cloud") if isinstance(c.get("cloud"), dict) else {}, raw if isinstance(raw, dict) else {},
                                     choice, confirmed, policy)
            else:
                res = M.resolve_conflict(c, choice, local_raw=raw if raw is not None else M.MISSING)
            if choice != KEEP_MINE:
                value = M.MISSING if "cloud" in (c.get("absent") or ()) and kind != KIND_DATE else res["local"]
                edits[h] = M.set_local_value(c, current, lp, base_obj, value)
        except (ValueError, KeyError):
            note(cid, "the value could not be put in place")
            continue
        # the pin's base becomes the website's value: the merge now reads the desktop value as a desktop-only change (keep mine: it is
        # pushed) or as the same as the website's (take website: nothing to push)
        pin = {"path": path, "base_json": c.get("cloud_json")}
        pins2[h] = [p for p in pins2.get(h, []) if p["path"] != path] + [pin]
        entry = {"id": cid, "handle": h, "path": path, "choice": choice}
        if kind == KIND_DATE and res.get("fallback"):
            entry["fallback"] = res["fallback"]    # the two dates have different shapes: the window says the choice became keep mine
        decided.append(entry)
        rows.append(c)

    if not decided:
        first.undecided = undecided
        return first
    for h, obj in edits.items():
        local2[h] = obj
    second = again(local2, base2, pins2)
    second.fingerprints = dict(first.fingerprints)     # the tree is still the first pass's tree until the apply
    second.reviewed_hash = first.reviewed_hash
    second.projected = first.projected
    second.undecided = undecided
    second.decided = decided
    second.decided_rows = rows   # the whole conflicts, for the sidecar row (never in the preview file)
    second.sticky_held = first.sticky_held
    for h, obj in edits.items():
        r = second.results.get(h)
        second.commits[h] = r.local_obj if r is not None and r.local_obj is not None else obj
        if not any(p["handle"] == h for p in second.pulled_rows):
            second.pulled_rows.append({"class": obj.get("_class", ""), "handle": h, "kind": "update", "prepull": plan_mod._plain(first.projected.get(h))})
        second.local_ids.setdefault(h, (obj.get("_class", ""), obj.get("gramps_id", "")))
    for h in removals:
        cls, gid = second.local_ids.get(h) or (local[h].get("_class", ""), local[h].get("gramps_id", ""))
        second.local_ids[h] = (cls, gid)
        second.base_ops = [b for b in second.base_ops if b[2] != h]
        second.base_ops.append(("deleted", cls, h, next((x for x in heads if x.handle == h), None)))
        second.removals.append(h)
        second.pulled_rows.append({"class": cls, "handle": h, "kind": "delete", "prepull": plan_mod._plain(first.projected.get(h))})
    for cls, h in drops:
        second.base_ops = [b for b in second.base_ops if b[2] != h]
        second.base_ops.append(("drop", cls, h, None))
    for d in decided:
        second.closed.append((d["handle"], d["path"]))
    plan_mod._finish(second)
    return second
