"""The pull plan (sync.md 8.3 steps 4 and 5, BRD2 11.1): what a run would change, decided from three inputs and nothing else.

    L  the local Gramps objects (raw `json_data`)           B  the sidecar's last cloud copies           C  the verified snapshot

`build` projects L (`projection.project`), merges L, B and C object by object (`merge.merge_tree`) and then turns the merge's results
into the things the rest of a run needs. It reads no file, opens no database and makes no network call, so every rule here is tested
without Gramps. What it adds to the merge engine:

* Inbound privacy (BRD2 11.1, PS-03). Every pulled object (new, or changed since the base) is scanned with `dob_exact`, the same
  matcher the projection uses, against every local full date of birth. A hit is never applied: the object stays as the desktop has it,
  an incident (counts only in status.json) is recorded, and a withdraw-and-expunge push is offered.
* Expunge notices (BRD2 11.1). A head with the base's version but another hash is the website scrubbing a value in place. The base is
  refreshed to the scrubbed object and the pointers that changed are held, so the push never puts the scrubbed value back.
* Reverts (D47). A push that returns a field to the value it had before a pull of the last five pull runs is labelled
  `reverts a website change (origin)`; the GUI needs a confirmation for it and the CLI parks it.
* The mass-delete guard (sync.md 17): more than 10 incoming deletes, or more than 5 % of the local objects, are never applied by the
  CLI (nor by the GUI without a confirmation).
* Symmetry (`symmetric`). The projection removes a private ChildRef from its family but leaves the child's back-link, and the website
  refuses a session whose people and families disagree, so the push drops that back-link from the projected person. The pull plans
  its own pending pushes from the same projection and must drop it too, or a pushed tree reads as having a change waiting for ever.
* The plan hash that `sync --yes --plan <run_id>` compares (headless runbook 19.3).

Standard library only; Python 3.9 compatible except for what `hfygramps.merge` and `projection` already require.
"""
import copy
import hashlib
import json

from .. import canonical
from .. import merge as M
from .. import projection as PR
from .. import rules as R
from . import consts

REVERT_LABEL = "reverts a website change (origin)"
MASS_DELETE_OBJECTS = 10
MASS_DELETE_PERCENT = 5
INBOUND_RULE = "scan.dob_exact"
_MISSING = object()


