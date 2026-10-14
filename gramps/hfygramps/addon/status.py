"""status.json, the contract the CLI wrapper, the gramplet and io read (sync.md 4.3), and the run ids that tie it to a run."""
import secrets
import time

from . import consts, paths

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def utc_now(now=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))


def new_run_id(now=None):
    """A 26-character ULID: 48 bits of milliseconds, 80 bits of randomness; sorts by time."""
    millis = int((time.time() if now is None else now) * 1000)
    value = (millis << 80) | secrets.randbits(80)
    return "".join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def zero_counts():
    return {"pulled": {"create": 0, "update": 0, "delete": 0}, "pushed": {"create": 0, "update": 0, "delete": 0},
            "conflicts_open": 0, "holds": 0, "blocked": 0, "media_up": 0, "media_down": 0}


def build(run_id, action, mode, dbid, bound, result, exit_code, started_at, finished_at, *, dry_run=False, error=None,
          next_action="none", counts=None, versions=None, head_seq=0, snapshot_seq=0, backup=None):
    """A status.json document. `error` is {"code", "message"} only: no object content ever goes in here."""
    if result not in consts.RESULTS:
        raise ValueError("unknown result")
    if next_action not in consts.NEXT_ACTIONS:
        raise ValueError("unknown next_action")
    return {
        "schema": consts.STATUS_SCHEMA,
        "run_id": run_id,
        "action": action,
        "mode": mode,
        "dry_run": bool(dry_run),
        "started_at": started_at,
        "finished_at": finished_at,
        "result": result,
        "exit_code": int(exit_code),
        "tree": {"dbid": dbid, "bound": bool(bound)},
        "cloud": {"head_seq": head_seq, "snapshot_seq": snapshot_seq},
        "counts": counts if counts is not None else zero_counts(),
        "backup": backup,
        "error": error,
        "next_action": next_action,
        "versions": versions or {},
    }


def write(tree_paths, doc):
    """Atomically replaces `<dbid>/status.json`."""
    tree_paths.ensure()
    paths.atomic_write_json(tree_paths.status, doc)


def read(tree_paths):
    """The parsed status.json, None when absent, ValueError when damaged."""
    return paths.read_json(tree_paths.status)


def refusal(code):
    """(exit_code, next_action, error dict) for a catalog refusal."""
    exit_code, next_action, message = consts.REFUSALS[code]
    return exit_code, next_action, {"code": code, "message": message}


def exit_code_for(doc, run_id):
    """What the wrapper exits with: the document's `exit_code`, or 70 when it is missing or belongs to another run (D41)."""
    if not isinstance(doc, dict) or doc.get("run_id") != run_id:
        return consts.EXIT_INTERNAL
    code = doc.get("exit_code")
    return code if isinstance(code, int) and 0 <= code <= 255 else consts.EXIT_INTERNAL


def summary_line(doc):
    """One human line, counts and codes only."""
    err = doc.get("error") or {}
    bits = ["hfy-sync %s: %s" % (doc.get("action"), doc.get("result"))]
    if err:
        bits.append("%s %s" % (err.get("code", ""), err.get("message", "")))
    bits.append("(exit %s%s)" % (doc.get("exit_code"), ", next: %s" % doc["next_action"] if doc.get("next_action") not in (None, "none") else ""))
    return " ".join(b for b in bits if b)
