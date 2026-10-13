"""The Gramps bundle shim (HFY-TSK-249): import Gramps 6.0.6 from the installed Gramps.app bundle, headless.

Gramps.app ships its own Python 3.13 site-packages, whose native libraries (GLib, GObject) are found only through the
bundle. Running a script against it takes four things, which `activate()` does:

1. Python 3.13, to match the bundle's ABI (Homebrew's `python3.13` works; the bundle's own interpreter is not
   needed). A script run by another interpreter is re-executed under `python3.13`.
2. `DYLD_LIBRARY_PATH` pointed at the bundle's `lib/`, set before the interpreter starts (macOS strips it for
   protected binaries, not for Homebrew Python), so the script re-executes itself once with it set.
3. `locale.textdomain` and `locale.bindtextdomain`, which Homebrew's Python lacks, replaced by no-ops.
4. `GRAMPSHOME` pointed at a fresh temporary directory, so Gramps never reads or writes the user's real settings or
   trees. The directory is removed when the script exits.

Environment: `GRAMPS_BUNDLE` (default `/Applications/Gramps.app/Contents/Resources`) and `GRAMPS_PYTHON` (a path to
a Python 3.13) override the defaults.

This module opens no tree and reads no family data. The same shim serves the other Gramps generators under
`scripts/records/`. Usage, from the top of a script:

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import gramps_shim
    gramps_shim.activate()
    from gramps.gen.lib import Date
"""

import atexit
import locale
import os
import shutil
import sys
import tempfile

BUNDLE = os.environ.get("GRAMPS_BUNDLE", "/Applications/Gramps.app/Contents/Resources")
REQUIRED_VERSION = "6.0.6"
_CANDIDATES = ("/opt/homebrew/bin/python3.13", "/usr/local/bin/python3.13", "/usr/bin/python3.13")


def _find_python():
    for cand in (os.environ.get("GRAMPS_PYTHON"),) + _CANDIDATES:
        if cand and os.access(cand, os.X_OK):
            return cand
    raise SystemExit("gramps_shim: Python 3.13 not found (set GRAMPS_PYTHON); the Gramps.app bundle is built for 3.13")


def activate():
    """Make `import gramps` work. Re-executes the calling script when the interpreter or environment is wrong."""
    site = os.path.join(BUNDLE, "lib", "python3.13", "site-packages")
    lib = os.path.join(BUNDLE, "lib")
    if not os.path.isdir(site):
        raise SystemExit("gramps_shim: no Gramps bundle at %s (set GRAMPS_BUNDLE)" % BUNDLE)
    env = dict(os.environ)
    dyld = [p for p in env.get("DYLD_LIBRARY_PATH", "").split(":") if p]
    if sys.version_info[:2] != (3, 13) or lib not in dyld:
        env["DYLD_LIBRARY_PATH"] = ":".join([lib] + dyld)
        env["GI_TYPELIB_PATH"] = os.path.join(lib, "girepository-1.0")
        py = sys.executable if sys.version_info[:2] == (3, 13) else _find_python()
        os.execve(py, [py] + sys.argv, env)
    home = tempfile.mkdtemp(prefix="hfy-gramps-home-")
    atexit.register(shutil.rmtree, home, ignore_errors=True)
    os.environ["GRAMPSHOME"] = home
    sys.path.insert(0, site)
    for fn in ("textdomain", "bindtextdomain"):
        if not hasattr(locale, fn):
            setattr(locale, fn, lambda *a, **k: None)
    from gramps.version import VERSION  # noqa: E402

    if VERSION != REQUIRED_VERSION:
        raise SystemExit("gramps_shim: Gramps %s found, %s required (the goldens are version-pinned)" % (VERSION, REQUIRED_VERSION))
    return VERSION
