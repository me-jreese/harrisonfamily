"""The verified backup taken before every apply (sync.md 8.3 step 7, BRD2 11.1) and the restore from one (error catalog D46).

    make(dbdir, tp, action, seq, sidecar_path)   backups/<UTC>-<action>-seq<N>.sqlite, .sidecar.sqlite and .sha256
    prune(backups_dir)                            the last KEEP_LAST, plus the newest of each day for KEEP_DAYS days
    restore(dbdir, tp, backup, ...)               Gramps closed, `<dbdir>/lock` absent, sha256 checked, the database files moved aside, the
                                                  backup copied in, `PRAGMA integrity_check`, the matching sidecar put back

The backup uses SQLite's online backup API from a separate read connection, because Gramps' own connection is private
(gramps/plugins/db/dbapi/sqlite.py). No backup, no apply: a failed integrity check removes the files and raises `BackupError`.

The sidecar copy is part of the backup. A database restored without the sidecar of its moment would show every restored object as a
desktop edit of what the website changed since, and the next push would put the old values back (the revert hazard of D46, D47).
`<name>.sha256` is plain `sha256sum` text: one `<hex>  <file name>` line for the database and one for the sidecar copy.

Standard library only; Python 3.9 compatible.
"""
import datetime
import hashlib
import os
import re
import shutil
import sqlite3
import time

from . import consts, preflight, sidecar

KEEP_LAST = 20
KEEP_DAYS = 30
DB_FILES = ("sqlite.db", "sqlite.db-journal", "sqlite.db-wal", "sqlite.db-shm", "lock")
_NAME = re.compile(r"^(\d{8}T\d{6}Z)-([a-z]+)-seq(\d+)$")


class BackupError(Exception):
    """`code` is a catalog-style word; `exit_code` and `next_action` say what the wrapper returns."""

    def __init__(self, code, message, exit_code=consts.EXIT_INTERNAL, next_action="none"):
        Exception.__init__(self, "%s (%s)" % (message, code))
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.next_action = next_action


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                return h.hexdigest()
            h.update(block)


def _ro_uri(path):
    import pathlib

    return pathlib.Path(os.path.abspath(path)).as_uri() + "?mode=ro"


def _integrity(path):
    con = sqlite3.connect(path, timeout=10)
    try:
        return con.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        con.close()


