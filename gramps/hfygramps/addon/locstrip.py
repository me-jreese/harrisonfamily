"""A copy of a JPEG or PNG with minimal metadata, and the reading of a position (HFY-TSK-374). Pure standard library; Python 3.9 compatible.

The Gramps tree and the file on this Mac are never changed: ``strip`` takes the bytes of a file and returns the bytes of a COPY, and the
caller uploads the copy. The copy is BUILT from an allowlist, not cleaned: whatever is not named below is not in it.

    JPEG   kept, byte for byte: SOI, EOI, the frame, scan, restart, Huffman, quantisation and arithmetic tables and the compressed image data
           (never decoded or encoded), and the later scans of a progressive file. Rebuilt: APP0 JFIF (its first 12 bytes, thumbnail size 0),
           APP14 Adobe (its first 12 bytes, the colour transform), and an APP1 Exif that holds ONE tag, Orientation (0x0112, in the byte order the
           original had), if the original had a valid one. Kept after a check: the APP2 ICC profile, if it parses, every tag has a type from a
           list of numeric types or a short text from a conservative alphabet, and no byte is unaccounted for (see ``_check_icc``).
           Dropped: every other APPn (XMP, standard and extended, IPTC/APP13, MPF, maker data, JFXX, thumbnails), every comment, every other Exif tag
           (MakerNote, UserComment, ImageDescription, the GPS IFD...).
    PNG    kept: IHDR, PLTE, tRNS, IDAT, IEND, gAMA, cHRM, sRGB, sBIT, bKGD, pHYs, cICP, mDCV, cLLI (fixed sizes), a checked iCCP, and an eXIf
           rebuilt with Orientation only. Dropped: tEXt, zTXt, iTXt (XMP included), tIME, sPLT, hIST, every other eXIf tag, every unknown ancillary
           chunk. The copy is image-lossless and NOT metadata-lossless.
    TIFF   is not rewritten: the strip returns the reason ``tiff`` and the file stays held.

Fail closed: ``strip`` never raises, and holds (``(None, reason)``) a file whose structure it cannot follow with certainty: a marker or
critical chunk it does not know, an animation (acTL), a wrong CRC, a missing or repeated IHDR/IEND, any byte after the end of the image but
NULs, an Exif it cannot read to the Orientation tag (an IFD whose entry count does not fit), an ICC profile it does not accept (``icc``),
and a file over the work budget (``limit``). Then the copy is checked as a structure, not by a list of bad words (``_verify_jpeg``,
``_verify_png``): it is read again, its marker or chunk sequence must be a subset of the allowlist, the picture-side parts must equal the
original's, the rebuilt parts must be exactly what was built, and over every metadata byte there must be no TIFF signature but the rebuilt
Exif, no GPS or position name (UTF-8, UTF-16, UTF-32), no location atom and no coordinate-shaped text. ``has_location_residue`` (the earlier,
stricter list-based reading) is run on the copy as well.

Reading a position (the add-on holds, or copies, a photo that HAS one): ``assess_signal`` reads every IFD of every TIFF structure in the metadata
(a count that lies is read as far as the data goes), deflated and UTF-16 text, hex raw profiles, a location atom in a trailer, and in XMP any
property whose NAME is a position (gps, lat, lon, lng, long, latitude, longitude, geo, coord, position, ``pos:``, northing, easting, breite,
laenge, altitude, where, location, in any namespace) or whose VALUE is a coordinate pair (decimals, degrees and minutes, with N/S/E/W in any
order, separated by a comma, a tab, a space, a slash or a semicolon); a comment and a text chunk are read for the values. One ``Budget`` per file
bounds the work (IFD entries, TIFF headers, inflated bytes, XMP bytes, segments); past it ``ScanLimit`` is raised and the photo is held as "too
much to check" (``limit``).

Nothing here logs, prints or returns a value of the file: the reasons are code words.
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
ICC = "icc"

_GPS_POINTER = 0x8825
_EXIF_POINTER = 0x8769
_INTEROP_POINTER = 0xA005
_SUB_IFDS = 0x014A
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
_MAX_INFLATED = 8 * 1024 * 1024
_MAX_SIGNATURES = 64    # TIFF signatures walked in one part of a file
_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_XMP_EXT_NS = b"http://ns.adobe.com/xmp/extension/\x00"
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_XMP_KEYWORD = b"XML:com.adobe.xmp"

_NAME_CHARS = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-:")
_WHITE = b" \t\r\n"
_TIFF_SIG = re.compile(rb"II\*\x00|MM\x00\*")
_NEXT_MARKER = re.compile(rb"\xff+[\x01-\xcf\xd8-\xfe]")  # the first marker after entropy-coded data (not a stuffed 0xFF00, not RSTn)
# Long names a chance match inside compressed picture data cannot produce (2**-70 per position or less).
_LONG_TOKENS = re.compile(rb"GPSLatitude|GPSLongitude|GPSInfo|GPSAltitude|GPSDest|GPSVersionID|exif:GPS|GpsLat|GpsLong", re.IGNORECASE)
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


# ----------------------------------------------------------------------------------------------- position names and values

# A property name is a position when its local name (split at capital letters, digits and underscores) has one of these words in it, or starts
# with gps, or when its namespace prefix is ``pos``: LRFTargetLat, vnd:Latitude, geo:long, acme:Lng, target_lat, Northing, Breite, Laenge...
_CAMEL = re.compile(rb"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
_POSITION_TOKENS = frozenset([b"lat", b"latitude", b"lon", b"long", b"longitude", b"lng", b"geo", b"geotag", b"geolocation", b"geocode",
                              b"coord", b"coords", b"coordinate", b"coordinates", b"position", b"northing", b"easting", b"breite",
                              b"laenge", b"altitude", b"where", b"location", b"gps"])
# an attribute (a name before = and a quote) or an element (a name after <); the values: ="..." / ='...' / >text<
_XML_NAME = re.compile(rb"(?:(?<=[\s\"'])((?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*)(?=\s*=\s*[\"'])|<((?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*))")
_XML_VALUE = re.compile(rb"=\s*\"([^\"]{1,512})\"|=\s*'([^']{1,512})'|>([^<>]{1,512})<")
# the pieces of a coordinate: 12.3460 / N12.3460 / E 65 / 12.3460N / 65,25.926E / 12 deg 20 / 12\xb020; two of them close together are a pair
_COORD_TOKEN = re.compile(rb"\d{1,3}\.\d{3,}|\b[NSEW]\s?-?\d{1,3}(?:[.,]\d+)?|\d{1,3}(?:[.,]\d+)?\s?[NSEW]\b|\d{1,3}\s?(?:\xc2\xb0|\xb0|deg)\s?\d{1,2}")
_DIGITS = b"0123456789"


def _position_name(qualified):
    prefix, _sep, local = qualified.rpartition(b":")
    if prefix.lower() == b"pos":
        return True
    low = local.decode("utf-8", "ignore").lower().replace("\u00e4", "ae")
    if low == "gpsversionid":
        return False  # a version number is not a position
    if low.startswith("gps") or "laenge" in low or "breite" in low:
        return True
    return any(w.lower() in _POSITION_TOKENS for w in _CAMEL.findall(local))


def _coord_value(text):
    """True when ``text`` (the first 64 KiB of it) holds a coordinate pair: two pieces of a coordinate within 48 bytes of each other. NULs are
    taken out first (UTF-16, UTF-32)."""
    text = text[:65536]
    if b"\x00" in text:
        text = text.replace(b"\x00", b"")
    if not any(d in text for d in _DIGITS):
        return False
    last = None
    for m in _COORD_TOKEN.finditer(text):
        if last is not None and m.start() - last <= 48:
            return True
        last = m.end()
    return False


def _xmp_has_position(text):
    """True when an XMP text has a property named like a position or a value shaped like a coordinate pair (any namespace, any form)."""
    budget().take("xmp", len(text))
    if b"\x00" in text:
        text = text.replace(b"\x00", b"")
    for n, m in enumerate(_XML_NAME.finditer(text)):
        if n > 50000:
            raise ScanLimit()
        if _position_name(m.group(1) or m.group(2)):
            return True
    for n, m in enumerate(_XML_VALUE.finditer(text)):
        if n > 50000:
            raise ScanLimit()
        if _coord_value(m.group(1) or m.group(2) or m.group(3)):
            return True
    return False


def _looks_like_xmp(text):
    head = text[:8192]
    return b"<x:xmpmeta" in head or b"<?xpacket" in head or b"xmlns:" in head or b"<rdf:" in head


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
    """A coordinate pair (``_coord_value``) in ``text``, also as UTF-16."""
    return _coord_value(text)


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
            if hi - lo > 4 and data[lo] == 0xFF and data[lo + 1] in (0xE1, 0xFE):
                payload = data[lo + 4:hi]
                if data[lo + 1] == 0xFE:
                    if _coord_value(payload):
                        return True  # a comment with a coordinate pair
                elif not payload.startswith(b"Exif\x00") and _xmp_has_position(payload):
                    return True      # an XMP packet (standard, extended, any header) with a position property or value
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
                    if keyword == _XMP_KEYWORD or _looks_like_xmp(text):
                        if _xmp_has_position(text):
                            return True
                    elif _coord_value(text):
                        return True  # a text with a coordinate pair
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


# ------------------------------------------------------------------------------------------------------------ the minimal copy

_ICC_TYPES = frozenset([b"XYZ ", b"curv", b"para", b"sf32", b"mft1", b"mft2", b"mAB ", b"mBA ", b"chrm", b"cicp", b"dtim", b"meas", b"sig ",
                        b"view", b"text", b"desc", b"mluc", b"vcgt", b"ui08", b"ui16", b"ui32", b"uf32"])
_ICC_CHARS = re.compile(r"^[A-Za-z0-9 \-_.,():/%]*$")
_ICC_WORDS = frozenset(["lat", "latitude", "lon", "long", "longitude", "lng", "gps", "geo", "coord", "coords", "coordinate", "coordinates", "position"])
_ICC_MAX = 4 * 1024 * 1024
_PNG_FIXED = {b"IHDR": (13,), b"gAMA": (4,), b"cHRM": (32,), b"sRGB": (1,), b"pHYs": (9,), b"cICP": (4,), b"mDCV": (24,), b"cLLI": (8,),
              b"sBIT": (1, 2, 3, 4), b"bKGD": (1, 2, 6), b"IEND": (0,)}
_PNG_COPIED = frozenset([b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"bKGD", b"pHYs", b"cICP", b"mDCV", b"cLLI"])
_PNG_ANIMATION = frozenset([b"acTL", b"fcTL", b"fdAT"])


def _seg(marker, payload):
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def _icc_text(text):
    """A text of an ICC tag must be short, in a conservative alphabet, and carry no coordinate and no position word."""
    text = text.rstrip("\x00")
    if len(text) > 200 or not _ICC_CHARS.match(text):
        raise _Refuse(ICC)
    if any(w in _ICC_WORDS for w in re.findall(r"[a-z]+", text.lower())) or re.search(r"\d{7,}", text):
        raise _Refuse(ICC)
    if _coord_value(text.encode("ascii")):
        raise _Refuse(ICC)


def _icc_zero(data):
    if data.strip(b"\x00"):
        raise _Refuse(ICC)


def _icc_tag_text(data):
    typ = data[:4]
    if typ == b"text":
        text, _nul, rest = data[8:].partition(b"\x00")
        _icc_zero(rest)
        _icc_text(text.decode("latin-1"))
    elif typ == b"desc":
        count = struct.unpack_from(">I", data, 8)[0] if len(data) >= 12 else 1 << 30
        ascii_, rest = data[12:12 + count], data[12 + count:]
        if len(ascii_) != count:
            raise _Refuse(ICC)
        head, _nul, tail = ascii_.partition(b"\x00")
        _icc_zero(tail)
        _icc_text(head.decode("latin-1"))
        if not rest.strip(b"\x00"):
            return
        if len(rest) < 8 or rest[:4].strip(b"\x00abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"):
            raise _Refuse(ICC)
        ucount = struct.unpack_from(">I", rest, 4)[0]
        ustr, rest2 = rest[8:8 + 2 * ucount], rest[8 + 2 * ucount:]
        if len(ustr) != 2 * ucount:
            raise _Refuse(ICC)
        try:
            _icc_text(ustr.decode("utf-16-be"))
        except UnicodeDecodeError:
            raise _Refuse(ICC)
        if not rest2.strip(b"\x00"):
            return
        if len(rest2) < 3 or rest2[2] > 67:
            raise _Refuse(ICC)
        mac = rest2[3:3 + 67]
        head, _nul, tail = mac[:rest2[2]].partition(b"\x00")
        _icc_zero(tail + mac[rest2[2]:] + rest2[3 + 67:])
        _icc_text(head.decode("latin-1"))
    else:  # mluc
        n, size = struct.unpack_from(">II", data, 8) if len(data) >= 16 else (1 << 30, 0)
        if size != 12 or n > 64 or 16 + 12 * n > len(data):
            raise _Refuse(ICC)
        used = [(0, 16 + 12 * n)]
        for i in range(n):
            lang, country, length, off = struct.unpack_from(">2s2sII", data, 16 + 12 * i)
            if length % 2 or off < 16 + 12 * n or off + length > len(data) or (lang + country).strip(b"\x00abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"):
                raise _Refuse(ICC)
            try:
                _icc_text(data[off:off + length].decode("utf-16-be"))
            except UnicodeDecodeError:
                raise _Refuse(ICC)
            used.append((off, off + length))
        _icc_unaccounted(data, used)


def _icc_unaccounted(data, used):
    """Every byte of ``data`` that is in none of the ``used`` ranges must be zero."""
    cursor = 0
    for lo, hi in sorted(used):
        if lo > cursor:
            _icc_zero(data[cursor:lo])
        cursor = max(cursor, hi)
    _icc_zero(data[cursor:])


def _check_icc(profile):
    """Accepts an ICC profile only when it parses end to end and holds nothing it does not name: the size field is the length, the header's
    reserved bytes are zero, the tag table fits, every tag has a type from ``_ICC_TYPES`` (numbers, curves, matrices, short texts), the text tags
    ('text', 'desc', 'mluc') are short and in a conservative alphabet with no coordinate or position word, no byte lies outside the header, the
    table and the tags unless it is zero. Anything else raises ``_Refuse("icc")``."""
    n = len(profile)
    try:
        if n < 132 or n > _ICC_MAX or struct.unpack_from(">I", profile, 0)[0] != n or profile[36:40] != b"acsp" or profile[100:128].strip(b"\x00"):
            raise _Refuse(ICC)
        count = struct.unpack_from(">I", profile, 128)[0]
        table_end = 132 + 12 * count
        if count > 200 or table_end > n:
            raise _Refuse(ICC)
        used = [(0, table_end)]
        for i in range(count):
            _sig, off, size = struct.unpack_from(">4sII", profile, 132 + 12 * i)
            if size < 8 or off < table_end or off + size > n:
                raise _Refuse(ICC)
            data = profile[off:off + size]
            if data[:4] not in _ICC_TYPES or data[4:8] != b"\x00\x00\x00\x00":
                raise _Refuse(ICC)
            if data[:4] in (b"text", b"desc", b"mluc"):
                _icc_tag_text(data)
            used.append((off, off + size))
        _icc_unaccounted(profile, used)
    except (struct.error, ValueError):
        raise _Refuse(ICC)


def _orientation(tiff):
    """(byte order, Orientation 1..8) of the first IFD of an Exif TIFF, or None when there is no valid one. An Exif it cannot read to the end of
    IFD0 (an entry count that does not fit, a repeated Orientation tag) raises: the photo is held, as the Orientation cannot be told with certainty."""
    if len(tiff) < 8 or tiff[:4] not in (b"II*\x00", b"MM\x00*"):
        raise _Refuse()
    order = "<" if tiff[:2] == b"II" else ">"
    off = struct.unpack_from(order + "I", tiff, 4)[0]
    if off == 0:
        return None
    if off < 8 or off + 2 > len(tiff):
        raise _Refuse()
    n = struct.unpack_from(order + "H", tiff, off)[0]
    if off + 2 + 12 * n + 4 > len(tiff):
        raise _Refuse()
    budget().take("entries", n)
    found, value = False, None
    for i in range(n):
        tag, typ, count = struct.unpack_from(order + "HHI", tiff, off + 2 + 12 * i)
        if tag == 0x0112:
            if found:
                raise _Refuse()
            found = True
            number = struct.unpack_from(order + "H", tiff, off + 2 + 12 * i + 8)[0]
            value = number if typ == 3 and count == 1 and 1 <= number <= 8 else None  # a value no reader accepts is no Orientation
    return (order, value) if value else None


def _exif_tiff(order, value):
    """The whole Exif TIFF of the copy: IFD0 with one entry, Orientation, and no next IFD (26 bytes)."""
    return ((b"II*\x00" if order == "<" else b"MM\x00*") + struct.pack(order + "IH", 8, 1) + struct.pack(order + "HHI", 0x0112, 3, 1)
            + struct.pack(order + "H", value) + b"\x00\x00" + struct.pack(order + "I", 0))


def _jpeg_parts(data):
    """[(marker, payload)] of every marker segment from SOI to EOI, and (None, bytes) for the entropy-coded data after each SOS, in file order.
    Raises ``_Refuse`` for anything it cannot follow: a marker that is not a segment marker of a JPEG, a cut segment, no EOI, and any byte after
    EOI but NULs."""
    n, pos, parts = len(data), 2, []
    if data[:2] != b"\xff\xd8":
        raise _Refuse()
    while True:
        budget().take("parts")
        if pos + 2 > n or data[pos] != 0xFF:
            raise _Refuse()
        marker = data[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker == 0xD9:
            if data[pos + 2:].strip(b"\x00"):
                raise _Refuse()
            return parts
        if marker not in _STRUCTURAL and not 0xE0 <= marker <= 0xEF and marker != 0xFE:
            raise _Refuse()
        if pos + 4 > n:
            raise _Refuse()
        length = struct.unpack_from(">H", data, pos + 2)[0]
        if length < 2 or pos + 2 + length > n:
            raise _Refuse()
        parts.append((marker, data[pos + 4:pos + 2 + length]))
        pos += 2 + length
        if marker == 0xDA:
            nxt = _NEXT_MARKER.search(data, pos)
            if nxt is None:
                raise _Refuse()
            parts.append((None, data[pos:nxt.start()]))
            pos = nxt.start()


def _icc_of_jpeg(parts):
    """The ICC profile in the APP2 segments of a JPEG (None when there is none); raises ``_Refuse("icc")`` for a broken chain of segments."""
    found = [p for m, p in parts if m == 0xE2 and p[:12] == b"ICC_PROFILE\x00"]
    if not found:
        return None
    if any(len(p) < 14 or p[13] == 0 for p in found) or len({p[13] for p in found}) != 1:
        raise _Refuse(ICC)
    total = found[0][13]
    if sorted(p[12] for p in found) != list(range(1, total + 1)):
        raise _Refuse(ICC)
    profile = b"".join(p[14:] for p in sorted(found, key=lambda p: p[12]))
    _check_icc(profile)
    return profile


def _build_jpeg(parts):
    _icc_of_jpeg(parts)
    out, jfif, exif, adobe = [b"\xff\xd8"], False, False, False
    for marker, payload in parts:
        if marker is None:
            out.append(payload)
        elif marker in _STRUCTURAL:
            out.append(_seg(marker, payload))
        elif marker == 0xE0 and payload[:5] == b"JFIF\x00" and len(payload) >= 14 and not jfif:
            jfif = True
            out.append(_seg(0xE0, payload[:12] + b"\x00\x00"))
        elif marker == 0xE1 and payload[:6] == b"Exif\x00\x00" and not exif:
            exif = True
            found = _orientation(payload[6:])
            if found:
                out.append(_seg(0xE1, b"Exif\x00\x00" + _exif_tiff(*found)))
        elif marker == 0xE2 and payload[:12] == b"ICC_PROFILE\x00":
            out.append(_seg(marker, payload))
        elif marker == 0xEE and payload[:5] == b"Adobe" and len(payload) >= 12 and not adobe:
            adobe = True
            out.append(_seg(0xEE, payload[:12]))
        # every other segment (XMP, IPTC, MPF, JFXX, maker data, comments...) is not in the copy
    out.append(b"\xff\xd9")
    return b"".join(out)


def _scan_metadata(meta, tiffs_allowed):
    """The checks over every metadata byte of a copy: no TIFF signature beyond the ``tiffs_allowed`` of the rebuilt Exif, no GPS or position name,
    no location atom, no coordinate-shaped text. True when it is clean."""
    return (len(_TIFF_SIG.findall(meta)) == tiffs_allowed and not _names_in(meta, _TOKEN_WORDS + _POSITION_WORDS) and b"gps" not in _squash(meta)
            and b"\xa9xyz" not in meta and not _coord_value(meta))


def _scan_picture_side(blob):
    """The parts that are copied as they are (tables, scan data, palette, picture chunks) must not carry a position either: no GPS name, and no
    TIFF signature that walks to a GPS position (a random signature in compressed data walks to nothing and is ignored)."""
    try:
        if _names_in(blob, _TOKEN_WORDS + _POSITION_WORDS) or _tiffs_have_position(blob, 0, len(blob)):
            raise _Refuse(VERIFY_FAILED)
    except Unreadable:
        raise _Refuse(VERIFY_FAILED)


def _verify_jpeg(out, parts_in):
    """The copy, read again: only the picture-side parts of the original, and the rebuilt or checked metadata, nothing else."""
    parts = _jpeg_parts(out)

    def picture(items):
        return [(m, p) for m, p in items if m is None or m in _STRUCTURAL]

    if picture(parts) != picture(parts_in):
        raise _Refuse(VERIFY_FAILED)
    meta, icc_chunks, kinds = [], [], []
    for marker, payload in parts:
        if marker is None or marker in _STRUCTURAL:
            continue
        kinds.append(marker)
        if marker == 0xE0 and len(payload) == 14 and payload[:5] == b"JFIF\x00" and payload[12:] == b"\x00\x00":
            pass
        elif marker == 0xEE and len(payload) == 12 and payload[:5] == b"Adobe":
            pass
        elif marker == 0xE1 and payload[:6] == b"Exif\x00\x00" and _exif_tiff(*(_orientation(payload[6:]) or (None, 0))) == payload[6:]:
            pass
        elif marker == 0xE2 and payload[:12] == b"ICC_PROFILE\x00":
            icc_chunks.append(payload)
            continue
        else:
            raise _Refuse(VERIFY_FAILED)
        meta.append(_seg(marker, payload))
    if any(kinds.count(k) > 1 for k in (0xE0, 0xE1, 0xEE)):
        raise _Refuse(VERIFY_FAILED)
    table = b"".join(_seg(m, p) for m, p in parts if m in _STRUCTURAL and m != 0xDA)
    if not _scan_metadata(b"".join(meta) + table, 1 if 0xE1 in kinds else 0):
        raise _Refuse(VERIFY_FAILED)
    _scan_picture_side(b"".join(p for m, p in parts if m is None) + table)
    profile = _icc_of_jpeg(parts)
    if profile is not None and (_names_in(profile, _TOKEN_WORDS + _POSITION_WORDS) or _TIFF_SIG.search(profile) or b"\xa9xyz" in profile):
        raise _Refuse(VERIFY_FAILED)


def _png_orientation(body):
    return _orientation(body[6:] if body[:6] == b"Exif\x00\x00" else body)


def _png_icc(body):
    k = body.find(b"\x00")
    if k < 1 or k > 79 or body[k + 1:k + 2] != b"\x00":
        raise _Refuse(ICC)
    _icc_text(body[:k].decode("latin-1"))
    profile = _inflate(body[k + 2:])
    _check_icc(profile)
    return profile


def _png_chunk(kind, body, crc=None):
    crc = crc if crc is not None else struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    return struct.pack(">I", len(body)) + kind + body + crc


def _build_png(chunks):
    out, exif = [_PNG_SIG], False
    for kind, body, crc in chunks:
        if kind in _PNG_ANIMATION:
            raise _Refuse()  # dropping the frames would change the picture
        if kind in _PNG_COPIED:
            if kind in _PNG_FIXED and len(body) not in _PNG_FIXED[kind] or kind == b"PLTE" and (len(body) % 3 or len(body) > 768):
                raise _Refuse()
            out.append(_png_chunk(kind, body, crc))
        elif kind == b"iCCP":
            _png_icc(body)
            out.append(_png_chunk(kind, body, crc))
        elif kind == b"eXIf":
            if not exif:
                exif = True
                found = _png_orientation(body)
                if found:
                    out.append(_png_chunk(b"eXIf", _exif_tiff(*found)))
        elif kind[0] & 0x20 == 0:
            raise _Refuse()  # a critical chunk this does not know
        # an ancillary chunk that is not named above (tEXt, zTXt, iTXt, tIME, sPLT, hIST, unknown) is not in the copy
    return b"".join(out)


def _verify_png(out, chunks_in):
    chunks = _chunks(out)

    def picture(items):
        return [(k, b) for k, b, _c in items if k in _PNG_COPIED]

    if picture(chunks) != picture(chunks_in):
        raise _Refuse(VERIFY_FAILED)
    meta, kinds, profile, picture = [], [], None, []
    for kind, body, _crc in chunks:
        if kind in _PNG_COPIED:
            if kind not in (b"IDAT", b"PLTE", b"tRNS"):
                meta.append(kind + body)
            else:
                picture.append(body)
            continue
        kinds.append(kind)
        if kind == b"eXIf" and _exif_tiff(*(_orientation(body) or (None, 0))) == body:
            meta.append(kind + body)
        elif kind == b"iCCP":
            profile = _png_icc(body)
            if _names_in(profile, _TOKEN_WORDS + _POSITION_WORDS) or _TIFF_SIG.search(profile) or b"\xa9xyz" in profile:
                raise _Refuse(VERIFY_FAILED)
            meta.append(body[:body.find(b"\x00")])
        else:
            raise _Refuse(VERIFY_FAILED)
    if any(kinds.count(k) > 1 for k in (b"eXIf", b"iCCP")) or not _scan_metadata(b"".join(meta), 1 if b"eXIf" in kinds else 0):
        raise _Refuse(VERIFY_FAILED)
    _scan_picture_side(b"".join(picture))


# ------------------------------------------------------------------------------------------------------------------ the API


def strip(data, content_type):
    """``(bytes, "")``: a copy of a JPEG or PNG with minimal metadata (see the module docstring), or ``(None, reason)``; never raises. ``reason``
    is one of ``tiff`` (kept held), ``unsupported``, ``unparseable``, ``verify_failed``, ``icc`` (a colour profile it does not accept) and
    ``limit`` (more work than the budget allows)."""
    try:
        if content_type == TIFF:
            return None, TIFF_KEPT
        if content_type not in (JPEG, PNG) or not isinstance(data, (bytes, bytearray)):
            return None, UNSUPPORTED
        data = bytes(data)
        with scope():
            if content_type == JPEG:
                parts = _jpeg_parts(data)
                out = _build_jpeg(parts)
                _verify_jpeg(out, parts)
            else:
                chunks = _chunks(data)
                out = _build_png(chunks)
                _verify_png(out, chunks)
            try:
                left = _residue(out, content_type)
            except _Refuse:
                left = True
        if left:
            return None, VERIFY_FAILED
        return out, ""
    except _Refuse as exc:
        return None, exc.reason if exc.reason in (TIFF_KEPT, UNSUPPORTED, VERIFY_FAILED, ICC) else UNPARSEABLE
    except ScanLimit:
        return None, LIMIT
    except Exception:  # noqa: BLE001 - a file the walkers cannot take stays held; nothing escapes (never a RecursionError or MemoryError either)
        return None, UNPARSEABLE
