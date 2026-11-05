"""Remove the GPS location from a JPEG or PNG without touching the picture (HFY-TSK-374). Pure standard library; Python 3.9 compatible.

The Gramps tree and the file on this Mac are never changed: ``strip`` takes the bytes of a file and returns the bytes of a COPY, and the
caller uploads the copy. The copy differs from the original only inside the metadata that carries a position:

    JPEG   the compressed image data, every segment other than the APP1 ``Exif`` and APP1 XMP ones, and the file's length are byte for
           byte the original's. In the Exif TIFF the GPS pointer (tag 0x8825) is taken out of its IFD (the IFD's entries move up, its
           count drops by one, its next-IFD offset moves with it, the freed 12 bytes are zero), and the GPS IFD with every value it
           points to is overwritten with zero bytes, so no coordinate is left in the file as an unreferenced leftover. Nothing else in
           the TIFF moves, so every other tag keeps its offset and its value, and the segment keeps its length. A thumbnail JPEG
           inside the TIFF (IFD1) is cleaned the same way. In the XMP packet every ``GPS*`` property (any prefix: ``exif:GPSLatitude``,
           ``exifEX:GPS*``, ``drone-dji:GpsLatitude``) is replaced by spaces, so the packet keeps its length and stays well-formed.
    PNG    the same two changes inside the ``eXIf`` chunk and the ``XML:com.adobe.xmp`` iTXt chunk; the chunk CRC is computed again, and
           a compressed XMP text is deflated again (that chunk's length may change). Every other chunk, ``IDAT`` included, is copied.
    TIFF   is not rewritten: the strip returns the reason ``tiff`` and the file stays held.

Fail closed: ``strip`` never raises. It returns ``(None, reason)`` for a file it cannot parse with certainty (a truncated or garbled
segment, an IFD that loops or points outside the data, an unknown value type, a GPS IFD it cannot read, XMP it cannot blank, a
``Raw profile type`` text chunk), and for any copy in which it can still find a location afterwards. Before it returns bytes it
also checks that nothing outside the allowed segments changed and that every other tag of the Exif IFDs has the same type, count and
value bytes as before. ``has_location_residue`` is a second, separately written scan; the caller runs the add-on's own detector too.

Only GPS fields go. A caption, a title or a place NAME in XMP or IPTC (``photoshop:City``, a "Location" text) is not a position and
stays. Nothing here logs, prints or returns a value of the file: the reasons are code words.
"""
import re
import struct
import zlib

JPEG = "image/jpeg"
PNG = "image/png"
TIFF = "image/tiff"

# Reasons (code words). ``None`` never appears: a successful strip returns an empty reason.
TIFF_KEPT = "tiff"
UNSUPPORTED = "unsupported"
UNPARSEABLE = "unparseable"
VERIFY_FAILED = "verify_failed"

_GPS_POINTER = 0x8825
_EXIF_POINTER = 0x8769
_INTEROP_POINTER = 0xA005
_SUB_IFDS = 0x014A
_THUMB_OFFSET, _THUMB_LENGTH = 0x0201, 0x0202
_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}
_LONGS = (4, 13)
_MAX_IFDS = 32
_MAX_ENTRIES = 512
_MAX_DEPTH = 2          # a thumbnail JPEG inside the Exif, and no deeper
_MAX_INFLATED = 4 * 1024 * 1024
_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_XMP_EXT_NS = b"http://ns.adobe.com/xmp/extension/\x00"
_TEXT_MARKERS = (0xE1, 0xEC, 0xED, 0xFE)  # APP1 (Exif, XMP), APP12, APP13 (IPTC) and comments: where a position can be written as text
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_XMP_KEYWORD = b"XML:com.adobe.xmp"

# XMP: a property whose local name starts with "gps", under any prefix, as an attribute or as an element (with whatever it holds).
_NAME = rb"(?:[A-Za-z_][\w.\-]*:)?gps[\w.\-]*"
_XMP_ELEMENT = re.compile(rb"<(" + _NAME + rb")(?:\s[^<>]*)?(?:/>|>.*?</\1\s*>)", re.IGNORECASE | re.DOTALL)
_XMP_ATTRIBUTE = re.compile(rb"(?<=[\s\"'])" + _NAME + rb"\s*=\s*(?:\"[^\"]*\"|'[^']*')", re.IGNORECASE)
# Long names a chance match inside compressed picture data cannot produce (7 or more letters, 2**-56 per position or less).
_LONG_TOKENS = re.compile(rb"GPSLatitude|GPSLongitude|GPSInfo|GPSAltitude|GPSDest|GPSVersionID|exif:GPS|GpsLat|GpsLong", re.IGNORECASE)


