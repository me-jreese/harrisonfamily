"""Support for the push tests (HFY-TSK-206): an in-process stand-in for the website's sync API and a tree that holds objects in memory.

    FakeCloud     the parts of /api/sync/* the push uses, with the server's own rules where they matter to the addon: version checks
                  (409 version_conflict), the reserved ID block, retired Person IDs, renumbers, merges, step-up for deletes and the
                  destructive budget, idempotent replay of a batch key, sessions, the seeded gate and the snapshot file. It also logs every
                  request body as JSON text, so a test can grep it the way the dev-server request log is greped.
    PushTree      a runner.TreeAccess over a dict of raw Gramps objects (the synthetic fixture tree). After `attach_db` it also takes a
                  pull: `apply` is one transaction over the dict, and a sqlite.db in a temporary folder gives the backup something to copy.
    PullView      the pull's five-method Cloud over a FakeCloud, so one fake website serves both halves of a sync.
    make_token    an unsigned JWT-shaped access token with the claims the addon reads (amr, auth_time).

Standard library only. Every value is the synthetic fixture's. Python 3.9 compatible.
"""
import base64
import copy
import gzip
import hashlib
import json
import os
import re
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, GRAMPS)
sys.path.insert(0, HERE)

import test_addon_runtime as R  # noqa: E402
from hfygramps import canonical  # noqa: E402
from hfygramps.addon import consts, pushplan, transport  # noqa: E402

FIXTURE = os.path.join(GRAMPS, "tests", "fixtures", "synthetic-tree.jsonl")
CLASS_ORDER = list(consts.CLASSES)


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        objs = [json.loads(line) for line in fh if line.strip()]
    return {o["handle"]: o for o in objs}


def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_token(step_up=False, auth_age=10, now=None):
    now = int(time.time() if now is None else now)
    claims = {"sub": "I9001", "amr": ["pwd", "mfa"] if step_up else ["pwd"], "auth_time": now - auth_age, "exp": now + 3600}
    return "%s.%s.%s" % (b64u(b'{"alg":"RS256"}'), b64u(json.dumps(claims).encode("utf-8")), b64u(b"sig"))


class _Resp:
    def __init__(self, status, body, headers=None):
        self.status, self.body, self.headers = status, body, headers or {}


class _Opened:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        return self.data if n < 0 else self.data[:n]


class _Opener:
    def __init__(self, cloud):
        self.cloud = cloud

    def open(self, req, timeout=None):
        url = req.full_url
        if not url.startswith("https://snapshots.test/snapshot/"):
            raise OSError("unknown url")
        self.cloud.downloads += 1
        data = self.cloud.snapshot_files.get(url)
        if data is None:
            raise OSError("expired")
        if self.cloud.corrupt_downloads > 0:
            self.cloud.corrupt_downloads -= 1
            data = data[:-7]
        return _Opened(data)


class _Http:
    timeout = 5

    def __init__(self, cloud):
        self.opener = _Opener(cloud)


class Versions:
    tree_id = None


def err(status, code, details=None, exit_override=None):
    exit_code, next_action = transport.map_error(status, code)
    return transport.TransportError(code, exit_override or exit_code, next_action, status=status, details=details,
                                    message="The website answered %d (%s)." % (status, code))


