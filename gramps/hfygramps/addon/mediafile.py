"""What the addon learns from the bytes of a Media file (sync.md 5.5, 9; BRD2 D2-06; HFY-TSK-207).

Pure standard library; Python 3.9 compatible. No Gramps, no network, no sidecar. Three callers use it:

    the push        ``collect`` gives the projection ``{media handle: {"exif_gps", "md5", "readable"}}`` (the keys it reads) plus what the
                    upload needs (``sha256``, ``size``, ``content_type``, ``state``, ``path``), so the Media checksum the website gets is the
                    MD5 of the bytes on disk (a stale Gramps checksum never travels) and a file that cannot go is held, not sent.
    the download    ``exif_gps`` and ``hold_for_bytes`` run on the verified bytes of a cloud blob before anything is written (the desktop
                    re-checks GPS on download: BRD2 D2-06), so a location-bearing photo is held and never lands in the media folder.
    the tests       the helpers are pure so they run without Gramps.

A file is one of these ``state`` values; only ``ok`` can be uploaded:

    ok            readable, 1 byte to 25 MB, an accepted type, no EXIF GPS
    missing       nothing at the path (a moved or deleted file, or an empty path)
    unreadable    the path exists and cannot be read
    empty         0 bytes
    placeholder   a Dropbox online-only file: the ``com.dropbox.placeholder`` extended attribute, or the macOS dataless flag
    too_large     over 25 MB (the website's limit); only the MD5 is computed
    unsupported   a type the website does not accept (HEIC, WebP, video): sync.md 9
    gps           EXIF GPS (or XMP GPS) in a JPEG, PNG or TIFF: held, "remove the location info, then sync"

``exif_gps`` fails closed: EXIF that is present but cannot be read counts as a position, like the website's own check
(``api/src/upload-guard.js``, ``tiffHasGpsPosition``), which this ports.
"""
import hashlib
import os
import struct
import sys
import zlib

MAX_BYTES = 25 * 1024 * 1024  # MAX_MEDIA_BYTES of api/src/sync/media.js
CHUNK = 1024 * 1024
EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/tiff": ".tif", "application/pdf": ".pdf"}
GPS_MIME = ("image/jpeg", "image/png", "image/tiff")  # redaction-v1 media.exifGpsMime
PLACEHOLDER_XATTR = "com.dropbox.placeholder"
SF_DATALESS = 0x40000000  # st_flags of a macOS dataless (online-only) file: reading it would make the file provider download it

STATES = ("ok", "missing", "unreadable", "empty", "placeholder", "too_large", "unsupported", "gps")

# What the user is told, per state (no path, no content). Keys are hold rules; the rest of the addon puts them in the sidecar holds table.
HOLD_RULES = {
    "missing": "media_blob_missing",
    "unreadable": "media_blob_unreadable",
    "empty": "media_blob_empty",
    "placeholder": "media_blob_placeholder",
    "too_large": "media_blob_too_large",
    "unsupported": "media_blob_unsupported",
}
GPS_RULE = "media.exif_gps.hold"  # the projection's own rule id for the same thing


# ------------------------------------------------------------------------------------------------------------------ types


def sniff(head):
    """The content type of the file's first bytes, or None for a type the website does not accept."""
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if head[:4] in (b"GIF8",) or head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    if head[:5] == b"%PDF-":
        return "application/pdf"
    return None


# --------------------------------------------------------------------------------------------------------------------- GPS

_GPS_POINTER = 0x8825
_GPS_POSITION_TAGS = (0x0002, 0x0004, 0x0014, 0x0016)  # GPSLatitude, GPSLongitude, GPSDestLatitude, GPSDestLongitude
_XMP_MARKERS = (b"GPSLatitude", b"GPSLongitude", b"GPSDestLatitude", b"GPSDestLongitude")


