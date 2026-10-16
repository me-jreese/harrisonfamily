"""Fakes for the pull tests (HFY-TSK-205): a tree, a cloud and a snapshot, all in memory over the synthetic fixture.

    load_fixture()     {handle: object} from gramps/tests/fixtures/synthetic-tree.jsonl (fictional data only)
    FakeTree           a runner.TreeAccess over a dict, with a real transaction (a copy, swapped in on success), an undo list, a real
                       sqlite.db in a temporary folder for the backup, and the same `apply` contract as the Gramps shell
    FakeCloud          a Cloud over a list of heads: meta(), snapshot_info(), fetch(), media_download(), with the snapshot built the way
                       api/src/sync/pull.js builds it
    Env                a temporary HOME with a bound sidecar, so `runner.run` can be called for check, pull and sync

Standard library only; written for Python 3.9 or later.
"""
import copy
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
FIXTURE = os.path.join(GRAMPS_DIR, "tests", "fixtures", "synthetic-tree.jsonl")
if GRAMPS_DIR not in sys.path:
    sys.path.insert(0, GRAMPS_DIR)

from hfygramps import canonical  # noqa: E402
from hfygramps import projection as PR  # noqa: E402
from hfygramps.addon import binding, consts, paths, runner, sidecar, transport  # noqa: E402
from hfygramps.addon import plan as plan_mod  # noqa: E402

CLASS_RANK = {c: i for i, c in enumerate(consts.CLASSES)}
CLOUD_TREE = "11111111-2222-4333-8444-555555555555"