class FakeCloud:
    """A Client-shaped object (meta, get, post, token_provider, versions, http) over an in-memory store."""

    def __init__(self, dbid, tree_id="cloud-tree-1", seeded=False, merges_enabled=False, retired=(), members=None, token=None):
        self.dbid = dbid
        self.server = "https://sync.test"
        self.tree_id = tree_id
        self.seeded = seeded
        self.merges_enabled = merges_enabled
        self.retired = set(retired)
        self.members = members
        self.heads = {}
        self.seq = 0
        self.receipts = {}
        self.sessions = {}
        self.open_session = None
        self.requests = []          # (method, path, body) of every call, bodies as JSON text
        self.batches = []           # the bodies of the batches that reached the store
        self.token = token or make_token()
        self.versions = Versions()
        self.http = _Http(self)
        self.snapshot_files = {}
        self.downloads = 0
        self.corrupt_downloads = 0
        self.lose_response = 0      # the next N committed batches answer with a network failure
        self.fail_with = []         # [(path_prefix, TransportError[, skip])] answered once, before the store sees the call
        self.meta_overrides = {}    # keys of the handshake to replace (a stale handshake, a missing list)
        self.no_step_up = False     # the server's view of the token: refuse step-up whatever the token claims
        self.refuse_privacy = set()
        self.refuse_each = []       # one handle per batch attempt: that op is refused (privacy) if the attempt carries it
        self.aliases = []
        self.writes_enabled = True
        self.heartbeats = []
        self.on_batch = None        # called (no arguments) before a new batch is checked: a website-side edit that races the push
        self.replays = []           # the keys that were answered from a stored receipt
        self.id_block = {c: "%s8000-%s8999" % (p, p) for c, p in pushplan.DEFAULT_BLOCK_PREFIX.items()}

    # ------------------------------------------------------------------------------------------------------------- the client

    def token_provider(self):
        return self.token

    def meta(self):
        self._log("GET", "/api/sync/meta", None)
        out = {
            "api_version": 1, "min_client": "0.1.0", "accepted": {"gramps": ["6.0"], "schema": [21]}, "redaction_version": 1,
            "tree_id": self.tree_id, "bound": {"dbid": self.dbid, "fingerprint": "f" * 64} if self.dbid else None, "head_seq": self.seq,
            "rendered_seq": 0, "writes_enabled": self.writes_enabled, "seeded": self.seeded, "merges_enabled": self.merges_enabled,
            "limits": {"max_ops": 24, "max_obj_bytes": 204800, "max_body_bytes": 2097152}, "id_block": dict(self.id_block),
            "retired_person_ids": sorted(self.retired | {h["gramps_id"] for h in self.heads.values() if h["class"] == "Person" and h["deleted"]}),
        }
        if self.members is not None:
            out["member_person_ids"] = sorted(self.members)
        out.update(self.meta_overrides)
        return out

    def get(self, path, query=None):
        self._log("GET", path, None)
        self._scripted(path)
        if path == "/api/sync/snapshot":
            return _Resp(200, self._snapshot())
        raise err(404, "not_found")

    def post(self, path, body=None, idempotency_key=None):
        self._log("POST", path, body)
        self._scripted(path)
        if path == "/api/sync/batches":
            return self._batch(body, idempotency_key)
        if path == "/api/sync/sessions":
            return self._open(body)
        m = re.match(r"^/api/sync/sessions/([^/]+)/complete$", path)
        if m:
            return self._complete(m.group(1))
        if path == "/api/sync/status":
            self.heartbeats.append(body)
            return _Resp(204, None)
        raise err(404, "not_found")

    def _log(self, method, path, body):
        self.requests.append((method, path, json.dumps(body, sort_keys=True, ensure_ascii=False) if body is not None else ""))

    def _scripted(self, path):
        for i, entry in enumerate(self.fail_with):
            prefix, exc = entry[0], entry[1]
            if path.startswith(prefix):
                if len(entry) > 2 and entry[2] > 0:       # (prefix, exc, skip): let the first `skip` matching calls through
                    self.fail_with[i] = (prefix, exc, entry[2] - 1)
                    return
                del self.fail_with[i]
                raise exc

    # ---------------------------------------------------------------------------------------------------------------- snapshot

    def _snapshot(self):
        heads = sorted(self.heads.items(), key=lambda kv: (CLASS_ORDER.index(kv[1]["class"]), kv[0]))
        lines = []
        for handle, h in heads:
            lines.append(canonical.canonical_json({"class": h["class"], "handle": handle, "gramps_id": h["gramps_id"], "version": h["version"],
                                                   "seq": h["seq"], "deleted": h["deleted"], "obj": None if h["deleted"] else h["obj"]}) + "\n")
        body = "".join(lines).encode("utf-8")
        sha = hashlib.sha256(body).hexdigest()
        header = (canonical.canonical_json({"type": "header", "tree_id": self.tree_id, "seq": self.seq, "schema": 21, "redaction": 1,
                                            "count": len(heads), "body_sha256": sha}) + "\n").encode("utf-8")
        url = "https://snapshots.test/snapshot/%d" % self.seq
        self.snapshot_files[url] = gzip.compress(header + body)
        return {"seq": self.seq, "url": url, "body_sha256": sha, "count": len(heads), "generated_at": "2026-10-14T00:00:00Z"}

    # ---------------------------------------------------------------------------------------------------------------- sessions

    def _open(self, body):
        if self.open_session and self.sessions[self.open_session]["state"] == "open":
            raise err(409, "session_open", {"session_id": self.open_session})
        sid = "S%019d" % (len(self.sessions) + 1)
        self.sessions[sid] = {"state": "open", "seed": not self.seeded, "expected": set(body.get("expected") or [])}
        self.open_session = sid
        return _Resp(201, {"session_id": sid, "expires_at": "2026-10-21T00:00:00Z", "seed": not self.seeded})

    def _complete(self, sid):
        s = self.sessions.get(sid)
        if s is None:
            raise err(404, "session_not_found")
        if s["state"] != "open":
            raise err(409, "session_closed")
        dangling = self._dangling()
        if dangling:
            raise err(422, "integrity_violation", {"violations": dangling})
        s["state"] = "complete"
        if s["seed"]:
            self.seeded = True
        self.open_session = None
        self.seq += 1
        return _Resp(200, {"seq": self.seq})

    def _dangling(self):
        out = []
        for handle, h in sorted(self.heads.items()):
            if h["deleted"]:
                continue
            for cls, ref, ptr in _refs(h["obj"]):
                t = self.heads.get(ref)
                if t is None or t["deleted"]:
                    out.append({"rule": "integrity.dangling_reference", "class": h["class"], "handle": handle, "pointer": ptr})
        return out

    # ----------------------------------------------------------------------------------------------------------------- batches

    def _fresh_step_up(self):
        from hfygramps.addon import push
        return not self.no_step_up and push.step_up_fresh(self.token)

    def _batch(self, body, key):
        if key is None:
            raise err(428, "idempotency_key_required")
        digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()
        if key in self.receipts:
            rec = self.receipts[key]
            if rec["digest"] != digest:
                raise err(422, "idempotency_key_reused")
            self.replays.append(key)
            return _Resp(200, rec["response"], {"idempotent-replayed": "true"})
        if self.on_batch is not None:
            hook, self.on_batch = self.on_batch, None
            hook()
        if body.get("tree_id") not in (None, self.tree_id):
            raise err(403, "tree_mismatch")
        if not self.writes_enabled:
            raise err(503, "sync_paused")
        ops = body["ops"]
        if len(ops) > 24:
            raise err(413, "batch_too_large")
        session = None
        if body.get("session_id"):
            session = self.sessions.get(body["session_id"])
            if session is None:
                raise err(404, "session_not_found")
            if session["state"] != "open":
                raise err(409, "session_closed")
        elif not self.seeded:
            raise err(503, "store_not_seeded")
        destructive = [o for o in ops if o["op"] in ("delete", "withdraw")]
        if destructive and not self._fresh_step_up() and (any(o["op"] == "delete" for o in destructive) or len(destructive) > 10):
            raise err(403, "step_up_required", {"reason": "delete"})
        each = self.refuse_each.pop(0) if self.refuse_each else None
        privacy = [o for o in ops if (o["handle"] in self.refuse_privacy or o["handle"] == each) and o["op"] in ("create", "update")]
        if privacy:
            raise err(422, "privacy_violation", {"violations": [{"rule": "privacy.test_rule", "class": o["class"], "handle": o["handle"], "pointer": "/x", "op_id": o["op_id"]} for o in privacy]})
        conflicts, bad_block, bad_retired, bad_renumber, bad_merge = [], [], [], [], []
        retired = self.retired | {h["gramps_id"] for h in self.heads.values() if h["class"] == "Person" and h["deleted"]}
        for o in ops:
            head = self.heads.get(o["handle"])
            ref = {"op_id": o["op_id"], "class": o["class"], "handle": o["handle"]}
            live = head is not None and not head["deleted"]
            if o["op"] == "create":
                if head is None and o.get("base_version") is not None:
                    conflicts.append(ref)
                elif head is not None and not (head["deleted"] and o.get("base_version") == head["version"]):
                    conflicts.append(ref)
            elif not live or head["version"] != o.get("base_version"):
                conflicts.append(ref)
            if o["op"] in ("create", "update") and o["class"] != "Tag":
                gid = o["obj"].get("gramps_id")
                if pushplan.in_block(pushplan.block_ranges({"id_block": self.id_block}), o["class"], gid) and (o["op"] == "create" or (live and head["gramps_id"] != gid)):
                    bad_block.append(ref)
                if o["class"] == "Person" and gid in retired and not (live and head["gramps_id"] == gid):
                    bad_retired.append(ref)
                if o["class"] == "Person" and live and head["gramps_id"] not in ("", gid):       # "" -> id is the one-time assignment (Q2-03 declined)
                    bad_renumber.append(ref)
            if o["op"] == "delete" and o.get("reason") == "merge" and not self.merges_enabled:
                bad_merge.append(ref)
        for code, lst in (("gramps_id_retired", bad_retired), ("renumber_blocked", bad_renumber), ("reserved_id_block", bad_block)):
            if lst:
                raise err(409, code, {"conflicts": lst})                  # the validator's shape: the ops are named
        self._plan_gids(ops)                                              # applyBatch's shape: {class, gramps_id}, the first offender only
        if bad_merge:
            raise err(409, "merges_disabled", {"conflicts": bad_merge})
        if conflicts:
            raise err(409, "version_conflict", {"conflicts": conflicts})
        results = []
        seq_from = self.seq + 1
        for o in ops:
            self.seq += 1
            head = self.heads.get(o["handle"])
            version = (head["version"] + 1) if head else 1
            if o["op"] in ("create", "update"):
                self.heads[o["handle"]] = {"class": o["class"], "version": version, "seq": self.seq, "deleted": False,
                                           "gramps_id": o["obj"].get("gramps_id", ""), "obj": copy.deepcopy(o["obj"])}
            else:
                self.heads[o["handle"]] = dict(head, version=version, seq=self.seq, deleted=True, obj=None)
                if o["op"] == "delete" and o.get("reason") == "merge":
                    self.aliases.append({"old": head["gramps_id"], "into": o.get("merged_into")})
            results.append({"op_id": o["op_id"], "class": o["class"], "handle": o["handle"], "version": version, "seq": self.seq,
                            "gramps_id": self.heads[o["handle"]]["gramps_id"]})
        response = {"batch_id": "B%d" % len(self.receipts), "seq_from": seq_from, "seq_to": self.seq, "results": results}
        self.receipts[key] = {"digest": digest, "response": response}
        self.batches.append(body)
        if self.lose_response > 0:
            self.lose_response -= 1
            raise transport.TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed.")
        return _Resp(200, response)

    def _plan_gids(self, ops):
        """api/src/sync/apply.js planGids, for the refusals that name no op: its errors carry `{class, gramps_id}` and nothing else, and
        it throws at the first offender (two ops of the batch claiming one ID), then, once every op has been read, at the first ID
        another live object holds. (The validator answers a retired Person ID, and a create over a deleted Person, first, naming the ops.)"""
        claims = {}
        for o in ops:
            if o["class"] == "Tag":
                continue
            head = self.heads.get(o["handle"])
            if o["op"] not in ("create", "update"):
                continue
            gid = o["obj"].get("gramps_id") or ""
            if not gid or (head is not None and not head["deleted"] and head["gramps_id"] == gid):
                continue
            other = claims.get((o["class"], gid))
            if other is not None and other != o["handle"]:
                raise err(409, "gid_conflict", {"class": o["class"], "gramps_id": gid})
            claims[(o["class"], gid)] = o["handle"]
        freed = {(self.heads[o["handle"]]["class"], self.heads[o["handle"]]["gramps_id"]) for o in ops
                 if o["handle"] in self.heads and not self.heads[o["handle"]]["deleted"] and o["class"] not in ("Person", "Tag")
                 and (o["op"] in ("delete", "withdraw") or (o["op"] == "update" and o["obj"].get("gramps_id") != self.heads[o["handle"]]["gramps_id"]))}
        held = {(h["class"], h["gramps_id"]): hd for hd, h in self.heads.items() if not h["deleted"] and h["gramps_id"]}
        for (cls, gid), handle in claims.items():
            holder = held.get((cls, gid))
            if holder is not None and holder != handle and (cls, gid) not in freed:
                raise err(409, "gramps_id_taken", {"class": cls, "gramps_id": gid})

    # ------------------------------------------------------------------------------------------------------------- test hooks

    def edit(self, handle, fn):
        """A website-side edit (another writer): fn(obj) changes a copy, the head moves to the next version."""
        h = self.heads[handle]
        obj = copy.deepcopy(h["obj"])
        fn(obj)
        self.seq += 1
        self.heads[handle] = dict(h, obj=obj, version=h["version"] + 1, seq=self.seq)
        return self.heads[handle]

    def log_text(self):
        return "\n".join(b for _m, _p, b in self.requests if b)

    def pushed_ops(self):
        return [o for b in self.batches for o in b["ops"]]