def tiff_has_gps(b, start=0, end=None):
    """True when the TIFF structure at ``b[start:end]`` has a GPS IFD with a position. Every read is bounds-checked. Not a TIFF: False.
    A GPS pointer whose IFD cannot be read, or a position tag of an odd type, counts as a position (fail closed)."""
    end = len(b) if end is None else min(end, len(b))
    if start + 8 > end:
        return False
    if b[start:start + 2] == b"II":
        fmt = "<"
    elif b[start:start + 2] == b"MM":
        fmt = ">"
    else:
        return False
    size = end - start

    def u16(o):
        if o is None or o < 0 or o + 2 > size:
            return None
        return struct.unpack_from(fmt + "H", b, start + o)[0]

    def u32(o):
        if o is None or o < 0 or o + 4 > size:
            return None
        return struct.unpack_from(fmt + "I", b, start + o)[0]

    if u16(2) != 42:
        return False

    def entries(ifd):
        n = u16(ifd)
        if n is None or n > 1000 or ifd + 2 + n * 12 > size:
            return None
        out = []
        for i in range(n):
            at = ifd + 2 + i * 12
            out.append((u16(at), u16(at + 2), u32(at + 4), u32(at + 8)))
        return out

    def position_present(entry):
        _tag, kind, count, value = entry
        if kind not in (5, 10) or not count:
            return True  # a position tag of an unexpected type
        for k in range(min(count, 4)):
            num, den = u32(value + k * 8) if value is not None else None, u32(value + k * 8 + 4) if value is not None else None
            if num is None or den is None:
                return True  # points outside what was read
            if num != 0 and den != 0:
                return True
        return False

    seen = set()
    ifd = u32(4)
    hops = 0
    while ifd and hops < 4 and ifd not in seen:
        seen.add(ifd)
        listing = entries(ifd)
        if listing is None:
            return False
        for entry in listing:
            if entry[0] == _GPS_POINTER:
                gps = entries(entry[3])
                if gps is None:
                    return True  # a GPS IFD that cannot be read
                if any(e[0] in _GPS_POSITION_TAGS and position_present(e) for e in gps):
                    return True
        ifd = u32(ifd + 2 + len(listing) * 12)
        hops += 1
    return False


def _exif_has_gps(b, start, end):
    """An EXIF payload: with or without the ``Exif\\0\\0`` prefix."""
    if b[start:start + 6] == b"Exif\x00\x00":
        start += 6
    return tiff_has_gps(b, start, end)


def _xmp_has_gps(text):
    return any(m in text for m in _XMP_MARKERS)


def _jpeg_has_gps(b):
    """Walks the JPEG segments to the start of the scan. A segment structure that loses sync ends the walk (the generic scan in
    ``exif_gps`` still looks for an EXIF header anywhere), like the website's ``jpegFinds``."""
    pos = 2
    n = len(b)
    while pos + 4 <= n:
        if b[pos] != 0xFF:
            return False
        marker = b[pos + 1]
        if marker == 0xFF:
            pos += 1  # fill byte
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        if marker in (0xD9, 0xDA):
            return False  # end of image, start of scan: the metadata is behind us
        length = struct.unpack_from(">H", b, pos + 2)[0]
        seg_start, seg_end = pos + 4, min(n, pos + 2 + length)
        if marker == 0xE1:
            if b[seg_start:seg_start + 6] == b"Exif\x00\x00" and _exif_has_gps(b, seg_start, seg_end):
                return True
            if b[seg_start:seg_start + 4] == b"http" and _xmp_has_gps(b[seg_start:seg_end]):
                return True
        if length < 2:
            return False
        pos += 2 + length
    return False


MAX_EXIF_HEADERS = 16


def _generic_has_gps(b):
    """The scans that do not depend on the container: an ``Exif\\0\\0`` TIFF header anywhere (up to 16 of them), and plain-text XMP GPS properties."""
    start = 0
    for _ in range(MAX_EXIF_HEADERS):
        at = b.find(b"Exif\x00\x00", start)
        if at < 0:
            break
        if tiff_has_gps(b, at + 6):
            return True
        start = at + 6
    return _xmp_has_gps(b)


def _png_has_gps(b):
    pos = 8
    n = len(b)
    while pos + 8 <= n:
        length, kind = struct.unpack_from(">I4s", b, pos)
        body_start, body_end = pos + 8, pos + 8 + length
        if body_end + 4 > n:
            return kind == b"eXIf"  # a truncated chunk: only an EXIF chunk that cannot be read matters
        body = b[body_start:body_end]
        if kind == b"eXIf" and _exif_has_gps(body, 0, len(body)):
            return True
        if kind in (b"iTXt", b"tEXt") and _xmp_has_gps(body):
            return True
        if kind == b"zTXt":
            try:
                if _xmp_has_gps(zlib.decompress(body.split(b"\x00", 1)[1][1:], 15, 1024 * 1024)):
                    return True
            except (zlib.error, IndexError):
                pass
        if kind == b"IEND":
            break
        pos = body_end + 4
    return False


