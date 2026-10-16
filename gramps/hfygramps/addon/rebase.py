"""The `rebase` action: this tree meets a cloud store that was recovered or re-seeded (error catalog D50; HFY-TSK-275, review SI-04).

After a store recovery the operator gives the cloud a new tree id (`sync-admin.mjs bump-tree-id`). The cloud is then a different tree than
the one this tree last synced with: every version, seq and base copy in the sidecar belongs to the old one, so a pull or a push would
compare against the wrong history. Pull and push stop at the handshake (D50, `next_action: rebase`); this action starts the sync over
against the new store without touching the tree and without sending anything:

    handshake    the cloud must be this tree's (dbid) and a different cloud tree than the sidecar remembers
    snapshot     the new store's heads, verified like a pull's; the rollback guard is waived (the new store may be at a lower seq)
    classify     each object with no base, as sync.md section 7 says: the desktop and the website hold equal projections -> converged;
                 they differ -> a conflict; only one side has it -> left for the next pull (website only) or push (desktop only)
    backup       the verified backup of every apply (backup.make): the sidecar of this moment is part of it
    sidecar      ONE SQLite transaction: the old base is dropped, the converged objects become the new base, the old open conflicts are
                 closed (the new run lists what still differs), unsent outbox entries are rejected, the old store's open push session is
                 forgotten, the pull window is cleared, and the meta follows the new tree

Nothing is written to the Gramps tree and nothing is sent to the website: the plan's local commits, deletes and push ops are
counted for the summary and then dropped. The next `pull` brings the website-only objects in through the usual preview, and conflicts
wait for a person (parked on the command line, open in the window). An object this tree deleted since its last sync, which the new store
still holds, is counted apart (`deleted_on_desktop`): the dropped base no longer remembers the delete, so the next pull would bring it back,
and the person is told so before it happens. A dry run (the command line without --yes) stops after the
classification and changes nothing, the sidecar included. Counts only in status.json and the run log; no object content anywhere.
"""
import json

from . import backup as backup_mod
from . import consts, pull, sidecar, status
from . import plan as plan_mod

SETTLED = ("converged", "unchanged")


def _deleted_on_desktop(plan, base, local):
    """Handles this tree deleted since its last sync (the old base holds them, the tree no longer does) that the new store still holds live.

    The rebase drops the old base, so without a base the next pull would see each of these as an object only the website has and bring
    it back. Naming them lets the person decide (delete them again on the website) instead of losing the pending delete unseen."""
    return sorted(h for h, b in base.items() if not b["deleted"] and h not in local and h in plan.results and plan.results[h].action == "create_local")


def _summary(plan, base=None, local=None):
    """Counts of what the classification found. `cloud_only` and `desktop_only` are what the next pull and push will handle;
    `deleted_on_desktop` are the website-only objects that this tree had deleted since its last sync (they are not in `cloud_only`)."""
    gone = set(_deleted_on_desktop(plan, base or {}, local or {}))
    rebased = [h for h, r in plan.results.items() if r.action in SETTLED]
    cloud_only = [h for h, r in plan.results.items() if r.action == "create_local" and h not in gone]
    desktop_only = [o for o in plan.push_ops if o.get("op") in ("create", "update")]
    return {"rebased": len(rebased), "conflicts": len({c.get("handle") for c in plan.conflicts}), "cloud_only": len(cloud_only),
            "desktop_only": len(desktop_only), "deleted_on_desktop": len(gone)}


def run(tree, mode, options, tp, log, config, side, outcome, services, run_id, environ):
    """Runs the rebase on a bound tree; returns (result, exit_code, next_action, error)."""
    ctx = pull.Ctx(tree, mode, options, tp, log, config, side, outcome, services, run_id, environ)
    dry = bool(options.dry_run or not options.yes)
    try:
        return _run(ctx, dry)
    except pull.transport.TransportError as exc:
        log.line("transport: %s" % exc.code)
        res = "refused" if exc.exit_code in (consts.EXIT_USAGE, consts.EXIT_NOT_ENABLED, consts.EXIT_SIGN_IN, consts.EXIT_CONFIG) else "failed"
        return (res, exc.exit_code, exc.next_action, {"code": exc.code, "message": exc.message})
    except pull.snapshot.SnapshotError as exc:
        log.line("snapshot: %s" % exc.code)
        return pull._fail("refused", consts.EXIT_SERVER_REFUSED, "none", exc.code, exc.message)
    except backup_mod.BackupError as exc:
        log.line("backup: %s" % exc.code)
        return pull._fail("failed", exc.exit_code, exc.next_action, exc.code, exc.message)


