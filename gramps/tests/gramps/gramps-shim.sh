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
#                         refuses and records any open, listdir, scandir or sqlite connect under them.
#   HFY_SHIM_AUDIT_LOG    file the hook appends to: "checked <n>" at exit and one "VIOLATION <event> <path>" per hit.
#   GRAMPSHOME, HOME      set by the caller to a throwaway directory (run.sh does this).
set -euo pipefail

APP="${HFY_GRAMPS_APP:-/Applications/Gramps.app}"
CONTENTS="$APP/Contents"
if [ ! -x "$CONTENTS/MacOS/Gramps" ] || [ ! -f "$CONTENTS/Resources/gramps_launcher.py" ]; then
  echo "[ERROR] Gramps bundle not found at $APP (set HFY_GRAMPS_APP)" >&2
  exit 2
fi

mode="${1:-}"
case "$mode" in
  --script) shift; [ $# -ge 1 ] || { echo "usage: $0 --script file.py [args...]" >&2; exit 2; }
            export HFY_SHIM_SCRIPT="$1"; shift ;;
  --cli)    shift ;;
  *)        echo "usage: $0 --script file.py [args...] | --cli [gramps args...]" >&2; exit 2 ;;
esac

SHIM="$(mktemp -d "${TMPDIR:-/tmp}/hfy-gramps-shim.XXXXXX")"
trap 'rm -rf "$SHIM"' EXIT
mkdir -p "$SHIM/Contents/MacOS" "$SHIM/Contents/Resources"
cp "$CONTENTS/MacOS/Gramps" "$SHIM/Contents/MacOS/Gramps"
cp "$CONTENTS/Info.plist" "$SHIM/Contents/Info.plist"
for d in etc include lib share; do ln -s "$CONTENTS/Resources/$d" "$SHIM/Contents/Resources/$d"; done
# A copied Mach-O loses its signature; arm64 refuses to run it unsigned.
codesign -s - --force "$SHIM/Contents/MacOS/Gramps" >/dev/null 2>&1

LAUNCHER="$SHIM/Contents/Resources/gramps_launcher.py"
# Stock launcher minus its final "import gramps.grampsapp as app" and "app.main()".
grep -v -e '^import gramps.grampsapp as app$' -e '^app.main()$' "$CONTENTS/Resources/gramps_launcher.py" > "$LAUNCHER"
cat >> "$LAUNCHER" <<'PYEOF'

import sys

_forbid = [p for p in environ.get("HFY_SHIM_FORBID", "").split(":") if p]
_log = environ.get("HFY_SHIM_AUDIT_LOG", "")
_state = {"checked": 0}


def _audit(event, args):
    if event == "open":
        target = args[0]
    elif event in ("os.listdir", "os.scandir"):
        target = args[0] if args else None
    elif event == "sqlite3.connect":
        target = args[0]
    else:
        return
    if isinstance(target, bytes):
        target = target.decode("utf-8", "replace")
    if not isinstance(target, str):
        return
    _state["checked"] += 1
    full = abspath(target)
    for prefix in _forbid:
        if full == prefix or full.startswith(prefix.rstrip("/") + "/"):
            with open(_log, "a") as fh:
                fh.write("VIOLATION %s %s\n" % (event, full))
            raise PermissionError("hfy shim: access to forbidden path %s" % full)


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

"$SHIM/Contents/MacOS/Gramps" "$@"