def exif_gps(data, content_type=None):
    """True when the bytes of a JPEG, PNG or TIFF carry a GPS position in EXIF (or XMP). ``content_type`` defaults to the sniffed type;
    other types are not read (a PDF or GIF has no EXIF)."""
    ct = content_type or sniff(data[:16])
    try:
        if ct == "image/jpeg":
            return _jpeg_has_gps(data) or _generic_has_gps(data)
        if ct == "image/png":
            return _png_has_gps(data) or _generic_has_gps(data)
        if ct == "image/tiff":
            return tiff_has_gps(data) or _xmp_has_gps(data)
    except (struct.error, IndexError, ValueError):
        return True  # an image whose metadata cannot be walked is not known to be free of a position
    return False


def hold_for_bytes(data):
    """The hold rule for the bytes of a downloaded blob (nothing is written when it is not None): empty, or a position in the EXIF."""
    if not data:
        return HOLD_RULES["empty"]
    if exif_gps(data):
        return GPS_RULE
    return None


# --------------------------------------------------------------------------------------------------------- placeholders


def _listxattr_darwin(path):
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.dylib", use_errno=True)
    size = libc.listxattr(os.fsencode(path), None, 0, 1)  # XATTR_NOFOLLOW
    if size <= 0:
        return []
    buf = ctypes.create_string_buffer(size)
    got = libc.listxattr(os.fsencode(path), buf, size, 1)
    return [n.decode("utf-8", "replace") for n in buf.raw[:max(got, 0)].split(b"\x00") if n]


def xattr_names(path):
    """The extended attribute names of ``path`` ([] when there are none or they cannot be read). Tests replace this."""
    try:
        if hasattr(os, "listxattr"):
            return list(os.listxattr(path, follow_symlinks=False))
        if sys.platform == "darwin":
            return _listxattr_darwin(path)
    except (OSError, AttributeError, ValueError, TypeError):
        pass
    return []


def placeholder_reason(path, st=None):
    """``"placeholder"`` for a Dropbox online-only file (the xattr, or the macOS dataless flag), else None. Never reads the content."""
    try:
        st = st or os.stat(path)
    except OSError:
        return None
    if getattr(st, "st_flags", 0) & SF_DATALESS:
        return "placeholder"
    if PLACEHOLDER_XATTR in xattr_names(path):
        return "placeholder"
    return None


# ------------------------------------------------------------------------------------------------------------- files


def resolve(path, base):
    """The absolute path a Media ``path`` names: the path itself when absolute, else under Gramps' base media path ``base`` (Gramps'
    own rule, gramps.gen.utils.file.media_path_full). ``~`` is expanded. An empty path is ''."""
    if not isinstance(path, str) or not path:
        return ""
    path = os.path.expanduser(path)
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(os.path.expanduser(base or ""), path))


def inspect(path):
    """What the file at ``path`` is. Returns {state, path, size, readable, md5, sha256, content_type, exif_gps}; the hashes are '' unless
    they could be computed. Reads the whole file only when it is an uploadable size; never raises."""
    info = {"state": "missing", "path": path, "size": 0, "readable": False, "md5": "", "sha256": "", "content_type": "", "exif_gps": False}
    if not path:
        return info
    try:
        st = os.stat(path)
    except OSError:
        return info
    if not os.path.isfile(path):
        return info
    info["size"] = st.st_size
    reason = placeholder_reason(path, st)
    if reason:
        info["state"] = reason  # before the size: a Dropbox placeholder can report a size and no content
        return info
    if st.st_size == 0:
        info["state"] = "empty"
        return info
    try:
        if st.st_size > MAX_BYTES:
            md5 = hashlib.md5()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(CHUNK), b""):
                    md5.update(chunk)
            info.update(state="too_large", readable=True, md5=md5.hexdigest())
            return info
        with open(path, "rb") as fh:
            data = fh.read(MAX_BYTES + 1)
    except OSError:
        info["state"] = "unreadable"
        return info
    if not data:
        info["state"] = "empty"  # it shrank between the stat and the read
        return info
    info.update(readable=True, size=len(data), md5=hashlib.md5(data).hexdigest(), sha256=hashlib.sha256(data).hexdigest())
    ct = sniff(data[:16])
    info["content_type"] = ct or ""
    info["exif_gps"] = exif_gps(data, ct)
    info["state"] = "gps" if info["exif_gps"] else ("ok" if ct else "unsupported")
    return info


def collect(media_objects, base):
    """``{media handle: inspect(...)}`` for raw Gramps Media objects (``_class`` Media, ``path``), paths resolved against ``base``.
    The projection reads ``exif_gps``, ``md5`` and ``readable``; the push reads the rest."""
    out = {}
    for obj in media_objects:
        handle = obj.get("handle")
        if isinstance(handle, str) and handle:
            out[handle] = inspect(resolve(obj.get("path"), base))
    return out
