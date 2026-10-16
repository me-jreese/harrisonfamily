#!/usr/bin/env python3
"""Generate 20-order.md and 30-board.md from tasks.json + tracker-idmap.json + status.json (orchestrator-maintained).
Env: HFY_ORCH_STATE (status.json and the outputs live in $HFY_ORCH_STATE/catalog2/) and HFY_ORCH_REPO (a harrisonfamily
checkout; tasks.json and tracker-idmap.json are read from its docs/design/hfy-pln-002/)."""
import json, os, pathlib, collections, sys
TOOL = "gen_board.py"

def env_dir(var, what):
    v = os.environ.get(var)
    if not v:
        sys.exit(f"{TOOL}: {var} is not set; export {var}=<{what}>")
    if not os.path.isdir(v):
        sys.exit(f"{TOOL}: {var}={v} is not a directory ({what})")
    return pathlib.Path(v).resolve()


HERE = env_dir("HFY_ORCH_STATE", "orchestration state directory") / "catalog2"
HERE.mkdir(exist_ok=True)
P = env_dir("HFY_ORCH_REPO", "harrisonfamily checkout") / "docs/design/hfy-pln-002"
T = json.load(open(P / "tasks.json")); idm = json.load(open(P / "tracker-idmap.json"))
st = json.load(open(HERE / "status.json")) if (HERE / "status.json").exists() else {}
by = {t["key"]: t for t in T}
waves = collections.OrderedDict((f"W{i}", []) for i in range(7))
for t in T:
    if not t["key"].startswith("wave-"):
        waves.setdefault(t.get("wave") or "Follow-ups", []).append(t)
board = ["## Board", "", "Format: `id key [repo] status`. Status is the tracker status (open unless noted). Wave objectives: W0..W6 = " + ", ".join(idm[f"wave-W{i}"] for i in range(7)) + ".", ""]
cnt = collections.Counter()
for w, ts in waves.items():
    board.append(f"### {w} ({idm['wave-'+w]}, {len(ts)} tasks)" if 'wave-'+w in idm else f"### {w} (follow-up tasks filed after import, {len(ts)} tasks)")
    board.append("```text")
    for t in sorted(ts, key=lambda x: int(idm[x['key']].split('-')[-1])):
        s = st.get(t["key"], "open"); cnt[s] += 1
        board.append(f"{idm[t['key']]} {t['key']} [{t['repo']}] {s}")
    board.append("```")
board.insert(3, "Totals: " + ", ".join(f"{k} {v}" for k, v in sorted(cnt.items())) + ".")
(HERE / "30-board.md").write_text("\n".join(board) + "\n")
order = ["## Order of operations", "",
 "- Waves are reporting groups; entry is by each task's depends_on edges and named io gates (BRD-2 section 7.1).",
 "- Critical path (effort-weighted, ~36 working days + io response): d03-gitignore-guard -> synthetic-fixture-tree -> gramps-schema-export -> store-apply-core -> validator-js -> sync-push-routes -> sync-dev-harness-e2e -> addon-push -> addon-media -> sync-error-catalog-tests -> seed-and-shadow -> cutover-live-render -> edit-flag-flip -> tag-edit-flip.",
 "- Merge discipline: islands merge train (rebase + rebuild, generated files take origin/main's side); one io-kit package per PR; kit dependants wait for the kit task to close (published).",
 "- Release groups: app-stack change sets per RG-n under io's G-prod; site changes deploy on merge via @io-kit/ci; every flip is its own orchestrator task with a D-11 audit and io approval.",
 ""]
(HERE / "20-order.md").write_text("\n".join(order))
print("board lines", len(board), dict(cnt))