def chash(value):
    """sha256 of a plain JSON value; unlike `canonical` it accepts the floats a raw Gramps object can hold (a MediaRef rect)."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def fingerprint(obj):
    return chash(obj)


# ---------------------------------------------------------------------------------------------------------------- inbound scan


def incident_offer(cls, handle):
    """The withdraw-and-expunge push an incident offers. `addon-push` (the task that sends pushes) builds the same op from the open rows
    of the sidecar's `incidents` table (`sidecar.open_incidents`), so the offer does not have to be stored anywhere else; this build only
    records it, in the preview file (`incidents[].offer`) and the table, and sends nothing."""
    return {"op": "withdraw", "reason": "private", "expunge": True, "class": cls, "handle": handle}


def sendable(op, confirmed=False):
    """True when a planned push may be sent now. `send` always may; `confirm` (a GUI revert or delete) only with the person's explicit
    confirmation; `parked` (a CLI revert) never, whatever the flag."""
    d = op.get("disposition")
    return d == "send" or (d == "confirm" and bool(confirmed))


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def references(obj, handles):
    """True when any string value anywhere in `obj` is one of `handles` (a handle is a random token: a match is a reference)."""
    if not handles:
        return False
    stack = [obj]
    while stack:
        node = stack.pop()
        if isinstance(node, str):
            if node in handles:
                return True
        elif isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return False


def drop_dependants(objs, seeds, exempt):
    """Handles of `objs` ({handle: object}) that refer, directly or through each other, to a handle in `seeds`; the seeds themselves are
    not included. The chain only passes through handles that are not in `exempt` (objects the tree already has: what refers to those
    still has something to point at), so one missing new object takes its new dependants with it and nothing else."""
    gone, cascade = set(), set(seeds)
    changed = True
    while changed:
        changed = False
        for h in sorted(objs):
            if h in gone or h in seeds:
                continue
            if references(objs[h], cascade):
                gone.add(h)
                changed = True
                if h not in exempt:
                    cascade.add(h)
    return gone


def dob_index(local_objects, sticky, policy):
    """The matcher for the local full dates of birth: every day-precise date of a birth-like or sticky event, once per owner."""
    tree = R.Tree(list(local_objects))
    return PR.DobIndex(PR.local_dobs(tree, set(sticky or ()), policy), policy["scan"]["dobWindow"])


def scan_fields(policy):
    """{class: [path]}: the free-text fields the scan policy names."""
    fields = {}
    for f in policy["scan"]["fields"]:
        fields.setdefault(f["class"], []).append(f["path"])
    return fields


def dob_hit(obj, index, policy, fields=None):
    """True when a Date of any class in `obj`, or a free-text field the scan policy names, shows a local full date of birth."""
    if not index:
        return False
    fields = fields if fields is not None else scan_fields(policy)
    for node in _walk(obj):
        if isinstance(node, dict) and (node.get("_class") == "Date" or "dateval" in node):
            if index.date_hit(node) or index.text_hit(node.get("text")):
                return True
        for path in fields.get(node.get("_class"), ()):
            v = R.pointer_get(node, path)
            if isinstance(v, str) and v and index.text_hit(v):
                return True
    return False


# ---------------------------------------------------------------------------------------------------------------- symmetry


def symmetric(projected, holds=()):
    """``projected`` with every person's back-links made to agree with the projected families. The projection removes a private
    ChildRef from its family but leaves the child's ``parent_family_list`` pointing at that family, and the website refuses a session
    whose people and families disagree (422 ``integrity.symmetry.child`` at completion). A person's link to a family that does not
    list the person is dropped from the projected person (never the other way round, so no content is lost; the lift brings the link
    back, because the local object still has it). The dropped link would also have shown that the private relationship exists.
    Objects the projection holds whole keep their cloud copy untouched.

    The push (`pushplan.build_plan`) and the pull (`build`, for the pushes it reports as waiting) both apply it, so the two halves of a
    sync agree about what is pending."""
    held = {x["handle"] for x in holds if x.get("scope") == "object"}
    out = dict(projected)
    for h, o in projected.items():
        if not isinstance(o, dict) or o.get("_class") != "Person" or h in held:
            continue
        fixed = dict(o)
        for key, listed in (("parent_family_list", lambda f: h in [c.get("ref") for c in f.get("child_ref_list") or ()]),
                            ("family_list", lambda f: h in (f.get("father_handle"), f.get("mother_handle")))):
            keep = [fh for fh in o.get(key) or () if not isinstance(projected.get(fh), dict) or projected[fh].get("_class") != "Family"
                    or listed(projected[fh])]
            if keep != list(o.get(key) or ()):
                fixed[key] = keep
        if fixed != o:
            out[h] = fixed
    return out


# ---------------------------------------------------------------------------------------------------------------- reverts


def _get(obj, pointer):
    return R.pointer_get(obj, pointer, _MISSING) if pointer else obj


def revert_paths(op, cloud_obj, pulled):
    """Pointers at which push `op` puts back a value that a recent pull replaced; [] when it does not revert anything.

    `pulled` is the list of the object's rows in the sidecar's `pulled` table (newest first): each says what the pull did (`create`,
    `update` or `delete`) and holds the projected object as the desktop had it before. An update reverts when, at a pointer where it
    differs from the website's copy, its value equals the pre-pull value. A delete reverts a create that a pull made; a create
    reverts a delete that a pull made.
    """
    out = []
    for row in pulled or ():
        kind = row["kind"]
        if op["op"] == "delete" and kind == "create":
            return [""]
        if op["op"] == "create" and kind == "delete":
            return [""]
        if op["op"] == "update" and kind == "update" and isinstance(row.get("prepull"), dict) and isinstance(cloud_obj, dict):
            for p in M.diff_pointers(cloud_obj, op["obj"]):
                want = _get(row["prepull"], p)
                if want is not _MISSING and _get(op["obj"], p) == want and _get(cloud_obj, p) != want:
                    out.append(p)
    return sorted(set(out))


def hold_back(op_obj, cloud_obj, pointers):
    """`op_obj` with the website's value put back at every pointer in `pointers` (the scrubbed values the push must not restore)."""
    out = copy.deepcopy(op_obj)
    for p in pointers:
        if not p:
            continue
        cv = _get(cloud_obj, p)
        if cv is _MISSING:
            R.pointer_remove(out, [p])
        else:
            R.pointer_set(out, p, copy.deepcopy(cv))
    return out


