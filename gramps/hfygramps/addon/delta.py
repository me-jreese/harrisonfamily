"""The delta pull (ARCH-B; HFY-TSK-277, sync.md 7.2 `GET /api/sync/changes`, 8.3 step 3, BRD2 11.1): the cloud state from a cached state plus the change feed.

A pull needs the website's whole state to plan against. Step 3 of a run normally downloads a full snapshot. With the feed on, the addon keeps the
last cloud state it derived (the cache, `cache/snapshot-<seq>.jsonl.gz` in the snapshot file format, and `cache/cloud-state.json` beside it) and
replays only the ops after that seq:

    use      the website's handshake says `changes_feed: true` (SYNC#HEAD.changes_feed, off by default) and config.json does not say
             `"changes_feed": false`. Either missing means the plain snapshot pull, which stays the reference path.
    base     the newest cached state: it must verify like a downloaded snapshot (sha256, header, this tree, this database schema, this
             redaction version) and carry the `expunge_epoch` the handshake reports now. An expunge rewrites log entries and heads without moving
             seq, so a cache at an unchanged seq could still hold a scrubbed value; a changed epoch discards the cache.
    replay   `GET /api/sync/changes?since=<cached seq>` page by page. Every op is checked before it is applied: the seqs run one by one from the
             cached seq (the feed is dense; a marker op fills the seq of a session close), the op is one of create, update, delete, withdraw
             or marker, a create is over no head or a tombstone and an update or delete over a live head, the version is exactly one more than
             the head's (a create over nothing is version 1), the object names the class and handle of its op, and the object hashes to the op's
             `hash`. An op the website marks `expunged` carries no object, so the cached head cannot be trusted either.
    result   the heads after the replay, serialised the way the website builds a snapshot (class order, canonical JSON, the same header; a head
             privacy-expunge emptied keeps the `expunged: true` the cached snapshot gave it, because the flag is part of the body). The
             body hashes to the same body_sha256 a snapshot at that seq would carry, so the rest of the run (plan, preview, apply, sidecar) cannot
             tell the two apart: the plan of a delta pull is the plan of a snapshot pull of the same cloud state.

Any doubt falls back to the full snapshot for this run and costs nothing but the download: no cache, a damaged cache, a changed epoch, a gap in
the seqs, a version that does not follow, an object that does not hash, an expunged op, a head behind the cache, `410`, `400 bad_cursor`
or `404 not_enabled` from the feed, a `429`/`5xx` that outlasts the transport's retries, a feed answer that is not the documented shape. The reason is a word in the run log, never content.

Verification. A cache that is only ever advanced by deltas could drift if the website's log or this code had a fault, so every 7th sync
(DELTA_VERIFY_EVERY: six delta syncs, then one) downloads the full snapshot anyway, uses it for the plan, replays the feed to the snapshot's seq and
compares the two body hashes. A difference is logged as `delta verify mismatch`; the snapshot replaces the cache, so the next deltas start from the truth.

Nothing here writes object content to the log or to status.json: a fallback reason is one of the codes below.
"""
import gzip
import hashlib
import os
import re

from .. import canonical
from . import consts, paths, snapshot, transport

# The order the website writes a snapshot in: api/src/sync/store.js CLASSES, then handle. consts.CLASSES is the order a push sends in.
SERVER_CLASS_ORDER = ("Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag")
PAGE_LIMIT = 500  # the route's maximum
MAX_PAGES = 5000  # a runaway feed (a server that never reaches its own head) stops here and falls back
STATE_FILE = "cloud-state.json"
_HANDLE = re.compile(consts.HANDLE_PATTERN)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_OPS = ("create", "update", "delete", "withdraw", "marker")
FEED_REFUSALS = (400, 404, 410)  # bad_cursor or validation, not_enabled, gap_too_large: the feed cannot serve this cursor, a snapshot can
FEED_UNAVAILABLE = (429, 500, 502, 503, 504)  # still failing after the transport's own retries: the feed is optional, so try the snapshot route


class Fallback(Exception):
    """The delta pull cannot be trusted for this run; `code` is a short word for the run log."""

    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


def _int(v, low=0):
    return isinstance(v, int) and not isinstance(v, bool) and v >= low


