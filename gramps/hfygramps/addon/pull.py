"""The pull side of a run: `check`, `pull` and the pull half of `sync` (sync.md 8.3 steps 3 to 11; HFY-TSK-205).

    handshake    GET /api/sync/meta: the cloud tree must be this tree's (dbid), and the same cloud tree as the last pull
    snapshot     download and verify (sha256, header, tree, schema, redaction, count); an older seq than the last pull is refused
    plan         plan.build: project, merge, privacy scan, expunge notices, reverts, mass-delete guard, plan hash
    preview      previews/<run_id>.json (pointers and projected values; the CLI prints counts only). A `check`, or any dry run, stops here
    media down   files of cloud-created or changed Media, before the backup so the one transaction can set `Media.path`
    backup       backups/<UTC>-<action>-seq<N>.sqlite with its sidecar copy, `PRAGMA integrity_check` ok, sha256 recorded. No backup, no apply
    stale check  every object the plan touches is read again; a changed one means "re-plan" (and again inside the transaction)
    apply        ONE non-batch DbTxn "Website sync: pull seq N" (a single Edit > Undo entry); the symmetry and reference check runs inside it
                 and any exception rolls the whole transaction back
    sidecar      base rows, conflicts, holds, incidents, the pulled-objects window and the meta, in one SQLite transaction

Crash safety. Everything after the Gramps commit is idempotent, and the merge absorbs a crash between the commit and the sidecar
update: on the next run the local object already equals the website's (`converged`), so the base just advances. A crash inside the
transaction is rolled back by SQLite's journal; the backup covers real corruption. Fault injection (faults.py) exercises each
boundary. Nothing in status.json, the run log or an error message carries object content.
"""
import copy
import json
import os
import shutil
import urllib.parse

from .. import merge as M
from .. import projection as PR
from .. import rules as R
from . import backup as backup_mod
from . import consts, delta, errors, faults, media, paths, sidecar, snapshot, status, transport
from . import plan as plan_mod

MAX_REPLANS = 3
PREVIEWS_KEPT = 20
SNAPSHOTS_KEPT = 2
DISK_MARGIN_BYTES = 100 * 1024 * 1024


class Cloud:
    """The sync API as a pull uses it. Tests pass an object with the same five methods (services["cloud"])."""

    def __init__(self, client, http):
        self.client = client
        self.http = http

    def meta(self):
        body = self.client.meta()
        if not isinstance(body, dict):
            raise transport.TransportError("bad_meta", consts.EXIT_INTERNAL, message="The website's handshake answer was not usable.")
        self.client.versions.tree_id = body.get("tree_id") or None
        return body

    def snapshot_info(self):
        body = self.client.get("/api/sync/snapshot").body
        if not isinstance(body, dict) or not isinstance(body.get("url"), str):
            raise transport.TransportError("bad_snapshot_answer", consts.EXIT_INTERNAL, message="The snapshot answer was not usable.")
        return body

    def changes(self, since, limit):
        """GET /api/sync/changes (ARCH-B, delta.py): the decoded answer, whatever it is; delta.py checks the shape."""
        return self.client.get("/api/sync/changes", query={"since": since, "limit": limit}).body

    def fetch(self, url):
        return self.http.get_bytes(media.check_download_url(url))

    def media_download(self, handle):
        body = self.client.post("/api/sync/media/%s/download" % urllib.parse.quote(handle, safe=""), {}).body
        if not isinstance(body, dict):
            raise transport.TransportError("bad_media_answer", consts.EXIT_INTERNAL, message="The media answer was not usable.")
        return body


def make_cloud(config, tree, services, environ):
    """The Cloud for this run: services["cloud"], or the real transport with the sign-in from the Keychain."""
    from . import keychain, oauth

    server = transport.check_server(services.get("server") or (config or {}).get("server") or consts.DEFAULT_SERVER)
    http = services.get("http") or transport.Http()
    kc = services.get("keychain") or keychain.open_for(server, environ)
    tokens = oauth.TokenManager(server, kc, http=http)
    versions = transport.Versions(tree.gramps_version, tree.schema_version)
    return Cloud(transport.Client(server, versions, tokens, http=http), http)


