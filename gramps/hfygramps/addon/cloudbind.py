"""The `cloud-bind` action (HFY-TSK-369): tell the website's store which tree it belongs to, once, before the first `check`.

    hfy-sync cloud-bind              a look: what would be sent (field names and byte lengths), exit 10, no network, no sign-in used
    hfy-sync cloud-bind --yes        POST /api/sync/bind {dbid, fingerprint, tree_name_sha256}

`bind` binds the tree on this Mac and sends nothing. The website's store starts unbound, and `check`, `pull`, `push` and `rebase` stop at
the handshake with exit 78 and the code word `cloud_unbound` until this step has run. The first bind needs only the owner's sign-in
(`login`); a repeat is the server's `409 already_bound`, whether it names this tree or another one. A rebind (another tree on purpose)
needs a fresh sign-in and is not part of this action.

The three values are not invented here. `dbid` and `fingerprint` are the ones the local `bind` stored in the sidecar's meta, so a repeat
names the same tree to the server (it compares both), and `tree_name_sha256` is the sha256 of the tree's display name, the digest the
end-to-end lane sends (`tests/e2e/e2e_case.py`). The call goes through the same `transport.Client` and `oauth.TokenManager` (the owner's
refresh token in the Keychain) as every other action; there is no credential code in this module.

Nothing the action prints, logs or stores carries a value: status.json, the run log and the summary line name the field names, their
byte lengths and a code word. The tree's name, its ids, the digest, the cloud tree id and every token stay out of them.
"""
import hashlib
import re

from . import consts, keychain, pull, sidecar, status, transport

FIELDS = ("dbid", "fingerprint", "tree_name_sha256")
# The server's validators (api/src/sync/routes.js bindBody); checked here so a value it would refuse as 400 is not sent at all.
_DBID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_FINGERPRINT = re.compile(r"^[A-Za-z0-9._:-]{8,256}$")

BOUND, ALREADY_BOUND = "bound", "already_bound"

NOT_OWNER_MESSAGE = "This sign-in is not the tree owner's. Nothing was sent. Sign in with the owner's account (hfy-sync login), then run cloud-bind again."
OTHER_TREE_MESSAGE = ("The website is already bound to a different tree. Nothing was changed. Open the tree it is bound to; "
                      "binding another tree on purpose is a rebind, which needs a fresh sign-in and is not part of cloud-bind.")
PAUSED_MESSAGE = "The website's sync is switched off or paused. Nothing was sent. Wait until it is turned on, then run cloud-bind again."
NETWORK_MESSAGE = "The website could not be reached. Nothing was changed by this run. Check the network, then run cloud-bind again."


def tree_name_sha256(name):
    return hashlib.sha256((name or "").encode("utf-8")).hexdigest()


def _lengths(values):
    return {k: len(values[k].encode("utf-8")) for k in FIELDS}


def _done(ctx_outcome, lengths, sent, outcome):
    """counts.cloud_bind: field names and byte lengths, whether the call was made, and a code word. No value."""
    ctx_outcome["counts"] = dict(status.zero_counts(), cloud_bind={"fields": lengths, "sent": bool(sent), "outcome": outcome})


def _refused_with(code, exit_code, next_action, message):
    return ("refused", exit_code, next_action, {"code": code, "message": message})


def _from_transport(exc):
    """(result, exit_code, next_action, error) for a failed call, with a fix hint that names no value. The exit code is the transport's
    own (transport.map_error), so a code means here what it means for `check` and `push`."""
    code, st = exc.code, exc.status
    if exc.exit_code == consts.EXIT_NOT_ENABLED:       # 404 not_enabled, 503 sync_paused: the website's switch, not this Mac
        return _refused_with(code, consts.EXIT_NOT_ENABLED, "none", PAUSED_MESSAGE)
    if exc.exit_code == consts.EXIT_SIGN_IN:           # no sign-in, a dead or revoked one, a locked Keychain, or step_up_required
        if code == "step_up_required":
            return _refused_with(code, consts.EXIT_SIGN_IN, "step_up", "A fresh sign-in is needed. Nothing was sent. Run hfy-sync login --step-up, then run cloud-bind again.")
        return _refused_with(code, consts.EXIT_SIGN_IN, exc.next_action or "login",
                             "You are not signed in as the tree's owner, or the sign-in expired. Nothing was sent. Run hfy-sync login, then run cloud-bind again.")
    if st == 403 and code == "not_owner":
        return _refused_with(code, consts.EXIT_CONFIG, "login", NOT_OWNER_MESSAGE)
    if exc.exit_code == consts.EXIT_CONFIG:            # 426 and upgrade_required, other 403s, a certificate that does not verify
        hint = "Update the addon, then run cloud-bind again." if exc.next_action == "update_addon" else "Nothing was sent. Fix the cause above, then run cloud-bind again."
        return _refused_with(code, consts.EXIT_CONFIG, exc.next_action, "%s %s" % (exc.message, hint))
    if exc.exit_code == consts.EXIT_SERVER_REFUSED:    # 400 validation, 413, 422
        return _refused_with(code, consts.EXIT_SERVER_REFUSED, "none",
                             "The website refused the request (%s). Nothing was stored. Run hfy-sync status and hfy-sync check, and ask io if it stays." % code)
    if code == "network":
        return ("failed", consts.EXIT_TEMPORARY, "retry", {"code": code, "message": NETWORK_MESSAGE})
    if exc.exit_code == consts.EXIT_TEMPORARY:         # 5xx, a 503 that stayed busy
        return ("failed", consts.EXIT_TEMPORARY, "retry", {"code": code, "message": "%s Nothing was changed by this run. Run cloud-bind again in a moment." % exc.message})
    return ("failed", exc.exit_code, exc.next_action, {"code": code, "message": exc.message})


