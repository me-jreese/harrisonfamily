"""The sidecar rows the push reads and writes (sync.md 4.3): the merge base, the outbox, the holds and the conflicts.

Every function takes the sqlite connection of `sidecar.open_checked` and commits its own change, so a crash leaves the sidecar as it was
before the call or as it is after it, never between (the sidecar runs in the default rollback-journal mode). Rows hold projected values
only: the base is the cloud object at the last sync, never a raw Gramps object. Standard library only; Python 3.9 compatible.

    base      `base_rows` reads it, `set_base` and `set_base_deleted` advance a row after an acknowledgement (or when the local object
              and the cloud object agree), `drop_base` removes a row the cloud no longer has.
    outbox    pending (written, not yet sent) -> sent (the request is on the wire) -> acked, or rejected. D49: a `pending` row is a crash
              before the send and is discarded; a `sent` row is replayed with its own Idempotency-Key; the answer 409, 422 or 410 to a
              replay marks the row `rejected` and it is never sent again; only a 2xx or an `Idempotent-Replayed` answer advances the
              base.
    holds     what was kept back and why, replaced as a whole by every real run (`first_seen` survives for a hold that stays), except
              the pull's own `expunge.notice` rows: those say which values a website scrub removed, they are the pull's to write,
              and a push neither replaces nor drops them (`sidecar.load_expunge_holds` hands them to the plan); and the rows of a
              media file the pull's download held, which stay while that Media has no file (`sidecar.download_holds`).
    conflicts conflicts, pinned by their path (sync.md 6.7, BRD2 11.1): `parked` when the command line found them, `open` when the
              Gramps window did (the pull writes both the same way); `pins` hands both back to the merge.
"""
import json

from . import consts, sidecar
from .. import canonical


def get_json(con, key, default=None):
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        return default


def set_json(con, key, value):
    con.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value, sort_keys=True, separators=(",", ":"))))
    con.commit()


def get_text(con, key, default=None):
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return default if row is None else row[0]


def set_text(con, key, value):
    con.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))
    con.commit()


def del_meta(con, key):
    con.execute("DELETE FROM meta WHERE key = ?", (key,))
    con.commit()


# ------------------------------------------------------------------------------------------------------------------ base


def base_rows(con):
    """{handle: {"class", "version", "seq", "hash", "obj" (parsed, None for a deleted row), "deleted"}}."""
    out = {}
    for cls, handle, version, seq, hash_, obj_json, deleted in con.execute(
            "SELECT class, handle, version, seq, hash, obj_json, deleted FROM base"):
        out[handle] = {"class": cls, "version": version, "seq": seq, "hash": hash_, "deleted": bool(deleted),
                       "obj": None if obj_json is None else json.loads(obj_json)}
    return out


def _put_base(con, cls, handle, version, seq, obj):
    con.execute(
        "INSERT INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, ?, ?, 0) "
        "ON CONFLICT(class, handle) DO UPDATE SET version = excluded.version, seq = excluded.seq, hash = excluded.hash, "
        "obj_json = excluded.obj_json, deleted = 0",
        (cls, handle, int(version), int(seq), canonical.object_hash(obj), canonical.object_json(obj)))


def _put_base_deleted(con, cls, handle, version, seq):
    con.execute(
        "INSERT INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, '', NULL, 1) "
        "ON CONFLICT(class, handle) DO UPDATE SET version = excluded.version, seq = excluded.seq, hash = '', obj_json = NULL, deleted = 1",
        (cls, handle, int(version), int(seq)))


def set_base(con, cls, handle, version, seq, obj, commit=True):
    """The base row becomes `obj` (projected) at `version`."""
    _put_base(con, cls, handle, version, seq, obj)
    if commit:
        con.commit()


def set_base_deleted(con, cls, handle, version, seq, commit=True):
    _put_base_deleted(con, cls, handle, version, seq)
    if commit:
        con.commit()


def drop_base(con, handle, commit=True):
    con.execute("DELETE FROM base WHERE handle = ?", (handle,))
    if commit:
        con.commit()


def apply_cloud_heads(con, heads, handles):
    """Advances the base rows of `handles` to the cloud's own heads ({handle: {class, version, seq, deleted, obj}}), in one commit."""
    for h in handles:
        head = heads[h]
        if head["deleted"]:
            _put_base_deleted(con, head["class"], h, head["version"], head["seq"])
        else:
            _put_base(con, head["class"], h, head["version"], head["seq"], head["obj"])
    con.commit()


