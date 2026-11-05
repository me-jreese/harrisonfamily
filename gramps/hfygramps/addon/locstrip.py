"""Remove the GPS location from a JPEG or PNG without touching the picture (HFY-TSK-374). Pure standard library; Python 3.9 compatible.

The Gramps tree and the file on this Mac are never changed: ``strip`` takes the bytes of a file and returns the bytes of a COPY, and the
caller uploads the copy. The copy differs from the original only inside the metadata that carries a position:

    JPEG   the compressed image data, every segment other than the APP1 ``Exif`` and APP1 XMP ones, and the file's length are byte for
           byte the original's. In the Exif TIFF the GPS pointer (tag 0x8825) is taken out of its IFD (the IFD's entries move up, its
           count drops by one, its next-IFD offset moves with it, the freed 12 bytes are zero), and the GPS IFD with every value it
           points to is overwritten with zero bytes, so no coordinate is left in the file as an unreferenced leftover. Nothing else in
           the TIFF moves, so every other tag keeps its offset and its value, and the segment keeps its length. A thumbnail JPEG
           inside the TIFF (IFD1) is cleaned the same way. In the XMP packet every position property (a local name that starts with ``gps`` or
           has a latitude, longitude, geo, coordinate, position or altitude word in it, any prefix: ``exif:GPSLatitude``,
           ``drone-dji:LRFTargetLat``, ``vnd:Latitude``) is replaced by spaces, so the packet keeps its length and stays well-formed.
    PNG    the same two changes inside the ``eXIf`` chunk and the ``XML:com.adobe.xmp`` iTXt chunk; the chunk CRC is computed again, and
           a compressed XMP text is deflated again (that chunk's length may change). Every other chunk, ``IDAT`` included, is copied.
    TIFF   is not rewritten: the strip returns the reason ``tiff`` and the file stays held.

Fail closed: ``strip`` never raises. A file is only taken when its whole structure is one this module can follow and name:

    Work    one ``Budget`` per file bounds the IFD entries, TIFF headers, inflated bytes, XMP bytes and segments over all the checks together;
           past it ``ScanLimit`` is raised and the photo is held as "too much to check" (``limit``). An IFD whose declared entry count is larger
           than the data raises ``Unreadable`` unless a position is found among the entries that fit (``unreadable``).
    JPEG   every marker segment from SOI to EOI is walked (the entropy-coded scans are skipped, a progressive file's later scans and the
           segments between them included); only the markers a JPEG uses, and only these application segments, are accepted: JFIF/JFXX
           (APP0), Exif and standard XMP (APP1), ICC_PROFILE and MPF (APP2), Ducky (APP12), Photoshop 3.0 (APP13), Adobe (APP14) and
           comments. Any other APPn, any other APP1 (``Exif`` followed by anything but two NULs included), ANY extended-XMP segment, and
           any byte after EOI but NULs (a second picture, a motion-photo video) hold the photo.
    PNG    only the standard chunks are accepted (see ``_PNG_KINDS``): an unknown ancillary chunk (``zxIf``...), a ``Raw profile type``
           text chunk and any byte after IEND hold the photo.
    Other  an IFD that loops or points outside the data, an unknown value type, a GPS IFD it cannot read, XMP it cannot blank (UTF-16, a
           DOCTYPE, more than ``_MAX_PROPERTIES`` GPS properties, a property whose end is not within ``_WINDOW`` bytes), and inflated
           text above ``_MAX_INFLATED`` hold the photo.

``has_location_residue`` is the check the copy must pass (it is also run by the caller next to the add-on's detector): over every
metadata byte of the copy (every JPEG segment, every PNG chunk but the picture data, inflated where compressed) it looks for ANY TIFF
signature (``II*\\0`` / ``MM\\0*``) and walks it for a GPS pointer, for the letters ``gps`` (also as UTF-16, NULs removed), for the
long GPS property names, for a ``©xyz`` location atom, and it repeats the structural rules above. ``has_location_signal`` is the
looser, positive detector the add-on also uses to decide that a photo HAS a location (it finds what ``mediafile.exif_gps`` alone does
not: GPS in the Exif sub-IFD, in deflated XMP, in a hex raw profile, behind an ``Exif\\0\\xff`` header, in UTF-16 XMP, DJI names).

Only GPS fields go. A caption, a title or a place NAME in XMP or IPTC (``photoshop:City``, a "Location" text) is not a position and
stays. Nothing here logs, prints or returns a value of the file: the reasons are code words.
"""
import re
import struct
import threading
import zlib

JPEG = "image/jpeg"
PNG = "image/png"
TIFF = "image/tiff"

# Reasons (code words). ``None`` never appears: a successful strip returns an empty reason.
TIFF_KEPT = "tiff"
UNSUPPORTED = "unsupported"
UNPARSEABLE = "unparseable"
VERIFY_FAILED = "verify_failed"
LIMIT = "limit"

_GPS_POINTER = 0x8825
_EXIF_POINTER = 0x8769
_INTEROP_POINTER = 0xA005
_SUB_IFDS = 0x014A
_THUMB_OFFSET, _THUMB_LENGTH = 0x0201, 0x0202
_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}
_LONGS = (4, 13)
_POSITION_TAGS = (0x0002, 0x0004, 0x0014, 0x0016)  # GPSLatitude, GPSLongitude, GPSDestLatitude, GPSDestLongitude
_MAX_IFDS = 32
_MAX_ENTRIES = 512
_BUDGET_ENTRIES = 20000      # IFD entries examined in one file, all structures together (a camera file has a few hundred)
_BUDGET_SIGNATURES = 256     # TIFF signatures walked in one file
_BUDGET_INFLATED = 16 * 1024 * 1024   # bytes inflated in one file, all chunks together
_BUDGET_XMP = 2 * 1024 * 1024         # XMP bytes blanked or checked in one file
_BUDGET_PARTS = 20000        # segments and chunks of one file
_MAX_DEPTH = 2          # a thumbnail JPEG inside the Exif, and no deeper
_MAX_INFLATED = 8 * 1024 * 1024
_MAX_PROPERTIES = 128   # location properties in one XMP packet; a camera writes a few dozen at most
_WINDOW = 2048          # how far past a property's name its start tag, value or closing tag is looked for
_MAX_SIGNATURES = 64    # TIFF signatures walked in one part of a file
_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_XMP_EXT_NS = b"http://ns.adobe.com/xmp/extension/\x00"
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_XMP_KEYWORD = b"XML:com.adobe.xmp"