# ---------------------------------------------------------------------------------------------------------------- the run


class Ctx:
    def __init__(self, tree, mode, options, tp, log, config, side, outcome, services, run_id, environ):
        self.tree, self.mode, self.options, self.tp, self.log = tree, mode, options, tp, log
        self.config, self.side, self.outcome, self.services, self.run_id, self.environ = config, side, outcome, services, run_id, environ
        self.faults = services.get("faults") or faults.Faults(environ)
        self.dry = options.action == "check" or options.dry_run
        self.policy = R.load_policy()


def _refuse(code):
    exit_code, next_action, error = status.refusal(code)
    return ("refused", exit_code, next_action, error)


def _fail(res, exit_code, next_action, code, message):
    return (res, exit_code, next_action, {"code": code, "message": message})


def run(tree, mode, options, tp, log, config, side, outcome, services, run_id, environ):
    """Runs a pull-side action on a bound tree; returns (result, exit_code, next_action, error)."""
    ctx = Ctx(tree, mode, options, tp, log, config, side, outcome, services, run_id, environ)
    try:
        return _run(ctx)
    except transport.TransportError as exc:
        log.line("transport: %s" % exc.code)
        res = "refused" if exc.exit_code in (consts.EXIT_USAGE, consts.EXIT_NOT_ENABLED, consts.EXIT_SIGN_IN, consts.EXIT_CONFIG) else "failed"
        return (res, exc.exit_code, exc.next_action, {"code": exc.code, "message": exc.message})
    except snapshot.SnapshotError as exc:
        log.line("snapshot: %s" % exc.code)
        return _fail("refused", consts.EXIT_SERVER_REFUSED, "none", exc.code, exc.message)
    except backup_mod.BackupError as exc:
        log.line("backup: %s" % exc.code)
        return _fail("failed", exc.exit_code, exc.next_action, exc.code, exc.message)


def _free_bytes(ctx, path):
    f = ctx.services.get("free_bytes")
    return f() if f else shutil.disk_usage(path).free


def _db_size(tree):
    try:
        return os.path.getsize(os.path.join(tree.dbdir, "sqlite.db"))
    except (OSError, TypeError):
        return 0


def _fp(obj):
    return None if obj is None else plan_mod.fingerprint(obj)


