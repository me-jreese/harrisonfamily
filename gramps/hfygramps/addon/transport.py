"""HTTPS transport of the desktop addon (sync.md 7.1, 8.1, 8.3; HFY-TSK-180).

    make_ssl_context()   urllib's default context; when its trust store is empty (Gramps' bundled Python has no CA bundle, R2-08)
                         the system file /etc/ssl/cert.pem is added. Certificate and hostname checks are never switched off.
    Http                 one request with retries: idempotent calls retry three times at 1, 4 and 16 s, only on network errors and
                         on 503 `retryable`. Redirects are refused, so a bearer token never follows a Location header.
    Client               the sync API: every call carries the handshake headers of sync.md 7.1 and a bearer token.

Failures raise `TransportError`, which carries the wrapper's exit code and next_action (sync.md 8.7): 401 and 403
`step_up_required` -> 77, 426 -> 78. Messages hold a status and an error code from the response, never a response body, a
token or a header value. Standard library only; Python 3.9 compatible.
"""
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from . import consts

MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024  # a presigned snapshot or media file (get_bytes); the API's own JSON stays under MAX_BODY_BYTES
# Cloudflare answers urllib's default `Python-urllib/x.y` agent with its own 403 (error 1010) before the origin sees the request
# (probe, HFY-TSK-180, DL-31); any request the addon makes names itself instead.
USER_AGENT = "hfy_sync/%s" % consts.ADDON_VERSION
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class TransportError(Exception):
    """A failed call. `code` is a short word (an API error code or one of ours), never response content."""

    def __init__(self, code, exit_code, next_action="none", status=None, message=None, details=None):
        self.code = code
        self.exit_code = exit_code
        self.next_action = next_action
        self.status = status
        # The `details` member of an error body ({error, message, details?}, api/src/http.js), kept as data for a caller that acts on
        # it (the push reads the op ids and pointers of a 409 or a 422). It is never part of the message or of any log line.
        self.details = details if isinstance(details, dict) else None
        self.message = message or "The call failed (%s)." % code
        Exception.__init__(self, "%s (%s)" % (self.message, code))


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers  # lower-cased names
        self.body = body  # decoded JSON, or None when the body was empty or not JSON


# ---------------------------------------------------------------------------------------------------------------- TLS


def _has_roots(ctx):
    try:
        return ctx.cert_store_stats().get("x509_ca", 0) > 0
    except (ssl.SSLError, ValueError):
        return False


def make_ssl_context(cafile=consts.SYSTEM_CA_FILE, factory=None):
    """A verifying context. `factory` stands in for ssl.create_default_context in tests."""
    ctx = (factory or ssl.create_default_context)()
    if not _has_roots(ctx) and cafile and os.path.isfile(cafile):
        ctx.load_verify_locations(cafile=cafile)  # adds to the (empty) default store
    if ctx.verify_mode != ssl.CERT_REQUIRED or not ctx.check_hostname:
        raise TransportError("tls_not_verifying", consts.EXIT_INTERNAL, message="TLS verification is off; refusing to send anything.")
    return ctx


# ------------------------------------------------------------------------------------------------------- error mapping


def map_error(status, code):
    """(exit_code, next_action) for an HTTP error. Only the first three rows are fixed by the task; the rest follow sync.md 8.7."""
    if status == 401:
        return consts.EXIT_SIGN_IN, "login"
    if status == 403 and code == "step_up_required":
        return consts.EXIT_SIGN_IN, "step_up"
    if status == 426 or code in ("redaction_version_mismatch", "upgrade_required"):
        return consts.EXIT_CONFIG, "update_addon"
    if status == 403:
        return consts.EXIT_CONFIG, ("rebase" if code == "tree_mismatch" else "none")  # D50: a recovered or re-seeded store is another cloud tree
    if code == "sync_paused" or (status == 404 and code == "not_enabled"):
        return consts.EXIT_NOT_ENABLED, "none"
    if status in (400, 413, 422):
        return consts.EXIT_SERVER_REFUSED, "none"
    if status == 409 or status >= 500:
        return consts.EXIT_TEMPORARY, "retry"
    return consts.EXIT_INTERNAL, "none"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _is_tls_failure(exc):
    reason = getattr(exc, "reason", exc)
    return isinstance(reason, ssl.SSLCertVerificationError) or isinstance(reason, ssl.CertificateError) or (
        isinstance(reason, ssl.SSLError) and "CERTIFICATE_VERIFY_FAILED" in str(reason))


