"""Complete an object with the keys of a blank object of its class, without ever turning a missing key into a cleared one (HFY-TSK-409).

Gramps reads every key of the object it loads: `Event.set_object_state` pops `description`, `attribute_list` and the rest, and an
object that lacks one raises KeyError. Every other class takes `__dict__.update(state)`, so a missing key keeps the constructor's
blank value and the commit then writes that blank over what the tree held. The website stores what its editor sent, and the editor
creates an Event with six keys (the website now stores new objects complete, `api/src/records/ops.js` `completeCreate`, but the
objects stored before that, and any future sparse source, are still read). The rule here is one sentence:

    A missing key is "no information", never "empty". It takes the value the tree already holds; only when the tree holds
    nothing for it (the object is new to the tree) does it take the blank value of its class.

``complete(state, blank_for, existing=None)`` returns a copy of `state`:

  * a key that is present keeps its value, whatever it is (``None``, ``0``, ``''`` and ``[]`` included): nothing is ever replaced;
  * a key that is missing takes, in this order, the value of the same key of ``existing`` (the object as the tree holds it now:
    only for an object that is already there, and only for the object itself and the plain objects nested in it, never for a Date,
    a StyledText or a type, which are values and are replaced whole; an element of a list of references takes the values of the
    tree's element with the same `ref`, any other list element has no identity and takes the blank), and
    else the value of the blank object of its class (``blank_for(class name)``);
  * it descends into every nested dict that names a class (a ``PlaceName``, an ``EventRef``, the elements of a list), so the
    nested objects a sparse source cut down are filled too and keep the values they had;
  * a dict whose ``_class`` is a type table (``EventType``...) only gets an empty ``string``: its ``value`` is never invented;
  * ``change`` is Gramps' own derived stamp (canonical.DERIVED_KEYS) and is never added;
  * ``NEVER_INVENT`` keys are never added, because the blank value would be a guess that reads as data (a blank Gramps Event is a
    Birth): the object is then left as it is, Gramps refuses it with a KeyError, the one transaction rolls back and nothing changes.

``blank_for`` is ``table_blank`` (``blanks.py``, written by ``gramps/scripts/gen-blanks.py``) in CI and the merge; the Gramps side
passes a function that asks Gramps for ``object_to_dict(Class())``, and the lane test proves the table and Gramps agree.

Standard library only.
"""

import copy

from .blanks import BLANKS
from .canonical import DERIVED_KEYS

#: (class, key) pairs whose blank value is a guess, never filled in.
NEVER_INVENT = frozenset({("Event", "type")})


def table_blank(name):
    """The blank object of class `name` from the committed table, or None."""
    return BLANKS.get(name)


def is_value_class(name):
    """True for the classes that are values, replaced whole when they change: Date, StyledText and every type table."""
    return isinstance(name, str) and (name in ("Date", "StyledText") or name.endswith("Type"))


def blank_value(name, key, blank_for=table_blank):
    """``(True, blank value)`` when class `name` has a blank for `key` that may be filled in, else ``(False, None)``."""
    if (name, key) in NEVER_INVENT or key in DERIVED_KEYS:
        return False, None
    blank = blank_for(name)
    if isinstance(blank, dict):
        return (True, copy.deepcopy(blank[key])) if key in blank else (False, None)
    if isinstance(name, str) and name.endswith("Type") and key == "string":
        return True, ""
    return False, None


def is_class_key(name, key, blank_for=table_blank):
    """True when `key` is one of the keys Gramps serialises for class `name`: its absence can only mean a sparse source, never a removal."""
    blank = blank_for(name)
    if isinstance(blank, dict):
        return key in blank
    return isinstance(name, str) and name.endswith("Type") and key == "string"


def blank_keys(name, blank_for=table_blank):
    """The keys class `name` may be completed with."""
    blank = blank_for(name)
    keys = [k for k in blank if blank_value(name, k, blank_for)[0]] if isinstance(blank, dict) else []
    if not keys and isinstance(name, str) and name.endswith("Type"):
        keys = ["string"]
    return keys


def complete(obj, blank_for=table_blank, existing=None):
    """A copy of `obj` with every missing key filled in, from `existing` first and from the blank object of its class second (see above)."""
    return _complete(obj, blank_for, existing)


#: The lists whose elements are identified by their `ref` (merge.KEYED): an element of the state is matched to the element of the tree
#: with the same `ref` (the n-th of equal refs), so a sparse element of an existing reference also takes the tree's values.
KEYED_LISTS = frozenset({"event_ref_list", "media_list", "person_ref_list", "reporef_list", "placeref_list", "child_ref_list"})


def _existing_element(existing_list, ref, nth):
    seen = 0
    for e in existing_list:
        if isinstance(e, dict) and e.get("ref") == ref:
            if seen == nth:
                return e
            seen += 1
    return None


def _complete_list(items, blank_for, existing_list):
    out, seen = [], {}
    for v in items:
        ex = None
        if isinstance(existing_list, list) and isinstance(v, dict) and isinstance(v.get("ref"), str):
            nth = seen.get(v["ref"], 0)
            seen[v["ref"]] = nth + 1
            ex = _existing_element(existing_list, v["ref"], nth)
        out.append(_complete(v, blank_for, ex))
    return out


def _complete(node, blank_for, existing, key=None):
    if isinstance(node, list):
        return _complete_list(node, blank_for, existing) if key in KEYED_LISTS else [_complete(v, blank_for, None) for v in node]
    if not isinstance(node, dict):
        return copy.deepcopy(node)
    name = node.get("_class")
    ex = existing if isinstance(existing, dict) and not is_value_class(name) and existing.get("_class") == name else None
    out = {k: _complete(v, blank_for, ex.get(k) if ex is not None else None, k) for k, v in node.items()}
    if ex is not None:
        for key, value in ex.items():
            if key not in out and key not in DERIVED_KEYS:
                out[key] = copy.deepcopy(value)
    if isinstance(name, str):
        for key in blank_keys(name, blank_for):
            if key not in out:
                out[key] = blank_value(name, key, blank_for)[1]
    return out


def carry(previous, incoming):
    """A copy of `incoming` (the website's object) with the keys it lacks taken from `previous` (the object the base row held before).

    The base row follows the website, and the website's object can be sparse; a key the website leaves out is "no information", so the
    agreed state keeps what the base row already held for it instead of forgetting it (otherwise the next push would read a desktop
    value the website never removed as a desktop addition). Only keys of the previous row are carried, nothing is invented; the row's
    hash stays the website's. Value classes (Date, StyledText, types) are replaced whole, and lists are taken as they are."""
    if not isinstance(incoming, dict) or not isinstance(previous, dict):
        return copy.deepcopy(incoming)
    keep = not is_value_class(incoming.get("_class")) and previous.get("_class") == incoming.get("_class")
    out = {k: carry(previous.get(k), v) if isinstance(v, dict) else copy.deepcopy(v) for k, v in incoming.items()}
    if keep:
        for key, value in previous.items():
            if key not in out and key not in DERIVED_KEYS:
                out[key] = copy.deepcopy(value)
    return out
