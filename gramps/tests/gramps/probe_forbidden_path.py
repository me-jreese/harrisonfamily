"""Negative control for run.sh: opening a forbidden path under the audit hook must fail and be logged."""
import sys

path = sys.argv[1]
try:
    open(path)
except PermissionError:
    print("blocked")
    sys.exit(0)
except OSError as exc:  # the path may not exist; the hook fires before the open itself
    print("not blocked: %s" % exc)
    sys.exit(1)
print("not blocked")
sys.exit(1)
