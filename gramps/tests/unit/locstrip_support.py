"""Synthetic JPEG, PNG and TIFF builders for the location-strip tests (HFY-TSK-374). Every coordinate, name and date is fabricated.

``build_tiff`` lays out a small Exif TIFF (IFD0 with Make, Orientation and DateTime, an Exif IFD with DateTimeOriginal and a MakerNote, a GPS
IFD with a version, latitude and longitude with their out-of-line rationals, an altitude and a processing method, and optionally an IFD1
with a thumbnail JPEG) in either byte order. ``jpeg`` and ``png`` wrap it with XMP and a stand-in for the picture data. Standard library only.
"""
import base64
import struct
import zlib

# Fabricated position: 37 33 42.42 and 122 4 51.51. The packed rationals are what the leftover search looks for.
LAT = ((37, 1), (33, 1), (4242, 100))
LON = ((122, 1), (4, 1), (5151, 100))
MAKE = b"SYNTHCAM"
DATE = b"2001:02:03 04:05:06"
MAKER_NOTE = b"SYNTHMAKERNOTE0"
JFIF = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"


def rational_bytes(order, triple):
    return b"".join(struct.pack(order + "II", n, d) for n, d in triple)


def _entry(order, tag, typ, count, payload):
    return (tag, typ, count, payload)


def asc(order, tag, text):
    data = text + b"\x00"
    return (tag, 2, len(data), data)


def short(order, tag, value):
    return (tag, 3, 1, struct.pack(order + "H", value) + b"\x00\x00")


def ref(tag, kind, name):
    return (tag, 4, 1, (kind, name))


def assemble(order, ifds, blobs):
    """ifds: [(name, [(tag, type, count, payload)], next name or None)] in layout order; a payload is bytes or (kind, name) with kind
    ``ifd``, ``blob`` or ``bloblen``. The first IFD is IFD0. Returns the TIFF bytes."""
    pos = 8
    ifd_at = {}
    for name, entries, _nxt in ifds:
        ifd_at[name] = pos
        pos += 2 + 12 * len(entries) + 4
    data_at = {}
    for name, entries, _nxt in ifds:
        for i, (_tag, _typ, _count, payload) in enumerate(entries):
            if isinstance(payload, bytes) and len(payload) > 4:
                data_at[(name, i)] = pos
                pos += len(payload) + (len(payload) & 1)
    blob_at = {}
    for name, blob in blobs.items():
        blob_at[name] = pos
        pos += len(blob) + (len(blob) & 1)
    out = bytearray((b"II*\x00" if order == "<" else b"MM\x00*") + struct.pack(order + "I", ifd_at[ifds[0][0]]))
    out.extend(bytes(pos - len(out)))
    for name, entries, nxt in ifds:
        at = ifd_at[name]
        struct.pack_into(order + "H", out, at, len(entries))
        for i, (tag, typ, count, payload) in enumerate(entries):
            base = at + 2 + 12 * i
            if isinstance(payload, tuple):
                kind, target = payload
                value = {"ifd": ifd_at, "blob": blob_at}[kind][target] if kind != "bloblen" else len(blobs[target])
                field = struct.pack(order + "I", value)
            elif len(payload) > 4:
                field = struct.pack(order + "I", data_at[(name, i)])
                out[data_at[(name, i)]:data_at[(name, i)] + len(payload)] = payload
            else:
                field = payload.ljust(4, b"\x00")
            struct.pack_into(order + "HHI", out, base, tag, typ, count)
            out[base + 8:base + 12] = field
        struct.pack_into(order + "I", out, at + 2 + 12 * len(entries), ifd_at[nxt] if nxt else 0)
    for name, blob in blobs.items():
        out[blob_at[name]:blob_at[name] + len(blob)] = blob
    return bytes(out)


def gps_entries(order):
    return [(0x0000, 1, 4, b"\x02\x03\x00\x00"), (0x0001, 2, 2, b"N\x00"), (0x0002, 5, 3, rational_bytes(order, LAT)),
            (0x0003, 2, 2, b"W\x00"), (0x0004, 5, 3, rational_bytes(order, LON)), (0x0006, 5, 1, rational_bytes(order, [(1234, 10)])),
            (0x001B, 7, 12, b"ASCII\x00\x00\x00FAKE")]