def _read(fp, cap=MAX_BODY_BYTES):
    data = fp.read(cap + 1)
    if len(data) > cap:
        raise TransportError("body_too_large", consts.EXIT_INTERNAL)
    return data


def _json_or_none(data):
    if not data:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


class Http:
    """Sends one request, with retries when the caller says the call is idempotent. No auth or API knowledge here."""

    def __init__(self, ssl_context=None, timeout=consts.HTTP_TIMEOUT_S, delays=consts.RETRY_DELAYS_S, sleep=time.sleep):
        self.ssl_context = ssl_context or make_ssl_context()
        self.timeout = timeout
        self.delays = tuple(delays)
        self.sleep = sleep
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self.ssl_context), _NoRedirect())
        self.attempts = 0  # of the last send(), for tests and the run log

    def send(self, method, url, headers=None, data=None, idempotent=False):
        """Returns a Response for a 2xx, raises TransportError otherwise."""
        schedule = list(self.delays) if idempotent else []
        self.attempts = 0
        while True:
            self.attempts += 1
            try:
                return self._once(method, url, headers or {}, data)
            except _Retryable as retry:
                if not schedule:
                    raise retry.final
                self.sleep(schedule.pop(0))

    def get_bytes(self, url, headers=None):
        """GET of a presigned URL: the raw body, with the same retries as any idempotent call. The caller sends no Authorization
        header here, the URL is the credential (and a bearer token must never go to S3)."""
        self.attempts = 0
        schedule = list(self.delays)
        while True:
            self.attempts += 1
            try:
                return self._once("GET", url, headers or {}, None, raw=True).body
            except _Retryable as retry:
                if not schedule:
                    raise retry.final
                self.sleep(schedule.pop(0))

    def _once(self, method, url, headers, data, raw=False):
        headers = dict(headers)
        if not any(k.lower() == "user-agent" for k in headers):
            headers["User-Agent"] = USER_AGENT
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                if raw:
                    return Response(resp.status, {k.lower(): v for k, v in resp.headers.items()}, _read(resp, MAX_DOWNLOAD_BYTES))
                return Response(resp.status, {k.lower(): v for k, v in resp.headers.items()}, _json_or_none(_read(resp)))
        except urllib.error.HTTPError as exc:
            try:
                body = _json_or_none(_read(exc))
            finally:
                exc.close()
            return self._http_error(exc.code, body, {k.lower(): v for k, v in exc.headers.items()})
        except TransportError:
            raise
        except urllib.error.URLError as exc:
            if _is_tls_failure(exc):
                raise TransportError("tls_verify_failed", consts.EXIT_CONFIG, status=None,
                                     message="The server's certificate could not be verified; nothing was sent.")
            raise _Retryable(TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed."))
        except ssl.SSLCertVerificationError:
            raise TransportError("tls_verify_failed", consts.EXIT_CONFIG, message="The server's certificate could not be verified; nothing was sent.")
        except (OSError, socket.timeout, ValueError) as exc:  # connection reset, timeout, truncated body, http.client errors
            if isinstance(exc, ValueError):
                raise TransportError("bad_request", consts.EXIT_INTERNAL, message="The request could not be built.")
            raise _Retryable(TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed."))
        except Exception as exc:  # noqa: BLE001 - http.client.HTTPException and friends are transient too
            if exc.__class__.__module__ == "http.client":
                raise _Retryable(TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed."))
            raise

    def _http_error(self, status, body, headers):
        code = body.get("error") if isinstance(body, dict) else None
        code = code if isinstance(code, str) and _CODE.match(code) else "http_%d" % status
        if status == 503 and code == "retryable":
            raise _Retryable(TransportError("retryable", consts.EXIT_TEMPORARY, "retry", status=503, message="The website is busy (503)."))
        if 300 <= status < 400:
            raise TransportError("unexpected_redirect", consts.EXIT_INTERNAL, status=status, message="The server answered with a redirect; refusing to follow it.")
        exit_code, next_action = map_error(status, code)
        raise TransportError(code, exit_code, next_action, status=status, message="The website answered %d (%s)." % (status, code),
                             details=body.get("details") if isinstance(body, dict) else None)


class _Retryable(Exception):
    def __init__(self, final):
        Exception.__init__(self)
        self.final = final


# ------------------------------------------------------------------------------------------------------------ the API


class Versions:
    """The values of the handshake headers (sync.md 7.1). `tree_id` may be unknown before the first bind."""

    def __init__(self, gramps_version, db_schema, tree_id=None, addon_version=consts.ADDON_VERSION,
                 redaction_version=consts.REDACTION_VERSION):
        self.gramps_version = str(gramps_version)
        self.db_schema = int(db_schema)
        self.tree_id = tree_id
        self.addon_version = addon_version
        self.redaction_version = int(redaction_version)

    def headers(self):
        out = {
            "X-HFY-Sync-Client": "hfy_sync/%s" % self.addon_version,
            "X-HFY-Gramps-Version": self.gramps_version,
            "X-HFY-Gramps-Schema": str(self.db_schema),
            "X-HFY-Redaction-Version": str(self.redaction_version),
        }
        if self.tree_id:
            out["X-HFY-Tree-Id"] = self.tree_id  # absent only for the calls that precede the bind (meta, bind)
        return out


def check_server(server):
    """The server base URL without a trailing slash. https only; plain http only to a loopback host (the local dev server)."""
    parsed = urllib.parse.urlsplit(server)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("the sync server must be an https URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("the sync server URL must be a bare origin")
    return server.rstrip("/")


class Client:
    """Calls /api/sync/*. `token_provider()` returns a current access token (oauth.TokenManager.access_token)."""

    def __init__(self, server, versions, token_provider, http=None):
        self.server = check_server(server)
        self.versions = versions
        self.token_provider = token_provider
        self.http = http or Http()

    def request(self, method, path, body=None, query=None, idempotency_key=None, extra_headers=None):
        """One API call. GET and calls with an Idempotency-Key are idempotent and retry; any other POST is sent once."""
        if not path.startswith("/api/sync/"):
            raise ValueError("not a sync API path")
        url = self.server + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = dict(self.versions.headers())
        headers["Accept"] = "application/json"
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        headers.update(extra_headers or {})
        idempotent = method in ("GET", "HEAD") or bool(idempotency_key)
        headers["Authorization"] = "Bearer %s" % self.token_provider()
        try:
            return self.http.send(method, url, headers, data, idempotent=idempotent)
        except TransportError as exc:
            # A 401 before the local expiry (revocation, clock skew): refresh once and replay. Only a call that is safe to repeat
            # (GET, or the same Idempotency-Key) is replayed; the provider must be able to force a refresh.
            refresh = getattr(self.token_provider, "refresh", None)
            if exc.status != 401 or not idempotent or refresh is None:
                raise
            headers["Authorization"] = "Bearer %s" % refresh()
            return self.http.send(method, url, headers, data, idempotent=idempotent)

    def get(self, path, query=None):
        return self.request("GET", path, query=query)

    def post(self, path, body=None, idempotency_key=None):
        return self.request("POST", path, body=body, idempotency_key=idempotency_key)

    def meta(self):
        return self.get("/api/sync/meta").body
