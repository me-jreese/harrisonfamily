"""The sidecar `state.sqlite` (sync.md 4.3): the merge base, the outbox, conflicts, holds and the run log, per tree.

It is created with the design's DDL, checked with `PRAGMA integrity_check`, and opened in the default rollback-journal mode, so
a crash leaves it as it was before the transaction (sync.md 8.3, crash safety). Only the standard-library `sqlite3` is used.
"""
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
    import json

    con.execute(
        "INSERT OR REPLACE INTO runs (run_id, action, mode, started_at, finished_at, result, exit_code, counts_json, error_json, backup_path) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (doc["run_id"], doc["action"], doc["mode"], doc["started_at"], doc["finished_at"], doc["result"], doc["exit_code"],
         json.dumps(doc["counts"], sort_keys=True), json.dumps(doc["error"], sort_keys=True) if doc["error"] else None, doc["backup"]),
    )
    con.commit()
