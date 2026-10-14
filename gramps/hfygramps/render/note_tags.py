from __future__ import annotations

from html import escape
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse
import re

from .labels import (
    TAG_BOLD,
    TAG_FONTCOLOR,
    TAG_FONTFACE,
    TAG_FONTSIZE,
    TAG_HIGHLIGHT,
    TAG_ITALIC,
    TAG_LINK,
    TAG_NAME_TO_CODE,
    TAG_STRIKETHROUGH,
    TAG_SUBSCRIPT,
    TAG_SUPERSCRIPT,
    TAG_UNDERLINE,
)

# Ported from the live ETL (HFY-TSK-114; D-02, PS-24): note text and tags come from Gramps 6 (`text.string` / `text.tags`) with a
# fallback to the older `_string` / `_tags` shape. Everything member-editable is untrusted: text is HTML
# escaped, tag ranges render as well-formed (never overlapping) markup, colours must be hex, and a LINK
# tag only becomes an anchor for a plain http(s) URL. Anything else is dropped and the text stays.

HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

SIZE_BUCKETS: List[Tuple[float, str]] = [
    (16, "note-size-sm"),
    (22, "note-size-md"),
    (10**6, "note-size-lg"),
]

_BREAK_CHARS = "\n\r"


def _size_class(value: float) -> str:
    for upper_bound, class_name in SIZE_BUCKETS:
        if value <= upper_bound:
            return class_name
    return "note-size-lg"


def _sanitize_color(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if HEX_COLOR_RE.fullmatch(candidate):
        return candidate.lower()
    return None


def _safe_href(value: Any, gate: Optional[Callable[[str], bool]] = None) -> Optional[str]:
    """A plain http(s) URL with a host, no userinfo, no whitespace or control characters, and (when a text ``gate`` is
    given) nothing the gate blocks, else None. A link is free text too: ``?email=a@b.example`` or a phone number in the
    query would otherwise bypass the gate that reads the note string."""

    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate or "\\" in candidate:
        return None
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in candidate):
        return None
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None
    if "@" in parsed.netloc:  # userinfo (``user:pass@host``)
        return None
    if gate is not None and not gate(candidate):
        return None
    return candidate


