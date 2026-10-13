"""Negative controls for run.sh: the audit hook must refuse a forbidden path, and log it.

    probe_forbidden_path.py audit <path>    raise the "open" audit event for <path> exactly as open()
                                            does, without opening anything (run.sh points this at the
                                            real grampsdb, so even a broken hook touches nothing there)
    probe_forbidden_path.py open <path>     really open <path> (run.sh points this at an existing file
                                            in a throwaway directory it forbids for this run only)
    probe_forbidden_path.py sqlite <path>   sqlite3.connect a read-only "file:" URI of <path>

Exit 0 when the hook refused the access, 1 when it did not.
"""
import pathlib
import sqlite3
import sys

mode, path = sys.argv[1], sys.argv[2]
try:
    if mode == "audit":
        sys.audit("open", path, "r", 0)
    elif mode == "open":
        open(path, "rb").close()
    elif mode == "sqlite":
        sqlite3.connect(pathlib.Path(path).as_uri() + "?mode=ro", uri=True).close()
    else:
        raise SystemExit(__doc__)
except PermissionError as exc:
    if "hfy shim" not in str(exc):
        print("refused, but not by the hook: %s" % exc)
        sys.exit(1)
    print("blocked")
    sys.exit(0)
except OSError as exc:
    print("not blocked: %s" % exc)
    sys.exit(1)
print("not blocked")
sys.exit(1)
