"""The plan of a push: the diff of the local tree against the merge base and the cloud, as ops, holds, blocks and parked deletes
(sync.md 8.3 steps 4 and 12, 8.4; BRD2 11.1; error catalog D17, D26, D35 to D37, D44, D51).

Pure: no network, no sqlite, no Gramps. `build_plan` takes the raw local objects (L), the sidecar's base rows (B) and the cloud's heads
(C, from the snapshot), runs the projection (P) and the three-way merge (``hfygramps.merge``), and sorts every object's result:

    push op         ``obj = P(lift(M, L))`` with ``base_version = C.version`` (the merge engine's own push, sync.md 8.3 step 12)
    hold            the content or the object stays on the desktop (a projection hold, a reserved or retired ID, a too-large object, a
                    merge that cannot go yet): nothing is sent for it and the sidecar says why
    blocked         a change the addon never pushes (a person renumber, a delete without step-up, a mass delete, and a change that
                    reverts a website change a recent pull made: D47, the command line parks it and the Gramps window confirms it)
    pull pending    the website changed the object too and the local apply (pull) has not happened: the merged object is pushed, and its
                    base row is left as it was (so the website's edit is still to be taken, never read as a desktop revert)
    base advance    the local and the cloud object agree (converged): the base row follows the cloud head, nothing is sent

Nothing in a plan carries a value that is not already in the projected objects: holds and blocks name classes, handles, rules and
pointers. Python 3.9 compatible.
"""
import json
import re

from .. import merge as M
from .. import projection as PR
from . import consts, mediaup
from . import plan as pullplan

# The Gramps ID prefixes of the block the website mints from (api/src/sync/validator.js BLOCK_PREFIX); the handshake's `id_block` wins.
DEFAULT_BLOCK_PREFIX = {"Person": "I", "Family": "F", "Event": "E", "Place": "P", "Media": "O", "Note": "N", "Source": "S", "Citation": "C",
                        "Repository": "R"}
_BLOCK = re.compile(r"^([A-Za-z]*)(\d+)-([A-Za-z]*)(\d+)$")


def block_ranges(meta):
    """{class: (prefix, low, high)} from the handshake's id_block ("I8000-I8999"); the defaults when it is absent or odd."""
    out = {c: (p, 8000, 8999) for c, p in DEFAULT_BLOCK_PREFIX.items()}
    given = (meta or {}).get("id_block")
    if isinstance(given, dict):
        for cls, text in given.items():
            m = _BLOCK.match(text) if isinstance(text, str) else None
            if m and m.group(1) == m.group(3):
                out[cls] = (m.group(1), int(m.group(2)), int(m.group(4)))
    return out


def in_block(ranges, cls, gramps_id):
    """True when `gramps_id` is in the website's reserved block for `cls` (leading zeros allowed, like the server's check)."""
    rng = ranges.get(cls)
    if not rng or not isinstance(gramps_id, str):
        return False
    m = re.fullmatch(re.escape(rng[0]) + r"(\d+)", gramps_id, re.IGNORECASE)
    return bool(m) and rng[1] <= int(m.group(1)) <= rng[2]


def merged_ids(person):
    """The values of a person's 'Merged Gramps ID' attributes."""
    out = []
    for attr in (person or {}).get("attribute_list") or []:
        if isinstance(attr, dict) and (attr.get("type") or {}).get("string") == consts.MERGED_ID_ATTRIBUTE and isinstance(attr.get("value"), str):
            out.append(attr["value"])
    return out


def class_rank(cls):
    return consts.CLASSES.index(cls) if cls in consts.CLASSES else len(consts.CLASSES)


def op_bound(op):
    """The most transaction items one op takes on the server (api/src/sync/apply.js txnItemBound)."""
    if op["op"] == "create":
        return 3
    if op["op"] == "update":
        return 4
    return 4 if op["class"] == "Person" and op.get("reason") == "merge" else 3


