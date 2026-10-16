#!/usr/bin/env python3
"""Rebuild status.json from live tracker statuses (ELR batch_get over idmap ids), keeping prior notes as a suffix only when status is unchanged.
Env: HFY_ORCH_STATE (status.json lives in $HFY_ORCH_STATE/catalog2/) and HFY_ORCH_REPO (a harrisonfamily checkout;
tracker-idmap.json is read from its docs/design/hfy-pln-002/)."""
import json, os, pathlib, subprocess, collections, sys
TOOL = "refresh_status.py"

def env_dir(var, what):
    v = os.environ.get(var)
    if not v:
        sys.exit(f"{TOOL}: {var} is not set; export {var}=<{what}>")
    if not os.path.isdir(v):
        sys.exit(f"{TOOL}: {var}={v} is not a directory ({what})")
    return pathlib.Path(v).resolve()


HERE = env_dir("HFY_ORCH_STATE", "orchestration state directory") / "catalog2"
HERE.mkdir(exist_ok=True)
idm = json.load(open(env_dir("HFY_ORCH_REPO", "harrisonfamily checkout") / "docs/design/hfy-pln-002/tracker-idmap.json"))
old = json.load(open(HERE / "status.json")) if (HERE / "status.json").exists() else {}
ids = sorted(set(v for v in idm.values() if v.startswith("HFY-TSK")))
f = HERE / ".ids.txt"; f.write_text("\n".join(ids) + "\n")
r = subprocess.run([os.path.expanduser("~/.enceladus/elr/elr"), "batch_get", "--ids-file", str(f), "--json"], capture_output=True, text=True)
rows = {x["id"]: x.get("status_or_version") for x in json.loads(r.stdout)["rows"] if x.get("ok")}
new = {}
for k, rid in idm.items():
    if k.startswith("wave-") or rid not in rows: continue
    s = rows[rid]
    prev = old.get(k, "")
    note = prev.split(" (", 1)[1].rstrip(")") if prev.startswith(s + " (") else ""
    new[k] = f"{s} ({note})" if note else s
(HERE / "status.json").write_text(json.dumps(new, indent=0, sort_keys=True) + "\n")
print(len(rows), "fetched;", dict(collections.Counter(v.split(" (")[0] for v in new.values())))