# ---------------------------------------------------------------------------------------------------------------- the plan


class Plan:
    """Everything a run needs to preview, hash and apply. The lists hold plain dicts so a preview file is `json.dump(plan.preview(...))`."""

    def __init__(self):
        self.results = {}
        self.integrity = []
        self.commits = {}        # handle -> local-form object to commit (create or update)
        self.removals = []       # handles to remove locally
        self.base_ops = []       # ("set"|"deleted", class, handle, Head) or ("drop", class, handle, None)
        self.conflicts = []      # merge conflict dicts, with class/handle/gramps_id
        self.closed = []         # (handle, path) of pins the run found resolved
        self.push_ops = []       # dicts, see _push
        self.incidents = []      # {class, handle, gramps_id, rule, seq, offer}
        self.notices = []        # {class, handle, gramps_id, paths}
        self.media = []          # handles of Media whose file must be downloaded
        self.blocked = []        # {class, handle, gramps_id, reason}
        self.deferred = []       # {class, handle, gramps_id, reason} (media failures are added by the run)
        self.autos = []
        self.holds = []
        self.mass_delete = False
        self.sticky = frozenset()
        self.pulled_rows = []    # {class, handle, kind, prepull} to record when the run applies
        self.expunge_holds = {}  # handle -> pointers (persisted + new)
        self.local_ids = {}      # handle -> (class, gramps_id) for the summary lines
        self.plan_hash = ""
        self.counts = {}
        self.fingerprints = {}   # handle -> fingerprint of the local object the plan was made from
        self.base_objs = {}      # handle -> the base object the plan was made against (after expunge refreshes)
        self.parked = []         # push ops the CLI parked (reverts)
        self.planned_push = {"create": 0, "update": 0, "delete": 0}
        self.reviewed_hash = ""  # the plan hash of the pass the person reviewed (differs from plan_hash after decisions)
        self.projected = {}      # handle -> P(L) (symmetric), the projected local objects this plan was made from
        self.decided = []        # [{id, handle, path, choice}] conflicts a person decided in this plan
        self.decided_rows = []   # the same conflicts in full (projected values): only the sidecar row takes them, never the preview file
        self.undecided = []      # [{id, reason}] decisions that were not carried out
        self.sticky_held = []    # [{class, handle, gramps_id}] sticky events whose local day and month are withheld

    # ---- queries
    @property
    def applies(self):
        return bool(self.commits or self.removals)

    @property
    def has_changes(self):
        """Something a `check` reports as pending: a local apply, a push, a base refresh that matters, a notice or media."""
        return bool(self.commits or self.removals or self.push_ops or self.notices or self.media or self.base_ops_visible())

    def base_ops_visible(self):
        return [b for b in self.base_ops if b[0] == "deleted"]

    @property
    def needs_attention(self):
        return bool(self.conflicts or self.incidents or self.blocked or self.integrity)


def _gid(local, cloud_head, base_obj):
    for o in (local, cloud_head.obj if cloud_head is not None else None, base_obj):
        if isinstance(o, dict) and o.get("gramps_id"):
            return o["gramps_id"]
    return ""


def _plain(value):
    return json.loads(json.dumps(value, default=str))


