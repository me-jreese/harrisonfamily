"""One run of the addon (sync.md 8.3 step 1, the part this skeleton implements).

    preflight (refuse, never partly run)  ->  binding (D03, D12, D13)  ->  the action  ->  status.json

`run` is called by the Gramps tool with a `TreeAccess` over the open database and by tests with a fake one. It never raises: a
bug becomes a `failed` status with exit 70, because Gramps' `cli_tool` swallows exceptions and the wrapper reads only
status.json. Nothing in status.json, the run log or an error message carries object content.
"""
import hashlib
import os
import sys
import time
import webbrowser

from . import binding, consts, keychain, oauth, paths, preflight, pull, sidecar, status, transport


class TreeAccess:
    """What the runner needs from the open Gramps tree. hfy_sync_tool.GrampsTree implements it over the Gramps API."""

    dbid = ""  # the tree directory name (db.get_dbid())
    name = ""  # the tree's display name
    schema_version = 0  # db.get_schema_version()
    gramps_series = (0, 0)  # (major, minor) of the running Gramps
    gramps_version = ""

    def read_marker(self):
        """The `hfy_sync_tree_id` metadata value, or None."""
        raise NotImplementedError

    def handles(self):
        """{(class, handle)} of every object in the tree, class names from consts.CLASSES."""
        raise NotImplementedError

    def bind(self, tree_id, also):
        """Writes the marker inside one DbTxn and calls `also()` inside it; an exception from either leaves the tree untouched."""
        raise NotImplementedError

    dbdir = ""  # the tree's folder (backups read sqlite.db there)

    def objects(self):
        """{handle: raw `json_data` dict} of every primary object, read without changing anything."""
        raise NotImplementedError

    def media_files(self):
        """{media handle: {"exif_gps", "md5", "readable"}} for the projection; {} when the addon does not read the files."""
        return {}

    def editors_open(self):
        """True while a Gramps edit window is open (GUI only; D45)."""
        return False

    def apply(self, label, commits, removals, precheck=None, verify=None, hook=None):
        """Applies `commits` ({handle: local-form object}) and `removals` ([(class, handle)]) in ONE non-batch DbTxn named `label`.

        Inside the transaction: `precheck(read)` first (`read(class, handle)` gives the raw object or None; it raises to abort), then
        the commits, `hook("mid_apply")` after the first half of them, the removals, and last `verify(objects_now)` with every object
        as it would be committed. Any exception rolls the whole transaction back and propagates.
        """
        raise NotImplementedError


class Options:
    def __init__(self, action="status", dry_run=False, allow_deletes=False, yes=False, step_up=False, plan="", backup=""):
        self.action = action
        self.plan = plan or ""  # `sync --yes --plan <run_id>`: apply only if the new plan equals that run's preview (runbook 19.3)
        self.backup = backup or ""
        self.step_up = bool(step_up)
        self.dry_run = bool(dry_run)
        self.allow_deletes = bool(allow_deletes)
        self.yes = bool(yes)


class _Log:
    """logs/<run_id>.log: step names and codes only (sync.md 4.3)."""

    def __init__(self, tree_paths, run_id):
        self.path = os.path.join(tree_paths.logs, "%s.log" % run_id)

    def line(self, text):
        try:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write("%s %s\n" % (status.utc_now(), text))
            os.chmod(self.path, 0o600)
        except OSError:
            pass


def _versions(tree):
    return {"addon": consts.ADDON_VERSION, "gramps": tree.gramps_version, "db_schema": tree.schema_version,
            "redaction": consts.REDACTION_VERSION}


