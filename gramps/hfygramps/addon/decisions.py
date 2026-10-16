"""Web conflict decisions on a pull (HFY-TSK-338, SI-30; sync.md 6.7, BRD2 11.1 6.7).

An admin can decide a parked conflict on the website: keep the website's value (`keep_cloud`) or the desktop's (`keep_desktop`). The decision
is stored with `{cloud_version, cloud_value_hash}`: the version of the website's record and the hash of the website's values at the conflict's
paths when the admin decided. The addon applies it only while both still match; otherwise the website reopens the conflict (state open, the old
decision kept as history) and nothing is applied.

    ask        POST /api/sync/conflicts/reconcile with the website values the merge just found at every open conflict path (`observed`).
               The website checks every pending decision against its record and answers `apply` and `reopened`. A `check`, or any dry
               run, sends `dry: true`: the website writes nothing and `reopened` lists what a real pull would reopen.
    check      the same rule, here, against the cloud state this run planned from (`stale_reason`): a decision the website called valid
               but this snapshot does not match is held, not applied. The hash is the website's: sha256 of the canonical JSON of
               `[{path, cloud}]`, byte for byte (`api/src/sync/pull.js` `cloudValueHash`).
    apply      by the ordinary merge, never by editing the tree: the decided conflict's pin gets the base that makes the three-way rule
               produce the decision. `keep_cloud`: the base becomes the desktop value, so the website's change is taken. `keep_desktop`:
               the base becomes the website's value, so the desktop's change is kept and goes in the push. The plan, preview, backup, one
               transaction and the sidecar update are the pull's own.
    settle     after the plan: a pin the merge closed is applied; one that still conflicts (a composite conflict, or the desktop value
               changed again) is held and stays open.
    receipt    after the sidecar commit, `POST /api/sync/conflicts/:id/applied` for each applied decision, and for a decision with no
               conflict left on the desktop (`moot`), so the website offers it no more.

Not handled: a conflict on the whole object (path ""), which the Gramps window resolves. Reports hold ids, pointers and reasons, never values.
Standard library only.
"""
import hashlib
import json
import re

from .. import canonical
from .. import merge as M
from . import transport

APPLICABLE = ("keep_cloud", "keep_desktop")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_UNRESOLVED = object()

#: What a report says about a decision. `apply` is only a plan: `settle` turns it into `applied` or `held`.
APPLY, APPLIED, REOPENED, HELD, MOOT = "apply", "applied", "reopened", "held", "moot"


def cloud_value_hash(paths):
    """sha256 hex of the canonical JSON of the cloud values at a conflict's paths (the website's `cloudValueHash`), or None when a value has no
    canonical form (a float), which never equals a stored hash."""
    rows = [{"path": "" if p.get("path") is None else str(p.get("path")), "cloud": p.get("cloud")} for p in paths]
    try:
        return hashlib.sha256(canonical.canonical_json(rows).encode("utf-8")).hexdigest()
    except canonical.CanonicalError:
        return None


def stale_reason(decision, version, paths):
    """None while a stored decision still applies, else why not (the website's `decisionStaleReason`): `not_resolved`, `no_hash`,
    `version_changed` or `value_changed`. `paths` are the conflict's paths with the CURRENT cloud values, `version` the cloud head's."""
    if decision.get("state") != "resolved":
        return "not_resolved"
    stored = decision.get("cloud_value_hash")
    if not isinstance(stored, str) or not _HASH.match(stored):
        return "no_hash"
    cv = decision.get("cloud_version")
    cv = cv if isinstance(cv, int) and not isinstance(cv, bool) else None
    now = version if isinstance(version, int) and not isinstance(version, bool) else None
    if cv != now:
        return "version_changed"
    if stored != cloud_value_hash(paths):
        return "value_changed"
    return None


def cloud_value_at(obj, path):
    """The value at an RFC 6901 pointer of a cloud object (an absent member reads None), or `_UNRESOLVED` for a pointer that cannot be followed
    here (a keyed-list token such as ``ref#0``, a derived view key). The website's `cloudValueAt`."""
    if not isinstance(path, str) or (path != "" and not path.startswith("/")):
        return _UNRESOLVED
    node = obj
    for raw in ([] if path == "" else path[1:].split("/")):
        tok = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            if not re.match(r"^(0|[1-9][0-9]*)$", tok):
                return _UNRESOLVED
            i = int(tok)
            node = node[i] if i < len(node) else None
        elif isinstance(node, dict):
            if tok in ("_birth_ref", "_death_ref"):
                return _UNRESOLVED
            node = node.get(tok)
        else:
            node = None
        if node is None:
            return None
    return node