def _run(ctx, dry):
    tree, tp, log, side = ctx.tree, ctx.tp, ctx.log, ctx.side
    meta = sidecar.meta(side)
    cloud = ctx.services.get("cloud") or pull.make_cloud(ctx.config, tree, ctx.services, ctx.environ)

    handshake = cloud.meta()
    bound = handshake.get("bound")
    if not isinstance(bound, dict):
        log.line("cloud not bound")
        return pull._fail("refused", consts.EXIT_CONFIG, "bind", "cloud_unbound",
                          "The website has no tree bound to it yet. Bind the website's store to this tree first.")
    if bound.get("dbid") != tree.dbid:
        log.line("cloud bound to another tree")
        return pull._refuse("D03")
    cloud_tree = handshake.get("tree_id")
    ctx.outcome["cloud"] = (int(handshake.get("head_seq") or 0), int(meta.get("last_pull_seq") or 0))
    if not cloud_tree:
        return pull._fail("refused", consts.EXIT_CONFIG, "none", "cloud_unbound", "The website did not name its tree. Try again later.")
    if not meta.get("cloud_tree_id") or meta["cloud_tree_id"] == cloud_tree:
        log.line("rebase: the cloud tree is the one this tree last synced with; nothing to rebase")
        ctx.outcome["counts"] = dict(status.zero_counts(), rebase={"needed": False})
        return (consts.OK, consts.EXIT_OK, "none", None)
    log.line("rebase: the cloud tree changed (a recovery or a re-seed)")

    # The new store's heads. Its seq may be lower than the old store's last pull, so the rollback guard (last_pull_seq) is waived.
    ctx.snap = pull._snapshot(ctx, cloud, cloud_tree, 0)
    snap = ctx.snap
    ctx.outcome["cloud"] = (int(handshake.get("head_seq") or 0), snap.seq)
    log.line("snapshot seq=%d count=%d" % (snap.seq, snap.header["count"]))

    local = tree.objects()
    plan = plan_mod.build(
        local, {}, snap.heads, pins={}, sticky=set(sidecar.meta_json(side, "birthlike_sticky", [])),
        released=set(sidecar.meta_json(side, "released", [])), mode=ctx.mode, allow_deletes=False, files=tree.media_files(), pulled={},
        expunge_holds=sidecar.load_expunge_holds(side), policy=ctx.policy, parked=snap.parked)
    summary = _summary(plan, sidecar.load_base(side), local)
    log.line("classified rebased=%(rebased)d conflicts=%(conflicts)d cloud_only=%(cloud_only)d desktop_only=%(desktop_only)d "
             "deleted_on_desktop=%(deleted_on_desktop)d" % summary)
    ctx.outcome["counts"] = dict(status.zero_counts(), conflicts_open=len(plan.conflicts), rebase=dict(summary, needed=True))
    if dry:
        log.line("rebase: dry run; nothing changed")
        return (consts.CHANGES_PENDING, consts.EXIT_DRY_RUN_CHANGES, "none", None)

    if pull._free_bytes(ctx, tp.dir) < 3 * pull._db_size(tree) + pull.DISK_MARGIN_BYTES:
        log.line("refused disk space")
        return pull._refuse("disk_space")
    bk = backup_mod.make(tree.dbdir, tp, "rebase", snap.seq, tp.sidecar)
    ctx.outcome["backup"] = bk.path
    log.line("backup %s" % bk.name)
    ctx.faults.hit("after_backup")

    _write_sidecar(ctx, plan, cloud_tree, summary)
    ctx.faults.hit("after_sidecar")
    backup_mod.prune(tp.backups)
    open_conflicts = ctx.outcome.get("conflicts_open", 0)
    ctx.outcome["counts"] = dict(status.zero_counts(), conflicts_open=open_conflicts, rebase=dict(summary, needed=False))
    log.line("rebase: done; conflicts open=%d" % open_conflicts)
    if open_conflicts:
        return ("partial", consts.EXIT_PARTIAL, "resolve_conflicts", {"code": "conflicts_open",
                "message": "%d conflict(s) are open after the rebase; both sides were left as they are, and nothing was sent." % open_conflicts})
    return (consts.OK, consts.EXIT_OK, "none", None)


def _write_sidecar(ctx, plan, cloud_tree, summary):
    side, snap = ctx.side, ctx.snap
    now = status.utc_now()
    state = "parked" if ctx.mode == "cli" else "open"
    heads = {h.handle: h for h in snap.heads}
    with side:
        side.execute("DELETE FROM base")
        for handle, r in sorted(plan.results.items()):
            head = heads.get(handle)
            if r.action in SETTLED and head is not None and not head.deleted:
                side.execute("INSERT OR REPLACE INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
                             (r.cls, handle, head.version, head.seq, head.hash, pull._obj_json(head.obj)))
        # The conflicts of the old cloud tree compared against its base; the new run lists what still differs.
        side.execute("UPDATE conflicts SET state = 'resolved', decision = 'rebase', resolved_at = ? WHERE state IN ('open', 'parked')", (now,))
        for c in plan.conflicts:
            side.execute("INSERT OR REPLACE INTO conflicts (id, class, handle, path, kind, base_json, cloud_json, local_json, state, detected_at) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (c["id"], c.get("class"), c.get("handle"), c["path"], c["kind"], c.get("base_json"), c.get("cloud_json"),
                          c.get("local_json"), state, now))
        side.execute("UPDATE outbox SET state = 'rejected' WHERE state IN ('pending', 'sent')")  # addressed to the old cloud tree
        side.execute("DELETE FROM meta WHERE key = 'open_session'")  # the push session the old store opened (pushstate): the new store never heard of it
        if sidecar.has_table(side, "pulled"):
            side.execute("DELETE FROM pulled")  # the revert labels compare against pulls from the old tree
        if sidecar.has_table(side, "own_pushes"):
            side.execute("DELETE FROM own_pushes")  # the seqs the old store gave this desktop's pushes: the new store hands the same numbers to website edits (HFY-TSK-343)
        sidecar.set_meta(side, "cloud_tree_id", cloud_tree)
        sidecar.set_meta(side, "last_pull_seq", snap.seq)
        sidecar.set_meta(side, "last_snapshot_sha256", snap.body_sha256)
        sidecar.set_meta(side, "rebase_n", int(sidecar.meta(side).get("rebase_n") or 0) + 1)
        sidecar.set_meta(side, "last_rebase_at", now)
        sidecar.set_meta(side, "last_rebase_json", json.dumps(summary, sort_keys=True))
    ctx.outcome["conflicts_open"] = side.execute("SELECT COUNT(*) FROM conflicts WHERE state IN ('open', 'parked')").fetchone()[0]