def run(tree, mode, options, run_id=None, argv=None, environ=None, services=None):
    """Runs `options.action` on `tree`; returns the status document, which is also written to `<dbid>/status.json`."""
    environ = os.environ if environ is None else environ
    run_id = run_id or status.new_run_id()
    started = status.utc_now()
    tree_paths = paths.TreePaths(tree.dbid, environ)
    outcome = {"bound": False, "dry_run": options.dry_run, "counts": None}
    side = None
    try:
        tree_paths.ensure()
        log = _Log(tree_paths, run_id)
        log.line("run %s action=%s mode=%s" % (run_id, options.action, mode))
        outcome["run_id"] = run_id
        result = _decide(tree, mode, options, tree_paths, log, argv if argv is not None else sys.argv, environ, outcome, services or {})
        side = outcome.get("side")
        if side is None and outcome["bound"] and os.path.exists(tree_paths.sidecar):
            try:
                side = sidecar.open_checked(tree_paths.sidecar)  # just bound: the run row goes into the new sidecar
            except sidecar.SidecarError:
                side = None
    except Exception as exc:  # noqa: BLE001 - the whole point is that nothing escapes
        result = ("failed", consts.EXIT_INTERNAL, "none", {"code": "internal", "message": "Internal error (%s). See the run log." % type(exc).__name__})
        try:
            _Log(tree_paths, run_id).line("internal error %s" % type(exc).__name__)
        except Exception:  # noqa: BLE001
            pass
        side = outcome.get("side")  # a sidecar opened before the failure is still closed below, and gets the failed run's row
    res, exit_code, next_action, error = result
    doc = status.build(run_id, options.action, mode, tree.dbid, outcome["bound"], res, exit_code, started, status.utc_now(),
                       dry_run=options.dry_run or options.action == "check", error=error, next_action=next_action, counts=outcome["counts"],
                       versions=_versions(tree), head_seq=outcome.get("cloud", (0, 0))[0], snapshot_seq=outcome.get("cloud", (0, 0))[1],
                       backup=outcome.get("backup"), via=outcome.get("pull_via"))
    try:
        if side is not None:
            sidecar.record_run(side, doc)
    except Exception:  # noqa: BLE001 - the run log row is best effort; status.json is the contract
        pass
    finally:
        if side is not None:
            side.close()
    try:
        if outcome.get("unlocked") and mode != "cli":
            pass  # the Gramps window shows the returned document; nothing may touch the running run's status.json
        else:
            status.write(tree_paths, doc, holds_lock=not outcome.get("unlocked"))
    except OSError as exc:
        doc = dict(doc, result="failed", exit_code=consts.EXIT_INTERNAL, error={"code": "internal", "message": "status.json could not be written (%s)." % type(exc).__name__})
    return doc


def _refused(code):
    exit_code, next_action, error = status.refusal(code)
    return ("refused", exit_code, next_action, error)


def _decide(tree, mode, options, tp, log, argv, environ, outcome, services):
    """Returns (result, exit_code, next_action, error)."""
    if options.action not in consts.ACTIONS:
        log.line("refused usage")
        return _refused("usage")
    if mode == "cli" and preflight.force_unlock_requested(argv):
        log.line("refused D02")
        return _refused("D02")
    if not preflight.schema_supported(tree.schema_version, tree.gramps_series):
        log.line("refused D04")
        return _refused("D04")
    with preflight.StateLock(tp.lock) as lock:
        if not lock.acquired:
            log.line("refused D14")
            outcome["unlocked"] = True  # status.json is the running run's: this refusal goes to its own file
            return _refused("D14")
        if mode == "cli":
            try:
                gui = preflight.gui_process_running(preflight.ps_lines(environ))
            except Exception:  # noqa: BLE001 - a ps failure must not decide a run; the tree lock still protects it
                gui = False
            if gui:
                log.line("refused D01")
                return _refused("D01")
        try:
            config = paths.read_json(tp.config)
            if config is not None and not isinstance(config, dict):
                raise ValueError("config.json is not an object")
        except ValueError:
            log.line("refused config_unreadable")
            return _refused("config_unreadable")
        side = None
        if config is not None and config.get("dbid") == tree.dbid:
            if not os.path.exists(tp.sidecar):
                side = None
            else:
                try:
                    side = sidecar.open_checked(tp.sidecar)
                except sidecar.SidecarError:
                    side = "damaged"
        if side not in (None, "damaged"):
            outcome["side"] = side  # run() records the run row and closes it, also when a step below raises
        verdict = binding.check(config, tree, side)
        log.line("binding %s" % (verdict.code or ("bound" if verdict.bound else "unbound")))
        if verdict.code and side not in (None, "damaged"):
            side.close()  # a refused run leaves no row in a sidecar that may belong to another tree
            outcome.pop("side", None)
        outcome["bound"] = verdict.bound
        if verdict.code:
            return _refused(verdict.code)
        if options.action == "status":
            return (consts.OK, consts.EXIT_OK, "none", None)
        if options.action == "bind":
            return _bind(tree, mode, options, tp, log, config, outcome)
        if options.action == "login":
            return _login(options, config, log, services, environ)
        if options.action in consts.PULL_ACTIONS and not outcome["bound"]:
            log.line("refused: not bound")
            return _refused("unbound")
        if options.action in consts.PULL_ACTIONS:
            return pull.run(tree, mode, options, tp, log, config, outcome.get("side"), outcome, services, outcome["run_id"], environ)
        if options.action == "restore":
            log.line("refused: restore through the tool")
            return _refused("restore_open")  # the tree is open in this very run: restore is the wrapper's job, with Gramps closed
        exit_code, next_action, message = consts.NOT_ENABLED
        log.line("not enabled %s" % options.action)
        return ("refused", exit_code, next_action, {"code": "not_enabled", "message": message})