def _refusal(code):
    exit_code, next_action, error = status.refusal(code)
    return ("refused", exit_code, next_action, error)


def _is_this_tree(client, dbid, fingerprint):
    """The server answered 409 already_bound. It says the same for this tree and for another one, so ask the handshake which."""
    body = client.meta()
    bound = body.get("bound") if isinstance(body, dict) else None
    return isinstance(bound, dict) and bound.get("dbid") == dbid and bound.get("fingerprint") == fingerprint


def run(tree, mode, options, tp, log, config, side, outcome, services, environ):
    """Runs `cloud-bind` on a locally bound tree; returns (result, exit_code, next_action, error)."""
    meta = sidecar.meta(side)
    dbid, fingerprint = meta.get("dbid") or "", meta.get("fingerprint") or ""
    if dbid != tree.dbid:
        log.line("cloud-bind: sidecar names another tree")
        return _refusal("D03")
    if not (_DBID.match(dbid) and _FINGERPRINT.match(fingerprint)):
        log.line("cloud-bind: local binding is not usable")
        return _refusal("D13")
    values = {"dbid": dbid, "fingerprint": fingerprint, "tree_name_sha256": tree_name_sha256(tree.name)}
    lengths = _lengths(values)

    if options.dry_run or not options.yes:
        log.line("cloud-bind: dry run")
        _done(outcome, lengths, False, "dry_run")
        return (consts.CHANGES_PENDING, consts.EXIT_DRY_RUN_CHANGES, "none", None)

    try:
        client = pull.make_cloud(config, tree, services, environ).client
    except ValueError:
        log.line("cloud-bind: unusable server URL")
        _done(outcome, lengths, False, "config_unreadable")
        return _refused_with("config_unreadable", consts.EXIT_CONFIG, "none", "The server in config.json is not an https URL. Fix or remove it.")
    except keychain.KeychainError:
        log.line("cloud-bind: keychain unavailable")
        _done(outcome, lengths, False, "D42")
        return _refused_with("D42", consts.EXIT_SIGN_IN, "login", "The Keychain is locked or unavailable. Unlock it and run cloud-bind again.")

    try:
        try:
            answer = client.post("/api/sync/bind", values).body
        except transport.TransportError as exc:
            if not (exc.status == 409 and exc.code == "already_bound"):
                raise
            same = _is_this_tree(client, dbid, fingerprint)
            _done(outcome, lengths, True, ALREADY_BOUND if same else "bound_other_tree")
            if same:
                log.line("cloud-bind: already bound to this tree")
                return (consts.OK, consts.EXIT_OK, "none", None)
            log.line("cloud-bind: bound to another tree")
            return _refused_with("bound_other_tree", consts.EXIT_CONFIG, "open_bound_tree", OTHER_TREE_MESSAGE)
    except transport.TransportError as exc:
        log.line("cloud-bind: %s" % exc.code)
        _done(outcome, lengths, False, exc.code)
        return _from_transport(exc)

    if not (isinstance(answer, dict) and isinstance(answer.get("tree_id"), str) and answer["tree_id"]):
        log.line("cloud-bind: answer not usable")
        _done(outcome, lengths, True, "bad_bind_answer")
        return ("failed", consts.EXIT_INTERNAL, "none", {"code": "bad_bind_answer", "message": "The website answered, but not in a form this addon reads. Run hfy-sync check to see whether the bind took."})
    _done(outcome, lengths, True, BOUND)
    log.line("cloud-bind: bound")
    return (consts.OK, consts.EXIT_OK, "none", None)
