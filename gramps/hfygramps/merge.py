"""The three-way field-level merge engine, lift, symmetry checks and conflict model (HFY-PLN-002 sync.md section 6 as amended by BRD2
section 11.1; task merge-engine-py).

Standard library only, imports nothing from Gramps, runs in Gramps' bundled Python and in CI's stock python3 (3.10 and later).

Vocabulary (sync.md 6.3):

    B  the base: the cloud object at the last sync (projected form, from the sidecar)
    L  the local Gramps object (raw ``json_data``); P(L) = ``local_proj`` is its projection (``projection.project_tree``)
    C  the cloud object now (projected form), or ``TOMBSTONE``, or ``None`` (the store has no such head)
    M  the merged object, still in projected form

    merge_object(B, L, P(L), C, ...)   one object, the object-level table of 6.4 and the field-level rules of 6.3
    merge_tree(base, local, ...)       every object, then the relationship symmetry and reference checks of 6.6
    lift(C, L, P(L))                   the local-form object for a projected one: every local-only part of L comes back

A run produces, per object, ``local_obj`` (``lift(M, L)``, what to commit in Gramps, ``None`` when nothing changes) and ``push``
(``obj = P(lift(M, L))`` with ``base_version = C.version``, ``None`` when it equals C), exactly as 8.3 step 12 requires; both edits
of a web change to field a and a desktop change to field b are in ``push["obj"]`` and in ``local_obj`` after one run.

The merge view (6.2). Each object is turned into a view before anything is compared: ``change`` is dropped (derived), the
``birth_ref_index`` and ``death_ref_index`` of a Person become ``_birth_ref`` and ``_death_ref`` (the key of the event reference
they name, re-indexed after the merge), and every list becomes a list view (``LV``) by its property name:

    keyed   ``event_ref_list``, ``media_list``, ``person_ref_list``, ``reporef_list``, ``placeref_list``, ``child_ref_list``.
            Element key ``<ref>#<n>``, n the occurrence among equal refs (a child reference's ref is unique, so its key is ``<ref>#0``).
            A side's elements are matched to the base's by content first, then by occurrence among the leftovers of one ref; a
            leftover count that disagrees is a stale key and the whole list is a ``list`` conflict, never a different element
            (11.1, 6.2). A new element is keyed ``<ref>#+<content hash>``, so equal additions on both sides converge and
            different ones coexist. Elements merge field by field, so a ``MediaRef.rect`` edited on the web and its ``note_list``
            edited on the desktop both survive.
    set     ``family_list``, ``parent_family_list``, ``note_list``, ``citation_list``, ``tag_list``: ordered sets of handles.
    bag     ``alternate_names``, ``attribute_list``, ``urls``, ``surname_list``, ``alt_names``, ``alt_loc``, ``address_list``,
            ``lds_ord_list``: identity-less values keyed by the canonical hash of the element, never by position.

A bag cannot tell an edited element from a removal plus an addition, so an element both sides dropped, with a different addition on
each side, is the "ambiguous pairing" conflict even when the additions are unrelated: the engine asks rather than guesses. Raw
local views (the desktop object against its projection) may carry elements the projection dropped (private duplicates): a
duplicate with no leftover counterpart in the projection just gets a new key; only when the projection's own element also
differs from the raw one is the pairing ambiguous, and the object is held as a stale key.

Atomic values (never split): ``Date`` (``sortval`` is derived and ignored when comparing), ``StyledText``, every ``GrampsType``,
``MediaRef.rect`` and any list this table does not name. ``Media.checksum`` of a file the addon could not read is derived too
(``merge_context(..., unreadable=...)``): it is never compared, each side keeps its own value. Order: if only one side reordered a list, that order wins; if both did,
the local order wins and the cloud-only keys are appended (an automatic resolution, listed in ``result.autos``).

The three-way rule per path, on ``b = B[path]``, ``l = P(L)[path]`` and ``c = C[path]``:

    l == c               converged
    l == b, c != b       take the cloud value, unless the composite rule below makes it a conflict
    c == b, l != b       take the local value (it goes in the push)
    otherwise            conflict (``kind: field``; ``list`` for a bag, a stale key or a delete against an edit of a list element)

The composite rule: ``c != b`` on a field whose local value is refined by a local-only part (the raw L differs from P(L) there:
a birth date with a local day and month, an event place that is a street-level descendant, a held field) is a ``composite``
conflict even though ``l == b``. So is a cloud change to an event's ``type``, to the ``role`` of a reference to an event, or to a
person's ``_birth_ref``, when the event is birth-like locally or was birth-like at the base (``merge_context``): never auto-taken.

Pinning (6.7). A conflict pins its path. ``pins`` are the sidecar's open conflicts, ``{"path", "base_json"}`` (``base_json`` is
the base value at the path as canonical JSON, ``None`` when the path was absent at the base): while a pin is open that value is
the base for the path and its descendants, whatever the object's base row says, so a base row that advanced for other paths can
never turn the pinned path into a silent take-local or take-cloud. The push carries the cloud value at a conflict path, the local
apply keeps the local value there, and ``result.conflicts`` lists the conflict again each run (same ``id``) until a run finds the
path converged or one-sided; the pin is then in ``result.closed``. A pin with the path ``""`` is on the whole object (a delete
against an edit, an identity or integrity freeze): it stores no kind or reason, the object is merged again each run and finds the
same object-level conflict while the cause stands, and the pin is in ``result.closed`` when the cause is gone (``merge_tree``
re-checks integrity on the result, so a violation that still stands freezes the object again).

Lift (6.5). ``lift(C, L, P(L))`` is the same engine run in its lift mode: a three-way merge with P(L) as the base, L as the local
side and C as the cloud side, where a conflict takes C. What differs between L and P(L) is exactly what P took out of L (local-only
date parts, addresses, private list elements, local-only attributes, ``Media.path``, held fields, street-level places and refs,
precise coordinates and rectangles, ``lds_ord_list``), and what differs between C and P(L) is what the cloud changed, so every
local-only part comes back and ``P(lift(C, L)) == C`` for every C the checker accepts. The indexes are recomputed from ``_birth_ref``.
``change`` is the one top-level key kept from L; Gramps stamps it again on commit.

Conflicts hold projected values only (``base``, ``cloud`` and ``local`` are what the cloud may see; the sidecar mirrors them to
the cloud). The raw desktop value at a conflict's path comes from ``local_value`` and goes to ``resolve_conflict`` as ``local_raw``
when the user keeps mine, so a composite conflict's desktop-only refinement is never overwritten by its own projection.

An object the cloud must not have (``local_proj`` is None) that was synced before is withdrawn (``action: withdraw``, a push op
``withdraw`` with no step-up, sync.md 5.1); with no cloud copy left its base row is dropped.
"""

