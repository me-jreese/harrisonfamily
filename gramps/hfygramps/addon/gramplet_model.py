"""What the Website sync gramplet shows and when it asks (HFY-TSK-278; sync.md 13, phase B). No Gtk here, so it is tested without a window.

The gramplet is read-only. It reads `status.json` (the last run), the sidecar's `last_pull_seq` (opened read-only, so SQLite cannot
create or change a file) and `GET /api/sync/meta` (the website's `head_seq`). The number of website changes waiting is
`head_seq - last_pull_seq`, never below zero. It writes nothing: no status.json, no sidecar row, no tree object, no Keychain item.

It asks the website at most once every POLL_INTERVAL_S and only while the gramplet is visible; a failed ask counts as an ask, so a
broken network is not retried faster. With no saved sign-in it shows a sign-in prompt, not an error. Everything shown is a code,
a count or a time, never object content.
"""
import calendar
import os
import sqlite3
import time

from . import consts, keychain, oauth, paths, status, transport

POLL_INTERVAL_S = 300  # the most often the website is asked (sync.md 13.2)

# `state` values the gramplet can be in.
UNBOUND, SIGN_IN, READY, UNAVAILABLE = "unbound", "sign_in", "ready", "unavailable"


def read_last_pull_seq(tree_paths):
    """The sidecar's `last_pull_seq`, read through a read-only connection; None when there is no sidecar or it cannot be read."""
    if not os.path.exists(tree_paths.sidecar):
        return None
    uri = "file:%s?mode=ro" % tree_paths.sidecar.replace("?", "%3f").replace("#", "%23")
    con = None
    try:
        con = sqlite3.connect(uri, uri=True, timeout=2)
        row = con.execute("SELECT value FROM meta WHERE key = 'last_pull_seq'").fetchone()
        return int(row[0]) if row and str(row[0]).isdigit() else None
    except sqlite3.Error:
        return None
    finally:
        if con is not None:
            con.close()


def parse_utc(text):
    try:
        return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None


def ago(seconds):
    """A short age: 'just now', '5 minutes ago', '3 hours ago', '2 days ago'."""
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "just now"
    for size, unit in ((86400, "day"), (3600, "hour"), (60, "minute")):
        if seconds >= size:
            n = seconds // size
            return "%d %s%s ago" % (n, unit, "" if n == 1 else "s")
    return "just now"


class Model:
    """The gramplet's state. `client_factory()` returns a transport.Client (or raises); tests pass a fake. `clock()` is seconds."""

    def __init__(self, dbid, client_factory, environ=None, clock=time.time, interval=POLL_INTERVAL_S):
        self.tp = paths.TreePaths(dbid, environ)
        self.client_factory = client_factory
        self.clock = clock
        self.interval = interval
        self.last_poll = None  # clock value of the last ask (kept after a failure: no faster retry)
        self.head_seq = None
        self.state = UNBOUND
        self.polls = 0

    # -- what is on disk -------------------------------------------------------------------------------------------
    def last_run(self):
        """(result, finished_at epoch or None) from status.json; (None, None) when there is none or it is damaged."""
        try:
            doc = status.read(self.tp)
        except ValueError:
            return None, None
        if not isinstance(doc, dict):
            return None, None
        result = doc.get("result")
        return (result if result in consts.RESULTS else None), parse_utc(doc.get("finished_at"))

    def bound(self):
        try:
            cfg = paths.read_json(self.tp.config)
        except ValueError:
            return False
        return isinstance(cfg, dict) and cfg.get("dbid") == self.tp.dbid and os.path.exists(self.tp.sidecar)

    # -- asking the website ----------------------------------------------------------------------------------------
    def poll_due(self, visible):
        if not visible:
            return False
        return self.last_poll is None or self.clock() - self.last_poll >= self.interval

    def refresh(self, visible):
        """Asks the website when it is due. Returns True when it asked. Never raises."""
        if not self.bound():
            self.state = UNBOUND
            return False
        if self.state == UNBOUND:
            self.state = UNAVAILABLE
        if not self.poll_due(visible):
            return False
        self.last_poll = self.clock()
        self.polls += 1
        try:
            meta = self.client_factory().meta()
            self.head_seq = int(meta.get("head_seq")) if isinstance(meta, dict) and meta.get("head_seq") is not None else None
            self.state = READY if self.head_seq is not None else UNAVAILABLE
        except (oauth.AuthRequired, keychain.KeychainError):
            self.state, self.head_seq = SIGN_IN, None
        except transport.TransportError as exc:
            self.state = SIGN_IN if exc.status == 401 or exc.next_action == "login" else UNAVAILABLE
            self.head_seq = None
        except (ValueError, TypeError, OSError):
            self.state, self.head_seq = UNAVAILABLE, None
        return True

    def waiting(self):
        """Website changes not yet pulled, or None when unknown."""
        pulled = read_last_pull_seq(self.tp)
        if self.state != READY or self.head_seq is None or pulled is None:
            return None
        return max(0, self.head_seq - pulled)

    # -- what to show ----------------------------------------------------------------------------------------------
    def lines(self):
        """The gramplet's text lines."""
        if self.state == UNBOUND:
            return ["This tree is not bound to the website. Open Website sync to bind it."]
        out = []
        if self.state == SIGN_IN:
            out.append("Sign in to see the website's changes. Use Website sync, then Sign in (or hfy-sync login).")
        elif self.state == UNAVAILABLE:
            out.append("Website: changes unavailable right now.")
        else:
            n = self.waiting()
            if n is None:
                out.append("Website: changes unavailable right now.")
            else:
                out.append("Website: %d change%s waiting" % (n, "" if n == 1 else "s"))
        result, finished = self.last_run()
        if result is None:
            out.append("Last sync: none yet")
        else:
            out.append("Last sync: %s%s" % (result.replace("_", " "), ", " + ago(self.clock() - finished) if finished else ""))
        return out


def client_factory(dbid, gramps_version, schema_version, environ=None, http=None, keychain_override=None):
    """A callable giving a transport.Client for this tree's server, signed in from the saved Keychain token.

    The only thing a call can change is the rotated refresh token in the Keychain (oauth.TokenManager, the same code every run uses):
    the website rotates it on each refresh, so asking at all means keeping the new one. No tree, sidecar, status.json or log is written.
    """
    def make():
        cfg = paths.read_json(paths.TreePaths(dbid, environ).config)
        server = transport.check_server((cfg or {}).get("server") or consts.DEFAULT_SERVER)
        kc = keychain_override or keychain.open_for(server, environ)
        tokens = oauth.TokenManager(server, kc, http=http)
        return transport.Client(server, transport.Versions(gramps_version, schema_version), tokens, http=http)
    return make