class Entry:
    """One cloud decision, and what this run does with it."""

    def __init__(self, cloud_id, decision, cls, handle, gramps_id, status, reason=None):
        self.cloud_id, self.decision, self.cls, self.handle, self.gramps_id = cloud_id, decision, cls, handle, gramps_id
        self.status, self.reason = status, reason
        self.planned = False
        self.matched = []   # [(path, local conflict dict)] the open desktop conflicts this decision is about

    def report(self):
        """The preview and sidecar form: ids, pointers and words only."""
        return {"id": self.cloud_id, "decision": self.decision, "class": self.cls, "handle": self.handle, "gramps_id": self.gramps_id,
                "status": self.status, "reason": self.reason, "paths": [p for p, _c in self.matched], "conflicts": [c["id"] for _p, c in self.matched]}


class Outcome:
    """What the decisions of one run come to. `overrides` {(handle, path): base_json or None} rewrite the pins the plan merges with."""

    def __init__(self, entries=(), dry=False, error=None):
        self.entries = list(entries)
        self.dry = dry
        self.error = error
        self.overrides = {}
        for e in self.entries:
            e.planned = e.status == APPLY   # only a decision planned with a rewritten pin can be settled
            if not e.planned:
                continue
            for path, c in e.matched:
                self.overrides[(e.handle, path)] = c.get("local_json") if e.decision == "keep_cloud" else c.get("cloud_json")

    def pins(self, pins):
        """`sidecar.load_pins` with the decided pins' bases replaced."""
        out = {h: [dict(p) for p in ps] for h, ps in pins.items()}
        for (h, path), base_json in self.overrides.items():
            for p in out.get(h, []):
                if p["path"] == path:
                    p["base_json"] = base_json
        return out

    def settle(self, plan):
        """After a plan made with the overrides: a decision whose pins the merge closed is `applied`; one with a pin that still conflicts is
        `held`. Reasons are words, never values."""
        closed = set(plan.closed)
        still = {c["id"] for c in plan.conflicts}
        for e in self.entries:
            if not e.planned or not e.matched:
                continue
            ok = all((e.handle, path) in closed and c["id"] not in still for path, c in e.matched)
            e.status, e.reason = (APPLIED, None) if ok else (HELD, "conflict_remains")

    def by_status(self, *statuses):
        return [e for e in self.entries if e.status in statuses]

    def preview(self):
        return [e.report() for e in self.entries]

    def summary(self):
        out = {s: 0 for s in (APPLIED, REOPENED, HELD, MOOT)}
        for e in self.entries:
            if e.status in out:
                out[e.status] += 1
            elif e.status == APPLY:
                out[APPLIED] += 1
        return out


# ---------------------------------------------------------------------------------------------------------------- collecting


def _observed(plan):
    """The cloud value the merge found at each open conflict path of this plan: what the website cannot derive for a keyed-list path."""
    return [{"class": c["class"], "handle": c["handle"], "path": c["path"], "cloud": c.get("cloud")}
            for c in plan.conflicts if c.get("path") and c.get("class") and c.get("handle")][:500]


def collect(ctx, cloud, plan):
    """The decisions this run weighs, from the website, against `plan` (a plan made without any decision) and the cloud state `ctx.snap`.

    Returns an Outcome. A website that has no reconcile route (an older one), or that does not answer, gives an empty Outcome: a decision is
    never needed for a pull to be right, and what is not applied now is offered again on the next run.
    """
    fn = getattr(cloud, "reconcile_decisions", None)
    if fn is None:
        return Outcome()
    try:
        answer = fn(_observed(plan), dry=ctx.dry)
    except transport.TransportError as exc:
        ctx.log.line("decisions: skipped (%s)" % exc.code)
        return Outcome(error=exc.code)
    if not isinstance(answer, dict):
        ctx.log.line("decisions: skipped (bad_answer)")
        return Outcome(error="bad_answer")
    return _weigh(ctx, plan, answer)


