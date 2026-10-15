"""Support for the end-to-end scenarios (HFY-TSK-181): the local sync dev server as a subprocess, a sign-in with no browser or Keychain,
the addon's own transport pointed at the server, and the request log the privacy checks grep.

    DevServer          starts api/scripts/sync-dev-server.mjs on an ephemeral 127.0.0.1 port with its own temporary data directory, reads
                       its ready line, stops it, and reads the request log it writes (every request body, one JSON object per line).
    sign_in()          the real `oauth.login` (PKCE, the loopback callback, the code exchange) against the dev /auth endpoints, with the
                       browser replaced by a stub that follows the redirect itself and a Keychain held in memory. Returns a Session.
    Session            a TokenManager and the transport Client built the way the addon builds them, for the sync routes.
    read_snapshot()    downloads a snapshot URL and verifies it the way the addon will (gzip, header, body hash, count).

Standard library plus gramps/hfygramps/addon (which is standard library only), so the unit tests can import this module without Gramps or
node; only DevServer.start() needs node and api/node_modules. Written for Python 3.9 or later (CI's stock python3 and the Gramps bundle's).
"""
import gzip
import hashlib
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO_ROOT = os.path.abspath(os.path.join(GRAMPS_DIR, ".."))
SERVER_SCRIPT = os.path.join(REPO_ROOT, "api", "scripts", "sync-dev-server.mjs")
if GRAMPS_DIR not in sys.path:
    sys.path.insert(0, GRAMPS_DIR)

from hfygramps.addon import consts, oauth, transport  # noqa: E402

START_TIMEOUT_S = 30
STOP_TIMEOUT_S = 10

# The server is on loopback: a proxy named in the environment (or the system's) must never see its traffic.
for _name in ("no_proxy", "NO_PROXY"):
    _cur = os.environ.get(_name, "")
    if "127.0.0.1" not in _cur:
        os.environ[_name] = (_cur + "," if _cur else "") + "127.0.0.1,localhost"


class DevServerError(Exception):
    pass


