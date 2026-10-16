"""The push action (sync.md 8.3 steps 2, 3, 4, 5, 12 and 13; 8.4; BRD2 11.1; error catalog D07, D22 to D28, D35 to D37, D44, D48, D49):
the local tree's changes go to the website as ops, through sessions and an outbox that survives a lost response.

    handshake      GET /api/sync/meta: the bound tree (D03), the cloud tree id (D50), writes_enabled (D27), the retired Person IDs (D44),
                   merges_enabled (D51), the limits of a batch.
    outbox         a `sent` row left by an earlier run is replayed with its own Idempotency-Key: a 2xx or `Idempotent-Replayed` advances
                   the base; a 409, 422 or 410 marks the row `rejected` for good; a `pending` row is discarded (D49).
    snapshot       GET /api/sync/snapshot, verified like the pull will (gzip, header, tree, schema, redaction, count, hash, no older seq).
    plan           ``pushplan.build_plan`` over the raw local tree, the sidecar base, the snapshot's heads and the pull's `pulled` window (a
                   change that puts back what a recent pull replaced is parked by the command line: D47).
    preview        a dry run writes ``previews/<run_id>.json`` (pointers, never values), changes nothing, and exits 10 when there is
                   something to push.
    push           batches of at most 24 ops in dependency order, deletes last; a session when there is more than one batch (or the store
                   is not seeded yet); every batch is written to the outbox (`pending`, then `sent`) BEFORE it goes on the wire; the base
                   advances only from the acknowledgement; the session is completed at the end.

    media          a Media op carries its blob (``mediaup``): the file is hashed on disk (the checksum the website gets is that MD5), uploaded
                   to the staging key with a signed SHA-256 just before the batch that names it, and the website moves it into place after the
                   op commits. A file that cannot go (missing, empty, online-only, GPS) is held with guidance; the metadata still syncs.

What this action never does: apply a website change to the Gramps database (that is the pull), write to a served media key, or print
a field value. Standard library only; Python 3.9 compatible.
"""
import base64
import gzip
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from . import consts, decisions, mediaup, oauth, keychain, plan as pullplan, pushplan, pushstate, sidecar, status, transport
from .. import canonical, merge as M

_RULE = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024


class PushStop(Exception):
    """The run stops here with this result (result, exit_code, next_action, error)."""

    def __init__(self, result):
        Exception.__init__(self, "stop")
        self.result = result


def refused(code, exit_code, next_action, message, result="refused"):
    return (result, exit_code, next_action, {"code": code, "message": message})


# ---------------------------------------------------------------------------------------------------------------- helpers


def token_claims(token):
    """The (unverified) claims of a JWT access token, or {}. Used only to decide whether a delete can possibly be accepted; the
    server is the authority and answers 403 step_up_required when it disagrees."""
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        claims = json.loads(base64.urlsafe_b64decode(part.encode("ascii")).decode("utf-8"))
        return claims if isinstance(claims, dict) else {}
    except (AttributeError, IndexError, ValueError, UnicodeError):
        return {}


def step_up_fresh(token, now=None):
    """True when the access token carries a fresh step-up: amr includes mfa and auth_time is at most 300 s old (sync.md 7.1)."""
    claims = token_claims(token)
    amr, auth_time = claims.get("amr"), claims.get("auth_time")
    now = time.time() if now is None else now
    return isinstance(amr, list) and "mfa" in amr and isinstance(auth_time, int) and not isinstance(auth_time, bool) \
        and 0 <= now - auth_time <= consts.STEP_UP_MAX_AGE_S


def _signed_in_label(token):
    """A short label for 'Signed in as' in the window: the token's name claim, else its subject. Never written to status.json."""
    claims = token_claims(token)
    for key in ("name", "preferred_username", "sub"):
        v = claims.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()[:64]
    return ""


def error_result(exc):
    """(result, exit_code, next_action, error) for a TransportError: nothing of the response but its code."""
    res = "refused" if exc.exit_code in (consts.EXIT_USAGE, consts.EXIT_NOT_ENABLED, consts.EXIT_SIGN_IN, consts.EXIT_CONFIG) else "failed"
    return (res, exc.exit_code, exc.next_action, {"code": exc.code, "message": exc.message})


def _detail_list(exc, key):
    items = (exc.details or {}).get(key)
    return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []


def _safe_rule(rule, default):
    return rule if isinstance(rule, str) and _RULE.match(rule) else default


ID_REFUSALS = ("gramps_id_taken", "gid_conflict", "gramps_id_retired")


def _id_hits(exc, batch):
    """The ops that an ID refusal names by value. api/src/sync/apply.js answers `gramps_id_taken`, `gid_conflict` and `gramps_id_retired`
    with ``{class, gramps_id}`` and no op (the validator's own refusals carry ``conflicts`` with an ``op_id``), so the culprits are the
    creates and updates of that class that claim that ID: one record for a taken or retired ID, both of two that claim one ID."""
    if exc.code not in ID_REFUSALS:
        return []
    details = exc.details if isinstance(exc.details, dict) else {}
    cls, gid = details.get("class"), details.get("gramps_id")
    if not isinstance(cls, str) or not isinstance(gid, str) or not gid:
        return []
    return [{"class": o["class"], "handle": o["handle"]} for o in batch
            if o["class"] == cls and o["op"] in ("create", "update") and isinstance(o.get("obj"), dict) and o["obj"].get("gramps_id") == gid]