def build_tiff(order="<", gps=True, thumb=None, gps_in_ifd1=False):
    """The Exif TIFF. ``thumb``: the bytes of a JPEG for IFD1's thumbnail. ``gps_in_ifd1``: IFD1 points at a GPS IFD of its own as well."""
    ifd0 = [asc(order, 0x010F, MAKE), short(order, 0x0112, 6), asc(order, 0x0132, DATE), ref(0x8769, "ifd", "exif")]
    if gps:
        ifd0.append(ref(0x8825, "ifd", "gps"))
    ifds = [("ifd0", ifd0, "ifd1" if thumb else None),
            ("exif", [(0x9003, 2, len(DATE) + 1, DATE + b"\x00"), (0x927C, 7, len(MAKER_NOTE), MAKER_NOTE)], None)]
    if gps:
        ifds.append(("gps", gps_entries(order), None))
    blobs = {}
    if thumb:
        ifd1 = [short(order, 0x0103, 6), ref(0x0201, "blob", "thumb"), ref(0x0202, "bloblen", "thumb")]
        if gps_in_ifd1:
            ifd1.append(ref(0x8825, "ifd", "gps2"))
            ifds.append(("gps2", gps_entries(order), None))
        ifds.append(("ifd1", ifd1, None))
        blobs["thumb"] = thumb
    return assemble(order, ifds, blobs)


def read_tags(tiff):
    """A tiny reader for the checks: {"ifd0": {tag: value bytes}, "exif": {...}, "gps": {...} or None, "ifd1": {...} or None}."""
    order = "<" if tiff[:2] == b"II" else ">"

    def ifd(off):
        n = struct.unpack_from(order + "H", tiff, off)[0]
        out = {}
        for i in range(n):
            tag, typ, count, val = struct.unpack_from(order + "HHII", tiff, off + 2 + 12 * i)
            size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1}[typ] * count
            out[tag] = (typ, count, tiff[off + 2 + 12 * i + 8:off + 2 + 12 * i + 8 + size] if size <= 4 else tiff[val:val + size])
        return out, struct.unpack_from(order + "I", tiff, off + 2 + 12 * n)[0]

    ifd0, nxt = ifd(struct.unpack_from(order + "I", tiff, 4)[0])
    result = {"ifd0": ifd0, "exif": ifd(struct.unpack_from(order + "I", ifd0[0x8769][2].ljust(4, b"\x00"), 0)[0])[0] if 0x8769 in ifd0 else None,
              "gps": None, "ifd1": ifd(nxt)[0] if nxt else None}
    if 0x8825 in ifd0:
        result["gps"] = ifd(struct.unpack_from(order + "I", ifd0[0x8825][2], 0)[0])[0]
    return result


def xmp_packet(gps=True, style="attribute", padding=64):
    """An XMP packet. Without GPS it still has a date property and a title, which must survive."""
    head = ('<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
            'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" '
            'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"')
    attrs = ' exif:DateTimeOriginal="2001-02-03T04:05:06"'
    body = '><dc:title>Synthetic title</dc:title>'
    if gps and style == "attribute":
        attrs += ' exif:GPSLatitude="37,33.4242N" exif:GPSLongitude="122,4.5151W" exif:GPSAltitude="1234/10"'
    if gps and style == "element":
        body += '<exif:GPSLatitude>37,33.4242N</exif:GPSLatitude><exif:GPSLongitude>122,4.5151W</exif:GPSLongitude><exif:GPSAltitudeRef/>'
    tail = '</rdf:Description></rdf:RDF></x:xmpmeta>' + " " * padding + '<?xpacket end="w"?>'
    return (head + attrs + body + tail).encode("latin-1")


def segment(marker, payload):
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def jpeg(tiff=None, xmp=None, extra_segments=b"", body=None):
    """SOI, JFIF, [APP1 Exif], [APP1 XMP], ``extra_segments``, then a small valid JPEG (tables, frame, scan, EOI): ``BASELINE`` unless ``body`` is given."""
    out = JFIF
    if tiff is not None:
        out += segment(0xE1, b"Exif\x00\x00" + tiff)
    if xmp is not None:
        out += segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + xmp)
    return out + extra_segments + (BASELINE if body is None else body)