def build(local, base_rows, heads, *, pins=None, sticky=(), released=(), mode="cli", allow_deletes=False, files=None, pulled=None,
          expunge_holds=None, policy=None, confirm_mass_delete=False, decisions=None, defer_deletes=False):
    """Plans one pull. `local` {handle: raw object}; `base_rows` sidecar.load_base(); `heads` a Snapshot's heads.

    `decisions` ({conflict id: {"choice", "confirmed"}}, the Gramps window only) are a person's answers to conflicts the first pass
    found; they are carried out in the same plan (``decide.second_pass``): the plan returned is the second pass, and
    `reviewed_hash` is the first pass's plan hash, the one the person saw. `defer_deletes` holds back every incoming delete (a person
    who declined the confirmation): each is listed as blocked, nothing is removed."""
    kw = dict(sticky=sticky, released=released, mode=mode, allow_deletes=allow_deletes, files=files, pulled=pulled,
              expunge_holds=expunge_holds, policy=policy, confirm_mass_delete=confirm_mass_delete, defer_deletes=defer_deletes)
    first = _build_once(local, base_rows, heads, pins=pins, **kw)
    first.reviewed_hash = first.plan_hash
    if defer_deletes or confirm_mass_delete:
        # the person reviewed the plan without those answers: the hash `sync --plan` and the window compare is that plan's
        first.reviewed_hash = _build_once(local, base_rows, heads, pins=pins, **dict(kw, confirm_mass_delete=False, defer_deletes=False)).plan_hash
    if not decisions or not first.conflicts:
        return first
    from . import decide

    return decide.second_pass(first, decisions, local, base_rows, pins or {}, lambda local2, base2, pins2: _build_once(local2, base2, heads, pins=pins2, **kw),
                              policy or R.load_policy(), heads)