import copy
import hashlib
import json
import re

from . import projection as PR
from . import rules as R

TOMBSTONE = "tombstone"


class _Missing:
    """The value of an absent key (distinct from JSON ``null``)."""

    __slots__ = ()

    def __repr__(self):
        return "MISSING"


MISSING = _Missing()

KEYED = ("event_ref_list", "media_list", "person_ref_list", "reporef_list", "placeref_list", "child_ref_list")
SETS = ("family_list", "parent_family_list", "note_list", "citation_list", "tag_list")
BAGS = ("alternate_names", "attribute_list", "urls", "surname_list", "alt_names", "alt_loc", "address_list", "lds_ord_list")
LIST_KIND = dict([(n, "keyed") for n in KEYED] + [(n, "set") for n in SETS] + [(n, "bag") for n in BAGS])
ATOMIC_CLASSES = ("Date", "StyledText")
DERIVED = ("change", "birth_ref_index", "death_ref_index")
INDEX_FIELDS = (("birth_ref_index", "_birth_ref"), ("death_ref_index", "_death_ref"))

KINDS = ("field", "composite", "list", "delete_edit", "identity", "integrity")

#: What the preview and the GUI show as the reason of a conflict.
REASON_DESKTOP_ONLY = "has desktop-only data"


def _dump(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _chash(value, n=12):
    return hashlib.sha256(_dump(value).encode("utf-8")).hexdigest()[:n]


def _esc(token):
    return str(token).replace("~", "~0").replace("/", "~1")


def _path(toks):
    return "".join("/" + _esc(t) for t in toks)


class LV:
    """A list view: ``kind`` (keyed, set or bag), ``order`` (the keys in list order), ``items`` (key -> element view for a keyed
    list, key -> the plain element for a set or a bag) and ``stale`` (the refs whose elements could not be matched to the base)."""

    __slots__ = ("kind", "order", "items", "stale")

    def __init__(self, kind, order, items, stale=()):
        self.kind, self.order, self.items, self.stale = kind, list(order), items, list(stale)


def _eq(a, b):
    """Structural equality of views and plain values: ``Date.sortval`` (derived) is ignored, a list view compares kind, key order
    and elements, and ``True`` is not ``1``."""
    if a is b:
        return True
    if isinstance(a, LV):
        return (isinstance(b, LV) and a.kind == b.kind and a.order == b.order
                and all(_eq(v, b.items[k]) for k, v in a.items.items()))
    if isinstance(b, LV) or a is MISSING or b is MISSING:
        return False
    if isinstance(a, dict):
        if not isinstance(b, dict):
            return False
        skip = "sortval" if "Date" in (a.get("_class"), b.get("_class")) else None
        ka, kb = set(a) - {skip}, set(b) - {skip}
        return ka == kb and all(_eq(a[k], b[k]) for k in ka)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _atomic(d):
    cls = d.get("_class")
    return cls in ATOMIC_CLASSES or (isinstance(cls, str) and cls.endswith("Type"))


def strip_change(obj):
    """A copy of an object without Gramps' ``change`` stamp (derived)."""
    return {k: copy.deepcopy(v) for k, v in obj.items() if k != "change"}


# --------------------------------------------------------------------------------------------------------------------
# The merge view.


def _ref_of(element):
    return element.get("ref") if isinstance(element, dict) else None


def _keyed_keys(node, ref):
    """``(keys, stale)``: the key of every element of a keyed list. Without a reference view, ``<ref>#<n>``; against one, each
    element takes the key of the base element it is (equal content first, then the n-th leftover of the same ref)."""
    refs = [_ref_of(e) for e in node]
    keys = [None] * len(node)
    stale = []
    if ref is None:
        seen = {}
        for i, r in enumerate(refs):
            n = seen.get(r, 0)
            seen[r] = n + 1
            keys[i] = "%s#%d" % (r, n)
        return keys, stale
    base = [(k, _render(ref.items[k])) for k in ref.order]
    used = set()
    for i, e in enumerate(node):
        for k, be in base:
            if k not in used and _ref_of(be) == refs[i] and _eq(be, e):
                keys[i] = k
                used.add(k)
                break
    left_nodes, left_base = {}, {}
    for i, k in enumerate(keys):
        if k is None:
            left_nodes.setdefault(refs[i], []).append(i)
    for k, be in base:
        if k not in used:
            left_base.setdefault(_ref_of(be), []).append(k)
    for r, idxs in left_nodes.items():
        ks = left_base.get(r, [])
        if ks and len(ks) != len(idxs):
            stale.append(r)
        for i, k in zip(idxs, ks):
            keys[i] = k
    fresh = {}
    for i, k in enumerate(keys):
        if k is None:
            h = _chash(node[i])
            j = fresh.get(h, 0)
            fresh[h] = j + 1
            keys[i] = "%s#+%s%s" % (refs[i], h, ".%d" % j if j else "")
    return keys, stale


def _build_list(node, name, ref):
    kind = LIST_KIND[name]
    ref = ref if isinstance(ref, LV) and ref.kind == kind else None
    if kind == "keyed":
        keys, stale = _keyed_keys(node, ref)
        items = {k: _build(e, None, ref.items.get(k) if ref else None) for k, e in zip(keys, node)}
        return LV(kind, keys, items, stale)
    seen, keys = {}, []
    for e in node:
        h = _chash(e)
        n = seen.get(h, 0)
        seen[h] = n + 1
        keys.append("%s#%d" % (h, n))
    return LV(kind, keys, {k: copy.deepcopy(e) for k, e in zip(keys, node)})


def _build(node, name, ref):
    if isinstance(node, dict):
        if _atomic(node):
            return copy.deepcopy(node)
        rd = ref if isinstance(ref, dict) else {}
        out = {k: _build(v, k, rd.get(k)) for k, v in node.items() if k not in DERIVED}
        order = getattr(out.get("event_ref_list"), "order", [])
        for field, view_key in INDEX_FIELDS:
            if field in node:
                i = node[field]
                out[view_key] = order[i] if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(order) else None
        return out
    if isinstance(node, list) and name in LIST_KIND:
        return _build_list(node, name, ref)
    return copy.deepcopy(node)


def _render(view):
    """The plain value of a view: lists back in key order, ``_birth_ref`` and ``_death_ref`` back as indexes (-1 for none)."""
    if isinstance(view, LV):
        return [_render(view.items[k]) for k in view.order]
    if isinstance(view, dict):
        out = {k: _render(v) for k, v in view.items() if k not in ("_birth_ref", "_death_ref")}
        order = getattr(view.get("event_ref_list"), "order", [])
        for field, view_key in INDEX_FIELDS:
            if view_key in view:
                key = view[view_key]
                out[field] = order.index(key) if key in order else -1
        return out
    if isinstance(view, list):
        return [_render(v) for v in view]
    return copy.deepcopy(view)


def merge_view(obj, ref=None):
    """The merge view of a plain object (6.2). ``ref`` is another view (the base's) to key the keyed lists against."""
    return _build(obj, None, ref)


def render_view(view):
    """The plain object of a merge view (the inverse of ``merge_view``)."""
    return _render(view)


# --------------------------------------------------------------------------------------------------------------------
# Context: what is birth-like, locally or at the base.


class Context:
    """``birthlike``: handles of the events that are birth-like locally (or sticky) or were birth-like at the base.
    ``unreadable``: handles of the Media whose file the addon could not read (their ``checksum`` is derived, sync.md 6.1)."""

    def __init__(self, birthlike=(), unreadable=()):
        self.birthlike = frozenset(birthlike)
        self.unreadable = frozenset(unreadable)


def merge_context(local_objects, base_objects=(), sticky=(), policy=None, unreadable=()):
    """The context of a run: ``local_objects`` and ``base_objects`` are iterables of Gramps objects (the base ones are the cloud
    copies the sidecar holds), ``sticky`` the stored ``birthlike_sticky`` handles, ``unreadable`` the Media handles whose file
    could not be read."""
    pol = policy or R.load_policy()
    out = set(sticky or ())
    for objects in (local_objects, base_objects):
        tree = R.Tree(list(objects))
        out.update(e["handle"] for e in tree.of_class("Event") if "handle" in e and R.is_birth_like(e, tree, pol))
    return Context(out, unreadable)


def update_baseline(sticky, objects, base=None, released=(), policy=None):
    """The ``birthlike_sticky`` set to store with the sidecar after a run: the stored set unioned with the events that are birth-like
    now, were birth-like at ``base`` or share a local full birth date, minus the handles io released (``projection.
    update_birthlike_sticky``). The projection never carries Gramps' change stamp, so nothing else of the baseline needs
    persisting beyond the base rows the run returns in ``base_after``. Feed the result back as ``sticky`` to both the projection
    and ``merge_context`` on the next run."""
    return frozenset(PR.update_birthlike_sticky(sticky, objects, base, released, policy))


# --------------------------------------------------------------------------------------------------------------------
# The engine.


class LiftError(ValueError):
    """A lift that cannot be made safely (a keyed list whose elements cannot be matched to P(L)): the caller holds the object."""


def _conflict_id(cls, handle, path):
    return "cf-" + _chash("%s:%s:%s" % (cls, handle, path), 16)


def _plain(view):
    return None if view is MISSING else _render(view)


def _json(view):
    return None if view is MISSING else _dump(_render(view))


class _Merge:
    """One pass of the three-way engine over views. ``mode`` is ``local`` (a conflict keeps the local value: the local apply),
    ``push`` (a conflict takes the cloud value: the push) or ``lift`` (the same, with P(L) as the base: no composite rule, no
    pins, and a list that cannot be matched raises ``LiftError``)."""

    def __init__(self, mode, cls=None, handle=None, ctx=None, pins=None, strict=True):
        self.mode, self.strict = mode, strict
        self.take_cloud = mode != "local"
        self.composite = mode != "lift"
        self.cls, self.handle = cls, handle
        self.ctx = ctx or Context()
        self.pins = pins or {}
        self.conflicts, self.autos = [], []

    def m(self, b, l, c, toks, raw, elem=False):
        """Merge one node; ``raw`` is the matching node of the raw local object's view (``MISSING`` when there is none)."""
        path = _path(toks)
        if path in self.pins:
            pin = self.pins[path]
            b = MISSING if pin is MISSING else _build(pin, toks[-1], b)
        return self._m(b, l, c, toks, raw, elem)

    def _m(self, b, l, c, toks, raw, elem):
        if _eq(l, c):
            return l
        if toks == ("checksum",) and self.cls == "Media" and self.handle in self.ctx.unreadable:
            return c if self.take_cloud else l              # derived: never compared, each side keeps its own value
        if isinstance(b, LV) and isinstance(l, LV) and isinstance(c, LV):
            return self._list(b, l, c, toks, raw)
        if all(isinstance(x, dict) and not _atomic(x) for x in (b, l, c)):
            return self._dict(b, l, c, toks, raw)
        if _eq(l, b):
            why = self._composite(b, l, c, toks, raw)
            if why:
                return self._conflict("composite", toks, b, l, c, why)
            return c
        if _eq(c, b):
            return l
        if elem:
            return self._conflict("list", toks, b, l, c, "edited on one side, removed on the other")
        return self._conflict("field", toks, b, l, c, "changed on both sides")

    def _dict(self, b, l, c, toks, raw):
        out = {}
        rawd = raw if isinstance(raw, dict) else {}
        for k in dict.fromkeys(list(l) + list(c) + list(b)):
            r = self.m(b.get(k, MISSING), l.get(k, MISSING), c.get(k, MISSING), toks + (k,), rawd.get(k, MISSING))
            if r is not MISSING:
                out[k] = r
        return out

    def _list(self, b, l, c, toks, raw):
        if l.stale or c.stale:
            if self.mode == "lift" and self.strict:
                raise LiftError("the elements of %s cannot be matched to the projected object" % (_path(toks) or "/"))
            return self._conflict("list", toks, b, l, c, "stale key: the elements cannot be matched to the base")
        rawi = raw.items if isinstance(raw, LV) else {}
        items = {}
        for k in dict.fromkeys(l.order + c.order + b.order):
            r = self.m(b.items.get(k, MISSING), l.items.get(k, MISSING), c.items.get(k, MISSING), toks + (k,),
                       rawi.get(k, MISSING), True)
            if r is not MISSING:
                items[k] = r
        if b.kind == "bag":
            gone_l, gone_c = set(b.items) - set(l.items), set(b.items) - set(c.items)
            add_l, add_c = set(l.items) - set(b.items), set(c.items) - set(b.items)
            if gone_l & gone_c and add_l and add_c and add_l != add_c:
                return self._conflict("list", toks, b, l, c, "ambiguous pairing: both sides replaced the same element")
        return LV(b.kind, self._order(b.order, l.order, c.order, items, toks), items)

    def _order(self, b, l, c, items, toks):
        """Key order of a merged list: the side that reordered wins; with neither (or both) the local order, and the other side's
        new keys go after their predecessor there (appended, when both reordered)."""
        def moved(side):
            common = set(b) & set(side)
            return [k for k in b if k in common] != [k for k in side if k in common]
        lr, cr = moved(l), moved(c)
        primary, secondary = (c, l) if cr and not lr else (l, c)
        out = [k for k in primary if k in items]
        placed, anchor = set(out), None
        for k in secondary:
            if k in placed:
                anchor = k
            elif k in items:
                if lr and cr:
                    out.append(k)
                else:
                    out.insert(0 if anchor is None else out.index(anchor) + 1, k)
                placed.add(k)
                anchor = k
        if lr and cr:
            self.autos.append({"path": _path(toks), "kind": "order",
                               "detail": "both sides reordered; the local order is kept and the cloud-only keys are appended"})
        return out

    def _composite(self, b, l, c, toks, raw):
        """The reason a take-cloud is a composite conflict, or None (6.3, BRD2 11.1)."""
        if not self.composite:
            return None
        if raw is not MISSING and not _eq(raw, l):
            return "the desktop value has a local-only part"
        birthlike = self.ctx.birthlike
        if self.cls == "Event" and toks == ("type",) and self.handle in birthlike:
            return "type change on a birth-like event"
        if len(toks) == 3 and toks[0] == "event_ref_list" and toks[2] == "role" and toks[1].split("#")[0] in birthlike:
            return "role change on a reference to a birth-like event"
        if self.cls == "Person" and toks == ("_birth_ref",) \
                and any(x.split("#")[0] in birthlike for x in (b, l, c) if isinstance(x, str)):
            return "birth reference change on a birth-like event"
        return None

    def _conflict(self, kind, toks, b, l, c, reason):
        path = _path(toks)
        self.conflicts.append({
            "id": _conflict_id(self.cls, self.handle, path), "class": self.cls, "handle": self.handle, "kind": kind,
            "path": path, "reason": reason, "base": _plain(b), "cloud": _plain(c), "local": _plain(l),
            "base_json": _json(b), "cloud_json": _json(c), "local_json": _json(l),
            "absent": [n for n, v in (("base", b), ("cloud", c), ("local", l)) if v is MISSING],
        })
        return c if self.take_cloud else l


def _pin_map(pins):
    """``{path: base value or MISSING}`` of the pins below the object (``merge_object`` has already dealt with the object-level
    pin, the one with the path ``""``)."""
    return {p["path"]: MISSING if p.get("base_json") is None else json.loads(p["base_json"]) for p in pins}


# --------------------------------------------------------------------------------------------------------------------
# Lift.


def lift(cloud, local, local_proj=None, *, policy=None, strict=True):
    """The local-form object for the projected object ``cloud``: every local-only part of ``local`` comes back (6.5), so that
    ``P(lift(C, L)) == C`` for every C the checker accepts. ``local_proj`` is P(L) from the whole tree's projection; without it the
    object is projected alone (right for an object that needs no other object's context). ``local=None`` (the object is new here)
    gives a copy of ``cloud``. Raises ``LiftError`` when a keyed list cannot be matched to P(L); with ``strict=False`` such a list
    is taken from ``cloud`` whole (right for the push object, whose local-only parts P removes again anyway)."""
    if local is None:
        return copy.deepcopy(cloud)
    if local_proj is None:
        local_proj = PR.project_tree([local], policy=policy)[0][local["handle"]]
        if local_proj is None:
            raise ValueError("the local object is excluded from the cloud; there is nothing to lift onto")
    pv = _build(local_proj, None, None)
    lv = _build(local, None, pv)
    cv = _build(cloud, None, pv)
    out = _render(_Merge("lift", local.get("_class"), local.get("handle"), strict=strict).m(pv, lv, cv, (), MISSING))
    if "change" in local:
        out["change"] = local["change"]
    return out


# --------------------------------------------------------------------------------------------------------------------
# Results.


class MergeResult:
    """What one object's merge decided.

    action          noop, unchanged, converged, create_local, push_create, update, delete_local, delete_deferred, push_delete,
                    withdraw, drop_base, conflict, excluded
    local_obj       the local-form object to commit in Gramps (``lift(M, L)``), or None when nothing changes locally
    push            ``{"op": "create"|"update"|"delete", "class", "handle", "base_version", "obj"}``, or None when nothing is sent
    base_after      the projected object the sidecar's base row becomes (after the push is acknowledged), None when the row goes
    conflicts       the open conflicts of the object (each run lists a pinned one again)
    autos           automatic resolutions worth logging (both sides reordered a list)
    closed          paths whose pin the run found resolved
    needs_confirmation / needs_step_up / deferred   what the caller must still ask or why nothing was done
    """

    def __init__(self, cls, handle, gramps_id, action, **kw):
        self.cls, self.handle, self.gramps_id, self.action = cls, handle, gramps_id, action
        self.local_obj = kw.get("local_obj")
        self.push = kw.get("push")
        self.base_after = kw.get("base_after")
        self.conflicts = kw.get("conflicts", [])
        self.autos = kw.get("autos", [])
        self.closed = kw.get("closed", [])
        self.needs_confirmation = kw.get("needs_confirmation", False)
        self.needs_step_up = kw.get("needs_step_up", False)
        self.deferred = kw.get("deferred")

    def as_dict(self):
        return dict(self.__dict__)


def _gid(*objs):
    return next((o.get("gramps_id") for o in objs if isinstance(o, dict) and o.get("gramps_id")), None)


def diff_pointers(a, b, ptr=""):
    """RFC 6901 pointers (no values) where two plain objects differ; a list of another length differs as a whole."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out += diff_pointers(a.get(k, MISSING), b.get(k, MISSING), ptr + "/" + _esc(k))
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff_pointers(x, y, "%s/%d" % (ptr, i))
        return out
    return [] if _eq(a, b) else [ptr]


def _object_conflict(cls, handle, gid, kind, reason, base, cloud, local, **extra):
    c = {"id": _conflict_id(cls, handle, ""), "class": cls, "handle": handle, "gramps_id": gid, "kind": kind, "path": "",
         "reason": reason, "base": base, "cloud": cloud, "local": local,
         "base_json": None if base is None else _dump(base), "cloud_json": None if cloud in (None, TOMBSTONE) else _dump(cloud),
         "local_json": None if local is None else _dump(local),
         "absent": [n for n, v in (("base", base), ("cloud", cloud), ("local", local)) if v is None]}
    c.update(extra)
    return c


# --------------------------------------------------------------------------------------------------------------------
# One object: the object-level table (6.4) and the field-level rules (6.3).


def merge_object(base, local, local_proj, cloud, *, cloud_version=None, project_fn=None, pins=(), mode="cli",
                 allow_deletes=False, ctx=None):
    """Merge one object.

    base         B, the projected object at the last sync, or None
    local        L, the raw Gramps object, or None
    local_proj   P(L), or None when L is absent or the cloud must not have it
    cloud        C: the projected object, ``TOMBSTONE``, or None (the store has no head)
    cloud_version  C.version, the ``base_version`` of the push
    project_fn   ``obj -> P(obj)`` in the context of the whole local tree; ``push["obj"]`` is ``project_fn(lift(M, L))``
                 (without it, M itself, which is the same for any M the checker accepts)
    pins         the open conflicts of this object, ``{"path", "base_json"}`` (path ``""`` freezes the object)
    mode         ``cli`` (conflicts are parked, ``disposition: parked``) or ``gui`` (``open``)
    allow_deletes  the CLI applies an incoming delete only with this (``allow_deletes=1``)
    ctx          ``merge_context(...)``
    """
    src = next((o for o in (base, local, cloud) if isinstance(o, dict)), {})
    cls, handle = src.get("_class"), src.get("handle")
    gid = _gid(local, cloud, base)
    pins = list(pins)
    make = lambda action, **kw: MergeResult(cls, handle, gid, action, **kw)  # noqa: E731
    lp = local_proj

    if any(p["path"] == "" for p in pins):
        # A pin on the whole object is re-evaluated, never trusted: the object is merged again with the pin removed. While the
        # cause stands the run finds the same object-level conflict (same id, kind and reason, derived and not stored); when it is
        # gone (the cloud went back to the base, the target of a reference exists again) the pin is reported in ``closed``. An
        # integrity freeze is re-checked by ``merge_tree`` on the result, which freezes the object again if the violation stands.
        res = merge_object(base, local, local_proj, cloud, cloud_version=cloud_version, project_fn=project_fn,
                           pins=[p for p in pins if p["path"] != ""], mode=mode, allow_deletes=allow_deletes, ctx=ctx)
        if not any(c["path"] == "" for c in res.conflicts):
            res.closed = [""] + list(res.closed)
        return res

    if local is None:
        if not isinstance(cloud, dict):
            return _finish(make("drop_base" if base is not None else "noop"), mode)
        if base is None:
            return _finish(make("create_local", local_obj=lift(cloud, None), base_after=cloud), mode)
        if _eq(cloud, base):
            return _finish(make("push_delete", needs_step_up=True,
                                push={"op": "delete", "class": cls, "handle": handle, "base_version": cloud_version, "obj": None}), mode)
        return _finish(make("conflict", base_after=base, conflicts=[_object_conflict(
            cls, handle, gid, "delete_edit", "deleted on the desktop, edited on the website", base, cloud, None)]), mode)

    if lp is None:
        # The cloud must not have this object. One that was synced before is withdrawn (sync.md 5.1, BRD2 5.1b: a delete that
        # needs no step-up, because it reduces exposure); the cloud copy and the base row are reconciled, whatever the website
        # did to it since. With no cloud copy left the base row just goes.
        if base is None:
            return _finish(make("excluded"), mode)
        if isinstance(cloud, dict):
            return _finish(make("withdraw", push={"op": "withdraw", "class": cls, "handle": handle,
                                                  "base_version": cloud_version, "obj": None}), mode)
        return _finish(make("drop_base"), mode)

    if cloud is None:
        if base is None:
            return _finish(make("push_create", base_after=lp, push={
                "op": "create", "class": cls, "handle": handle, "base_version": None, "obj": lp}), mode)
        return _finish(make("conflict", base_after=base, conflicts=[_object_conflict(
            cls, handle, gid, "identity", "the cloud has no record of this object", base, None, lp)]), mode)

    if cloud == TOMBSTONE:
        if base is None:
            return _finish(make("push_create", base_after=lp, push={
                "op": "create", "class": cls, "handle": handle, "base_version": cloud_version, "obj": lp}), mode)
        desk = diff_pointers(strip_change(local), lp)                # what only the desktop has (local-only, held, private)
        edited = [] if _eq(lp, base) else diff_pointers(base, lp)    # what the desktop changed in the shared part
        if not desk and not edited:
            return _finish(_delete_local(make, mode, allow_deletes), mode)
        # Desktop-only data wins the reason even when the shared part was edited too (AC8); the preview lists both kinds.
        reason = REASON_DESKTOP_ONLY if desk else "edited on the desktop, deleted on the website"
        return _finish(make("conflict", base_after=base, conflicts=[_object_conflict(
            cls, handle, gid, "delete_edit", reason, base, TOMBSTONE, lp, lost=list(dict.fromkeys(edited + desk)),
            lost_edited=edited, lost_desktop_only=desk)]), mode)

    if base is None:
        if _eq(lp, cloud):
            return _finish(make("converged", base_after=cloud), mode)
        return _finish(make("conflict", base_after=None, conflicts=[_object_conflict(
            cls, handle, gid, "field", "the desktop and the website both have this object and there is no common base",
            None, cloud, lp, differs=diff_pointers(cloud, lp))]), mode)

    if not pins and _eq(lp, base) and _eq(cloud, base):
        return _finish(make("unchanged", base_after=cloud), mode)
    return _finish(_update(make, base, local, lp, cloud, ctx or Context(), pins, cloud_version, project_fn, cls, handle), mode)


def _delete_local(make, mode, allow_deletes):
    if mode == "cli" and not allow_deletes:
        return make("delete_deferred", deferred="the CLI applies an incoming delete only with allow_deletes")
    return make("delete_local", needs_confirmation=mode != "cli")


def _finish(result, mode):
    for c in result.conflicts:
        c["disposition"] = "parked" if mode == "cli" else "open"
    return result


def _update(make, base, local, lp, cloud, ctx, pins, cloud_version, project_fn, cls, handle):
    bv = _build(base, None, None)
    pv = _build(lp, None, bv)
    cv = _build(cloud, None, bv)
    rv = _build(local, None, pv)
    pm = _pin_map(pins)
    local_pass, push_pass = _Merge("local", cls, handle, ctx, pm), _Merge("push", cls, handle, ctx, pm)
    m_local = local_pass.m(bv, pv, cv, (), rv)
    m_push = push_pass.m(bv, pv, cv, (), rv)
    try:
        new_local = lift(_render(m_local), local, lp)
        lifted = lift(_render(m_push), local, lp, strict=False)
    except LiftError as err:
        return make("conflict", base_after=base, conflicts=[_object_conflict(
            cls, handle, _gid(local, cloud), "integrity", "cannot lift safely: %s" % err, base, cloud, lp)])
    pushed = project_fn(lifted) if project_fn else _render(m_push)
    push = None if _eq(pushed, cloud) else {"op": "update", "class": cls, "handle": handle, "base_version": cloud_version, "obj": pushed}
    changed = not _eq(strip_change(new_local), strip_change(local))
    open_paths = [c["path"] for c in local_pass.conflicts]
    closed = sorted(p for p in pm if not any(o == p or o.startswith(p + "/") for o in open_paths))
    return make("update", local_obj=new_local if changed else None, push=push, base_after=pushed if push else cloud,
                conflicts=local_pass.conflicts, autos=local_pass.autos, closed=closed)


# --------------------------------------------------------------------------------------------------------------------
# Relationship symmetry and references (6.6).

REF_LISTS = {"event_ref_list": "Event", "media_list": "Media", "child_ref_list": "Person", "person_ref_list": "Person",
             "reporef_list": "Repository", "placeref_list": "Place"}
HANDLE_LISTS = {"note_list": "Note", "citation_list": "Citation", "tag_list": "Tag", "family_list": "Family",
                "parent_family_list": "Family"}
HANDLE_FIELDS = {("Event", "place"): "Place", ("Citation", "source_handle"): "Source", ("Family", "father_handle"): "Person",
                 ("Family", "mother_handle"): "Person"}


def _dicts(node, ptr=""):
    if isinstance(node, dict):
        yield ptr, node
        for k, v in node.items():
            yield from _dicts(v, ptr + "/" + _esc(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _dicts(v, "%s/%d" % (ptr, i))


def check_integrity(objects, removed=()):
    """The violations in a local tree (``{handle: object}``): ``[{"problem", "involves": [handles], "detail", "key"}]`` (``key``
    names the violation without its position in a list, so two runs can be compared) for a missing
    or wrong-class target of a reference, a family list that does not match the family's parents, a parent-family list that does not
    match its children, and a birth or death index out of range or not an integer. ``removed`` are the handles this run deletes: a reference to one
    names it among the objects involved."""
    by = dict(objects)
    out = []

    def add(problem, involves, detail, key=None):
        out.append({"problem": problem, "involves": sorted(set(involves)), "detail": detail,
                    "key": key or "%s|%s|%s" % (problem, ",".join(sorted(set(involves))), detail)})

    def target(src, ptr, h, cls):
        found = by.get(h)
        if found is None or found.get("_class") != cls:
            # the key leaves out the position in a list, so a reference that merely moved is the same violation as before
            add("dangling_reference", [src, h] if h in removed else [src], "%s names a %s that does not exist" % (ptr, cls),
                "dangling_reference|%s|%s|%s" % (src, re.sub(r"/\d+", "/#", ptr), h))

    for h in sorted(by):
        o = by[h]
        for ptr, d in _dicts(o):
            for key, cls in HANDLE_LISTS.items():
                for i, t in enumerate(d.get(key) or ()):
                    target(h, "%s/%s/%d" % (ptr, key, i), t, cls)
            for key, cls in REF_LISTS.items():
                for i, el in enumerate(d.get(key) or ()):
                    target(h, "%s/%s/%d" % (ptr, key, i), el.get("ref"), cls)
        for (kls, key), cls in HANDLE_FIELDS.items():
            if o.get("_class") == kls and o.get(key):
                target(h, "/" + key, o[key], cls)
        if o.get("_class") == "Person":
            n = len(o.get("event_ref_list") or ())
            for key in ("birth_ref_index", "death_ref_index"):
                v = o.get(key, -1)
                if isinstance(v, bool) or not isinstance(v, int) or not -1 <= v < n:
                    add("index_out_of_range", [h], "/%s is outside the event reference list" % key)
            for fh in o.get("family_list") or ():
                f = by.get(fh)
                if f is not None and f.get("_class") == "Family" and h not in (f.get("father_handle"), f.get("mother_handle")):
                    add("asymmetric_family", [h, fh], "the person lists a family that does not list the person as a parent")
            for fh in o.get("parent_family_list") or ():
                f = by.get(fh)
                if f is not None and f.get("_class") == "Family" and h not in [c.get("ref") for c in f.get("child_ref_list") or ()]:
                    add("asymmetric_child", [h, fh], "the person lists a family that does not list the person as a child")
        if o.get("_class") == "Family":
            for key in ("father_handle", "mother_handle"):
                p = by.get(o.get(key))
                if p is not None and p.get("_class") == "Person" and h not in (p.get("family_list") or ()):
                    add("asymmetric_family", [h, o[key]], "the family names a parent whose family list does not include it")
            for el in o.get("child_ref_list") or ():
                p = by.get(el.get("ref"))
                if p is not None and p.get("_class") == "Person" and h not in (p.get("parent_family_list") or ()):
                    add("asymmetric_child", [h, el["ref"]], "the family lists a child whose parent-family list does not include it")
    return out


class TreeResult:
    """``results`` ({handle: MergeResult}), ``conflicts`` (every open conflict, with its object's class, handle and gramps_id),
    ``integrity`` (the violations that froze changed objects) and ``autos``."""

    def __init__(self, results, integrity):
        self.results, self.integrity = results, integrity
        self.conflicts = [c for h in sorted(results) for c in results[h].conflicts]
        self.autos = [a for h in sorted(results) for a in results[h].autos]

    def actions(self):
        out = {}
        for r in self.results.values():
            out[r.action] = out.get(r.action, 0) + 1
        return out


def merge_tree(base, local, local_proj, cloud, *, versions=None, pins=None, project_fn=None, mode="cli", allow_deletes=False,
               sticky=(), policy=None, cloud_is_delta=True, unreadable=()):
    """Merge a whole tree. ``base``, ``local``, ``local_proj`` and ``cloud`` map handles to objects (``cloud`` values may be
    ``TOMBSTONE``); ``versions`` maps handles to C.version; ``pins`` maps handles to their open conflicts; ``unreadable`` are the Media handles whose file could not be read. With ``cloud_is_delta``
    a handle that ``cloud`` does not list is unchanged in the cloud (C = B); without it the cloud has no such head.

    After the per-object merges the post-merge local tree is checked (6.6). A violation that is new in this run (the local tree
    before the run did not have it) and involves an object this run changes freezes that object (the run's change to it is not applied or pushed, its base row stays, and an ``integrity`` conflict
    pins it); every other object's result stands."""
    versions, pins = versions or {}, pins or {}
    ctx = merge_context(local.values(), base.values(), sticky, policy, unreadable)
    results = {}
    for h in sorted(set(base) | set(local) | set(cloud)):
        if h in cloud:
            c = cloud[h]
        else:
            c = base.get(h) if cloud_is_delta else None
        results[h] = merge_object(base.get(h), local.get(h), local_proj.get(h), c, cloud_version=versions.get(h),
                                  project_fn=project_fn, pins=pins.get(h, ()), mode=mode, allow_deletes=allow_deletes, ctx=ctx)
    integrity = []
    existing = {v["key"] for v in check_integrity(local)}       # already there before this run: not this run's doing
    while True:
        after = dict(local)
        for h, r in results.items():
            if r.action == "delete_local":
                del after[h]
            elif r.local_obj is not None:
                after[h] = r.local_obj
        deleting = {h for h, r in results.items() if r.action == "delete_local"}
        changing = {h for h, r in results.items() if r.local_obj is not None} | deleting
        found = [v for v in check_integrity(after, deleting) if changing & set(v["involves"]) and v["key"] not in existing]
        if not found:
            break
        integrity += found
        for h in sorted({h for v in found for h in v["involves"]} & changing):
            r = results[h]
            why = "; ".join(sorted({v["detail"] for v in found if h in v["involves"]}))
            results[h] = _finish(MergeResult(r.cls, h, r.gramps_id, "conflict", base_after=base.get(h), conflicts=[_object_conflict(
                r.cls, h, r.gramps_id, "integrity", why, base.get(h), cloud.get(h), local_proj.get(h),
                involves=sorted({x for v in found if h in v["involves"] for x in v["involves"]}))]), mode)
    return TreeResult(results, integrity)


# --------------------------------------------------------------------------------------------------------------------
# Deciding a conflict.

DATE_CHOICES = ("keep_mine", "take_year_keep_daymonth", "clear_daymonth")
DEFAULT_DATE_CHOICE = "take_year_keep_daymonth"


def date_choices():
    """The three offers for a composite date conflict, in the order the GUI shows them (13.1, BRD2 11.1)."""
    return [
        {"id": "keep_mine", "label": "Keep mine", "default": False, "needs_confirmation": False},
        {"id": "take_year_keep_daymonth", "label": "Take the website year and keep my day and month", "default": True,
         "needs_confirmation": False},
        {"id": "clear_daymonth", "label": "Take the website value and clear my day and month", "default": False,
         "needs_confirmation": True},
    ]


def _same_shape(cloud_date, local_date, pol):
    """Whether the local day and month can be laid over the website's date: both are structured dates of the same modifier (single,
    range, span, ...) and the same length, so each half has its own counterpart."""
    cd, ld = cloud_date.get("dateval"), local_date.get("dateval")
    return (isinstance(cd, list) and isinstance(ld, list) and len(cd) == len(ld)
            and cloud_date.get("modifier") == local_date.get("modifier") != pol["dates"]["textOnlyModifier"])


def resolve_date(cloud_date, local_date, choice=DEFAULT_DATE_CHOICE, confirmed=False, policy=None):
    """The outcome of a composite date conflict: ``{"local": the Date to store in Gramps, "cloud": the Date the cloud holds
    afterwards}``. ``cloud_date`` is the website's Date (projected form), ``local_date`` the raw local one. The default keeps the
    local day and month under the website's year, and the website's text; clearing them needs ``confirmed=True``.

    The default needs the two dates to have the same shape (same modifier, same number of values; a text-only local date has no
    day or month to keep). When they do not, the day and month cannot be laid over the website's date, so the outcome is
    ``keep_mine`` (nothing of the desktop is lost, the website's edit is not taken) and the result says so with
    ``"fallback": "keep_mine"``; the GUI shows that and offers the other choice."""
    pol = policy or R.load_policy()
    if choice == "keep_mine":
        return {"local": copy.deepcopy(local_date), "cloud": R.reduce_date(local_date, pol)}
    if choice == "clear_daymonth":
        if not confirmed:
            raise ValueError("clearing the local day and month needs an extra confirmation")
        return {"local": copy.deepcopy(cloud_date), "cloud": copy.deepcopy(cloud_date)}
    if choice != "take_year_keep_daymonth":
        raise ValueError("unknown choice %r" % (choice,))
    if not _same_shape(cloud_date, local_date, pol):
        return dict(resolve_date(cloud_date, local_date, "keep_mine", policy=pol), fallback="keep_mine")
    out = copy.deepcopy(cloud_date)
    lv = local_date["dateval"]
    dv = list(out["dateval"])
    for i in pol["dates"]["dayMonthIndexes"]:
        if i < len(dv):
            dv[i] = lv[i]
    out["dateval"] = dv
    year = dv[2] if len(dv) > 2 else 0
    out["sortval"] = (R.sdn(out.get("calendar", 0), year, dv[1] or 1, dv[0] or 1) or 0) \
        if year and out.get("calendar", 0) in pol["dates"]["sortvalCalendars"] else 0
    return {"local": out, "cloud": copy.deepcopy(cloud_date)}


def _tokens(path):
    return [t.replace("~1", "/").replace("~0", "~") for t in path.split("/")[1:]]


def local_value(conflict, local, local_proj, base):
    """The raw desktop value at a conflict's path, for ``resolve_conflict(..., local_raw=...)``: what is in ``local`` where the
    conflict's ``local`` (projected) value is, with the desktop-only parts. ``base`` is the object's base row, the one the
    conflict was found against (it keys the keyed lists). ``None`` when the desktop has nothing at the path. A conflict holds
    projected values only because it is mirrored to the cloud; the raw value never goes into one."""
    if not conflict["path"]:
        return strip_change(local)
    bv = _build(base, None, None)
    node = _build(local, None, _build(local_proj, None, bv))
    for tok in _tokens(conflict["path"]):
        node = node.items.get(tok, MISSING) if isinstance(node, LV) else node.get(tok, MISSING) if isinstance(node, dict) else MISSING
        if node is MISSING:
            return None
    return _plain(node)


def set_local_value(conflict, local, local_proj, base, value):
    """A copy of the raw desktop object ``local`` with ``value`` (a plain, projected-form value; ``MISSING`` removes it) put at the
    conflict's path. ``local_proj`` and ``base`` are the same inputs ``local_value`` takes, because the path's keyed-list tokens
    (``<ref>#<n>``) mean something only against the view the conflict was found in. Used to carry out a person's decision on a
    conflict in the same run: ``resolve_conflict`` / ``resolve_date`` say what the desktop value becomes, this puts it there.
    Raises ``ValueError`` for a path that does not exist in the desktop object (nothing is guessed) and for the object-level path."""
    if not conflict["path"]:
        raise ValueError("an object-level conflict has no path to set")
    toks = _tokens(conflict["path"])
    bv = _build(base, None, None)
    root = _build(local, None, _build(local_proj, None, bv))
    node = root
    for tok in toks[:-1]:
        node = node.items.get(tok, MISSING) if isinstance(node, LV) else node.get(tok, MISSING) if isinstance(node, dict) else MISSING
        if node is MISSING:
            raise ValueError("the path is not in the desktop object")
    last = toks[-1]
    if isinstance(node, LV):
        if value is MISSING:
            if last in node.items:
                del node.items[last]
                node.order = [k for k in node.order if k != last]
        else:
            node.items[last] = _build(value, None, node.items.get(last))
            if last not in node.order:
                node.order.append(last)
    elif isinstance(node, dict):
        if value is MISSING:
            node.pop(last, None)
        else:
            node[last] = _build(value, last, node.get(last))
    else:
        raise ValueError("the path is not in the desktop object")
    out = _render(root)
    if "change" in local:
        out["change"] = local["change"]
    return out


def resolve_conflict(conflict, choice, local_raw=MISSING):
    """``{"local": value, "cloud": value}`` for a non-date conflict: ``keep_mine`` keeps the desktop value and pushes its
    projection, ``take_website`` takes the cloud value, ``skip`` leaves the conflict open (``None``).

    A conflict lists the projected desktop value (``conflict["local"]``), which is what the cloud may see. Keeping mine must keep
    the raw value, or it would overwrite the desktop-only refinement a composite conflict exists to protect (a street-level
    event place, a held field, a private list element), so ``keep_mine`` needs ``local_raw``, from ``local_value(...)``, and
    refuses without it."""
    if choice == "keep_mine":
        if local_raw is MISSING:
            raise ValueError("keep_mine needs the raw desktop value (local_value) so desktop-only parts are not overwritten")
        return {"local": local_raw, "cloud": conflict["local"]}
    if choice == "take_website":
        return {"local": conflict["cloud"], "cloud": conflict["cloud"]}
    if choice == "skip":
        return None
    raise ValueError("unknown choice %r" % (choice,))
