"""The sidecar `state.sqlite` (sync.md 4.3): the merge base, the outbox, conflicts, holds and the run log, per tree.

It is created with the design's DDL, checked with `PRAGMA integrity_check`, and opened in the default rollback-journal mode, so
a crash leaves it as it was before the transaction (sync.md 8.3, crash safety). Only the standard-library `sqlite3` is used.
"""
import json
import os
import sqlite3

from . import consts

DDL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE base (class TEXT NOT NULL, handle TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL,
  hash TEXT NOT NULL, obj_json TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (class, handle));
CREATE TABLE outbox (batch_key TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','acked','rejected')),
  request_json TEXT NOT NULL, response_json TEXT, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conflicts (id TEXT PRIMARY KEY, class TEXT, handle TEXT, path TEXT, kind TEXT,
  base_json TEXT, cloud_json TEXT, local_json TEXT, state TEXT, decision TEXT,
  cloud_conflict_id TEXT, detected_at TEXT, resolved_at TEXT);
CREATE TABLE holds (class TEXT, handle TEXT, path TEXT, rule TEXT, detail TEXT, first_seen TEXT,
  PRIMARY KEY (class, handle, path, rule));
CREATE TABLE media_local (handle TEXT PRIMARY KEY, path TEXT, md5 TEXT, sha256 TEXT, size INTEGER, origin TEXT);
CREATE TABLE id_map (class TEXT, handle TEXT, old_id TEXT, new_id TEXT, kind TEXT, at TEXT);
CREATE TABLE runs (run_id TEXT PRIMARY KEY, action TEXT, mode TEXT, started_at TEXT, finished_at TEXT,
  result TEXT, exit_code INTEGER, counts_json TEXT, error_json TEXT, backup_path TEXT);
"""
TABLES = ("meta", "base", "outbox", "conflicts", "holds", "media_local", "id_map", "runs")


class SidecarError(Exception):
    """The sidecar is damaged, unreadable or from a newer addon (D13)."""


def _connect(path):
    con = sqlite3.connect(path, timeout=5)
    con.execute("PRAGMA foreign_keys = ON")
    return con


def create(path, meta):
    """Creates a new sidecar at `path` with the DDL and `meta` plus `sidecar_schema`. Refuses to replace one.

    Built under a temporary name and renamed into place, so a crash never leaves a half-made `state.sqlite`.
    """
    if os.path.exists(path):
        raise SidecarError("a sidecar already exists")
    tmp = path + ".new"
    if os.path.exists(tmp):
        os.unlink(tmp)
    try:
        con = _connect(tmp)
        try:
            con.executescript(DDL)
            rows = dict(meta)
            rows["sidecar_schema"] = str(consts.SIDECAR_SCHEMA)
            con.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", sorted((k, str(v)) for k, v in rows.items()))
            con.commit()
            verdict = con.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            con.close()
        if verdict != "ok":
            raise SidecarError("integrity_check failed on the new sidecar")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def open_checked(path):
    """Opens an existing sidecar after `PRAGMA integrity_check` and a schema-version check; SidecarError (D13) otherwise."""
    try:
        con = _connect(path)
        try:
            verdict = con.execute("PRAGMA integrity_check").fetchone()[0]
            if verdict != "ok":
                raise SidecarError("integrity_check failed")
            have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if not set(TABLES) <= have:
                raise SidecarError("tables missing")
            row = con.execute("SELECT value FROM meta WHERE key = 'sidecar_schema'").fetchone()
            if row is None or not row[0].isdigit():
                raise SidecarError("no schema version")
            if int(row[0]) > consts.SIDECAR_SCHEMA:
                raise SidecarError("written by a newer addon")
        except BaseException:
            con.close()
            raise
        return con
    except sqlite3.Error as exc:
        raise SidecarError("unreadable: %s" % type(exc).__name__) from exc


def meta(con):
    return dict(con.execute("SELECT key, value FROM meta"))


def set_meta(con, key, value):
    con.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))


def base_handles(con):
    """{(class, handle)} of the live (not deleted) objects the last sync agreed on; the similarity guard's reference set."""
    return {(c, h) for c, h in con.execute("SELECT class, handle FROM base WHERE deleted = 0")}


def record_run(con, doc):
    """Appends a status document to the `runs` table (counts and codes only)."""
    con.execute(
        "INSERT OR REPLACE INTO runs (run_id, action, mode, started_at, finished_at, result, exit_code, counts_json, error_json, backup_path) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (doc["run_id"], doc["action"], doc["mode"], doc["started_at"], doc["finished_at"], doc["result"], doc["exit_code"],
         json.dumps(doc["counts"], sort_keys=True), json.dumps(doc["error"], sort_keys=True) if doc["error"] else None, doc["backup"]),
    )
    con.commit()


# ---------------------------------------------------------------------------------------------------------------------------
# The pull side (HFY-TSK-205). Two tables beyond the sync.md 4.3 DDL, created on the first apply (a read never creates them):
#
#   pulled     what a pull changed in the last PULL_WINDOW pull runs: the object as the desktop had it before (projected), so a push
#              that returns a field to that value is labelled "reverts a website change (origin)" (BRD2 11.1, D47). `run_n` counts the
#              pull runs that applied something; the row of a run in flight has run_n = meta.pull_n + 1 and is kept if the run ends
#              between the Gramps commit and the sidecar update.
#   incidents  a pulled object whose text or dates matched a local full date of birth (dob_exact): never applied, counts only in
#              status.json, offered a withdraw-and-expunge push.