def _build_once(local, base_rows, heads, *, pins=None, sticky=(), released=(), mode="cli", allow_deletes=False, files=None, pulled=None,
                expunge_holds=None, policy=None, confirm_mass_delete=False, defer_deletes=False):
    pol = policy or R.load_policy()
    pins = pins or {}
    files = files or {}
    pulled = pulled or {}
    plan = Plan()
    plan.fingerprints = {h: fingerprint(o) for h, o in local.items()}

    base = {h: row["obj"] for h, row in base_rows.items() if not row["deleted"] and isinstance(row["obj"], dict)}
    versions = {h: row["version"] for h, row in base_rows.items() if h in base}
    head_by = {h.handle: h for h in heads}
    cloud, exp_holds = {}, {h: list(p) for h, p in (expunge_holds or {}).items()}
    for head in heads:
        cloud[head.handle] = M.TOMBSTONE if head.deleted else head.obj
        versions[head.handle] = head.version

    # ---- expunge notices: the same version with another hash is a scrub in place; the base follows the website, the old value is held
    for head in heads:
        row = base_rows.get(head.handle)
        if head.deleted or row is None or row["deleted"] or head.version != row["version"] or row["hash"] == head.hash:
            continue
        paths = M.diff_pointers(base[head.handle], head.obj)
        plan.notices.append({"class": head.cls, "handle": head.handle, "gramps_id": head.gramps_id, "paths": paths})
        exp_holds[head.handle] = sorted(set(exp_holds.get(head.handle, [])) | set(paths))
        base[head.handle] = head.obj
        plan.base_ops.append(("set", head.cls, head.handle, head))

    # ---- inbound privacy: a pulled object that shows a local full date of birth is never applied
    index = dob_index(local.values(), sticky, pol)
    scan_table = scan_fields(pol)
    hit_handles = set()
    for head in heads:
        row = base_rows.get(head.handle)
        changed = row is None or row["deleted"] or head.hash != row["hash"] or head.version != row["version"]
        if head.deleted or not changed or head.handle in {n["handle"] for n in plan.notices}:
            continue
        if dob_hit(head.obj, index, pol, scan_table):
            hit_handles.add(head.handle)
            plan.incidents.append({"class": head.cls, "handle": head.handle, "gramps_id": head.gramps_id, "rule": INBOUND_RULE,
                                   "seq": head.seq,
                                   "offer": incident_offer(head.cls, head.handle)})
    # a pulled object that points at a withheld NEW object would dangle: it waits too (and what points at it), as a deferral, not an incident
    pulled_objs = {}
    for head in heads:
        row = base_rows.get(head.handle)
        changed = row is None or row["deleted"] or head.hash != row["hash"] or head.version != row["version"]
        if not head.deleted and changed and head.handle not in hit_handles and head.handle not in {n["handle"] for n in plan.notices}:
            pulled_objs[head.handle] = head.obj
    withheld_new = {h for h in hit_handles if h not in local}
    dependants = drop_dependants(pulled_objs, withheld_new, set(local)) if withheld_new else set()
    for h in sorted(dependants):
        head = head_by[h]
        plan.deferred.append({"class": head.cls, "handle": h, "gramps_id": head.gramps_id, "reason": "refers to an object withheld for privacy"})
    withheld = hit_handles | dependants
    for h in withheld:
        if h in base_rows and not base_rows[h]["deleted"] and h in base:
            cloud[h] = base[h]
            versions[h] = base_rows[h]["version"]
        else:
            cloud.pop(h, None)
            versions.pop(h, None)

    # ---- project, merge
    local_list = list(local.values())
    proj = PR.project(local_list, base=base, files=files, released=released, sticky=sticky, policy=pol)
    lp = symmetric(proj.projected, proj.holds)
    plan.projected = lp
    plan.sticky = proj.sticky
    plan.holds = proj.holds
    plan.sticky_held = sticky_held(local, proj.sticky, pol)

    def project_one(obj):
        objs = [obj if o.get("handle") == obj.get("handle") else o for o in local_list]
        if obj.get("handle") not in local:
            objs.append(obj)
        again = PR.project(objs, base=base, files=files, released=released, sticky=sticky, policy=pol)
        return symmetric(again.projected, again.holds).get(obj["handle"])

    tr = M.merge_tree(base, local, lp, cloud, versions=versions, pins=pins, project_fn=project_one, mode=mode,
                      allow_deletes=allow_deletes, sticky=sticky, policy=pol, cloud_is_delta=False)
    plan.results = tr.results
    plan.integrity = [{"problem": v["problem"], "involves": v["involves"]} for v in tr.integrity]
    plan.autos = [{"handle": a.get("handle"), "detail": a.get("detail")} if isinstance(a, dict) else {"detail": str(a)} for a in tr.autos]

    deletes = [h for h, r in tr.results.items() if r.action == "delete_local"]
    total = max(len(local), 1)
    plan.mass_delete = len(deletes) > MASS_DELETE_OBJECTS or len(deletes) * 100 > MASS_DELETE_PERCENT * total
    notice_by = {n["handle"]: n for n in plan.notices}

    for h in sorted(tr.results):
        r = tr.results[h]
        head = head_by.get(h)
        gid = r.gramps_id or _gid(local.get(h), head, base.get(h))
        plan.local_ids[h] = (r.cls, gid)
        if h in withheld:
            continue
        a = r.action
        if a in ("create_local", "update") and r.local_obj is not None:
            plan.commits[h] = r.local_obj
            plan.pulled_rows.append({"class": r.cls, "handle": h, "kind": "create" if a == "create_local" else "update",
                                     "prepull": _plain(lp.get(h)) if a == "update" else None})
        elif a == "delete_local":
            if defer_deletes:
                plan.blocked.append({"class": r.cls, "handle": h, "gramps_id": gid, "reason": "incoming delete (not confirmed in this window)"})
            elif plan.mass_delete and not confirm_mass_delete:
                plan.blocked.append({"class": r.cls, "handle": h, "gramps_id": gid,
                                     "reason": "mass delete: more than %d objects or %d %% of the tree" % (MASS_DELETE_OBJECTS, MASS_DELETE_PERCENT)})
            else:
                plan.removals.append(h)
                plan.pulled_rows.append({"class": r.cls, "handle": h, "kind": "delete", "prepull": _plain(lp.get(h))})
                plan.base_ops.append(("deleted", r.cls, h, head))
        elif a == "delete_deferred":
            plan.blocked.append({"class": r.cls, "handle": h, "gramps_id": gid, "reason": "incoming delete (the command line needs --allow-deletes)"})
        if a in ("unchanged", "converged", "create_local", "update") and head is not None and not head.deleted and h not in notice_by:
            row = base_rows.get(h)
            if row is None or row["deleted"] or row["version"] != head.version or row["hash"] != head.hash or row["seq"] != head.seq:
                plan.base_ops.append(("set", r.cls, h, head))
        elif a == "drop_base":
            plan.base_ops.append(("drop", r.cls, h, None))
        for c in r.conflicts:
            plan.conflicts.append(dict(c, gramps_id=c.get("gramps_id") or gid))
        for path in r.closed:
            plan.closed.append((h, path))
        if r.push is not None:
            op = _push(r, head, pulled.get(h), exp_holds.get(h), mode)
            if op is not None:
                plan.push_ops.append(op)
        if a == "update" and r.cls == "Media" and head is not None and not head.deleted:
            if _blob_changed(local.get(h), head.obj):
                plan.media.append(h)
        if a == "create_local" and r.cls == "Media" and head is not None and not head.deleted:
            plan.media.append(h)
    plan.expunge_holds = exp_holds
    plan.base_objs = base
    _finish(plan)
    return plan