def _run(ctx):
    tree, tp, log, side, options = ctx.tree, ctx.tp, ctx.log, ctx.side, ctx.options
    meta = sidecar.meta(side)
    last_pull_seq = int(meta.get("last_pull_seq") or 0)
    cloud = ctx.services.get("cloud") or make_cloud(ctx.config, tree, ctx.services, ctx.environ)

    # ---- handshake
    handshake = cloud.meta()
    bound = handshake.get("bound")
    if not isinstance(bound, dict):
        log.line("cloud not bound")
        return _fail("refused", consts.EXIT_CONFIG, "bind", "cloud_unbound",
                     "The website has no tree bound to it yet. Bind the website's store to this tree first.")
    if bound.get("dbid") != tree.dbid:
        log.line("cloud bound to another tree")
        return _refuse("D03")
    cloud_tree = handshake.get("tree_id")
    if meta.get("cloud_tree_id") and meta["cloud_tree_id"] != cloud_tree:
        log.line("cloud tree changed")
        return _refuse("D50")
    ctx.outcome["cloud"] = (int(handshake.get("head_seq") or 0), last_pull_seq)
    log.line("handshake ok head_seq=%s" % handshake.get("head_seq"))

    # ---- the cloud state (step 3): a delta on the cached state when the change feed is on, else (or on any doubt) a full snapshot
    ctx.snap = _cloud_state(ctx, cloud, handshake, cloud_tree, last_pull_seq)
    snap = ctx.snap
    ctx.outcome["cloud"] = (int(handshake.get("head_seq") or 0), snap.seq)
    log.line("snapshot seq=%d count=%d" % (snap.seq, snap.header["count"]))
    ctx.faults.hit("after_snapshot")

    # ---- plan (step 4) and preview (step 5)
    plan = _plan(ctx)
    _write_preview(ctx, plan)
    ctx.outcome["counts"] = plan.counts
    log.line("plan hash=%s changes=%s" % (plan.plan_hash[:12], plan.has_changes))
    if ctx.dry:
        return _dry_result(plan)

    # ---- the reviewed plan, when the caller names one (headless runbook 19.3)
    if options.plan:
        refused = _check_reviewed(ctx, plan)
        if refused:
            return refused
    if ctx.mode == "gui" and tree.editors_open():
        log.line("refused D45")
        return _refuse("D45")
    if plan.applies and _free_bytes(ctx, tp.dir) < 3 * _db_size(tree) + DISK_MARGIN_BYTES:
        log.line("refused disk space")
        return _refuse("disk_space")

    # ---- media down (step 6), backup (step 7), stale check (step 8)
    media_paths, bk = {}, None
    hook = ctx.services.get("between_preview_and_apply")
    for attempt in range(MAX_REPLANS + 1):
        if plan.media:
            holds_before = len(plan.holds)
            got, failed = _media_down(ctx, cloud, plan)
            media_paths.update(got)
            if _defer_media(plan, failed) or len(plan.holds) != holds_before:
                _write_preview(ctx, plan)  # the preview file describes the plan that is applied
                ctx.outcome["counts"] = plan.counts
            ctx.faults.hit("after_media")
        if plan.applies and bk is None:
            bk = backup_mod.make(tree.dbdir, tp, options.action, snap.seq, tp.sidecar)
            ctx.outcome["backup"] = bk.path
            log.line("backup %s" % bk.name)
            ctx.faults.hit("after_backup")
        if hook:
            hook()
            hook = None  # the seam fires once
        if not _stale(ctx, plan):
            break
        log.line("stale: replan %d" % (attempt + 1))
        plan = _plan(ctx)
        _write_preview(ctx, plan)
        ctx.outcome["counts"] = plan.counts
        if options.plan or ctx.mode == "gui":
            return _fail("changes_pending", consts.EXIT_DRY_RUN_CHANGES, "review_preview", "plan_changed",
                         "The tree changed after the preview was made. Review the new preview.")
    else:
        return _fail("failed", consts.EXIT_TEMPORARY, "retry", "tree_busy",
                     "The tree kept changing while the sync was planned. Try again when it is quiet.")

    # ---- apply (step 9)
    if plan.applies:
        pull_n = int(sidecar.meta(side).get("pull_n") or 0)
        pending = _record_pending(ctx, plan, pull_n + 1)
        try:
            _apply(ctx, plan, media_paths)
        except errors.StaleTree:
            _clear_pending(ctx, pull_n + 1, pending)
            log.line("stale inside the transaction")
            return _fail("changes_pending", consts.EXIT_DRY_RUN_CHANGES, "review_preview", "plan_changed",
                         "The tree changed while the changes were applied; nothing was applied. Review the new preview.")
        except errors.ApplyAborted as exc:
            _clear_pending(ctx, pull_n + 1, pending)
            log.line("apply aborted: %s" % exc.code)
            return _fail("refused", consts.EXIT_SERVER_REFUSED, "review_preview", exc.code,
                         "A relationship or reference check failed inside the transaction; nothing was applied.")
        except Exception:
            _clear_pending(ctx, pull_n + 1, pending)  # the transaction rolled back whole (a crash that ends the process never gets here)
            raise
        ctx.faults.hit("after_commit")
        log.line("applied %d, removed %d" % (len(plan.commits), len(plan.removals)))

    # ---- base, conflicts, holds, incidents (step 10)
    _update_sidecar(ctx, plan, cloud_tree)
    ctx.faults.hit("after_sidecar")
    if bk is not None:
        backup_mod.prune(tp.backups)
    _prune_previews(tp)
    return _final(ctx, plan)


# ---------------------------------------------------------------------------------------------------------------- steps