class _Refuse(Exception):
    def __init__(self, reason=UNPARSEABLE):
        Exception.__init__(self, reason)
        self.reason = reason


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


def _spaces(match):
    return b" " * len(match.group(0))


def _squash(text):
    """Lower case with NUL bytes taken out, so a UTF-16 packet reads as the letters it spells."""
    return text.replace(b"\x00", b"").lower()


def _blank_xmp(buf, lo, hi):
    """Replaces every GPS property of the XMP text in ``buf[lo:hi]`` with spaces of the same length (the packet stays well-formed)."""
    text = bytes(buf[lo:hi])
    new = _XMP_ATTRIBUTE.sub(_spaces, _XMP_ELEMENT.sub(_spaces, text))
    if len(new) != len(text):
        raise _Refuse()
    if b"gps" in _squash(new):
        raise _Refuse()  # a GPS property this does not know how to blank (a comment, UTF-16, another construct)
    buf[lo:hi] = new


# ------------------------------------------------------------------------------------------------------------------- JPEG


def _strip_jpeg(buf, lo, hi, depth, edits):
    """Walks the segments of the JPEG at ``buf[lo:hi]`` up to its scan and cleans the APP1 Exif and XMP segments in place."""
    if hi - lo < 4 or bytes(buf[lo:lo + 2]) != b"\xff\xd8":
        raise _Refuse()
    pos = lo + 2
    while True:
        if pos + 2 > hi or buf[pos] != 0xFF:
            raise _Refuse()
        marker = buf[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker == 0x00:
            raise _Refuse()
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            pos += 2
            continue
        if marker in (0xD9, 0xDA):
            return  # the end of the image, or the start of the scan: the metadata is behind us
        if pos + 4 > hi:
            raise _Refuse()
        length = struct.unpack_from(">H", buf, pos + 2)[0]
        s, e = pos + 4, pos + 2 + length
        if length < 2 or e > hi:
            raise _Refuse()
        if marker == 0xE1:
            if bytes(buf[s:s + 6]) == b"Exif\x00\x00":
                _strip_tiff(buf, s + 6, e, depth, edits)
                edits.append((s + 6, e))
            elif bytes(buf[s:s + len(_XMP_NS)]) == _XMP_NS:
                _blank_xmp(buf, s + len(_XMP_NS), e)
                edits.append((s + len(_XMP_NS), e))
            elif bytes(buf[s:s + len(_XMP_EXT_NS)]) == _XMP_EXT_NS and b"gps" in _squash(bytes(buf[s:e])):
                raise _Refuse()  # extended XMP is split across segments: not blanked, so a photo that has GPS there stays held
        pos = e


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


def _inflate(blob):
    d = zlib.decompressobj()
    out = d.decompress(blob, _MAX_INFLATED + 1)
    if len(out) > _MAX_INFLATED or not d.eof:
        raise _Refuse()
    return out


def _chunks(data):
    """[(type, data, crc)] of a PNG up to and including IEND, and whatever follows IEND as the last item with the type ``None``."""
    if data[:8] != _PNG_SIG:
        raise _Refuse()
    pos, n, out, seen_end = 8, len(data), [], False
    while pos < n:
        if pos + 12 > n:
            raise _Refuse()
        length, kind = struct.unpack_from(">I4s", data, pos)
        end = pos + 8 + length
        if end + 4 > n:
            raise _Refuse()
        out.append((kind, data[pos + 8:end], data[end:end + 4]))
        pos = end + 4
        if kind == b"IEND":
            seen_end = True
            break
    if not seen_end or not out or out[0][0] != b"IHDR":
        raise _Refuse()
    if pos < n:
        out.append((None, data[pos:], b""))
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


def _png_copy(data):
    pieces = [_PNG_SIG]
    for kind, body, crc in _chunks(data):
        if kind is None:
            pieces.append(body)  # after IEND: copied; the scans below look at it
            continue
        new = body
        if kind == b"eXIf":
            buf = bytearray(body)
            start = 6 if bytes(buf[:6]) == b"Exif\x00\x00" else 0
            _strip_tiff(buf, start, len(buf), 0, [])
            new = bytes(buf)
        elif kind == b"iTXt":
            keyword, flag, method, text_at = _itxt_text_start(body)
            if keyword == _XMP_KEYWORD:
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
        if new is not body and new != body:
            crc = struct.pack(">I", zlib.crc32(kind + new) & 0xFFFFFFFF)
        pieces.append(struct.pack(">I", len(new)) + kind + new + crc)
    return b"".join(pieces)


# ---------------------------------------------------------------------------------------------------- the independent scan


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


def _exif_headers_have_gps(b):
    start = 0
    for _ in range(17):
        at = b.find(b"Exif\x00\x00", start)
        if at < 0:
            return False
        if _has_gps_pointer(b, at + 6, len(b)):
            return True
        start = at + 6
    return True  # more Exif headers than any camera writes


def has_location_residue(data, content_type):
    """True when ``data`` (a JPEG or PNG) still shows any sign of a GPS position, or cannot be examined. The checks, in the file's
    metadata only (never in the compressed picture, where three letters can occur by chance): a GPS pointer in any IFD of any Exif
    header, the letters ``gps`` in any APPn, comment, text or XMP part (also inflated, and also as UTF-16), a text chunk holding a
    raw profile; in the whole file: the long GPS property names and every ``Exif`` header."""
    try:
        if _LONG_TOKENS.search(data) or _exif_headers_have_gps(data):
            return True
        if content_type == JPEG:
            if data[:2] != b"\xff\xd8":
                return True
            pos, n = 2, len(data)
            while pos + 4 <= n:
                if data[pos] != 0xFF:
                    return True
                marker = data[pos + 1]
                if marker == 0xFF:
                    pos += 1
                    continue
                if marker == 0x01 or 0xD0 <= marker <= 0xD8:
                    pos += 2
                    continue
                if marker in (0xD9, 0xDA):
                    return False
                length = struct.unpack_from(">H", data, pos + 2)[0]
                if length < 2 or pos + 2 + length > n:
                    return True
                payload = data[pos + 4:pos + 2 + length]
                if marker in _TEXT_MARKERS and b"gps" in _squash(payload):
                    return True
                if marker == 0xE1 and not payload.startswith((b"Exif\x00\x00", _XMP_NS)) and (b"II*\x00" in payload or b"MM\x00*" in payload):
                    return True  # a TIFF structure in an APP1 that is not announced as Exif: not read by the strip, so not known to be clean
                pos += 2 + length
            return True  # no scan reached
        if content_type == PNG:
            for kind, body, _crc in _chunks(data):
                if kind is None:
                    if b"gps" in _squash(body):
                        return True
                    continue
                if kind == b"IDAT":
                    continue
                text = body
                if kind == b"eXIf" and _has_gps_pointer(body, 6 if body[:6] == b"Exif\x00\x00" else 0, len(body)):
                    return True
                if kind == b"zTXt":
                    k = body.find(b"\x00")
                    text = _inflate(body[k + 2:]) if k >= 0 else body
                elif kind == b"iTXt":
                    keyword, flag, method, at = _itxt_text_start(body)
                    text = _inflate(body[at:]) if flag == 1 else body[at:]
                    if flag == 1 and method != 0:
                        return True
                if b"gps" in _squash(text):
                    return True
                if kind in (b"tEXt", b"zTXt", b"iTXt") and b"raw profile" in _squash(body[:80]):
                    return True
            return False
        return True
    except (_Refuse, struct.error, zlib.error, ValueError, IndexError, TypeError):
        return True


# ------------------------------------------------------------------------------------------------------------------ the API


def strip(data, content_type):
    """``(bytes, "")`` with the GPS location taken out of a JPEG or PNG, or ``(None, reason)``; never raises. ``reason`` is one of
    ``tiff`` (kept held), ``unsupported``, ``unparseable`` and ``verify_failed``."""
    try:
        if content_type == TIFF:
            return None, TIFF_KEPT
        if content_type not in (JPEG, PNG) or not isinstance(data, (bytes, bytearray)):
            return None, UNSUPPORTED
        data = bytes(data)
        out = _jpeg_copy(data) if content_type == JPEG else _png_copy(data)
        if has_location_residue(out, content_type):
            return None, VERIFY_FAILED
        return out, ""
    except _Refuse as exc:
        return None, exc.reason
    except Exception:  # noqa: BLE001 - a file the walkers cannot take stays held; nothing escapes (never a RecursionError or MemoryError either)
        return None, UNPARSEABLE