def _online_copy(src_path, dst_path, readonly=True):
    src = sqlite3.connect(_ro_uri(src_path) if readonly else src_path, uri=readonly, timeout=30)
    try:
        dst = sqlite3.connect(dst_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _utc(now=None):
    return datetime.datetime.fromtimestamp(time.time() if now is None else now, datetime.timezone.utc).replace(tzinfo=None)


def backup_name(action, seq, now=None):
    t = _utc(now)
    return "%s-%s-seq%d" % (t.strftime("%Y%m%dT%H%M%SZ"), re.sub(r"[^a-z]", "", action.lower()) or "run", int(seq))


class Backup:
    def __init__(self, name, directory):
        self.name = name
        self.dir = directory
        self.path = os.path.join(directory, name + ".sqlite")
        self.sidecar_path = os.path.join(directory, name + ".sidecar.sqlite")
        self.sha_path = os.path.join(directory, name + ".sha256")
        self.sha256 = None
        self.sidecar_sha256 = None


def make(dbdir, tp, action, seq, sidecar_path=None, now=None):
    """Takes the backup; returns a Backup whose files exist and passed `integrity_check`. Raises BackupError and leaves nothing behind."""
    os.makedirs(tp.backups, mode=0o700, exist_ok=True)
    stamp = now if now is not None else time.time()
    name = backup_name(action, seq, stamp)
    while os.path.exists(os.path.join(tp.backups, name + ".sqlite")):  # two backups in one second
        stamp += 1
        name = backup_name(action, seq, stamp)
    b = Backup(name, tp.backups)
    made = []
    try:
        db_file = os.path.join(dbdir, "sqlite.db")
        if not os.path.isfile(db_file):
            raise BackupError("backup_failed", "The tree's database file was not found; nothing was changed.")
        for src, dst, readonly in ((db_file, b.path, True), (sidecar_path, b.sidecar_path, False)):
            if src is None:
                continue
            made.append(dst)
            try:
                _online_copy(src, dst, readonly=readonly)
            except sqlite3.Error as exc:
                raise BackupError("backup_failed", "The backup could not be made (%s); nothing was changed." % type(exc).__name__)
            os.chmod(dst, 0o600)
            if _integrity(dst) != "ok":
                raise BackupError("backup_failed", "The backup did not pass integrity_check; nothing was changed.")
        b.sha256 = sha256_file(b.path)
        lines = ["%s  %s\n" % (b.sha256, os.path.basename(b.path))]
        if sidecar_path is not None:
            b.sidecar_sha256 = sha256_file(b.sidecar_path)
            lines.append("%s  %s\n" % (b.sidecar_sha256, os.path.basename(b.sidecar_path)))
        made.append(b.sha_path)
        with open(b.sha_path, "w", encoding="utf-8") as fh:
            fh.write("".join(lines))
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(b.sha_path, 0o600)
    except BaseException:
        for p in made:
            try:
                os.unlink(p)
            except OSError:
                pass
        raise
    return b


def read_sha_file(path):
    """{file name: hex} from a `.sha256` file, or None when it is missing or malformed."""
    try:
        with open(path, encoding="utf-8") as fh:
            rows = [ln.rstrip("\n").split("  ", 1) for ln in fh if ln.strip()]
    except OSError:
        return None
    out = {}
    for row in rows:
        if len(row) != 2 or not re.match(r"^[0-9a-f]{64}$", row[0]):
            return None
        out[row[1]] = row[0]
    return out or None


def list_backups(backups_dir):
    """[(name, path)] of every complete backup (database file and `.sha256`), oldest first."""
    try:
        names = sorted(f[:-len(".sqlite")] for f in os.listdir(backups_dir) if f.endswith(".sqlite") and not f.endswith(".sidecar.sqlite"))
    except OSError:
        return []
    return [(n, os.path.join(backups_dir, n + ".sqlite")) for n in names if _NAME.match(n) and os.path.exists(os.path.join(backups_dir, n + ".sha256"))]


def prune(backups_dir, keep_last=KEEP_LAST, keep_days=KEEP_DAYS, now=None):
    """Keeps the newest `keep_last` backups and the newest of each UTC day within `keep_days`; removes the rest. Returns the names removed."""
    items = list_backups(backups_dir)
    keep = {n for n, _ in items[-keep_last:]}
    cutoff = _utc(now) - datetime.timedelta(days=keep_days)
    newest_of_day = {}
    for n, _ in items:
        stamp = datetime.datetime.strptime(_NAME.match(n).group(1), "%Y%m%dT%H%M%SZ")
        if stamp >= cutoff:
            newest_of_day[stamp.date()] = n  # sorted oldest first, so the last one of a day wins
    keep |= set(newest_of_day.values())
    removed = []
    for n, _ in items:
        if n in keep:
            continue
        for suffix in (".sqlite", ".sidecar.sqlite", ".sha256"):
            try:
                os.unlink(os.path.join(backups_dir, n + suffix))
            except OSError:
                pass
        removed.append(n)
    return removed


# ---------------------------------------------------------------------------------------------------------------- restore


def resolve(tp, backup):
    """The Backup named by `backup`: a name or a path to its `.sqlite` file. BackupError when it is not one of this tree's."""
    base = os.path.basename(backup)
    name = base[:-len(".sqlite")] if base.endswith(".sqlite") else base
    if not _NAME.match(name):
        raise BackupError("backup_invalid", "That is not one of this tree's backups.", consts.EXIT_USAGE)
    if os.path.sep in backup and os.path.realpath(os.path.dirname(os.path.abspath(backup))) != os.path.realpath(tp.backups):
        raise BackupError("backup_invalid", "That backup is not in this tree's backups folder.", consts.EXIT_USAGE)
    b = Backup(name, tp.backups)
    if not os.path.isfile(b.path) or not os.path.isfile(b.sha_path):
        raise BackupError("backup_invalid", "No complete backup of that name (the database file and its .sha256 are both needed).", consts.EXIT_USAGE)
    return b


def restore(dbdir, tp, backup, ps_lines=None, now=None, hook=None):
    """Restores `backup` into the tree at `dbdir` (Gramps closed). Returns {"aside": directory, "backup": name}.

    Order, and the reason for it: refuse while Gramps runs or `lock` exists (a running Gramps would overwrite the file under us);
    verify the sha256 of the database copy and of the sidecar copy before anything moves; take `state.lock`; move aside sqlite.db,
    sqlite.db-journal, -wal, -shm and lock (a stale journal next to a restored database would be rolled into it); copy the backup in;
    `PRAGMA integrity_check` the result (on failure put everything back); then put the matching sidecar in place. Needs the sidecar
    copy: without it the next push would revert whatever the website changed since the backup (D46).
    """
    if os.path.exists(os.path.join(dbdir, "lock")):
        raise BackupError("D01", consts.REFUSALS["D01"][2], consts.EXIT_TEMPORARY, "close_gramps")
    if ps_lines is not None and preflight.gui_process_running(ps_lines):
        raise BackupError("D01", consts.REFUSALS["D01"][2], consts.EXIT_TEMPORARY, "close_gramps")
    b = resolve(tp, backup)
    sums = read_sha_file(b.sha_path)
    if not sums or sums.get(os.path.basename(b.path)) != sha256_file(b.path):
        raise BackupError("backup_invalid", "The backup does not match its sha256; it was not used.", consts.EXIT_CONFIG)
    side_name = os.path.basename(b.sidecar_path)
    if side_name not in sums or not os.path.isfile(b.sidecar_path):
        raise BackupError("backup_incomplete", "The backup has no sidecar copy; restoring only the database would push the website's "
                          "newer changes back as reverts.", consts.EXIT_CONFIG)
    if sums[side_name] != sha256_file(b.sidecar_path):
        raise BackupError("backup_invalid", "The backup's sidecar copy does not match its sha256; it was not used.", consts.EXIT_CONFIG)
    if _integrity(b.path) != "ok" or _integrity(b.sidecar_path) != "ok":
        raise BackupError("backup_invalid", "The backup does not pass integrity_check; it was not used.", consts.EXIT_CONFIG)
    tp.ensure()
    stamp = _utc(now).strftime("%Y%m%dT%H%M%SZ")
    aside = os.path.join(dbdir, "pre-restore-%s" % stamp)
    with preflight.StateLock(tp.lock) as lock:
        if not lock.acquired:
            raise BackupError("D14", consts.REFUSALS["D14"][2], consts.EXIT_TEMPORARY, "retry")
        moved = []
        side_aside = None
        try:
            os.makedirs(aside, mode=0o700, exist_ok=True)
            for name in DB_FILES:
                src = os.path.join(dbdir, name)
                if os.path.lexists(src):
                    os.replace(src, os.path.join(aside, name))
                    moved.append(name)
            if hook:
                hook("restore_moved")
            tmp = os.path.join(dbdir, ".sqlite.db.restore")
            shutil.copyfile(b.path, tmp)
            os.chmod(tmp, 0o600)
            os.replace(tmp, os.path.join(dbdir, "sqlite.db"))
            if _integrity(os.path.join(dbdir, "sqlite.db")) != "ok":
                raise BackupError("restore_failed", "The restored database did not pass integrity_check; the previous files were put back.")
            if os.path.exists(tp.sidecar):
                side_aside = os.path.join(aside, "state.sqlite")
                os.replace(tp.sidecar, side_aside)
            side_tmp = tp.sidecar + ".restore"
            shutil.copyfile(b.sidecar_path, side_tmp)
            os.chmod(side_tmp, 0o600)
            os.replace(side_tmp, tp.sidecar)
            try:
                con = sidecar.open_checked(tp.sidecar)
                con.close()
            except sidecar.SidecarError:
                raise BackupError("restore_failed", "The restored sidecar did not pass its checks; the previous files were put back.")
        except BaseException:
            _rollback(dbdir, tp, aside, moved, side_aside)
            raise
    return {"aside": aside, "backup": b.name}


def _rollback(dbdir, tp, aside, moved, side_aside):
    for name in moved:
        try:
            os.replace(os.path.join(aside, name), os.path.join(dbdir, name))
        except OSError:
            pass
    if side_aside and os.path.exists(side_aside):
        try:
            os.replace(side_aside, tp.sidecar)
        except OSError:
            pass