def _cloud_state(ctx, cloud, handshake, cloud_tree, last_pull_seq):
    """Step 3: the website's whole state as a verified Snapshot, by the cheapest route that can be trusted (delta.py)."""
    epoch = delta.epoch_of(handshake)
    if not delta.enabled(handshake, ctx.config) or not hasattr(cloud, "changes"):
        snap = _snapshot(ctx, cloud, cloud_tree, last_pull_seq)
        _remember(ctx, snap, epoch, 0)
        return snap
    log = ctx.log
    head_seq = int(handshake.get("head_seq") or 0)
    try:
        replica = delta.load(ctx.tp, cloud_tree, ctx.tree.schema_version, epoch)
        if replica.streak >= consts.DELTA_VERIFY_EVERY - 1:
            return _verified_snapshot(ctx, cloud, replica, head_seq, cloud_tree, last_pull_seq, epoch)
        delta.advance(replica, cloud, head_seq)
        snap = replica.to_snapshot(ctx.tree.schema_version, last_pull_seq)
        _cache_snapshot(ctx, snap.raw_gz, snap.seq)
        _remember(ctx, snap, epoch, replica.streak + 1)
        ctx.outcome["pull_via"] = "delta"
        log.line("delta ok seq=%d" % snap.seq)
        return snap
    except delta.Fallback as fb:
        log.line("delta fallback: %s" % fb.code)
    snap = _snapshot(ctx, cloud, cloud_tree, last_pull_seq)
    _remember(ctx, snap, epoch, 0)
    ctx.outcome["pull_via"] = "snapshot"
    return snap


def _verified_snapshot(ctx, cloud, replica, head_seq, cloud_tree, last_pull_seq, epoch):
    """Every 7th sync: the full snapshot is the cloud state, and the delta replay to its seq must hash to the same body."""
    snap = _snapshot(ctx, cloud, cloud_tree, last_pull_seq)
    _remember(ctx, snap, epoch, 0)
    ctx.outcome["pull_via"] = "snapshot"
    try:
        delta.advance(replica, cloud, head_seq, until=snap.seq)
        if replica.seq != snap.seq:
            ctx.log.line("delta verify inconclusive: the replay ended at another seq")
        elif replica.to_snapshot(ctx.tree.schema_version).body_sha256 == snap.body_sha256:
            ctx.log.line("delta verify ok seq=%d" % snap.seq)
        else:
            ctx.log.line("delta verify MISMATCH seq=%d: the snapshot is used and replaces the cache" % snap.seq)
            ctx.outcome["delta_verify"] = "mismatch"
    except delta.Fallback as fb:
        ctx.log.line("delta verify inconclusive: %s" % fb.code)
    return snap


def _remember(ctx, snap, epoch, streak):
    try:
        delta.save_state(ctx.tp, snap, epoch, streak)
    except OSError:
        pass  # the cache is a convenience; with no state file the next run takes a snapshot


