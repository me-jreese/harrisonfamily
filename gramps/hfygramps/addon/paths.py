"""The desktop layout of sync.md 4.3. Nothing here is under Dropbox or in git.

    <HOME>/Library/Application Support/hfy_sync/config.json
    <HOME>/Library/Application Support/hfy_sync/<dbid>/{state.sqlite, state.lock, status.json,
                                                        previews/, backups/, logs/, cache/}

`dbid` is the Gramps database id, which is the tree's directory name under Gramps' `grampsdb` folder
(`DbGeneric.get_dbid`). Tests run with a temporary HOME (and GRAMPSHOME), so nothing here ever reads the real one.
"""
import json
import os
import re
import tempfile

_DBID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_dbid(dbid):
    return isinstance(dbid, str) and bool(_DBID.match(dbid))


def home_dir(environ=None):
    environ = os.environ if environ is None else environ
    return environ.get("HOME") or os.path.expanduser("~")


def app_support_root(environ=None):
    """`<HOME>/Library/Application Support/hfy_sync`."""
    return os.path.join(home_dir(environ), "Library", "Application Support", "hfy_sync")


def config_path(environ=None):
    return os.path.join(app_support_root(environ), "config.json")


class TreePaths:
    """Every per-tree path of sync.md 4.3 for one dbid."""

    def __init__(self, dbid, environ=None):
        if not valid_dbid(dbid):
            raise ValueError("not a usable database id")
        self.dbid = dbid
        self.root = app_support_root(environ)
        self.dir = os.path.join(self.root, dbid)
        self.sidecar = os.path.join(self.dir, "state.sqlite")
        self.lock = os.path.join(self.dir, "state.lock")
        self.status = os.path.join(self.dir, "status.json")
        self.previews = os.path.join(self.dir, "previews")
        self.backups = os.path.join(self.dir, "backups")
        self.logs = os.path.join(self.dir, "logs")
        self.cache = os.path.join(self.dir, "cache")
        self.config = os.path.join(self.root, "config.json")

    def status_for(self, run_id):
        """`<dbid>/status.<run_id>.json`: where a run that does not hold state.lock puts its refusal (None for an odd run id)."""
        return os.path.join(self.dir, "status.%s.json" % run_id) if valid_dbid(run_id) else None

    def ensure(self):
        """Creates the per-tree directories, owner-only: the sidecar holds projected family data."""
        for d in (self.root, self.dir, self.previews, self.backups, self.logs, self.cache):
            os.makedirs(d, mode=0o700, exist_ok=True)


def gramps_data_root(environ=None):
    """Where Gramps keeps `grampsdb`: `$GRAMPSHOME/gramps`, else `<HOME>/Library/Application Support/gramps` (const.py)."""
    environ = os.environ if environ is None else environ
    if environ.get("GRAMPSHOME"):
        return os.path.join(environ["GRAMPSHOME"], "gramps")
    return os.path.join(home_dir(environ), "Library", "Application Support", "gramps")


def find_tree(name, environ=None):
    """(dbid, directory) of the Gramps tree called `name`, or None. Reads only the small `name.txt` files."""
    root = os.path.join(gramps_data_root(environ), "grampsdb")
    if not os.path.isdir(root):
        return None
    for entry in sorted(os.listdir(root)):
        name_file = os.path.join(root, entry, "name.txt")
        if not os.path.isfile(name_file) or not valid_dbid(entry):
            continue
        try:
            with open(name_file, encoding="utf-8") as fh:
                found = fh.read().strip()
        except OSError:
            continue
        if found == name:
            return entry, os.path.join(root, entry)
    return None


def atomic_write_json(path, obj, mode=0o600):
    """Temp file in the same directory, fsync, rename: a reader sees the old file or the new one, never half of one."""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path):
    """The parsed file, or None when it does not exist. A damaged file raises ValueError."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("unreadable %s" % os.path.basename(path)) from exc
