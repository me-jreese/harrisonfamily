"""The tree binding (BRD2 section 11, SI-06; sync.md 8.3 step 1, D03).

A tree is the bound tree when all three agree:
  1. the dbid (the Gramps tree directory name) equals the `dbid` in config.json and in the sidecar meta;
  2. the tree marker uuid stored in the tree's own metadata (`hfy_sync_tree_id`, written inside the bind DbTxn) equals the sidecar's
     `tree_id`;
  3. the similarity guard: at least 90 % of the sidecar's base handles still exist in the tree.

The old fingerprint (a hash of all handles) is not compared any more: it changed on every local create or delete. Local edits
between syncs move the similarity by a few handles at most, so they never reach D03. Swapping in a different tree misses the
marker, the dbid or the 90 % line.

A re-imported or copied tree (new dbid, or a marker that does not match) is rebound with a fresh sign-in (step-up), gets a new
sidecar, goes through rebase mode (D12) and the mass-delete guard (sync.md 17, docs/how-to/install-the-gramps-sync-addon.md).
"""
import uuid

from . import consts


def new_tree_id():
    return uuid.uuid4().hex


def similarity_ok(base, local):
    """True when at least SIMILARITY_MIN_PERCENT of `base` (a set of (class, handle)) is in `local`; an empty base always passes."""
    if not base:
        return True
    present = len(base & local)
    return present * 100 >= len(base) * consts.SIMILARITY_MIN_PERCENT


def new_config(tree_name, dbid, client_instance_id=None, server=None):
    """config.json of sync.md 4.3: {server, tree_name, dbid, media_root, client_instance_id}."""
    return {
        "schema": 1,
        "server": server or consts.DEFAULT_SERVER,
        "tree_name": tree_name,
        "dbid": dbid,
        "media_root": consts.DEFAULT_MEDIA_ROOT,
        "client_instance_id": client_instance_id or uuid.uuid4().hex,
    }


class Verdict:
    """The outcome of `check`: `code` is None (bound or not yet bound) or a catalog id (D03, D12, D13)."""

    def __init__(self, code=None, bound=False, reason=""):
        self.code = code
        self.bound = bound
        self.reason = reason  # a short reason for the log; never shown with object content


def check(config, tree, side):
    """Decides the binding of the open tree.

    config: the parsed config.json or None. tree: runner.TreeAccess. side: None when state.sqlite is absent, a sidecar
    connection when it is there, or the string "damaged" when it failed its checks.
    """
    if config is None:
        return Verdict(None, False, "unbound")
    if config.get("dbid") != tree.dbid:
        return Verdict("D03", False, "dbid differs from config")
    if side is None:
        return Verdict("D12", False, "sidecar missing")
    if side == "damaged":
        return Verdict("D13", False, "sidecar damaged")
    from . import sidecar

    meta = sidecar.meta(side)
    if meta.get("dbid") != tree.dbid:
        return Verdict("D03", False, "dbid differs from sidecar")
    marker = tree.read_marker()
    if not marker or marker != meta.get("tree_id"):
        return Verdict("D03", False, "tree marker missing or different")
    if not similarity_ok(sidecar.base_handles(side), tree.handles()):
        return Verdict("D03", False, "fewer than %d %% of the synced handles exist" % consts.SIMILARITY_MIN_PERCENT)
    return Verdict(None, True, "bound")