_NAME_CHARS = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-:")
_WHITE = b" \t\r\n"
_GPS_WORD = re.compile(rb"gps", re.IGNORECASE)
_TIFF_SIG = re.compile(rb"II\*\x00|MM\x00\*")
_NEXT_MARKER = re.compile(rb"\xff+[\x01-\xcf\xd8-\xfe]")  # the first marker after entropy-coded data (not a stuffed 0xFF00, not RSTn)
# Long names a chance match inside compressed picture data cannot produce (2**-70 per position or less).
_LONG_TOKENS = re.compile(rb"GPSLatitude|GPSLongitude|GPSInfo|GPSAltitude|GPSDest|GPSVersionID|exif:GPS|GpsLat|GpsLong", re.IGNORECASE)
# Two decimal numbers of the shape of a latitude and a longitude, or a degrees-minutes text, in free text (a comment, a description).
_COORD_TEXT = re.compile(rb"[-+]?\d{1,3}\.\d{3,}\s*[,;/ ]\s*[-+]?\d{1,3}\.\d{3,}|\d{1,3}\s*(?:\xc2\xb0|\xb0|deg)\s*\d{1,2}\s*(?:'|\xe2\x80\xb2)", re.IGNORECASE)
_POSITION_NAMES = re.compile(rb"gpslatitude|gpslongitude|gpsdestlatitude|gpsdestlongitude|gpslongtitude|latitude|longitude", re.IGNORECASE)

# JPEG markers that carry a length and are not application segments: SOF0-15 but DHT/JPG/DAC, DHT, DAC, DQT, DNL, DRI, DHP, EXP, SOS, COM.
_STRUCTURAL = frozenset([0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF,
                         0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF])
_PNG_KINDS = frozenset([b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA", b"iCCP", b"sBIT", b"sRGB", b"cICP", b"mDCV", b"cLLI",
                        b"bKGD", b"hIST", b"pHYs", b"sPLT", b"tIME", b"acTL", b"fcTL", b"fdAT", b"eXIf", b"tEXt", b"zTXt", b"iTXt"])
_PNG_PICTURE = frozenset([b"IDAT", b"fdAT", b"PLTE", b"hIST", b"tRNS"])
_SUSPECT_KEYWORDS = (b"exif", b"gps", b"raw profile", b"app1", b"iptc", b"location", b"geo")


class TooBig(Exception):
    """Inflated data above the limit."""


class ScanLimit(Exception):
    """A file needs more work than the budget allows (too many IFD entries, TIFF signatures, segments, inflated or blanked bytes)."""


class Unreadable(Exception):
    """A metadata structure that cannot be read with certainty and could hide a position (an IFD whose declared entry count is larger than the
    data, say): the photo is held, but nothing says it HAS a position."""


class Budget:
    """The work one file may cost, over every check together: past a limit the check raises ``ScanLimit`` and the photo is held."""

    def __init__(self):
        self.entries, self.signatures, self.inflated, self.xmp, self.parts = (_BUDGET_ENTRIES, _BUDGET_SIGNATURES, _BUDGET_INFLATED,
                                                                              _BUDGET_XMP, _BUDGET_PARTS)

    def take(self, name, n=1):
        left = getattr(self, name) - n
        if left < 0:
            raise ScanLimit()
        setattr(self, name, left)


_LOCAL = threading.local()


class scope:
    """``with locstrip.scope():`` gives everything inside one budget (a scope inside another shares the outer one)."""

    def __enter__(self):
        self.own = getattr(_LOCAL, "budget", None) is None
        if self.own:
            _LOCAL.budget = Budget()
        return _LOCAL.budget

    def __exit__(self, *exc):
        if self.own:
            _LOCAL.budget = None
        return False


def budget():
    """The budget in force (a fresh one when a function is called outside any ``scope``)."""
    current = getattr(_LOCAL, "budget", None)
    return current if current is not None else Budget()


class _Refuse(Exception):
    def __init__(self, reason=UNPARSEABLE):
        Exception.__init__(self, reason)
        self.reason = reason


def inflate_bounded(blob, limit=_MAX_INFLATED):
    """The zlib stream ``blob`` inflated, never holding more than ``limit`` + 1 bytes. ``TooBig`` above the limit, ``zlib.error`` for a
    corrupt or cut stream."""
    d = zlib.decompressobj()
    out = d.decompress(bytes(blob), limit + 1)
    if len(out) > limit:
        raise TooBig()
    if not d.eof or d.unused_data:
        raise zlib.error("incomplete stream, or more data after it")  # a second stream after the first would be read by no one but hide text
    return out


def _inflate(blob):
    try:
        out = inflate_bounded(blob)
    except TooBig:
        raise ScanLimit()
    except zlib.error:
        raise _Refuse()
    budget().take("inflated", len(out))
    return out


_TOKEN_WORDS = (b"gpslat", b"gpslong", b"gpsinfo", b"gpsaltitude", b"gpsdest", b"gpsversionid", b"exif:gps")
_POSITION_WORDS = (b"latitude", b"longitude", b"gpslongtitude")


def _names_in(buf, words):
    """True when any of the (lower case) ``words`` is in ``buf``, in any case; with the NUL bytes taken out as well (UTF-16)."""
    low = bytes(buf).lower()
    if any(w in low for w in words):
        return True
    if b"\x00" in low:
        low = low.replace(b"\x00", b"")
        return any(w in low for w in words)
    return False


def _squash(text):
    """Lower case with NUL bytes taken out, so a UTF-16 text reads as the letters it spells."""
    return bytes(text).replace(b"\x00", b"").lower()


# ------------------------------------------------------------------------------------------------------------------- TIFF