def sticky_held(local, sticky, policy):
    """The events in the sticky set that are not birth-like now and whose local date still has a day or a month: the day and month stay
    on this computer until a person releases the handle (BRD2 11.1, PS-02). Handles and ids only."""
    out = []
    tree = R.Tree(list(local.values())) if sticky else None
    for h in sorted(sticky or ()):
        o = local.get(h)
        if isinstance(o, dict) and o.get("_class") == "Event" and isinstance(o.get("date"), dict) and R.date_violations(o["date"], policy) \
                and not R.is_birth_like(o, tree, policy):    # an event that is birth-like now is reduced by its own rule; a release would not change that
            out.append({"class": "Event", "handle": h, "gramps_id": o.get("gramps_id", "")})
    return out


def _blob_changed(local_obj, cloud_obj):
    return bool(cloud_obj.get("checksum")) and (not isinstance(local_obj, dict) or local_obj.get("checksum") != cloud_obj.get("checksum"))


def _push(result, head, pulled_rows, hold_pointers, mode):
    op = dict(result.push)
    cloud_obj = head.obj if head is not None and not head.deleted else None
    if hold_pointers and op["obj"] is not None and cloud_obj is not None:
        held = hold_back(op["obj"], cloud_obj, hold_pointers)
        op["obj"] = held
        if held == cloud_obj:
            return None  # the held pointers were all that differed: nothing to send
    reverts = revert_paths(op, cloud_obj, pulled_rows)
    op["needs_step_up"] = bool(result.needs_step_up) or op["op"] == "delete"
    op["reverts"] = reverts
    op["label"] = REVERT_LABEL if reverts else ""
    if reverts:
        op["disposition"] = "parked" if mode == "cli" else "confirm"
    elif op["op"] == "delete" and mode != "cli":
        op["disposition"] = "confirm"
    else:
        op["disposition"] = "send"
    op["gramps_id"] = result.gramps_id
    return op


def _finish(plan):
    plan.parked = [o for o in plan.push_ops if o["disposition"] == "parked"]
    plan.planned_push = {"create": 0, "update": 0, "delete": 0}
    for o in plan.push_ops:
        if o["disposition"] in ("send", "confirm"):
            plan.planned_push[{"create": "create", "delete": "delete", "withdraw": "delete"}.get(o["op"], "update")] += 1
    plan.counts = status_counts(plan)
    plan.plan_hash = plan_hash(plan)


def status_counts(plan):
    """The `counts` of status.json for a plan. `pushed` stays zero: this build plans pushes (the preview lists them), `addon-push` sends."""
    pulled = {"create": 0, "update": 0, "delete": 0}
    for row in plan.pulled_rows:
        if row["handle"] in plan.commits or row["handle"] in plan.removals:
            pulled[row["kind"]] += 1
    return {"pulled": pulled, "pushed": {"create": 0, "update": 0, "delete": 0}, "conflicts_open": len(plan.conflicts),
            "holds": len(plan.holds), "blocked": len(plan.blocked) + len(plan.parked) + len(plan.deferred), "media_up": 0, "media_down": 0,
            "privacy_incidents": len(plan.incidents), "push_pending": sum(plan.planned_push.values())}