def _weigh(ctx, plan, answer):
    by_id = {c["id"]: c for c in plan.conflicts}
    snap = ctx.snap
    claimed = set()
    entries = []
    server_reopened = {}
    for row in answer.get("reopened") or []:
        if isinstance(row, dict) and isinstance(row.get("id"), str):
            server_reopened[row["id"]] = row
    rows = [("apply", r) for r in answer.get("apply") or []] + [("reopened", r) for r in answer.get("reopened") or []]
    for kind, d in rows:
        if not isinstance(d, dict) or not isinstance(d.get("id"), str):
            continue
        decision = d.get("decision") or _last_decision(d)   # a reopened conflict has no decision any more, only its history
        if decision not in APPLICABLE:
            continue
        cls, handle = d.get("class"), d.get("handle")
        if not isinstance(cls, str) or not isinstance(handle, str):
            continue
        paths = [p for p in d.get("paths") or [] if isinstance(p, dict) and isinstance(p.get("path"), str)]
        entry = Entry(d["id"], decision, cls, handle, d.get("gramps_id") or "", APPLY)
        for p in paths:
            local = by_id.get(M._conflict_id(cls, handle, p["path"]))
            if local is not None and p["path"] != "":
                entry.matched.append((p["path"], local))
        if kind == "reopened":
            entry.status, entry.reason = REOPENED, str(d.get("reason") or "")
            entries.append(entry)
            continue
        head = snap.by_handle.get(handle)
        version = head.version if head is not None else None
        stale = stale_reason(dict(d, state="resolved"), version, _current(paths, entry.matched, head))
        if stale is not None:
            entry.status, entry.reason = HELD, "changed_since_check"
        elif not entry.matched:
            entry.status = MOOT
        elif any(local["id"] in claimed for _p, local in entry.matched):
            entry.status, entry.reason = MOOT, "superseded"
        entries.append(entry)
        if entry.status == APPLY:
            claimed.update(local["id"] for _p, local in entry.matched)
    # a decision the website returned neither way (applied meanwhile, or past its page budget) is simply not weighed
    ctx.log.line("decisions: %s" % " ".join("%s=%d" % kv for kv in sorted(Outcome(entries).summary().items())))
    return Outcome(entries, dry=ctx.dry)


def _last_decision(d):
    history = d.get("history")
    last = history[-1] if isinstance(history, list) and history and isinstance(history[-1], dict) else {}
    return last.get("decision")


def _current(paths, matched, head):
    """The conflict's paths with the cloud values of this run: the merge's where this desktop has the conflict, else the snapshot head's own
    value at the pointer, else the stored one. The same order as the website's `currentPaths`."""
    seen = {path: c.get("cloud") for path, c in matched}
    out = []
    for p in paths:
        path = p["path"]
        if path in seen:
            out.append({"path": path, "cloud": seen[path]})
            continue
        if head is None or head.deleted or head.obj is None:
            out.append({"path": path, "cloud": None})
            continue
        v = cloud_value_at(head.obj, path)
        out.append(p if v is _UNRESOLVED else {"path": path, "cloud": v})
    return out


# ---------------------------------------------------------------------------------------------------------------- after the run


def persist(side, outcome, now):
    """In the pull's sidecar transaction: link each decision's desktop conflicts to the website's conflict, record the decision on the ones
    applied, and keep the last run's report in `meta.web_decisions` (ids, reasons and counts)."""
    from . import sidecar

    for e in outcome.entries:
        for _path, c in e.matched:
            if e.status == APPLIED:
                side.execute("UPDATE conflicts SET decision = ?, cloud_conflict_id = ?, state = 'resolved', resolved_at = COALESCE(resolved_at, ?) WHERE id = ?",
                             (e.decision, e.cloud_id, now, c["id"]))
            elif e.status in (REOPENED, HELD):
                side.execute("UPDATE conflicts SET cloud_conflict_id = ? WHERE id = ? AND state IN ('open', 'parked')", (e.cloud_id, c["id"]))
    report = {"at": now, "counts": outcome.summary(),
              "reopened": [e.report() for e in outcome.by_status(REOPENED)], "held": [e.report() for e in outcome.by_status(HELD)]}
    if outcome.entries or outcome.error:
        report["error"] = outcome.error
        sidecar.set_meta_json(side, "web_decisions", report)


def acknowledge(ctx, cloud, outcome):
    """The receipts: `applied` for each applied decision, `moot` for one with no conflict left here. A receipt that fails is logged and left; the
    next pull offers the decision again (a keep_cloud one finds nothing to do and is receipted then)."""
    fn = getattr(cloud, "decision_applied", None)
    if fn is None:
        return
    for e in outcome.entries:
        if e.status not in (APPLIED, MOOT):
            continue
        try:
            fn(e.cloud_id, "applied" if e.status == APPLIED else "moot")
        except transport.TransportError as exc:
            ctx.log.line("decisions: receipt not sent (%s)" % exc.code)