def scan_start(data):
    return data.rindex(b"\xff\xda")


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def png(tiff=None, xmp=None, compress_xmp=False, text=None, icc=None, extra=b""):
    """A 1x1 greyscale PNG with an optional eXIf chunk, an iCCP chunk, an XMP iTXt chunk (deflated or not), a tEXt chunk and ``extra`` chunks."""
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
    if icc is not None:
        out += chunk(b"iCCP", b"prof\x00\x00" + zlib.compress(icc))
    out += extra
    if tiff is not None:
        out += chunk(b"eXIf", tiff)
    if xmp is not None:
        body = b"XML:com.adobe.xmp\x00" + (b"\x01\x00" if compress_xmp else b"\x00\x00") + b"\x00\x00" + (zlib.compress(xmp) if compress_xmp else xmp)
        out += chunk(b"iTXt", body)
    if text is not None:
        out += chunk(b"tEXt", text)
    return out + chunk(b"IDAT", zlib.compress(b"\x00\x80")) + chunk(b"IEND", b"")


def png_chunks(data):
    pos, out = 8, []
    while pos < len(data):
        length, kind = struct.unpack_from(">I4s", data, pos)
        body = data[pos + 8:pos + 8 + length]
        crc = data[pos + 8 + length:pos + 12 + length]
        out.append((kind, body, crc, zlib.crc32(kind + body) & 0xFFFFFFFF == struct.unpack(">I", crc)[0]))
        pos += 12 + length
    return out


def coordinate_bytes():
    """Every byte string a leftover coordinate would be: the packed rationals in both byte orders and the XMP text."""
    out = [rational_bytes(o, LAT) for o in "<>"] + [rational_bytes(o, LON) for o in "<>"]
    return out + [b"37,33.4242N", b"122,4.5151W", b"1234/10"]


def icc_profile(desc="Test sRGB", cprt="No copyright, use freely", extra_tag=None, text_kind="mluc", size_lie=0, gap=b"", replace=None, header_patch=None,
                tags_extra=()):
    """A small valid ICC profile: header, tag table, desc, cprt, wtpt, the three colorants and three gamma curves. ``extra_tag`` is (signature, data);
    ``replace`` {signature: data} changes a tag; ``header_patch`` (offset, bytes) changes the header after it is built; ``tags_extra`` adds tags."""
    def pad(b):
        return b + b"\x00" * (-len(b) % 4)

    def mluc(text):
        u = text.encode("utf-16-be")
        return pad(b"mluc\x00\x00\x00\x00" + struct.pack(">II", 1, 12) + b"enUS" + struct.pack(">II", len(u), 28) + u)

    def text_tag(text):
        return pad(b"text\x00\x00\x00\x00" + text.encode("latin-1") + b"\x00")

    def desc_tag(text):
        a = text.encode("latin-1") + b"\x00"
        return pad(b"desc\x00\x00\x00\x00" + struct.pack(">I", len(a)) + a + struct.pack(">II", 0, 0) + struct.pack(">HB", 0, 0) + b"\x00" * 67)

    def xyz(x, y, z):
        return b"XYZ \x00\x00\x00\x00" + struct.pack(">3i", x, y, z)

    curve = pad(b"curv\x00\x00\x00\x00" + struct.pack(">IH", 1, 0x0233))
    make = {"mluc": mluc, "text": text_tag, "desc": desc_tag}[text_kind]
    tags = [(b"desc", make(desc) if text_kind != "text" else desc_tag(desc)), (b"cprt", make(cprt) if text_kind != "desc" else text_tag(cprt)), (b"wtpt", xyz(63190, 65536, 54061)), (b"rXYZ", xyz(28484, 14319, 904)),
            (b"gXYZ", xyz(25360, 46088, 6522)), (b"bXYZ", xyz(9404, 5120, 46737)), (b"rTRC", curve), (b"gTRC", curve), (b"bTRC", curve)]
    if replace:
        tags = [(sig, replace.get(sig, data)) for sig, data in tags]
    if extra_tag:
        tags.append(extra_tag)
    tags.extend(tags_extra)
    table_end = 132 + 12 * len(tags)
    pos, table, body = table_end, b"", b""
    for sig, data in tags:
        data = pad(data)
        table += sig + struct.pack(">II", pos, len(data))
        body += data
        pos += len(data)
    size = pos + len(gap)
    header = (struct.pack(">I", size + size_lie) + b"lcms" + b"\x02\x10\x00\x00" + b"mntrRGB XYZ " + b"\x00" * 12 + b"acsp" + b"APPL" + b"\x00" * 24
              + struct.pack(">3i", 63190, 65536, 54061) + b"lcms" + b"\x00" * 16 + b"\x00" * 28)
    if header_patch:
        at, value = header_patch
        header = header[:at] + value + header[at + len(value):]
    return header + struct.pack(">I", len(tags)) + table + body + gap


