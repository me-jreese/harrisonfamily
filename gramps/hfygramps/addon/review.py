"""What the Gramps window shows and does (sync.md 13.1; task addon-gui-preview, HFY-TSK-208), with no Gtk in it.

    Flow.review()   runs `check` (the pull's dry run) and a dry `push`, reads the two preview files and builds the model
    build_model()   the header, the five sections with counts, the field-level diffs, the choices of every conflict, the confirmations
    Flow.apply()    one run after the person approved the preview: the editor-window check (D45), the pull with the decisions carried
                    out, then the push (step-up just before the deletes, which go first: D07), then the result banner
    banner()        the counts, the backup path and the undo warning

The Gtk code (`hfy_sync/hfy_sync_ui.py`) only draws this model and collects the answers, so every rule here is tested without a window.

What may be shown where (BRD2 11.1, PS-21). The preview files hold pointers and projected values only, and the command line never prints
a value. This module is the one place a value is read for display, and it reads the "yours" side of a conflict live from the database
(the local-only part included: a day and month, a street-level place), in memory, for the window. That value is never written to a file,
a log or status.json, and never put in a request: the push sends the projection of the tree, which has no such part. The website and base
columns come from the preview (projected values), so a local-only value appears only in the "yours" column of a conflict.

Standard library only; Python 3.9 compatible, no Gramps import.
"""
import calendar
import json
import os
import time
from urllib.parse import quote

from .. import merge as M
from .. import projection as PR
from .. import rules as R
from . import consts, decide, paths, preflight, pull as pull_mod, pushstate, runner, sidecar, status
from . import plan as plan_mod

SECTIONS = (("from_website", "From the website"), ("to_website", "To the website"), ("conflicts", "Conflicts"),
            ("held", "Held back"), ("blocked", "Blocked"))
UNDO_WARNING = ("A backup is taken before anything changes. Undo is available until you close the tree; "
                "undoing will revert these changes on the website at the next sync.")

# Blocks that appear as "waiting for your confirmation" in To the website, not in Blocked (the window runs the push with `yes`).
CONFIRMABLE = consts.CONFIRMABLE_RULES


# ----------------------------------------------------------------------------------------------------------------------- text


def relative_time(iso, now=None):
    """'5 minutes ago' for an ISO UTC time (the status documents' form); '' when there is none."""
    if not iso:
        return ""
    try:
        then = calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        return ""
    secs = int((time.time() if now is None else now) - then)
    if secs < 90:
        return "just now"
    for size, unit in ((86400, "day"), (3600, "hour"), (60, "minute")):
        if secs >= size:
            n = secs // size
            return "%d %s%s ago" % (n, unit, "" if n == 1 else "s")
    return "just now"


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def date_text(date):
    """A Gramps Date (raw or projected) as short text: '14 Feb 1840', 'Feb 1840' or '1840'; its own text when it has one and no numbers."""
    if not isinstance(date, dict):
        return ""
    dv = date.get("dateval") or []
    if len(dv) >= 3 and dv[2]:
        d, m, y = dv[0], dv[1], dv[2]
        out = ("%d " % d if d else "") + (_MONTHS[m - 1] + " " if m and 1 <= m <= 12 else "") + str(y)
        return out
    return str(date.get("text") or "")