def enabled(handshake, config):
    """True when this run should try the feed: the website says so and the config does not opt out."""
    if not isinstance(handshake, dict) or handshake.get("changes_feed") is not True:
        return False
    return not (isinstance(config, dict) and config.get("changes_feed") is False)


def epoch_of(handshake):
    e = handshake.get("expunge_epoch") if isinstance(handshake, dict) else None
    return e if _int(e) else 0


# ---------------------------------------------------------------------------------------------------------------- the replica


class Replica:
    """The cloud's heads as the addon holds them: {handle: snapshot.Head}, the seq they are current at, and the cache's bookkeeping."""

    def __init__(self, tree_id, seq, heads, epoch, streak=0):
        self.tree_id = tree_id
        self.seq = seq
        self.heads = {h.handle: h for h in heads}
        self.epoch = epoch
        self.streak = streak  # delta syncs since the last full snapshot

    def apply(self, op, expect_seq):
        """Applies one feed op in order, or raises Fallback. Nothing in the replica changes when it raises."""
        if not isinstance(op, dict) or op.get("seq") != expect_seq or not _int(expect_seq, 1):
            raise Fallback("gap")
        if op.get("expunged") is True:
            raise Fallback("expunged")
        kind = op.get("op")
        if kind not in _OPS:
            raise Fallback("bad_op")
        if kind == "marker":
            self.seq = expect_seq
            return
        cls, handle, version = op.get("class"), op.get("handle"), op.get("version")
        if cls not in consts.CLASSES or not isinstance(handle, str) or not _HANDLE.match(handle) or not _int(version, 1):
            raise Fallback("bad_op")
        old = self.heads.get(handle)
        if old is not None and old.cls != cls:
            raise Fallback("bad_op")
        if kind == "create":
            fits = (old is None and version == 1) or (old is not None and old.deleted and version == old.version + 1)
        else:  # update, delete and withdraw all work on a live head and move it by exactly one version
            fits = old is not None and not old.deleted and version == old.version + 1
        if not fits:
            raise Fallback("gap")
        gid = op.get("gramps_id")
        gid = gid if isinstance(gid, str) and gid else (old.gramps_id if old is not None else "")  # the website keeps the old id on an empty one
        if kind in ("create", "update"):
            obj = op.get("obj")
            if not isinstance(obj, dict) or obj.get("handle") != handle or obj.get("_class") != cls:
                raise Fallback("bad_obj")
            try:
                head = snapshot.Head(cls, handle, gid, version, expect_seq, False, obj)
            except canonical.CanonicalError:
                raise Fallback("bad_obj")
            if head.hash != op.get("hash"):
                raise Fallback("hash_mismatch")
        else:
            if op.get("obj") is not None:
                raise Fallback("bad_obj")
            head = snapshot.Head(cls, handle, gid, version, expect_seq, True, None)
        self.heads[handle] = head
        self.seq = expect_seq

    def sorted_heads(self):
        rank = {c: i for i, c in enumerate(SERVER_CLASS_ORDER)}
        return sorted(self.heads.values(), key=lambda h: (rank.get(h.cls, len(rank)), h.handle))

    def body(self):
        """The snapshot body: one canonical JSON line per head, as api/src/sync/pull.js buildSnapshot writes it."""
        return "".join(canonical.canonical_json({
            "class": h.cls, "handle": h.handle, "gramps_id": h.gramps_id or "", "version": h.version, "seq": h.seq,
            "deleted": bool(h.deleted), **({"expunged": True} if h.expunged else {}),  # present only when true, as pull.js writes it (HFY-TSK-204)
            "obj": None if h.deleted else h.obj}) + "\n" for h in self.sorted_heads()).encode("utf-8")

    def to_snapshot(self, schema, last_pull_seq=0):
        """The Snapshot a full download at this seq would give. Refuses a seq older than the last pull, like snapshot.parse does."""
        body = self.body()
        sha = hashlib.sha256(body).hexdigest()
        header = {"type": "header", "tree_id": self.tree_id, "seq": self.seq, "schema": schema, "redaction": consts.REDACTION_VERSION,
                  "count": len(self.heads), "body_sha256": sha}
        if self.seq < last_pull_seq:
            raise snapshot.SnapshotError("snapshot_older", "The website's state is older than the last one pulled (seq %d < %d); refusing to go back."
                                         % (self.seq, last_pull_seq))
        raw = gzip.compress((canonical.canonical_json(header) + "\n").encode("utf-8") + body, 9, mtime=0)
        return snapshot.Snapshot(header, self.sorted_heads(), raw)


