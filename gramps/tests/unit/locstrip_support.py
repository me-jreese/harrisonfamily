"""Synthetic JPEG, PNG and TIFF builders for the location-strip tests (HFY-TSK-374). Every coordinate, name and date is fabricated.

``build_tiff`` lays out a small Exif TIFF (IFD0 with Make, Orientation and DateTime, an Exif IFD with DateTimeOriginal and a MakerNote, a GPS
IFD with a version, latitude and longitude with their out-of-line rationals, an altitude and a processing method, and optionally an IFD1
with a thumbnail JPEG) in either byte order. ``jpeg`` and ``png`` wrap it with XMP and a stand-in for the picture data. Standard library only.
"""
import struct
import zlib

# Fabricated position: 37 33 42.42 and 122 4 51.51. The packed rationals are what the leftover search looks for.
LAT = ((37, 1), (33, 1), (4242, 100))
LON = ((122, 1), (4, 1), (5151, 100))
MAKE = b"SYNTHCAM"
DATE = b"2001:02:03 04:05:06"
MAKER_NOTE = b"SYNTHMAKERNOTE0"
SCAN = bytes(range(7, 250)) * 3 + b"\x12\x34\x56"      # the stand-in for the entropy-coded picture data (no 0xFF bytes in it)
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


def jpeg(tiff=None, xmp=None, extra_segments=b"", scan=SCAN):
    """SOI, JFIF, [APP1 Exif], [APP1 XMP], a stand-in for a quantisation table and frame header, the scan and EOI."""
    out = JFIF
    if tiff is not None:
        out += segment(0xE1, b"Exif\x00\x00" + tiff)
    if xmp is not None:
        out += segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + xmp)
    out += extra_segments + segment(0xDB, b"\x00" + bytes(range(1, 65))) + segment(0xC0, b"\x08\x00\x10\x00\x10\x01\x01\x11\x00")
    return out + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + scan + b"\xff\xd9"


def scan_start(data):
    return data.index(b"\xff\xda")


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def png(tiff=None, xmp=None, compress_xmp=False, text=None):
    """A 1x1 greyscale PNG with an optional eXIf chunk, an XMP iTXt chunk (deflated or not) and a tEXt chunk."""
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
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