class Plan:
    """What `build_plan` decided. Lists hold dicts; ops are wire ops without an ``op_id`` (the batcher numbers them)."""

    def __init__(self):
        self.ops = []             # creates and updates, in push order (class order, then handle)
        self.destructive = []     # deletes, merges and withdraws that may be sent now, last in push order
        self.holds = []           # {"class", "handle", "path", "rule", "detail"}
        self.blocked = []         # the same shape: changes that are never pushed as they are
        self.conflicts = []       # the merge's open conflicts
        self.closed = []          # conflict ids a run found resolved
        self.pull_pending = []    # [{"class", "handle", "gramps_id"}]
        self.keep_base = set()    # handles pushed while the website's own edit is still to be pulled: their base row is not advanced
        self.advance = []         # handles whose base row follows the cloud head
        self.drop_base = []       # handles whose base row goes
        self.sticky = frozenset()
        self.autos = []
        self.integrity = []
        self.mass_delete = False
        self.live_base = 0
        self.actions = {}
        self.uploads = {}         # {Media handle: mediafile.inspect dict}: the blobs this push uploads before the ops that name them
        self.warnings = []        # {"class", "handle", "rule", "detail"}: things to tell io that hold nothing back (a stale Gramps checksum)
        self.media_up = 0

    def counts(self):
        out = {"create": 0, "update": 0, "delete": 0}
        for o in self.ops:
            out[o["op"]] += 1
        for o in self.destructive:
            out["delete"] += 1
        return out

    def has_changes(self):
        return bool(self.ops or self.destructive)


def _hold(cls, handle, rule, path="", detail=None):
    return {"class": cls, "handle": handle, "path": path, "rule": rule, "detail": detail if detail is not None else consts.HOLD_MESSAGES.get(rule) or PR.hold_reason(rule)}