def _cache_snapshot(ctx, raw, seq):
    try:
        os.makedirs(ctx.tp.cache, mode=0o700, exist_ok=True)
        cache = os.path.join(ctx.tp.cache, "snapshot-%d.jsonl.gz" % seq)
        os.chmod(ctx.tp.cache, 0o700)  # makedirs leaves an existing folder as it was
        fd = os.open(cache + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # private from the first byte, whatever the umask
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        os.chmod(cache + ".tmp", 0o600)  # an older .tmp left by a crash keeps its mode through O_TRUNC
        os.replace(cache + ".tmp", cache)
        names = [f for f in os.listdir(ctx.tp.cache) if f.startswith("snapshot-") and f.endswith(".jsonl.gz")]
        names.sort(key=lambda f: int(f[len("snapshot-"):-len(".jsonl.gz")]) if f[len("snapshot-"):-len(".jsonl.gz")].isdigit() else -1)
        for f in names[:-SNAPSHOTS_KEPT]:
            os.unlink(os.path.join(ctx.tp.cache, f))
    except OSError:
        pass  # the cache is a convenience


def _snapshot(ctx, cloud, cloud_tree, last_pull_seq):
    info, raw = None, None
    for attempt in (0, 1):
        info = cloud.snapshot_info()
        try:
            raw = cloud.fetch(info["url"])
            break
        except transport.TransportError as exc:
            if exc.status != 403 or attempt:  # D52: an expired presigned URL is asked for once more
                raise
    snap = snapshot.parse(raw, expect=info, tree_id=cloud_tree, schema=ctx.tree.schema_version, last_pull_seq=last_pull_seq)
    _cache_snapshot(ctx, raw, snap.seq)
    return snap


def _plan(ctx):
    """One planning pass over the tree as it is now."""
    side, tree = ctx.side, ctx.tree
    pull_n = int(sidecar.meta(side).get("pull_n") or 0)
    local = tree.objects()
    plan = plan_mod.build(
        local, sidecar.load_base(side), ctx.snap.heads, pins=sidecar.load_pins(side),
        sticky=set(sidecar.meta_json(side, "birthlike_sticky", [])), released=set(sidecar.meta_json(side, "released", [])),
        mode=ctx.mode, allow_deletes=ctx.options.allow_deletes, files=tree.media_files(), pulled=sidecar.load_pulled(side, pull_n),
        expunge_holds=sidecar.load_expunge_holds(side), policy=ctx.policy, confirm_mass_delete=bool(ctx.services.get("confirm_mass_delete")))
    plan.local = local
    return plan


def _write_preview(ctx, plan):
    doc = plan_mod.preview(plan, ctx.run_id, ctx.options.action, ctx.mode, ctx.snap, status.utc_now())
    paths.atomic_write_json(os.path.join(ctx.tp.previews, "%s.json" % ctx.run_id), doc)


def _prune_previews(tp):
    try:
        files = sorted((os.path.getmtime(os.path.join(tp.previews, f)), f) for f in os.listdir(tp.previews) if f.endswith(".json"))
        for _, f in files[:-PREVIEWS_KEPT]:
            os.unlink(os.path.join(tp.previews, f))
    except OSError:
        pass


def _check_reviewed(ctx, plan):
    """`sync --yes --plan <run_id>`: the plan about to be applied must be the one that was reviewed (exit 10 otherwise)."""
    rid = ctx.options.plan
    if not paths.valid_dbid(rid):
        return _fail("refused", consts.EXIT_USAGE, "none", "plan_unknown", "The plan id is not a run id.")
    try:
        reviewed = paths.read_json(os.path.join(ctx.tp.previews, "%s.json" % rid))
    except ValueError:
        reviewed = None
    if not isinstance(reviewed, dict) or not isinstance(reviewed.get("plan_hash"), str):
        ctx.log.line("reviewed plan not found")
        return _fail("refused", consts.EXIT_USAGE, "none", "plan_unknown", "There is no preview for that run id. Run check first and review it.")
    if reviewed["plan_hash"] != plan.plan_hash:
        ctx.log.line("plan differs from the reviewed one")
        return _fail("changes_pending", consts.EXIT_DRY_RUN_CHANGES, "review_preview", "plan_changed",
                     "The changes now differ from the preview you reviewed. Nothing was applied; review the new preview.")
    return None


def _media_down(ctx, cloud, plan):
    root = os.path.expanduser((ctx.config or {}).get("media_root") or consts.DEFAULT_MEDIA_ROOT)
    got, failed = {}, []
    for h in sorted(plan.media):
        try:
            info = media.download(cloud, h, root)
        except (transport.TransportError, ValueError, OSError) as exc:
            ctx.log.line("media %s: deferred (%s)" % (h[:6], getattr(exc, "code", type(exc).__name__)))
            failed.append(h)
            continue
        if info is None:
            ctx.log.line("media %s: no blob; metadata only" % h[:6])
            continue
        if info.get("held"):
            ctx.log.line("media %s: held (%s); metadata only" % (h[:6], info["held"]))
            plan.holds.append({"handle": h, "rule": info["held"], "scope": "download", "pointer": "/blob",
                               "detail": consts.HOLD_MESSAGES.get(info["held"]) or PR.hold_reason(info["held"])})
            continue
        got[h] = info
        with ctx.side:
            ctx.side.execute("INSERT OR REPLACE INTO media_local (handle, path, md5, sha256, size, origin) VALUES (?, ?, ?, ?, ?, 'cloud')",
                             (h, info["path"], info["md5"], info["sha256"], info["size"]))
    ctx.outcome["media_down"] = ctx.outcome.get("media_down", 0) + sum(1 for i in got.values() if i["fresh"])
    if any(x.get("scope") == "download" for x in plan.holds):
        plan.counts = dict(plan.counts, holds=len(plan.holds))
    return got, failed


def _defer_media(plan, failed):
    """A Media object whose file could not be fetched, and everything that refers to it, waits for the next run.

    Transitive: an object that refers to a dropped NEW object is dropped as well (and so on), so no commit is left pointing at
    something that is not applied, which the in-transaction reference check would refuse for every run until the file arrives. The
    plan hash is recomputed for the plan that will actually be applied. Returns True when the plan changed.
    """
    if not failed:
        return False
    bad = set(failed)
    local = plan.local or {}
    direct = {h for h, obj in plan.commits.items() if h in bad or plan_mod.references(obj, bad)}
    rest = {h: o for h, o in plan.commits.items() if h not in direct}
    # the chain passes through the failed Media and through the dropped objects the tree does not have yet
    exempt = set(local)
    seeds = {h for h in bad | direct if h not in exempt}
    gone = direct | plan_mod.drop_dependants(rest, seeds, exempt)
    for h in sorted(gone):
        plan.deferred.append({"class": plan.local_ids[h][0], "handle": h, "gramps_id": plan.local_ids[h][1], "reason": "a media file is missing"})
        del plan.commits[h]
    bad |= gone
    plan.pulled_rows = [r for r in plan.pulled_rows if r["handle"] not in bad]
    plan.base_ops = [b for b in plan.base_ops if b[2] not in bad]
    plan.media = [h for h in plan.media if h not in bad]
    plan.counts = plan_mod.status_counts(plan)
    plan.plan_hash = plan_mod.plan_hash(plan)
    return True


def _stale(ctx, plan):
    """Step 8: re-read the tree; True when an object the plan touches is not what the plan was made from."""
    fresh = ctx.tree.objects()
    touched = set(plan.commits) | set(plan.removals) | {o["handle"] for o in plan.push_ops} | {c["handle"] for c in plan.conflicts} | set(plan.media)
    return any(_fp(fresh.get(h)) != _fp_planned(plan, h) for h in touched)


def _fp_planned(plan, h):
    return plan.fingerprints.get(h)


def _record_pending(ctx, plan, run_n):
    """The pre-pull values of this run, written before the Gramps commit so a crash right after it still leaves them.

    Returns the (class, handle) keys written. A row replaces an older one for the same object, so the values are always those of the
    pull that is about to happen; `_clear_pending` removes exactly these rows when the run ends without committing, so a pull that
    never happened leaves no history for the revert labelling to use.
    """
    sidecar.ensure_pull_tables(ctx.side)
    now = status.utc_now()
    keys = []
    with ctx.side:
        for row in plan.pulled_rows:
            if row["handle"] in plan.commits or row["handle"] in plan.removals:
                ctx.side.execute("INSERT OR REPLACE INTO pulled (run_n, class, handle, kind, prepull_json, at) VALUES (?, ?, ?, ?, ?, ?)",
                                 (run_n, row["class"], row["handle"], row["kind"],
                                  json.dumps(row["prepull"], sort_keys=True) if row["prepull"] is not None else None, now))
                keys.append((row["class"], row["handle"]))
    return keys


def _clear_pending(ctx, run_n, keys):
    try:
        with ctx.side:
            for cls, h in keys:
                ctx.side.execute("DELETE FROM pulled WHERE run_n = ? AND class = ? AND handle = ?", (run_n, cls, h))
    except Exception:  # noqa: BLE001 - cleanup must never hide the real outcome
        pass


def _apply(ctx, plan, media_paths):
    commits = {h: copy.deepcopy(o) for h, o in plan.commits.items()}
    for h, info in media_paths.items():
        if h in commits:
            commits[h]["path"] = info["path"]
    existing = {v["key"] for v in M.check_integrity(plan.local)}
    removed = set(plan.removals)
    planned = {h: plan.fingerprints.get(h) for h in list(commits) + list(plan.removals)}

    def precheck(read):
        for h, fp in planned.items():
            cls = plan.local_ids[h][0]
            if _fp(read(cls, h)) != fp:
                raise errors.StaleTree()

    def verify(objects_now):
        new = [v for v in M.check_integrity(objects_now, removed) if v["key"] not in existing]
        if new:
            raise errors.ApplyAborted("integrity", "The changes would break %d relationship or reference check(s)." % len(new))

    label = "Website sync: pull seq %d" % ctx.snap.seq
    ctx.tree.apply(label, commits, [(plan.local_ids[h][0], h) for h in plan.removals], precheck=precheck, verify=verify, hook=ctx.faults.hit)


def _update_sidecar(ctx, plan, cloud_tree):
    """Step 10, in one sidecar transaction: base rows, conflicts, holds, incidents, the pulled window and the meta."""
    side, snap = ctx.side, ctx.snap
    now = status.utc_now()
    applied = plan.applies
    meta = sidecar.meta(side)
    pull_n = int(meta.get("pull_n") or 0)
    new_pull_n = pull_n + 1 if applied else pull_n
    sidecar.ensure_pull_tables(side)
    cls_of = {h: c for h, (c, _g) in plan.local_ids.items()}

    # the sticky set, from the tree and the base as they are after this run
    local_after = dict(plan.local)
    for h, o in plan.commits.items():
        local_after[h] = o
    for h in plan.removals:
        local_after.pop(h, None)
    base_after = dict(plan.base_objs)
    for op, _cls, h, head in plan.base_ops:
        if op == "set" and head is not None and head.obj is not None:
            base_after[h] = head.obj
        else:
            base_after.pop(h, None)
    stored_sticky = set(sidecar.meta_json(side, "birthlike_sticky", []))
    released = set(sidecar.meta_json(side, "released", []))
    sticky_after = sorted(PR.update_birthlike_sticky(stored_sticky, list(local_after.values()), base_after, released, ctx.policy))

    with side:
        for op, cls, h, head in plan.base_ops:
            if op == "set":
                side.execute("INSERT OR REPLACE INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
                             (cls, h, head.version, head.seq, head.hash, _obj_json(head.obj)))
            elif op == "deleted":
                side.execute("INSERT OR REPLACE INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, ?, NULL, 1)",
                             (cls, h, head.version if head else 0, head.seq if head else 0, head.hash if head and head.hash else ""))
            else:  # drop
                side.execute("DELETE FROM base WHERE handle = ?", (h,))

        # conflicts: listed again each run until the engine reports the path closed
        state = "parked" if ctx.mode == "cli" else "open"
        current = set()
        for c in plan.conflicts:
            current.add(c["id"])
            row = side.execute("SELECT 1 FROM conflicts WHERE id = ?", (c["id"],)).fetchone()
            if row:
                side.execute("UPDATE conflicts SET cloud_json = ?, local_json = ?, state = ?, kind = ?, path = ?, resolved_at = NULL WHERE id = ?",
                             (c.get("cloud_json"), c.get("local_json"), state, c["kind"], c["path"], c["id"]))
            else:
                side.execute("INSERT INTO conflicts (id, class, handle, path, kind, base_json, cloud_json, local_json, state, detected_at) "
                             "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                             (c["id"], c.get("class"), c.get("handle"), c["path"], c["kind"], c.get("base_json"), c.get("cloud_json"),
                              c.get("local_json"), state, now))
        for (h, path) in plan.closed:
            side.execute("UPDATE conflicts SET state = 'resolved', resolved_at = ? WHERE handle = ? AND path = ? AND state IN ('open', 'parked')",
                         (now, h, path))
        for (cid,) in side.execute("SELECT id FROM conflicts WHERE state IN ('open', 'parked')").fetchall():
            if cid not in current:
                side.execute("UPDATE conflicts SET state = 'resolved', resolved_at = ? WHERE id = ?", (now, cid))

        # incidents (counts only leave this file)
        keep = {(i["class"], i["handle"]) for i in plan.incidents}
        for cls, h in side.execute("SELECT class, handle FROM incidents WHERE state = 'open'").fetchall():
            if (cls, h) not in keep:
                side.execute("UPDATE incidents SET state = 'resolved' WHERE class = ? AND handle = ?", (cls, h))
        for i in plan.incidents:
            side.execute("INSERT OR IGNORE INTO incidents (class, handle, gramps_id, rule, seq, first_seen, state) VALUES (?, ?, ?, ?, ?, ?, 'open')",
                         (i["class"], i["handle"], i["gramps_id"], i["rule"], i["seq"], now))
            side.execute("UPDATE incidents SET seq = ?, state = 'open' WHERE class = ? AND handle = ?", (i["seq"], i["class"], i["handle"]))

        # holds: the projection's are replaced each run (first_seen kept); an expunge notice's stay until io releases them
        seen = {(c, h, p, r): f for c, h, p, r, f in side.execute("SELECT class, handle, path, rule, first_seen FROM holds")}
        side.execute("DELETE FROM holds WHERE rule != ?", (sidecar.EXPUNGE_RULE,))
        for x in plan.holds:
            key = (cls_of.get(x["handle"], ""), x["handle"], x["pointer"], x["rule"])
            side.execute("INSERT OR REPLACE INTO holds (class, handle, path, rule, detail, first_seen) VALUES (?, ?, ?, ?, ?, ?)",
                         (key[0], key[1], key[2], key[3], x.get("detail") or x["scope"], seen.get(key, now)))
        for n in plan.notices:
            for p in n["paths"]:
                side.execute("INSERT OR IGNORE INTO holds (class, handle, path, rule, detail, first_seen) VALUES (?, ?, ?, ?, ?, ?)",
                             (n["class"], n["handle"], p, sidecar.EXPUNGE_RULE, "scrubbed on the website", now))

        sidecar.set_meta(side, "last_pull_seq", max(int(sidecar.meta(side).get("last_pull_seq") or 0), snap.seq))
        sidecar.set_meta(side, "last_snapshot_sha256", snap.body_sha256)
        if cloud_tree:
            sidecar.set_meta(side, "cloud_tree_id", cloud_tree)
        sidecar.set_meta_json(side, "birthlike_sticky", sticky_after)
        sidecar.set_meta(side, "pull_n", new_pull_n)
        sidecar.set_meta(side, "last_pull_at", now)
        side.execute("DELETE FROM pulled WHERE run_n <= ?", (new_pull_n - sidecar.PULL_WINDOW,))
    ctx.outcome["conflicts_open"] = side.execute("SELECT COUNT(*) FROM conflicts WHERE state IN ('open', 'parked')").fetchone()[0]


