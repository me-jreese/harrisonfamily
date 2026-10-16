"""Media files up (sync.md 8.3 step 11, section 9; BRD2 D2-06 and 11.1 7.2; review SI-31; HFY-TSK-207).

The push sends a Media object's metadata as an op and its blob beside it. Two halves:

    plan      ``annotate`` (pure; called by ``pushplan.build_plan``) decides, for every Media the projection let through, what the blob does:

                  upload   a readable, accepted, GPS-free file whose bytes the website does not have yet (the sidecar's ``media_local`` row
                           is missing or names other bytes). The op gets ``blob = {sha256, md5, size, content_type}`` and the push
                           uploads the bytes first; an unchanged Media with a new file gets an op of its own (a blob-only update).
                  held     the file is missing, unreadable, 0 bytes, a Dropbox online-only placeholder, over 25 MB or a type the website does
                           not take: the metadata syncs, the op carries ``blob = {state: "missing"}`` (the website keeps any blob it has: a
                           good cloud blob is never replaced by an empty one) and a ``holds`` row says what to do.
                  gps      EXIF GPS in the bytes (the projection holds it by mime; this holds it by the bytes, whatever the mime says): the
                           Media is not sent at all.
              A Gramps checksum that is not the disk's MD5 is only a warning: the projection already sends the disk MD5.
    upload    ``upload`` (the push calls it just before each batch): presign (the signed ``x-amz-checksum-sha256``), PUT to the staging key
              ``media/.staging/<handle>/<sha256>``, one retry with a new presign (D31). The Media op then names the blob; the website checks
              the staged object, commits, and copies it into ``media/<handle><ext>`` itself (api/src/sync/media.js ``finalizeBlobs``), so a
              refused or conflicting op leaves the served blob and its metadata as they were. The addon never writes to a served key.

``media_local`` (``handle, path, md5, sha256, size, origin``) remembers the bytes the website holds for a handle: ``cloud`` after a
download (the pull), ``up`` after an acknowledged push. A file that equals its row is not uploaded again. Standard library only;
Python 3.9 compatible.
"""
import base64
import copy
import hashlib

from . import consts, mediafile, transport
from . import media as media_down

CLASS = "Media"
# The Media whose op may carry a blob: the merge says they go to the website as they are (``converged`` and ``unchanged`` are the
# ones with no op, which get a blob-only update when their file is new).
WITH_OP = ("push_create", "update")
NO_OP = ("converged", "unchanged")

GPS_RULE = mediafile.GPS_RULE


class Deferred(Exception):
    """The upload of one blob cannot go on this run; ``rule`` is the hold to record."""

    def __init__(self, rule):
        Exception.__init__(self, rule)
        self.rule = rule


# ------------------------------------------------------------------------------------------------------------ sidecar rows


def load_rows(con):
    """{handle: {path, md5, sha256, size, origin}} from ``media_local``."""
    return {h: {"path": p or "", "md5": m or "", "sha256": s or "", "size": z or 0, "origin": o or ""}
            for h, p, m, s, z, o in con.execute("SELECT handle, path, md5, sha256, size, origin FROM media_local")}


def record(con, handle, path, md5, sha256, size, origin="up", commit=True):
    con.execute("INSERT OR REPLACE INTO media_local (handle, path, md5, sha256, size, origin) VALUES (?, ?, ?, ?, ?, ?)",
                (handle, path or "", md5, sha256, int(size), origin))
    if commit:
        con.commit()


def matches(row, info):
    """True when the website already holds the bytes of ``info`` for this handle (``row`` is its ``media_local`` row)."""
    return bool(row) and bool(info.get("sha256")) and row.get("sha256") == info["sha256"] and row.get("md5") == info["md5"]


def descriptor(info):
    """The ``blob`` of a Media op (api/src/sync/media.js ``blobDescriptor``): what the desktop says it uploaded."""
    return {"sha256": info["sha256"], "md5": info["md5"], "size": info["size"], "content_type": info["content_type"]}


# ---------------------------------------------------------------------------------------------------------------- planning


def _hold(handle, rule, path="/blob"):
    from .. import projection as PR  # the projection's own rules (media.exif_gps.hold, media.pdf.hold) have their sentence there

    return {"class": CLASS, "handle": handle, "path": path, "rule": rule, "detail": consts.HOLD_MESSAGES.get(rule) or PR.hold_reason(rule)}