def _refs(obj):
    """(class, handle, pointer) of the handles an object holds (a thin copy of the server's referencesOf, enough for the fixture)."""
    out = []
    lists = {"event_ref_list": "Event", "media_list": "Media", "child_ref_list": "Person", "person_ref_list": "Person", "reporef_list": "Repository",
             "placeref_list": "Place"}
    handle_lists = {"note_list": "Note", "citation_list": "Citation", "tag_list": "Tag", "family_list": "Family", "parent_family_list": "Family"}
    fields = {("Event", "place"): "Place", ("Citation", "source_handle"): "Source", ("Family", "father_handle"): "Person", ("Family", "mother_handle"): "Person"}

    def walk(node, ptr, key):
        if isinstance(node, dict):
            if key in lists and isinstance(node.get("ref"), str) and node["ref"]:
                out.append((lists[key], node["ref"], ptr + "/ref"))
            for k, v in node.items():
                if (obj.get("_class"), k) in fields and node is obj and isinstance(v, str) and v:
                    out.append((fields[(obj["_class"], k)], v, ptr + "/" + k))
                walk(v, ptr + "/" + k, key if isinstance(v, dict) and False else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                if key in handle_lists and isinstance(v, str) and v:
                    out.append((handle_lists[key], v, "%s/%d" % (ptr, i)))
                else:
                    walk(v, "%s/%d" % (ptr, i), key)
    walk(obj, "", "")
    return out


MINI_PERSONS = ("I0002", "I0004", "I0006", "I0007", "I0010")


def mini_fixture():
    """A small slice of the fixture (five persons with their events, places, one note and one media; no families): a projection and a
    merge of the whole fixture take about two seconds, and most of these tests only need a few objects."""
    data = load_fixture()
    todo = [h for h, o in data.items() if o["_class"] == "Person" and o["gramps_id"] in MINI_PERSONS]
    keep = set()
    while todo:
        h = todo.pop()
        if h in keep or h not in data:
            continue
        keep.add(h)
        for cls, ref, _ptr in _refs(data[h]):
            if not (data[h]["_class"] == "Person" and cls == "Family"):
                todo.append(ref)
    out = {h: copy.deepcopy(data[h]) for h in keep}
    for o in out.values():
        if o["_class"] == "Person":
            o["family_list"], o["parent_family_list"] = [], []
    return out


class PushTree(R.FakeTree):
    """A runner.TreeAccess over a dict of raw Gramps objects. `data` is the tree; tests edit it in place. Default: the mini slice."""

    def __init__(self, data=None, full=False, **kw):
        self.data = copy.deepcopy(data if data is not None else (load_fixture() if full else mini_fixture()))
        R.FakeTree.__init__(self, objs=set(), **kw)

    def handles(self):
        return {(o["_class"], h) for h, o in self.data.items()}

    def objects(self):
        return copy.deepcopy(self.data)

    # a pull applies through these (see the pull tests' FakeTree): one transaction over `data`, swapped in on success
    def attach_db(self, root):
        """A folder with a small sqlite.db, so the pull's backup has a file to copy."""
        self.dbdir = os.path.join(root, "grampsdb", self.dbid)
        os.makedirs(self.dbdir, exist_ok=True)
        con = sqlite3.connect(os.path.join(self.dbdir, "sqlite.db"))
        con.execute("CREATE TABLE objects (handle TEXT PRIMARY KEY, json TEXT NOT NULL)")
        con.commit()
        con.close()
        self.undo = []
        self.applies = 0

    def editors_open(self):
        return False

    def apply(self, label, commits, removals, precheck=None, verify=None, hook=None):
        working = copy.deepcopy(self.data)
        if precheck is not None:
            precheck(lambda cls, h: copy.deepcopy(self.data.get(h)))
        for _h, o in sorted(commits.items()):
            working[o["handle"]] = copy.deepcopy(o)
        for _cls, h in removals:
            working.pop(h, None)
        if verify is not None:
            verify(copy.deepcopy(working))
        self.data = working
        self.undo.append(label)
        self.applies += 1

    def pad(self, n):
        """Adds n plain, unreferenced notes: a bigger tree, so a mass delete stays under the 90 percent similarity line (D03)."""
        template = copy.deepcopy(next(o for o in load_fixture().values() if o["_class"] == "Note" and o["text"]["string"] == "A plain note with nothing sensitive in it."))
        handles = []
        self.pads = getattr(self, "pads", [])
        for i in range(n):
            note = copy.deepcopy(template)
            note.update({"handle": "padnote%020d" % i, "gramps_id": "N%04d" % (5000 + i)})
            note["text"] = dict(note["text"], string="Padding note number %d." % i)
            self.data[note["handle"]] = note
            handles.append(note["handle"])
        self.pads += handles
        return handles

    # edits, the way io would make them
    def edit(self, handle, fn):
        fn(self.data[handle])

    def person_by_id(self, gramps_id):
        return next(o for o in self.data.values() if o["_class"] == "Person" and o["gramps_id"] == gramps_id)

    def by_id(self, cls, gramps_id):
        return next(o for o in self.data.values() if o["_class"] == cls and o.get("gramps_id") == gramps_id)


class PullView:
    """The pull's Cloud (meta, snapshot_info, fetch, media_download) over a FakeCloud: one fake website for both halves of a sync."""

    def __init__(self, cloud):
        self.cloud = cloud

    def meta(self):
        return self.cloud.meta()

    def snapshot_info(self):
        return self.cloud.get("/api/sync/snapshot").body

    def fetch(self, url):
        return self.cloud.snapshot_files[url]

    def media_download(self, handle):
        raise err(404, "not_found")
