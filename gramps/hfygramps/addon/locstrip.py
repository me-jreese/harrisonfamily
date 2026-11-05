"""A copy of a JPEG or PNG with minimal metadata, and the reading of a position (HFY-TSK-374). Pure standard library; Python 3.9 compatible.

The Gramps tree and the file on this Mac are never changed: ``strip`` takes the bytes of a file and returns the bytes of a COPY, and the
caller uploads the copy. The copy is BUILT from an allowlist, not cleaned: whatever is not named below is not in it.

    JPEG   kept, byte for byte, after a structural check: SOI, EOI, the frame (SOF0, SOF1 or SOF2, 8 bit), the scans, the restart interval, and
           the quantisation and Huffman tables the frame and the scans name (a table nothing uses, and DHP, EXP, DAC, DNL, are refused). Rebuilt:
           APP0 JFIF (its first 12 bytes, thumbnail size 0), APP14 Adobe (its first 12 bytes, a transform that fits the components), and an APP1
           Exif that holds ONE tag, Orientation (0x0112, in the byte order the original had), if the original had a valid one. Kept after a check:
           the APP2 ICC profile, if it is clean (``_check_icc``), written again in a fixed form (``_rewrite_icc``: every text tag a neutral
           string, the colour tags byte for byte, the profile ID and the header's text fields zero). Dropped: every other APPn (XMP, standard and extended, IPTC/APP13, MPF, maker
           data, JFXX, thumbnails), every comment, every other Exif tag (MakerNote, UserComment, ImageDescription, the GPS IFD...).
           Every scan is read to its real end with a syntax-only Huffman decoder (``_validate_scan``): only 0xFF00 stuffing and RSTn in sequence
           inside it, the number of MCUs and blocks the frame asks for, the padding of 1-bits, the next real marker straight after: a byte more or
           less, text before EOI, a second scan that carries a payload, are ``structure``. Several scans only in a progressive frame.
    PNG    kept: IHDR, PLTE (colour type 3 only), tRNS, IDAT, IEND, gAMA, cHRM, sRGB, sBIT, bKGD, pHYs, all of fixed sizes that fit the header, a
           iCCP written the same way (a fixed keyword and a new zlib stream), and an eXIf rebuilt with Orientation only. The IDAT chunks must be one zlib stream that inflates to exactly the scanlines
           of the header (Adam7 too, filter bytes 0 to 4), with no unused input and no chunk after the end of the stream. Dropped: tEXt, zTXt, iTXt
           (XMP included), tIME, sPLT, hIST, cICP, mDCV, cLLI, every other eXIf tag, every unknown ancillary chunk. The copy is image-lossless and
           NOT metadata-lossless.
    TIFF   is not rewritten: the strip returns the reason ``tiff`` and the file stays held.

Fail closed: ``strip`` never raises, and holds (``(None, reason)``) a file whose structure it cannot follow with certainty: a marker or
critical chunk it does not know, an animation (acTL), a wrong CRC, a missing or repeated IHDR/IEND, any byte after the end of the image but
NULs, an Exif it cannot read to the Orientation tag (an IFD whose entry count does not fit), a picture side it cannot account for
(``structure``), an ICC profile it does not accept (``icc``), and a file over the work budget (``limit``). Then the copy is checked as a
structure, not by a list of bad words (``_verify_jpeg``, ``_verify_png``): it is read again, its marker or chunk sequence must be a subset of
the allowlist, the picture-side parts must equal the original's, the rebuilt parts must be exactly what was built, and over every metadata
byte there must be no TIFF signature but the rebuilt Exif, no GPS or position name (UTF-8, UTF-16, UTF-32), no location atom and no
coordinate-shaped text. ``has_location_residue`` (the earlier, stricter list-based reading) is run on the copy as well.

Not detectable: the coded picture itself. A scan or a zlib stream that decodes and has the right size can hide any payload an adversary
encoded into the image (steganography), and a table (quantisation values, Huffman symbols, ICC numbers) holds numbers by design; the checks
refuse a table that spells a decimal number or a run of digits and everything outside the picture, not a picture that was made to carry bytes.
The bit-level choices of the compressed data (the unused bits of a deflate block, empty stored blocks) are not examined either.

Reading a position (the add-on holds, or copies, a photo that HAS one): ``assess_signal`` reads every IFD of every TIFF structure in the metadata
(a count that lies is read as far as the data goes), deflated and UTF-16 text, hex raw profiles, a location atom in a trailer, and in XMP any
property whose NAME is a position (gps, lat, lon, lng, long, latitude, longitude, geo, coord, position, ``pos:``, northing, easting, breite,
laenge, altitude, where, location, in any namespace) or whose VALUE is a coordinate pair (decimals, degrees and minutes, with N/S/E/W in any
order, separated by a comma, a tab, a space, a slash or a semicolon); a comment and a text chunk are read for the values. One ``Budget`` per file
bounds the work (IFD entries, TIFF headers, inflated bytes, XMP bytes, segments); past it ``ScanLimit`` is raised and the photo is held as "too
much to check" (``limit``).

Nothing here logs, prints or returns a value of the file: the reasons are code words.
"""
import array
import collections
import hashlib
import itertools
import re
import struct
import threading
import unicodedata
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
STRUCTURE = "structure"  # the picture side of the file has a part the add-on cannot account for (rule media_structure)

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
_BUDGET_SCAN = 192 * 1024 * 1024      # bytes of entropy-coded JPEG data, or of inflated PNG picture data, read to their end in one file
_BUDGET_BLOCKS = 16 * 1024 * 1024     # JPEG blocks and PNG scanlines walked in one file
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
        self.entries, self.signatures, self.inflated, self.xmp, self.parts, self.scan, self.blocks = (
            _BUDGET_ENTRIES, _BUDGET_SIGNATURES, _BUDGET_INFLATED, _BUDGET_XMP, _BUDGET_PARTS, _BUDGET_SCAN, _BUDGET_BLOCKS)

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


# ------------------------------------------------------------------------------------------------------- the picture side of a JPEG

# The bytes a copy takes over as they are (tables, scan data) are walked to their real end, so nothing can ride along in them: a frame with
# valid fields, tables that parse exactly and that a scan uses, and every scan decoded as far as its syntax goes (the Huffman symbols are read,
# no pixel is made) up to the last bit of the last MCU, the padding being ones, the restart markers in sequence. Only baseline and extended
# sequential (SOF0, SOF1) and progressive (SOF2) Huffman JPEGs of 8 bits are accepted; DAC, DHP, EXP, DNL and every other frame type are held.
# What this cannot tell from the picture: the values of a table or of the picture itself (a quantisation table is 64 bytes that scale the
# picture, a Huffman table lists its symbols, the scan is the coded coefficients). A table that spells a decimal number is refused (a real
# table has no "." between digits, and a Huffman symbol can never be 0x2e); a crafted scan that decodes can still spell bytes, and the
# picture it makes shows it. That is steganography in the pixels, which no metadata filter can see.


def _bad():
    raise _Refuse(STRUCTURE)


