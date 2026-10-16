"""What the Website sync gramplet shows and when it asks (HFY-TSK-278; sync.md 13, phase B). No Gtk here, so it is tested without a window.

The gramplet is read-only with ONE disclosed exception. It reads the sidecar's `last_pull_seq` (opened
read-only, so SQLite cannot create or change a file), its `own_pushes` and `runs` tables the same way, and `GET /api/sync/meta` (the website's `head_seq`). The number of website changes
waiting is the changes after `last_pull_seq` up to `head_seq` that the desktop did not make itself: each seq the website gave one of the desktop's own acknowledged
pushes is kept in the sidecar's `own_pushes` table (`base` holds only an object's newest seq, so it cannot be counted), so those seqs are taken off (never below zero). A push of two
updates with no website edit therefore shows none waiting. "Last sync" is the newest real `pull`, `push` or `sync` row of the
sidecar's `runs` table (a failed or partial real run counts too); bind, status and check are other actions, and a dry pull or push is marked dry in its row, so none of them moves it, and status.json,
which every run rewrites, is not used. It writes no status.json, no sidecar row, no tree object, no log and creates no
Keychain item. The exception: the website rotates the refresh token on every refresh, so when the access token has expired (about once
an hour of use: one TokenManager is kept for the life of the Model) the rotated refresh token is saved to the Keychain item that
already exists. This is the same code every run uses. The gramplet never deletes the Keychain item (a refused refresh shows the
sign-in prompt and leaves the item for the next run to judge), and it does not ask while a sync run holds state.lock, so it cannot
race a run on the rotating token. io has not yet confirmed this exception is acceptable (open item on HFY-TSK-278).

It asks the website at most once every POLL_INTERVAL_S and only while the gramplet is visible; a failed ask counts as an ask, so a
broken network is not retried faster. With no saved sign-in it shows a sign-in prompt, not an error. Everything shown is a code,
a count or a time, never object content.
"""
import calendar
import fcntl
import json
import os
import sqlite3
import time
import urllib.parse

from . import consts, keychain, oauth, paths, transport

POLL_INTERVAL_S = 300  # the most often the website is asked (sync.md 13.2)

# `state` values the gramplet can be in.
UNBOUND, SIGN_IN, READY, UNAVAILABLE = "unbound", "sign_in", "ready", "unavailable"


def read_last_pull_seq(tree_paths):
    """The sidecar's `last_pull_seq`, read through a read-only connection; None when there is no sidecar or it cannot be read."""
    if not os.path.exists(tree_paths.sidecar):
        return None
    uri = "file:%s?mode=ro" % urllib.parse.quote(tree_paths.sidecar)
    con = None
    try:
        con = sqlite3.connect(uri, uri=True, timeout=2)
        row = con.execute("SELECT value FROM meta WHERE key = 'last_pull_seq'").fetchone()
        return int(row[0]) if row else None
    except (sqlite3.Error, ValueError, TypeError):
        return None
    finally:
        if con is not None:
            con.close()


def _read_only(tree_paths):
    if not os.path.exists(tree_paths.sidecar):
        return None
    uri = "file:%s?mode=ro" % urllib.parse.quote(tree_paths.sidecar)
    try:
        return sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error:
        return None


def read_own_seqs(tree_paths, after, upto):
    """How many distinct seqs in (after, upto] are the desktop's own acknowledged pushes (rows of `own_pushes`, one per acknowledged seq,
    so two pushes of one object count twice); 0 when the table is missing (a sidecar from before it existed) or unreadable."""
    con = _read_only(tree_paths)
    if con is None:
        return 0
    try:
        row = con.execute("SELECT COUNT(DISTINCT seq) FROM own_pushes WHERE seq > ? AND seq <= ?", (int(after), int(upto))).fetchone()
        return int(row[0]) if row else 0
    except (sqlite3.Error, ValueError, TypeError):
        return 0
    finally:
        con.close()


def read_last_real_run(tree_paths):
    """(result, finished_at text) of the newest non-dry pull, push or sync row of the sidecar's `runs` table; (None, None) when there is none.

    A dry run is a row too (its counts_json carries `"dry_run": true`), so the newest few rows are read and the dry ones skipped."""
    con = _read_only(tree_paths)
    if con is None:
        return None, None
    try:
        for result, finished, counts in con.execute("SELECT result, finished_at, counts_json FROM runs WHERE action IN ('pull', 'push', 'sync') "
                                                    "ORDER BY finished_at DESC"):
            try:
                dry = bool((json.loads(counts) or {}).get("dry_run"))
            except (ValueError, TypeError, AttributeError):
                dry = False
            if not dry:
                return result, finished
        return None, None
    except sqlite3.Error:
        return None, None
    finally:
        con.close()


def run_in_progress(tree_paths):
    """True when a sync run holds state.lock. Read-only: the lock file is opened, never created, and only a shared lock is tried."""
    try:
        fh = open(tree_paths.lock, "rb")
    except OSError:
        return False
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        fh.close()


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
        """(result, finished_at epoch or None) of the last real pull, push or sync (the sidecar's runs table); (None, None) when none."""
        result, finished = read_last_real_run(self.tp)
        return (result if result in consts.RESULTS else None), parse_utc(finished)

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
        if run_in_progress(self.tp):
            return False  # a run owns the rotating token; ask again on the next tick
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
        return max(0, self.head_seq - pulled - read_own_seqs(self.tp, pulled, self.head_seq))

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


class _KeepKeychainItem:
    """The Keychain as the gramplet uses it: reads and the rotated-token save pass through, delete does nothing (see the module docstring)."""

    def __init__(self, inner):
        self._inner = inner

    def read(self):
        return self._inner.read()

    def delete(self):
        return None

    def __getattr__(self, name):
        return getattr(self._inner, name)


def client_factory(dbid, gramps_version, schema_version, environ=None, http=None, keychain_override=None):
    """A callable giving a transport.Client for this tree's server, signed in from the saved Keychain token.

    One Client (and so one oauth.TokenManager) is built on the first call and reused, so the access token is reused until it nears
    expiry and only then is the refresh token spent. The only thing a refresh changes is the rotated refresh token in the existing
    Keychain item; the item is never deleted from here. Nothing else is written.
    """
    cache = []

    def make():
        if cache:
            return cache[0]
        cfg = paths.read_json(paths.TreePaths(dbid, environ).config)
        server = transport.check_server((cfg or {}).get("server") or consts.DEFAULT_SERVER)
        kc = _KeepKeychainItem(keychain_override or keychain.open_for(server, environ))
        tokens = oauth.TokenManager(server, kc, http=http)
        cache.append(transport.Client(server, transport.Versions(gramps_version, schema_version), tokens, http=http))
        return cache[0]
    return make
