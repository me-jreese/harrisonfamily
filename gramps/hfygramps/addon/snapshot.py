"""The cloud snapshot the pull reads (sync.md 7.2, 8.3 step 3; api/src/sync/pull.js `buildSnapshot`).

A gzip file of canonical JSON lines. Line 1 is the header `{"type":"header","tree_id","seq","schema","redaction","count","body_sha256"}`;
every further line is one head `{"class","handle","gramps_id","version","seq","deleted","obj"}` (a tombstone has `deleted: true` and
`obj: null`; a head privacy-expunge emptied, HFY-TSK-204, is a tombstone that also carries `expunged: true`, and the key is present only then).
`body_sha256` is the SHA-256 of every byte after the header line's newline, so the flag is part of what it hashes.

`parse` verifies the file the way step 3 says before anything reads an object: the gunzip stays under a size cap, the body hashes to
the header's `body_sha256` (and to the route's), the header names this tree, the database schema and the redaction version the addon
runs, the count matches, every line is well formed, every handle has the plain shape of consts.HANDLE_PATTERN, and no handle or (class, handle) appears twice. A line of a class
the addon does not know (a newer website, error catalog D39) is parked in `Snapshot.parked`: it counts toward `count` and is not a head. A snapshot older than the last
one this tree pulled is refused (`snapshot_older`: rollback protection). Failures are `SnapshotError`, a code and a message with no
object content.
"""
import hashlib
import json
import re
import zlib

from . import consts
from .. import canonical

MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024  # uncompressed; a bomb is stopped here
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_HANDLE = re.compile(consts.HANDLE_PATTERN)
_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]")


class SnapshotError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, "%s (%s)" % (message, code))
        self.code = code
        self.message = message


class Head:
    """One head of the snapshot. `hash` is the canonical hash of the object (None for a tombstone). `expunged` is True only on the tombstone of a
    head privacy-expunge emptied: the website writes the flag into the line, so a delta replica has to carry it to hash like the website's file."""

    __slots__ = ("cls", "handle", "gramps_id", "version", "seq", "deleted", "obj", "hash", "expunged")

    def __init__(self, cls, handle, gramps_id, version, seq, deleted, obj, expunged=False):
        self.cls, self.handle, self.gramps_id, self.version, self.seq, self.deleted, self.obj = cls, handle, gramps_id, version, seq, deleted, obj
        self.expunged = expunged is True
        self.hash = None if deleted else canonical.object_hash(obj)


class Snapshot:
    def __init__(self, header, heads, raw_gz, parked=()):
        self.header = header
        self.heads = heads  # list of Head, in the file's order (class, then handle)
        self.parked = list(parked)  # [{class, handle, gramps_id}]: lines of a class this addon does not know (D39); they are in `count`, not in `heads`
        self.raw_gz = raw_gz
        self.seq = header["seq"]
        self.body_sha256 = header["body_sha256"]
        self.by_handle = {h.handle: h for h in heads}


def gunzip_capped(raw, cap=MAX_SNAPSHOT_BYTES):
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        out = d.decompress(raw, cap + 1)
        if d.unconsumed_tail or len(out) > cap:
            raise SnapshotError("snapshot_invalid", "The snapshot is larger than the addon accepts.")
        out += d.flush()
    except zlib.error:
        raise SnapshotError("snapshot_invalid", "The snapshot is not a gzip file.")
    if len(out) > cap or not d.eof:
        raise SnapshotError("snapshot_invalid", "The snapshot is truncated or too large.")
    return out


def _bad(why):
    return SnapshotError("snapshot_invalid", "The snapshot failed verification (%s)." % why)


def _int(v, low=0):
    return isinstance(v, int) and not isinstance(v, bool) and v >= low


def parse(raw_gz, expect=None, tree_id=None, schema=None, redaction=consts.REDACTION_VERSION, last_pull_seq=0):
    """Verifies `raw_gz` and returns a Snapshot. `expect` is the route's answer `{seq, body_sha256, count}`."""
    raw = gunzip_capped(raw_gz)
    head_line, nl, body = raw.partition(b"\n")
    if not nl:
        raise _bad("no header line")
    try:
        header = json.loads(head_line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise _bad("header is not JSON")
    if not isinstance(header, dict) or header.get("type") != "header":
        raise _bad("first line is not the header")
    for key in ("seq", "schema", "redaction", "count"):
        if not _int(header.get(key)):
            raise _bad("header %s" % key)
    if not isinstance(header.get("body_sha256"), str) or not _SHA256.match(header["body_sha256"]):
        raise _bad("header body_sha256")
    if hashlib.sha256(body).hexdigest() != header["body_sha256"]:
        raise _bad("the body does not hash to body_sha256")
    if expect is not None:
        if header["body_sha256"] != expect.get("body_sha256") or header["seq"] != expect.get("seq") or header["count"] != expect.get("count"):
            raise _bad("the file is not the one the route announced")
    if tree_id is not None and header.get("tree_id") != tree_id:
        raise _bad("the header names another tree")
    if schema is not None and header["schema"] != schema:
        raise _bad("the header names another database schema")
    if header["redaction"] != redaction:
        raise _bad("the header names another redaction version")
    heads, parked, seen = [], [], set()
    for line in body.split(b"\n"):
        if not line:
            continue
        try:
            row = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise _bad("a line is not JSON")
        if not isinstance(row, dict):
            raise _bad("a line is not an object")
        cls, handle = row.get("class"), row.get("handle")
        if not isinstance(cls, str) or not cls or not isinstance(handle, str) or not handle:
            raise _bad("a line has no usable class or handle")
        if not _HANDLE.match(handle):  # a handle names a local file and a URL path: no separator, no dots, no escapes
            raise _bad("a handle has an unusable shape")
        if handle in seen:
            raise _bad("a handle appears twice")
        seen.add(handle)
        if cls not in consts.CLASSES:
            # D39: a newer website may hold a class this addon has never heard of. That object is parked, not the whole snapshot refused.
            gid = row.get("gramps_id")
            parked.append({"class": _UNSAFE.sub("?", cls)[:40], "handle": handle, "gramps_id": _UNSAFE.sub("?", gid)[:40] if isinstance(gid, str) else ""})
            continue
        deleted = row.get("deleted")
        if not isinstance(deleted, bool) or not _int(row.get("version")) or not _int(row.get("seq")):
            raise _bad("a line has no usable version, seq or deleted flag")
        obj = row.get("obj")
        if deleted:
            if obj is not None:
                raise _bad("a tombstone carries an object")
        else:
            if not isinstance(obj, dict) or obj.get("handle") != handle or obj.get("_class") != cls:
                raise _bad("a live head carries no matching object")
        gid = row.get("gramps_id")
        try:
            heads.append(Head(cls, handle, gid if isinstance(gid, str) else "", row["version"], row["seq"], deleted, obj, row.get("expunged") is True))
        except canonical.CanonicalError:
            raise _bad("a head carries a value that is not canonical JSON")
    if len(heads) + len(parked) != header["count"]:
        raise _bad("the count does not match the body")
    if header["seq"] < last_pull_seq:
        raise SnapshotError("snapshot_older", "The website's snapshot is older than the last one pulled (seq %d < %d); refusing to go back."
                            % (header["seq"], last_pull_seq))
    return Snapshot(header, heads, raw_gz, parked)
