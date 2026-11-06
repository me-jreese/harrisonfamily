"""MediaRef rectangles, read the way Gramps reads them (ruling P4-R16, spec DOC-E61934196E75 section 2).

A rectangle is ``[x1, y1, x2, y2]``, integer percent of the picture. For READ and COMPARE the readers (the renderer, the redaction
rules and the projection) use one predicate, the same one as ``api/src/rect.js`` ``normalizeRect`` and ``shared/redaction-rules.mjs``
``rectProblem``: a region is "no region" (null) ONLY for the full frame ``(0, 0, 100, 100)`` and for a point (``x1 == x2`` and
``y1 == y2``, which includes Gramps' own ``[0, 0, 0, 0]``). A box with one zero-extent axis is kept as typed, and reversed corners are
kept as stored: the readers never repair a rectangle Gramps holds. The authoring guard (reject zero-area, inverted, smaller than 2x2)
belongs to the web editor and the API, not to these readers.

Standard library only: this module ships in the render Lambda's zip and in the Gramps addon.
"""

from typing import Any, List, Optional, Sequence

FULL_FRAME = (0, 0, 100, 100)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_full_frame(rect: Sequence[Any]) -> bool:
    """True for four numbers equal to ``(0, 0, 100, 100)`` (``100.0`` counts, as in ``rules.rect_problem``)."""
    return len(rect) == 4 and all(a == b for a, b in zip(rect, FULL_FRAME))


def is_point(rect: Sequence[Any]) -> bool:
    """True when ``x1 == x2`` and ``y1 == y2``: nothing is marked."""
    return len(rect) == 4 and rect[0] == rect[2] and rect[1] == rect[3]


def is_no_region(rect: Sequence[Any]) -> bool:
    """True for the two shapes that mean "tagged without an area marked": the full frame and a point."""
    return is_full_frame(rect) or is_point(rect)


def normalize_rect(raw: Any) -> Optional[List[int]]:
    """A stored MediaRef rect as the readers use it: a copy of four integers, or ``None`` for "no region".

    ``None`` for a missing (``None``) or empty rect, for the full frame and for a point. A malformed value (not four integers) is also
    ``None`` here; callers that must tell the two apart ask ``render.transform.rect_is_malformed``. Every other rectangle, a box with
    one zero-extent axis and reversed corners included, is returned exactly as stored.
    """
    if not isinstance(raw, (list, tuple)) or len(raw) != 4 or not all(_is_int(v) for v in raw):
        return None
    if is_no_region(raw):
        return None
    return [int(v) for v in raw]
