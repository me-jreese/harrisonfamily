"""Sign-in of the desktop addon: PKCE loopback login and the token manager (sync.md 8.5; HFY-TSK-180).

    login()          PKCE S256 + `state`, a one-shot http.server on 127.0.0.1 on an ephemeral port (the client is registered for any
                     loopback port, SI-39), the system browser at /auth/authorize, a five-minute wait, then the code exchange at
                     /auth/token. The refresh token goes to the Keychain; the access token stays in memory.
    TokenManager     hands out the access token; refreshes it with the stored refresh token. Refresh tokens rotate, so the new one
                     is written to the Keychain (and read back) BEFORE the new access token is used. A refresh is never retried: a
                     lost response would leave the rotated token unknown and the next try would revoke the family. A reused or
                     revoked token (`invalid_grant`) is "sign in again" (exit 77); the dead token is removed.

`login --step-up` adds `prompt=login&max_age=300`. Standard library only; Python 3.9 compatible.
"""
import base64
import hashlib
import hmac
import http.server
import json
import secrets
import threading
import time
import urllib.parse
import webbrowser

from . import consts, transport
from .keychain import KeychainError

CALLBACK_PATH = "/callback"
_PAGE = (b"<!doctype html><meta charset=utf-8><title>hfy-sync</title><p>%s</p>")


class AuthRequired(transport.TransportError):
    """Sign in (or step up) again."""

    def __init__(self, code="not_signed_in", next_action="login", message="Sign in again with hfy-sync login."):
        transport.TransportError.__init__(self, code, consts.EXIT_SIGN_IN, next_action, message=message)


class LoginError(transport.TransportError):
    pass


def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def pkce_pair():
    """(verifier, S256 challenge); the verifier is 43 characters of base64url."""
    verifier = _b64u(secrets.token_bytes(32))
    return verifier, _b64u(hashlib.sha256(verifier.encode("ascii")).digest())


def sync_resource(server):
    """The resource indicator (RFC 8707) for a server: <server>/api/sync, so the token audience matches the host that gets it."""
    return transport.check_server(server) + "/api/sync"


def authorize_url(server, redirect_uri, challenge, state, step_up=False):
    params = [
        ("response_type", "code"), ("client_id", consts.OAUTH_CLIENT_ID), ("redirect_uri", redirect_uri),
        ("code_challenge", challenge), ("code_challenge_method", "S256"), ("state", state),
        ("resource", sync_resource(server)), ("scope", consts.OAUTH_SCOPE),
    ]
    if step_up:
        params += [("prompt", "login"), ("max_age", str(consts.STEP_UP_MAX_AGE_S))]
    return "%s/auth/authorize?%s" % (server.rstrip("/"), urllib.parse.urlencode(params))


def _token_post(http, server, fields):
    """POST /auth/token (form-encoded). Never retried. Returns the JSON body of a 200."""
    data = urllib.parse.urlencode(fields).encode("ascii")
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    try:
        resp = http.send("POST", server.rstrip("/") + "/auth/token", headers, data, idempotent=False)
    except transport.TransportError as exc:
        if exc.status == 400 and exc.code == "invalid_grant":
            raise AuthRequired("invalid_grant", "login", "The saved sign-in is no longer valid. Sign in again with hfy-sync login.")
        if exc.status is not None and 400 <= exc.status < 500 and exc.exit_code == consts.EXIT_SERVER_REFUSED:
            raise LoginError(exc.code, consts.EXIT_INTERNAL, "none", status=exc.status, message="The sign-in server refused the request (%s)." % exc.code)
        raise
    body = resp.body
    if not isinstance(body, dict) or not isinstance(body.get("access_token"), str) or not isinstance(body.get("refresh_token"), str):
        raise LoginError("bad_token_response", consts.EXIT_INTERNAL, message="The sign-in server's answer was not a token.")
    return body


class _Callback(http.server.BaseHTTPRequestHandler):
    server_version = "hfy-sync"
    sys_version = ""
    timeout = consts.CALLBACK_CONN_TIMEOUT_S  # applied to the connection socket: a silent client cannot stall the single-threaded loop

    def log_message(self, fmt, *args):  # no request line (it carries the code) in any log
        pass

    def _reply(self, status, text):
        body = _PAGE % text.encode("ascii")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        srv = self.server
        # A DNS-rebinding page must not be able to read or feed this endpoint: the Host header has to be our loopback address.
        if self.headers.get("Host") != "127.0.0.1:%d" % srv.server_port:
            return self._reply(400, "Wrong host.")
        parts = urllib.parse.urlsplit(self.path)
        if parts.path != CALLBACK_PATH:
            return self._reply(404, "Not found.")
        q = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
        if srv.result is not None:
            return self._reply(409, "Already used.")
        if not hmac.compare_digest(q.get("state", "").encode("utf-8"), srv.expected_state.encode("utf-8")):
            return self._reply(400, "This sign-in link is not for this session. Close this tab and run hfy-sync login again.")
        # The auth server always sends `iss` (authorization_response_iss_parameter_supported, RFC 9207), so a callback without it is refused.
        if srv.expected_issuer and q.get("iss") != srv.expected_issuer:
            return self._reply(400, "Wrong issuer.")
        srv.result = {k: q[k] for k in ("code", "error") if k in q}
        self._reply(200, "Signed in. You can close this tab and go back to Gramps.")