# ---------------------------------------------------------------------------------------------------------------- outbox


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def outbox_add(con, key, session_id, now, request):
    """A `pending` row: the whole request is written before anything is sent."""
    con.execute("INSERT INTO outbox (batch_key, session_id, created_at, state, request_json, response_json, attempts) VALUES (?, ?, ?, 'pending', ?, NULL, 0)",
                (key, session_id, now, _json(request)))
    con.commit()


def outbox_mark_sent(con, key):
    con.execute("UPDATE outbox SET state = 'sent', attempts = attempts + 1 WHERE batch_key = ?", (key,))
    con.commit()


def outbox_mark_attempt(con, key):
    con.execute("UPDATE outbox SET attempts = attempts + 1 WHERE batch_key = ?", (key,))
    con.commit()


def outbox_set_state(con, key, state, response=None, commit=True):
    con.execute("UPDATE outbox SET state = ?, response_json = ? WHERE batch_key = ?", (state, None if response is None else _json(response), key))
    if commit:
        con.commit()


def outbox_rows(con, state=None):
    q = "SELECT batch_key, session_id, created_at, state, request_json, response_json, attempts FROM outbox"
    args = ()
    if state is not None:
        q += " WHERE state = ?"
        args = (state,)
    q += " ORDER BY created_at, batch_key"
    return [{"key": k, "session_id": s, "created_at": c, "state": st, "request": json.loads(rq),
             "response": None if rs is None else json.loads(rs), "attempts": a} for k, s, c, st, rq, rs, a in con.execute(q, args)]


def outbox_discard_pending(con):
    """D49: a `pending` row is a crash before the send; it is removed and the next plan recomputes. Returns how many."""
    n = con.execute("SELECT COUNT(*) FROM outbox WHERE state = 'pending'").fetchone()[0]
    con.execute("DELETE FROM outbox WHERE state = 'pending'")
    con.commit()
    return n


def outbox_prune(con, keep=consts.OUTBOX_KEEP):
    """Keeps the newest `keep` closed (acked or rejected) rows for the run log."""
    con.execute("DELETE FROM outbox WHERE state IN ('acked', 'rejected') AND batch_key NOT IN "
                "(SELECT batch_key FROM outbox WHERE state IN ('acked', 'rejected') ORDER BY created_at DESC, batch_key DESC LIMIT ?)", (int(keep),))
    con.commit()


OWN_PUSHES_DDL = "CREATE TABLE IF NOT EXISTS own_pushes (seq INTEGER PRIMARY KEY)"


def record_own_seq(con, seq):
    """Remembers a seq the website gave one of the desktop's own acknowledged pushes: an op's (`ack_batch`) or the marker of a completed push
    session (push.py `_complete_session`). `base` keeps only the newest seq of each object, so a second push of the same object would otherwise
    hide the first; the gramplet's 'changes waiting' count reads this table instead. The rebase empties it (a re-seeded store restarts its seqs)."""
    con.execute(OWN_PUSHES_DDL)
    con.execute("INSERT OR IGNORE INTO own_pushes (seq) VALUES (?)", (int(seq),))


def ack_batch(con, key, request, response):
    """An acknowledged batch (a 2xx or an `Idempotent-Replayed` answer): the outbox row becomes `acked` and every op's object (or
    deletion) becomes the base row at the version the server gave it, in ONE commit. Returns the number of ops applied.

    `request` is the outbox row's request ({"body": {...}, "keep": [handle, ...]}); `response` the 2xx body. A handle in `keep` is an
    object the website changed too and the desktop has not applied yet (the pull is still to take that edit): the merged object was
    pushed, but its base row is left as it was, so the website's edit is taken by the next pull and never read as a desktop revert.
    This is the only place the base advances after a push (D49): a rejected or pending row never reaches it.
    """
    keep = set(request.get("keep") or ())
    results = {r.get("op_id"): r for r in (response or {}).get("results", []) if isinstance(r, dict)}
    n = 0
    for op in request["body"]["ops"]:
        res = results.get(op.get("op_id"))
        if res is None:
            continue
        if op["op"] in ("create", "update", "delete", "withdraw") and res.get("seq") is not None:
            record_own_seq(con, res["seq"])
        if op["op"] in ("create", "update") and op["handle"] in keep:
            pass
        elif op["op"] in ("create", "update"):
            set_base(con, op["class"], op["handle"], res["version"], res["seq"], op["obj"], commit=False)
        elif op["op"] in ("delete", "withdraw"):
            set_base_deleted(con, op["class"], op["handle"], res["version"], res["seq"], commit=False)
        else:
            continue
        n += 1
    outbox_set_state(con, key, "acked", response, commit=False)
    con.commit()
    return n