def _ceil(a, b):
    return -(-a // b)


def _parse_sof(marker, payload):
    if marker not in (0xC0, 0xC1, 0xC2) or len(payload) < 6:
        _bad()
    prec, height, width, nf = struct.unpack(">BHHB", payload[:6])
    if prec != 8 or height < 1 or width < 1 or not 1 <= nf <= 4 or len(payload) != 6 + 3 * nf:
        _bad()
    comps, seen = [], set()
    for i in range(nf):
        cid, hv, tq = payload[6 + 3 * i:9 + 3 * i]
        if not (1 <= hv >> 4 <= 4 and 1 <= hv & 15 <= 4 and tq <= 3) or cid in seen:
            _bad()
        seen.add(cid)
        comps.append((cid, hv >> 4, hv & 15, tq))
    return {"progressive": marker == 0xC2, "height": height, "width": width, "comps": comps,
            "hmax": max(c[1] for c in comps), "vmax": max(c[2] for c in comps)}


# A quantisation table is 64 bytes of numbers, and a real one has stretches whose values happen to be ASCII digits (the libjpeg table at quality
# 53 to 57 has eight in a row, the one at 55 has "4.763", and one real encoder's table has "3.4444"), so only what a real table does not do is
# refused: a number with a point, four or more decimals and four different digits, eleven digits in a row with five different values, or four
# numbers of two digits or more with separators between them ("12 20 44 / 65 25 55").
_TABLE_POINT = re.compile(rb"[0-9]{1,3}\.[0-9]{4,}")
_TABLE_DIGITS = re.compile(rb"[0-9]{11,}")
_TABLE_PAIRS = re.compile(rb"(?:[0-9]{2,6}[ ,/;.-]{1,3}){3,}[0-9]{2,6}")


def _table_spells_text(values):
    values = bytes(values)
    return (any(len(set(m.group())) >= 5 for m in _TABLE_POINT.finditer(values))      # the point itself is one of the values
            or any(len(set(m.group())) >= 5 for m in _TABLE_DIGITS.finditer(values)) or bool(_TABLE_PAIRS.search(values)))


def _parse_dqt(payload):
    ids, pos = [], 0
    while pos < len(payload):
        pq, tq = payload[pos] >> 4, payload[pos] & 15
        if pq != 0 or tq > 3 or pos + 65 > len(payload) or 0 in payload[pos + 1:pos + 65] or _table_spells_text(payload[pos + 1:pos + 65]):
            _bad()
        ids.append(tq)
        pos += 65
    if not ids or pos != len(payload):
        _bad()
    return ids


def _parse_dht(payload):
    tables, pos = [], 0
    while pos < len(payload):
        tc, th = payload[pos] >> 4, payload[pos] & 15
        if tc > 1 or th > 3 or pos + 17 > len(payload):
            _bad()
        counts = payload[pos + 1:pos + 17]
        n = sum(counts)
        symbols = payload[pos + 17:pos + 17 + n]
        if n == 0 or n > 256 or len(symbols) != n or len(set(symbols)) != n or sum(c << (15 - i) for i, c in enumerate(counts)) > 0xFFFF:
            _bad()  # no symbols, more than 256, a repeated symbol, or a set of codes that overfills (or uses the all-ones code)
        if tc == 0 and max(symbols) > 11 or tc == 1 and any((v & 15) > 10 for v in symbols):
            _bad()
        tables.append((tc, th, bytes(counts), bytes(symbols)))
        pos += 17 + n
    if not tables:
        _bad()
    return tables


def _huffman_lut(counts, symbols, entry):
    """A 16-bit lookup table: ``entry(code length, symbol)`` for every 16 bits that start with the code (0 where no valid code starts)."""
    lut, code, k = [0] * 65536, 0, 0
    for length in range(1, 17):
        for _ in range(counts[length - 1]):
            e = entry(length, symbols[k])
            k += 1
            if e:
                lo, hi = code << (16 - length), (code + 1) << (16 - length)
                lut[lo:hi] = [e] * (hi - lo)
            code += 1
        code <<= 1
    return lut


# Entry layouts: the bits consumed (the code and the extra bits after it) in the high half; the low half says what the symbol does.
_EOB = 0x1000
_ZRL = 0x8000


def _e_dc(length, sym):
    return (length + sym) << 16 if sym <= 11 else 0


def _e_seq_ac(length, sym):
    r, s = sym >> 4, sym & 15
    if s:
        return (length + s) << 16 | (r + 1)
    if sym == 0x00:
        return length << 16 | _EOB
    return length << 16 | 16 if sym == 0xF0 else 0


def _e_prog_first(length, sym):
    r, s = sym >> 4, sym & 15
    if s:
        return (length + s) << 16 | (r + 1)
    if sym == 0xF0:
        return length << 16 | _ZRL | 16
    return length << 16 | r << 8 | 0xFF           # an end-of-band run of 2**r blocks, r more bits follow


def _e_prog_refine(length, sym):
    r, s = sym >> 4, sym & 15
    if s > 1:
        return 0
    if s:
        return (length + 1) << 16 | r << 8 | 1      # a new coefficient, its sign bit follows
    return length << 16 | r << 8 | (2 if r == 15 else 3)   # sixteen zeros, or an end-of-band run


def _end_of_bits(chunk, real_bits, consumed):
    """True when what is left of ``chunk`` after ``consumed`` bits is fewer than eight bits, all ones (the padding)."""
    left = real_bits - consumed
    if left < 0 or left > 7:
        return False
    return not left or (chunk[real_bits // 8 - 1] & ((1 << left) - 1)) == (1 << left) - 1


def _dec_sequential(chunk, nmcu, sched):
    """One restart interval of a sequential scan: ``nmcu`` MCUs, each the blocks of ``sched`` ([(DC table, AC table)]). True when the data is
    exactly those MCUs and the padding."""
    real = len(chunk) * 8
    data = chunk + bytes(16)
    rb = len(chunk) + 4
    fb = int.from_bytes
    acc = nb = ip = 0
    for _ in range(nmcu):
        for dc, ac in sched:
            if nb < 32:
                if ip > rb:
                    return False
                acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | fb(data[ip:ip + 4], "big"), nb + 32, ip + 4
            e = dc[(acc >> (nb - 16)) & 0xFFFF]
            if not e:
                return False
            nb -= e >> 16
            k = 1
            while k < 64:
                if nb < 32:
                    if ip > rb:
                        return False
                    acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | fb(data[ip:ip + 4], "big"), nb + 32, ip + 4
                e = ac[(acc >> (nb - 16)) & 0xFFFF]
                if not e:
                    return False
                nb -= e >> 16
                k += e & 0xFFFF
            if 64 < k < _EOB:
                return False
    return _end_of_bits(data, real, ip * 8 - nb)


def _dec_dc_first(chunk, nblocks, sched):
    real = len(chunk) * 8
    data = chunk + bytes(16)
    rb = len(chunk) + 4
    fb = int.from_bytes
    acc = nb = ip = 0
    for _ in range(nblocks):
        for dc in sched:
            if nb < 32:
                if ip > rb:
                    return False
                acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | fb(data[ip:ip + 4], "big"), nb + 32, ip + 4
            e = dc[(acc >> (nb - 16)) & 0xFFFF]
            if not e:
                return False
            nb -= e >> 16
    return _end_of_bits(data, real, ip * 8 - nb)


def _more(data, acc, nb, ip, need):
    """The bit buffer refilled until it holds ``need`` bits."""
    while nb < need and ip <= len(data):
        acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | int.from_bytes(data[ip:ip + 4], "big"), nb + 32, ip + 4
    return acc, nb, ip


def _dec_ac_first(chunk, nblocks, lut, ss, se, nz, first):
    """One interval of a progressive AC scan, first pass: ``nblocks`` blocks from block ``first``. ``nz`` keeps, per block, which coefficients are
    nonzero (a later refinement scan reads correction bits for them)."""
    real = len(chunk) * 8
    data = chunk + bytes(16)
    rb = len(chunk) + 4
    fb = int.from_bytes
    acc = nb = ip = 0
    eobrun = 0
    bi, end = first, first + nblocks
    while bi < end:
        if eobrun:
            take = min(eobrun, end - bi)        # the blocks an end-of-band run covers carry no data
            eobrun -= take
            bi += take
            continue
        k = ss
        mask = nz[bi]
        while k <= se:
            if nb < 32:
                if ip > rb:
                    return False
                acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | fb(data[ip:ip + 4], "big"), nb + 32, ip + 4
            e = lut[(acc >> (nb - 16)) & 0xFFFF]
            if not e:
                return False
            nb -= e >> 16
            low = e & 0xFFFF
            if low & 0xFF == 0xFF:
                r = (low >> 8) & 15
                eobrun = (1 << r) - 1
                if r:
                    eobrun += (acc >> (nb - r)) & ((1 << r) - 1)
                    nb -= r
                break
            if low & _ZRL:
                k += 16
            else:
                k += low
                if k - 1 > se:
                    return False
                mask |= 1 << (k - 1)
        else:
            if k > se + 1:
                return False
        nz[bi] = mask
        bi += 1
    return eobrun == 0 and _end_of_bits(data, real, ip * 8 - nb)


def _dec_ac_refine(chunk, nblocks, lut, ss, se, nz, first):
    real = len(chunk) * 8
    data = chunk + bytes(16)
    rb = len(chunk) + 4
    fb = int.from_bytes
    acc = nb = ip = 0
    eobrun = 0
    for bi in range(first, first + nblocks):
        k = ss
        mask = nz[bi]
        corrections = 0
        if not eobrun:
            while k <= se:
                if nb < 32:
                    if ip > rb:
                        return False
                    acc, nb, ip = ((acc & ((1 << nb) - 1)) << 32) | fb(data[ip:ip + 4], "big"), nb + 32, ip + 4
                e = lut[(acc >> (nb - 16)) & 0xFFFF]
                if not e:
                    return False
                nb -= e >> 16
                typ, r = e & 3, (e >> 8) & 15
                if typ == 3:
                    eobrun = 1 << r
                    if r:
                        eobrun += (acc >> (nb - r)) & ((1 << r) - 1)
                        nb -= r
                    break
                while k <= se:                  # over the coefficients that are already nonzero, to the (r+1)th zero one
                    if (mask >> k) & 1:
                        corrections += 1
                    else:
                        if r == 0:
                            break
                        r -= 1
                    k += 1
                if typ == 1:
                    if k > se:
                        return False
                    mask |= 1 << k
                k += 1
                if corrections:                 # the correction bits sit before the next symbol
                    acc, nb, ip = _more(data, acc, nb, ip, corrections + 32)
                    nb -= corrections
                    corrections = 0
        if eobrun:
            while k <= se:
                if (mask >> k) & 1:
                    corrections += 1
                k += 1
            if corrections:
                acc, nb, ip = _more(data, acc, nb, ip, corrections + 32)
                nb -= corrections
            eobrun -= 1
        nz[bi] = mask
    return eobrun == 0 and _end_of_bits(data, real, ip * 8 - nb)


def _entropy_chunks(entropy):
    """The restart intervals of one scan's entropy-coded bytes, unstuffed; ``None`` when an 0xFF is anything but stuffing or a restart marker, or the
    restart markers are not in sequence."""
    pieces = re.split(rb"\xff([\xd0-\xd7])", entropy)
    chunks = pieces[0::2]
    if [p[0] for p in pieces[1::2]] != [0xD0 + (i % 8) for i in range(len(chunks) - 1)]:
        return None
    out = []
    for chunk in chunks:
        if b"\xff" in chunk.replace(b"\xff\x00", b""):
            return None
        out.append(chunk.replace(b"\xff\x00", b"\xff"))
    return out


def _validate_jpeg(parts):
    """Walks the segments of a JPEG (``_jpeg_parts``) and the entropy-coded data of every scan; raises ``_Refuse(STRUCTURE)`` for anything it cannot
    account for. See the comment above."""
    frame, scans, restart = None, 0, 0
    qdef, hdef, hluts, nz, coverage = {}, {}, {}, {}, {}
    for index, (marker, payload) in enumerate(parts):
        if marker is None:
            continue
        budget().take("parts")
        if marker in (0xC0, 0xC1, 0xC2):
            if frame is not None:
                _bad()
            frame = _parse_sof(marker, payload)
        elif marker == 0xDB:
            for tq in _parse_dqt(payload):
                if qdef.get(tq) is False:
                    _bad()          # a table replaced before anything used it
                qdef[tq] = False
        elif marker == 0xC4:
            for tc, th, counts, symbols in _parse_dht(payload):
                if hdef.get((tc, th), (None, True))[1] is False:
                    _bad()
                hdef[(tc, th)] = ((counts, symbols), False)
                for key in [k for k in hluts if k[:2] == (tc, th)]:
                    del hluts[key]
        elif marker == 0xDD:
            if len(payload) != 2:
                _bad()
            restart = struct.unpack(">H", payload)[0]
        elif marker == 0xDA:
            if frame is None or index + 1 >= len(parts) or parts[index + 1][0] is not None:
                _bad()
            _validate_scan(frame, payload, parts[index + 1][1], restart, qdef, hdef, hluts, nz, coverage)
            scans += 1
        elif marker in _STRUCTURAL:
            _bad()   # DAC, DHP, EXP, DNL, any other frame type: not accounted for
    if frame is None or not scans or any(v is False for v in qdef.values()) or any(v[1] is False for v in hdef.values()):
        _bad()
    cids = [c[0] for c in frame["comps"]]
    if frame["progressive"]:
        if any(coverage.get((cid, "dc")) != 1 for cid in cids):
            _bad()
    elif any(coverage.get(cid) != 1 for cid in cids):
        _bad()


def _validate_scan(frame, payload, entropy, restart, qdef, hdef, hluts, nz, coverage):
    ns = payload[0] if payload else 0
    if not 1 <= ns <= len(frame["comps"]) or len(payload) != 4 + 2 * ns:
        _bad()
    ss, se, ahl = payload[1 + 2 * ns], payload[2 + 2 * ns], payload[3 + 2 * ns]
    ah, al = ahl >> 4, ahl & 15
    by_id = {c[0]: c for c in frame["comps"]}
    comps = []
    for i in range(ns):
        cs, tdta = payload[1 + 2 * i], payload[2 + 2 * i]
        if cs not in by_id or cs in [c[0][0] for c in comps] or tdta >> 4 > 3 or tdta & 15 > 3:
            _bad()
        comps.append((by_id[cs], tdta >> 4, tdta & 15))
    if frame["progressive"]:
        if ss == 0:
            ok = se == 0 and (ah == 0 or ah == al + 1) and al <= 13
        else:
            ok = ns == 1 and 1 <= ss <= se <= 63 and (ah == 0 or ah == al + 1) and al <= 13
        kind = "dc" if ss == 0 else "ac"
    else:
        ok = (ss, se, ah, al) == (0, 63, 0, 0)
        kind = "seq"
    if not ok:
        _bad()
    hmax, vmax, width, height = frame["hmax"], frame["vmax"], frame["width"], frame["height"]
    if ns > 1:
        if sum(c[0][1] * c[0][2] for c in comps) > 10:
            _bad()
        nmcu = _ceil(width, 8 * hmax) * _ceil(height, 8 * vmax)
        sched_blocks = [c for c in comps for _ in range(c[0][1] * c[0][2])]
    else:
        (_cid, h, v, _tq), _td, _ta = comps[0]
        nmcu = _ceil(_ceil(width * h, hmax), 8) * _ceil(_ceil(height * v, vmax), 8)
        sched_blocks = [comps[0]]
    for (_cid, _h, _v, tq), _td, _ta in comps:
        if tq not in qdef:
            _bad()
        qdef[tq] = True
    need_dc = kind == "seq" or (kind == "dc" and ah == 0)
    need_ac = kind == "seq" or kind == "ac"
    luts = {}
    for (_c, _h, _v, _tq), td, ta in comps:
        for need, tc, th in ((need_dc, 0, td), (need_ac, 1, ta)):
            if not need:
                continue
            if (tc, th) not in hdef:
                _bad()
            (counts, symbols), _used = hdef[(tc, th)]
            hdef[(tc, th)] = ((counts, symbols), True)
            flavour = 0 if tc == 0 else (1 if kind == "seq" else (2 if ah == 0 else 3))
            key = (tc, th, flavour)
            if key not in hluts:
                hluts[key] = _huffman_lut(counts, symbols, (_e_dc, _e_seq_ac, _e_prog_first, _e_prog_refine)[flavour])
            luts[(tc, th)] = hluts[key]
    budget().take("scan", len(entropy))
    budget().take("blocks", nmcu * len(sched_blocks))
    chunks = _entropy_chunks(entropy)
    per = restart or nmcu
    if chunks is None or len(chunks) != _ceil(nmcu, per):
        _bad()
    done = 0
    for chunk in chunks:
        n = min(per, nmcu - done)
        if kind == "seq":
            ok = _dec_sequential(chunk, n, [(luts[(0, td)], luts[(1, ta)]) for (_c, td, ta) in sched_blocks])
        elif kind == "dc" and ah == 0:
            ok = _dec_dc_first(chunk, n, [luts[(0, td)] for (_c, td, _ta) in sched_blocks])
        elif kind == "dc":
            ok = _end_of_bits(chunk, len(chunk) * 8, n * len(sched_blocks))
        else:
            (cid, h, v, _tq), _td, ta = comps[0]
            if cid not in nz:
                nz[cid] = array.array("Q", bytes(8 * _ceil(_ceil(width * h, hmax), 8) * _ceil(_ceil(height * v, vmax), 8)))
            ok = (_dec_ac_first if ah == 0 else _dec_ac_refine)(chunk, n, luts[(1, ta)], ss, se, nz[cid], done)
        if not ok:
            _bad()
        done += n
    for (cid, _h, _v, _tq), _td, _ta in comps:
        if kind == "seq":
            coverage[cid] = coverage.get(cid, 0) + 1
        elif kind == "dc" and ah == 0:
            coverage[(cid, "dc")] = coverage.get((cid, "dc"), 0) + 1


# ----------------------------------------------------------------------------------------------------------- the picture side of a PNG

_PNG_DEPTHS = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
_PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
_ADAM7 = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
_PNG_SINGLE = frozenset([b"PLTE", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"bKGD", b"pHYs", b"iCCP"])
_PNG_BEFORE_PLTE = frozenset([b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"iCCP"])
_SBIT_LEN = {0: 1, 2: 3, 3: 3, 4: 2, 6: 4}


def _png_row_groups(width, height, depth, ctype, interlace):
    """[(number of scanlines, length of each with its filter byte, unused bits at the end of each)] of the decompressed data: one group, or one
    per non-empty Adam7 pass."""
    bits = depth * _PNG_CHANNELS[ctype]
    if not interlace:
        return [(height, 1 + _ceil(width * bits, 8), -width * bits % 8)]
    out = []
    for xo, yo, dx, dy in _ADAM7:
        pw = _ceil(width - xo, dx) if width > xo else 0
        ph = _ceil(height - yo, dy) if height > yo else 0
        if pw and ph:
            out.append((ph, 1 + _ceil(pw * bits, 8), -pw * bits % 8))
    return out


def _png_row_starts(groups):
    pos = 0
    for rows, length, _pad in groups:
        for _ in range(rows):
            yield pos
            pos += length


def _png_check_idat(blob, width, height, depth, ctype, interlace):
    """The picture data must be one complete zlib stream that inflates to exactly the scanlines the header says (each starting with a filter byte of
    0 to 4) and ends at the last byte of the last IDAT: no byte after the stream, no data in an IDAT that the stream does not use."""
    groups = _png_row_groups(width, height, depth, ctype, interlace)
    expected = sum(rows * length for rows, length, _pad in groups)
    budget().take("scan", expected)
    budget().take("blocks", sum(rows for rows, _length, _pad in groups))
    padded = depth < 8 and any(pad for _rows, _length, pad in groups)      # unused bits at the end of a row of 1, 2 or 4 bit pixels
    kept = bytearray() if padded else None
    it = _png_row_starts(groups)
    next_start = next(it, expected + 1)
    d, total, pos = zlib.decompressobj(), 0, 0
    try:
        while pos < len(blob) and not d.eof:
            pending = blob[pos:pos + 65536]
            pos += len(pending)
            while pending:
                out = d.decompress(pending, 1 << 20)
                pending = d.unconsumed_tail
                if padded:
                    kept += out
                base = total
                total += len(out)
                if total > expected:
                    _bad()
                while next_start < total:
                    if out[next_start - base] > 4:
                        _bad()
                    next_start = next(it, expected + 1)
                if d.eof:
                    break
    except zlib.error:
        _bad()
    if not d.eof or d.unused_data or pos < len(blob) or total != expected:
        _bad()
    if padded:
        _png_padding_zero(kept, groups)


def _png_padding_zero(data, groups):
    """The unused bits at the end of every row of a 1, 2 or 4 bit image must be zero in the rows as they are rebuilt (after the filter is
    undone): they are no pixel, and 7 bits per row would carry a payload. Only the last byte of a row matters; a row is rebuilt from the one before."""
    pos = 0
    for rows, length, pad in groups:
        prior, mask = bytes(length - 1), (1 << pad) - 1
        for _ in range(rows):
            ftype, row = data[pos], data[pos + 1:pos + length]
            pos += length
            if ftype == 0 or not pad:
                cur = row
            elif ftype == 1:
                cur = bytes(itertools.accumulate(row, lambda a, b: (a + b) & 255))
            elif ftype == 2:
                cur = bytes((a + b) & 255 for a, b in zip(row, prior))
            else:
                cur, left, corner = bytearray(row), 0, 0
                for i, up in enumerate(prior):
                    if ftype == 3:
                        guess = (left + up) >> 1
                    else:
                        base = left + up - corner
                        da, db, dc = abs(base - left), abs(base - up), abs(base - corner)
                        guess = left if da <= db and da <= dc else (up if db <= dc else corner)
                    left = cur[i] = (cur[i] + guess) & 255
                    corner = up
            if pad and cur[-1] & mask:
                _bad()
            prior = cur


def _png_values(kind, body, depth, ctype, plte_entries):
    """The values of a chunk that is copied must be ones the specification allows, in sane ranges."""
    top = 1 << depth
    if kind == b"PLTE":
        if ctype != 3 or len(body) % 3 or not 3 <= len(body) <= 768 or len(body) // 3 > top:
            _bad()          # a palette belongs to a palette image; a "suggested palette" on any other is a carrier and not needed
    elif kind == b"tRNS":
        if ctype == 0:
            ok = len(body) == 2 and struct.unpack(">H", body)[0] < top
        elif ctype == 2:
            ok = len(body) == 6 and all(v < top for v in struct.unpack(">3H", body))
        elif ctype == 3:
            ok = 1 <= len(body) <= plte_entries
        else:
            ok = False
        if not ok:
            _bad()
    elif kind == b"gAMA":
        if len(body) != 4 or not 1 <= struct.unpack(">I", body)[0] <= 1000000:
            _bad()
    elif kind == b"cHRM":
        if len(body) != 32 or max(struct.unpack(">8I", body)) > 200000:
            _bad()
    elif kind == b"sRGB":
        if len(body) != 1 or body[0] > 3:
            _bad()
    elif kind == b"sBIT":
        if len(body) != _SBIT_LEN[ctype] or not all(1 <= v <= (8 if ctype == 3 else depth) for v in body):
            _bad()
    elif kind == b"bKGD":
        if ctype == 3:
            ok = len(body) == 1 and body[0] < plte_entries
        elif ctype in (0, 4):
            ok = len(body) == 2 and struct.unpack(">H", body)[0] < top
        else:
            ok = len(body) == 6 and all(v < top for v in struct.unpack(">3H", body))
        if not ok:
            _bad()
    elif kind == b"pHYs":
        if len(body) != 9:
            _bad()
        x, y, unit = struct.unpack(">IIB", body)
        if not (1 <= x <= 10000000 and 1 <= y <= 10000000 and unit <= 1):
            _bad()


def _validate_png(chunks):
    """The header, the order of the chunks, the values of those that are copied, and the picture data to its real end (see ``_png_check_idat``)."""
    try:
        width, height, depth, ctype, comp, filt, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
    except struct.error:
        _bad()
    if not (1 <= width <= 0x7FFFFFFF and 1 <= height <= 0x7FFFFFFF) or depth not in _PNG_DEPTHS.get(ctype, ()) or comp or filt or interlace > 1:
        _bad()
    seen, idat, state, entries = set(), [], "before", None
    for kind, body, _crc in chunks[1:]:
        if kind == b"IDAT":
            if state == "after":
                _bad()
            state = "in"
            idat.append(body)
            continue
        if state == "in":
            state = "after"
        if kind == b"IEND":
            continue
        if kind in _PNG_SINGLE:
            if kind in seen or state != "before":
                _bad()
            seen.add(kind)
            if kind == b"PLTE":
                if {b"bKGD", b"tRNS"} & seen:
                    _bad()
                entries = len(body) // 3
            elif kind in _PNG_BEFORE_PLTE and b"PLTE" in seen:
                _bad()
            elif kind in (b"bKGD", b"tRNS") and ctype == 3 and b"PLTE" not in seen:
                _bad()
            if kind == b"iCCP":
                _png_icc(body)
            else:
                _png_values(kind, body, depth, ctype, entries)
    if not idat or (ctype == 3 and b"PLTE" not in seen) or (b"iCCP" in seen and b"sRGB" in seen):
        _bad()
    _png_check_idat(b"".join(idat), width, height, depth, ctype, interlace)


# ------------------------------------------------------------------------------------------------------------ the minimal copy

_ICC_MAX = 4 * 1024 * 1024
_ICC_TAG_MAX = 1024 * 1024
_ICC_LUT = (b"mft1", b"mft2", b"mAB ", b"mBA ")
_ICC_TEXT_TYPES = (b"desc", b"mluc")
_ICC_TECH = frozenset([b"fscn", b"dcam", b"rscn", b"ijet", b"twax", b"epho", b"esta", b"dsub", b"rpho", b"fprn", b"vidm", b"vidc", b"pjtv", b"CRT ",
                       b"PMD ", b"AMD ", b"KPCD", b"imgs", b"grav", b"offs", b"silk", b"flex"])    # the technology signatures of the ICC specification
_ICC_NAME = b"Profile"                 # what every description of a kept profile says
_ICC_COPYRIGHT = b"No copyright"       # and its copyright
_PNG_ICC_NAME = b"ICC Profile"         # the keyword of the iCCP chunk of a copy
_D50 = struct.pack(">iii", 63190, 65536, 54061)
_ICC_TAGS = {
    b"A2B0": _ICC_LUT, b"A2B1": _ICC_LUT, b"A2B2": _ICC_LUT, b"B2A0": _ICC_LUT, b"B2A1": _ICC_LUT, b"B2A2": _ICC_LUT, b"gamt": _ICC_LUT,
    b"pre0": _ICC_LUT, b"pre1": _ICC_LUT, b"pre2": _ICC_LUT,
    b"rXYZ": (b"XYZ ",), b"gXYZ": (b"XYZ ",), b"bXYZ": (b"XYZ ",), b"wtpt": (b"XYZ ",), b"bkpt": (b"XYZ ",), b"lumi": (b"XYZ ",),
    b"rTRC": (b"curv", b"para"), b"gTRC": (b"curv", b"para"), b"bTRC": (b"curv", b"para"), b"kTRC": (b"curv", b"para"),
    b"chad": (b"sf32",), b"chrm": (b"chrm",), b"cicp": (b"cicp",), b"meas": (b"meas",), b"view": (b"view",), b"tech": (b"sig ",), b"calt": (b"dtim",),
    b"cprt": (b"text", b"mluc"), b"dscm": (b"mluc",), b"desc": _ICC_TEXT_TYPES, b"dmnd": _ICC_TEXT_TYPES, b"dmdd": _ICC_TEXT_TYPES, b"vued": _ICC_TEXT_TYPES,
}
_ICC_CLASSES = (b"scnr", b"mntr", b"prtr", b"link", b"spac", b"abst", b"nmcl")
_ICC_SPACES = (b"XYZ ", b"Lab ", b"Luv ", b"YCbr", b"Yxy ", b"RGB ", b"GRAY", b"HSV ", b"HLS ", b"CMYK", b"CMY ")
_SIG_CHARS = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ")
_PNG_FIXED = {b"IHDR": (13,), b"gAMA": (4,), b"cHRM": (32,), b"sRGB": (1,), b"pHYs": (9,), b"IEND": (0,)}
_PNG_COPIED = frozenset([b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"bKGD", b"pHYs"])
_PNG_ANIMATION = frozenset([b"acTL", b"fcTL", b"fdAT"])


def _seg(marker, payload):
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def _icc_zero(data):
    if data.strip(b"\x00"):
        raise _Refuse(ICC)


def _icc_tag_text(data):
    """A text tag (``text``, ``desc``, ``mluc``) is followed only far enough to know it is one: its words are NEVER kept, ``_rewrite_icc`` writes
    a fixed neutral string in its place, so nothing in it (a name, a number, spaced digits, words, gap bytes) reaches the copy."""
    typ = data[:4]
    if typ == b"desc":
        count = struct.unpack_from(">I", data, 8)[0] if len(data) >= 12 else 1 << 30
        if 12 + count > len(data):
            raise _Refuse(ICC)
    elif typ == b"mluc":
        n, size = struct.unpack_from(">II", data, 8) if len(data) >= 16 else (1 << 30, 0)
        if size != 12 or n > 64 or 16 + 12 * n > len(data):
            raise _Refuse(ICC)
        for i in range(n):
            length, off = struct.unpack_from(">II", data, 20 + 12 * i)
            if length % 2 or off < 16 + 12 * n or off + length > len(data):
                raise _Refuse(ICC)


def _icc_unaccounted(data, used):
    """Every byte of ``data`` that is in none of the ``used`` ranges must be zero."""
    cursor = 0
    for lo, hi in sorted(used):
        if lo > cursor:
            _icc_zero(data[cursor:lo])
        cursor = max(cursor, hi)
    _icc_zero(data[cursor:])


def _ibad():
    raise _Refuse(ICC)


def _s15(data, off, limit=8.0):
    value = struct.unpack_from(">i", data, off)[0]
    if abs(value) > limit * 65536:
        _ibad()
    return value


def _sig4(four):
    if four != bytes(4) and not all(c in _SIG_CHARS for c in four):
        _ibad()


def _icc_date(data, off):
    year, month, day, hour, minute, second = struct.unpack_from(">6H", data, off)
    if (year, month, day, hour, minute, second) != (0,) * 6 and not (1900 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31 and hour < 24
                                                                    and minute < 60 and second < 61):
        _ibad()


def _icc_header(p):
    if struct.unpack_from(">I", p, 0)[0] != len(p) or p[36:40] != b"acsp":
        _ibad()
    _sig4(p[4:8])
    if p[8] not in (2, 4) or p[9] >> 4 > 9 or p[9] & 15 > 9 or p[10:12] != bytes(2):
        _ibad()
    if p[12:16] not in _ICC_CLASSES or p[16:20] not in _ICC_SPACES or p[20:24] not in (b"XYZ ", b"Lab "):
        _ibad()
    _icc_date(p, 24)
    _sig4(p[40:44])
    if p[44:46] != bytes(2) or p[56:63] != bytes(7) or p[63] > 15 or struct.unpack_from(">I", p, 64)[0] > 3:
        _ibad()
    _sig4(p[48:52])
    _sig4(p[52:56])
    for off, want in ((68, 63190), (72, 65536), (76, 54061)):          # the illuminant is D50
        if abs(struct.unpack_from(">i", p, off)[0] - want) > 3000:
            _ibad()
    _sig4(p[80:84])
    if p[84:100] != bytes(16):
        zeroed = bytearray(p)
        zeroed[44:48] = bytes(4)
        zeroed[64:68] = bytes(4)
        zeroed[84:100] = bytes(16)
        if hashlib.md5(bytes(zeroed)).digest() != p[84:100]:
            _ibad()                    # a profile ID is the MD5 of the profile, or zero
    if p[100:128] != bytes(28):
        _ibad()


def _icc_xyz(data, limit=3.0):
    if len(data) != 20:
        _ibad()
    for off in (8, 12, 16):
        _s15(data, off, limit)


def _icc_curv_len(data, off=0):
    n = struct.unpack_from(">I", data, off + 8)[0]
    if n > 4096:
        _ibad()
    return 12 + 2 * n, n


def _icc_curve(data, off=0):
    """Checks a 'curv' or 'para' element at ``off`` and returns its length."""
    typ = data[off:off + 4]
    if data[off + 4:off + 8] != bytes(4):
        _ibad()
    if typ == b"curv":
        length, n = _icc_curv_len(data, off)
        if off + length > len(data):
            _ibad()
        if n == 1 and struct.unpack_from(">H", data, off + 12)[0] > 0x0A00:
            _ibad()                    # a gamma above 10
        if n > 1:
            values = struct.unpack_from(">%dH" % n, data, off + 12)
            if not (all(a <= b for a, b in zip(values, values[1:])) or all(a >= b for a, b in zip(values, values[1:]))):
                _ibad()                # a transfer curve is monotone; bytes that are not a curve do not make one
        return length
    if typ == b"para":
        ftype, reserved = struct.unpack_from(">HH", data, off + 8)
        if ftype > 4 or reserved:
            _ibad()
        length = 12 + 4 * (1, 3, 4, 5, 7)[ftype]
        if off + length > len(data):
            _ibad()
        for i in range((length - 12) // 4):
            _s15(data, off + 12 + 4 * i)
        return length
    _ibad()


def _icc_pad_zero(data, end):
    if len(data) - end > 3 or data[end:].strip(b"\x00"):
        _ibad()


def _icc_clut(data, off, nin, nout):
    """A multi-dimensional table of an 'mAB ' / 'mBA ' element at ``off``; returns its length."""
    grid = data[off:off + 16]
    prec = data[off + 16]
    if len(grid) != 16 or prec not in (1, 2) or data[off + 17:off + 20] != bytes(3) or grid[nin:].strip(b"\x00"):
        _ibad()
    size = 1
    for g in grid[:nin]:
        if not 2 <= g <= 64:
            _ibad()
        size *= g
    length = 20 + size * nout * prec
    if length > _ICC_TAG_MAX or off + length > len(data):
        _ibad()
    return length


def _icc_lut(data):
    typ = data[:4]
    nin, nout = data[8], data[9]
    if not (1 <= nin <= 4 and 1 <= nout <= 4):
        _ibad()
    if typ in (b"mft1", b"mft2"):
        grid = data[10]
        if not 2 <= grid <= 64 or data[11]:
            _ibad()
        for i in range(9):
            _s15(data, 12 + 4 * i)
        if typ == b"mft1":
            size = 48 + 256 * nin + grid ** nin * nout + 256 * nout
        else:
            n, m = struct.unpack_from(">HH", data, 48)
            if not (2 <= n <= 4096 and 2 <= m <= 4096):
                _ibad()
            size = 52 + 2 * nin * n + 2 * grid ** nin * nout + 2 * nout * m
        if size > _ICC_TAG_MAX or len(data) < size:
            _ibad()
        _icc_pad_zero(data, size)
        return
    if data[10:12] != bytes(2):
        _ibad()
    offsets = struct.unpack_from(">5I", data, 12)       # B curves, matrix, M curves, CLUT, A curves
    counts = (nout, 0, nout, 0, nin) if typ == b"mAB " else (nin, 0, nin, 0, nout)
    used = [(0, 32)]
    for which, off in enumerate(offsets):
        if not off:
            continue
        if off < 32 or off % 4 or off >= len(data):
            _ibad()
        if which == 1:
            for i in range(12):
                _s15(data, off + 4 * i)
            used.append((off, off + 48))
        elif which == 3:
            used.append((off, off + _icc_clut(data, off, nin, nout)))
        else:
            pos = off
            for _ in range(counts[which]):
                length = _icc_curve(data, pos)
                pos += length + (-length) % 4
            used.append((off, pos))
    _icc_unaccounted(data, used)


def _icc_tag(sig, data):
    typ = data[:4]
    if typ not in _ICC_TAGS[sig] or data[4:8] != bytes(4) or len(data) > _ICC_TAG_MAX:
        _ibad()
    if typ in (b"text", b"desc", b"mluc"):
        _icc_tag_text(data)
    elif typ == b"XYZ ":
        _icc_xyz(data, 1000.0 if sig == b"lumi" else 3.0)   # the luminance tag is in cd/m2
    elif typ in (b"curv", b"para"):
        _icc_pad_zero(data, _icc_curve(data))
    elif typ == b"sf32":
        if len(data) != 44:
            _ibad()
        for i in range(9):
            _s15(data, 8 + 4 * i)
    elif typ == b"chrm":
        n, colorant = struct.unpack_from(">HH", data, 8)
        if n > 4 or colorant > 4 or len(data) != 12 + 8 * n:
            _ibad()
        for i in range(2 * n):
            _s15(data, 12 + 4 * i, 2.0)
    elif typ == b"cicp":
        if len(data) != 12 or max(data[8:12]) > 31:
            _ibad()
    elif typ == b"meas":
        if len(data) != 36 or struct.unpack_from(">I", data, 8)[0] > 2 or struct.unpack_from(">I", data, 24)[0] > 2 \
                or struct.unpack_from(">I", data, 28)[0] > 0x10000 or struct.unpack_from(">I", data, 32)[0] > 8:
            _ibad()
        for off in (12, 16, 20):
            _s15(data, off, 3.0)
    elif typ == b"view":
        if len(data) != 36 or struct.unpack_from(">I", data, 32)[0] > 8:
            _ibad()
        for off in range(8, 32, 4):
            _s15(data, off, 1000.0)
    elif typ == b"sig ":
        if len(data) != 12 or data[8:12] not in _ICC_TECH:
            _ibad()
    elif typ == b"dtim":
        if len(data) != 20:
            _ibad()
        _icc_date(data, 8)
    else:
        _icc_lut(data)


def _check_icc(profile):
    """Accepts an ICC profile only when it is clean as a structure: the header fields have valid values (size, version, class, spaces, date, D50
    illuminant, printable signatures, the profile ID zero or the MD5, reserved bytes zero); the tag table has only standard colour tags, each once,
    4-byte aligned, with a type that belongs to the tag and a size and values that fit the type (numbers in range, monotone curves, tables whose
    sizes add up, short plain texts); tags do not overlap (equal tags may share data); and every byte outside the header, the table and the tags is
    zero. A tag it does not know, a private signature, ui08, vcgt, dict and anything else: ``_Refuse("icc")``."""
    n = len(profile)
    try:
        if n < 132 or n > _ICC_MAX:
            _ibad()
        _icc_header(profile)
        count = struct.unpack_from(">I", profile, 128)[0]
        table_end = 132 + 12 * count
        if not 1 <= count <= 64 or table_end > n:
            _ibad()
        seen, ranges = set(), set()
        for i in range(count):
            sig, off, size = struct.unpack_from(">4sII", profile, 132 + 12 * i)
            if sig not in _ICC_TAGS or sig in seen or off % 4 or size < 8 or off < table_end or off + size > n:
                _ibad()
            seen.add(sig)
            _icc_tag(sig, profile[off:off + size])
            ranges.add((off, off + size))
        ordered = sorted(ranges)
        if any(b[0] < a[1] for a, b in zip(ordered, ordered[1:])):
            _ibad()                    # two tags overlap but are not the same
        _icc_unaccounted(profile, [(0, table_end)] + ordered)
    except (struct.error, ValueError, IndexError, UnicodeDecodeError):
        _ibad()


def _icc_text_tag(typ, text):
    """A text tag of the same type as the one it replaces, with the fixed layout of that type and ``text`` (ASCII) as its only words."""
    if typ == b"text":
        return b"text" + bytes(4) + text + b"\x00"
    if typ == b"desc":              # ASCII count and string, empty Unicode part (language 0, count 0), empty ScriptCode part, 67 zero bytes
        return b"desc" + bytes(4) + struct.pack(">I", len(text) + 1) + text + b"\x00" + bytes(4 + 4 + 2 + 1 + 67)
    wide = text.decode("ascii").encode("utf-16-be")
    return b"mluc" + bytes(4) + struct.pack(">II", 1, 12) + b"enUS" + struct.pack(">II", len(wide), 28) + wide      # one record, one language


def _rewrite_icc(profile):
    """The profile as it is sent. ``profile`` has passed ``_check_icc``. Every text-bearing tag (desc, cprt, dmnd, dmdd, vued, dscm; textType,
    textDescriptionType and multiLocalizedUnicode) is written again with a fixed neutral string, in its own type and a fixed layout, and only the
    first language of an mluc survives (and it is en-US); every other tag is carried over byte for byte (data that two tags share stays shared).
    The tag table is laid out again (4-byte aligned, zero padding), the size field is set, the profile ID, the reserved bytes and the
    free-text signatures and the date of the header (preferred CMM, platform, manufacturer, model, creator, creation date) are zeroed, the flags keep only the two bits the
    ICC defines and the illuminant is D50. Nothing of the original's words, header text or padding is in the result, so it reads as the same
    colours and as nothing else; ``_rewrite_icc(_rewrite_icc(p)) == _rewrite_icc(p)``."""
    count = struct.unpack_from(">I", profile, 128)[0]
    table_end = 132 + 12 * count
    entries = [struct.unpack_from(">4sII", profile, 132 + 12 * i) for i in range(count)]
    blobs, shared, refs = [], {}, []         # blobs: (offset in the original, index of the first tag, data)
    for i, (sig, off, size) in enumerate(entries):
        data = profile[off:off + size]
        if data[:4] in (b"text", b"desc", b"mluc"):
            blobs.append((off, i, _icc_text_tag(data[:4], _ICC_COPYRIGHT if sig == b"cprt" else _ICC_NAME)))
            refs.append(len(blobs) - 1)
        else:
            if (off, size) not in shared:
                blobs.append((off, i, data))
                shared[(off, size)] = len(blobs) - 1
            refs.append(shared[(off, size)])
    placed, cursor = {}, table_end
    for j in sorted(range(len(blobs)), key=lambda j: blobs[j][:2]):
        placed[j] = cursor
        cursor += len(blobs[j][2]) + (-len(blobs[j][2])) % 4
    body = bytearray(cursor - table_end)
    for j, at in placed.items():
        body[at - table_end:at - table_end + len(blobs[j][2])] = blobs[j][2]
    table = b"".join(struct.pack(">4sII", sig, placed[refs[i]], len(blobs[refs[i]][2])) for i, (sig, _off, _size) in enumerate(entries))
    head = bytearray(profile[:128])
    head[0:4] = struct.pack(">I", cursor)
    for lo, hi in ((4, 8), (24, 36), (40, 44), (44, 48), (48, 56), (80, 84), (84, 100), (100, 128)):
        head[lo:hi] = bytes(hi - lo)
    head[47] = profile[47] & 3
    head[68:80] = _D50
    return bytes(head) + struct.pack(">I", count) + table + bytes(body)


def _icc_segments(profile):
    """The payloads of the APP2 segments that carry ``profile``, in the order of a JPEG."""
    parts = [profile[i:i + 65519] for i in range(0, len(profile), 65519)]
    return [b"ICC_PROFILE\x00" + bytes([n + 1, len(parts)]) + part for n, part in enumerate(parts)]


def _png_icc_body(profile):
    return _PNG_ICC_NAME + b"\x00\x00" + zlib.compress(profile, 9)


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


def _jfif_ok(payload):
    """A JFIF header of the copy: a known version, units 0 to 2, densities up to 9999, no thumbnail."""
    return (len(payload) == 14 and payload[:5] == b"JFIF\x00" and payload[5:7] in (b"\x01\x00", b"\x01\x01", b"\x01\x02") and payload[7] <= 2
            and max(struct.unpack(">HH", payload[8:12])) <= 9999 and payload[12:] == b"\x00\x00")


def _adobe_ok(payload):
    """An Adobe header: version 100 or 101, the two flag words 0, 0x4000 or 0x8000, a transform of 0, 1 or 2."""
    if len(payload) != 12 or payload[:5] != b"Adobe":
        return False
    version, flags0, flags1, transform = struct.unpack(">HHHB", payload[5:12])
    return version in (100, 101) and flags0 in (0, 0x4000, 0x8000) and flags1 in (0, 0x4000, 0x8000) and transform <= 2


def _build_jpeg(parts):
    _validate_jpeg(parts)
    profile = _icc_of_jpeg(parts)
    out, jfif, exif, adobe = [b"\xff\xd8"], False, False, False
    for marker, payload in parts:
        if marker is None:
            out.append(payload)
        elif marker in _STRUCTURAL:
            out.append(_seg(marker, payload))
        elif marker == 0xE0 and payload[:5] == b"JFIF\x00" and len(payload) >= 14 and not jfif:
            jfif = True
            if not _jfif_ok(payload[:12] + b"\x00\x00"):
                _bad()
            out.append(_seg(0xE0, payload[:12] + b"\x00\x00"))
        elif marker == 0xE1 and payload[:6] == b"Exif\x00\x00" and not exif:
            exif = True
            found = _orientation(payload[6:])
            if found:
                out.append(_seg(0xE1, b"Exif\x00\x00" + _exif_tiff(*found)))
        elif marker == 0xE2 and payload[:12] == b"ICC_PROFILE\x00":
            if profile is not None:          # the profile is written once, where its first segment was, with fixed words
                out.extend(_seg(0xE2, chunk) for chunk in _icc_segments(_rewrite_icc(profile)))
                profile = None
        elif marker == 0xEE and payload[:5] == b"Adobe" and len(payload) >= 12 and not adobe:
            adobe = True
            if not _adobe_ok(payload[:12]):
                _bad()
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
        if marker == 0xE0 and _jfif_ok(payload):
            pass
        elif marker == 0xEE and _adobe_ok(payload):
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
    if profile is not None and (_names_in(profile, _TOKEN_WORDS + _POSITION_WORDS) or _TIFF_SIG.search(profile) or b"\xa9xyz" in profile
                                or _rewrite_icc(profile) != profile or icc_chunks != _icc_segments(profile)):     # the sent profile is the fixed form
        raise _Refuse(VERIFY_FAILED)


def _png_orientation(body):
    return _orientation(body[6:] if body[:6] == b"Exif\x00\x00" else body)


def _png_icc(body):
    k = body.find(b"\x00")
    if k < 1 or k > 79 or body[k + 1:k + 2] != b"\x00":
        raise _Refuse(ICC)
    try:
        profile = _inflate(body[k + 2:])
    except _Refuse as exc:
        raise _Refuse(ICC) if exc.reason == UNPARSEABLE else exc      # a stream that is cut, or with more data after it
    _check_icc(profile)
    return profile


def _png_chunk(kind, body, crc=None):
    crc = crc if crc is not None else struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    return struct.pack(">I", len(body)) + kind + body + crc


def _build_png(chunks):
    _validate_png(chunks)
    out, exif = [_PNG_SIG], False
    for kind, body, crc in chunks:
        if kind in _PNG_ANIMATION:
            raise _Refuse()  # dropping the frames would change the picture
        if kind in _PNG_COPIED:
            if kind in _PNG_FIXED and len(body) not in _PNG_FIXED[kind] or kind == b"PLTE" and (len(body) % 3 or len(body) > 768):
                raise _Refuse()
            out.append(_png_chunk(kind, body, crc))
        elif kind == b"iCCP":
            out.append(_png_chunk(kind, _png_icc_body(_rewrite_icc(_png_icc(body)))))
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
            if (_names_in(profile, _TOKEN_WORDS + _POSITION_WORDS) or _TIFF_SIG.search(profile) or b"\xa9xyz" in profile
                    or _rewrite_icc(profile) != profile or body != _png_icc_body(profile)):         # the sent profile is the fixed form
                raise _Refuse(VERIFY_FAILED)
            meta.append(body[:body.find(b"\x00")])
        else:
            raise _Refuse(VERIFY_FAILED)
    if any(kinds.count(k) > 1 for k in (b"eXIf", b"iCCP")) or not _scan_metadata(b"".join(meta), 1 if b"eXIf" in kinds else 0):
        raise _Refuse(VERIFY_FAILED)
    _scan_picture_side(b"".join(picture))


# ------------------------------------------------------------------------------------------------------------------ the API


def _strip(data, content_type):
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
        return None, exc.reason if exc.reason in (TIFF_KEPT, UNSUPPORTED, VERIFY_FAILED, ICC, STRUCTURE) else UNPARSEABLE
    except ScanLimit:
        return None, LIMIT
    except Exception:  # noqa: BLE001 - a file the walkers cannot take stays held; nothing escapes (never a RecursionError or MemoryError either)
        return None, UNPARSEABLE


_MEMO = collections.OrderedDict()


def strip(data, content_type):
    """``(bytes, "")``: a copy of a JPEG or PNG with minimal metadata (see the module docstring), or ``(None, reason)``; never raises. ``reason``
    is one of ``tiff`` (kept held), ``unsupported``, ``unparseable``, ``verify_failed``, ``icc`` (a colour profile it does not accept),
    ``structure`` (the picture side has a part it cannot account for) and ``limit`` (more work than the budget allows). The answer for the
    same bytes is remembered for a few files (reading the picture data to its end takes seconds for a large photo, and the push asks again)."""
    try:
        key = (hashlib.sha256(bytes(data)).digest(), content_type)
    except (TypeError, ValueError):
        return None, UNSUPPORTED
    if key in _MEMO:
        _MEMO.move_to_end(key)
        return _MEMO[key]
    result = _strip(data, content_type)
    _MEMO[key] = result
    while len(_MEMO) > 6:
        _MEMO.popitem(last=False)
    return result