class _Tiff:
    """A TIFF structure at ``buf[start:end]``; every read is bounds-checked and raises ``_Refuse``."""

    def __init__(self, buf, start, end):
        if start < 0 or end > len(buf) or end - start < 8:
            raise _Refuse()
        order = bytes(buf[start:start + 2])
        if order == b"II":
            self.e = "<"
        elif order == b"MM":
            self.e = ">"
        else:
            raise _Refuse()
        self.buf, self.start, self.size = buf, start, end - start
        if self.u16(2) != 42:
            raise _Refuse()

    def u16(self, o):
        if o < 0 or o + 2 > self.size:
            raise _Refuse()
        return struct.unpack_from(self.e + "H", self.buf, self.start + o)[0]

    def u32(self, o):
        if o < 0 or o + 4 > self.size:
            raise _Refuse()
        return struct.unpack_from(self.e + "I", self.buf, self.start + o)[0]

    def ifd(self, off):
        """([(tag, type, count, offset of the 4-byte value field)], next IFD offset) of the IFD at ``off``."""
        n = self.u16(off)
        if n > _MAX_ENTRIES or off + 2 + n * 12 + 4 > self.size:
            raise _Refuse()
        budget().take("entries", n)
        entries = []
        for i in range(n):
            at = off + 2 + i * 12
            entries.append((self.u16(at), self.u16(at + 2), self.u32(at + 4), at + 8))
        return entries, self.u32(off + 2 + n * 12)

    def region(self, entry):
        """(offset, length) of the bytes an entry's value occupies: its own 4-byte field, or the data it points to."""
        _tag, typ, count, field = entry
        if typ not in _TYPE_SIZE or count > (1 << 24):
            raise _Refuse()
        size = _TYPE_SIZE[typ] * count
        if size <= 4:
            return field, size
        off = self.u32(field)
        if off < 8 or off + size > self.size:
            raise _Refuse()
        return off, size

    def value_bytes(self, entry):
        off, size = self.region(entry)
        return bytes(self.buf[self.start + off:self.start + off + size])

    def walk(self):
        """{ifd offset: (entries, next offset)} of every IFD reachable from IFD0: the chain, the Exif, Interoperability and SubIFD
        pointers. An IFD reached twice, too many IFDs, or one that cannot be read refuses."""
        ifds = {}
        queue = [self.u32(4)]
        while queue:
            off = queue.pop()
            if off == 0:
                continue
            if off in ifds or len(ifds) >= _MAX_IFDS or off < 8:
                raise _Refuse()
            entries, nxt = self.ifd(off)
            ifds[off] = (entries, nxt)
            if nxt:
                queue.append(nxt)
            for entry in entries:
                tag, typ, count, field = entry
                if tag in (_EXIF_POINTER, _INTEROP_POINTER):
                    if typ not in _LONGS or count != 1:
                        raise _Refuse()
                    queue.append(self.u32(field))
                elif tag == _SUB_IFDS:
                    if typ not in _LONGS or count > 16:
                        raise _Refuse()
                    base, _size = self.region(entry)
                    queue.extend(self.u32(base + 4 * k) for k in range(count))
        return ifds

    def signature(self, ifds):
        """{ifd offset: [(tag, type, count, value bytes)]}: what the differential check compares."""
        return {off: [(e[0], e[1], e[2], self.value_bytes(e)) for e in entries] for off, (entries, _nxt) in sorted(ifds.items())}


def _strip_tiff(buf, start, end, depth, edits):
    """Takes the GPS IFD out of the TIFF at ``buf[start:end]``, in place and without changing its length. Cleans a thumbnail JPEG too."""
    t = _Tiff(buf, start, end)
    ifds = t.walk()
    before = t.signature(ifds)

    removals, gps_ifds = {}, set()
    for off, (entries, _nxt) in ifds.items():
        for i, entry in enumerate(entries):
            if entry[0] == _GPS_POINTER:
                if entry[1] not in _LONGS or entry[2] != 1:
                    raise _Refuse()
                gps_ifds.add(t.u32(entry[3]))
                removals.setdefault(off, set()).add(i)

    zero = []
    blocks = [(off, off + 2 + len(entries) * 12 + 4) for off, (entries, _nxt) in ifds.items()]
    for g in sorted(gps_ifds):
        if g in ifds:
            raise _Refuse()
        entries, nxt = t.ifd(g)
        if nxt:
            raise _Refuse()
        zero.append((g, 2 + len(entries) * 12 + 4))
        for entry in entries:
            off, size = t.region(entry)
            if size > 4:
                zero.append((off, size))
    for off, size in zero:
        if any(off < b_end and b_start < off + size for b_start, b_end in blocks):
            raise _Refuse()  # a value of the GPS IFD sits inside another IFD: not a layout this understands

    thumbs = []
    for off, (entries, _nxt) in ifds.items():
        by_tag = {e[0]: e for e in entries}
        if _THUMB_OFFSET in by_tag and _THUMB_LENGTH in by_tag:
            o, n = t.u32(by_tag[_THUMB_OFFSET][3]), t.u32(by_tag[_THUMB_LENGTH][3])
            if n >= 4 and 8 <= o and o + n <= t.size and bytes(buf[start + o:start + o + 2]) == b"\xff\xd8":
                thumbs.append((start + o, start + o + n))

    for lo, hi in thumbs:
        if depth + 1 > _MAX_DEPTH:
            raise _Refuse()
        _strip_jpeg(buf, lo, hi, depth + 1, [])

    if not removals and not gps_ifds:
        return bool(thumbs)
    for off, size in zero:
        buf[start + off:start + off + size] = bytes(size)
    for off, idx in removals.items():
        entries, nxt = ifds[off]
        keep = [bytes(buf[start + off + 2 + i * 12:start + off + 2 + (i + 1) * 12]) for i in range(len(entries)) if i not in idx]
        old_end = off + 2 + len(entries) * 12 + 4
        block = struct.pack(t.e + "H", len(keep)) + b"".join(keep) + struct.pack(t.e + "I", nxt)
        block += bytes(old_end - off - len(block))
        if len(block) != old_end - off:
            raise _Refuse()
        buf[start + off:start + old_end] = block

    after_tiff = _Tiff(buf, start, end)
    after = after_tiff.signature(after_tiff.walk())
    expected = {off: [row for i, row in enumerate(rows) if i not in removals.get(off, ())] for off, rows in before.items()}
    if after != expected:
        raise _Refuse(VERIFY_FAILED)  # something other than the GPS entries changed
    return True