def _obj_json(obj):
    from .. import canonical

    return canonical.object_json(obj)


# ---------------------------------------------------------------------------------------------------------------- results


def _attention(plan, extra_blocked=0):
    """(code, message, next_action) of what still needs a person after the run, or None."""
    if plan.incidents:
        return ("privacy_incident", "%d pulled object(s) were not applied because they show a local date of birth. "
                "A withdraw-and-expunge push is offered." % len(plan.incidents), "review_incidents")
    if plan.conflicts:
        return ("conflicts_open", "%d conflict(s) are open; both sides were left as they are." % len(plan.conflicts), "resolve_conflicts")
    media_held = sum(1 for x in plan.holds if x.get("scope") == "download")
    if plan.blocked or plan.deferred or plan.parked or media_held:
        return ("blocked", "%d change(s) were held back (deletes, reverts or media files); see the preview." %
                (len(plan.blocked) + len(plan.deferred) + len(plan.parked) + media_held), "review_preview")
    return None


def _dry_result(plan):
    if plan.has_changes:
        return ("changes_pending", consts.EXIT_DRY_RUN_CHANGES, "review_preview", None)
    att = _attention(plan)
    if att:
        return ("partial", consts.EXIT_PARTIAL, att[2], {"code": att[0], "message": att[1]})
    return (consts.OK, consts.EXIT_OK, "none", None)


def _final(ctx, plan):
    plan.counts["media_down"] = ctx.outcome.get("media_down", 0)
    plan.counts["conflicts_open"] = ctx.outcome.get("conflicts_open", plan.counts["conflicts_open"])
    ctx.outcome["counts"] = plan.counts
    att = _attention(plan)
    if att:
        return ("partial", consts.EXIT_PARTIAL, att[2], {"code": att[0], "message": att[1]})
    if ctx.options.action == "sync" and plan.counts["push_pending"]:
        return ("partial", consts.EXIT_PARTIAL, "none", {"code": "push_pending",
                "message": "%d desktop change(s) are waiting to go to the website; `sync` only pulls, so run hfy-sync push to send them." % plan.counts["push_pending"]})
    return (consts.OK, consts.EXIT_OK, "none", None)
