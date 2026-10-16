"""Shared fakes for the hfy-sync-render tests (HFY-TSK-176): an in-memory table, buckets, a metrics sink and a store builder.

The fakes implement the ports of ``lambda/hfy-sync-render/hfy_render/aws.py``, so the engine runs unchanged. Standard library only
(no boto3), so CI's stock python3 runs every test. Every fixture is the synthetic tree; no real name, date or contact appears here.
"""

import copy
import datetime
import hashlib
import itertools
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
LAMBDA = os.path.join(REPO, "lambda", "hfy-sync-render")
for path in (LAMBDA,):
    if path not in sys.path:
        sys.path.insert(0, path)

import render_support as rs  # noqa: E402  (also puts gramps/ and the render fixtures on sys.path)

from hfy_render import engine, errors  # noqa: E402
from hfy_render.aws import seq_key  # noqa: E402

FIXED_AT = rs.FIXED_AT
T0 = datetime.datetime(2026, 10, 14, 12, 0, 0, tzinfo=datetime.timezone.utc)


def iso(dt):
    return engine.iso(dt)


class FakeClock:
    def __init__(self, start=T0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now = self.now + datetime.timedelta(seconds=seconds)


class Metrics:
    def __init__(self):
        self.events = []

    def emit(self, name, value=1):
        self.events.append((name, value))

    def count(self, name):
        return sum(v for n, v in self.events if n == name)


class FakeBucket:
    """A dict-backed bucket. ``prefix`` makes a view over another bucket's store (shadow mode is a prefix of the sync bucket)."""

    def __init__(self, store=None, prefix="", name="bucket"):
        self.objects = store if store is not None else {}
        self.prefix = prefix
        self.name = name
        self.puts = []
        self.deletes = []
        self.heads = []
        self.gets = []
        self.fail_put_after = None  # raise on the Nth put (0-based) and later
        self.lie_checksum = False
        self.deny_list_prefixes = set()

    def _k(self, key):
        return self.prefix + key

    def get(self, key):
        self.gets.append(key)
        return self.objects.get(self._k(key))

    def put(self, key, body, sha256_hex):
        if self.fail_put_after is not None and len(self.puts) >= self.fail_put_after:
            raise OSError("injected put failure with a planted MARKER-7Q value")
        assert hashlib.sha256(body).hexdigest() == sha256_hex, "put with a checksum that is not the body's"
        self.puts.append(key)
        self.objects[self._k(key)] = body

    def delete(self, key):
        self.deletes.append(key)
        self.objects.pop(self._k(key), None)

    def head_sha256(self, key):
        self.heads.append(key)
        body = self.objects.get(self._k(key))
        if body is None:
            return None
        return "0" * 64 if self.lie_checksum else hashlib.sha256(body).hexdigest()

    def list_keys(self, prefix):
        if prefix.rstrip("/") in self.deny_list_prefixes:
            err = Exception("AccessDenied")
            err.response = {"Error": {"Code": "AccessDenied"}}
            raise err
        full = self._k(prefix)
        for k in sorted(self.objects):
            if k.startswith(full):
                yield k[len(self.prefix):]

    def site_view(self):
        return {k[len(self.prefix):]: v for k, v in self.objects.items() if k.startswith(self.prefix)}


class FakeTable:
    def __init__(self):
        self.items = {}
        self.fail_commit = False
        self.commits = 0
        self.state_writes = []
        self.reads_log_calls = 0

    # -- reads -----------------------------------------------------------------------------------------------------------
    def get(self, pk, sk, consistent=True):
        item = self.items.get((pk, sk))
        return copy.deepcopy(item) if item else None

    def query_log(self, lo, hi):
        self.reads_log_calls += 1
        for (pk, sk), item in sorted(self.items.items()):
            if pk == "SYNC#LOG" and seq_key(lo) <= sk <= seq_key(hi):
                yield copy.deepcopy(item)

    def batch_get(self, keys):
        return {k: copy.deepcopy(self.items[k]) for k in keys if k in self.items}

    def query_heads(self, cls):
        for (pk, sk), item in sorted(self.items.items()):
            if sk == "HEAD" and pk.startswith(f"REC#{cls}#"):
                yield copy.deepcopy(item)

    def read_state(self):
        return self.get("SYNC#RENDER", "STATE")

    # -- writes ----------------------------------------------------------------------------------------------------------
    def write_state(self, fields, remove=()):
        item = self.items.setdefault(("SYNC#RENDER", "STATE"), {"PK": "SYNC#RENDER", "SK": "STATE"})
        item.update(copy.deepcopy(fields))
        for k in remove:
            item.pop(k, None)
        self.state_writes.append(dict(fields))

    def commit_pass(self, expect, fields, remove, outbox):
        if self.fail_commit:
            raise OSError("injected commit failure")
        item = self.items.get(("SYNC#RENDER", "STATE"), {})
        current = item.get("rendered_seq")
        if (expect is None and current is not None) or (expect is not None and current != expect):
            raise errors.RenderFailed(errors.RULE_STATE_CONFLICT)
        self.commits += 1
        self.write_state(fields, remove)
        if outbox is not None:
            self.items[(outbox["PK"], outbox["SK"])] = copy.deepcopy(outbox)

    # -- the store builder -----------------------------------------------------------------------------------------------
    def head_seq(self):
        head = self.items.get(("SYNC#HEAD", "META"))
        return int(head["seq"]) if head else 0

    def outbox(self):
        return {sk: item for (pk, sk), item in sorted(self.items.items()) if pk == "SYNC#RENDERED"}


class FakeStore:
    """Builds a store the way applyBatch would: a log entry per op, a head per object, ``SYNC#HEAD.seq``."""

    def __init__(self, table=None, start=T0):
        self.table = table or FakeTable()
        self.at = start
        self.table.items.setdefault(("SYNC#HEAD", "META"), {"PK": "SYNC#HEAD", "SK": "META", "seq": 0, "seeded": True})

    def _next(self):
        head = self.table.items[("SYNC#HEAD", "META")]
        head["seq"] += 1
        return head["seq"]

    def _at(self, at):
        self.at = at or (self.at + datetime.timedelta(seconds=1))
        return iso(self.at)

    def put(self, obj, origin="desktop", principal="p-owner", at=None, blob=None, op=None):
        cls, handle = obj["_class"], obj["handle"]
        stored = {k: v for k, v in obj.items() if k != "change"}
        text = json.dumps(stored, sort_keys=True, separators=(",", ":"), ensure_ascii=False)  # the fixture holds floats; the real store is canonical
        existing = self.table.items.get((f"REC#{cls}#{handle}", "HEAD"))
        version = (existing["version"] + 1) if existing else 1
        kind = op or ("update" if existing and not existing["deleted"] else "create")
        seq = self._next()
        when = self._at(at)
        gid = obj.get("gramps_id") or ""
        self.table.items[("SYNC#LOG", seq_key(seq))] = {
            "PK": "SYNC#LOG", "SK": seq_key(seq), "entity": "change", "seq": seq, "op": kind, "class": cls, "handle": handle,
            "gramps_id": gid, "version": version, "obj_json": text, "hash": hashlib.sha256(text.encode()).hexdigest(),
            "principal": principal, "origin": origin, "at": when,
        }
        head = {
            "PK": f"REC#{cls}#{handle}", "SK": "HEAD", "entity": "rec", "class": cls, "handle": handle, "gramps_id": gid,
            "version": version, "seq": seq, "deleted": False, "obj_json": text, "hash": hashlib.sha256(text.encode()).hexdigest(),
            "updated_at": when, "origin": origin,
        }
        if blob is not None:
            head["blob"] = blob
        self.table.items[(head["PK"], "HEAD")] = head
        return seq

    def remove(self, cls, handle, op="delete", origin="desktop", principal="p-owner", reason=None):
        existing = self.table.items[(f"REC#{cls}#{handle}", "HEAD")]
        seq = self._next()
        when = self._at(None)
        self.table.items[("SYNC#LOG", seq_key(seq))] = {
            "PK": "SYNC#LOG", "SK": seq_key(seq), "entity": "change", "seq": seq, "op": op, "class": cls, "handle": handle,
            "gramps_id": existing["gramps_id"], "version": existing["version"] + 1, "obj_json": None, "hash": None,
            "principal": principal, "origin": origin, "at": when, **({"reason": reason} if reason else {}),
        }
        existing.update({"deleted": True, "obj_json": None, "hash": None, "version": existing["version"] + 1, "seq": seq})
        if reason:
            existing["reason"] = reason
        return seq

    def marker(self, origin="desktop"):
        seq = self._next()
        when = self._at(None)
        self.table.items[("SYNC#LOG", seq_key(seq))] = {
            "PK": "SYNC#LOG", "SK": seq_key(seq), "entity": "change", "seq": seq, "op": "marker", "obj_json": None,
            "principal": "p-owner", "origin": origin, "at": when,
        }
        return seq

    def open_session(self, session_id, opened_at, state="open"):
        self.table.items[(f"SYNC#SESSION#{session_id}", "META")] = {
            "PK": f"SYNC#SESSION#{session_id}", "SK": "META", "state": state, "opened_at": iso(opened_at), "seed": False,
        }
        self.table.items[("SYNC#HEAD", "META")]["open_session"] = session_id

    def close_session(self):
        self.table.items[("SYNC#HEAD", "META")].pop("open_session", None)

    def load(self, objects, media_files=None, origin="seed", final_at=FIXED_AT):
        """Loads a projected tree (one entry per object, media blobs from ``media_files``); the last entry's ``at`` is ``final_at``."""

        ordered = sorted(objects, key=lambda o: (o["_class"], o["handle"]))
        for i, obj in enumerate(ordered):
            blob = None
            info = (media_files or {}).get(obj["handle"]) if obj["_class"] == "Media" else None
            if info:
                blob = {"s3_key": "media/%s%s" % (obj["handle"], info.get("ext") or ""), "sha256": info["checksum"], "size": info["size"],
                        "content_type": "image/jpeg", "state": "present"}
            at = None
            if i == len(ordered) - 1:
                at = datetime.datetime.strptime(final_at, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)
                self.at = at - datetime.timedelta(seconds=1)
            self.put(obj, origin=origin, at=at, blob=blob)


def fixture_store(table=None):
    """The projected synthetic tree loaded into a fresh store; the last entry's ``at`` is the fixed time the golden was made with."""

    objects = rs.p_fixture()
    from parity import media_files  # the render fixtures dir is on sys.path through render_support

    store = FakeStore(table)
    store.load(objects, media_files(objects))
    return store


class Rig:
    """A store, buckets, metrics and an engine for one mode."""

    def __init__(self, mode="live", store=None, workers=1, overlay=None, text_gate=None, remaining_ms=None, clock=None, graph_trigger=None):
        self.store = store or fixture_store()
        self.table = self.store.table
        self.sync_store = {}
        self.sync = FakeBucket(self.sync_store, name="sync")
        self.shadow = FakeBucket(self.sync_store, prefix="render-shadow/", name="shadow")
        self.site = FakeBucket({}, name="site")
        self.metrics = Metrics()
        self.clock = clock or FakeClock()
        self.mode = mode
        self.workers = workers
        self.overlay = overlay
        self.text_gate = text_gate
        self.remaining_ms = remaining_ms
        self.graph_trigger = graph_trigger

    def engine(self, mode=None):
        kwargs = {}
        if self.remaining_ms is not None:
            kwargs["remaining_ms"] = self.remaining_ms
        return engine.Engine(engine.Deps(
            table=self.table, sync_root=self.sync, live_bucket=self.site, shadow_bucket=self.shadow, metrics=self.metrics,
            mode=mode or self.mode, clock=self.clock, overlay=self.overlay, text_gate=self.text_gate, workers=self.workers, graph_trigger=self.graph_trigger, **kwargs,
        ))

    def run(self, event=None, mode=None):
        return self.engine(mode).run({"source": "schedule"} if event is None else event)

    def state(self):
        return self.table.read_state() or {}

    def site_files(self):
        return self.site.site_view()

    def manifest(self, mode="live"):
        import json

        raw = self.sync_store.get("render/manifest-%s.json" % mode)
        return json.loads(raw.decode())["keys"] if raw else None


def fresh_render(rig, mode="live"):
    """The site a brand-new renderer produces from the rig's current store (a deep copy of its table, no render state)."""

    table = FakeTable()
    table.items = {k: copy.deepcopy(v) for k, v in rig.table.items.items() if k[0] != "SYNC#RENDER" and k[0] != "SYNC#RENDERED"}
    other = Rig(mode, store=FakeStore(table))
    other.run()
    return other.site_files()


def by_class(objects, cls):
    return [o for o in objects if o["_class"] == cls]


def counter():
    return itertools.count(1)