def _pulled_window(con):
    """The pull's `pulled` rows (sidecar.load_pulled) for the last pull runs, or {} when no pull has applied anything yet."""
    raw = sidecar.meta(con).get("pull_n")
    return sidecar.load_pulled(con, int(raw) if str(raw).isdigit() else 0)


class Snapshot:
    def __init__(self, seq, heads, count):
        self.seq, self.heads, self.count = seq, heads, count


def read_snapshot_bytes(raw, route, tree_id):
    """Verifies a downloaded snapshot (sync.md 8.3 step 3, D10) and returns a Snapshot. ValueError says what failed (no content)."""
    try:
        data = gzip.decompress(raw)
    except (OSError, EOFError, ValueError):
        raise ValueError("not gzip")
    head_line, _, body = data.partition(b"\n")
    try:
        header = json.loads(head_line.decode("utf-8"))
    except ValueError:
        raise ValueError("header unreadable")
    if not isinstance(header, dict) or header.get("type") != "header":
        raise ValueError("no header")
    if hashlib.sha256(body).hexdigest() != header.get("body_sha256") or header.get("body_sha256") != route.get("body_sha256"):
        raise ValueError("body hash")
    if header.get("seq") != route.get("seq") or not isinstance(header.get("seq"), int):
        raise ValueError("seq")
    if tree_id and header.get("tree_id") != tree_id:
        raise ValueError("tree")
    if header.get("schema") not in consts.SUPPORTED_DB_SCHEMAS:
        raise ValueError("schema")
    if header.get("redaction") != consts.REDACTION_VERSION:
        raise ValueError("redaction")
    heads = {}
    n = 0
    for line in body.split(b"\n"):
        if not line:
            continue
        n += 1
        try:
            row = json.loads(line.decode("utf-8"))
        except ValueError:
            raise ValueError("line unreadable")
        if not isinstance(row, dict) or not isinstance(row.get("handle"), str) or not isinstance(row.get("version"), int):
            raise ValueError("line shape")
        if row.get("class") not in consts.CLASSES:
            continue  # D39: a class this addon does not know is left alone
        heads[row["handle"]] = {"class": row["class"], "version": row["version"], "seq": row.get("seq") or 0,
                                "deleted": row.get("deleted") is True, "gramps_id": row.get("gramps_id") or "",
                                "obj": None if row.get("deleted") is True else row.get("obj")}
    if header.get("count") != n or header.get("count") != route.get("count"):
        raise ValueError("count")
    return Snapshot(header["seq"], heads, n)


