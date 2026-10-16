"""status.json, the contract the CLI wrapper, the gramplet and io read (sync.md 4.3), and the run ids that tie it to a run."""
import os
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


def write(tree_paths, doc, holds_lock=True):
    """Atomically replaces `<dbid>/status.json`.

    A run that does not hold state.lock (D14: another run does) writes `status.<run_id>.json` instead, so it can never replace the
    document of the run that is working; the wrapper looks for that file first.
    """
    tree_paths.ensure()
    target = tree_paths.status if holds_lock else (tree_paths.status_for(doc.get("run_id")) or tree_paths.status)
    paths.atomic_write_json(target, doc)


def read(tree_paths):
    """The parsed status.json, None when absent, ValueError when damaged."""
    return paths.read_json(tree_paths.status)


def read_run(tree_paths, run_id):
    """The document of run `run_id`: its own `status.<run_id>.json` (read once, then removed) or else status.json."""
    own = tree_paths.status_for(run_id)
    if own and os.path.exists(own):
        try:
            return paths.read_json(own)
        finally:
            try:
                os.unlink(own)
            except OSError:
                pass
    return read(tree_paths)


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
    if doc.get("action") in consts.PULL_ACTIONS:
        # What io needs to act on the run: the run id (`sync --yes --plan <run id>` names it) and the counts. Never a value.
        c = doc.get("counts") or {}
        p = c.get("pulled") or {}
        bits.append("run %s; from the website: %s new, %s changed, %s deleted; conflicts open: %s" % (
            doc.get("run_id"), p.get("create", 0), p.get("update", 0), p.get("delete", 0), c.get("conflicts_open", 0)))
    return " ".join(b for b in bits if b)
