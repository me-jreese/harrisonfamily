"""Canonical JSON and object hashes (HFY-PLN-002 sync.md 4.1, task projection-py).

The cloud store keeps each redacted Gramps object as ``obj_json``, a canonical JSON string, and its ``hash``, the sha256 hex of
that string's UTF-8 bytes. ``shared/canonical.mjs`` is the JavaScript original of the same function; both pass the vectors in
``shared/canonical.vectors.json`` byte for byte (gramps/tests/unit/test_canonical.py runs them, and runs the JavaScript module
too when ``node`` is installed).

The format: keys sorted by code point, no whitespace, non-ASCII characters written as they are (UTF-8), the escapes of
``json.dumps`` (``\\"``, ``\\\\``, ``\\b``, ``\\f``, ``\\n``, ``\\r``, ``\\t`` and lower-case ``\\u00xx`` for the other control
characters). Only values both languages agree on are accepted, and anything else raises ``CanonicalError`` rather than writing
bytes the other side would write differently:

* integers only, within +/-(2**53 - 1) (JavaScript numbers); no float, NaN or infinity (Gramps latitude and longitude are
  strings);
* object keys are strings; values are ``None``, bool, int, str, list/tuple and dict;
* a string with a lone surrogate (it has no UTF-8 form) is refused.

Standard library only; Python 3.10 and later.
"""

import hashlib
import json

MAX_SAFE_INTEGER = 2 ** 53 - 1

#: Top-level keys that are never part of a stored object: ``change`` is Gramps' own last-changed stamp (derived, sync.md 6.1).
DERIVED_KEYS = ("change",)


class CanonicalError(ValueError):
    """The value has no canonical form (a float, a lone surrogate, a non-string key, an unsupported type)."""


def _check(value, depth=0):
    if depth > 200:
        raise CanonicalError("nesting too deep")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError("integer outside the JavaScript safe range")
        return
    if isinstance(value, float):
        raise CanonicalError("floats have no canonical form; integers only")
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise CanonicalError("string with a lone surrogate") from None
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _check(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalError("object keys must be strings")
            _check(key, depth + 1)
            _check(item, depth + 1)
        return
    raise CanonicalError("unsupported type %s" % type(value).__name__)


def canonical_json(value):
    """The canonical JSON text of ``value`` (``str``)."""
    _check(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_bytes(value):
    """The canonical JSON as UTF-8 bytes: what is hashed and what is stored."""
    return canonical_json(value).encode("utf-8")


def sha256_hex(value):
    """sha256 hex of the canonical bytes of ``value``."""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def stored_form(obj):
    """``obj`` as the cloud stores it: a shallow copy without the derived top-level keys (``change``)."""
    return {k: v for k, v in obj.items() if k not in DERIVED_KEYS}


def object_json(obj):
    """``obj_json`` of a projected Gramps object (no ``change`` key)."""
    return canonical_json(stored_form(obj))


def object_hash(obj):
    """``hash`` of a projected Gramps object: sha256 hex of ``object_json``."""
    return hashlib.sha256(object_json(obj).encode("utf-8")).hexdigest()