def _allowed_url(client, url):
    """A snapshot address must be https; plain http only for a loopback host when the configured server is itself loopback (the dev server)."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname or ""
    except ValueError:
        return False
    if parts.scheme == "https":
        return bool(host)
    if parts.scheme == "http" and host in ("127.0.0.1", "::1", "localhost"):
        try:
            base_host = urllib.parse.urlsplit(str(client.server)).hostname or ""
        except ValueError:
            return False
        return base_host in ("127.0.0.1", "::1", "localhost")
    return False


def download(client, url):
    """GET a presigned URL (no Authorization header, no redirect) and return its bytes; raises OSError-like failures as ValueError."""
    if not _allowed_url(client, url):
        raise ValueError("the snapshot address is not an allowed one")
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": transport.USER_AGENT})
    try:
        with client.http.opener.open(req, timeout=client.http.timeout) as resp:
            data = resp.read(MAX_SNAPSHOT_BYTES + 1)
    except (urllib.error.URLError, OSError) as exc:
        raise ValueError("download failed (%s)" % type(exc).__name__)
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise ValueError("too large")
    return data


# ------------------------------------------------------------------------------------------------------------------- run


def run(tree, mode, options, tp, side, config, log, outcome, services, run_id, now=None, environ=None):
    """Runs one push. Returns (result, exit_code, next_action, error); fills outcome["counts"]. Never writes status.json."""
    runner_ = _Push(tree, mode, options, tp, side, config, log, outcome, services, run_id, now or status.utc_now, environ)
    try:
        return runner_.run()
    except PushStop as stop:
        return runner_.settle(stop.result)
    except transport.TransportError as exc:
        log.line("push: %s" % exc.code)
        return runner_.settle(error_result(exc))


class _Push:
    def __init__(self, tree, mode, options, tp, side, config, log, outcome, services, run_id, now, environ=None):
        self.tree, self.mode, self.options, self.tp, self.side = tree, mode, options, tp, side
        self.environ = environ
        self.config, self.log, self.outcome, self.services, self.run_id, self.now = config or {}, log, outcome, services, run_id, now
        self.dry = bool(options.dry_run)
        self.client = None
        self.meta = {}
        self.cloud_tree_id = None
        self.session_id = None
        self.plan = None
        self.extra_holds = []        # holds the server's refusals added during this run
        self.extra_blocked = []
        self.counts = status.zero_counts()
        self.moved = False           # a 409 version_conflict stopped the push (D22)
        self.server_refused = None   # the last 4xx code that dropped ops (D24)
        self.no_step_up = False
        self.step_up = False
        self.signed_in = ""
        self.integrity_open = False  # the session could not be completed (D25)
        self.serial = 0
        self.limits = {}
        self.replayed = 0
        self.acked = set()           # handles whose ops an acknowledged batch carried in this run (HFY-TSK-338: they release keep_desktop receipts)
        self.id_named = False        # the last refusal dropped ops that the server named by ID (it names one ID per answer)
        self.files = {}              # {Media handle: mediafile.inspect dict}: the bytes on disk, read once per run
        self.staged = set()          # (handle, sha256) already at their staging key in this run
        self.deferred_media = set()  # new Media whose upload failed: what refers to them waits for the next run
        self.blob_retries = {}       # Media handle -> how many times the website could not find its staged blob this run
        self.base_handles = set()
        self.pathless = frozenset()  # Media handles with no file path (a held download): their holds survive this run's replacement of the table

    # ------------------------------------------------------------------------------------------------------- the client

    def _client(self):
        if self.services.get("client") is not None:
            return self.services["client"]
        server = self.services.get("server") or self.config.get("server") or consts.DEFAULT_SERVER
        try:
            server = transport.check_server(server)
        except ValueError:
            raise PushStop(refused("config_unreadable", consts.EXIT_CONFIG, "none", "The server in config.json is not an https URL. Fix or remove it."))
        kc = self.services.get("keychain") or keychain.open_for(server, self.environ)  # the file seam under HFY_SYNC_TEST=1, as the pull uses it
        http = self.services.get("http")
        tokens = oauth.TokenManager(server, kc, http=http)
        versions = transport.Versions(self.tree.gramps_version, self.tree.schema_version)
        return transport.Client(server, versions, tokens, http=http)

    # --------------------------------------------------------------------------------------------------------------- run

    def run(self):
        con = self.side
        if self.options.action != "push":
            raise PushStop(refused("usage", consts.EXIT_USAGE, "none", "Unknown action."))
        try:
            self.client = self._client()
        except keychain.KeychainError:
            raise PushStop(refused("D42", consts.EXIT_SIGN_IN, "login", "The Keychain is locked or unavailable. Unlock it and run again."))
        self._handshake()
        self.files = self.tree.media_files() or {}
        if not self.dry:
            discarded = pushstate.outbox_discard_pending(con)
            if discarded:
                self.log.line("push: discarded %d pending outbox rows" % discarded)
            self._resolve_outbox()
        snap = self._snapshot()
        local = self.tree.objects()
        self.pathless = sidecar.pathless_media(local)
        base = pushstate.base_rows(con)
        self.base_handles = {h for h, r in base.items() if not r["deleted"]}
        sticky = pushstate.get_json(con, "birthlike_sticky", [])
        token = self.client.token_provider()
        step_up = self.step_up = step_up_fresh(token)
        self.signed_in = _signed_in_label(token)
        if isinstance(self.services.get("sink"), dict):
            self.services["sink"]["signed_in"] = self.signed_in    # in-process only, for the window's header: no file ever holds it
        self.plan = pushplan.build_plan(
            local, base, snap.heads, meta=self.meta, members=self._members(), mode=self.mode, allow_deletes=self.options.allow_deletes, yes=self.options.yes,
            step_up=step_up, sticky=sticky, pins=pushstate.pins(con), max_obj_bytes=self.limits.get("max_obj_bytes"),
            files=self.files, unreadable=[h for h, f in self.files.items() if not f.get("readable")], blobs=mediaup.load_rows(con),
            expunge_holds=sidecar.load_expunge_holds(con), pulled=_pulled_window(con), released=set(sidecar.meta_json(con, "released", [])))
        plan = self.plan
        for w in plan.warnings:
            self.log.line("push: warning %s %s" % (w["rule"], w["handle"][:6]))
        self.log.line("push: plan %s ops=%d destructive=%d holds=%d blocked=%d conflicts=%d pull_pending=%d media_up=%d" % (
            snap.seq, len(plan.ops), len(plan.destructive), len(plan.holds), len(plan.blocked), len(plan.conflicts), len(plan.pull_pending), plan.media_up))
        if self.dry:
            return self._preview(snap)

        # Real run: what the plan decided about the sidecar goes in first (all of it can be derived again), then the pushes.
        now = self.now()
        pushstate.record_conflicts(con, plan.conflicts, plan.closed, now, state="parked" if self.mode == "cli" else "open")
        pushstate.set_json(con, "birthlike_sticky", sorted(plan.sticky))
        self._advance_base(snap, base)
        self.session_id = pushstate.get_text(con, "open_session")
        stopped = False
        order = [("create/update", plan.ops), ("delete", plan.destructive)]
        if self.mode == "gui" and self.options.deletes_first:
            order.reverse()   # D07: the delete batches go right after the step-up, before the 300 s window can lapse on a long push
        total = sum(len(pushplan.make_batches(ops, self.limits)) for _n, ops in order if ops)
        if not self.session_id and total and (total > 1 or not self.meta.get("seeded")):
            self._open_session()
        for _name, ops in order:
            if ops and not stopped:
                stopped = not self._push_ops(ops)
        if not stopped and self.session_id:
            self._complete_session()
        self._receipts()
        return self.settle(self._verdict())

    def _receipts(self):
        """HFY-TSK-338: the website's keep_desktop decisions a pull applied wait for the push that carries the desktop value. Receipt each one whose
        object the website now holds as the desktop has it: its batch was acknowledged (this run or an earlier outbox row), or the two sides agree
        already. An object with a conflict, a hold or a blocked change this run, or an op that was not carried, is not receipted. Best effort."""
        plan = self.plan
        try:
            held = {c["handle"] for c in plan.conflicts} | {r["handle"] for r in plan.holds + plan.blocked + self.extra_holds + self.extra_blocked}
            carried = (self.acked | set(plan.advance)) - held - ({op["handle"] for op in plan.ops + plan.destructive} - self.acked)
            decisions.send_pending_receipts(self.side, self.client, carried, self.log)
        except Exception:  # noqa: BLE001 - a receipt that fails is sent by the next push; the run's own result stands
            self.log.line("push: decision receipts failed")

    def _members(self):
        """The member principals' Gramps IDs: the handshake's `member_person_ids` and config.json's, together; None if neither is a list."""
        found = None
        for source in (self.meta.get("member_person_ids"), self.config.get("member_person_ids")):
            if isinstance(source, list):
                found = (found or set()) | {x for x in source if isinstance(x, str)}
        return found

    # --------------------------------------------------------------------------------------------------------- handshake

    def _handshake(self):
        meta = self.client.meta()
        if not isinstance(meta, dict):
            raise PushStop(refused("bad_handshake", consts.EXIT_INTERNAL, "none", "The website's handshake was not understood.", "failed"))
        self.meta = meta
        self.limits = meta.get("limits") if isinstance(meta.get("limits"), dict) else {}
        if meta.get("api_version") != 1:
            raise PushStop(refused("D05", consts.EXIT_CONFIG, "update_addon", "The website speaks a newer sync version. Update the addon first."))
        if meta.get("redaction_version") != consts.REDACTION_VERSION:
            raise PushStop(refused("D05", consts.EXIT_CONFIG, "update_addon", "The website's redaction version differs from this addon's. Update the addon first."))
        bound = meta.get("bound")
        if not isinstance(bound, dict) or not meta.get("tree_id"):
            raise PushStop(refused("cloud_unbound", consts.EXIT_CONFIG, "bind", "The website is not bound to a tree yet. Bind it first (seed-and-shadow)."))
        if bound.get("dbid") != self.tree.dbid:
            raise PushStop(refused("D03", consts.EXIT_CONFIG, "open_bound_tree", consts.REFUSALS["D03"][2]))
        known = pushstate.get_text(self.side, "cloud_tree_id")
        if known and known != meta["tree_id"]:
            raise PushStop(refused("D50", consts.EXIT_CONFIG, "rebase", "The website's store was re-seeded or recovered. Rebase this tree from the Gramps window; nothing is sent automatically."))
        self.cloud_tree_id = meta["tree_id"]
        if not known and not self.dry:
            pushstate.set_text(self.side, "cloud_tree_id", self.cloud_tree_id)
        self.client.versions.tree_id = self.cloud_tree_id
        if meta.get("writes_enabled") is False:
            raise PushStop(refused("sync_paused", consts.EXIT_NOT_ENABLED, "none", "Writes to the website are paused. Wait for io to resume them."))

    # ----------------------------------------------------------------------------------------------------------- outbox

    def _resolve_outbox(self):
        """Sync.md 8.3 step 2: every `sent` row is re-POSTed with its own Idempotency-Key."""
        con = self.side
        for row in pushstate.outbox_rows(con, "sent"):
            pushstate.outbox_mark_attempt(con, row["key"])
            try:
                resp = self.client.post("/api/sync/batches", row["request"]["body"], idempotency_key=row["key"])
            except transport.TransportError as exc:
                if exc.status in (409, 410, 422) or (exc.status is not None and 400 <= exc.status < 500 and exc.status not in (401, 429)):
                    pushstate.outbox_set_state(con, row["key"], "rejected")        # D49: discarded; the next plan recomputes
                    self.log.line("push: outbox %s rejected (%s)" % (row["key"][:12], exc.code))
                    continue
                raise                                                              # network, 5xx, 401: the row stays `sent`
            n = pushstate.ack_batch(con, row["key"], row["request"], resp.body)
            if resp.headers.get("idempotent-replayed") == "true":
                self.replayed += 1
            self._count_pushed(row["request"]["body"]["ops"])
            self.acked.update(op["handle"] for op in row["request"]["body"]["ops"])
            self._record_uploads(row["request"]["body"]["ops"])
            self.log.line("push: outbox %s acked (%d ops)" % (row["key"][:12], n))

    def _count_pushed(self, ops):
        for op in ops:
            self.counts["pushed"]["delete" if op["op"] in ("delete", "withdraw") else op["op"]] += 1

    # --------------------------------------------------------------------------------------------------------- snapshot

    def _snapshot(self):
        last = pushstate.get_text(self.side, "last_pull_seq", "0")
        last = int(last) if str(last).isdigit() else 0
        for attempt in (0, 1):
            route = self.client.get("/api/sync/snapshot").body
            if not isinstance(route, dict) or not isinstance(route.get("url"), str):
                raise transport.TransportError("bad_snapshot_answer", consts.EXIT_TEMPORARY, "retry", message="The snapshot answer was not understood.")
            if isinstance(route.get("seq"), int) and route["seq"] < last:
                raise PushStop(refused("D11", consts.EXIT_TEMPORARY, "retry", "The website is older than the last sync (seq went backwards). Wait; io checks the store.", "failed"))
            try:
                return read_snapshot_bytes(download(self.client, route["url"]), route, self.cloud_tree_id)
            except ValueError as exc:
                self.log.line("push: snapshot attempt %d failed (%s)" % (attempt + 1, exc))
        raise PushStop(refused("D10", consts.EXIT_TEMPORARY, "retry", "The snapshot could not be verified. Run again.", "failed"))

    def _advance_base(self, snap, base):
        """Objects whose local and cloud forms agree: the base row follows the cloud head. Nothing is sent for them."""
        move = []
        for h in self.plan.advance:
            head = snap.heads.get(h)
            row = base.get(h)
            if head is None or head["deleted"]:
                continue
            if row is None or row["deleted"] or row["version"] != head["version"] or row["hash"] != canonical.object_hash(head["obj"]):
                move.append(h)
        if move:
            pushstate.apply_cloud_heads(self.side, snap.heads, move)
        for h in self.plan.drop_base:
            pushstate.drop_base(self.side, h, commit=False)
        self.side.commit()

    # ---------------------------------------------------------------------------------------------------------- preview

    def _preview(self, snap):
        plan = self.plan
        ops = [dict((k, o.get(k)) for k in ("op", "class", "handle", "base_version", "reason") if o.get(k) is not None) for o in plan.ops + plan.destructive]
        for o, src in zip(ops, plan.ops + plan.destructive):
            gid = (src.get("obj") or {}).get("gramps_id")
            if gid:
                o["gramps_id"] = gid
        doc = {
            "schema": 1, "run_id": self.run_id, "action": "push", "created_at": self.now(), "cloud_seq": snap.seq,
            "counts": dict(plan.counts(), media_up=plan.media_up), "ops": ops, "holds": plan.holds, "warnings": plan.warnings, "blocked": plan.blocked, "pull_pending": plan.pull_pending,
            "step_up_fresh": bool(self.step_up), "sticky": sorted(plan.sticky), "mass_delete": bool(plan.mass_delete),
            "conflicts": [{"id": c["id"], "class": c["class"], "handle": c["handle"], "path": c["path"], "kind": c["kind"]} for c in plan.conflicts],
            "plan_sha256": hashlib.sha256(json.dumps(ops, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        }
        os.makedirs(self.tp.previews, mode=0o700, exist_ok=True)
        path = os.path.join(self.tp.previews, "%s.json" % self.run_id)
        from . import paths as paths_
        paths_.atomic_write_json(path, doc)
        self.counts["pushed"] = plan.counts()
        self.counts["media_up"] = plan.media_up
        self.counts["conflicts_open"] = len(plan.conflicts)
        self.counts["holds"] = len(plan.holds)
        self.counts["blocked"] = len(plan.blocked)
        self.outcome["counts"] = self.counts
        self.log.line("push: preview written")
        if plan.has_changes():
            return ("changes_pending", consts.EXIT_DRY_RUN_CHANGES, "none", None)
        if plan.conflicts or plan.blocked or plan.holds:
            return self._partial_result()
        return (consts.OK, consts.EXIT_OK, "none", None)

    # ------------------------------------------------------------------------------------------------------------ pushing

    def _push_ops(self, ops):
        """Pushes `ops` as batches. Returns False when the run must stop (a 409, or nothing more can be sent)."""
        work = [list(b) for b in pushplan.make_batches(ops, self.limits)]
        while work:
            batch = work.pop(0)
            if not batch:
                continue
            verdict = self._send(batch, work)
            if verdict == "stop":
                return False
        return True

    def _body(self, batch):
        ops = []
        for i, op in enumerate(batch, 1):
            ops.append(dict(op, op_id=str(i)))
        body = {"tree_id": self.cloud_tree_id, "client_run_id": self.run_id, "ops": ops}
        if self.session_id:
            body["session_id"] = self.session_id
        return body

    def _key(self, body):
        self.serial += 1
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]
        return "%s-%03d-%s" % (self.run_id, self.serial, digest)

    def _send(self, batch, work):
        con = self.side
        destructive = batch[0]["op"] in ("delete", "withdraw")
        attempts = 1 + consts.MAX_DEAD_BATCH_RETRIES
        while attempts > 0:
            attempts -= 1
            if not batch:
                return "ok"
            if destructive and self.no_step_up:
                self._park(batch, "step_up_required")
                return "ok"
            batch = self._stage_blobs(batch)
            if not batch:
                return "ok"
            body = self._body(batch)
            key = self._key(body)
            request = {"body": body}
            keep = sorted(o["handle"] for o in batch if o["handle"] in self.plan.keep_base and o["op"] in ("create", "update"))
            if keep:
                request["keep"] = keep
            pushstate.outbox_add(con, key, self.session_id, self.now(), request)
            pushstate.outbox_mark_sent(con, key)
            try:
                resp = self.client.post("/api/sync/batches", body, idempotency_key=key)
            except transport.TransportError as exc:
                rest = self._refusal(exc, key, batch, work, destructive)
                if rest == "stop":
                    return "stop"
                if rest == "split":
                    return "ok"
                if self.id_named:
                    attempts += 1                           # the server names one ID per answer and each answer drops its records: progress, not a retry
                batch = rest
                continue
            pushstate.ack_batch(con, key, request, resp.body)
            self._count_pushed(body["ops"])
            self.acked.update(op["handle"] for op in body["ops"])
            self._record_uploads(body["ops"])
            return "ok"
        for op in batch:                                    # the retry budget ran out with ops still unsent: hold them, so the verdict is partial
            self._hold(op, "server_refused")
        return "ok"

    # ---------------------------------------------------------------------------------------------------------------- media

    def _stage_blobs(self, batch):
        """Uploads the blob of every Media op in the batch to its staging key and returns the ops that can go. An op whose blob cannot be
        uploaded this run is held (and so is what refers to a new Media of that kind, so no op points at something the website will not
        have); the website moves a staged blob into place itself, after the op commits, so nothing here touches a served key."""
        out = []
        for op in batch:
            if op["op"] in ("create", "update") and self.deferred_media and pullplan.references(op.get("obj"), self.deferred_media):
                self._defer(op, "media_dependency_deferred")
                continue
            blob = op.get("blob")
            if op["class"] == "Media" and op["op"] in ("create", "update") and isinstance(blob, dict) and blob.get("state") != "missing":
                info = self.plan.uploads.get(op["handle"])
                if info is not None and (op["handle"], info["sha256"]) not in self.staged:
                    try:
                        mediaup.upload(self.client, op["handle"], info)
                    except mediaup.Deferred as exc:
                        self.log.line("push: media %s deferred (%s)" % (op["handle"][:6], exc.rule))
                        self._defer(op, exc.rule)
                        continue
                    self.staged.add((op["handle"], info["sha256"]))
                    self.log.line("push: media %s staged" % op["handle"][:6])
            out.append(op)
        return out

    def _blob_refused(self, exc, batch):
        """The website did not find the staged blob a Media op names (a pending upload that expired, an object it could not verify): the blob
        is uploaded again and the batch re-sent, once per Media; a second refusal defers that Media (D31)."""
        handle = (exc.details or {}).get("handle")
        hit = [o for o in batch if isinstance(handle, str) and o["handle"] == handle and isinstance(o.get("blob"), dict) and o["blob"].get("state") != "missing"]
        if not hit:
            raise exc
        self.staged = {x for x in self.staged if x[0] != handle}
        self.blob_retries[handle] = self.blob_retries.get(handle, 0) + 1
        self.log.line("push: media %s refused (%s)" % (handle[:6], exc.code))
        if self.blob_retries[handle] <= 1:
            return batch
        for o in hit:
            self._defer(o, "media_upload_failed")
        return [o for o in batch if o not in hit]

    def _defer(self, op, rule):
        self._hold(op, rule, path="/blob" if op["class"] == "Media" else "")
        if op["op"] == "create" or op["handle"] not in self.base_handles:
            self.deferred_media.add(op["handle"])

    def _record_uploads(self, ops):
        """An acknowledged Media op that named a blob: the website now holds those bytes, so the next plan does not upload them again."""
        for op in ops:
            blob = op.get("blob")
            if op["class"] != "Media" or op["op"] not in ("create", "update") or not isinstance(blob, dict) or blob.get("state") == "missing":
                continue
            info = self.plan.uploads.get(op["handle"]) if self.plan is not None else None
            path = (info or self.files.get(op["handle"]) or {}).get("path") or ""
            mediaup.record(self.side, op["handle"], path, blob["md5"], blob["sha256"], blob["size"], origin="up")
            self.counts["media_up"] += 1

    def _hold(self, op, rule, blocked=False, path=""):
        row = {"class": op["class"], "handle": op["handle"], "path": path, "rule": rule,
               "detail": consts.HOLD_MESSAGES.get(rule) or "The website refused this record (%s)." % rule}
        (self.extra_blocked if blocked else self.extra_holds).append(row)

    def _park(self, batch, rule):
        for op in batch:
            self._hold(op, rule, blocked=True)

    def _refusal(self, exc, key, batch, work, destructive):
        """What to do with a batch the server refused. Returns the ops to send again, "split" (work was queued) or "stop";
        raises for anything that ends the run (the row is then `rejected`, or stays `sent` when the answer may have been lost)."""
        con = self.side
        self.id_named = False
        lost = exc.status is None or exc.status >= 500 or exc.status == 401
        if lost:
            raise exc                                       # the batch may have committed: the row stays `sent` and is replayed next run
        pushstate.outbox_set_state(con, key, "rejected")
        code = exc.code
        if exc.status == 409 and code in ("version_conflict", "exists"):
            self.moved = True                               # D22: stop pushing; the next run converges
            self.log.line("push: 409 %s" % code)
            return "stop"
        if exc.status == 409 and code in ("session_closed", "session_expired") or (exc.status == 404 and code == "session_not_found"):
            pushstate.del_meta(con, "open_session")
            self.session_id = None
            self._open_session()
            return batch
        if exc.status == 403 and code == "step_up_required" and destructive:
            self.no_step_up = True                          # D07: park the deletes, keep the rest of the run
            self._park(batch, "step_up_required")
            return []
        if exc.status == 413 and code == "batch_too_large":
            if len(batch) == 1:
                self._hold(batch[0], "object_too_large")
                return []
            mid = len(batch) // 2
            work.insert(0, batch[mid:])
            work.insert(0, batch[:mid])
            return "split"
        if exc.status == 422 and code == "idempotency_key_reused":
            return batch                                    # D28: a new key, the same plan
        if exc.status == 422 and code in ("blob_not_uploaded", "blob_mismatch"):
            return self._blob_refused(exc, batch)           # the staged object is gone or is not the claimed one: upload it again, once
        mapping = {"gid_conflict": "gramps_id_taken", "merges_disabled": "merge_held", "assign_desktop_only": "gramps_id_taken",
                   "reserved_id_block": "reserved_id_block", "gramps_id_taken": "gramps_id_taken", "gramps_id_retired": "gramps_id_retired",
                   "renumber_blocked": "renumber_blocked"}
        refused_content = ("privacy_violation", "integrity_violation", "withdrawn_reference", "validation", "unknown_class")
        known = (exc.status == 409 and code in mapping) or (exc.status in (422, 400) and code in refused_content)
        if known:
            hits = _detail_list(exc, "conflicts") or _detail_list(exc, "violations")
            if not hits:
                hits = _id_hits(exc, batch)
                self.id_named = bool(hits)
            by_handle = {(o["class"], o["handle"]): o for o in batch}
            dropped = {}
            for item in hits:
                op = by_handle.get((item.get("class"), item.get("handle")))
                if op is None and str(item.get("op_id", "")).isdigit() and 1 <= int(item["op_id"]) <= len(batch):
                    op = batch[int(item["op_id"]) - 1]
                if op is not None:
                    dropped.setdefault((op["class"], op["handle"]), (op, item))
            culprits = list(dropped.values()) or [(o, {}) for o in batch]    # a refusal that names no op takes the whole batch
            for op, item in culprits:
                if code == "renumber_blocked":
                    self._hold(op, "renumber_blocked", blocked=True)
                elif code in refused_content:
                    self._hold(op, _safe_rule(item.get("rule"), code), path=item.get("pointer") if isinstance(item.get("pointer"), str) else "")
                else:
                    self._hold(op, mapping[code])
            self.server_refused = code
            gone = {id(o) for o, _i in culprits}
            self.log.line("push: %d ops dropped on %s" % (len(gone), code))
            return [o for o in batch if id(o) not in gone]
        raise exc

    # ------------------------------------------------------------------------------------------------------------ sessions

    def _open_session(self):
        expected = ["%s#%s" % (o["class"], o["handle"]) for o in (self.plan.ops if self.plan else [])]
        try:
            resp = self.client.post("/api/sync/sessions", {"expected": expected})
        except transport.TransportError as exc:
            if exc.status == 409 and exc.code == "session_open":
                raise PushStop(refused("D48", consts.EXIT_TEMPORARY, "retry", "Another push session is open on the website (an unfinished earlier run). "
                                       "Wait for it to expire, or abort it from the Gramps window.", "failed"))
            raise
        self.session_id = resp.body["session_id"]
        pushstate.set_text(self.side, "open_session", self.session_id)
        self.log.line("push: session opened")

    def _complete_session(self):
        try:
            resp = self.client.post("/api/sync/sessions/%s/complete" % self.session_id, {})
        except transport.TransportError as exc:
            if exc.status == 422 and exc.code in ("integrity_violation", "withdrawn_reference"):
                for item in _detail_list(exc, "violations"):
                    if item.get("class") in consts.CLASSES and isinstance(item.get("handle"), str):
                        self.extra_holds.append({"class": item["class"], "handle": item["handle"], "path": item.get("pointer") if isinstance(item.get("pointer"), str) else "",
                                                 "rule": "integrity_violation", "detail": consts.HOLD_MESSAGES["integrity_violation"]})
                self.integrity_open = True                   # D25: the session stays open; the next run holds the dependants and pushes again
                return
            if exc.status in (404, 409) and exc.code in ("session_not_found", "session_closed", "session_expired"):
                pushstate.del_meta(self.side, "open_session")
                return
            raise
        # The marker the website writes when it completes a session takes a seq of its own, and the desktop made it: the gramplet's "changes
        # waiting" count must not read it as a website edit (HFY-TSK-343). Recorded in the commit that closes the session, so a crash between
        # the two leaves the session open and the next run completes it again (the website answers the same seq) and records it then.
        seq = resp.body.get("seq") if isinstance(getattr(resp, "body", None), dict) else None
        if isinstance(seq, int) and not isinstance(seq, bool):
            pushstate.record_own_seq(self.side, seq)
        pushstate.del_meta(self.side, "open_session")
        self.log.line("push: session completed")

    # ------------------------------------------------------------------------------------------------------------- result

    def _partial_result(self):
        n_conf = len(self.plan.conflicts)
        nxt = "resolve_conflicts" if n_conf else ("step_up" if any(b["rule"] == "step_up_required" for b in self.plan.blocked + self.extra_blocked) else "none")
        msg = "%d conflicts parked, %d changes blocked, %d objects or fields held." % (
            n_conf, len(self.plan.blocked) + len(self.extra_blocked), len(self.plan.holds) + len(self.extra_holds))
        return ("partial", consts.EXIT_PARTIAL, nxt, {"code": "held", "message": msg})

    def _verdict(self):
        plan = self.plan
        if self.moved:
            return ("partial", consts.EXIT_TEMPORARY, "retry", {"code": "version_conflict", "message": "The website changed while pushing (409). Run again; the next run converges."})
        if self.server_refused in ("privacy_violation", "validation", "unknown_class"):
            return ("partial", consts.EXIT_SERVER_REFUSED, "none", {"code": self.server_refused, "message": "The website refused some content; it was held and the rest was pushed. File a bug."})
        if self.integrity_open:
            return ("partial", consts.EXIT_PARTIAL, "retry", {"code": "integrity_violation", "message": consts.HOLD_MESSAGES["integrity_violation"]})
        if plan.conflicts or plan.blocked or plan.holds or self.extra_blocked or self.extra_holds:
            return self._partial_result()
        return (consts.OK, consts.EXIT_OK, "none", None)

    def settle(self, result):
        """Writes the run's last sidecar rows (holds, counts, last_push_at), prunes the outbox and sends the heartbeat; returns `result`."""
        plan = self.plan
        con = self.side
        if plan is not None and not self.dry:
            try:
                self.side.execute("SELECT 1")
                holds = pushplan._unique(plan.holds + plan.blocked + self.extra_holds + self.extra_blocked)
                pushstate.sync_holds(con, holds, self.now(), self.pathless)
                self.counts["conflicts_open"] = len(pushstate.open_conflicts(con))
                self.counts["holds"] = len(pushplan._unique(plan.holds + self.extra_holds))
                self.counts["blocked"] = len(pushplan._unique(plan.blocked + self.extra_blocked))
                if sum(self.counts["pushed"].values()):
                    pushstate.set_text(con, "last_push_at", self.now())
                pushstate.outbox_prune(con)
            except Exception:  # noqa: BLE001 - the run's own result stands; a sidecar write that fails here is the next run's to redo
                self.log.line("push: sidecar bookkeeping failed")
        self.outcome["counts"] = self.counts
        if plan is not None and not self.dry:
            self._heartbeat(result)
        return result

    def _heartbeat(self, result):
        """POST /api/sync/status (sync.md 8.3 step 13). Best effort: a failure never changes the run's result."""
        try:
            meta = sidecar.meta(self.side)
            flat = {}
            for k, v in self.counts.items():
                if isinstance(v, dict):
                    flat.update({"%s_%s" % (k, kk): vv for kk, vv in v.items()})
                else:
                    flat[k] = v
            self.client.post("/api/sync/status", {
                "client_instance_id": self.config.get("client_instance_id") or "unknown-instance", "dbid": self.tree.dbid,
                "fingerprint": meta.get("fingerprint") or "unknown-fingerprint", "addon_version": consts.ADDON_VERSION,
                "gramps_version": self.tree.gramps_version or "unknown", "schema": self.tree.schema_version,
                "last_run": {"run_id": self.run_id, "action": "push", "result": result[0], "exit_code": result[1], "counts": flat, "finished_at": self.now()},
            })
        except Exception:  # noqa: BLE001
            self.log.line("push: heartbeat failed")