def annotate(plan, files, rows, local, cloud, actions):
    """Sets the blob of every Media op, adds the blob-only updates, the holds and the warnings (all on ``plan``).

    files    {media handle: ``mediafile.inspect`` dict}; a Media with no entry is left alone (nothing is known about its file)
    rows     {handle: media_local row}
    local    {handle: raw Gramps object}
    cloud    {handle: snapshot head} (class, version, deleted, obj)
    actions  {handle: the merge's action for the object}
    Fills ``plan.uploads`` ({handle: info}), ``plan.warnings`` and ``plan.media_up``.
    """
    plan.uploads, plan.warnings = {}, []
    ops = {o["handle"]: o for o in plan.ops if o["class"] == CLASS}
    whole_held = {x["handle"] for x in plan.holds + plan.blocked if x["class"] == CLASS}
    drop = set()
    for handle, obj in sorted(local.items()):
        if obj.get("_class") != CLASS or handle not in files or handle in whole_held:
            continue
        action = actions.get(handle)
        if action not in WITH_OP and action not in NO_OP:
            continue  # excluded, deleted, in conflict, or a cloud object the pull is to create
        info = files[handle]
        row = rows.get(handle)
        stored = obj.get("checksum")
        if info.get("readable") and info.get("md5") and isinstance(stored, str) and stored and stored != info["md5"]:
            plan.warnings.append({"class": CLASS, "handle": handle, "rule": "media_checksum_stale",
                                  "detail": "Gramps has an old checksum for this file; the file's own MD5 is sent instead."})
        op = ops.get(handle)
        state = info.get("state")
        if state == "gps":
            # the projection holds a GPS photo by its mime; a wrong or empty mime is caught here, by the bytes
            drop.add(handle)
            plan.holds.append(_hold(handle, GPS_RULE, ""))
        elif state == "ok" and info.get("content_type") == "application/pdf" and obj.get("mime") != "application/pdf":
            drop.add(handle)  # a PDF the mime does not say is one (scanned certificates stay on the desktop until io releases them)
            plan.holds.append(_hold(handle, "media.pdf.hold", ""))
        elif state == "ok":
            if matches(row, info):
                continue
            if op is None:
                head = cloud.get(handle)
                if action not in NO_OP or not head or head.get("deleted") or head.get("obj") is None:
                    continue
                op = {"op": "update", "class": CLASS, "handle": handle, "base_version": head["version"], "obj": copy.deepcopy(head["obj"])}
                plan.ops.append(op)
                ops[handle] = op
            op["blob"] = descriptor(info)
            plan.uploads[handle] = info
        elif row is None:
            # The file cannot go: the metadata does and the blob is held. (When the website already holds bytes for this handle there
            # is nothing to tell io: the file was evicted or emptied after it synced, and the cloud copy is good and stays.)
            plan.holds.append(_hold(handle, mediafile.HOLD_RULES.get(state, "media_blob_unreadable")))
            if op is not None:
                op["blob"] = {"state": "missing"}
    if drop:
        plan.ops = [o for o in plan.ops if not (o["class"] == CLASS and o["handle"] in drop)]
    plan.ops.sort(key=lambda o: (consts.CLASSES.index(o["class"]) if o["class"] in consts.CLASSES else len(consts.CLASSES), o["handle"]))
    plan.media_up = len(plan.uploads)


# ---------------------------------------------------------------------------------------------------------------- uploading


def read_verified(info):
    """The bytes of the planned file, or Deferred('media_file_changed') when they are not the bytes the plan hashed."""
    try:
        with open(info["path"], "rb") as fh:
            data = fh.read(mediafile.MAX_BYTES + 1)
    except OSError:
        raise Deferred("media_blob_unreadable")
    if len(data) != info["size"] or hashlib.sha256(data).hexdigest() != info["sha256"] or hashlib.md5(data).hexdigest() != info["md5"]:
        raise Deferred("media_file_changed")
    return data


def _presign(client, handle, info):
    body = {"handle": handle, "content_type": info["content_type"], "size": info["size"],
            "sha256_b64": base64.b64encode(bytes.fromhex(info["sha256"])).decode("ascii"), "md5_hex": info["md5"]}
    try:
        answer = client.post("/api/sync/media/presign", body).body
    except transport.TransportError as exc:
        if exc.status in (400, 413, 422):
            raise Deferred("media_upload_refused")
        raise  # sign-in, a paused store, the network: the run ends (the caller does not defer a blob for those)
    if not isinstance(answer, dict) or not isinstance(answer.get("upload_url"), str) or not isinstance(answer.get("headers"), dict):
        raise Deferred("media_upload_failed")
    headers = {k: v for k, v in answer["headers"].items() if isinstance(k, str) and isinstance(v, str)}
    # Only the two signed headers go on the wire, and the checksum the website signed must be the one computed here.
    wanted = {"Content-Type": info["content_type"], "x-amz-checksum-sha256": body["sha256_b64"]}
    lowered = {k.lower(): v for k, v in headers.items()}
    if any(lowered.get(k.lower()) != v for k, v in wanted.items()):
        raise Deferred("media_upload_failed")
    try:
        url = media_down.check_download_url(answer["upload_url"])  # https (or loopback http), no userinfo: the rule for any presigned URL
    except transport.TransportError:
        raise Deferred("media_upload_failed")
    return url, wanted


def upload(client, handle, info):
    """Uploads the file of ``info`` to its staging key: presign, PUT, and one more try with a new presign if S3 refused the first (D31).

    No Authorization header goes to S3 (the URL is the credential). Raises Deferred(rule) when this blob cannot go this run, and lets
    sign-in, paused-store and network failures propagate (the run ends; nothing is held for them)."""
    data = read_verified(info)
    for _attempt in (0, 1):
        url, headers = _presign(client, handle, info)
        try:
            client.http.send("PUT", url, headers, data, idempotent=True)
            return
        except transport.TransportError as exc:
            if exc.status is None or exc.status >= 500:
                raise
            continue  # a 4xx from S3: an expired URL, a checksum it did not like
    raise Deferred("media_upload_failed")
