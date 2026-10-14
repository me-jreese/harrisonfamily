"""One render pass (BRD2 section 11, sync.md 11.1, HFY-TSK-176).

A pass reads ``SYNC#HEAD.seq``, folds the store view, renders the whole site with ``hfygramps.render``, re-checks every output,
diffs it against the mode's manifest, writes only what changed, deletes only what the renderer owns and no longer wants, and then
advances ``SYNC#RENDER.rendered_seq`` (with the ``SYNC#RENDERED`` outbox item, in one transaction) only after every write succeeded.

What a pass never does: write or delete a key outside ``keys.is_owned_key``; carry an exception message anywhere; run twice at once
(reserved concurrency 1, and the cursor update is conditional); advance on a failure; delete in bulk on its own authority
(the mass-delete guard), except the exposure-reducing deletes a withdraw or a moderation hide causes.
"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from . import RENDERER_VERSION, errors
from .aws import HEAD_PK, seq_key
from .keys import DATA_PREFIXES, is_owned_key
from .privacy import PrivacyChecker
from .view import CLASSES, StoreView, closure_from, people_of, reverse_refs, sha256_hex
from hfygramps.render import site

MODES = ("off", "shadow", "live")
SESSION_QUIET_SECONDS = 600
SESSION_TTL_SECONDS = 7 * 86400
RECONCILE_EVERY_SECONDS = 86400
MASS_DELETE_FLOOR = 10
MASS_DELETE_FRACTION = 0.10
OUTBOX_TTL_SECONDS = 400 * 86400
OUTBOX_LIST_CAP = 10_000
MANIFEST_SAVE_EVERY = 250
BUDGET_MARGIN_MS = 20_000
REPORT_LIST_CAP = 2_000

log = logging.getLogger("hfy.render")


def manifest_key(mode: str) -> str:
    return f"render/manifest-{mode}.json"


def parse_time(text: Any) -> Optional[datetime]:
    """An ISO-8601 time (``...Z`` or an offset) as an aware UTC datetime, or None."""

    if not isinstance(text, str) or not text:
        return None
    try:
        value = text.strip()
        if value.endswith("Z") or value.endswith("z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


@dataclass
class Request:
    source: str = "direct"
    allow_mass_delete: bool = False
    prune_foreign: bool = False
    force: bool = False
    reconcile: bool = False

    @property
    def operator(self) -> bool:
        """An operator flag that asks for a full pass although the cursor is current (``reconcile`` alone does not)."""

        return self.allow_mass_delete or self.prune_foreign or self.force


def parse_event(event: Any) -> Request:
    """The trigger and the operator flags. A flag counts only when it is exactly ``true`` (``{"allow_mass_delete": true}``)."""

    if not isinstance(event, dict):
        return Request()
    records = event.get("Records")
    if isinstance(records, list) and records and all(isinstance(r, dict) and r.get("eventSource") == "aws:dynamodb" for r in records):
        return Request(source="stream")
    return Request(
        source="schedule" if event.get("source") == "schedule" else ("operator" if event else "direct"),
        allow_mass_delete=event.get("allow_mass_delete") is True,
        prune_foreign=event.get("prune_foreign") is True,
        force=event.get("force") is True,
        reconcile=event.get("reconcile") is True,
    )


@dataclass
class Deps:
    """The ports. ``sync_root`` is the whole sync bucket (manifests and reports live in it); ``live_bucket`` is the site bucket;
    ``shadow_bucket`` is the ``render-shadow/`` prefix of the sync bucket. A pass writes to exactly one of the last two."""

    table: Any
    sync_root: Any
    live_bucket: Any
    shadow_bucket: Any
    metrics: Any
    mode: str
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    overlay: Any = None  # hook for hfy-moderation-record-targets: .apply(objects) -> (objects, exempt_delete_keys)
    text_gate: Any = None
    workers: int = 8
    remaining_ms: Callable[[], int] = lambda: 10 ** 9
    checker: PrivacyChecker = field(default_factory=PrivacyChecker)


@dataclass
class Plan:
    """The outcome of the diff, before any write."""

    writes: List[str]
    deletes: List[str]
    refused: List[str]
    exempt_deletes: List[str]
    foreign: List[str]
    unlisted: List[str]
    exposure_reduced: bool = False  # a withdraw or a moderation hide is part of this pass (so a stale public copy is a leak)


class Engine:
    def __init__(self, deps: Deps) -> None:
        if deps.mode not in MODES:
            raise errors.RenderFailed(errors.RULE_BAD_MODE)
        self.d = deps

    # ------------------------------------------------------------------------------------------------------------- entry
    def run(self, event: Any) -> Dict[str, Any]:
        req = parse_event(event)
        if self.d.mode == "off":
            return {"status": "noop", "mode": "off"}
        started = time.monotonic()
        try:
            out = self._run(req)
        except errors.RenderFailed as exc:
            self._fail(exc)
            raise errors.RenderFailed(exc.rule, exc.cause_class or type(exc).__name__) from None
        except BaseException as exc:  # noqa: B902 - sanitised below, never its message
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            self._fail(exc)
            cls, _ = errors.describe(exc)
            raise errors.RenderFailed("pass.failed", cls) from None
        out["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        log.info("render %s", json.dumps({k: v for k, v in out.items() if isinstance(v, (int, str))}, sort_keys=True))
        return out

    def _fail(self, exc: BaseException) -> None:
        """Records the class and rule id (never a message), raises the RenderError metric. Both are best effort."""

        cls, rule = errors.describe(exc)
        log.error("render failed class=%s rule=%s", cls, rule or "-")
        try:
            self.d.metrics.emit("RenderError", 1)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.d.table.write_state({"last_error": errors.last_error_text(exc), "last_error_at": iso(self.d.clock()), "mode_attempted": self.d.mode})
        except Exception:  # noqa: BLE001
            log.error("render failed to record last_error")

    # -------------------------------------------------------------------------------------------------------------- pass
    def _run(self, req: Request) -> Dict[str, Any]:
        d = self.d
        now = d.clock()
        mode = d.mode
        state = d.table.read_state() or {}
        head = d.table.get(HEAD_PK, "META", consistent=True)
        seq = int(head.get("seq") or 0) if head else 0
        if seq <= 0:
            return {"status": "skipped", "reason": "empty_store", "mode": mode, "seq": 0}

        stored_mode = state.get("mode")
        first_pass = stored_mode != mode  # includes "no state yet": a new mode renders from nothing and trusts no cursor
        cursor = None if state.get("rendered_seq") is None else int(state["rendered_seq"])
        prev_seq = 0 if first_pass or cursor is None else cursor
        due = first_pass or seq > prev_seq or req.operator
        reconcile_due = req.reconcile or (
            req.source == "schedule"
            and (parse_time(state.get("last_reconcile_at")) is None
                 or (now - parse_time(state.get("last_reconcile_at"))).total_seconds() >= RECONCILE_EVERY_SECONDS)
        )

        if self._session_young(head, now):
            return {"status": "skipped", "reason": "push_session_open", "mode": mode, "seq": seq}

        if not due and not reconcile_due:
            return {"status": "skipped", "reason": "current", "mode": mode, "seq": seq}

        view = self._build_view(seq, None if first_pass else prev_seq)
        if not due:
            counts = self._reconcile(view, now)
            return {"status": "reconciled", "mode": mode, "seq": seq, **counts}

        result = self._render_and_apply(req, state, view, seq, prev_seq, first_pass, cursor, now)
        if reconcile_due and result.get("status") == "rendered":
            counts = self._reconcile(view, now)
            result.update(counts)
        return result

    # ------------------------------------------------------------------------------------------------------------ session
    def _session_young(self, head: Dict[str, Any], now: datetime) -> bool:
        """True while a push session younger than 10 minutes is open: a half-pushed tree is not rendered, and the cursor does not move."""

        sid = head.get("open_session") if head else None
        if not sid:
            return False
        session = self.d.table.get(f"SYNC#SESSION#{sid}", "META", consistent=True)
        if not session or session.get("state") != "open":
            return False
        opened = parse_time(session.get("opened_at"))
        if opened is None and isinstance(session.get("ttl"), int) and not isinstance(session.get("ttl"), bool):
            opened = datetime.fromtimestamp(session["ttl"] - SESSION_TTL_SECONDS, tz=timezone.utc)  # the 7-day ttl dates the open
        if opened is None:
            # No usable clock on an open session: fail closed (a half-pushed tree is not rendered) and alarm. The API treats such a
            # session as open too; aborting it (POST /api/sync/sessions/:id/abort) releases the render.
            self._alarm("RenderError", errors.RULE_SESSION_OPENED_AT, now)
            return True
        age = (now - opened).total_seconds()
        if age >= SESSION_TTL_SECONDS:
            return False  # treated as expired at opened_at + 7 d, without waiting for the TTL delete
        return age < SESSION_QUIET_SECONDS

    def _alarm(self, metric: str, rule: str, now: datetime) -> None:
        """A metric, a log line and ``last_error`` for a condition that holds a pass without being an exception. Best effort."""

        log.error("render alarm %s rule=%s", metric, rule)
        try:
            self.d.metrics.emit(metric, 1)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.d.table.write_state({
                "last_error": errors.last_error_text(errors.RenderFailed(rule)), "last_error_at": iso(now), "mode_attempted": self.d.mode,
            })
        except Exception:  # noqa: BLE001
            log.error("render failed to record last_error")

    # --------------------------------------------------------------------------------------------------------------- view
    def _build_view(self, target: int, track_after: Optional[int]) -> StoreView:
        view = StoreView(track_after=track_after)
        for item in self.d.table.query_log(1, target):
            view.fold(item)
        if view.seq < target:
            raise errors.RenderFailed(errors.RULE_SNAPSHOT_GAP)
        return view

    def _media_files(self, objects: Dict[Tuple[str, str], Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        keys = [(f"REC#Media#{h}", "HEAD") for (cls, h) in objects if cls == "Media"]
        if not keys:
            return {}
        items = self.d.table.batch_get(keys)
        out: Dict[str, Dict[str, Any]] = {}
        for (pk, _sk), item in items.items():
            blob = item.get("blob")
            if item.get("deleted") is True or not isinstance(blob, dict) or blob.get("state") != "present":
                continue
            sha = blob.get("sha256")
            if not isinstance(sha, str) or not sha:
                continue
            s3_key = blob.get("s3_key") if isinstance(blob.get("s3_key"), str) else ""
            dot = s3_key.rfind(".")
            ext = s3_key[dot:].lower() if dot > s3_key.rfind("/") else None
            out[pk[len("REC#Media#"):]] = {"checksum": sha, "size": blob.get("size"), "ext": ext or None}
        return out

    # ----------------------------------------------------------------------------------------------------- render + apply
    def _render_and_apply(
        self, req: Request, state: Dict[str, Any], view: StoreView, seq: int, prev_seq: int, first_pass: bool,
        cursor: Optional[int], now: datetime,
    ) -> Dict[str, Any]:
        d = self.d
        mode = d.mode
        objects = view.parsed_objects()
        object_list = [objects[k] for k in sorted(objects)]
        exempt_keys: Set[str] = set()
        if d.overlay is not None:
            object_list, exempt = d.overlay.apply(object_list)
            exempt_keys = set(exempt or ())
        media_files = self._media_files({(o["_class"], o["handle"]): o for o in object_list if o.get("_class") == "Media"})
        rendered = site.render(object_list, media_files=media_files, generated_at=view.last_at or site.DEFAULT_GENERATED_AT, text_gate=d.text_gate)

        # The privacy re-check: a failing file is not written and not deleted (the site keeps the last good copy).
        blocked: Dict[str, List[str]] = {}
        bodies: Dict[str, bytes] = {}
        for key, body in rendered.files.items():
            if not is_owned_key(key):
                blocked[key] = [errors.RULE_KEY_UNOWNED]
                continue
            rules = d.checker.check(body)
            if rules:
                blocked[key] = rules
            else:
                bodies[key] = body
        desired = {k: sha256_hex(v) for k, v in bodies.items()}
        if blocked:
            d.metrics.emit("RenderPrivacyBlock", len(blocked))
            log.error("render privacy block files=%d rules=%s", len(blocked), ",".join(sorted({r for rs in blocked.values() for r in rs})))

        # The first live pass ignores every manifest, writes every desired key and verifies each (BRD2 11.1). A first live pass that did
        # not finish (a time budget, a failed write) is resumed from its own manifest, never restarted: the state item names the attempt
        # and the manifest carries the same name, so a manifest from an earlier live period can never be mistaken for it.
        first_live = mode == "live" and first_pass
        try:
            stored, stored_attempt = self._load_manifest(mode)
        except errors.RenderFailed:
            if not first_live:
                raise
            stored, stored_attempt = {}, None  # a first live pass trusts no manifest, so an unreadable one does not stop it
        attempt = state.get("first_live_attempt") if first_live else None
        resume = bool(first_live and attempt and stored_attempt == attempt)
        ignore_manifest = first_live and not resume
        if ignore_manifest:
            attempt = iso(now)
            d.table.write_state({"first_live_attempt": attempt})
        base: Dict[str, Optional[str]] = {} if ignore_manifest else {k: v for k, v in stored.items() if is_owned_key(k)}
        bucket = d.live_bucket if mode == "live" else d.shadow_bucket

        plan = self._plan(req, view, objects, desired, blocked, base, bucket, ignore_manifest, first_live, exempt_keys)

        # Ownership is persisted before the first write (a key being written is owned, content unknown), so a crash between a write
        # and the final manifest can never leave an owned file that the next pass would call foreign.
        current: Dict[str, Optional[str]] = dict(base)
        for k in plan.writes:
            current[k] = base.get(k)
        if plan.writes or plan.deletes or ignore_manifest:
            self._save_manifest(mode, current, seq, attempt)

        written: List[str] = []
        deleted: List[str] = []
        progress = {"since_save": 0}

        def wrote(key: str, _result: Any) -> None:
            written.append(key)
            current[key] = desired[key]
            progress["since_save"] += 1

        def removed(key: str, _result: Any) -> None:
            deleted.append(key)
            current.pop(key, None)
            progress["since_save"] += 1

        def maybe_save() -> None:
            if progress["since_save"] >= MANIFEST_SAVE_EVERY:
                progress["since_save"] = 0
                self._save_manifest(mode, current, seq, attempt)

        try:
            # Exposure-reducing deletes go first.
            self._parallel(plan.deletes, lambda k: self._delete_one(bucket, k), removed, maybe_save)
            self._parallel(plan.writes, lambda k: self._write_one(bucket, k, bodies[k], desired[k], first_live), wrote, maybe_save)
        finally:
            if written or deleted:
                try:
                    self._save_manifest(mode, current, seq, attempt)
                except Exception:  # noqa: BLE001
                    log.error("render manifest not saved")

        pruned: List[str] = []
        if req.prune_foreign and plan.foreign:
            self._parallel(plan.foreign, lambda k: self._delete_one(bucket, k), lambda k, _r: pruned.append(k), None)

        guard_tripped = bool(plan.refused)
        if guard_tripped or plan.exempt_deletes:
            # AC7: an exposure-reducing delete is exempt from the guard but always alarms, however few there are (one MassDeleteGuard
            # per pass; the report and the log carry the counts).
            d.metrics.emit("MassDeleteGuard", 1)
        if guard_tripped:
            log.error("render mass-delete guard refused=%d limit=%d", len(plan.refused), self._limit(base))
        elif plan.exempt_deletes:
            log.warning("render exempt deletes=%d", len(plan.exempt_deletes))

        counts = {
            "written": len(written), "deleted": len(deleted), "unchanged": len(desired) - len(plan.writes),
            "blocked": len(blocked), "refused_deletes": len(plan.refused), "exempt_deletes": len(plan.exempt_deletes),
            "foreign": len(plan.foreign), "pruned": len(pruned), "files": len(desired),
        }
        self._report(mode, seq, counts, written, deleted, blocked, plan, now)

        # A withdraw or a hide plus a privacy-blocked file: the blocked file keeps its last good copy, and that copy (an index, a family
        # file, a search entry) may still name the person who was just withdrawn. The cursor does not move, a distinct last_error is
        # stored (the RenderPrivacyBlock alarm already fired for the blocked files), and the schedule retries until the block clears or
        # an operator acts (BRD2 R-18).
        withdraw_held = mode == "live" and bool(blocked) and plan.exposure_reduced and not guard_tripped
        if withdraw_held:
            log.error("render withdraw held by privacy block files=%d", len(blocked))
            d.table.write_state({
                "last_error": errors.last_error_text(errors.RenderFailed(errors.RULE_WITHDRAW_BLOCKED)),
                "last_error_at": iso(now), "mode_attempted": mode, "blocked_files": len(blocked),
            })
            return {"status": "blocked", "reason": errors.RULE_WITHDRAW_BLOCKED, "mode": mode, "seq": seq, **counts}

        if guard_tripped:
            d.table.write_state({
                "last_error": errors.last_error_text(errors.RenderFailed(errors.RULE_MASS_DELETE)),
                "last_error_at": iso(now), "mode_attempted": mode, "refused_deletes": len(plan.refused),
            })
            return {"status": "blocked", "reason": errors.RULE_MASS_DELETE, "mode": mode, "seq": seq, **counts}

        # Advance: the cursor, and in live mode the outbox item, in one transaction.
        outbox = None
        if mode == "live" and (first_pass or seq > prev_seq):
            outbox = self._outbox(view, objects, seq, prev_seq, first_pass, now)
        fields: Dict[str, Any] = {
            "rendered_seq": seq, "mode": mode, "renderer_version": RENDERER_VERSION, "last_full_at": iso(now),
            "last_pass": counts, "blocked_files": len(blocked), "foreign_keys": len(plan.foreign),
        }
        remove = ["refused_deletes", "mode_attempted", "first_live_attempt"]
        if blocked:
            first_rule = sorted({r for rs in blocked.values() for r in rs})[0]
            fields["last_error"] = f"RenderPrivacyBlock:{first_rule}"
            fields["last_error_at"] = iso(now)
        else:
            remove.append("last_error")
            remove.append("last_error_at")
        d.table.commit_pass(cursor, fields, remove, outbox)
        return {"status": "rendered", "mode": mode, "seq": seq, **counts}

    # ------------------------------------------------------------------------------------------------------------- plan
    def _limit(self, base: Dict[str, Any]) -> float:
        return max(MASS_DELETE_FLOOR, MASS_DELETE_FRACTION * len(base))

    def _plan(
        self, req: Request, view: StoreView, objects: Dict[Tuple[str, str], Dict[str, Any]], desired: Dict[str, str],
        blocked: Dict[str, List[str]], base: Dict[str, Optional[str]], bucket: Any, ignore_manifest: bool, first_live: bool,
        exempt_keys: Set[str],
    ) -> Plan:
        writes = sorted(k for k, sha in desired.items() if ignore_manifest or base.get(k) != sha)

        gone = sorted(k for k in base if k not in desired and k not in blocked)
        withdrawn_gids = {h.gramps_id for h in view.heads.values() if h.cls == "Person" and h.deleted and h.op == "withdraw" and h.gramps_id}
        withdrawn_handles: Set[str] = {h.handle for h in view.heads.values() if h.deleted and h.op == "withdraw"}
        for t in view.touched.values():
            if t.key[0] == "Person" and t.op == "withdraw" and t.prev_json:
                try:
                    prev = json.loads(t.prev_json)
                except ValueError:
                    continue
                withdrawn_handles |= closure_from(prev, objects)

        def exempt(key: str) -> bool:
            if key in exempt_keys:
                return True
            prefix, name = key[:-5].split("/", 1)
            return name in withdrawn_gids if prefix == "person" else name in withdrawn_handles

        exempt_deletes = [k for k in gone if exempt(k)]
        regular = [k for k in gone if not exempt(k)]
        tripped = len(regular) > self._limit(base) and not req.allow_mass_delete
        deletes = list(exempt_deletes) if tripped else list(gone)
        refused = list(regular) if tripped else []

        foreign: List[str] = []
        unlisted: List[str] = []
        if first_live or req.reconcile or req.prune_foreign:
            known = set(desired) | set(blocked) | set(base) | set(gone)
            foreign, unlisted = self._foreign(bucket, known)
        exposure_reduced = bool(
            exempt_deletes or any(t.op == "withdraw" for t in view.touched.values())
            or (first_live and any(h.deleted and h.op == "withdraw" for h in view.heads.values()))
        )
        return Plan(writes, sorted(deletes), sorted(refused), sorted(exempt_deletes), foreign, unlisted, exposure_reduced)

    def _foreign(self, bucket: Any, known: Set[str]) -> Tuple[List[str], List[str]]:
        """Renderer-shaped keys under the data prefixes that the renderer never wrote: reported, deleted only by ``prune_foreign``."""

        foreign: List[str] = []
        unlisted: List[str] = []
        for prefix in DATA_PREFIXES:
            try:
                for key in bucket.list_keys(prefix + "/"):
                    if is_owned_key(key) and key not in known:
                        foreign.append(key)
            except Exception as exc:  # noqa: BLE001
                code = getattr(exc, "response", {}).get("Error", {}).get("Code")
                if code in ("AccessDenied", "403"):
                    unlisted.append(prefix)  # the renderer role lists some prefixes only (app-stack RenderedDataList)
                else:
                    raise
        return sorted(foreign), unlisted

    # ----------------------------------------------------------------------------------------------------------- writing
    def _write_one(self, bucket: Any, key: str, body: bytes, sha: str, verify: bool) -> None:
        if not is_owned_key(key):
            raise errors.ProtectedKey()
        bucket.put(key, body, sha)
        if verify:
            got = bucket.head_sha256(key)
            if got != sha:
                raise errors.RenderFailed(errors.RULE_CHECKSUM)

    def _delete_one(self, bucket: Any, key: str) -> None:
        if not is_owned_key(key):
            raise errors.ProtectedKey()
        bucket.delete(key)

    def _parallel(
        self, keys: List[str], fn: Callable[[str], Any], done: Callable[[str, Any], None], after: Optional[Callable[[], None]] = None,
    ) -> None:
        """Runs ``fn(key)`` for every key (a small thread pool); ``done`` runs in the calling thread as each finishes.

        The first failure stops submitting work and is re-raised after the in-flight calls finish, so what succeeded is recorded."""

        if not keys:
            return
        error: Optional[BaseException] = None

        def check_budget() -> Optional[BaseException]:
            return errors.RenderFailed(errors.RULE_TIMEOUT) if self.d.remaining_ms() < BUDGET_MARGIN_MS else None

        if self.d.workers <= 1 or len(keys) < 2:
            for key in keys:
                error = check_budget()
                if error:
                    break
                try:
                    result = fn(key)
                except BaseException as exc:  # noqa: B902
                    error = exc
                    break
                done(key, result)
                if after:
                    after()
        else:
            with ThreadPoolExecutor(max_workers=self.d.workers) as pool:
                futures = {pool.submit(fn, key): key for key in keys}
                for fut in as_completed(futures):
                    key = futures[fut]
                    try:
                        result = fut.result()
                    except BaseException as exc:  # noqa: B902
                        if error is None:
                            error = exc
                            for other in futures:
                                other.cancel()
                        continue
                    done(key, result)
                    if error is None:
                        error = check_budget()
                        if error:
                            for other in futures:
                                other.cancel()
                    if after and error is None:
                        after()
        if error is not None:
            raise error

    # ---------------------------------------------------------------------------------------------------------- manifest
    def _load_manifest(self, mode: str) -> Tuple[Dict[str, Optional[str]], Optional[str]]:
        raw = self.d.sync_root.get(manifest_key(mode))
        if raw is None:
            return {}, None
        try:
            doc = json.loads(raw.decode("utf-8"))
            keys = doc["keys"]
            if not isinstance(keys, dict):
                raise ValueError
            attempt = doc.get("attempt")
            return {k: (v if isinstance(v, str) else None) for k, v in keys.items() if isinstance(k, str)}, (attempt if isinstance(attempt, str) else None)
        except (ValueError, KeyError, UnicodeDecodeError, AttributeError):
            raise errors.RenderFailed("manifest.corrupt") from None

    def _save_manifest(self, mode: str, keys: Dict[str, Optional[str]], seq: int, attempt: Optional[str] = None) -> None:
        doc: Dict[str, Any] = {"version": 1, "mode": mode, "seq": seq, "keys": {k: keys[k] for k in sorted(keys)}}
        if attempt:
            doc["attempt"] = attempt
        body = json.dumps(doc, sort_keys=True).encode("utf-8")
        self.d.sync_root.put(manifest_key(mode), body, sha256_hex(body))

    def _report(self, mode: str, seq: int, counts: Dict[str, int], written: List[str], deleted: List[str], blocked: Dict[str, List[str]], plan: Plan, now: datetime) -> None:
        """``render/reports/<seq>.json``: keys and counts only, never text. Best effort."""

        doc = {
            "seq": seq, "mode": mode, "at": iso(now), "counts": counts,
            "written": sorted(written)[:REPORT_LIST_CAP], "deleted": sorted(deleted)[:REPORT_LIST_CAP],
            "refused_deletes": plan.refused[:REPORT_LIST_CAP], "foreign": plan.foreign[:REPORT_LIST_CAP], "foreign_unlisted_prefixes": plan.unlisted,
            "blocked": [{"key": k, "rules": blocked[k]} for k in sorted(blocked)][:REPORT_LIST_CAP],
        }
        try:
            body = json.dumps(doc, sort_keys=True).encode("utf-8")
            self.d.sync_root.put(f"render/reports/{seq}.json", body, sha256_hex(body))
        except Exception:  # noqa: BLE001
            log.error("render report not written")

    # ----------------------------------------------------------------------------------------------------------- outbox
    def _outbox(self, view: StoreView, objects: Dict[Tuple[str, str], Dict[str, Any]], seq: int, prev_seq: int, baseline: bool, now: datetime) -> Dict[str, Any]:
        """The ``SYNC#RENDERED/<seq>`` item: the only source of record-change notifications (SI-20).

        ``changed_people`` is every live person whose page a change in the range can alter, from the store's backrefs; a first pass in a
        mode is a baseline with no people (the site simply came online), so a cutover never notifies."""

        changed: Set[str] = set()
        deleted_people: Set[str] = set()
        if not baseline:
            rev = reverse_refs(objects)

            def gid_of(key: Tuple[str, str]) -> str:
                head = view.heads.get(key)
                obj = objects.get(key) or {}
                value = (head.gramps_id if head else "") or obj.get("gramps_id") or ""
                return value.strip() if isinstance(value, str) else ""

            changed = people_of(list(view.touched), objects, rev, gid_of)
            live_ids = {gid_of(k) for k in objects if k[0] == "Person"}
            for t in view.touched.values():
                if t.key[0] == "Person" and t.key not in objects and t.gramps_id and t.gramps_id not in live_ids:
                    deleted_people.add(t.gramps_id.strip())
        item: Dict[str, Any] = {
            "PK": "SYNC#RENDERED", "SK": seq_key(seq), "entity": "rendered",
            "seq_from": 1 if baseline else prev_seq + 1, "seq_to": seq, "baseline": baseline,
            "changed_people": sorted(changed)[:OUTBOX_LIST_CAP], "changed_count": len(changed),
            "deleted_people": sorted(deleted_people)[:OUTBOX_LIST_CAP], "deleted_count": len(deleted_people),
            "principals": sorted(view.principals)[:200], "origins": sorted(view.origins), "entries": view.range_entries,
            "truncated": len(changed) > OUTBOX_LIST_CAP or len(deleted_people) > OUTBOX_LIST_CAP,
            "at": iso(now), "ttl": int((now + timedelta(seconds=OUTBOX_TTL_SECONDS)).timestamp()),
        }
        return item

    # --------------------------------------------------------------------------------------------------------- reconcile
    def _reconcile(self, view: StoreView, now: datetime) -> Dict[str, Any]:
        """Daily: the view's hashes against the heads (GSI1 RECS#<Class>). A difference confirmed by a consistent read is a HeadMismatch."""

        suspects: List[Tuple[str, str]] = []
        for cls in CLASSES:
            seen: Set[str] = set()
            for item in self.d.table.query_heads(cls):
                handle = item.get("handle")
                if not isinstance(handle, str):
                    continue
                seen.add(handle)
                if int(item.get("seq") or 0) > view.seq:
                    continue  # written after the view's seq: not comparable
                if self._differs(view.heads.get((cls, handle)), item):
                    suspects.append((cls, handle))
            for (kcls, khandle), head in view.heads.items():
                if kcls == cls and khandle not in seen and not head.deleted:
                    suspects.append((cls, khandle))
        confirmed = 0
        if suspects:
            items = self.d.table.batch_get([(f"REC#{c}#{h}", "HEAD") for c, h in suspects])
            for c, h in suspects:
                item = items.get((f"REC#{c}#{h}", "HEAD"))
                if int(item.get("seq") or 0) > view.seq if item else False:
                    continue
                if item is None:
                    if (c, h) in view.heads and not view.heads[(c, h)].deleted:
                        confirmed += 1
                elif self._differs(view.heads.get((c, h)), item):
                    confirmed += 1
        if confirmed:
            self.d.metrics.emit("HeadMismatch", confirmed)
            log.error("render head mismatch count=%d", confirmed)
        self.d.table.write_state({"last_reconcile_at": iso(now), "last_reconcile_mismatches": confirmed})
        return {"reconcile_mismatches": confirmed}

    @staticmethod
    def _differs(head: Any, item: Dict[str, Any]) -> bool:
        if head is None:
            return item.get("deleted") is not True and not item.get("expunged")
        if item.get("expunged") or item.get("deleted") is True:
            return not head.deleted
        if head.deleted:
            return True
        if int(item.get("version") or 0) != head.version:
            return True
        want = item.get("hash")
        return isinstance(want, str) and want != sha256_hex((head.obj_json or "").encode("utf-8"))