# ------------------------------------------------------------------------------------------------------------------- XMP


def _element_end(work, name_end, name):
    """The index just past the element whose start tag has its name ending at ``name_end``: its own end for ``<x/>``, else its closing tag."""
    i, quote, limit = name_end, 0, min(len(work), name_end + _WINDOW)
    while i < limit:
        c = work[i]
        if quote:
            if c == quote:
                quote = 0
        elif c in (0x22, 0x27):
            quote = c
        elif c == 0x3E:
            break
        elif c == 0x3C:
            raise _Refuse()
        i += 1
    else:
        raise _Refuse()
    if work[i - 1] == 0x2F:
        return i + 1
    close = b"</" + name
    j = work.find(close, i + 1, min(len(work), i + 1 + _WINDOW))
    if j < 0:
        raise _Refuse()
    k = j + len(close)
    while k < len(work) and work[k] in _WHITE:
        k += 1
    if k >= len(work) or work[k] != 0x3E:
        raise _Refuse()
    return k + 1


def _attribute_end(work, name_end):
    """The index just past ``="value"`` that follows an attribute name ending at ``name_end``."""
    i = name_end
    while i < len(work) and work[i] in _WHITE:
        i += 1
    if i >= len(work) or work[i] != 0x3D:
        raise _Refuse()
    i += 1
    while i < len(work) and work[i] in _WHITE:
        i += 1
    if i >= len(work) or work[i] not in (0x22, 0x27):
        raise _Refuse()
    j = work.find(bytes([work[i]]), i + 1, min(len(work), i + 1 + _WINDOW))
    if j < 0:
        raise _Refuse()
    return j + 1