def icc_text_tag(kind, text):
    """A text tag of an ICC profile in one of the three layouts: ``text`` (textType), ``desc`` (textDescriptionType, v2) or ``mluc`` (v4); ``text``
    is a str. The layouts are those of the specification, so a reader sees what a camera's profile has."""
    def pad(b):
        return b + b"\x00" * (-len(b) % 4)
    if kind == "mluc":
        u = text.encode("utf-16-be")
        return pad(b"mluc\x00\x00\x00\x00" + struct.pack(">II", 1, 12) + b"enUS" + struct.pack(">II", len(u), 28) + u)
    if kind == "text":
        return pad(b"text\x00\x00\x00\x00" + text.encode("latin-1") + b"\x00")
    a = text.encode("latin-1") + b"\x00"
    return pad(b"desc\x00\x00\x00\x00" + struct.pack(">I", len(a)) + a + struct.pack(">II", 0, 0) + struct.pack(">HB", 0, 0) + b"\x00" * 67)


def icc_segments(profile, chunk_size=65000):
    """The APP2 segments that carry an ICC profile."""
    chunks = [profile[i:i + chunk_size] for i in range(0, len(profile), chunk_size)] or [b""]
    return b"".join(segment(0xE2, b"ICC_PROFILE\x00" + bytes([i + 1, len(chunks)]) + c) for i, c in enumerate(chunks))


# Small valid JPEGs (from the first quantisation table to EOI), made once with an encoder: the structure the strip reads to the end.
BASELINE = base64.b64decode(
    "/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ"
    "0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAEAAYAwEiAAIRAQMRAf/EAB8AAAEF"
    "AQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNico"
    "IJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1"
    "tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAA"
    "IBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNU"
    "VVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+"
    "jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A8us9MYgcHHYelb1ppfPA4Har9npuRjHOMV0Nppueozz/AJ/lWUJG+VZjtqYV1pqHTZFPlq21lQuO"
    "ASCOpIxwSMk9/wAKK66800No1yGCqNnVgMeuOfXoPc8UV7mXyfs3buLiTMoKtTU/5ejS6+j/AEP/2Q==")
BASELINE2 = base64.b64decode(
    "/9sAQwAKBwcIBwYKCAgICwoKCw4YEA4NDQ4dFRYRGCMfJSQiHyIhJis3LyYpNCkhIjBBMTQ5Oz4+PiUuRElDPEg3PT47/9sAQwEKCwsODQ4cEB"
    "AcOygiKDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7/8AAEQgAEAAYAwERAAIRAQMRAf/EAB8AAAEF"
    "AQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNico"
    "IJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1"
    "tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAA"
    "IBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNU"
    "VVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+"
    "jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A89tbE4UYzxniskXhqyZs2thwAR074rRM+hw9fUtXunuNPbyoUd1O750BCgZJPII6Z/P8K7MM17RX"
    "eh05lXf1NuEU2tdUna2reqa2vvbfvZN9lYA4+TPpXmXPzvD1zZtdPPBI645FaJn0OGr9C7d6dG1kEdAdxKqDjqVIBwefy5rrwzandf1/XnodmN"
    "qwnhuSerei23adt9f/AAG8uyex/9k=")
