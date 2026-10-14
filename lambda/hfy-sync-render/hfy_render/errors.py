"""Failure vocabulary. Nothing in this package ever carries an exception message out of a pass (PS-20, BRD2 R-19).

``SYNC#RENDER.last_error``, the log lines, the metrics and the exception that leaves the handler hold an exception class
name and a rule id from this file, never a message: a message may quote a store value (a date, a phone number, a note).
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

# Rule ids (stable strings; docs/reference/sync-render.md lists them).
RULE_KEY_UNOWNED = "key.unowned"
RULE_NOT_JSON = "output.not_json"
RULE_SORT_VALUE = "privacy.sort_value"
RULE_SOURCE_PATH = "privacy.source_path"
RULE_DATE_TEXT = "privacy.date_text"
RULE_DETECTOR_PREFIX = "privacy.detector."
RULE_TEXT_PREFIX = "privacy.text."
RULE_MASS_DELETE = "guard.mass_delete"
RULE_WITHDRAW_BLOCKED = "guard.withdraw_blocked"
RULE_SESSION_OPENED_AT = "session.opened_at_invalid"
RULE_IDENTIFIER_SHAPE = "privacy.identifier_shape"
RULE_CHECKSUM = "write.checksum_mismatch"
RULE_TIMEOUT = "timeout.budget"
RULE_STATE_CONFLICT = "state.conflict"
RULE_SNAPSHOT_GAP = "view.log_gap"
RULE_BAD_MODE = "config.bad_mode"
RULE_PROTECTED_KEY = "key.protected"

_SAFE = re.compile(r"[^A-Za-z0-9_.:-]")


class RenderFailed(Exception):
    """A pass failed. ``str()`` is the rule id, a constant from this module; the cause's message is never kept."""

    def __init__(self, rule: str, cause_class: Optional[str] = None) -> None:
        super().__init__(rule)
        self.rule = rule
        self.cause_class = cause_class


class ProtectedKey(RenderFailed):
    """An attempt to write or delete a key the renderer does not own (person/index.html, person/graph.json, binaries, faces, SVGs)."""

    def __init__(self) -> None:
        super().__init__(RULE_PROTECTED_KEY)


def describe(exc: BaseException) -> Tuple[str, Optional[str]]:
    """``(exception class name, rule id or None)``: the only two facts about a failure that may be stored or logged."""

    if isinstance(exc, RenderFailed):
        return (_SAFE.sub("_", exc.cause_class or type(exc).__name__)[:64], exc.rule)
    return (_SAFE.sub("_", type(exc).__name__)[:64], None)


def last_error_text(exc: BaseException) -> str:
    cls, rule = describe(exc)
    return f"{cls}:{rule}" if rule else cls