class _OneShot(http.server.HTTPServer):
    allow_reuse_address = False
    result = None
    expected_state = ""
    expected_issuer = ""


def login(server, keychain, http=None, open_browser=webbrowser.open, timeout=consts.LOGIN_TIMEOUT_S, step_up=False,
          clock=time.monotonic, bind_host="127.0.0.1", port=0):
    """Runs the loopback sign-in. Returns {"expires_in": seconds, "access_token": str}; the refresh token is in the Keychain.

    Raises LoginError / AuthRequired / transport errors / KeychainError; none of their messages carry a code, state or token.
    """
    http = http or transport.Http()
    server = transport.check_server(server)
    verifier, challenge = pkce_pair()
    state = _b64u(secrets.token_bytes(24))
    httpd = _OneShot((bind_host, port), _Callback)
    try:
        httpd.expected_state = state
        httpd.expected_issuer = server + "/auth"
        redirect_uri = "http://127.0.0.1:%d%s" % (httpd.server_port, CALLBACK_PATH)
        url = authorize_url(server, redirect_uri, challenge, state, step_up=step_up)
        if not open_browser(url):
            raise LoginError("browser_not_opened", consts.EXIT_TEMPORARY, "retry", message="The browser could not be opened.")
        deadline = clock() + timeout
        httpd.timeout = 0.25
        while httpd.result is None and clock() < deadline:
            httpd.handle_request()
        result = httpd.result
    finally:
        httpd.server_close()
    if result is None:
        raise LoginError("login_timeout", consts.EXIT_SIGN_IN, "login", message="No sign-in arrived within five minutes.")
    if "error" in result or "code" not in result:
        raise LoginError("login_denied", consts.EXIT_SIGN_IN, "login", message="The sign-in was not completed (%s)." % ("error" if "error" in result else "no code"))
    body = _token_post(http, server, {
        "grant_type": "authorization_code", "code": result["code"], "redirect_uri": redirect_uri, "code_verifier": verifier,
        "client_id": consts.OAUTH_CLIENT_ID, "resource": sync_resource(server),
    })
    keychain.store(body["refresh_token"], recreate=True)  # before anything else uses the access token
    return {"access_token": body["access_token"], "expires_in": int(body.get("expires_in") or 0)}


class TokenManager:
    """The access token of this process. `keychain` holds the refresh token."""

    SKEW_S = 60

    def __init__(self, server, keychain, http=None, clock=time.monotonic):
        self.server = transport.check_server(server)
        self.keychain = keychain
        self.http = http or transport.Http()
        self.clock = clock
        self._token = None
        self._expires = 0.0

    def seed(self, access_token, expires_in):
        """Takes the access token a login just returned."""
        self._token, self._expires = access_token, self.clock() + max(0, int(expires_in))

    def __call__(self):
        return self.access_token()

    def access_token(self):
        if self._token and self.clock() < self._expires - self.SKEW_S:
            return self._token
        return self.refresh()

    def refresh(self):
        try:
            current = self.keychain.read()
        except KeychainError as exc:
            raise transport.TransportError("keychain_unavailable", consts.EXIT_SIGN_IN, "login", message="The Keychain is locked or unavailable. Unlock it and run again.")
        if not current:
            raise AuthRequired()
        self._token = None
        body = None
        for attempt in (0, 1):
            try:
                body = _token_post(self.http, self.server, {
                    "grant_type": "refresh_token", "refresh_token": current, "client_id": consts.OAUTH_CLIENT_ID,
                    "resource": sync_resource(self.server),
                })
                break
            except AuthRequired:
                # Another process (the CLI and a Gramps run) may have rotated the token since we read it. If the Keychain now holds
                # a different value, that is the winner's live token: keep it and retry once with it. Delete only a token that is
                # still the one we sent.
                try:
                    latest = self.keychain.read()
                    if attempt == 0 and latest and latest != current:
                        current = latest
                        continue
                    if latest == current:
                        self.keychain.delete()  # a dead token only invites a loop; the family is revoked server side
                except KeychainError:
                    pass
                raise
        try:
            self.keychain.store(body["refresh_token"])  # persisted (and read back) before the new access token is used
        except KeychainError:
            raise transport.TransportError("keychain_unavailable", consts.EXIT_SIGN_IN, "login",
                                           message="The rotated sign-in could not be saved to the Keychain; it was not used. Sign in again.")
        self._token, self._expires = body["access_token"], self.clock() + int(body.get("expires_in") or 0)
        return self._token