def plan_hash(plan):
    """sha256 over what the plan will do, not over when or by whom it was made: the entries a person would review."""
    rows = []
    for h in sorted(set(plan.commits) | set(plan.removals)):
        rows.append(["local", h, plan.results[h].action, chash(plan.commits[h]) if h in plan.commits else "removed"])
    for o in plan.push_ops:
        rows.append(["push", o["class"], o["handle"], o["op"], o["base_version"], chash(o["obj"]), o["disposition"], o["reverts"]])
    for c in plan.conflicts:
        rows.append(["conflict", c["id"], chash([c.get("cloud_json"), c.get("local_json")])])
    for i in plan.incidents:
        rows.append(["incident", i["class"], i["handle"], i["rule"]])
    for n in plan.notices:
        rows.append(["notice", n["class"], n["handle"], n["paths"]])
    for b in plan.blocked:
        rows.append(["blocked", b["class"], b["handle"], b["reason"]])
    for d in plan.deferred:
        rows.append(["deferred", d["class"], d["handle"], d["reason"]])
    rows.append(["media", sorted(plan.media)])
    rows.sort(key=lambda r: json.dumps(r, sort_keys=True))
    return hashlib.sha256(json.dumps({"v": 1, "rows": rows}, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------------------------------------------- preview file

_CLIP = 200


def _clip(value):
    if isinstance(value, str):
        return value if len(value) <= _CLIP else value[:_CLIP] + "..."
    if value is _MISSING:
        return None
    text = json.dumps(value, sort_keys=True, default=str)
    return value if len(text) <= 2 * _CLIP else {"clipped_bytes": len(text)}


def _changes(a, b, left, right):
    out = []
    for p in M.diff_pointers(a, b) if isinstance(a, dict) and isinstance(b, dict) else [""]:
        out.append({"path": p, left: _clip(_get(a, p)) if a is not None else None, right: _clip(_get(b, p)) if b is not None else None})
    return out


def preview(plan, run_id, action, mode, snapshot, now):
    """The preview file's document: pointers and projected values only (BRD2 11.1: the CLI never prints field values)."""
    def entry(h, extra):
        cls, gid = plan.local_ids.get(h, ("", ""))
        return dict({"class": cls, "handle": h, "gramps_id": gid}, **extra)

    heads = snapshot.by_handle
    from_site, to_site = [], []
    for h in sorted(plan.commits):
        r = plan.results[h]
        head = heads.get(h)
        base_obj = plan.base_objs.get(h)
        from_site.append(entry(h, {"action": r.action, "changes": _changes(base_obj, head.obj, "base", "website") if head and base_obj is not None
                                    else [{"path": "", "website": "new object"}]}))
    for h in sorted(plan.removals):
        from_site.append(entry(h, {"action": "delete_local", "changes": [{"path": "", "website": "deleted on the website"}]}))
    for o in plan.push_ops:
        head = heads.get(o["handle"])
        cloud_obj = head.obj if head is not None and not head.deleted else None
        to_site.append({"class": o["class"], "handle": o["handle"], "gramps_id": o.get("gramps_id", ""), "op": o["op"],
                        "label": o["label"], "disposition": o["disposition"], "needs_step_up": o["needs_step_up"],
                        "changes": _changes(cloud_obj, o["obj"], "website", "desktop") if o["obj"] is not None and cloud_obj is not None else
                        [{"path": "", "desktop": "new object" if o["op"] == "create" else o["op"]}]})
    conflicts = [{"id": c["id"], "class": c.get("class", ""), "handle": c.get("handle", ""), "gramps_id": c.get("gramps_id", ""),
                  "kind": c["kind"], "path": c["path"], "reason": c["reason"], "disposition": c.get("disposition"),
                  "base": _clip(c.get("base")), "website": _clip(c.get("cloud")), "desktop": _clip(c.get("local"))} for c in plan.conflicts]
    return {
        "schema": 1, "run_id": run_id, "action": action, "mode": mode, "created_at": now, "plan_hash": plan.plan_hash,
        "snapshot": {"seq": snapshot.seq, "body_sha256": snapshot.body_sha256, "count": snapshot.header["count"]},
        "counts": plan.counts, "planned_push": plan.planned_push, "from_website": from_site, "to_website": to_site, "conflicts": conflicts,
        "held": [{"handle": x["handle"], "rule": x["rule"], "scope": x["scope"], "pointer": x["pointer"]} for x in plan.holds],
        "blocked": plan.blocked, "deferred": plan.deferred, "media_to_download": sorted(plan.media),
        "sticky_held": plan.sticky_held, "decided": plan.decided, "undecided": plan.undecided, "reviewed_hash": plan.reviewed_hash,
        "incidents": [{"class": i["class"], "handle": i["handle"], "gramps_id": i["gramps_id"], "rule": i["rule"], "offer": i["offer"]} for i in plan.incidents],
        "expunge_notices": plan.notices, "mass_delete": plan.mass_delete,
        "integrity": plan.integrity,
    }
