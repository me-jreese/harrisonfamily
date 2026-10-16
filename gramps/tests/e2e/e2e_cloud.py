"""The website's side of a pull scenario (HFY-TSK-205): a signed-in owner who seeds the dev server's store and then edits it.

    CloudDriver(server, client, tree_id)
        .seed(objects)                 open the seed session and push the projected objects in class order, 24 to a batch, then complete it
        .heads()                       {handle: head dict} read from a snapshot the way the addon will
        .get(gid)                      the cloud copy of the object with this Gramps id (a deep copy)
        .update(obj)                   push an update with base_version = the head's version (a website edit: origin desktop, owner bearer)
        .create(obj, blob=None)        push a create; `blob` is {"bytes", "content_type"} for a Media object (presign, PUT, then the op)
        .delete_with(updates, cls, handle)   one batch: the updates, then the delete (it needs the step-up session this driver signs in with)
        .follow_tree(id)               name the new cloud tree in later calls (after the dev server's tree_id was changed)
        .scrub(obj)                    POST /_dev/scrub: rewrite the head in place at the same version (stands in for privacy-expunge --path)

The driver's calls are the real push routes, so everything it writes passed the server's validator, privacy checker and integrity rules. It
is not the addon's push (that is addon-push): it is only how a scenario makes "the website changed".

Standard library plus gramps/hfygramps/addon. Python 3.9 or later.
"""
import base64
import copy
import hashlib
import json

import e2e_support as E
from hfygramps.addon import consts

BATCH = 24


def class_rank(cls):
    return consts.CLASSES.index(cls)


class CloudDriver:
    def __init__(self, server, session):
        self.server = server
        self.session = session
        self.tree_id = None
        self.client = None
        self.keys = 0
        self.batches = 0

    # ---------------------------------------------------------------------------------------------------------- binding and seed

    def bind(self, dbid, fingerprint, tree_name_sha256):
        plain = self.session.client()
        self.tree_id = plain.post("/api/sync/bind", {"dbid": dbid, "fingerprint": fingerprint, "tree_name_sha256": tree_name_sha256}).body["tree_id"]
        self.client = self.session.client(tree_id=self.tree_id)
        return self.tree_id

    def follow_tree(self, tree_id):
        """The website's owner after `sync-admin bump-tree-id` (the dev server: PATCH /_dev/head {tree_id}): calls now name the new tree."""
        self.tree_id = tree_id
        self.client = self.session.client(tree_id=tree_id)

    def _push(self, ops, session_id=None):
        self.keys += 1
        body = {"tree_id": self.tree_id, "client_run_id": "e2e-%d" % self.keys, "ops": ops}
        if session_id:
            body["session_id"] = session_id
        resp = self.client.request("POST", "/api/sync/batches", body=body, idempotency_key="e2e-%s-%d" % (self.tree_id[:8], self.keys))
        self.batches += 1
        return resp.body

    def seed(self, objects):
        ordered = sorted(objects.values(), key=lambda o: (class_rank(o["_class"]), o["handle"]))
        opened = self.client.post("/api/sync/sessions", {"expected": ["%s#%s" % (o["_class"], o["handle"]) for o in ordered]}).body
        ops = [{"op_id": str(i), "op": "create", "class": o["_class"], "handle": o["handle"], "base_version": None, "obj": o}
               for i, o in enumerate(ordered)]
        for i in range(0, len(ops), BATCH):
            self._push(ops[i:i + BATCH], opened["session_id"])
        self.client.post("/api/sync/sessions/%s/complete" % opened["session_id"], {})
        return len(ops)

    # ----------------------------------------------------------------------------------------------------------------------- reads

    def snapshot(self):
        info = self.client.get("/api/sync/snapshot").body
        header, lines = E.read_snapshot(info["url"], info)
        return info, header, lines

    def heads(self):
        return {row["handle"]: row for row in self.snapshot()[2]}

    def get(self, gramps_id):
        for row in self.heads().values():
            if row.get("gramps_id") == gramps_id and not row.get("deleted"):
                return copy.deepcopy(row["obj"])
        raise KeyError(gramps_id)

    def version_of(self, handle):
        return self.heads()[handle]["version"]

    # ---------------------------------------------------------------------------------------------------------------- website edits

    def update(self, obj):
        base = self.version_of(obj["handle"])
        return self._push([{"op_id": "1", "op": "update", "class": obj["_class"], "handle": obj["handle"], "base_version": base, "obj": obj}])

    def edit(self, gramps_id, fn):
        obj = self.get(gramps_id)
        fn(obj)
        self.update(obj)
        return obj

    def create(self, obj, blob=None):
        op = {"op_id": "1", "op": "create", "class": obj["_class"], "handle": obj["handle"], "base_version": None, "obj": obj}
        if blob is not None:
            op["blob"] = self.upload(obj["handle"], blob["bytes"], blob["content_type"])
        return self._push([op])

    def upload(self, handle, data, content_type):
        sha = hashlib.sha256(data).digest()
        md5 = hashlib.md5(data).hexdigest()
        presign = self.client.post("/api/sync/media/presign", {
            "handle": handle, "content_type": content_type, "size": len(data), "sha256_b64": base64.b64encode(sha).decode("ascii"), "md5_hex": md5,
        }).body
        status, _ = E._call("PUT", presign["upload_url"], data, dict(presign["headers"]))
        if status not in (200, 204):
            raise E.DevServerError("the blob upload answered %d" % status)
        return {"sha256": sha.hex(), "md5": md5, "size": len(data), "content_type": content_type}

    def delete_with(self, updates, cls, handle):
        ops = []
        for obj in updates:
            ops.append({"op_id": str(len(ops) + 1), "op": "update", "class": obj["_class"], "handle": obj["handle"],
                        "base_version": self.version_of(obj["handle"]), "obj": obj})
        ops.append({"op_id": str(len(ops) + 1), "op": "delete", "class": cls, "handle": handle, "base_version": self.version_of(handle)})
        return self._push(ops)

    def scrub(self, obj):
        status, body = E._call("POST", self.server.origin + "/_dev/scrub", {"class": obj["_class"], "handle": obj["handle"], "obj": obj},
                               {"Content-Type": "application/json"})
        if status != 200:
            raise E.DevServerError("the scrub was refused (%s): %s" % (status, body[:200]))
        return json.loads(body.decode("utf-8"))