PROGRESSIVE = base64.b64decode(
    "/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ"
    "0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8IAEQgAGAAYAwEiAAIRAQMRAf/EABgAAQEB"
    "AQEAAAAAAAAAAAAAAAAEBQMG/8QAGAEAAwEBAAAAAAAAAAAAAAAAAgQFAAP/2gAMAwEAAhADEAAAAfLX03gcDXP5oE2N2Dvb/8QAFxABAQEBAA"
    "AAAAAAAAAAAAAAAwIAI//aAAgBAQABBQKD0nrPlBaD1nyg9J5C5//EABwRAAMAAQUAAAAAAAAAAAAAAAACBAEFERMhUf/aAAgBAwEBPwGWg1Gr"
    "Kuu3hK+StOR+z//EABoRAAICAwAAAAAAAAAAAAAAAAABAgMEETL/2gAIAQIBAT8BTMfkRTLUT//EABsQAAIBBQAAAAAAAAAAAAAAAAEQEQIgIT"
    "FB/9oACAEBAAY/AkTEurA12z//xAAZEAEAAwEBAAAAAAAAAAAAAAABABEhMUH/2gAIAQEAAT8hjvaQrRocWppNSKkJ1Ghkq8YC7N82p//aAAwD"
    "AQACAAMAAAAQXCiC/8QAHBEBAAIBBQAAAAAAAAAAAAAAAQAhETFBUWFx/9oACAEDAQE/ENO5WD0HPZK9wAUmDaf/xAAXEQEBAQEAAAAAAAAAAA"
    "AAAAAAASFx/9oACAECAQE/EBqurUwf/8QAHhABAAIDAQADAQAAAAAAAAAAAREhADFBUWGBoeH/2gAIAQEAAT8QuFA1T5iH4ODBHCPLvkzHoReI"
    "igZxpAYNp36y0kFwBchd1X8y00NA5EOEU9+ctZDemWRV0EKXTMbTP//Z")
RESTART = base64.b64decode(
    "/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ"
    "0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAGAAYAwEiAAIRAQMRAf/EAB8AAAEF"
    "AQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNico"
    "IJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1"
    "tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAA"
    "IBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNU"
    "VVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+"
    "jp6vLz9PX29/j5+v/dAAQAAv/aAAwDAQACEQMRAD8A8utNLyyjB3YrftNNX5cp2rQstN6cA84x61vWWmfMFbj1HasoSN8qzHbU56/0tG0qYSxp"
    "J8hMe7+9g8j37/TrxRXcS6ZI2n3HlsUk8slSCBjA9e1Fe5l9W0GtPvNOIMT7SrTlrt0jfr1d0f/Qu2enA4yOex963rHTtoBx3PaiiuSB8plNeb"
    "tqak+kh7B0ZnVduWC9x6Hp8vryPcgUUUV6uEqSUNGevmMlOpHmSenX5n//2Q==")
GRAY = base64.b64decode(
    "/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/8AACwgAEAAQAQERAP"
    "/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEV"
    "UtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpq"
    "eoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAgBAQAAPwDyzSbXgEc9uldvpVrnaApPPrXP6Nah"
    "gAR1PQdq7nSrdsocce39K//Z")


def png_image(width=7, height=5, ctype=2, depth=8, interlace=0, before=b"", idat_chunks=1, palette=None, filler=0, pre=b""):
    """A valid PNG of the given kind: every scanline has filter byte 0 and ``filler`` pixels, the zlib stream is complete; ``pre`` is a string of chunks put before the palette (gAMA, iCCP...) and ``before`` after it, both before the picture data; the data is split into ``idat_chunks`` IDATs. Palette images get a palette of ``palette`` entries."""
    bits = depth * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    if interlace:
        lens = []
        for xo, yo, dx, dy in ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)):
            pw = -(-(width - xo) // dx) if width > xo else 0
            ph = -(-(height - yo) // dy) if height > yo else 0
            if pw and ph:
                lens += [1 + -(-pw * bits // 8)] * ph
    else:
        lens = [1 + -(-width * bits // 8)] * height
    raw = b"".join(b"\x00" + bytes([filler]) * (n - 1) for n in lens)
    stream = zlib.compress(raw, 9)
    pieces = [stream[i:i + max(1, len(stream) // idat_chunks + 1)] for i in range(0, len(stream), max(1, len(stream) // idat_chunks + 1))]
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, ctype, 0, 0, interlace))
    out += pre
    if ctype == 3:
        out += chunk(b"PLTE", bytes((i * 37) % 256 for i in range(3 * (palette or 4))))
    out += before + b"".join(chunk(b"IDAT", p) for p in pieces)
    return out + chunk(b"IEND", b"")
