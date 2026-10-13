#!/usr/bin/env bash
# Bundled-Gramps shim (HFY-TSK-228).
#
# Runs Python code or the Gramps CLI inside the Python 3.13 interpreter that is embedded in the
# Gramps.app bundle, so `import gramps` works without a system Gramps. The bundle's executable
# only ever runs Resources/gramps_launcher.py, so the shim builds a throwaway bundle that
# symlinks the real libraries and carries its own launcher. The launcher is the stock one with
# its last two lines replaced. Nothing in /Applications is modified.
#
#   gramps-shim.sh --script <file.py> [args...]   run a Python file under the bundle (sys.argv = [file, args...])
#   gramps-shim.sh --cli [gramps args...]         run the Gramps command line
#
# Environment:
#   HFY_GRAMPS_APP        path of Gramps.app (default /Applications/Gramps.app)
#   HFY_SHIM_FORBID       colon-separated path prefixes the process must never open. An audit hook
#                         refuses and records any open, listdir, scandir, sqlite connect, process start or
#                         exec that names a path under them.
#   HFY_SHIM_AUDIT_LOG    file the hook appends to: "checked <n>" at exit and one "VIOLATION <event> <path>" per hit.
#                         Required whenever HFY_SHIM_FORBID is set.
#   HFY_GRAMPS_ALLOW_VERSION=1  skip the bundle version check (the launcher rewrite below is coupled to 6.0.6).
#   GRAMPSHOME, HOME      a throwaway directory chosen by the caller (run.sh does this). When GRAMPSHOME
#                         is unset the shim sets both to a throwaway directory of its own, so a bare
#                         run never reads or writes the real Gramps folders.
#
# Limits of the audit hook: it compares the absolute path, then the realpath() (symlinks are
# resolved, path-like objects converted, sqlite "file:" URIs decoded) and covers open, listdir,
# scandir, sqlite3.connect, and the program, arguments and cwd of subprocess.Popen,
# os.posix_spawn, os.exec* and os.system. Python raises no audit event for os.stat or
# os.path.exists, so those are not covered, and a child process is only covered by what its command
# line shows. It is a tripwire for test code, not a sandbox.
set -euo pipefail

APP="${HFY_GRAMPS_APP:-/Applications/Gramps.app}"
CONTENTS="$APP/Contents"
if [ ! -x "$CONTENTS/MacOS/Gramps" ] || [ ! -f "$CONTENTS/Resources/gramps_launcher.py" ]; then
  echo "[ERROR] Gramps bundle not found at $APP (set HFY_GRAMPS_APP)" >&2
  exit 2
fi

if [ "${HFY_GRAMPS_ALLOW_VERSION:-0}" != "1" ] && ! grep -q 'Gramps-6\.0\.6' "$CONTENTS/Info.plist"; then
  echo "[ERROR] $APP is not Gramps 6.0.6 (the launcher rewrite is coupled to that bundle); set HFY_GRAMPS_ALLOW_VERSION=1 to override" >&2
  exit 2
fi
if [ -n "${HFY_SHIM_FORBID:-}" ] && [ -z "${HFY_SHIM_AUDIT_LOG:-}" ]; then
  echo "[ERROR] HFY_SHIM_FORBID needs HFY_SHIM_AUDIT_LOG (the hook records violations there)" >&2
  exit 2
fi

# The script path is only for --script; never inherit one from the caller's environment.
unset HFY_SHIM_SCRIPT
mode="${1:-}"
case "$mode" in
  --script) shift; [ $# -ge 1 ] || { echo "usage: $0 --script file.py [args...]" >&2; exit 2; }
            export HFY_SHIM_SCRIPT="$1"; shift ;;
  --cli)    shift ;;
  *)        echo "usage: $0 --script file.py [args...] | --cli [gramps args...]" >&2; exit 2 ;;
esac

SHIM_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hfy-gramps-shim.XXXXXX")"
trap 'rm -rf "$SHIM_ROOT"' EXIT
SHIM="$SHIM_ROOT/bundle"
mkdir -p "$SHIM/Contents/MacOS" "$SHIM/Contents/Resources"
cp "$CONTENTS/MacOS/Gramps" "$SHIM/Contents/MacOS/Gramps"
cp "$CONTENTS/Info.plist" "$SHIM/Contents/Info.plist"
for d in etc include lib share; do ln -s "$CONTENTS/Resources/$d" "$SHIM/Contents/Resources/$d"; done
# A copied Mach-O loses its signature; arm64 refuses to run it unsigned.
command -v codesign >/dev/null 2>&1 || { echo "[ERROR] codesign not found; this shim is macOS-only" >&2; exit 2; }
# Its output is captured, not written to a file: any extra file in the bundle root makes codesign refuse.
if ! sign_out="$(codesign -s - --force "$SHIM/Contents/MacOS/Gramps" 2>&1)"; then
  printf '%s\n' "$sign_out" >&2
  echo "[ERROR] codesign failed for the copied launcher executable" >&2
  exit 2
