"""The refresh token in the macOS login Keychain (sync.md 8.5; PS-21; HFY-TSK-180).

    store(token)   `security -i`, with the command on stdin: the token is never an argument, so `ps` never shows it. The item is
                   created with `-T <trusted app>`, the Python of the Gramps bundle, so no other program reads it silently.
                   The write is read back before it counts.
    read()         `security find-generic-password -w`: the token comes back on stdout.
    delete()       `security delete-generic-password`.

A locked or unavailable Keychain is `KeychainError` (catalog D42: CLI exit 77, the GUI prompts). Nothing here prints or logs a
token. Standard library only; Python 3.9 compatible.
"""
import os
import re
import subprocess
import sys

from . import consts

SECURITY = "/usr/bin/security"
_SAFE = re.compile(r"^[A-Za-z0-9._~+/=-]{8,512}$")  # what a refresh token looks like (hfyrt_ + base64url); nothing needing shell quoting
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._:/|-]{1,128}$")  # service, and "<issuer>|owner" (sync.md 6)
_SAFE_PATH = re.compile(r"^/[A-Za-z0-9._/@+ -]{1,1024}$")

ITEM_NOT_FOUND = 44  # security's exit status for errSecItemNotFound


class KeychainError(Exception):
    """The Keychain could not be used. `locked` is True when the cause looks like a locked or denied keychain."""

    def __init__(self, message, locked=False):
        Exception.__init__(self, message)
        self.locked = locked


def account_for(server):
    """The Keychain account for a sync server: "<issuer>|owner" (sync.md 6, simplified; see consts.KEYCHAIN_ACCOUNT)."""
    return "%s/auth|%s" % (server.rstrip("/"), consts.KEYCHAIN_ACCOUNT_OWNER)


class Keychain:
    def __init__(self, service=consts.KEYCHAIN_SERVICE, account=consts.KEYCHAIN_ACCOUNT, trusted_app=None, security=SECURITY,
                 run=subprocess.run):
        if not (_SAFE_NAME.match(service) and _SAFE_NAME.match(account)):
            raise ValueError("unusable Keychain item name")
        self.service = service
        self.account = account
        # The Python that runs the addon: inside Gramps.app, the bundle's own interpreter (sync.md 8.5).
        self.trusted_app = sys.executable if trusted_app is None else trusted_app
        if not _SAFE_PATH.match(self.trusted_app or "") or not os.path.isabs(self.trusted_app):
            raise ValueError("the trusted application must be an absolute path")
        self.security = security
        self._run = run

    def _call(self, argv, stdin=None):
        try:
            return self._run([self.security] + argv, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, check=False, timeout=60)
        except (OSError, subprocess.SubprocessError) as exc:
            raise KeychainError("The security command could not run (%s)." % type(exc).__name__)

    def store(self, token, recreate=False):
        """Writes the item, then reads it back. Raises KeychainError unless the stored value equals `token`.

        `-U` updates an existing item but keeps its old access list, so `-T` only counts on a new item. A sign-in therefore passes
        `recreate=True`: any existing item is deleted first and the item is created fresh, with `-T` applied. Rotation keeps `-U`
        (delete-then-add would lose the only copy of the new token if the add failed).
        """
        if not isinstance(token, str) or not _SAFE.match(token):
            raise KeychainError("The token is not in a form the Keychain command accepts.")
        if recreate:
            self.delete()
        command = 'add-generic-password %s-s "%s" -a "%s" -T "%s" -w "%s"\n' % (
            "" if recreate else "-U ", self.service, self.account, self.trusted_app, token)
        proc = self._call(["-i"], stdin=command)
        # `security -i` can exit 0 after printing an error, so the read-back below is the real check.
        locked = self._looks_locked(proc)
        if proc.returncode != 0 and not self._read_back_ok(token):
            raise KeychainError("The Keychain refused the new token (security exit %d)." % proc.returncode, locked=locked)
        if not self._read_back_ok(token):
            raise KeychainError("The Keychain did not keep the new token.", locked=locked)

    def _read_back_ok(self, token):
        try:
            return self.read() == token
        except KeychainError:
            return False

    @staticmethod
    def _looks_locked(proc):
        text = ((proc.stderr or "") + (proc.stdout or "")).lower()
        return any(w in text for w in ("user interaction is not allowed", "user canceled", "authorization", "locked", "interaction"))

    def read(self):
        """The stored token, or None when there is no item."""
        proc = self._call(["find-generic-password", "-s", self.service, "-a", self.account, "-w"])
        if proc.returncode == ITEM_NOT_FOUND:
            return None
        if proc.returncode != 0:
            raise KeychainError("The Keychain could not be read (security exit %d)." % proc.returncode, locked=self._looks_locked(proc))
        value = (proc.stdout or "").rstrip("\n")
        return value or None

    def delete(self):
        """Removes the item; a missing item is fine."""
        proc = self._call(["delete-generic-password", "-s", self.service, "-a", self.account])
        if proc.returncode not in (0, ITEM_NOT_FOUND):
            raise KeychainError("The Keychain item could not be removed (security exit %d)." % proc.returncode, locked=self._looks_locked(proc))