def _numeric(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _tag_code(tag: Dict[str, Any]) -> Optional[int]:
    """Resolve the StyledTextTagType code from either note shape, inferring only from the value."""

    name = tag.get("name")
    if isinstance(name, dict):
        for key in ("value", "code"):
            code = name.get(key)
            if isinstance(code, int) and not isinstance(code, bool):
                return code
        for key in ("string", "_string"):
            label = name.get(key)
            if isinstance(label, str) and label.strip().lower() in TAG_NAME_TO_CODE:
                return TAG_NAME_TO_CODE[label.strip().lower()]
    elif isinstance(name, str) and name.strip().lower() in TAG_NAME_TO_CODE:
        return TAG_NAME_TO_CODE[name.strip().lower()]
    elif isinstance(name, int) and not isinstance(name, bool):
        return name

    value = tag.get("value")
    if _sanitize_color(value):
        return TAG_FONTCOLOR
    if _numeric(value) is not None:
        return TAG_FONTSIZE
    return None


def _classify_tag(tag: Dict[str, Any], gate: Optional[Callable[[str], bool]] = None) -> Optional[Tuple[str, str]]:
    code = _tag_code(tag)
    value = tag.get("value")
    if code == TAG_BOLD:
        return "<strong>", "</strong>"
    if code == TAG_ITALIC:
        return "<em>", "</em>"
    if code == TAG_UNDERLINE:
        return "<u>", "</u>"
    if code == TAG_STRIKETHROUGH:
        return "<s>", "</s>"
    if code == TAG_SUPERSCRIPT:
        return "<sup>", "</sup>"
    if code == TAG_SUBSCRIPT:
        return "<sub>", "</sub>"
    if code == TAG_FONTSIZE:
        numeric = _numeric(value)
        if numeric is not None:
            return f'<span class="{_size_class(numeric)}">', "</span>"
        return None
    if code == TAG_FONTCOLOR:
        sanitized = _sanitize_color(value)
        if sanitized:
            return f'<span class="note-color" style="color: {sanitized};">', "</span>"
        return None
    if code == TAG_HIGHLIGHT:
        sanitized = _sanitize_color(value)
        if sanitized:
            return (
                f'<span class="note-highlight" style="background-color: {sanitized};">',
                "</span>",
            )
        return None
    if code == TAG_LINK:
        href = _safe_href(value, gate)
        if href:
            return (
                f'<a href="{escape(href, quote=True)}" rel="noopener noreferrer nofollow" target="_blank">',
                "</a>",
            )
        return None
    if code == TAG_FONTFACE:
        return None
    return None


def _clean_ranges(raw_ranges: Any, text_length: int) -> List[Tuple[int, int]]:
    cleaned: List[Tuple[int, int]] = []
    if not isinstance(raw_ranges, (list, tuple)):
        return cleaned
    for raw_range in raw_ranges:
        if not isinstance(raw_range, (list, tuple)) or len(raw_range) < 2:
            continue
        try:
            start = int(raw_range[0])
            end = int(raw_range[1])
        except (TypeError, ValueError):
            continue
        start = max(0, min(text_length, start))
        end = max(0, min(text_length, end))
        if start < end:
            cleaned.append((start, end))
    return cleaned


def _apply_tag_markup(
    raw_text: str, tags: Iterable[Dict[str, Any]], gate: Optional[Callable[[str], bool]] = None
) -> str:
    """Escape `raw_text` and wrap tagged spans. Overlapping ranges are split at every boundary,
    so each segment opens and closes exactly the tags that cover it (always well formed)."""

    if not raw_text:
        return ""

    text_length = len(raw_text)
    spans: List[Tuple[int, int, int, Tuple[str, str]]] = []
    for idx, tag in enumerate(tags or []):
        if not isinstance(tag, dict):
            continue
        markup = _classify_tag(tag, gate)
        if not markup:
            continue
        for start, end in _clean_ranges(tag.get("ranges"), text_length):
            spans.append((idx, start, end, markup))

    boundaries = {0, text_length}
    for _, start, end, _markup in spans:
        boundaries.add(start)
        boundaries.add(end)
    for position, char in enumerate(raw_text):
        if char in _BREAK_CHARS:
            boundaries.add(position)
            boundaries.add(position + 1)
    ordered = sorted(boundaries)

    # Group consecutive non-break segments that share the same active tag set. A break piece is
    # `(None, text)`: "\r\n" collapses to "\n" and a lone "\r" is a line break.
    pieces: List[Tuple[Optional[Tuple[int, ...]], str]] = []
    for seg_start, seg_end in zip(ordered, ordered[1:]):
        chunk = raw_text[seg_start:seg_end]
        if not chunk:
            continue
        if chunk in _BREAK_CHARS and len(chunk) == 1:
            if chunk == "\r":
                following = raw_text[seg_end:seg_end + 1]
                pieces.append((None, "" if following == "\n" else "\n"))
            else:
                pieces.append((None, "\n"))
            continue
        active = tuple(sorted(idx for idx, s, e, _m in spans if s <= seg_start and seg_end <= e))
        if pieces and active and pieces[-1][0] == active:
            pieces[-1] = (active, pieces[-1][1] + chunk)
            continue
        pieces.append((active, chunk))

    markup_for = {idx: markup for idx, _s, _e, markup in spans}
    output: List[str] = []
    for active, chunk in pieces:
        if active is None:
            output.append(chunk)
            continue
        escaped = escape(chunk)
        if not active:
            output.append(escaped)
            continue
        output.append("".join(markup_for[idx][0] for idx in active))
        output.append(escaped)
        output.append("".join(markup_for[idx][1] for idx in reversed(active)))
    return "".join(output)


def _wrap_paragraphs(markup: str) -> str:
    if not markup:
        return ""
    blocks = [segment.strip() for segment in markup.split("\n\n") if segment.strip()]
    if not blocks:
        return ""
    wrapped = []
    for block in blocks:
        wrapped.append(f"<p>{block.replace(chr(10), '<br />')}</p>")
    return "".join(wrapped)


def note_text_parts(raw: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
    """`(string, tags)` from `text.string`/`text.tags`, falling back to `_string`/`_tags`."""

    text_obj = raw.get("text") or {}
    if not isinstance(text_obj, dict):
        return "", []
    string = text_obj.get("string")
    if not isinstance(string, str):
        string = text_obj.get("_string")
    if not isinstance(string, str):
        string = ""
    tags = text_obj.get("tags")
    if not isinstance(tags, list):
        tags = text_obj.get("_tags")
    if not isinstance(tags, list):
        tags = []
    return string, tags


def normalise_note_text(raw: Dict[str, Any], gate: Optional[Callable[[str], bool]] = None) -> Dict[str, str]:
    string, tags = note_text_parts(raw)
    markup = _apply_tag_markup(string, tags, gate)
    html = _wrap_paragraphs(markup)
    raw_text = string.replace("\r\n", "\n").replace("\r", "\n").strip()
    return {"raw": raw_text, "html": html}