def _login(options, config, log, services, environ=None):
    """`login` (sync.md 8.5): needs no bound tree. `services` lets tests replace the Keychain, the browser and the transport."""
    server = services.get("server") or (config or {}).get("server") or consts.DEFAULT_SERVER
    if options.dry_run:
        log.line("login: dry run")
        return (consts.OK, consts.EXIT_OK, "none", None)
    try:
        kc = services.get("keychain") or keychain.open_for(transport.check_server(server), environ)
        oauth.login(server, kc, http=services.get("http"), open_browser=services.get("open_browser", webbrowser.open),
                    timeout=services.get("timeout", consts.LOGIN_TIMEOUT_S), step_up=options.step_up)
    except ValueError:
        log.line("login: unusable server URL")
        return ("refused", consts.EXIT_CONFIG, "none", {"code": "config_unreadable", "message": "The server in config.json is not an https URL. Fix or remove it."})
    except keychain.KeychainError:
        log.line("login: keychain unavailable")
        return ("refused", consts.EXIT_SIGN_IN, "login", {"code": "D42", "message": "The Keychain is locked or unavailable. Unlock it and run login again."})
    except transport.TransportError as exc:
        log.line("login: %s" % exc.code)
        res = "refused" if exc.exit_code in (consts.EXIT_USAGE, consts.EXIT_NOT_ENABLED, consts.EXIT_SIGN_IN, consts.EXIT_CONFIG) else "failed"
        return (res, exc.exit_code, exc.next_action, {"code": exc.code, "message": exc.message})
    log.line("login: signed in")
    return (consts.OK, consts.EXIT_OK, "none", None)


def _bind(tree, mode, options, tp, log, config, outcome):
    if outcome["bound"]:
        log.line("bind: already bound")
        return (consts.OK, consts.EXIT_OK, "none", None)
    if os.path.exists(tp.sidecar):
        # config.json is absent here (an earlier bind stopped half way). An empty sidecar is replaced; one with data is not.
        try:
            con = sidecar.open_checked(tp.sidecar)
            try:
                used = con.execute("SELECT (SELECT COUNT(*) FROM base) + (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM conflicts)").fetchone()[0]
            finally:
                con.close()
        except sidecar.SidecarError:
            used = 1
        if used:
            log.line("refused D13 on bind")
            return _refused("D13")
    if options.dry_run or not options.yes:
        log.line("bind: dry run")
        return (consts.CHANGES_PENDING, consts.EXIT_DRY_RUN_CHANGES, "none", None)
    tree_id = binding.new_tree_id()
    handles = sorted("%s:%s" % ch for ch in tree.handles())
    fingerprint = hashlib.sha256("\n".join(handles).encode("utf-8")).hexdigest()
    cfg = binding.new_config(tree.name, tree.dbid)

    def make_sidecar():
        if os.path.exists(tp.sidecar):
            os.unlink(tp.sidecar)  # the empty one checked above
        sidecar.create(tp.sidecar, {
            "tree_id": tree_id, "dbid": tree.dbid, "fingerprint": fingerprint, "server": cfg["server"],
            "redaction_version": consts.REDACTION_VERSION, "addon_version": consts.ADDON_VERSION,
            "last_pull_seq": 0, "last_snapshot_sha256": "", "last_push_at": "", "client_instance_id": cfg["client_instance_id"],
        })

    tree.bind(tree_id, make_sidecar)
    try:
        paths.atomic_write_json(tp.config, cfg)
    except OSError:
        log.line("bind: config.json not written")
        raise
    log.line("bind: done")
    outcome["bound"] = True
    return (consts.OK, consts.EXIT_OK, "none", None)