def node_available():
    """The path of node 22 or later, or None."""
    node = shutil.which("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=20).stdout
        return node if int(out.strip().lstrip("v").split(".")[0]) >= 22 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def server_dependencies_installed():
    return os.path.isdir(os.path.join(REPO_ROOT, "api", "node_modules", "jose"))


_LOOPBACK = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _call(method, url, body=None, headers=None, timeout=30):
    """(status, bytes) of a loopback call that bypasses any proxy; an HTTP error is returned as its status, not raised."""
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode("utf-8"))
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with _LOOPBACK.open(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read()
        finally:
            exc.close()


class DevServer:
    """One dev server process. Use as a context manager, or call start() and stop().

    `command` replaces the node command line (unit tests use a stub that prints a ready line). `extra_args` are options of the script
    (`--access-ttl 30`, `--id-policy mint`).
    """

    def __init__(self, extra_args=(), command=None, start_timeout=START_TIMEOUT_S):
        self.extra_args = list(extra_args)
        self.command = command
        self.start_timeout = start_timeout
        self.proc = None
        self.ready = None
        self.work_dir = None  # ours: the server's data directory, its stderr, nothing else

    # ------------------------------------------------------------------------------------------------------ lifecycle

    def start(self):
        if self.proc is not None:
            raise DevServerError("already started")
        self.work_dir = tempfile.mkdtemp(prefix="hfy-e2e-dev-")
        os.chmod(self.work_dir, 0o700)
        data_dir = os.path.join(self.work_dir, "data")
        err = open(os.path.join(self.work_dir, "stderr.txt"), "wb")
        if self.command is not None:
            cmd = list(self.command)
        else:
            node = node_available()
            if not node:
                self._cleanup()
                raise DevServerError("node 22 or later is needed to run the sync dev server")
            if not server_dependencies_installed():
                self._cleanup()
                raise DevServerError("api/node_modules is missing: run 'cd api && npm ci' first")
            cmd = [node, SERVER_SCRIPT, "--port", "0", "--data-dir", data_dir] + self.extra_args
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err, cwd=self.work_dir)
        except OSError as exc:
            err.close()
            self._cleanup()
            raise DevServerError("could not start the dev server (%s)" % type(exc).__name__)
        finally:
            err.close()
        try:
            self.ready = self._read_ready()
        except BaseException:
            self.stop()
            raise
        return self

    def _read_ready(self):
        deadline = time.monotonic() + self.start_timeout
        buf = b""
        fd = self.proc.stdout.fileno()
        while time.monotonic() < deadline:
            if self.proc.poll() is not None and not buf:
                raise DevServerError("the dev server exited with %s before it was ready: %s" % (self.proc.returncode, self.stderr_text()[-600:]))
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                chunk = os.read(fd, 4096)
                if not chunk:
                    raise DevServerError("the dev server closed its output before it was ready: %s" % self.stderr_text()[-600:])
                buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    doc = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if isinstance(doc, dict) and doc.get("event") == "ready":
                    return doc
        raise DevServerError("the dev server was not ready within %d s: %s" % (self.start_timeout, self.stderr_text()[-600:]))

    def stderr_text(self):
        try:
            with open(os.path.join(self.work_dir, "stderr.txt"), encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except (OSError, TypeError):
            return ""

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(STOP_TIMEOUT_S)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            if proc.stdout:
                proc.stdout.close()
        self._cleanup()

    def _cleanup(self):
        if self.work_dir and os.environ.get("HFY_KEEP") != "1":
            shutil.rmtree(self.work_dir, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    # ---------------------------------------------------------------------------------------------------------- facts

    @property
    def origin(self):
        return self.ready["origin"]

    @property
    def log_file(self):
        return self.ready["log_file"]

    @property
    def data_dir(self):
        return self.ready["data_dir"]

    # ------------------------------------------------------------------------------------------------------ the log

    def log_text(self):
        """The whole request log as written."""
        with open(self.log_file, encoding="utf-8") as fh:
            return fh.read()

    def entries(self):
        """Every logged request, oldest first, as dicts."""
        return [json.loads(line) for line in self.log_text().splitlines() if line.strip()]

    def requests(self, method=None, path=None, status=None):
        """The logged requests matching all the given fields (path may end in '*' for a prefix)."""
        out = []
        for e in self.entries():
            if method and e.get("method") != method:
                continue
            if path and not (e.get("path", "").startswith(path[:-1]) if path.endswith("*") else e.get("path") == path):
                continue
            if status is not None and e.get("status") != status:
                continue
            out.append(e)
        return out

    def grep(self, needle):
        """The log lines (as text) that contain `needle`: the same grep the design describes, with the line number."""
        return [(i + 1, line) for i, line in enumerate(self.log_text().splitlines()) if needle in line]

    # --------------------------------------------------------------------------------------------------- dev controls

    def get_json(self, path):
        status, body = _call("GET", self.origin + path)
        return status, (json.loads(body.decode("utf-8")) if body else None)

    def patch_json(self, path, doc):
        status, body = _call("PATCH", self.origin + path, doc, {"Content-Type": "application/json"})
        return status, (json.loads(body.decode("utf-8")) if body else None)

    def set_head(self, **switches):
        """Sets SYNC#HEAD switches (writes_enabled, seeded, merges_enabled, min_client, ...); returns the head."""
        status, doc = self.patch_json("/_dev/head", switches)
        if status != 200:
            raise DevServerError("the head switch was refused (%s)" % status)
        return doc["head"]

    def state(self):
        status, doc = self.get_json("/_dev/state")
        if status != 200:
            raise DevServerError("state refused (%s)" % status)
        return doc


# ---------------------------------------------------------------------------------------------------------------- sign-in


class MemoryKeychain:
    """The Keychain interface (store, read, delete) over a variable: a scenario never touches the login Keychain."""

    def __init__(self):
        self.token = None
        self.stores = 0

    def store(self, token, recreate=False):
        self.token = token
        self.stores += 1

    def read(self):
        return self.token

    def delete(self):
        self.token = None


class BrowserStub:
    """Stands in for webbrowser.open: sends the authorize request itself and delivers the redirect to the loopback callback.

    The callback is fetched on a thread, because oauth.login only starts serving it after open_browser returns.
    """

    def __init__(self):
        self.urls = []
        self.thread = None
        self.error = None

    def __call__(self, url):
        self.urls.append(url)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            resp = opener.open(url, timeout=15)
            location = resp.headers.get("Location")
            resp.close()
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location")
            exc.close()
        if not location:
            self.error = "the authorize endpoint did not redirect"
            return False
        self.thread = threading.Thread(target=self._deliver, args=(location,), daemon=True)
        self.thread.start()
        return True

    def _deliver(self, location):
        try:
            _call("GET", location, timeout=15)
        except Exception as exc:  # noqa: BLE001 - reported through .error; the login itself times out or fails on its own
            self.error = type(exc).__name__


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Session:
    """A signed-in addon transport: the token manager and the client of sync.md 7.1, over a MemoryKeychain."""

    def __init__(self, origin, tokens, keychain, versions, http):
        self.origin = origin
        self.tokens = tokens
        self.keychain = keychain
        self.versions = versions
        self.http = http

    def client(self, tree_id=None):
        self.versions.tree_id = tree_id
        return transport.Client(self.origin, self.versions, self.tokens, http=self.http)


def make_versions(gramps_version="6.0.6", db_schema=21):
    return transport.Versions(gramps_version, db_schema)


def sign_in(server, step_up=False, versions=None, timeout=30):
    """Runs oauth.login against `server` (a DevServer) and returns a Session. Fails the way the addon would if the endpoints misbehave."""
    keychain = MemoryKeychain()
    http = transport.Http(delays=())  # no retries: a scenario wants the first answer
    browser = BrowserStub()
    got = oauth.login(server.origin, keychain, http=http, open_browser=browser, timeout=timeout, step_up=step_up)
    if browser.thread is not None:
        browser.thread.join(10)
    tokens = oauth.TokenManager(server.origin, keychain, http=http)
    tokens.seed(got["access_token"], got["expires_in"])
    return Session(server.origin, tokens, keychain, versions or make_versions(), http)


# ---------------------------------------------------------------------------------------------------------------- snapshot


def fetch_bytes(url):
    """GET a presigned URL (no Authorization header) and return its bytes; raises DevServerError for a non-200."""
    status, body = _call("GET", url)
    if status != 200:
        raise DevServerError("the snapshot URL answered %d" % status)
    return body


def read_snapshot(url, expect):
    """Downloads and verifies a snapshot the way sync.md 8.3 step 3 says: returns (header, [object lines as dicts]).

    `expect` is the snapshot route's answer ({seq, body_sha256, count}). Raises AssertionError-like ValueError on a mismatch.
    """
    raw = gzip.decompress(fetch_bytes(url))
    head_line, _, body = raw.partition(b"\n")
    header = json.loads(head_line.decode("utf-8"))
    if header.get("type") != "header":
        raise ValueError("the first line is not the header")
    if hashlib.sha256(body).hexdigest() != header["body_sha256"] or header["body_sha256"] != expect["body_sha256"]:
        raise ValueError("the body does not hash to body_sha256")
    lines = [json.loads(line.decode("utf-8")) for line in body.split(b"\n") if line]
    if header["count"] != len(lines) or header["count"] != expect["count"]:
        raise ValueError("the count does not match the body")
    if header["seq"] != expect["seq"]:
        raise ValueError("the seq does not match")
    return header, lines