# A name that is a position: a local name that starts with "gps", or that has a latitude, longitude, geo, coordinate, position or altitude
# word in it (split at capital letters: LRFTargetLat, vnd:Latitude, GeoTag), so a vendor's property carries no position into a copy either.
_CAMEL = re.compile(rb"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
_LOCATION_WORDS = frozenset([b"lat", b"latitude", b"lon", b"long", b"longitude", b"lng", b"geo", b"geotag", b"geolocation", b"geocode",
                             b"coord", b"coords", b"coordinate", b"coordinates", b"position", b"altitude", b"gps"])
# an attribute (name before = and a quote) or an element (name after <)
_XML_NAME = re.compile(rb"(?:(?<=[\s\"'])((?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*)(?=\s*=\s*[\"'])|<((?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*))")


def _location_name(qualified):
    local = qualified.rsplit(b":", 1)[-1]
    return local.lower().startswith(b"gps") or any(w.lower() in _LOCATION_WORDS for w in _CAMEL.findall(local))


def _blank_xmp(buf, lo, hi):
    """Replaces every position property of the XMP text in ``buf[lo:hi]`` with spaces of the same length (the packet stays well-formed): a
    property named gps*, or with a latitude, longitude, geo, coordinate, position or altitude word in its name. The work is bounded: the packet
    and all XMP of the file together are limited, at most ``_MAX_PROPERTIES`` properties, each looked for within ``_WINDOW`` bytes; past that
    it refuses. What it refuses: a DOCTYPE or entity, UTF-16 text with a GPS word, a coordinate-shaped text left after the blanking."""
    work = bytearray(buf[lo:hi])
    budget().take("xmp", len(work))
    if re.search(rb"<!(DOCTYPE|ENTITY)", work, re.IGNORECASE):
        raise _Refuse()  # XMP has no DTD; an entity can hide a value from the property that uses it
    pos, count = 0, 0
    while True:
        m = _XML_NAME.search(work, pos)
        if m is None:
            break
        attribute = m.group(1) is not None
        name = bytes(m.group(1) if attribute else m.group(2))
        if not _location_name(name):
            pos = m.end()
            continue
        count += 1
        if count > _MAX_PROPERTIES:
            raise _Refuse()
        start = m.start() if attribute else m.start()
        end = _attribute_end(work, m.end()) if attribute else _element_end(work, m.end(), name)
        work[start:end] = b" " * (end - start)
        pos = end
    if b"gps" in _squash(work):
        raise _Refuse()  # a GPS word this did not blank (a closing tag on its own, UTF-16, a comment)
    if any(_location_name(m.group(1) or m.group(2)) for m in _XML_NAME.finditer(work)):
        raise _Refuse()  # a position property left behind (a nested one)
    if _coordinate_text(work):
        raise _Refuse()  # a latitude/longitude pair or degrees-minutes text in what is left: it could be the value of a position
    buf[lo:hi] = work


# ------------------------------------------------------------------------------------------------------------------- JPEG


def _app_kind(marker, buf, p, e):
    """What a JPEG segment is: ``exif``, ``xmp``, ``xmpext``, ``icc`` or ``ok`` (a segment this accepts), None for one it cannot classify."""
    if marker == 0xFE:
        return "ok"
    if marker in _STRUCTURAL:
        return "ok"
    head = bytes(buf[p:min(e, p + 40)])
    if marker == 0xE0 and head[:5] in (b"JFIF\x00", b"JFXX\x00"):
        return "ok"
    if marker == 0xE1:
        if head[:6] == b"Exif\x00\x00":
            return "exif"
        if head.startswith(_XMP_NS):
            return "xmp"
        if head.startswith(_XMP_EXT_NS):
            return "xmpext"
        return None
    if marker == 0xE2:
        if head[:12] == b"ICC_PROFILE\x00":
            return "icc"
        if head[:4] == b"MPF\x00":
            return "ok"
        return None
    if marker == 0xEC and head[:5] == b"Ducky":
        return "ok"
    if marker == 0xED and head[:14] == b"Photoshop 3.0\x00":
        return "ok"
    if marker == 0xEE and head[:5] == b"Adobe":
        return "ok"
    return None


def _jpeg_layout(buf, lo, hi):
    """([(marker, payload start, segment end)], index after EOI) of the JPEG at ``buf[lo:hi]``, every segment from SOI to EOI, the later
    scans of a progressive file included. Anything it cannot follow raises ``_Refuse``; so do bytes after EOI other than NULs."""
    if hi - lo < 4 or bytes(buf[lo:lo + 2]) != b"\xff\xd8":
        raise _Refuse()
    pos, segs = lo + 2, []
    while True:
        if pos + 2 > hi or buf[pos] != 0xFF:
            raise _Refuse()
        marker = buf[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker == 0xD9:
            end = pos + 2
            if bytes(buf[end:hi]).strip(b"\x00"):
                raise _Refuse()
            return segs, end
        if marker != 0xDA and marker not in _STRUCTURAL and not 0xE0 <= marker <= 0xEF and marker != 0xFE:
            raise _Refuse()
        if pos + 4 > hi:
            raise _Refuse()
        length = struct.unpack_from(">H", buf, pos + 2)[0]
        e = pos + 2 + length
        if length < 2 or e > hi:
            raise _Refuse()
        segs.append((marker, pos + 4, e))
        budget().take("parts")
        pos = e
        if marker == 0xDA:
            nxt = _NEXT_MARKER.search(buf, pos, hi)
            if nxt is None:
                raise _Refuse()
            pos = nxt.start()


def _strip_jpeg(buf, lo, hi, depth, edits):
    """Cleans the APP1 Exif and XMP segments of the JPEG at ``buf[lo:hi]`` in place; refuses what it cannot classify."""
    segs, _end = _jpeg_layout(buf, lo, hi)
    xmp_seen = 0
    for marker, p, e in segs:
        kind = _app_kind(marker, buf, p, e)
        if kind is None or kind == "xmpext":
            raise _Refuse()
        if kind == "xmp":
            xmp_seen += 1
            if xmp_seen > 1:
                raise _Refuse()  # a second XMP packet: nothing writes one, and it could carry what the first does not
        if kind == "exif":
            _strip_tiff(buf, p + 6, e, depth, edits)
            edits.append((p + 6, e))
        elif kind == "xmp":
            _blank_xmp(buf, p + len(_XMP_NS), e)
            edits.append((p + len(_XMP_NS), e))


def _confined(original, copy, edits):
    """True when ``copy`` equals ``original`` everywhere outside the ``edits`` ranges (and has the same length)."""
    if len(copy) != len(original):
        return False
    cursor = 0
    for lo, hi in sorted(edits):
        if original[cursor:lo] != copy[cursor:lo]:
            return False
        cursor = max(cursor, hi)
    return original[cursor:] == copy[cursor:]


def _jpeg_copy(data):
    buf = bytearray(data)
    edits = []
    _strip_jpeg(buf, 0, len(buf), 0, edits)
    out = bytes(buf)
    if not _confined(data, out, edits):
        raise _Refuse(VERIFY_FAILED)
    return out


# -------------------------------------------------------------------------------------------------------------------- PNG


def _chunks(data):
    """[(type, data, crc)] of a PNG from IHDR to IEND. A chunk that runs past the data, a missing IEND, and any byte after IEND raise."""
    if data[:8] != _PNG_SIG:
        raise _Refuse()
    pos, n, out = 8, len(data), []
    while pos < n:
        if pos + 12 > n:
            raise _Refuse()
        length, kind = struct.unpack_from(">I4s", data, pos)
        end = pos + 8 + length
        if end + 4 > n:
            raise _Refuse()
        out.append((kind, data[pos + 8:end], data[end:end + 4]))
        budget().take("parts")
        if struct.pack(">I", zlib.crc32(data[pos + 4:end]) & 0xFFFFFFFF) != out[-1][2]:
            raise _Refuse()  # a chunk whose CRC is wrong: its length may be wrong too, and swallow what follows
        pos = end + 4
        if kind == b"IEND":
            break
    if not out or out[0][0] != b"IHDR" or out[-1][0] != b"IEND" or pos < n:
        raise _Refuse()
    return out


def _itxt_text_start(body):
    k = body.find(b"\x00")
    if k < 0 or k + 3 > len(body):
        raise _Refuse()
    lang_end = body.find(b"\x00", k + 3)
    if lang_end < 0:
        raise _Refuse()
    trans_end = body.find(b"\x00", lang_end + 1)
    if trans_end < 0:
        raise _Refuse()
    return body[:k], body[k + 1], body[k + 2], trans_end + 1


def _png_text(kind, body):
    """(keyword, the text, inflated when it is deflated) of a tEXt, zTXt or iTXt chunk. Refuses what it cannot decode."""
    if kind == b"tEXt":
        k = body.find(b"\x00")
        if k < 0:
            raise _Refuse()
        return body[:k], body[k + 1:]
    if kind == b"zTXt":
        k = body.find(b"\x00")
        if k < 0 or k + 2 > len(body) or body[k + 1] != 0:
            raise _Refuse()
        return body[:k], _inflate(body[k + 2:])
    keyword, flag, method, at = _itxt_text_start(body)
    if flag == 1 and method == 0:
        return keyword, _inflate(body[at:])
    if flag == 0:
        return keyword, body[at:]
    raise _Refuse()


def _png_copy(data):
    pieces = [_PNG_SIG]
    xmp_seen = 0
    for kind, body, crc in _chunks(data):
        if kind not in _PNG_KINDS:
            raise _Refuse()  # an unknown chunk (zxIf, exIf, a vendor's) may hold a position this does not read
        new = body
        if kind == b"eXIf":
            buf = bytearray(body)
            start = 6 if bytes(buf[:6]) == b"Exif\x00\x00" else 0
            _strip_tiff(buf, start, len(buf), 0, [])
            new = bytes(buf)
        elif kind == b"iTXt":
            keyword, flag, method, text_at = _itxt_text_start(body)
            if keyword == _XMP_KEYWORD:
                xmp_seen += 1
                if xmp_seen > 1:
                    raise _Refuse()  # a second XMP chunk
                if flag == 1 and method == 0:
                    text = bytearray(_inflate(body[text_at:]))
                    _blank_xmp(text, 0, len(text))
                    new = body[:text_at] + zlib.compress(bytes(text), 9)
                elif flag == 0:
                    buf = bytearray(body)
                    _blank_xmp(buf, text_at, len(buf))
                    new = bytes(buf)
                else:
                    raise _Refuse()
        if new != body:
            crc = struct.pack(">I", zlib.crc32(kind + new) & 0xFFFFFFFF)
        pieces.append(struct.pack(">I", len(new)) + kind + new + crc)
    return b"".join(pieces)


# ------------------------------------------------------------------------------------------------------- the checks of a copy


def _has_gps_pointer(b, start, end):
    """True when the TIFF at ``b[start:end]`` has a GPS pointer in any IFD it can reach, or cannot be walked. Not a TIFF header: False.
    Written apart from ``_Tiff`` on purpose: it is the second opinion."""
    if end - start < 8:
        return False
    if b[start:start + 2] == b"II":
        fmt = "<"
    elif b[start:start + 2] == b"MM":
        fmt = ">"
    else:
        return False
    size = end - start
    try:
        if struct.unpack_from(fmt + "H", b, start + 2)[0] != 42:
            return False
        todo, seen = [struct.unpack_from(fmt + "I", b, start + 4)[0]], set()
        while todo:
            off = todo.pop()
            if not off:
                continue
            if off in seen or len(seen) > 64 or off + 2 > size:
                return True
            seen.add(off)
            n = struct.unpack_from(fmt + "H", b, start + off)[0]
            if off + 2 + n * 12 + 4 > size:
                return True
            budget().take("entries", n)
            for i in range(n):
                at = start + off + 2 + i * 12
                tag, typ, count, value = struct.unpack_from(fmt + "HHII", b, at)
                if tag == _GPS_POINTER:
                    return True
                if tag in (_EXIF_POINTER, _INTEROP_POINTER) and value:
                    todo.append(value)
                elif tag == _SUB_IFDS:
                    if count > 16:
                        return True
                    if count == 1:
                        todo.append(value)
                    elif 4 * count + value > size:
                        return True
                    else:
                        todo.extend(struct.unpack_from(fmt + "I", b, start + value + 4 * k)[0] for k in range(count))
            nxt = struct.unpack_from(fmt + "I", b, start + off + 2 + n * 12)[0]
            if nxt:
                todo.append(nxt)
    except struct.error:
        return True
    return False


def _tiffs_have_gps(b, lo=0, hi=None):
    """True when ANY TIFF signature in ``b[lo:hi]`` (a main Exif block, a raw one behind any header, one in a trailer, in a thumbnail, in an
    IRB) leads to a GPS pointer or to a structure that cannot be walked, or when there are more signatures than any file has."""
    hi = len(b) if hi is None else hi
    for n, m in enumerate(_TIFF_SIG.finditer(b, lo, hi), 1):
        budget().take("signatures")
        if n > _MAX_SIGNATURES or _has_gps_pointer(b, m.start(), hi):
            return True
    return False


def _coordinate_text(text):
    """A latitude/longitude pair or degrees-minutes text in ``text`` (also as UTF-16). A cheap test first: the pattern needs a decimal point or a degree sign."""
    plain = text.replace(b"\x00", b"") if b"\x00" in text else text
    if b"." not in plain and b"\xb0" not in plain and b"deg" not in plain.lower():
        return False
    return bool(_COORD_TEXT.search(plain))


def _words_show_gps(text):
    return b"gps" in _squash(text) or b"\xa9xyz" in text or _names_in(text, _TOKEN_WORDS + _POSITION_WORDS) or _coordinate_text(text)


def _residue(data, content_type):
    if _names_in(data, _TOKEN_WORDS + _POSITION_WORDS):
        return True  # what the signal reads as a position must not be in a copy, however the name was damaged around it
    if _exif_headers_have_gps(data):
        return True
    if content_type == JPEG:
        segs, _end = _jpeg_layout(data, 0, len(data))
        for marker, p, e in segs:
            kind = _app_kind(marker, data, p, e)
            if kind is None or kind == "xmpext":
                return True
            payload = data[p:e]
            if kind != "icc" and _words_show_gps(payload):
                return True
            if _tiffs_have_gps(payload):
                return True
        return False
    if content_type == PNG:
        for kind, body, _crc in _chunks(data):
            if kind not in _PNG_KINDS:
                return True
            if kind in _PNG_PICTURE:
                continue
            if kind == b"iCCP":
                k = body.find(b"\x00")
                if k < 0 or _tiffs_have_gps(_inflate(body[k + 2:])):
                    return True
                continue
            text = body
            if kind in (b"tEXt", b"zTXt", b"iTXt"):
                keyword, text = _png_text(kind, body)
                if any(s in keyword.lower() for s in _SUSPECT_KEYWORDS) and keyword != _XMP_KEYWORD:
                    return True
                if _words_show_gps(keyword):
                    return True
                if kind == b"iTXt" and _words_show_gps(body[len(keyword):_itxt_text_start(body)[3]]):
                    return True  # the language tag and the translated keyword
            if _words_show_gps(text) or _tiffs_have_gps(text):
                return True
        return False
    return True


def has_location_residue(data, content_type):
    """True when ``data`` (a JPEG or PNG) still shows any sign of a GPS position, holds anything the strip does not account for, cannot
    be examined, or needs more work than the budget allows. See the module docstring for the rules; it looks at every metadata byte of the
    file and nowhere else (never in the compressed picture, where three letters can occur by chance)."""
    try:
        with scope():
            return _residue(bytes(data), content_type)
    except (_Refuse, ScanLimit, Unreadable, struct.error, zlib.error, ValueError, IndexError, TypeError, TooBig):
        return True


def _exif_headers_have_gps(b):
    start = 0
    for _ in range(17):
        at = b.find(b"Exif\x00", start)
        if at < 0:
            return False
        if _has_gps_pointer(b, at + 6, len(b)) or _has_gps_pointer(b, at + 5, len(b)):
            return True
        start = at + 5
    return True  # more Exif headers than any camera writes


# ------------------------------------------------------------------------------------------------------------ the positive signal


def _read_rationals(b, start, size, fmt, value, count):
    """True when one of the first rationals at ``value`` has a non-zero numerator and denominator, or cannot be read."""
    for k in range(min(count, 4)):
        o = value + 8 * k
        if o < 0 or o + 8 > size:
            return True
        if struct.unpack_from(fmt + "I", b, start + o)[0] != 0 and struct.unpack_from(fmt + "I", b, start + o + 4)[0] != 0:
            return True
    return False


def _tiff_has_position(b, start, end):
    """True when the TIFF at ``b[start:end]`` has, reached from ANY of its IFDs (chain, Exif, Interoperability, SubIFDs), a GPS IFD with a
    non-zero latitude, longitude or destination, a non-zero altitude, or an area name, or a GPS IFD that cannot be read (a GPS IFD with only a
    version, a time, a status or zero positions, a no-fix one, is not a position). An IFD that declares more entries than the data holds is
    read as far as the data goes, as readers do; when nothing is found in it ``Unreadable`` is raised, because the entries that do not fit
    could be the ones that point at a position. An IFD outside the data is skipped. Work is bounded by the file's budget and every GPS IFD
    is read once."""
    if end - start < 8:
        return False
    if b[start:start + 2] == b"II":
        fmt = "<"
    elif b[start:start + 2] == b"MM":
        fmt = ">"
    else:
        return False
    size = end - start
    bud = budget()
    cache = {}
    lied = False

    def u16(o):
        if o < 0 or o + 2 > size:
            raise struct.error("range")
        return struct.unpack_from(fmt + "H", b, start + o)[0]

    def u32(o):
        if o < 0 or o + 4 > size:
            raise struct.error("range")
        return struct.unpack_from(fmt + "I", b, start + o)[0]

    def read_entries(off):
        """(entries that fit, declared count, whether the declared count fits)"""
        n = u16(off)
        fit = (size - off - 2) // 12
        use = min(n, fit)
        bud.take("entries", use)
        out = []
        for i in range(use):
            at = off + 2 + i * 12
            out.append((u16(at), u16(at + 2), u32(at + 4), u32(at + 8)))
        return out, n, n <= fit

    def gps_position(off):
        if off in cache:
            return cache[off]
        try:
            ents, _n, fits = read_entries(off)
        except struct.error:
            cache[off] = True  # a GPS IFD that cannot be read
            return True
        found = not fits  # a GPS IFD whose count lies: what the rest of it holds is not known
        try:
            for tag, typ, count, value in ents:
                if tag in _POSITION_TAGS:
                    if typ not in (5, 10) or not count or _read_rationals(b, start, size, fmt, value, count):
                        found = True
                elif tag == 0x0006:  # altitude
                    if typ == 5 and count and _read_rationals(b, start, size, fmt, value, count):
                        found = True
                elif tag == 0x001C and typ == 7 and count > 8:  # area name: a character code, then the text
                    if value < 0 or value + count > size or b[start + value + 8:start + value + count].strip(b"\x00 "):
                        found = True
        except struct.error:
            found = True
        cache[off] = found
        return found

    try:
        if u16(2) != 42:
            return False
        todo, seen = [u32(4)], set()
        while todo:
            off = todo.pop()
            if not off or off in seen:
                continue
            if len(seen) >= 64:
                raise Unreadable()  # more IFDs than any file has
            seen.add(off)
            try:
                ents, n, fits = read_entries(off)
                if not fits:
                    lied = True
                for tag, typ, count, value in ents:
                    if tag == _GPS_POINTER:
                        if gps_position(value):
                            return True
                    elif tag in (_EXIF_POINTER, _INTEROP_POINTER) and value:
                        todo.append(value)
                    elif tag == _SUB_IFDS:
                        if count == 1:
                            todo.append(value)
                        elif count <= 16:
                            todo.extend(u32(value + 4 * k) for k in range(count))
                if fits:
                    todo.append(u32(off + 2 + n * 12))
            except struct.error:
                continue  # an IFD outside the data: nothing there to read
    except struct.error:
        return False
    if lied:
        raise Unreadable()
    return False


def _tiffs_have_position(b, lo, hi, end=None):
    """Any TIFF signature in ``b[lo:hi]`` walked for a position; the walk may run on to ``end`` (a block that straddles a segment edge)."""
    unreadable = False
    for m in _TIFF_SIG.finditer(b, lo, hi):
        budget().take("signatures")
        try:
            if _tiff_has_position(b, m.start(), hi if end is None else end):
                return True
        except Unreadable:
            unreadable = True
    if unreadable:
        raise Unreadable()
    return False


def _jpeg_meta_spans(data):
    """[(lo, hi)]: all bytes of a JPEG but its entropy-coded scans. What follows EOI, and what follows a structure it cannot follow, counts."""
    n, pos, spans = len(data), 2, [(0, min(2, len(data)))]
    while pos < n:
        budget().take("parts")
        if data[pos] != 0xFF or pos + 1 >= n:
            spans.append((pos, n))
            return spans
        m = data[pos + 1]
        if m == 0xFF:
            pos += 1
            continue
        if m == 0x00 or m == 0x01 or 0xD0 <= m <= 0xD8:
            spans.append((pos, pos + 2))
            pos += 2
            continue
        if m == 0xD9 or pos + 4 > n:
            spans.append((pos, n))
            return spans
        length = struct.unpack_from(">H", data, pos + 2)[0]
        if length < 2 or pos + 2 + length > n:
            spans.append((pos, n))
            return spans
        spans.append((pos, pos + 2 + length))
        pos += 2 + length
        if m == 0xDA:
            nxt = _NEXT_MARKER.search(data, pos)
            if nxt is None:
                spans.append((pos, n))
                return spans
            pos = nxt.start()
    return spans


def _raw_profile(text):
    """The bytes of an ImageMagick raw profile text (an empty line, the profile name, its length, then hex), or None. An ICC profile is not read."""
    lines = text.split(b"\n", 3)
    if len(lines) < 4 or lines[1].strip().lower() in (b"icc", b"icm"):
        return None
    digits = re.sub(rb"[^0-9a-fA-F]", b"", lines[3])
    try:
        return bytes.fromhex(digits[:len(digits) // 2 * 2].decode("ascii"))
    except ValueError:
        return None


def _png_pieces(data):
    """Yields (kind, body) of every chunk it can read; whatever it cannot read (a cut chunk, a wrong CRC, the bytes after IEND) as (None, rest)."""
    pos, n = 8, len(data)
    while pos < n:
        budget().take("parts")
        if pos + 12 > n:
            yield None, data[pos:]
            return
        length, kind = struct.unpack_from(">I4s", data, pos)
        end = pos + 8 + length
        if end + 4 > n:
            yield None, data[pos:]
            return
        if struct.pack(">I", zlib.crc32(data[pos + 4:end]) & 0xFFFFFFFF) != data[end:end + 4]:
            yield None, data[pos:]  # a wrong CRC: the length may be wrong, so the rest of the file is read as one piece
            return
        yield kind, data[pos + 8:end]
        pos = end + 4
        if kind == b"IEND":
            if pos < n:
                yield None, data[pos:]
            return


def _signal(data, ct, state):
    """True when a position is found. ``state["unreadable"]`` is set when something could not be read with certainty."""
    if _names_in(data, _POSITION_WORDS):
        return True

    def tiffs(buf, lo, hi, end=None):
        try:
            return _tiffs_have_position(buf, lo, hi, end)
        except Unreadable:
            state["unreadable"] = True
            return False

    if ct == JPEG:
        spans = _jpeg_meta_spans(data)
        if data[:2] != b"\xff\xd8":
            spans = [(0, len(data))]
        for lo, hi in spans:
            if tiffs(data, lo, hi, len(data)):
                return True
        if spans and spans[-1][1] == len(data) and spans[-1][0] > 2 and b"\xa9xyz" in data[spans[-1][0]:]:
            return True  # a location atom of a video trailer (a motion photo)
        return False
    if ct == PNG:
        if data[:8] != _PNG_SIG:
            return tiffs(data, 0, len(data))
        for kind, body in _png_pieces(data):
            if kind in _PNG_PICTURE:
                continue
            if kind is None:
                if tiffs(body, 0, len(body)) or _names_in(body, _POSITION_WORDS):
                    return True
                continue
            views = [body]
            try:
                if kind in (b"tEXt", b"zTXt", b"iTXt"):
                    keyword, text = _png_text(kind, body)
                    views.append(text)
                    if keyword.lower().startswith(b"raw profile"):
                        raw = _raw_profile(text)
                        if raw is not None:
                            views.append(raw)
                elif kind != b"eXIf":
                    for skip in (0, 1):               # an unknown chunk may be deflated (zxIf: a method byte, then the stream)
                        try:
                            views.append(_inflate(body[skip:]))
                        except _Refuse:
                            pass
            except _Refuse:
                state["unreadable"] = True
            for view in views:
                if tiffs(view, 0, len(view)) or _names_in(view, _POSITION_WORDS):
                    return True
        return False
    return False


def assess_signal(data, content_type):
    """What a JPEG, PNG or TIFF shows, by any of the ways the format allows: ``"location"`` (a GPS position in any IFD, in the Exif sub-IFD,
    behind an ``Exif\\0\\xff`` header or a raw TIFF anywhere in the metadata, in deflated or UTF-16 XMP or text, in a hex raw profile, a position
    property under another vendor's name, a location atom in a trailer), ``"limit"`` (it needs more work than the budget allows),
    ``"unreadable"`` (a structure that cannot be read with certainty and could hide a position, and none was found), or ``""``. The TIFF of a
    TIFF file is walked from its header (its pixel data is not searched)."""
    try:
        with scope():
            data = bytes(data)
            state = {"unreadable": False}
            if content_type == TIFF:
                try:
                    found = _tiff_has_position(data, 0, len(data))
                except Unreadable:
                    found, state["unreadable"] = False, True
                found = found or _names_in(data, _POSITION_WORDS)
            elif content_type in (JPEG, PNG):
                found = _signal(data, content_type, state)
            else:
                return ""
            return "location" if found else ("unreadable" if state["unreadable"] else "")
    except ScanLimit:
        return "limit"
    except (Unreadable, struct.error, IndexError, ValueError, TypeError, zlib.error, TooBig, _Refuse):
        return "unreadable"


def has_location_signal(data, content_type):
    """``assess_signal`` as a yes or no: True for a position, for a file that could not be read with certainty, and for one over the budget."""
    return bool(assess_signal(data, content_type))


# ------------------------------------------------------------------------------------------------------------------ the API


def strip(data, content_type):
    """``(bytes, "")`` with the GPS location taken out of a JPEG or PNG, or ``(None, reason)``; never raises. ``reason`` is one of
    ``tiff`` (kept held), ``unsupported``, ``unparseable``, ``verify_failed`` and ``limit`` (more work than the budget allows)."""
    try:
        if content_type == TIFF:
            return None, TIFF_KEPT
        if content_type not in (JPEG, PNG) or not isinstance(data, (bytes, bytearray)):
            return None, UNSUPPORTED
        data = bytes(data)
        with scope():
            out = _jpeg_copy(data) if content_type == JPEG else _png_copy(data)
            try:
                left = _residue(out, content_type)
            except _Refuse:
                left = True
        if left:
            return None, VERIFY_FAILED
        return out, ""
    except _Refuse as exc:
        return None, exc.reason if exc.reason in (TIFF_KEPT, UNSUPPORTED, VERIFY_FAILED) else UNPARSEABLE
    except ScanLimit:
        return None, LIMIT
    except Exception:  # noqa: BLE001 - a file the walkers cannot take stays held; nothing escapes (never a RecursionError or MemoryError either)
        return None, UNPARSEABLE