PULL_WINDOW = 5
PULL_DDL = """
CREATE TABLE IF NOT EXISTS pulled (run_n INTEGER NOT NULL, class TEXT NOT NULL, handle TEXT NOT NULL, kind TEXT NOT NULL,
  prepull_json TEXT, at TEXT, PRIMARY KEY (run_n, class, handle));
CREATE TABLE IF NOT EXISTS incidents (class TEXT NOT NULL, handle TEXT NOT NULL, gramps_id TEXT, rule TEXT NOT NULL, seq INTEGER,
  first_seen TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (class, handle));
"""
EXPUNGE_RULE = "expunge.notice"
OPEN_CONFLICT_STATES = ("open", "parked")


def ensure_pull_tables(con):
    con.executescript(PULL_DDL)


def has_table(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def meta_json(con, key, default):
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        return default


def set_meta_json(con, key, value):
    set_meta(con, key, json.dumps(value, sort_keys=True, separators=(",", ":")))


def load_base(con):
    """{handle: {class, version, seq, hash, obj, deleted}}: the last sync's cloud copies (obj is the parsed projected object)."""
    out = {}
    for cls, handle, version, seq, hsh, obj_json, deleted in con.execute(
            "SELECT class, handle, version, seq, hash, obj_json, deleted FROM base"):
        out[handle] = {"class": cls, "version": version, "seq": seq, "hash": hsh, "deleted": bool(deleted),
                       "obj": json.loads(obj_json) if obj_json else None}
    return out


def load_pins(con):
    """{handle: [{"path", "base_json"}]}: the open and parked conflicts, which pin their paths (sync.md 6.7)."""
    out = {}
    q = "SELECT handle, path, base_json FROM conflicts WHERE state IN (%s)" % ",".join("?" * len(OPEN_CONFLICT_STATES))
    for handle, path, base_json in con.execute(q, OPEN_CONFLICT_STATES):
        out.setdefault(handle, []).append({"path": path or "", "base_json": base_json})
    return out


def load_conflicts(con, states=OPEN_CONFLICT_STATES):
    cur = con.execute("SELECT id, class, handle, path, kind, base_json, cloud_json, local_json, state, decision, detected_at "
                      "FROM conflicts WHERE state IN (%s) ORDER BY id" % ",".join("?" * len(states)), states)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur]


def load_pulled(con, pull_n):
    """{handle: [{run_n, kind, prepull}]}, newest run first, for the last PULL_WINDOW pull runs (and the run in flight)."""
    if not has_table(con, "pulled"):
        return {}
    out = {}
    for run_n, cls, handle, kind, prepull in con.execute(
            "SELECT run_n, class, handle, kind, prepull_json FROM pulled WHERE run_n > ? ORDER BY run_n DESC", (pull_n - PULL_WINDOW,)):
        out.setdefault(handle, []).append({"run_n": run_n, "class": cls, "kind": kind, "prepull": json.loads(prepull) if prepull else None})
    return out


def open_incidents(con):
    """[{class, handle, gramps_id, rule, seq}] of the incidents still open: what `addon-push` turns into withdraw-and-expunge pushes
    (`plan.incident_offer`). Handles and ids only, no object content."""
    if not has_table(con, "incidents"):
        return []
    return [{"class": c, "handle": h, "gramps_id": g or "", "rule": r, "seq": q}
            for c, h, g, r, q in con.execute("SELECT class, handle, gramps_id, rule, seq FROM incidents WHERE state = 'open' ORDER BY class, handle")]


def load_expunge_holds(con):
    """{handle: [pointer]}: values a website scrub removed, which the push must not put back (sync.md 8.3, BRD2 11.1 inbound)."""
    out = {}
    for handle, path in con.execute("SELECT handle, path FROM holds WHERE rule = ?", (EXPUNGE_RULE,)):
        out.setdefault(handle, []).append(path)
    return out


def pathless_media(local):
    """The handles of the Media objects of `local` ({handle: raw object}) that have no file path: where the download held the file."""
    return frozenset(h for h, o in local.items() if isinstance(o, dict) and o.get("_class") == "Media" and not o.get("path"))


def download_holds(con, pathless):
    """The holds rows (class, handle, path, rule, detail, first_seen) of a media file the download held, whose Media is still in `pathless`.

    Only the pull's download finds these (it reads the bytes), and a later pull does not fetch the file again, so a run that replaces the
    holds table keeps them (`INSERT OR IGNORE` after its own rows) until the Media has a file of its own or is gone: the window lists
    them under Held back as long as they stay."""
    marks = ",".join("?" * len(consts.DOWNLOAD_HOLD_RULES))
    rows = con.execute("SELECT class, handle, path, rule, detail, first_seen FROM holds WHERE class = 'Media' AND path = '/blob' AND rule IN (%s)" % marks,
                       consts.DOWNLOAD_HOLD_RULES).fetchall()
    return [row for row in rows if row[1] in pathless]


def load_incidents(con):
    if not has_table(con, "incidents"):
        return []
    cur = con.execute("SELECT class, handle, gramps_id, rule, seq, first_seen, state FROM incidents WHERE state = 'open' ORDER BY class, handle")
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur]


def release_event(con, handle):
    """A person released an event in the Gramps window: its day and month are no longer kept local by the sticky set (BRD2 11.1, PS-02).
    The handle goes into ``released`` (so no rule puts it back, ``projection.update_birthlike_sticky``) and out of ``birthlike_sticky``."""
    released = set(meta_json(con, "released", []))
    released.add(handle)
    sticky = set(meta_json(con, "birthlike_sticky", []))
    sticky.discard(handle)
    set_meta_json(con, "released", sorted(released))
    set_meta_json(con, "birthlike_sticky", sorted(sticky))
    con.commit()