def short(value, limit=80):
    """A value as one short line for the window. Never used for the CLI or a log."""
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        text = value
    elif isinstance(value, dict):
        if value.get("clipped_bytes"):
            return "(a large value, %d bytes)" % value["clipped_bytes"]
        if value.get("_class") == "Date" or "dateval" in value:
            text = date_text(value) or "(no date)"
        elif isinstance(value.get("_class"), str) and value["_class"].endswith("Type") and "value" in value:
            text = value.get("string") or "type %s" % value["value"]     # a Gramps type: its custom name, else its number
        elif isinstance(value.get("string"), str):
            text = value["string"]
        else:
            text = json.dumps(value, sort_keys=True, ensure_ascii=False)
    else:
        text = json.dumps(value, sort_keys=True, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def pretty_path(path):
    """'/primary_name/first_name' as 'primary name › first name'; keyed list tokens lose their handle and counter."""
    if not path:
        return "the whole record"
    parts = []
    for tok in path.strip("/").split("/"):
        tok = tok.replace("~1", "/").replace("~0", "~")
        if "#" in tok:
            tok = "item"
        parts.append(tok.replace("_", " "))
    return " › ".join(parts)


def object_title(cls, gid):
    return ("%s %s" % (cls, gid)).strip()


def person_name(obj):
    """'First Surname' from a raw Person (live from the database), '' when it has none."""
    if not isinstance(obj, dict) or obj.get("_class") != "Person":
        return ""
    name = obj.get("primary_name") or {}
    surnames = " ".join(s.get("surname", "") for s in name.get("surname_list") or [] if isinstance(s, dict) and s.get("surname"))
    return " ".join(x for x in (name.get("first_name", ""), surnames) if x)


def person_url(server, cls, gid):
    """The website page of a person (design rule P2-R46: a person's name links to /person/?id=<gramps id>), None for anything else or with no id."""
    if cls != "Person" or not gid or not server or not safe_web_url(server):
        return None
    return "%s/person/?id=%s" % (server.rstrip("/"), quote(str(gid), safe=""))


def safe_web_url(url):
    """The URL when it is an http(s) address, else None: config.json is a file on this computer, and the window opens only web pages."""
    if isinstance(url, str) and url.lower().startswith(("https://", "http://")) and len(url.split("://", 1)[1]) > 0:
        return url
    return None


def folder_uri(path):
    """A file:// URI for a folder, with the spaces of '~/Library/Application Support' (and any other reserved character) escaped."""
    return "file://" + quote(os.path.abspath(path), safe="/")


def decision_summary(decisions):
    """The sentence the window asks before it applies, naming how many conflicts it is about to decide and how many of those send the
    desktop value over the website's; None when none is decided (every conflict skipped)."""
    chosen = [decide._normal(d)[0] for d in (decisions or {}).values()]
    chosen = [c for c in chosen if c != decide.SKIP]
    if not chosen:
        return None
    mine = sum(1 for c in chosen if c == decide.KEEP_MINE)
    text = "%d conflict%s will be decided now" % (len(chosen), "" if len(chosen) == 1 else "s")
    if mine:
        text += ": %d keep%s the value in Gramps and replace%s the website's at this sync" % (mine, "s" if mine == 1 else "", "s" if mine == 1 else "")
    return text + ". Conflicts you leave on Skip for now stay open."


def mass_blocked(pull_pv):
    """The incoming deletes held back as a mass delete (matched on the plan's rule code, not on its text)."""
    return [b for b in (pull_pv or {}).get("blocked", []) if b.get("rule") == "mass_delete"]


# ----------------------------------------------------------------------------------------------------------------------- model


class Context:
    """The live inputs the model reads for display: the tree's raw objects, the sidecar's base rows and (lazily) the projection."""

    def __init__(self, local, base_rows, server, sticky=(), released=(), files=None, policy=None, holds=None):
        self.local = local or {}
        self.base_rows = base_rows or {}
        self.server = server
        self.sticky, self.released, self.files = set(sticky), set(released), files or {}
        self.policy = policy or R.load_policy()
        self.holds = holds or []      # the sidecar's holds table as the last run left it (pushstate.hold_rows); only run_holds() reads it
        self._projected = None

    def projected(self):
        """P(L) as the pull's plan makes it (`plan._build_once`): the conflicts the window shows were found against that projection, so the
        "yours" column reads from it. It is not the push's `byte_view` of the tree: the push re-reads a Media by the mime its bytes admit to,
        the pull does not, and a conflict on a reference to such a Media (its rect, say) would not be found in the push's projection."""
        if self._projected is None:
            base = {h: r["obj"] for h, r in self.base_rows.items() if not r["deleted"] and r["obj"] is not None}
            proj = PR.project(list(self.local.values()), base=base, files=self.files, released=self.released, sticky=self.sticky, policy=self.policy)
            self._projected = plan_mod.symmetric(proj.projected, proj.holds)
        return self._projected

    def base_obj(self, handle):
        row = self.base_rows.get(handle)
        return row["obj"] if row and not row["deleted"] else None

    def gramps_id(self, handle, default=""):
        return (self.local.get(handle) or {}).get("gramps_id") or default


def _identity(ctx, cls, handle, gid=""):
    gid = gid or ctx.gramps_id(handle)
    raw = ctx.local.get(handle)
    return {"class": cls, "handle": handle, "gramps_id": gid, "title": object_title(cls, gid), "name": person_name(raw),
            "person_url": person_url(ctx.server, cls, gid)}


def yours_live(ctx, c):
    """The desktop value at a conflict's path, read from the database now, local-only part included. (value, local_only)"""
    h = c.get("handle")
    raw_obj = ctx.local.get(h)
    if raw_obj is None:
        return None, False
    if not c.get("path"):
        return None, False
    lp = ctx.projected().get(h)
    if lp is None:
        return None, False
    conflict = {"path": c["path"]}
    live = M.local_value(conflict, raw_obj, lp, ctx.base_obj(h))
    projected = M.local_value(conflict, lp, lp, ctx.base_obj(h))
    return live, live != projected


def _diff_rows(changes, left, right):
    out = []
    for ch in changes or ():
        out.append({"path": ch.get("path", ""), "label": pretty_path(ch.get("path", "")), left: short(ch.get(left)), right: short(ch.get(right))})
    return out


def _section(sid, title, rows, summary=""):
    return {"id": sid, "title": title, "count": len(rows), "summary": summary, "rows": rows}


def _count_text(counts, extra=""):
    parts = ["%s %d" % (k, counts.get(k, 0)) for k in ("create", "update", "delete")]
    return " · ".join(parts) + extra


def run_holds(ctx, seen):
    """The Held back rows only a real run can find: a media file the download held (the pull reads its bytes) and a file or record the
    upload could not send. The dry `check` and `push` the window reads cannot reproduce them, so they come from the sidecar's holds table
    (`ctx.holds`), with the plain words the run recorded. `seen` is the {(handle, path, rule)} the previews already list.

    The table is as the last run left it, so a row is left out when its object is no longer in the tree, when a download hold's Media now
    has a path of its own (the dry push reads that file, and says what is wrong with it), and for any rule the dry runs do find themselves."""
    out = []
    for x in ctx.holds:
        handle, rule = x["handle"], x["rule"]
        raw = ctx.local.get(handle)
        if raw is None or any(k[0] == handle and k[2] == rule for k in seen):
            continue
        if rule in consts.DOWNLOAD_HOLD_RULES:
            if raw.get("_class") != "Media" or raw.get("path"):
                continue
        elif rule not in consts.SEND_FAILED_RULES:
            continue
        note = x.get("detail") or consts.HOLD_MESSAGES.get(rule)
        if not note:
            try:
                note = PR.hold_reason(rule)
            except (KeyError, ValueError):
                note = rule
        seen.add((handle, x.get("path", ""), rule))
        out.append(dict(_identity(ctx, x["class"] or raw.get("_class", ""), handle), badge="held", rule=rule, path=x.get("path", ""),
                        note=note, label=pretty_path(x.get("path", ""))))
    return out


def build_model(pull_pv, push_pv, ctx, header=None):
    """The window's content from the two preview documents. Pure given its inputs; reads values only through `ctx` (live) and the previews."""
    pull_pv, push_pv = pull_pv or {}, push_pv or {}
    pull_changes = {(e["handle"]): e for e in pull_pv.get("to_website", [])}

    # ---- from the website
    rows = []
    kinds = {"create": 0, "update": 0, "delete": 0}
    for e in pull_pv.get("from_website", []):
        action = e.get("action")
        kind = "create" if action == "create_local" else "delete" if action == "delete_local" else "update"
        kinds[kind] += 1
        row = dict(_identity(ctx, e["class"], e["handle"], e.get("gramps_id", "")), badge={"create": "new", "update": "changed", "delete": "deleted"}[kind],
                   kind=kind, diffs=_diff_rows(e.get("changes"), "base", "website"))
        rows.append(row)
    sec_from = _section("from_website", "From the website", rows, _count_text(kinds))

    # ---- to the website: the push's ops, with the diffs the pull's plan has; blocked rows a confirmation lifts wait here too
    rows, kinds, confirm_rows = [], {"create": 0, "update": 0, "delete": 0}, []
    for o in push_pv.get("ops", []):
        kind = "delete" if o["op"] in ("delete", "withdraw") else o["op"]
        kinds[kind] += 1
        planned = pull_changes.get(o["handle"], {})
        diffs = _diff_rows(planned.get("changes"), "website", "desktop") if planned.get("changes") else \
            [{"path": "", "label": "the whole record", "website": "—", "desktop": "new record" if kind == "create" else kind}]
        row = dict(_identity(ctx, o["class"], o["handle"], o.get("gramps_id", "")), badge={"create": "new", "update": "changed", "delete": "delete"}[kind],
                   kind=kind, diffs=diffs, label=planned.get("label", ""))
        if kind == "delete":
            row["note"] = "needs a fresh sign-in" if not push_pv.get("step_up_fresh") else ""
        rows.append(row)
    for b in push_pv.get("blocked", []):
        if b["rule"] in CONFIRMABLE:
            confirm_rows.append(b)
    # (a delete that waits for the confirmation is counted by the push preview only after it is confirmed; show it with its reason)
    for b in confirm_rows:
        kind = "delete" if b["rule"] in ("delete_parked", "mass_delete", "merge_gui_only") else "update"
        planned = pull_changes.get(b["handle"], {})
        row = dict(_identity(ctx, b["class"], b["handle"]), badge="needs confirmation", kind=kind, confirm=b["rule"],
                   note=b.get("detail") or consts.HOLD_MESSAGES.get(b["rule"], ""),
                   diffs=_diff_rows(planned.get("changes"), "website", "desktop") if planned.get("changes") else [])
        rows.append(row)
        kinds[kind] += 1
    extra = " (needs fresh sign-in)" if kinds["delete"] and not push_pv.get("step_up_fresh") else ""
    sec_to = _section("to_website", "To the website", rows, _count_text(kinds, extra))

    # ---- conflicts
    rows = []
    for c in pull_pv.get("conflicts", []):
        full = {"kind": c["kind"], "path": c.get("path", ""), "cloud": c.get("website"), "local": c.get("desktop"), "base": c.get("base")}
        ctype = decide.conflict_type(full)
        yours, local_only = (None, False)
        if ctype in (decide.KIND_FIELD, decide.KIND_DATE):
            try:
                yours, local_only = yours_live(ctx, c)
            except (ValueError, KeyError, TypeError, AttributeError):
                yours, local_only = c.get("desktop"), False
        else:
            yours = c.get("desktop")
        diff = {"path": c.get("path", ""), "label": pretty_path(c.get("path", "")), "base": short(c.get("base")), "website": short(c.get("website")),
                "yours": short(yours), "yours_local_only": bool(local_only)}
        row = dict(_identity(ctx, c["class"], c["handle"], c.get("gramps_id", "")), badge=c.get("kind", "conflict"), id=c["id"], kind=c.get("kind"),
                   type=ctype, reason=c.get("reason", ""), diffs=[diff], choices=decide.choices(full))
        row["default"] = next((x["id"] for x in row["choices"] if x["default"]), decide.SKIP)
        rows.append(row)
    sec_conf = _section("conflicts", "Conflicts", rows, "")

    # ---- held back
    rows, seen = [], set()
    for x in push_pv.get("holds", []):
        key = (x["handle"], x.get("path", ""), x["rule"])
        seen.add(key)
        rows.append(dict(_identity(ctx, x["class"], x["handle"]), badge="held", rule=x["rule"], path=x.get("path", ""),
                         note=x.get("detail") or consts.HOLD_MESSAGES.get(x["rule"], ""), label=pretty_path(x.get("path", ""))))
    for x in pull_pv.get("held", []):
        key = (x["handle"], x.get("pointer", ""), x["rule"])
        if key in seen or any(k[0] == x["handle"] and k[2] == x["rule"] for k in seen):
            continue
        cls = (ctx.local.get(x["handle"]) or {}).get("_class", "")
        try:
            note = PR.hold_reason(x["rule"])
        except (KeyError, ValueError):
            note = x["rule"]
        seen.add(key)
        rows.append(dict(_identity(ctx, cls, x["handle"]), badge="held", rule=x["rule"], path=x.get("pointer", ""),
                         note="%s Edit it in Gramps to publish." % note if cls != "Media" else note, label=pretty_path(x.get("pointer", ""))))
    rows += run_holds(ctx, seen)
    for s in pull_pv.get("sticky_held", []):
        if s["handle"] in ctx.released:
            continue
        rows.append(dict(_identity(ctx, "Event", s["handle"], s.get("gramps_id", "")), badge="held", rule="birthlike_sticky", path="/date",
                         label="date", note="This event was a birth event. Its day and month stay on this computer until you release them.",
                         release={"handle": s["handle"], "label": "Release day and month…",
                                  "confirm": "Release the day and month of %s? They will be published on the website at the next push. "
                                             "This cannot be taken back once it is sent." % object_title("Event", s.get("gramps_id", ""))}))
    for b in push_pv.get("blocked", []):
        if b["rule"] == "sticky_daymonth":
            rows.append(dict(_identity(ctx, b["class"], b["handle"]), badge="flagged", rule=b["rule"], path=b.get("path", ""), label=pretty_path(b.get("path", "")),
                             note=b.get("detail") or consts.HOLD_MESSAGES["sticky_daymonth"],
                             release={"handle": b["handle"], "label": "Release day and month…",
                                      "confirm": "Release the day and month of %s? They will be published on the website at the next push. "
                                                 "This cannot be taken back once it is sent." % object_title(b["class"], ctx.gramps_id(b["handle"]))}))
    sec_held = _section("held", "Held back", rows, "")

    # ---- blocked
    rows = []
    for b in pull_pv.get("blocked", []):
        rows.append(dict(_identity(ctx, b["class"], b["handle"], b.get("gramps_id", "")), badge="blocked", note=b["reason"]))
    for b in pull_pv.get("deferred", []):
        rows.append(dict(_identity(ctx, b["class"], b["handle"], b.get("gramps_id", "")), badge="waiting", note=b["reason"]))
    for i in pull_pv.get("incidents", []):
        rows.append(dict(_identity(ctx, i["class"], i["handle"], i.get("gramps_id", "")), badge="not applied",
                         note="This record from the website shows a date of birth held on this computer, so it was not applied."))
    for v in pull_pv.get("integrity", []):
        rows.append({"class": "", "handle": "", "gramps_id": "", "title": "Relationship check", "name": "", "person_url": None, "badge": "blocked",
                     "note": v.get("problem", "")})
    for b in push_pv.get("blocked", []):
        if b["rule"] in CONFIRMABLE or b["rule"] == "sticky_daymonth":
            continue
        rows.append(dict(_identity(ctx, b["class"], b["handle"]), badge="blocked", rule=b["rule"],
                         note=b.get("detail") or consts.HOLD_MESSAGES.get(b["rule"], b["rule"])))
    sec_block = _section("blocked", "Blocked", rows, "")

    sections = [sec_from, sec_to, sec_conf, sec_held, sec_block]
    n_apply = sum(1 for r in sec_from["rows"])
    n_push = sum(1 for r in sec_to["rows"] if not r.get("confirm"))
    model = {
        "header": header or {}, "sections": sections, "by_id": {s["id"]: s for s in sections},
        "counts": {"apply": n_apply, "push": n_push, "confirm": sum(1 for r in sec_to["rows"] if r.get("confirm"))},
        "apply_label": "Apply %d · Push %d" % (n_apply, n_push + sum(1 for r in sec_to["rows"] if r.get("confirm"))),
        "warning": UNDO_WARNING,
        "confirmations": confirmations(pull_pv, push_pv, ctx),
    }
    return model


def confirmations(pull_pv, push_pv, ctx):
    """The modals the person must answer before the apply, each listing every object it covers: incoming deletes, a mass of them, and the
    outgoing deletes, reverts and merges the push holds until the window confirms. [{id, title, text, objects[{title, name, note}]}]"""
    out = []
    incoming = [e for e in pull_pv.get("from_website", []) if e.get("action") == "delete_local"]
    blocked_mass = mass_blocked(pull_pv)
    if incoming or blocked_mass:
        objs = [dict(_identity(ctx, e["class"], e["handle"], e.get("gramps_id", ""))) for e in incoming]
        objs += [dict(_identity(ctx, b["class"], b["handle"], b.get("gramps_id", ""))) for b in blocked_mass]
        mass = bool(pull_pv.get("mass_delete"))
        out.append({"id": "incoming_deletes", "mass": mass,
                    "title": "Delete %d record%s from Gramps?" % (len(objs), "" if len(objs) == 1 else "s"),
                    "text": ("This is a mass delete (more than 10 records, or more than 5 percent of the tree). " if mass else "") +
                            "The website deleted these. Applying removes them from this tree; a backup is taken first.",
                    "objects": objs})
    outgoing = [b for b in push_pv.get("blocked", []) if b["rule"] in CONFIRMABLE]
    if outgoing:
        objs = []
        for b in outgoing:
            o = dict(_identity(ctx, b["class"], b["handle"]))
            o["note"] = b.get("detail") or consts.HOLD_MESSAGES.get(b["rule"], "")
            o["rule"] = b["rule"]
            objs.append(o)
        out.append({"id": "outgoing", "title": "Send 1 change that needs your confirmation?" if len(objs) == 1 else "Send %d changes that need your confirmation?" % len(objs),
                    "text": "These go to the website only after you confirm. Deletes also need a fresh sign-in.", "objects": objs})
    return out


# ----------------------------------------------------------------------------------------------------------------------- banner


def banner(docs, undo=True):
    """The result banner after an apply: counts, the backup path and the undo warning. `docs` are the status documents of the run's steps
    (the pull, the push). {title, lines[], backup, warning, next_action, ok}. `ok` is false only when a step was refused or failed."""
    pull = next((d for d in docs if d and d.get("action") in ("pull", "sync")), None)
    push = next((d for d in docs if d and d.get("action") == "push"), None)
    lines, nxt = [], "none"
    stopped = any(d and (d.get("result") in ("refused", "failed") or (d.get("error") or {}).get("code") == "plan_changed") for d in docs)
    if pull and pull.get("result") not in ("refused", "failed"):
        c = (pull.get("counts") or {}).get("pulled") or {}
        lines.append("Applied from the website: %d new, %d changed, %d deleted." % (c.get("create", 0), c.get("update", 0), c.get("delete", 0)))
        if (pull.get("counts") or {}).get("conflicts_open"):
            lines.append("Conflicts still open: %d. Both sides were left as they are." % pull["counts"]["conflicts_open"])
    if push and push.get("result") not in ("refused", "failed"):
        c = (push.get("counts") or {}).get("pushed") or {}
        lines.append("Pushed to the website: %d new, %d changed, %d deleted." % (c.get("create", 0), c.get("update", 0), c.get("delete", 0)))
        counts = push.get("counts") or {}
        for key, text in (("conflicts_open", "Conflicts parked: %d."), ("holds", "Held back: %d."), ("blocked", "Blocked: %d.")):
            if counts.get(key):
                lines.append(text % counts[key])
    for d in (pull, push):
        err = (d or {}).get("error") or {}
        if err and not (d is push and err.get("code") == "held" and d.get("result") == "partial"):
            lines.append("%s: %s" % (err.get("code", ""), err.get("message", "")))
        if d and d.get("next_action") not in (None, "none"):
            nxt = d["next_action"]
    backup = next((d.get("backup") for d in docs if d and d.get("backup")), None)
    ok = not stopped
    title = "Sync finished" if ok and nxt == "none" else "Sync finished, with something left to do" if ok else "Sync stopped"
    if nxt != "none":
        lines.append("Next: %s." % NEXT_TEXT.get(nxt, nxt.replace("_", " ")))
    return {"title": title, "lines": lines, "backup": backup, "warning": UNDO_WARNING if undo else "", "next_action": nxt, "ok": ok}


NEXT_TEXT = {"resolve_conflicts": "decide the open conflicts (Check for changes shows them again)", "step_up": "sign in again to send the deletes",
             "login": "sign in", "review_preview": "check for changes again", "retry": "run it again in a moment",
             "close_gramps": "close Gramps", "rebase": "rebase this tree", "bind": "bind this tree", "review_incidents": "review the incident"}


# ----------------------------------------------------------------------------------------------------------------------- the flow


class Review:
    """What `Flow.review` found and `Flow.apply` needs: the two run documents, the two preview run ids and the model."""

    def __init__(self, pull_doc, push_doc, pull_pv, push_pv, ctx, model):
        self.pull_doc, self.push_doc, self.pull_pv, self.push_pv, self.ctx, self.model = pull_doc, push_doc, pull_pv, push_pv, ctx, model
        self.refusal = None     # the pull's check was refused: no model
        self.push_note = None   # the push's check was refused: a model without To the website

    @property
    def pull_run_id(self):
        return (self.pull_doc or {}).get("run_id")


class Flow:
    """One window's worth of runs over a `TreeAccess`. `services` is what `runner.run` takes (tests pass fake clouds)."""

    def __init__(self, tree, environ=None, services=None, argv=None):
        self.tree = tree
        self.environ = os.environ if environ is None else environ
        self.sink = {}                  # what a run tells the window in memory only (the signed-in label), never a file
        self.services = dict(services or {}, sink=self.sink)
        self.argv = argv or ["gramps"]
        self.tp = paths.TreePaths(tree.dbid, self.environ)

    # ---- running
    def run(self, action, **opts):
        return runner.run(self.tree, "gui", runner.Options(action, **opts), argv=self.argv, environ=self.environ, services=self.services)

    def _preview(self, doc):
        rid = (doc or {}).get("run_id")
        if not rid or not paths.valid_dbid(rid):
            return None
        try:
            return paths.read_json(os.path.join(self.tp.previews, "%s.json" % rid))
        except (ValueError, OSError):
            return None

    # ---- the model's live inputs
    def _server(self):
        try:
            cfg = paths.read_json(self.tp.config) or {}
        except (ValueError, OSError):
            cfg = {}
        return cfg.get("server") or consts.DEFAULT_SERVER

    def _sidecar_view(self):
        """(base_rows, sticky, released, last_sync_iso, last_result, holds) from the sidecar, read-only."""
        if not os.path.exists(self.tp.sidecar):
            return {}, [], [], "", "", []
        con = sidecar.open_checked(self.tp.sidecar)
        try:
            base = sidecar.load_base(con)
            sticky = sidecar.meta_json(con, "birthlike_sticky", [])
            released = sidecar.meta_json(con, "released", [])
            meta = sidecar.meta(con)
            last = max([meta.get("last_pull_at") or "", meta.get("last_push_at") or ""])
            row = con.execute("SELECT result FROM runs WHERE action IN ('pull', 'sync', 'push') AND result != 'changes_pending' "
                              "ORDER BY finished_at DESC LIMIT 1").fetchone()
            return base, sticky, released, last, row[0] if row else "", pushstate.hold_rows(con)
        finally:
            con.close()

    def header(self, pull_doc, push_pv):
        base, sticky, released, last, last_result, _holds = self._sidecar_view()
        cloud = self.sink.get("cloud") or {}
        head, rendered = cloud.get("head_seq"), cloud.get("rendered_seq")
        server = self._server()
        host = server.split("://", 1)[-1].rstrip("/")
        return {
            "tree": getattr(self.tree, "name", ""), "website": host, "signed_in": self.sink.get("signed_in") or "",
            "last_sync": ("%s, %s" % (relative_time(last), last_result or "ok")) if last else "never",
            "website_version": ("seq %s" % head if head else "") + (" (rendered ✓)" if isinstance(rendered, int) and isinstance(head, int) and rendered >= head else ""),
        }

    def review(self):
        """Runs `check` and a dry `push`, builds the model. A refusal (sign-in, binding, a changed website store) comes back as
        ``review.refusal`` (the run document), with no model."""
        pull_doc = self.run("check", dry_run=True)
        if pull_doc.get("result") in ("refused", "failed"):
            rv = Review(pull_doc, None, None, None, None, None)
            rv.refusal = pull_doc
            return rv
        pull_pv = self._preview(pull_doc) or {}
        push_doc = self.run("push", dry_run=True)
        push_pv = self._preview(push_doc) or {}
        base, sticky, released, _last, _res, holds = self._sidecar_view()
        ctx = Context(self.tree.objects(), base, self._server(), sticky, released, files=self.tree.media_files(), holds=holds)
        model = build_model(pull_pv, push_pv, ctx, self.header(pull_doc, push_pv))
        pull_mod._prune_previews(self.tp)    # a window checks twice per look: keep only the newest previews, as an apply does
        rv = Review(pull_doc, push_doc, pull_pv, push_pv, ctx, model)
        if push_doc.get("result") in ("refused", "failed"):
            rv.push_note = push_doc      # what to send could not be checked (sign-in, paused writes): the window says so, the rest is shown
        return rv

    def release(self, handle):
        """The person released an event's day and month (a confirmed answer). Takes the tree's run lock (the same one a run holds), so it
        never writes the sidecar while a run does; it returns False, and writes nothing, when a run holds the lock."""
        with preflight.StateLock(self.tp.lock) as lock:
            if not lock.acquired:
                return False
            con = sidecar.open_checked(self.tp.sidecar)
            try:
                sidecar.release_event(con, handle)
            finally:
                con.close()
        return True

    # ---- the apply
    def editors_refusal(self):
        """The D45 refusal, or None. Checked before the apply and again inside the pull."""
        if self.tree.editors_open():
            exit_code, next_action, message = consts.REFUSALS["D45"]
            return {"result": "refused", "action": "pull", "exit_code": exit_code, "next_action": next_action,
                    "error": {"code": "D45", "message": message}, "counts": status.zero_counts(), "backup": None}
        return None

    def apply(self, review, decisions=None, confirmed=None, step_up=None):
        """The run after the person approved the preview. `decisions` {conflict id: {"choice", "confirmed"}}; `confirmed` the modal answers
        ({"incoming_deletes": bool, "outgoing": bool}); `step_up()` signs in again and returns True (called just before the deletes go).
        Returns the banner."""
        decisions = decisions or {}
        confirmed = confirmed or {}
        refusal = self.editors_refusal()
        if refusal:
            return banner([refusal], undo=False)
        docs = []
        pv, push_pv = review.pull_pv or {}, review.push_pv or {}
        decisions = {cid: {"choice": c, "confirmed": ok} for cid, (c, ok) in ((cid, decide._normal(d)) for cid, d in decisions.items())}
        decided = any(d["choice"] != decide.SKIP for d in decisions.values())
        incoming = [e for e in pv.get("from_website", []) if e.get("action") == "delete_local"]
        mass_held = mass_blocked(pv)
        # Always the pull, even with nothing to apply: it records the conflicts it leaves open, and the decisions and the confirmations ride on it.
        opts = dict(yes=True, plan=review.pull_run_id, decisions=decisions)
        if incoming or mass_held:
            opts["confirm_deletes"] = bool(confirmed.get("incoming_deletes"))
            opts["confirm_mass_delete"] = bool(confirmed.get("incoming_deletes")) and bool(pv.get("mass_delete"))
        pull_doc = self.run("pull", **opts)
        docs.append(pull_doc)
        if pull_doc.get("result") in ("refused", "failed") or (pull_doc.get("error") or {}).get("code") == "plan_changed":
            return banner(docs)
        yes = bool(confirmed.get("outgoing"))
        waiting = [b for b in push_pv.get("blocked", []) if b["rule"] in CONFIRMABLE]
        if push_pv.get("ops") or (yes and waiting) or decided:
            deleting = (yes and any(b["rule"] in ("delete_parked", "mass_delete", "merge_gui_only") for b in waiting)) \
                or any(o["op"] in ("delete", "withdraw") for o in push_pv.get("ops", []))
            if deleting and step_up is not None:
                probe_pv = self._preview(self.run("push", dry_run=True, yes=yes)) or {}
                if any(b["rule"] == "step_up_required" for b in probe_pv.get("blocked", [])):
                    step_up()      # just before the deletes (D07); a refusal leaves them blocked, and the banner says so
            docs.append(self.run("push", yes=yes, deletes_first=True))
        return banner(docs)
