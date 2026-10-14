"""The refusals that happen before the addon reads anything (sync.md 8.3 step 1; error catalog D01, D02, D04, D14).

Pure functions and one lock helper; the Gramps shell and the wrapper call them. A refusal never partly runs.
"""
import fcntl
import getopt
import os
import shlex
import subprocess

from . import consts

# A Gramps process is the GUI unless it carries one of these: they make it a command-line run (gramps/cli/argparser.py).
_CLI_FLAGS = {"-a", "--action", "-i", "--import", "-e", "--export", "-l", "-L", "-t", "-v", "--version", "-?", "--help",
              "--usage", "-r", "--remove", "-s", "--show", "-c", "--config"}
_GUI_BINARY = "Gramps.app/Contents/MacOS/Gramps"


def force_unlock_requested(argv, shortopts=consts.GRAMPS_SHORTOPTS, longopts=consts.GRAMPS_LONGOPTS):
    """D02: True when Gramps would read `-u` or `--force-unlock` (or an unambiguous prefix of the long form) from `argv`.

    Uses getopt with Gramps' own option tables, so clusters such as `-yu` and abbreviations such as `--force-un` count. If
    getopt cannot parse the line, a plain scan of the tokens decides, and errs toward refusing.
    """
    args = list(argv[1:]) if argv else []
    try:
        opts, _rest = getopt.getopt(args, shortopts, longopts)
        return any(o in ("-u", "--force-unlock") for o, _v in opts)
    except getopt.GetoptError:
        for tok in args:
            if tok == "-u" or (tok.startswith("--") and "force-unlock".startswith(tok[2:].split("=")[0]) and len(tok) > 4):
                return True
        return False


def schema_supported(schema_version, gramps_series):
    """D04: the database schema is one the addon reads and Gramps is 6.0."""
    return schema_version in consts.SUPPORTED_DB_SCHEMAS and tuple(gramps_series[:2]) == consts.GRAMPS_SERIES


def ps_lines(environ=None):
    """Command lines of the running processes. `HFY_SYNC_PS_CMD` replaces `ps -axo command=` (a test seam; unset in use)."""
    environ = os.environ if environ is None else environ
    cmd = shlex.split(environ.get("HFY_SYNC_PS_CMD", "")) or ["ps", "-axo", "command="]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=10, check=False)
    return out.stdout.splitlines()


def gui_process_running(lines):
    """D01: True when any line is a Gramps.app process without a command-line action flag, i.e. the GUI."""
    for line in lines:
        if _GUI_BINARY not in line:
            continue
        try:
            tokens = shlex.split(line)
        except ValueError:
            tokens = line.split()
        flags = {t for t in tokens if t.startswith("-")}
        # -O alone opens the GUI on that tree, so it is not in the CLI set; a lone path argument does too.
        if not flags & _CLI_FLAGS:
            return True
    return False


class StateLock:
    """D14: `fcntl.flock` on `<dbid>/state.lock`, one run at a time. Use as a context manager; `acquired` says whether it holds."""

    def __init__(self, path):
        self.path = path
        self._fh = None
        self.acquired = False

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        self._fh = open(self.path, "a+")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.acquired = True
        except (BlockingIOError, OSError):
            self.acquired = False
        return self

    def __exit__(self, *exc):
        if self._fh is not None:
            if self.acquired:
                try:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            self._fh.close()
        return False
