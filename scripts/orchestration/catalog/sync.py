#!/usr/bin/env python3
"""Catalog sync: patch only changed sections of DOC-981BF41F2443 via elr doc_patch (delta-only).
Usage: sync.py [--all] [--dry-run]. Tracks section hashes in .synced.json. Prints one line per section.
Env: HFY_ORCH_STATE, the orchestration state directory; the section files live in $HFY_ORCH_STATE/catalog2/."""
import hashlib, json, os, subprocess, sys, pathlib
TOOL = "sync.py"

def env_dir(var, what):
    v = os.environ.get(var)
    if not v:
        sys.exit(f"{TOOL}: {var} is not set; export {var}=<{what}>")
    if not os.path.isdir(v):
        sys.exit(f"{TOOL}: {var}={v} is not a directory ({what})")
    return pathlib.Path(v).resolve()


DOC = "DOC-981BF41F2443"; PROJECT = "harrisonfamily"
ELR = os.path.expanduser("~/.enceladus/elr/elr")
HERE = env_dir("HFY_ORCH_STATE", "orchestration state directory") / "catalog2"
if not HERE.is_dir(): sys.exit(f"{TOOL}: {HERE} not found (the catalog section files)")
STATE = HERE / ".synced.json"
FILES = ["10-rulings.md", "20-order.md", "30-board.md", "40-gates.md", "50-findings.md", "60-ledger.md", "70-trueup.md"]
state = json.loads(STATE.read_text()) if STATE.exists() else {}
force = "--all" in sys.argv; dry = "--dry-run" in sys.argv
subprocess.run([ELR, "doc_digest", DOC], capture_output=True, text=True, cwd=os.path.expanduser("~"))
ok = True
for f in FILES:
    text = (HERE / f).read_text()
    heading, _, body = text.partition("\n")
    h = hashlib.sha256(text.encode()).hexdigest()
    if not force and state.get(f) == h:
        continue
    anchor = heading.lstrip("#").strip()
    bf = HERE / f".body-{f}"
    bf.write_text(body.lstrip("\n"))
    cmd = [ELR, "doc_patch", "--doc", DOC, "--project", PROJECT, "--anchor", anchor, "--op", "replace", "--body-file", str(bf)]
    if dry: cmd.append("--dry-run")
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.expanduser("~"))
    out = (r.stdout.strip().splitlines() or [""])[-1]
    try:
        j = json.loads(out); msg = j.get("status") or j.get("outcome") or j.get("ok")
    except Exception:
        msg = (out or r.stderr.strip())[:200]
    print(f"{f}: rc={r.returncode} {msg}")
    if r.returncode == 3:  # stale hash: refresh digest and retry once
        subprocess.run([ELR, "doc_digest", DOC], capture_output=True, text=True, cwd=os.path.expanduser("~"))
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.expanduser("~"))
        print(f"  retry rc={r.returncode}")
    if r.returncode == 0 and not dry:
        state[f] = h
    else:
        ok = ok and dry
        if r.returncode != 0: print("  stderr:", r.stderr.strip()[-300:])
STATE.write_text(json.dumps(state, indent=0))
sys.exit(0 if ok else 1)