def build_plan(local, base, cloud, *, meta, mode="cli", allow_deletes=False, yes=False, step_up=False, sticky=(), pins=None, unreadable=(),
               policy=None, max_obj_bytes=None, files=None, members=None, expunge_holds=None, pulled=None, blobs=None):
    """The plan.

    local        {handle: raw Gramps object}
    base         {handle: sidecar base row} (``pushstate.base_rows``)
    cloud        {handle: {"class", "version", "seq", "deleted", "obj"}} the snapshot's heads, tombstones included
    meta         the handshake (``GET /api/sync/meta``): merges_enabled, retired_person_ids, id_block, limits
    members      the Gramps IDs of the signed-in family members (member principals), or None when nobody has said (a merge is then
                 held as unverifiable); the website's handshake may list them as ``member_person_ids`` and config.json may too
    mode         "cli" (conflicts are parked, deletes need allow_deletes, a merge is parked) or "gui"
    allow_deletes, yes  the CLI flag; in the GUI `yes` is the confirmation
    step_up      the token carries a fresh step-up (amr mfa within 300 s)
    sticky       the sidecar's ``birthlike_sticky`` handles; pins {handle: [{"path", "base_json"}]} the open and parked conflicts
    expunge_holds  {handle: [pointer]} the values a website scrub removed (the pull's ``expunge.notice`` holds, ``sidecar.load_expunge_holds``):
                 an update never puts the desktop's value back at those pointers, and is not sent when they were all that differed
    files        {media handle: ``mediafile.inspect`` dict}: the projection reads ``exif_gps``, ``md5`` and ``readable``, and ``mediaup.annotate``
                 the rest (the blob of every Media op, the blob-only updates, the holds for a file that cannot go)
    blobs        {handle: ``media_local`` row}: the bytes the website already holds (``mediaup.load_rows``)
    pulled       {handle: [{"kind", "prepull", ...}]} what the last pull runs changed (``sidecar.load_pulled``): a create, update or delete
                 that puts back what a pull replaced is a revert (D47, ``plan.revert_paths``); it is blocked unless `mode` is "gui" and
                 `yes` is the person's confirmation
    """
    plan = Plan()
    meta = meta or {}
    pulled = pulled or {}
    max_obj_bytes = max_obj_bytes or (meta.get("limits") or {}).get("max_obj_bytes") or consts.PUSH_MAX_OBJ_BYTES
    base_objs = {h: r["obj"] for h, r in base.items() if not r["deleted"] and r["obj"] is not None}
    plan.live_base = len(base_objs)
    classes = {h: o.get("_class") for h, o in local.items()}
    for h, r in base.items():
        classes.setdefault(h, r["class"])
    for h, r in cloud.items():
        classes.setdefault(h, r["class"])

    proj = PR.project(list(local.values()), base=base_objs, files=files, sticky=sticky, policy=policy)
    projected_all = symmetric(proj.projected, proj.holds)
    plan.sticky = frozenset(M.update_baseline(sticky, list(local.values()), base_objs, policy=policy))
    for x in proj.holds:
        plan.holds.append(_hold(classes.get(x["handle"], ""), x["handle"], x["rule"], x["pointer"]))

    def project_one(obj):
        # P(lift(M, L)) (sync.md 8.3 step 12). When the lifted object is the local object itself (a desktop-only edit: the website changed
        # nothing in it) that is the projection already made for the whole tree; only an object that took a website change is projected
        # again, in the context of the local tree with that one object replaced.
        mine = local.get(obj["handle"])
        if mine is not None and M.strip_change(obj) == M.strip_change(mine) and projected_all.get(obj["handle"]) is not None:
            return projected_all[obj["handle"]]
        tree = dict(local)
        tree[obj["handle"]] = obj
        again = PR.project(list(tree.values()), base=base_objs, files=files, sticky=sticky, policy=policy)
        return symmetric(again.projected, again.holds).get(obj["handle"])

    heads = {h: (M.TOMBSTONE if r["deleted"] else r["obj"]) for h, r in cloud.items()}
    versions = {h: r["version"] for h, r in cloud.items()}
    tree = M.merge_tree(base_objs, local, projected_all, heads, versions=versions, pins=pins or {}, project_fn=project_one, mode=mode,
                        allow_deletes=allow_deletes, sticky=sticky, policy=policy, cloud_is_delta=False, unreadable=unreadable)
    plan.actions = tree.actions()
    plan.conflicts = list(tree.conflicts)
    plan.autos = list(tree.autos)
    plan.integrity = list(tree.integrity)

    ranges = block_ranges(meta)
    retired = set(meta.get("retired_person_ids") or [])
    members = set(members) if members is not None else None
    merges_enabled = meta.get("merges_enabled") is True

    creates, deletes, withdraws = [], [], []
    for handle in sorted(tree.results):
        r = tree.results[handle]
        cls = r.cls or classes.get(handle, "")
        plan.closed += [M._conflict_id(cls, handle, p) for p in r.closed]
        act = r.action
        if act == "push_create" or (act == "update" and r.push is not None):
            op = r.push
            if r.local_obj is not None:
                # The website changed this object too, and the desktop has not applied it (that is the pull). The merged object is
                # still what the website should hold, so it is pushed; but the base must not claim the desktop has it, or the next run
                # would read the missing website edit as a desktop revert. The base row stays what it was (the cloud object the
                # desktop last agreed on), so the next run takes the website's edit and finds the desktop's own edit converged.
                plan.pull_pending.append({"class": cls, "handle": handle, "gramps_id": r.gramps_id})
                plan.keep_base.add(handle)
            held = (expunge_holds or {}).get(handle)
            cloud_obj = None if cloud.get(handle, {}).get("deleted") else cloud.get(handle, {}).get("obj")
            if held and op.get("obj") is not None and cloud_obj is not None:
                op = dict(op, obj=pullplan.hold_back(op["obj"], cloud_obj, held))
                if op["obj"] == cloud_obj:
                    continue  # the scrubbed values were all that differed: nothing to send, and the base row already is the website's copy
            guard = _guard(op, local.get(handle), base.get(handle), ranges, retired, max_obj_bytes)
            if guard == "renumber_blocked":
                plan.blocked.append(_hold(cls, handle, guard, "/gramps_id"))
                continue
            if guard:
                plan.holds.append(_hold(cls, handle, guard))
                continue
            reverts = pullplan.revert_paths(op, cloud_obj, pulled.get(handle))
            if reverts and not _confirmed(mode, yes):
                plan.blocked.append(_hold(cls, handle, "revert_parked", reverts[0]))
                continue
            creates.append(op)
        elif act == "push_delete":
            deletes.append(r)
        elif act == "withdraw":
            withdraws.append(r)
        elif act in ("create_local", "delete_local", "delete_deferred") or (act == "update" and r.local_obj is not None):
            plan.pull_pending.append({"class": cls, "handle": handle, "gramps_id": r.gramps_id})
        elif act in ("converged", "unchanged") or (act == "update" and r.push is None and r.local_obj is None):
            if handle in cloud and cloud[handle]["class"]:
                plan.advance.append(handle)
        elif act == "drop_base":
            plan.drop_base.append(handle)
        # conflict, excluded, noop: nothing is sent and the base row stays

    creates.sort(key=lambda o: (class_rank(o["class"]), o["handle"]))
    plan.ops = [dict(o) for o in creates]

    _destructive(plan, deletes, withdraws, local, base, meta, mode=mode, allow_deletes=allow_deletes, yes=yes, step_up=step_up,
                 members=members, merges_enabled=merges_enabled, pulled=pulled)
    if files:
        mediaup.annotate(plan, files, blobs or {}, local, cloud, {h: r.action for h, r in tree.results.items()})
    plan.holds = _unique(plan.holds)
    plan.blocked = _unique(plan.blocked)
    return plan


