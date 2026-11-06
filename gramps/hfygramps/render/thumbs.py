"""Derived media thumbnails as the renderer publishes them (HFY-TSK-393, D-38, ruling P4-R17).

``hfy-graph-render`` (sharp, the renderer that already decodes originals) derives two JPEG thumbnails per published image, writes them
under ``media/thumb/`` and records what it made in one sidecar, ``media/thumb/index.json``:

    {"version": 2, "thumbs": {"<media handle>": {"checksum": "<sha256 of the original>", "w": <int>, "h": <int>}}}

``w`` and ``h`` are the pixel size of the original after its EXIF orientation is applied (the thumbnails keep that aspect ratio and are
never larger than the original). ``hfy-sync-render`` owns ``media/index.json`` and ``media/<handle>.json``, reads the sidecar each pass
and adds ``thumb`` to a media entry only when the sidecar was built from the entry's current checksum. The thumbnail keys are computed
here from the handle and the checksum, never read from the sidecar, so a sidecar cannot point an entry at another key. The same scheme is
in ``graph/cloud/thumbs.mjs``; ``test_render_thumbs.py`` and ``graph/test/cloud-thumbs.test.mjs`` pin both to the same keys.

The JPEG file names are ``<handle>-<10 letters>-s<size>.jpg`` with the handle and the hash written as letters only: the handle's UTF-8
bytes and the first 10 hex digits of the original's checksum, each hex digit written as a letter (0 -> a ... f -> p), so a replaced original
is a new URL (Cloudflare caches static files for hours under the URL first fetched). HFY-TSK-402: the first scheme,
``<handle>-<sha8>-<size>.jpg``, put digit runs beside dashes, and the privacy gate read some of them (the handle's own digits included) as a
phone number and withheld ``media/index.json``. The only digits left in a key are the 320 or 800 after an ``s``, so no handle or checksum
can make one. A version 1 sidecar (first scheme) reads as empty here, so no entry points at a key that ``hfy-graph-render`` has not written
yet. Standard library only.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Mapping, Optional

THUMB_PREFIX = "media/thumb/"
SIDECAR_KEY = "media/thumb/index.json"
SIZES = (320, 800)
SIDECAR_VERSION = 2
_DIGEST_LETTERS = 10

_HANDLE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_SIDE = 100_000


def _hex_letters(hex_digits: str) -> str:
    return "".join(chr(97 + int(c, 16)) for c in hex_digits)


def handle_letters(handle: str) -> str:
    """The handle as letters only (injective): its UTF-8 bytes in hex, each hex digit written as a letter (0 -> a ... f -> p)."""

    return _hex_letters(handle.encode("utf-8").hex())


def digest_letters(checksum: str) -> str:
    """The first 10 hex digits of a checksum written as letters (0 -> a ... f -> p): a hash segment with no digit in it."""

    return _hex_letters(checksum[:_DIGEST_LETTERS])


def thumb_key(handle: str, checksum: str, size: int) -> str:
    """``media/thumb/<handle as letters>-<10 letters>-s<size>.jpg``: the handle's UTF-8 bytes and the first 10 hex digits of the checksum,
    each hex digit written as a letter a-p."""

    return f"{THUMB_PREFIX}{handle_letters(handle)}-{digest_letters(checksum)}-s{size}.jpg"


def _dimension(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= _MAX_SIDE


def parse_sidecar(raw: Optional[bytes]) -> Dict[str, Dict[str, Any]]:
    """``{handle: {"checksum", "w", "h"}}`` from the sidecar bytes. Anything that is not a well-formed sidecar reads as empty
    (the entries then carry no ``thumb`` until ``hfy-graph-render`` writes a good sidecar)."""

    if not raw:
        return {}
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(doc, dict) or doc.get("version") != SIDECAR_VERSION or not isinstance(doc.get("thumbs"), dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for handle, rec in doc["thumbs"].items():
        if (
            isinstance(handle, str) and _HANDLE.match(handle) and isinstance(rec, dict)
            and isinstance(rec.get("checksum"), str) and _SHA256.match(rec["checksum"])
            and _dimension(rec.get("w")) and _dimension(rec.get("h"))
        ):
            out[handle] = {"checksum": rec["checksum"], "w": rec["w"], "h": rec["h"]}
    return out


def thumb_field(handle: Any, checksum: Any, record: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """The ``thumb`` object of a media entry, or None (no sidecar record, or one made from another checksum, or a missing original)."""

    if not isinstance(handle, str) or not _HANDLE.match(handle) or not isinstance(checksum, str) or not _SHA256.match(checksum):
        return None
    if not record or record.get("checksum") != checksum:
        return None
    return {
        "s320": thumb_key(handle, checksum, 320),
        "s800": thumb_key(handle, checksum, 800),
        "w": record["w"],
        "h": record["h"],
    }