def load_fixture():
    out = {}
    with open(FIXTURE, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                o = json.loads(line)
                out[o["handle"]] = o
    return out


def project_all(objects, **kw):
    """What a push sends, and so what the website holds: the projection with every person's back-links made to agree with the projected
    families (`plan.symmetric`). The website refuses a tree where they disagree, so a fake cloud never holds one."""
    proj = PR.project(copy.deepcopy(list(objects.values())), **kw)
    return {h: p for h, p in plan_mod.symmetric(proj.projected, proj.holds).items() if p is not None}


class FakeTree(runner.TreeAccess):
    dbid = "fixturetree"
    name = "Fixture Tree"
    schema_version = 21
    gramps_series = (6, 0)
    gramps_version = "6.0.6"

    def __init__(self, root, objects=None):
        self.root = root
        self.dbdir = os.path.join(root, "grampsdb", self.dbid)
        os.makedirs(self.dbdir, exist_ok=True)
        self._objs = copy.deepcopy(objects if objects is not None else load_fixture())
        self.marker = None
        self.undo = []
        self.editors = False
        self.applies = 0
        self._write_db()

    # ---- the sqlite file backups read
    def _write_db(self):
        path = os.path.join(self.dbroot(), "sqlite.db")
        if os.path.exists(path):
            os.unlink(path)
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE objects (handle TEXT PRIMARY KEY, json TEXT NOT NULL)")
        con.executemany("INSERT INTO objects VALUES (?, ?)", [(h, json.dumps(o, sort_keys=True)) for h, o in self._objs.items()])
        con.commit()
        con.close()

    def dbroot(self):
        return self.dbdir

    def reload(self):
        """Re-reads the objects from sqlite.db (after a restore put another file there)."""
        con = sqlite3.connect(os.path.join(self.dbdir, "sqlite.db"))
        try:
            self._objs = {h: json.loads(j) for h, j in con.execute("SELECT handle, json FROM objects")}
        finally:
            con.close()

    # ---- TreeAccess
    def read_marker(self):
        return self.marker

    def handles(self):
        return {(o["_class"], h) for h, o in self._objs.items()}

    def bind(self, tree_id, also):
        also()
        self.marker = tree_id

    def objects(self):
        return copy.deepcopy(self._objs)

    def editors_open(self):
        return self.editors

    def apply(self, label, commits, removals, precheck=None, verify=None, hook=None):
        working = copy.deepcopy(self._objs)
        if precheck is not None:
            precheck(lambda cls, h: copy.deepcopy(self._objs.get(h)))
        items = sorted(commits.items())
        half = (len(items) + 1) // 2
        for i, (h, o) in enumerate(items, 1):
            working[h] = copy.deepcopy(o)
            if hook is not None and i == half:
                hook("mid_apply")
        if hook is not None and not items:
            hook("mid_apply")
        for cls, h in removals:
            working.pop(h, None)
        if verify is not None:
            verify(copy.deepcopy(working))
        self._objs = working  # committed
        self.undo.append(label)
        self.applies += 1
        self._write_db()

    # ---- test helpers
    def edit(self, handle, fn):
        o = copy.deepcopy(self._objs[handle])
        fn(o)
        self._objs[handle] = o
        self._write_db()

    def remove(self, handle):
        self._objs.pop(handle, None)
        self._write_db()

    def add(self, obj):
        self._objs[obj["handle"]] = copy.deepcopy(obj)
        self._write_db()

    def undo_last(self, before):
        """Puts the objects back as they were before the last apply (an Undo in Gramps)."""
        self._objs = copy.deepcopy(before)
        self._write_db()


def snapshot_bytes(tree_id, seq, heads, schema=21, redaction=1):
    """A snapshot file as api/src/sync/pull.js buildSnapshot writes it; `heads` are dicts {class, handle, gramps_id, version, seq, deleted, obj}."""
    rows = sorted(heads, key=lambda h: (CLASS_RANK[h["class"]], h["handle"]))
    body = "".join(canonical.canonical_json({"class": h["class"], "handle": h["handle"], "gramps_id": h.get("gramps_id", ""), "version": h["version"],
                                              "seq": h["seq"], "deleted": h.get("deleted", False), "obj": None if h.get("deleted") else h["obj"]}) + "\n"
                   for h in rows)
    sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    header = canonical.canonical_json({"type": "header", "tree_id": tree_id, "seq": seq, "schema": schema, "redaction": redaction,
                                       "count": len(rows), "body_sha256": sha}) + "\n"
    return gzip.compress((header + body).encode("utf-8"), mtime=0), sha, len(rows)


def heads_of(projected, version=1, seq=1):
    return {h: {"class": o["_class"], "handle": h, "gramps_id": o.get("gramps_id", ""), "version": version, "seq": seq, "deleted": False,
                "obj": o} for h, o in projected.items()}


class FakeCloud:
    """Stands in for pull.Cloud. `heads` is {handle: head dict}; change it between runs to simulate website edits."""

    def __init__(self, dbid="fixturetree", heads=None, seq=1, tree_id=CLOUD_TREE, bound=True):
        self.dbid = dbid
        self.heads = heads if heads is not None else {}
        self.seq = seq
        self.tree_id = tree_id
        self.bound = bound
        self.blobs = {}          # handle -> {"bytes", "content_type"}
        self.calls = []
        self.fetch_errors = {}   # url suffix -> TransportError to raise once
        self.media_errors = {}   # handle -> exception
        self._files = {}

    def meta(self):
        self.calls.append("meta")
        return {"api_version": 1, "tree_id": self.tree_id, "bound": {"dbid": self.dbid, "fingerprint": "f" * 16} if self.bound else None,
                "head_seq": self.seq, "seeded": True, "writes_enabled": True}

    def snapshot_info(self):
        self.calls.append("snapshot")
        raw, sha, count = snapshot_bytes(self.tree_id, self.seq, list(self.heads.values()))
        key = "snap-%d-%s" % (self.seq, sha[:8])
        self._files[key] = raw
        return {"seq": self.seq, "url": "https://files.example.org/%s" % key, "body_sha256": sha, "count": count}

    def fetch(self, url):
        self.calls.append("fetch")
        key = url.rsplit("/", 1)[1]
        if key in self.fetch_errors:
            raise self.fetch_errors.pop(key)
        if key.startswith("media-"):
            return self._files[key]
        return self._files[key]

    def media_download(self, handle):
        self.calls.append("media:%s" % handle)
        if handle in self.media_errors:
            raise self.media_errors[handle]
        blob = self.blobs.get(handle)
        if blob is None:
            raise transport.TransportError("no_blob", consts.EXIT_INTERNAL, status=404)
        key = "media-%s" % handle
        self._files[key] = blob["bytes"]
        return {"url": "https://files.example.org/%s" % key, "sha256": blob.get("sha256") or hashlib.sha256(blob["bytes"]).hexdigest(),
                "md5": blob.get("md5") or hashlib.md5(blob["bytes"]).hexdigest(), "size": len(blob["bytes"]), "content_type": blob["content_type"]}

    # ---- website edits
    def put(self, obj, version=None, seq=None):
        h = obj["handle"]
        cur = self.heads.get(h)
        self.seq = seq or self.seq + 1
        self.heads[h] = {"class": obj["_class"], "handle": h, "gramps_id": obj.get("gramps_id", ""),
                         "version": version if version is not None else (cur["version"] + 1 if cur else 1), "seq": self.seq, "deleted": False, "obj": obj}

    def tombstone(self, handle):
        cur = self.heads[handle]
        self.seq += 1
        self.heads[handle] = {"class": cur["class"], "handle": handle, "gramps_id": cur.get("gramps_id", ""), "version": cur["version"] + 1,
                              "seq": self.seq, "deleted": True, "obj": None}


class Env:
    """A temporary HOME holding a bound sidecar for a FakeTree. Use as `env = Env(testcase)`."""

    def __init__(self, testcase, objects=None, seed=True):
        self.root = tempfile.mkdtemp(prefix="hfy-pull-test-")
        testcase.addCleanup(shutil.rmtree, self.root, True)
        self.environ = {"HOME": self.root, "HFY_SYNC_TEST": "1", "HFY_SYNC_PS_CMD": "true"}
        self.tree = FakeTree(self.root, objects)
        self.tp = paths.TreePaths(self.tree.dbid, self.environ)
        self.tp.ensure()
        self.cloud = FakeCloud(self.tree.dbid)
        self.runs = 0
        self._bind()
        if seed:
            self.seed_cloud()

    def _bind(self):
        tree_id = binding.new_tree_id()
        cfg = binding.new_config(self.tree.name, self.tree.dbid)
        cfg["media_root"] = os.path.join(self.root, "media")
        self.config = cfg
        paths.atomic_write_json(self.tp.config, cfg)
        sidecar.create(self.tp.sidecar, {"tree_id": tree_id, "dbid": self.tree.dbid, "fingerprint": "0" * 64, "server": cfg["server"],
                                          "redaction_version": consts.REDACTION_VERSION, "addon_version": consts.ADDON_VERSION,
                                          "last_pull_seq": 0, "last_snapshot_sha256": "", "last_push_at": "", "client_instance_id": cfg["client_instance_id"]})
        self.tree.marker = tree_id

    def seed_cloud(self):
        """The cloud holds exactly what the desktop projects: a seeded store."""
        projected = project_all(self.tree.objects())
        self.cloud.heads = heads_of(projected)
        self.cloud.seq = 1

    def run(self, action="check", mode="cli", services=None, **opt):
        self.runs += 1
        opts = runner.Options(action=action, **opt)
        svc = {"cloud": self.cloud}
        svc.update(services or {})
        return runner.run(self.tree, mode, opts, run_id=("T%025d" % self.runs), argv=["gramps"], environ=self.environ, services=svc)

    def settle(self):
        """The first sync: with no base, everything the two sides share is `converged` and the base is filled in."""
        doc = self.run("pull", yes=True)
        assert (doc["result"], doc["exit_code"]) == ("ok", 0), doc
        return doc

    def side(self):
        return sidecar.open_checked(self.tp.sidecar)

    def base_dump(self):
        con = self.side()
        try:
            return sorted(con.execute("SELECT class, handle, version, seq, hash, obj_json, deleted FROM base").fetchall())
        finally:
            con.close()

    def preview(self, doc):
        with open(os.path.join(self.tp.previews, "%s.json" % doc["run_id"]), encoding="utf-8") as fh:
            return json.load(fh)


class PullCase(unittest.TestCase):
    def setUp(self):
        self.env = Env(self)
        self.env.settle()