fi

LAUNCHER="$SHIM/Contents/Resources/gramps_launcher.py"
# Stock launcher minus its final "import gramps.grampsapp as app" and "app.main()".
grep -v -e '^import gramps.grampsapp as app$' -e '^app.main()$' "$CONTENTS/Resources/gramps_launcher.py" > "$LAUNCHER"
if grep -q 'grampsapp' "$LAUNCHER"; then
  echo "[ERROR] the stock launcher differs from the 6.0.6 layout (it still mentions grampsapp after filtering)" >&2
  exit 2
fi
cat >> "$LAUNCHER" <<'PYEOF'

import sys

import os as _os
from urllib.parse import unquote as _unquote, urlsplit as _urlsplit

# Each prefix both as written and resolved, so a symlinked home is caught either way.
_forbid = sorted({f(p) for p in environ.get("HFY_SHIM_FORBID", "").split(":") if p
                  for f in (_os.path.abspath, _os.path.realpath)})
_log = environ.get("HFY_SHIM_AUDIT_LOG", "")
_state = {"checked": 0}


def _under_forbidden(path):
    return any(path == p or path.startswith(p.rstrip("/") + "/") for p in _forbid)


def _hit(target, event):
    if isinstance(target, _os.PathLike):
        target = _os.fspath(target)
    if isinstance(target, bytes):
        target = target.decode("utf-8", "replace")
    if not isinstance(target, str) or not target:
        return
    if event == "sqlite3.connect" and target.startswith("file:"):
        # A URI filename: the path is the percent-decoded URI path, without its ?query.
        target = _unquote(_urlsplit(target).path)
        if not target:
            return
    _state["checked"] += 1
    # The lexical path first, so a forbidden path is refused without even a stat of the real folder.
    full = _os.path.abspath(target)
    if not _under_forbidden(full):
        full = _os.path.realpath(full)
        if not _under_forbidden(full):
            return
    with open(_log, "a") as fh:
        fh.write("VIOLATION %s %s\n" % (event, full))
    raise PermissionError("hfy shim: access to forbidden path %s" % full)


def _audit(event, args):
    if event in ("open", "os.listdir", "os.scandir", "sqlite3.connect"):
        if args:
            _hit(args[0], event)
    elif event in ("subprocess.Popen", "os.posix_spawn", "os.exec"):
        # Popen: (executable, args, cwd, env); posix_spawn and exec: (path, argv, env)
        _hit(args[0], event)
        argv = args[1]
        if isinstance(argv, (str, bytes, _os.PathLike)):
            argv = [argv]
        for a in (argv or []):
            _hit(a, event)
        if event == "subprocess.Popen":
            _hit(args[2], event)
    elif event == "os.system":
        for prefix in _forbid:
            if prefix in str(args[0]):
                with open(_log, "a") as fh:
                    fh.write("VIOLATION %s %s\n" % (event, args[0]))
                raise PermissionError("hfy shim: os.system names a forbidden path")


def _finish():
    if _log:
        with open(_log, "a") as fh:
            fh.write("checked %d\n" % _state["checked"])


if _forbid:
    import atexit

    sys.addaudithook(_audit)
    atexit.register(_finish)

_script = environ.get("HFY_SHIM_SCRIPT")
if _script:
    sys.argv = [_script] + sys.argv[1:]
    import runpy

    runpy.run_path(_script, run_name="__main__")
else:
    import gramps.grampsapp as app

    app.main()
PYEOF

# Without a caller-chosen GRAMPSHOME, Gramps would read its config and plugins from (and on a first
# run migrate data into) the user's real Gramps folders, so the shim then uses a throwaway home.
if [ -z "${GRAMPSHOME:-}" ]; then
  export GRAMPSHOME="$SHIM_ROOT/home"
  export HOME="$GRAMPSHOME"
  mkdir -p "$GRAMPSHOME"
fi

"$SHIM/Contents/MacOS/Gramps" "$@"