# ----------------------------------------------------------------------------------------------------------------- holds


def sync_holds(con, holds, now, pathless=()):
    """Replaces the holds table with `holds` ([{class, handle, path, rule, detail}]); a hold that stays keeps its first_seen.
    `pathless` is the handles of the Media with no file path: the holds of a media file the pull's download held stay for them."""
    seen = {(c, h, p, r): f for c, h, p, r, f in con.execute("SELECT class, handle, path, rule, first_seen FROM holds WHERE rule != ?", (sidecar.EXPUNGE_RULE,))}
    kept = sidecar.download_holds(con, pathless)
    con.execute("DELETE FROM holds WHERE rule != ?", (sidecar.EXPUNGE_RULE,))  # the pull's expunge notices stay: the push must not put those values back
    for x in holds:
        key = (x["class"], x["handle"], x.get("path", ""), x["rule"])
        con.execute("INSERT OR REPLACE INTO holds (class, handle, path, rule, detail, first_seen) VALUES (?, ?, ?, ?, ?, ?)",
                    key + (x.get("detail", ""), seen.get(key) or now))
    for row in kept:
        con.execute("INSERT OR IGNORE INTO holds (class, handle, path, rule, detail, first_seen) VALUES (?, ?, ?, ?, ?, ?)", row)
    con.commit()


def hold_rows(con):
    return [{"class": c, "handle": h, "path": p, "rule": r, "detail": d, "first_seen": f}
            for c, h, p, r, d, f in con.execute("SELECT class, handle, path, rule, detail, first_seen FROM holds ORDER BY class, handle, path, rule")]


# ------------------------------------------------------------------------------------------------------------- conflicts


def open_conflicts(con):
    """The conflicts that still pin their path: `open` (the Gramps window) and `parked` (the command line), as the pull treats them."""
    return [{"id": i, "class": c, "handle": h, "path": p, "kind": k, "base_json": b, "cloud_json": cl, "local_json": lo, "state": st}
            for i, c, h, p, k, b, cl, lo, st in con.execute(
                "SELECT id, class, handle, path, kind, base_json, cloud_json, local_json, state FROM conflicts WHERE state IN (%s) ORDER BY id"
                % ",".join("?" * len(sidecar.OPEN_CONFLICT_STATES)), sidecar.OPEN_CONFLICT_STATES)]


def pins(con):
    """{handle: [{"path", "base_json"}]} for the merge: an open or parked conflict pins its path (sync.md 6.7)."""
    out = {}
    for c in open_conflicts(con):
        out.setdefault(c["handle"], []).append({"path": c["path"] or "", "base_json": c["base_json"]})
    return out


def record_conflicts(con, found, closed_ids, now, state="open"):
    """Stores the run's conflicts as `state` (`parked` for the command line, `open` for the Gramps window; the same conflict keeps its
    `detected_at`) and resolves the ones the merge found closed.

    `found` are the merge's conflict dicts (each with ``id``, ``class``, ``handle``, ``path``, ``kind``, ``base_json``, ``cloud_json``,
    ``local_json``); `closed_ids` the ids of the pins a run found resolved by itself (the path converged or became one-sided).
    """
    old = {i: d for i, d in con.execute("SELECT id, detected_at FROM conflicts")}
    for c in found:
        con.execute(
            "INSERT INTO conflicts (id, class, handle, path, kind, base_json, cloud_json, local_json, state, decision, cloud_conflict_id, detected_at, resolved_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL) "
            "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, cloud_json = excluded.cloud_json, local_json = excluded.local_json, state = excluded.state, resolved_at = NULL",
            (c["id"], c["class"], c["handle"], c["path"], c["kind"], c["base_json"], c["cloud_json"], c["local_json"], state, old.get(c["id"]) or now))
    for cid in closed_ids:
        con.execute("UPDATE conflicts SET state = 'resolved', decision = COALESCE(decision, 'converged'), resolved_at = ? WHERE id = ? AND state IN ('open', 'parked')", (now, cid))
    con.commit()