# ---------------------------------------------------------------------------------------------------------------- the cache


def state_path(tp):
    return os.path.join(tp.cache, STATE_FILE)


def cache_file(tp, seq):
    return os.path.join(tp.cache, "snapshot-%d.jsonl.gz" % seq)


def save_state(tp, snap, epoch, streak):
    """Records which cached snapshot is the newest cloud state, under which expunge epoch, and how many delta syncs got there."""
    paths.atomic_write_json(state_path(tp), {"seq": snap.seq, "body_sha256": snap.body_sha256, "expunge_epoch": epoch, "streak": streak,
                                             "tree_id": snap.header.get("tree_id")})


def load(tp, cloud_tree, schema, epoch):
    """The Replica for the cached state, or Fallback. The cached file is verified like a download before anything trusts it."""
    try:
        state = paths.read_json(state_path(tp))
    except (OSError, ValueError):
        raise Fallback("cache_invalid")
    if state is None:
        raise Fallback("no_cache")
    if (not isinstance(state, dict) or not _int(state.get("seq")) or not _int(state.get("expunge_epoch")) or not _int(state.get("streak"))
            or not isinstance(state.get("body_sha256"), str) or not _SHA256.match(state["body_sha256"])):
        raise Fallback("cache_invalid")
    if state["expunge_epoch"] != epoch:
        raise Fallback("expunge_epoch")
    if state.get("tree_id") != cloud_tree:
        raise Fallback("other_tree")
    try:
        with open(cache_file(tp, state["seq"]), "rb") as fh:
            raw = fh.read()
        snap = snapshot.parse(raw, tree_id=cloud_tree, schema=schema)
    except (OSError, snapshot.SnapshotError):
        raise Fallback("cache_invalid")
    if snap.seq != state["seq"] or snap.body_sha256 != state["body_sha256"]:
        raise Fallback("cache_invalid")
    return Replica(cloud_tree, snap.seq, snap.heads, epoch, state["streak"])


# ---------------------------------------------------------------------------------------------------------------- the replay


def _page(cloud, since):
    try:
        resp = cloud.changes(since, PAGE_LIMIT)
    except transport.TransportError as exc:
        if exc.status in FEED_REFUSALS:
            raise Fallback("feed_%s" % exc.code)
        if exc.status in FEED_UNAVAILABLE:
            raise Fallback("feed_unavailable")  # a 401 or 403 is not here: signing in again is the answer to those, not a different route
        raise
    if (not isinstance(resp, dict) or resp.get("dense") is not True or not isinstance(resp.get("ops"), list)
            or not _int(resp.get("head_seq")) or not _int(resp.get("next_since"))):
        raise Fallback("bad_feed")
    return resp


def advance(replica, cloud, head_seq, until=None):
    """Replays the feed onto `replica` up to the cloud's head (or to `until`, for the verification). Raises Fallback."""
    if head_seq < replica.seq:
        raise Fallback("cloud_behind")  # a restored store: the snapshot route decides whether this is a rollback
    target = head_seq if until is None else min(head_seq, until)
    for _ in range(MAX_PAGES):
        if replica.seq >= target:
            return
        resp = _page(cloud, replica.seq)
        if _int(resp.get("expunge_epoch")) and resp["expunge_epoch"] != replica.epoch:
            raise Fallback("expunge_epoch")
        start = replica.seq
        for op in resp["ops"]:
            if until is not None and isinstance(op, dict) and _int(op.get("seq")) and op["seq"] > until:
                break
            replica.apply(op, replica.seq + 1)
        if until is None and resp["next_since"] != replica.seq:
            raise Fallback("gap")
        if replica.seq == start:
            raise Fallback("no_progress")  # the feed says there is more and gives none
        if resp["head_seq"] < replica.seq:
            raise Fallback("bad_feed")
    raise Fallback("too_many_pages")