# The pull's pending-push planning needs the same step (``plan.symmetric``), so it lives there.
symmetric = pullplan.symmetric


def _unique(rows):
    seen, out = set(), []
    for x in rows:
        key = (x["class"], x["handle"], x["path"], x["rule"])
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out


def _guard(op, local_obj, base_row, ranges, retired, max_obj_bytes):
    """The hold rule that keeps a create or update from being sent, or None. Checked before anything goes on the wire."""
    cls, obj = op["class"], op["obj"]
    gid = obj.get("gramps_id")
    old = base_row["obj"].get("gramps_id") if base_row and not base_row["deleted"] and base_row.get("obj") else None
    if cls == "Person" and old not in (None, "") and (gid or "") != old:
        return "renumber_blocked"                         # D35: a person's ID never changes once it is on the website (clearing it counts)
    if cls != "Tag" and gid and old != gid:
        # a create, or an update that gives the object an ID it did not have at the last sync (or changes it)
        if in_block(ranges, cls, gid):
            return "reserved_id_block"                    # D26
        if cls == "Person" and gid in retired:
            return "gramps_id_retired"                    # D44
    if len(_obj_bytes(obj)) > max_obj_bytes:
        return "object_too_large"                         # D40
    return None


def _obj_bytes(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _wire(push):
    """A delete or withdraw op without the `obj: None` the merge engine carries."""
    return {k: v for k, v in push.items() if k != "obj"}


def _confirmed(mode, yes):
    """True when the person has confirmed what the command line never sends on its own: only the Gramps window, with `yes`."""
    return mode == "gui" and bool(yes)


def _destructive(plan, deletes, withdraws, local, base, meta, *, mode, allow_deletes, yes, step_up, members, merges_enabled, pulled=None):
    """Sorts the deletes and withdraws into pushed, held, blocked and parked (D07, D35 to D37, D47, D51)."""
    pulled = pulled or {}
    persons = {h: o for h, o in local.items() if o.get("_class") == "Person"}
    plain, merges = [], []
    held_survivors = set()
    for r in deletes:
        gone = (base.get(r.handle) or {}).get("obj") or {}
        survivor = None
        if r.cls == "Person" and gone.get("gramps_id"):
            found = sorted(h for h, p in persons.items()
                           if gone["gramps_id"] in merged_ids(p) and gone["gramps_id"] not in merged_ids((base.get(h) or {}).get("obj")))
            if len(found) == 1:
                survivor = found[0]
            elif len(found) > 1:
                plan.holds.append(_hold(r.cls, r.handle, "merge_held"))
                held_survivors.update(found)
                continue
        if survivor is None:
            plain.append(r)
        else:
            merges.append((r, survivor, gone["gramps_id"]))

    # --- merges (sync.md 8.4, D36, D51). A merge is only ever pushed from the Gramps window, with `yes` and a fresh step-up: that is its
    # own confirmation, so the revert check (D47) does not apply to it.
    # A merge that is not pushed this run must still be recognised the next run, and it is recognised only while the survivor's 'Merged
    # Gramps ID' attribute is new relative to base. So the survivor's base row stays where it is (the survivor may still be pushed; the
    # push then leaves its base row alone) until the merge itself goes.
    pending = set(held_survivors)
    for r, survivor, old_id in merges:
        pending.add(survivor)
        if members is not None and old_id in members:
            plan.blocked.append(_hold(r.cls, r.handle, "merge_member_principal"))
        elif not merges_enabled:
            plan.holds.append(_hold(r.cls, r.handle, "merge_held"))
        elif members is None:
            plan.holds.append(_hold(r.cls, r.handle, "merge_unverified"))
        elif mode != "gui" or not yes:
            plan.blocked.append(_hold(r.cls, r.handle, "merge_gui_only"))
        elif not step_up:
            plan.blocked.append(_hold(r.cls, r.handle, "step_up_required"))
        else:
            op = _wire(r.push)
            op["reason"] = "merge"
            op["merged_into"] = persons[survivor]["gramps_id"]
            plan.destructive.append(op)
            pending.discard(survivor)
    plan.keep_base |= pending
    plan.advance = [h for h in plan.advance if h not in pending]

    # --- plain deletes (D07, D37)
    n = len(plain)
    plan.mass_delete = bool(n > consts.MAX_CLI_DELETES or (plan.live_base and n * 100 > consts.MASS_DELETE_SHARE_PERCENT * plan.live_base))
    for r in plain:
        if plan.mass_delete and not (mode == "gui" and yes):
            rule = "mass_delete"                          # D37: never pushed without the GUI's confirmation, never by the CLI
        elif pullplan.revert_paths(r.push, None, pulled.get(r.handle)) and not _confirmed(mode, yes):
            rule = "revert_parked"                        # D47: a delete of what a pull created; --allow-deletes does not release it
        elif mode == "cli" and not allow_deletes:
            rule = "delete_parked"
        elif mode == "gui" and not yes:
            rule = "delete_parked"
        elif not step_up:
            rule = "step_up_required"                     # D07
        else:
            rule = None
        if rule:
            plan.blocked.append(_hold(r.cls, r.handle, rule))
        else:
            plan.destructive.append(_wire(r.push))

    # --- withdraws reduce exposure and need no step-up; the server counts them with the deletes against its budget (403 then parks them)
    for r in withdraws:
        plan.destructive.append(_wire(r.push))
    plan.destructive.sort(key=lambda o: (-class_rank(o["class"]), o["handle"]))


# ----------------------------------------------------------------------------------------------------------------- batches


def make_batches(ops, limits=None):
    """Splits ops (already in push order) into batches that fit the server's limits: at most max_ops ops, 100 transaction items
    (each kind's bound plus the fixed items and the budget counter of a destructive batch), a body under max_body_bytes, and
    2 x the objects' bytes under 3.5 MB. Creates and updates never share a batch with deletes or withdraws."""
    limits = limits or {}
    max_ops = int(limits.get("max_ops") or consts.PUSH_MAX_OPS)
    max_body = int(limits.get("max_body_bytes") or consts.PUSH_MAX_BODY_BYTES)
    out, cur, items, body, objs = [], [], consts.PUSH_FIXED_TXN_ITEMS, 0, 0
    destructive = None
    for op in ops:
        is_dead = op["op"] in ("delete", "withdraw")
        size = len(json.dumps(op, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) + 24
        obj_bytes = 2 * len(_obj_bytes(op["obj"])) if op.get("obj") is not None else 0
        extra_items = 1 if is_dead and not cur else 0
        if cur and (len(cur) >= max_ops or destructive != is_dead or items + op_bound(op) + extra_items > consts.PUSH_TXN_ITEMS
                    or body + size > max_body * 0.9 or objs + obj_bytes > 3_400_000):
            out.append(cur)
            cur, items, body, objs = [], consts.PUSH_FIXED_TXN_ITEMS, 0, 0
        if not cur:
            destructive = is_dead
            items += 1 if is_dead else 0
        cur.append(op)
        items += op_bound(op)
        body += size
        objs += obj_bytes
    if cur:
        out.append(cur)
    return out
